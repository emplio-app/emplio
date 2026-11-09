// The OK an app action needs before it sends, changes or deletes anything (gmail.send_email, todoist.create_task).
// `emplio apps run` asks here first; the chat shows a card with Allow / Always allow / Deny and the command waits
// for the answer. Runs without asking: actions the provider marks read-only, ones this person said
// "Always allow" to, and, in chats, businesses whose Settings say "Just do it". Runs nobody is watching
// (automations, the background agent) get only the first two, plus what their automation lists and an owner or admin
// allowed (automations.ts); anything else is refused.
import type { Approval } from "@emplio/shared";
import { generateId } from "ai";
import { and, desc, eq, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { context } from "./auth";
import { db } from "./db";
import { conversations, messages, workspaceMembers } from "./db/schema";
import { postMessage } from "./chat";
import { connectCard, getAction, runAction } from "./integrations";
import { notify } from "./live";
import type { Session } from "./sandbox";

// The command waits this long for the answer; the card stays answerable until VALID_MS, then it expires.
// An answer in between is carried out here and its result added to the chat (the agent has moved on).
const WAIT_MS = 10 * 60_000;
const VALID_MS = 2 * 60 * 60_000;

type Waiting = { workspaceId: string; userId: string; conversationId: string; decide: (d: NonNullable<Approval["decision"]>) => void };
// ponytail: in memory, so a server restart drops pending asks (the command gets "no answer"); fine for one server
const waiting = new Map<string, Waiting>();
type Later = { workspaceId: string; userId: string; conversationId: string; card: Approval; run: () => Promise<unknown> };
// ponytail: in memory too; after a restart a late answer gets "expired"
const later = new Map<string, Later>();


// ponytail: an action's details cached per process; read-only-ness doesn't change between runs
// Only real answers are kept: a provider having a bad moment comes back as null, and the next look should ask again.
const details = new Map<string, ReturnType<typeof getAction>>();
export const detailOf = (action: string) => {
  const forget = () => (details.delete(action), null);
  if (!details.has(action)) details.set(action, getAction(action).then((d) => d ?? forget()).catch(forget));
  return details.get(action)!;
};

export async function alwaysAllowed(workspaceId: string, userId: string) {
  const row = await db.query.workspaceMembers.findFirst({
    where: and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, userId)),
    columns: { alwaysAllowed: true },
  });
  return row?.alwaysAllowed ?? [];
}

const setAllowed = (workspaceId: string, userId: string, value: ReturnType<typeof sql>) =>
  db
    .update(workspaceMembers)
    .set({ alwaysAllowed: value })
    .where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, userId)));

// What an action that isn't an app's is (an MCP tool), and how to do it if it's allowed after the command moved on.
// alwaysAsk: asked every time, whatever "Just do it" or "Always allow" say (installing a skill from outside)
type Own = { title: string; readOnly: boolean; appName: string; logo?: string; alwaysAsk?: boolean; run: () => Promise<unknown> };

// null: go ahead. A string: why not, for the agent. `account`: an app action's; `own`: an action that isn't an app's.
export async function approve(s: Session, action: string, input: unknown, { account, own }: { account?: string; own?: Own } = {}): Promise<string | null> {
  // "Just do it" counts only where someone is watching; background runs change things only when "Always allow"ed
  const asks = !!own?.alwaysAsk;
  if (s.settings.approvals === "auto" && !s.automation && !asks) return null;
  const detail = own ?? (await detailOf(action));
  if (detail?.readOnly) return null;
  if (!asks && (await alwaysAllowed(s.workspaceId, s.user.id)).includes(action)) return null;
  // what the automation behind this run lists and was allowed
  if (!asks && s.allowedActions?.includes(action)) return null;
  // no such action, or the provider couldn't say: unknown is never taken for safe
  if (!detail) return `error: couldn't check what ${action} does, so it wasn't run and nothing changed. If the name is right (emplio apps actions <app>), try again in a moment.`;
  if (s.thinker)
    return `error: ${action} changes something, and you can't without ${s.user.name}'s "Always allow". Don't do it another way: hand it to the AI employee as a task (emplio tasks add "<what>" --to ai --notes "${action} with <input>"); it gets ${s.user.name}'s OK first.`;
  if (s.automation)
    return `error: ${action} changes something, and a run nobody is watching may only do what its automation lists under actions: and ${s.user.name} allowed (or what they've said "Always allow" to). Don't do it another way: say in your last message exactly what you'd do, and that it needs adding to the automation's actions and allowing in Automations.`;
  if (s.task) return `error: ${action} needs ${s.user.name}'s OK first, and nobody can answer in a task's chat. Don't do it another way: set the task to waiting on ${s.user.name} (emplio tasks update <id> --status waiting --waiting "${s.user.name}'s OK to ...") and say exactly what you'd do, so they can say yes in their chat.`;
  if (!s.notify) return `error: ${action} needs ${s.user.name}'s OK first, which can't be asked from here. Leave it to the main chat.`;

  const app = own ? { name: own.appName, logo: own.logo } : await connectCard(action.split(".")[0]!).catch(() => null);
  const card: Approval = {
    id: crypto.randomUUID(),
    action,
    app: action.split(".")[0]!,
    appName: app?.name ?? action.split(".")[0]!,
    logo: app?.logo,
    title: detail.title ?? action,
    input,
    expiresAt: new Date(Date.now() + VALID_MS).toISOString(),
    ...(asks && { oneOff: true }),
  };
  s.notify(card);
  const decision = await new Promise<NonNullable<Approval["decision"]>>((resolve) => {
    const done = (d: NonNullable<Approval["decision"]>) => {
      clearTimeout(timer);
      waiting.delete(card.id);
      resolve(d);
    };
    const timer = setTimeout(() => done("timeout"), WAIT_MS);
    // Stop pressed: counts as no
    s.signal?.addEventListener("abort", () => done("deny"), { once: true });
    waiting.set(card.id, { workspaceId: s.workspaceId, userId: s.user.id, conversationId: s.conversationId, decide: done });
  });
  if (decision === "timeout") {
    const run = own?.run ?? (() => runAction({ workspaceId: s.workspaceId, userId: s.user.id }, action, input, { conversationId: s.conversationId, account }));
    later.set(card.id, { workspaceId: s.workspaceId, userId: s.user.id, conversationId: s.conversationId, card, run });
    setTimeout(() => later.get(card.id) && (later.delete(card.id), void settle(s.conversationId, card.id, "timeout")), VALID_MS - WAIT_MS);
    return `error: no answer from ${s.user.name} yet, so ${action} wasn't run. Their card stays up for ${VALID_MS / 3_600_000} hours: if they tap Allow it's done then and you'll see it in this chat; after that it expires. Say in a few words that it's waiting for their OK; don't ask it again.`;
  }
  s.notify({ ...card, decision });
  if (decision === "always" && !asks)
    await setAllowed(s.workspaceId, s.user.id, sql`array_append(array_remove(${workspaceMembers.alwaysAllowed}, ${action}), ${action})`);
  if (decision === "once" || decision === "always") return null;
  if (decision === "skipped")
    return `error: ${s.user.name} sent a message instead of answering the card, so ${card.title} (${action}) wasn't done and the card is gone. Their message comes next: go by it. A typed yes can't OK it: if they want it done, run it again (changed as they asked) and say in a few words to tap Allow on the new card.`;
  return decision === "deny"
    ? `error: ${s.user.name} said no to ${card.title} (${action}); nothing was done. They pressed no on purpose: something in it (the wording, who it goes to, the account, the timing) isn't what they want. Don't retry it unchanged or do it another way; politely ask what to change, and read their earlier messages for what they asked for.`
    : `error: ${action} wasn't run.`;
}

// The person wrote a message instead of tapping: their open cards in that chat are skipped (not done, no buttons),
// and a command waiting on one goes on, so the reply can end and their message go in. The skipped cards' ids, and
// whether a command was waiting.
export function moveOn(conversationId: string | null) {
  const ids: string[] = [];
  let waited = false;
  for (const [id, w] of waiting) if (w.conversationId === conversationId) ids.push(id), (waited = true), w.decide("skipped");
  for (const [id, l] of later)
    if (l.conversationId === conversationId) ids.push(id), later.delete(id), void settle(l.conversationId, id, "skipped").catch(() => {});
  return { ids, waited };
}

// A card's answer written into the saved reply, so it shows there for good.
async function settle(conversationId: string, id: string, decision: NonNullable<Approval["decision"]>) {
  const rows = await db.select().from(messages).where(eq(messages.conversationId, conversationId)).orderBy(desc(messages.createdAt)).limit(50);
  for (const row of rows) {
    const text = JSON.stringify(row.parts);
    if (!text.includes(id)) continue;
    const parts = (row.parts as { output?: { approvals?: Approval[] } }[]).map((p) =>
      p.output?.approvals ? { ...p, output: { ...p.output, approvals: p.output.approvals.map((a) => (a.id === id ? { ...a, decision } : a)) } } : p,
    );
    await db.update(messages).set({ parts }).where(eq(messages.id, row.id));
    return;
  }
}

// The person's answer to an ask, from whichever channel showed it: true when the waiting command takes it, how it
// went when the command had stopped waiting (done here), false if it expired or isn't theirs.
export async function decide(id: string, workspaceId: string, userId: string, decision: NonNullable<Approval["decision"]>): Promise<boolean | string> {
  const w = waiting.get(id);
  if (w && w.workspaceId === workspaceId && w.userId === userId) {
    w.decide(decision);
    return true;
  }
  const l = later.get(id);
  if (!l || l.workspaceId !== workspaceId || l.userId !== userId) return false;
  later.delete(id);
  await settle(l.conversationId, id, decision);
  if (decision === "always" && !l.card.oneOff)
    await setAllowed(workspaceId, userId, sql`array_append(array_remove(${workspaceMembers.alwaysAllowed}, ${l.card.action}), ${l.card.action})`);
  const text =
    decision === "deny"
      ? `You said no to ${l.card.title}, so it wasn't done.`
      : await l.run().then(
          () => `Done: ${l.card.title} (you allowed it).`,
          (error: unknown) => `You allowed ${l.card.title}, but it failed: ${error instanceof Error ? error.message : "something went wrong"}.`,
        );
  // in the chat, so the AI employee knows how it went
  // not awaited: a reply running in the chat now holds it (chat.ts holdChat), and the button shouldn't wait for that
  void postMessage(l.conversationId, { id: generateId(), role: "assistant", parts: [{ type: "text", text }] })
    .then(() => notify(userId))
    .catch(() => {});
  return text;
}

export async function approvalRoutes(app: FastifyInstance) {
  // the person answering a card in their chat
  app.post<{ Params: { id: string }; Body: { decision: string } }>(
    "/approvals/:id",
    { schema: { body: { type: "object", required: ["decision"], properties: { decision: { enum: ["once", "always", "deny"] } } } } },
    async (req, reply) => {
      const ctx = await context(req, reply);
      if (!ctx) return;
      const done = await decide(req.params.id, ctx.workspaceId, ctx.userId, req.body.decision as "once" | "always" | "deny");
      if (!done) return reply.code(404).send({ error: "This request has expired. Ask again in the chat." });
      return { ok: true, ...(typeof done === "string" && { result: done }) };
    },
  );

  // the person's "Always allow" list, for Settings
  app.get("/approvals/always", async (req, reply) => {
    const ctx = await context(req, reply);
    if (!ctx) return;
    return alwaysAllowed(ctx.workspaceId, ctx.userId);
  });

  app.delete<{ Params: { action: string } }>("/approvals/always/:action", async (req, reply) => {
    const ctx = await context(req, reply);
    if (!ctx) return;
    await setAllowed(ctx.workspaceId, ctx.userId, sql`array_remove(${workspaceMembers.alwaysAllowed}, ${req.params.action})`);
    return alwaysAllowed(ctx.workspaceId, ctx.userId);
  });
}
