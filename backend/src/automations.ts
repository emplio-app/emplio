// Automations: "when X happens, do Y" for the AI employee. Each one is a file in the company repo,
// automations/<name>.md: a few settings between --- lines, then the prompt. Git holds the files;
// syncAutomations keeps one row per file in the database, and the row is what runs:
// - schedule: the timer below starts it when due (cron, in the business's time zone)
// - trigger:  an app event (a new email, ...) its provider watches for and posts to our webhook, or one we
//             poll for ourselves (integrations/polls/): the timer checks the app and fires only on new items
// - manual:   only when someone runs it (Run in the app, `emplio automations run`)
// A run is a new chat, as whoever last saved the file (with their apps), with the prompt (and the event)
// as its first message. Every run is recorded in automation_runs.
// ponytail: runs aren't capped; a burst of events starts that many chats (queue per business if it bites)
import { createHmac, timingSafeEqual } from "node:crypto";
import { Cron } from "croner";
import { generateId, type UIMessage } from "ai";
import { and, desc, eq, gte, inArray, isNull, lte, ne, or } from "drizzle-orm";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { AUTOMATION_PREFIX, type Automation, type AutomationRun } from "@emplio/shared";
import { context, type Ctx } from "./auth";
import { generateReply, lastWords, quiet } from "./chat";
import { chatLink, heldBack, post } from "./channels";
import { SILENT } from "./reader";
import { db } from "./db";
import { record } from "./activity";
import { activity, automationRuns, automations, connections, conversations, jobs, users, workspaceMembers, workspaces } from "./db/schema";
import { lastAuthor, listFolder, readFile, writeFile } from "./gitea";
import { connectCard, getAction, getTrigger, listTriggers, runAction, startTrigger, stopTrigger, triggerPlan } from "./integrations";
import { APPS as OWN_APPS, freshSecret, type Delivery, type WebhookEvent } from "./integrations/own";
import { approve } from "./approvals";
import { findAgent, findTools, onlyReads, toolsUsed } from "./agents";
import type { Session } from "./sandbox";
import { pollConfig, pollOnce } from "./integrations/polls";
import * as githubHooks from "./integrations/own/github/triggers";
import { eventData, triggersFor, watchId, webhookSecret as razorpayWebhookSecret, razorpaySignatureOk } from "./integrations/own/razorpay/webhooks";
import { ensureWebhook } from "./integrations/composio";
import { AppsError } from "./integrations/types";
import { DEFAULT_ZONE, timezoneOf } from "./time";
import { cloud } from "./cloud";
import { JOB_MINUTES, reportsDue } from "./jobs";

const REPO = "company";
const FOLDER = "automations";
const NAME = /^[a-z0-9][a-z0-9-]{0,62}$/;
const ACTION = /^[a-z0-9_]+\.[a-z0-9_]+$/i;
// ponytail: every business is in India for now (same as AGENT.md's default)
const WHEN = ["trigger", "schedule", "manual"] as const;
type Row = typeof automations.$inferSelect;

export class AutomationError extends Error {}

const canManage = (who: Pick<Ctx, "role">) => who.role !== "member";

// The file's settings and prompt, or what's wrong with it.
// `zone`: the schedule's time zone when the file names none (whoever saved it, time.ts)
export function parseAutomation(text: string, zone = DEFAULT_ZONE) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)([\s\S]*)$/.exec(text);
  if (!m) return { error: "the file must start with settings between --- lines, then the prompt" } as const;
  let s: Record<string, unknown>;
  try {
    s = (Bun.YAML.parse(m[1]!) ?? {}) as Record<string, unknown>;
  } catch (error) {
    return { error: `the settings aren't valid YAML: ${(error as Error).message}` } as const;
  }
  if (typeof s !== "object" || Array.isArray(s)) return { error: "the settings must be key: value lines" } as const;
  const when = s.when as (typeof WHEN)[number];
  const prompt = m[2]!.trim();
  const timezone = typeof s.timezone === "string" ? s.timezone : zone;
  const enabled = s.enabled ?? true;
  const config = s.config ?? {};
  if (!WHEN.includes(when)) return { error: "when: must be trigger, schedule or manual" } as const;
  if (!prompt) return { error: "the prompt (after the settings) is empty" } as const;
  if (typeof enabled !== "boolean") return { error: "enabled: must be true or false" } as const;
  if (when === "trigger" && typeof s.trigger !== "string") return { error: "trigger: is missing (like gmail.new_gmail_message)" } as const;
  if (typeof config !== "object" || Array.isArray(config)) return { error: "config: must be key: value settings" } as const;
  if (s.agent !== undefined && typeof s.agent !== "string") return { error: 'agent: must be an agent\'s name, like "Supplier Finder" (emplio agents list)' } as const;
  if (s.account !== undefined && typeof s.account !== "string") return { error: 'account: must be an account name, like "me@work.com"' } as const;
  const actions = s.actions ?? [];
  if (!Array.isArray(actions) || actions.some((a) => typeof a !== "string" || !ACTION.test(a)))
    return { error: "actions: must be a list of app actions, like [gmail.send_email, todoist.create_task]" } as const;
  if (when === "schedule") {
    if (typeof s.schedule !== "string") return { error: 'schedule: is missing (cron, like "0 9 * * 1-5")' } as const;
    try {
      new Cron(s.schedule, { timezone });
    } catch (error) {
      return { error: `schedule: ${(error as Error).message}` } as const;
    }
  }
  return {
    when,
    trigger: when === "trigger" ? (s.trigger as string) : null,
    triggerConfig: when === "trigger" ? config : null,
    account: when === "trigger" ? ((s.account as string | undefined) ?? null) : null,
    schedule: when === "schedule" ? (s.schedule as string) : null,
    timezone: when === "schedule" ? timezone : null,
    enabled,
    prompt,
    agent: typeof s.agent === "string" ? s.agent : null,
    actions: [...new Set(actions as string[])],
  };
}

const nextRun = (row: { schedule?: string | null; timezone?: string | null }) => new Cron(row.schedule!, { timezone: row.timezone ?? DEFAULT_ZONE }).nextRun();

// Stop watching a trigger, unless another automation shares it (the provider hands out one per login and settings).
async function stopWatching(row: Pick<Row, "id" | "provider" | "externalId">) {
  if (!row.provider || !row.externalId) return;
  const [other] = await db
    .select({ id: automations.id })
    .from(automations)
    .where(and(eq(automations.externalId, row.externalId), ne(automations.id, row.id)))
    .limit(1);
  if (!other) await Promise.resolve(stopTrigger(row.provider, row.externalId)).catch((error) => console.warn("stopping trigger failed", error));
}

// The row for one file, from its text and whoever last committed it.
async function build(workspaceId: string, name: string, sha: string, old: Row | undefined) {
  const path = `${FOLDER}/${name}.md`;
  const [text, author] = await Promise.all([readFile(workspaceId, REPO, path), lastAuthor(workspaceId, REPO, path)]);
  const [member] = author
    ? await db
        .select({ id: users.id, role: workspaceMembers.role })
        .from(workspaceMembers)
        .innerJoin(users, eq(users.id, workspaceMembers.userId))
        .where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(users.email, author.email.toLowerCase())))
    : [];
  const parsed = parseAutomation(text ?? "", await timezoneOf(member?.id));
  const base = { workspaceId, name, sha, userId: member?.id ?? null, provider: null, externalId: null, nextRunAt: null, pollState: null, updatedAt: new Date() };
  if ("error" in parsed) return { ...base, when: "manual", enabled: false, prompt: text ?? "", actions: [], allowed: [], error: parsed.error! } satisfies typeof automations.$inferInsert;
  // what it does: the file's actions:, and any app action its prompt names that sends or changes something, so a
  // file that forgets to list one still gets it asked about rather than refused on every run
  parsed.actions = [...new Set([...parsed.actions, ...(await changesNamed(parsed.prompt, workspaceId)), ...(await toolsThatChange(workspaceId, parsed, member))])];
  // what was allowed stays allowed while it's still listed and runs as the same person
  const allowed = old && old.userId === member?.id ? old.allowed.filter((a) => parsed.actions.includes(a)) : [];
  const values: typeof automations.$inferInsert = { ...base, ...parsed, allowed, error: null };
  if (!member) values.error = `${author?.email ?? "whoever saved it"} isn't on the team, so it has nobody to run as; an admin saving it again takes it over`;
  else if (member.role === "member") values.error = "only the owner or an admin can set up automations";
  else if (values.when === "schedule") values.nextRunAt = nextRun(values);
  else if (values.when === "trigger" && values.enabled) {
    // an app whose triggers depend on the plan is started afresh, so a plan change takes (recheckPlans)
    const same =
      !OWN_APPS[values.trigger!.split(".")[0]!]?.plans &&
      old?.externalId &&
      old.trigger === values.trigger &&
      old.userId === values.userId &&
      old.account === values.account &&
      JSON.stringify(old.triggerConfig) === JSON.stringify(values.triggerConfig);
    if (same) Object.assign(values, { provider: old.provider, externalId: old.externalId });
    else
      try {
        Object.assign(values, await startTrigger({ workspaceId, userId: member.id }, values.trigger!, values.triggerConfig, values.account ?? undefined));
      } catch (error) {
        if (!(error instanceof AppsError)) throw error;
        values.error = error.message;
      }
    if (values.provider === "poll") {
      // first check now; the seen items carry over unless the trigger, settings or person changed
      const key = JSON.stringify([values.trigger, values.triggerConfig, values.userId, values.account]);
      Object.assign(values, { nextRunAt: new Date(), pollState: old?.pollState?.key === key ? old.pollState : { key, seen: null } });
    }
  }
  return values;
}

// Make the rows match the files in git: new and changed files are read again, removed ones dropped.
// Rows with an error are retried every time (the app may have been connected since).
const syncing = new Map<string, Promise<unknown>>();
export function syncAutomations(workspaceId: string): Promise<void> {
  const run = (syncing.get(workspaceId) ?? Promise.resolve()).then(async () => {
    const files = (await listFolder(workspaceId, REPO, FOLDER)).filter((f) => f.name.endsWith(".md") && NAME.test(f.name.slice(0, -3)));
    const rows = await db.select().from(automations).where(eq(automations.workspaceId, workspaceId));
    for (const row of rows)
      if (!files.some((f) => f.name === `${row.name}.md`)) {
        await db.delete(automations).where(eq(automations.id, row.id));
        await stopWatching(row);
      }
    for (const f of files) {
      const name = f.name.slice(0, -3);
      const old = rows.find((r) => r.name === name);
      // one with no owner is looked at again: its person may be found now (an upkeep commit once hid them)
      // ponytail: re-reads ownerless files every sync; fine while they're rare
      if (old && old.sha === f.sha && !old.error && old.userId) continue;
      const values = await build(workspaceId, name, f.sha, old);
      await db.insert(automations).values(values).onConflictDoUpdate({ target: [automations.workspaceId, automations.name], set: values });
      if (!old) cloud.onWork(workspaceId, null, "automation");
      if (old?.externalId && old.externalId !== values.externalId) await stopWatching(old);
    }
  });
  syncing.set(workspaceId, run.catch(() => {}));
  return run;
}

// Who a run acts as: the person behind the automation, with their current role.
export async function personFor(workspaceId: string, userId: string): Promise<Ctx | null> {
  const [m] = await db
    .select({ name: users.name, email: users.email, role: workspaceMembers.role, workspaceName: workspaces.name })
    .from(workspaceMembers)
    .innerJoin(users, eq(users.id, workspaceMembers.userId))
    .innerJoin(workspaces, eq(workspaces.id, workspaceMembers.workspaceId))
    .where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, userId)));
  if (!m?.name) return null;
  return { userId, userName: m.name, userEmail: m.email, workspaceId, workspaceName: m.workspaceName, role: m.role };
}

// A run's last line starts with this when the work didn't get done: the run shows as failed, with that line as why.
export const NOT_DONE = "[NOT DONE]";

// What a run came to: failed on an error, on its own word (NOT_DONE) or when it ended without a word on what came
// of it; otherwise done. said: what goes to the person's main chat (null: routine, nothing to say).
// problem: one it (or one of its agents, or the server for a command that couldn't run) reported during the run. A run
// that reported one can't pass as routine: it fails, so the person hears and the background check-in sets out to fix it.
export function outcome(error: string | null, words: string | null, problem: string | null = null) {
  const why =
    error ??
    (!words?.trim()
      ? "it ended without saying what came of it"
      : words.includes(NOT_DONE)
        ? words.replace(NOT_DONE, "").trim() || "it didn't get the work done"
        : problem && words.includes(SILENT)
          ? `it hit a problem and still reported nothing to do: ${problem}`
          : null);
  if (why) return { status: "failed", error: why, said: `failed: ${why}` } as const;
  return { status: "done", error: null, said: words!.includes(SILENT) ? null : words!.trim() } as const;
}

// The latest problem reported in a run's chat or its agents' job chats since it started
export async function problemIn(conversationId: string, since: Date) {
  const chats = db.select({ id: jobs.chatId }).from(jobs).where(eq(jobs.conversationId, conversationId));
  const [p] = await db
    .select({ summary: activity.summary })
    .from(activity)
    .where(and(eq(activity.kind, "problem"), gte(activity.createdAt, since), or(eq(activity.conversationId, conversationId), inArray(activity.conversationId, chats))))
    .orderBy(desc(activity.createdAt))
    .limit(1);
  return p?.summary ?? null;
}

// Runs whose reply ended with hand-offs still out: each ends with the reply their reports wake (woke, from jobs.ts).
// ponytail: in memory; a restart leaves such a run "running", as one cut off mid-reply already is
const handedOff = new Map<string, (error: string | null) => Promise<void>>();
export async function woke(conversationId: string, error: string | null) {
  const finish = handedOff.get(conversationId);
  if (!finish || (!error && (await reportsDue(conversationId)))) return;
  handedOff.delete(conversationId);
  await finish(error);
}

const clip = (text: string, max: number) => (text.length <= max ? text : `${text.slice(0, max)}\n... (${text.length - max} more characters cut)`);
const LABEL = { trigger: "an app event", schedule: "its schedule", manual: "someone ran it" };

// A run's first message: the automation's prompt, the event that started it, and how to end.
export const runMessage = (row: Pick<Row, "name" | "agent" | "prompt">, userName: string, reason: (typeof WHEN)[number], event?: unknown) =>
  [
    row.agent
      ? `${AUTOMATION_PREFIX}Automation "${row.name}" started (${LABEL[reason]}). Hand this to your ${row.agent} agent: emplio hand ${JSON.stringify(row.agent)}, with the work below and the event as its brief. Wait for it, check its report, then finish what's left yourself:`
      : `${AUTOMATION_PREFIX}Automation "${row.name}" started (${LABEL[reason]}). Do this:`,
    "",
    row.prompt,
    ...(event === undefined ? [] : ["", "The event that started it:", "```json", clip(JSON.stringify(event, null, 2), 20_000), "```"]),
    "",
    `End with a line or two for ${userName} on what came of it; they get it in their main chat. If it was routine and nothing needs them, end with exactly ${SILENT} instead. If the work didn't get done (something blocked it so little or none of it went through, a hand-off came back empty or failed and you couldn't finish it), start that line with ${NOT_DONE} and say why, even when it's the same as last time; never ${SILENT} then. Most of it done with a few left over is done (say what's left), and so is nothing to do this time.`,
  ].join("\n");

// Start a run in a new chat; returns once the chat exists, while the reply carries on in the background.
async function fire(row: Row, reason: (typeof WHEN)[number], event?: unknown) {
  // paused: the run is listed as not having happened and why, with no message (heldBack tells the owner once)
  const paused = await heldBack(row.workspaceId);
  const person = !paused && row.userId ? await personFor(row.workspaceId, row.userId) : null;
  const conversationId = crypto.randomUUID();
  if (person)
    await db.insert(conversations).values({ id: conversationId, workspaceId: row.workspaceId, userId: person.userId, title: `Automation: ${row.name}`, kind: "background" });
  const [run] = await db
    .insert(automationRuns)
    .values({
      workspaceId: row.workspaceId,
      automationId: row.id,
      name: row.name,
      reason,
      conversationId: person ? conversationId : null,
      ...(!person && { status: "failed" as const, error: paused ?? "nobody to run it as", finishedAt: new Date() }),
    })
    .returning();
  if (!person) return { runId: run!.id, conversationId: null };

  const text = runMessage(row, person.userName, reason, event);
  const message: UIMessage = { id: generateId(), role: "user", parts: [{ type: "text", text }] };
  const finish = async (failure: string | null) => {
    await quiet(conversationId);
    // the markers anywhere count, even after a line ("No new notes this run. [SILENT]")
    const { status, error, said } = outcome(failure, failure ? null : await lastWords(conversationId), await problemIn(conversationId, run!.startedAt));
    record({ workspaceId: row.workspaceId, userId: person.userId, conversationId, kind: "automation", summary: `Automation "${row.name}" ${error ? `failed: ${error}` : "finished"}` });
    await db.update(automationRuns).set({ status, error, finishedAt: new Date() }).where(eq(automationRuns.id, run!.id));
    // what came of it, in their main chat (and on their phone): always a failure, a success unless it was routine
    if (said) await post(row.workspaceId, person.userId, `**Automation "${row.name}"** ${said}\n\n[Open the run](${chatLink(conversationId)})`, { from: conversationId });
  };
  void (async () => {
    const log = { error: (obj: unknown, msg: string) => console.error(`automation ${row.name}: ${msg}`, obj) };
    let error: string | null = null;
    for await (const chunk of (await generateReply(person, conversationId, message, log, row.name))!)
      if (chunk.type === "error") error = chunk.errorText;
    // handed off and didn't wait them out: what came of it is in the reply their reports wake
    if (!error && (await reportsDue(conversationId))) {
      handedOff.set(conversationId, finish);
      // reports that never come (a thread stopped by hand goes back to nobody) still end it, past a thread's own time
      setTimeout(() => void woke(conversationId, "its hand-offs never reported back").catch(() => {}), (JOB_MINUTES + 15) * 60_000).unref?.();
      return;
    }
    await finish(error);
  })().catch((error) => finish(String(error)).catch(() => {}));
  return { runId: run!.id, conversationId };
}

// --- the shared functions behind the app's routes and `emplio automations` ---

const toRun = (r: typeof automationRuns.$inferSelect): AutomationRun => ({
  id: r.id,
  name: r.name,
  reason: r.reason,
  status: r.status,
  error: r.error,
  conversationId: r.conversationId,
  startedAt: r.startedAt.toISOString(),
  finishedAt: r.finishedAt?.toISOString() ?? null,
});

export async function listAutomations(workspaceId: string): Promise<Automation[]> {
  await syncAutomations(workspaceId);
  const rows = await db
    .select({ a: automations, ownerName: users.name, ownerEmail: users.email })
    .from(automations)
    .leftJoin(users, eq(users.id, automations.userId))
    .where(eq(automations.workspaceId, workspaceId))
    .orderBy(automations.name);
  const runs = await listAutomationRuns(workspaceId, undefined, 200);
  return Promise.all(rows.map(async ({ a, ownerName, ownerEmail }) => ({
    name: a.name,
    when: a.when,
    trigger: a.trigger,
    schedule: a.schedule,
    timezone: a.timezone,
    enabled: a.enabled,
    prompt: a.prompt,
    agent: a.agent,
    actions: await Promise.all(a.actions.map(async (action) => ({ ...(await describe(action)), action, allowed: a.allowed.includes(action) }))),
    error: a.error,
    owner: a.userId ? { id: a.userId, name: ownerName ?? ownerEmail ?? "" } : null,
    nextRunAt: a.enabled && !a.error ? (a.nextRunAt?.toISOString() ?? null) : null,
    lastRun: runs.find((r) => r.name === a.name) ?? null,
  })));
}

// The app actions a prompt names (gmail.send_email) that send or change something
async function changesNamed(prompt: string, workspaceId: string) {
  const named = [...new Set(prompt.match(/\b[a-z0-9]+\.[a-z0-9_]+\b/gi) ?? [])].filter((a) => ACTION.test(a) && a.includes("_")).slice(0, 20);
  const found = await Promise.all(named.map(async (a) => ((await getAction(a, { workspaceId }).catch(() => null))?.readOnly === false ? [a] : [])));
  return found.flat();
}

// The saved tools it uses that change things or spend money, already kept when it's set up: the ones its prompt names
// and its agent's. Listed like app actions, so they're allowed once for every run the same way. A tool made later
// isn't on the list, and its runs use it anyway (approvals.ts).
async function toolsThatChange(workspaceId: string, a: { prompt: string; agent: string | null }, member?: { id: string; role: string }) {
  const who = { workspaceId, userId: member?.id, admin: member?.role === "owner" || member?.role === "admin" };
  const agent = a.agent ? await findAgent(workspaceId, a.agent, who).catch(() => null) : null;
  const names = [...toolsUsed([{ input: { code: a.prompt } }]), ...[...a.prompt.matchAll(/\btools\.([a-z][a-z0-9_]*\.[A-Za-z]\w*)/g)].map((m) => m[1]!), ...(agent?.tools ?? [])];
  const tools = await findTools(who, [...new Set(names)]).catch(() => []);
  return tools.filter((t) => !onlyReads(t)).map((t) => `tools.${t.name}`);
}

// An action as the person reads it: its title and app
// ponytail: looked up on every list; cache like approvals.ts does if the Automations screen gets slow
async function describe(action: string) {
  if (action.startsWith("tools.")) return { title: `Saved tool ${action.slice("tools.".length)}`, app: "Tools", logo: undefined };
  const app = action.split(".")[0]!;
  const [detail, card] = await Promise.all([getAction(action).catch(() => null), connectCard(app).catch(() => null)]);
  return { title: detail?.title ?? action, app: card?.name ?? app, logo: card?.logo };
}

// Which of its listed actions its runs may do without asking (an owner or admin decides; the rest are refused).
export async function allowActions(who: Pick<Ctx, "workspaceId" | "role">, name: string, actions: string[]) {
  if (!canManage(who)) throw new AutomationError("only the owner or an admin can allow what automations do");
  const row = await db.query.automations.findFirst({ where: and(eq(automations.workspaceId, who.workspaceId), eq(automations.name, name)) });
  if (!row) throw new AutomationError(`no automation ${name}`);
  await db.update(automations).set({ allowed: row.actions.filter((a) => actions.includes(a)) }).where(eq(automations.id, row.id));
}

// The actions a run in this chat may do unasked: the automation's allowed ones, if an automation started the chat
export async function allowedIn(conversationId: string) {
  const [row] = await db
    .select({ allowed: automations.allowed, actions: automations.actions })
    .from(automationRuns)
    .innerJoin(automations, eq(automations.id, automationRuns.automationId))
    .where(eq(automationRuns.conversationId, conversationId))
    .limit(1);
  // listed: everything it lists (undefined when no automation started the chat)
  return { allowed: row?.allowed ?? [], listed: row?.actions };
}

// Saved from a chat: one card there asking to allow what it will do on every run, while the person is here to say so.
// A string for the agent: what was allowed, or why not.
export async function askToAllow(s: Session, a: Automation) {
  const missing = a.actions.filter((x) => !x.allowed);
  if (!missing.length) return a.actions.length ? "Everything it does is allowed already." : "";
  const list = missing.map((x) => `${x.title} (${x.app})`).join(", ");
  const allow = () => allowActions(s, a.name, [...a.actions.filter((x) => x.allowed), ...missing].map((x) => x.action));
  const refused = await approve(s, "automation.allow", { automation: a.name, "on every run": list }, {
    own: { title: `Let "${a.name}" do this on every run: ${list}`, readOnly: false, appName: missing[0]!.app, logo: missing[0]!.logo, alwaysAsk: true, run: allow },
  });
  if (refused) return `${refused}\n(Until it's allowed, runs can't do: ${list}. It can also be allowed in Automations.)`;
  await allow();
  return `${s.user.name} allowed it: its runs can do ${list} without asking. Nothing more is needed from them.`;
}

export async function listAutomationRuns(workspaceId: string, name?: string, limit = 50) {
  const rows = await db
    .select()
    .from(automationRuns)
    .where(and(eq(automationRuns.workspaceId, workspaceId), name ? eq(automationRuns.name, name) : undefined))
    .orderBy(desc(automationRuns.startedAt))
    .limit(Math.min(limit, 200));
  return rows.map(toRun);
}

const checkName = (name: string) => {
  if (!NAME.test(name)) throw new AutomationError(`"${name}" isn't a usable name: lowercase letters, digits and dashes, like daily-sales-summary`);
  return `${FOLDER}/${name}.md`;
};

// The file as written, for editing.
export async function readAutomation(workspaceId: string, name: string) {
  const text = await readFile(workspaceId, REPO, checkName(name));
  if (text === null) throw new AutomationError(`no automation ${name}`);
  return text;
}

// Create (mode add), change (update) or either (put) an automation's file, as this person, then sync and
// return it, with what's wrong if it can't run.
export async function saveAutomation(who: Ctx, name: string, text: string, mode: "add" | "update" | "put") {
  if (!canManage(who)) throw new AutomationError("only the owner or an admin can change automations");
  const path = checkName(name);
  const exists = (await readFile(who.workspaceId, REPO, path)) !== null;
  if (mode === "add" && exists) throw new AutomationError(`${name} already exists; change it with update`);
  if (mode === "update" && !exists) throw new AutomationError(`no automation ${name}; create it with add`);
  const parsed = parseAutomation(text, await timezoneOf(who.userId));
  // refuse broken settings up front instead of committing them
  if ("error" in parsed) throw new AutomationError(parsed.error!);
  const author = { name: who.userName, email: who.userEmail };
  await writeFile(who.workspaceId, REPO, path, text.endsWith("\n") ? text : `${text}\n`, `${exists ? "Edited" : "Added"} automation ${name}\n\nBy ${who.userName}`, author);
  await syncAutomations(who.workspaceId);
  return (await listAutomations(who.workspaceId)).find((a) => a.name === name)!;
}

export async function removeAutomation(who: Ctx, name: string) {
  if (!canManage(who)) throw new AutomationError("only the owner or an admin can change automations");
  const author = { name: who.userName, email: who.userEmail };
  if (!(await writeFile(who.workspaceId, REPO, checkName(name), null, `Removed automation ${name}\n\nBy ${who.userName}`, author)))
    throw new AutomationError(`no automation ${name}`);
  await syncAutomations(who.workspaceId);
}

// Turn it on or off: the enabled: line in its settings.
export async function setEnabled(who: Ctx, name: string, enabled: boolean) {
  const text = await readAutomation(who.workspaceId, name);
  const end = text.indexOf("\n---", 3);
  if (!text.startsWith("---") || end < 0) throw new AutomationError(`${name}'s file has no settings block; fix it with update`);
  const head = text.slice(0, end);
  const line = `enabled: ${enabled}`;
  const changed = /^enabled:.*$/m.test(head) ? head.replace(/^enabled:.*$/m, line) : `${head}\n${line}`;
  return saveAutomation(who, name, changed + text.slice(end), "update");
}

// Run it now, whatever starts it normally. Runs as the automation's person, so only managers (or that person) may.
export async function runAutomation(who: Ctx, name: string) {
  checkName(name);
  await syncAutomations(who.workspaceId);
  const row = await db.query.automations.findFirst({ where: and(eq(automations.workspaceId, who.workspaceId), eq(automations.name, name)) });
  if (!row) throw new AutomationError(`no automation ${name}`);
  if (!canManage(who) && row.userId !== who.userId) throw new AutomationError("only the owner, an admin or its own person can run it");
  if (row.error && !row.userId) throw new AutomationError(`it can't run: ${row.error}`);
  const paused = await heldBack(who.workspaceId);
  if (paused) throw new AutomationError(paused);
  return fire(row, "manual");
}

// --- what starts runs ---

// Due schedules, checked every 30 seconds. Moving nextRunAt on (only while still due) claims the run, so it fires once
// even with several servers. A run missed while the server was down fires once on start.
async function tick() {
  const due = await db
    .select()
    .from(automations)
    .where(and(eq(automations.when, "schedule"), eq(automations.enabled, true), isNull(automations.error), lte(automations.nextRunAt, new Date())));
  for (const row of due) {
    const [claimed] = await db
      .update(automations)
      .set({ nextRunAt: nextRun(row) })
      .where(and(eq(automations.id, row.id), lte(automations.nextRunAt, new Date())))
      .returning();
    if (claimed) await fire(claimed, "schedule").catch((error) => console.error("automation run failed to start", row.name, error));
  }
  const polls = await db
    .select()
    .from(automations)
    .where(and(eq(automations.provider, "poll"), eq(automations.enabled, true), isNull(automations.error), lte(automations.nextRunAt, new Date())));
  for (const row of polls) void poll(row).catch((error) => console.error("automation poll failed", row.name, error));
}

// One check of a trigger we poll: claim it (like a schedule), ask the app, fire once per new item.
async function poll(row: Row) {
  // not claimed, so what comes in meanwhile is still new when the business is back
  if (await heldBack(row.workspaceId)) return;
  const { every, config } = pollConfig(row.trigger!, row.triggerConfig);
  const [claimed] = await db
    .update(automations)
    .set({ nextRunAt: new Date(Date.now() + every * 60_000) })
    .where(and(eq(automations.id, row.id), lte(automations.nextRunAt, new Date())))
    .returning();
  if (!claimed?.pollState || !claimed.userId) return;
  const who = { workspaceId: row.workspaceId, userId: claimed.userId };
  let result: Awaited<ReturnType<typeof pollOnce>>;
  try {
    result = await pollOnce(row.trigger!, config, claimed.pollState.seen, (action, input) =>
      runAction(who, action, input, { quiet: true, account: claimed.account ?? undefined }),
    );
  } catch (error) {
    if (!(error instanceof AppsError)) throw error;
    // a sign-in problem stops it until fixed (the next sync retries); anything else, the next check tries again
    if (/isn't connected|signing in again/.test(error.message))
      await db.update(automations).set({ error: `${error.message}; reconnect it, then open Automations or save the file again` }).where(eq(automations.id, row.id));
    else console.warn(`automation ${row.name}: check failed: ${error.message}`);
    return;
  }
  await db.update(automations).set({ pollState: { key: claimed.pollState.key, seen: result.seen } }).where(eq(automations.id, row.id));
  // ponytail: at most 10 runs per check, the rest are marked seen; a queue if bursts matter
  for (const event of result.fresh.slice(0, 10)) await fire(claimed, "trigger", event);
}

let webhookSecret: string | null = null;

// Hourly: trigger automations of apps whose triggers depend on the plan (OwnApp.plans), set up again where the plan
// changed what they get: started on an upgrade, polled instead of told at once on a downgrade, refused once unpaid.
export async function recheckPlans() {
  const apps = Object.keys(OWN_APPS).filter((a) => OWN_APPS[a]!.plans);
  if (!apps.length) return;
  const rows = await db
    .select({ id: automations.id, workspaceId: automations.workspaceId, trigger: automations.trigger, provider: automations.provider, error: automations.error })
    .from(automations)
    .where(and(eq(automations.when, "trigger"), eq(automations.enabled, true)));
  const redo = new Set<string>();
  for (const row of rows) {
    const app = row.trigger?.split(".")[0] ?? "";
    if (!apps.includes(app)) continue;
    const want = await triggerPlan(row.workspaceId, app).then(
      (p) => (p.instant ? "instant" : "poll"),
      () => "refused",
    );
    const has = row.error ? "refused" : row.provider === "poll" ? "poll" : "instant";
    if (want === has) continue;
    // a changed sha makes the next sync read it again
    await db.update(automations).set({ sha: "" }).where(eq(automations.id, row.id));
    redo.add(row.workspaceId);
  }
  for (const workspaceId of redo) await syncAutomations(workspaceId).catch((error) => console.error("rechecking plans failed", workspaceId, error));
}

export async function startAutomations() {
  setInterval(() => void tick().catch((error) => console.error("automation timer failed", error)), 30_000);
  setInterval(() => void recheckPlans().catch((error) => console.error("rechecking plans failed", error)), 3600_000);
  void tick().catch((error) => console.error("automation timer failed", error));
  // where the provider posts trigger events; without it, trigger automations save fine but never fire
  if (process.env.WEBHOOK_URL)
    webhookSecret = await ensureWebhook(`${process.env.WEBHOOK_URL}/webhooks/composio`).catch((error) => {
      console.error("setting up the Composio webhook failed; trigger automations won't fire", error);
      return null;
    });
  else console.warn("WEBHOOK_URL not set; trigger automations won't fire");
}

// Standard Webhooks signature: base64 HMAC-SHA256 of "<id>.<timestamp>.<body>", sent as "v1,<sig>" (several, space-separated).
export function signatureOk(secret: string, id: string, timestamp: string, body: string, header: string, now = Date.now()) {
  if (!id || !timestamp || !header || Math.abs(now / 1000 - Number(timestamp)) > 300) return false;
  const key = secret.startsWith("whsec_") ? Buffer.from(secret.slice(6), "base64") : secret;
  const expected = Buffer.from(createHmac("sha256", key).update(`${id}.${timestamp}.${body}`).digest("base64"));
  return header.split(" ").some((s) => {
    const sig = Buffer.from(s.slice(s.indexOf(",") + 1));
    return sig.length === expected.length && timingSafeEqual(sig, expected);
  });
}

// webhook ids already handled: the provider retries until it gets a 200
const seen = new Set<string>();

async function onEvent(event: { type?: string; metadata?: { trigger_id?: string }; data?: unknown }) {
  const externalId = event.metadata?.trigger_id;
  if (!externalId) return;
  if (event.type === "composio.trigger.disabled") {
    // the next sync retries it (say, after the app is reconnected)
    await db
      .update(automations)
      .set({ error: "the app stopped sending its events (sign-in expired?); reconnect it, then open Automations or save the file again", externalId: null })
      .where(eq(automations.externalId, externalId));
    return;
  }
  if (event.type !== "composio.trigger.message") return;
  const rows = await db
    .select()
    .from(automations)
    .where(and(eq(automations.externalId, externalId), eq(automations.enabled, true), isNull(automations.error)));
  for (const row of rows) await fire(row, "trigger", event.data);
}

// An event from a business's own Razorpay account; the automations on that connection waiting for it run.
async function onRazorpayEvent(connection: string, event: { event?: string; payload?: Record<string, any> }) {
  const names = triggersFor(event.event ?? "");
  if (!names.length) return;
  const rows = await db
    .select()
    .from(automations)
    .where(and(eq(automations.externalId, watchId(connection)), inArray(automations.trigger, names), eq(automations.enabled, true), isNull(automations.error)));
  for (const row of rows) await fire(row, "trigger", eventData(event.payload));
}

// An event from a GitHub repository; the automations watching it on that connection, whose settings want it, run.
async function onGithubEvent(id: string, event: string, payload: Record<string, any>) {
  const names = githubHooks.triggersFor(event, payload);
  if (!names.length) return;
  const rows = await db
    .select()
    .from(automations)
    .where(and(eq(automations.externalId, id), inArray(automations.trigger, names), eq(automations.enabled, true), isNull(automations.error)));
  const data = githubHooks.eventData(payload);
  for (const row of rows) if (githubHooks.wanted(row.triggerConfig, payload)) await fire(row, "trigger", data);
}

// Events from an app on the shared webhook route: the automations on that id waiting for them, whose settings want them, run.
async function onAppEvents(app: string, fallback: string[], events: WebhookEvent[]) {
  const { push } = OWN_APPS[app]!;
  for (const event of events) {
    if (!event.triggers.length) continue;
    if (event.id) {
      if (seen.has(`${app}:${event.id}`)) continue;
      seen.add(`${app}:${event.id}`);
      if (seen.size > 10_000) seen.delete(seen.values().next().value!);
    }
    const names = event.triggers.map((t) => `${app}.${t}`);
    // no id from the app: the address it came to, or the connection itself (apps whose address carries only a token)
    const ids = event.watch ? [event.watch] : fallback;
    const rows = await db
      .select()
      .from(automations)
      .where(and(inArray(automations.externalId, ids), inArray(automations.trigger, names), eq(automations.enabled, true), isNull(automations.error)));
    for (const row of rows) if (push?.wanted?.(row.triggerConfig, event.data) ?? true) await fire(row, "trigger", event.data);
  }
}

// --- the app's routes, and the webhook ---

export async function automationRoutes(app: FastifyInstance) {
  const handle = async <T>(reply: { code(n: number): { send(b: unknown): unknown } }, fn: () => Promise<T>) => {
    try {
      return await fn();
    } catch (error) {
      if (error instanceof AutomationError || error instanceof AppsError) return reply.code(400).send({ error: error.message });
      throw error;
    }
  };

  app.get("/automations", async (req, reply) => {
    const ctx = await context(req, reply);
    if (!ctx) return;
    return listAutomations(ctx.workspaceId);
  });

  app.get<{ Params: { name: string } }>("/automations/:name", async (req, reply) => {
    const ctx = await context(req, reply);
    if (!ctx) return;
    return handle(reply, async () => {
      const text = await readAutomation(ctx.workspaceId, req.params.name);
      // the settings too, so the app can show them as a form
      return { text, ...parseAutomation(text, await timezoneOf(ctx.userId)) };
    });
  });

  app.put<{ Params: { name: string }; Body: { text: string } }>(
    "/automations/:name",
    { schema: { body: { type: "object", required: ["text"], properties: { text: { type: "string", maxLength: 50_000 } } } } },
    async (req, reply) => {
      const ctx = await context(req, reply);
      if (!ctx) return;
      return handle(reply, () => saveAutomation(ctx, req.params.name, req.body.text, "put"));
    },
  );

  app.patch<{ Params: { name: string }; Body: { enabled: boolean } }>(
    "/automations/:name",
    { schema: { body: { type: "object", required: ["enabled"], properties: { enabled: { type: "boolean" } } } } },
    async (req, reply) => {
      const ctx = await context(req, reply);
      if (!ctx) return;
      return handle(reply, () => setEnabled(ctx, req.params.name, req.body.enabled));
    },
  );

  app.delete<{ Params: { name: string } }>("/automations/:name", async (req, reply) => {
    const ctx = await context(req, reply);
    if (!ctx) return;
    return handle(reply, async () => (await removeAutomation(ctx, req.params.name), { ok: true }));
  });

  // which of its listed actions its runs may do (the Automations screen)
  app.put<{ Params: { name: string }; Body: { allowed: string[] } }>(
    "/automations/:name/allowed",
    { schema: { body: { type: "object", required: ["allowed"], properties: { allowed: { type: "array", maxItems: 100, items: { type: "string", maxLength: 200 } } } } } },
    async (req, reply) => {
      const ctx = await context(req, reply);
      if (!ctx) return;
      return handle(reply, async () => (await allowActions(ctx, req.params.name, req.body.allowed), { ok: true }));
    },
  );

  app.post<{ Params: { name: string } }>("/automations/:name/run", async (req, reply) => {
    const ctx = await context(req, reply);
    if (!ctx) return;
    return handle(reply, () => runAutomation(ctx, req.params.name));
  });

  app.get<{ Querystring: { name?: string; limit?: string } }>("/automation-runs", async (req, reply) => {
    const ctx = await context(req, reply);
    if (!ctx) return;
    return listAutomationRuns(ctx.workspaceId, req.query.name, Number(req.query.limit) || 50);
  });

  // Composio posts trigger events here (the only path the dev tunnel lets in). Signed, so the raw body is kept.
  await app.register(async (hooks) => {
    hooks.addContentTypeParser("application/json", { parseAs: "string", bodyLimit: 5 * 1024 * 1024 }, (_req, body, done) => done(null, body));
    // form-encoded deliveries (Mailchimp's), kept raw for the app to read
    hooks.addContentTypeParser("application/x-www-form-urlencoded", { parseAs: "string", bodyLimit: 5 * 1024 * 1024 }, (_req, body, done) => done(null, body));
    // multipart deliveries (Dropbox Sign's callbacks), kept raw for the app to read
    hooks.addContentTypeParser("multipart/form-data", { parseAs: "string", bodyLimit: 5 * 1024 * 1024 }, (_req, body, done) => done(null, body));
    hooks.post<{ Body: string }>("/webhooks/composio", async (req, reply) => {
      const h = (name: string) => String(req.headers[name] ?? "");
      if (!webhookSecret || !signatureOk(webhookSecret, h("webhook-id"), h("webhook-timestamp"), req.body, h("webhook-signature")))
        return reply.code(401).send({ error: "bad signature" });
      if (seen.has(h("webhook-id"))) return { ok: true };
      seen.add(h("webhook-id"));
      if (seen.size > 10_000) seen.delete(seen.values().next().value!);
      // answer at once; runs start in the background
      void onEvent(JSON.parse(req.body)).catch((error) => req.log.error(error, "handling a trigger event failed"));
      return { ok: true };
    });
    // A business's own Razorpay account, connected as an app.
    hooks.post<{ Body: string; Params: { connection: string } }>("/webhooks/razorpay/:connection", async (req, reply) => {
      const { connection } = req.params;
      if (!razorpaySignatureOk(req.body, String(req.headers["x-razorpay-signature"] ?? ""), razorpayWebhookSecret(connection))) return reply.code(401).send({ error: "bad signature" });
      const id = String(req.headers["x-razorpay-event-id"] ?? "");
      if (id && seen.has(id)) return { ok: true };
      if (id) seen.add(id);
      if (seen.size > 10_000) seen.delete(seen.values().next().value!);
      void onRazorpayEvent(connection, JSON.parse(req.body)).catch((error) => req.log.error(error, "handling a Razorpay event failed"));
      return { ok: true };
    });
    // A repository on a connected GitHub account. The same signature as Razorpay's, behind "sha256=".
    hooks.post<{ Body: string; Params: { connection: string; owner: string; repo: string } }>("/webhooks/github/:connection/:owner/:repo", async (req, reply) => {
      const { connection, owner, repo } = req.params;
      const signature = String(req.headers["x-hub-signature-256"] ?? "").replace(/^sha256=/, "");
      if (!razorpaySignatureOk(req.body, signature, githubHooks.webhookSecret(connection))) return reply.code(401).send({ error: "bad signature" });
      const id = String(req.headers["x-github-delivery"] ?? "");
      if (id && seen.has(id)) return { ok: true };
      if (id) seen.add(id);
      if (seen.size > 10_000) seen.delete(seen.values().next().value!);
      void onGithubEvent(githubHooks.watchId(connection, owner, repo), String(req.headers["x-github-event"] ?? ""), JSON.parse(req.body)).catch((error) => req.log.error(error, "handling a GitHub event failed"));
      return { ok: true };
    });
    // Every other own app with webhooks. What's after the connection (a project, a token) is the app's own (OwnApp.push.receive).
    const appWebhook = async (req: FastifyRequest<{ Body: string; Params: { app: string; connection: string; "*"?: string } }>, reply: FastifyReply) => {
      const { app, connection, "*": rest = "" } = req.params;
      const push = OWN_APPS[app]?.push;
      const receive = push?.receive;
      const row = receive && !push.appWide ? await db.query.connections.findFirst({ where: and(eq(connections.app, app), eq(connections.externalId, connection)) }) : null;
      const key = push?.appWide ? "" : row && (await freshSecret(row).catch(() => null));
      if (!receive || key === null || key === undefined) return reply.code(401).send({ error: "unknown webhook" });
      const delivery: Delivery = { body: req.body, headers: req.headers, connection, rest };
      const got = await receive(delivery, key).catch((error) => (req.log.error(error, `a ${app} webhook failed`), null));
      if (!got) return reply.code(401).send({ error: "bad signature" });
      reply.headers(got.headers ?? {});
      void got
        .events()
        .then((events) => onAppEvents(app, [...new Set([[app, connection, ...(rest ? [rest.split("/")[0]!] : [])].join(":"), `${app}:${connection}`])], events))
        .catch((error) => req.log.error(error, `handling a ${app} event failed`));
      return got.reply ?? { ok: true };
    };
    hooks.post("/webhooks/app/:app/:connection", appWebhook);
    hooks.post("/webhooks/app/:app/:connection/*", appWebhook);
    // some apps (Mailchimp) check a webhook's address with a GET before saving it; nothing is run
    hooks.get<{ Params: { app: string } }>("/webhooks/app/:app/:connection/*", async (req, reply) => (OWN_APPS[req.params.app]?.push?.receive ? { ok: true } : reply.code(404).send({ error: "unknown webhook" })));
  });
}

// --- `emplio automations ...` from a chat ---

const USAGE = `usage: emplio automations list                    all of this business's automations, with status
       emplio automations show <name>             its file
       emplio automations add <name> - <<'MD'     create one (the file: settings, then the prompt; see below)
       emplio automations update <name> - <<'MD'  replace its file
       emplio automations on|off <name>           turn it on or off
       emplio automations remove <name>           delete it
       emplio automations run <name>              run it now (in a new chat)
       emplio automations history [name]          recent runs
       emplio automations triggers <app> [words]  events an app can start one with
       emplio automations trigger <trigger>       a trigger's settings and what its events carry

The file (names: lowercase-with-dashes):
---
when: trigger                      # trigger | schedule | manual
trigger: gmail.new_gmail_message   # when: trigger
config:                            # the trigger's settings (emplio automations trigger <trigger>), e.g. a Gmail search
  query: "from:@acme.com"
account: "me@work.com"             # when: trigger, and the person has several accounts of that app (emplio apps list)
schedule: "0 9 * * 1-5"            # when: schedule; cron, minute hour day month weekday
agent: Supplier Finder             # optional: each run hands the work to this agent (emplio agents list)
actions: [gmail.send_email]        # every app action its runs take that sends or changes something
timezone: Asia/Kolkata             # for schedule; leave out for the clock of whoever saves it
enabled: true
---
The prompt: what to do each time, as you'd tell a new employee. The event (the email, ...) is added below it.

Setting one up so it runs well:
- Find the event with emplio automations triggers <app> [words] and its settings with emplio automations trigger <trigger>.
  Narrow with the trigger's own settings (a Gmail search query) where it has them; otherwise put the condition in the
  prompt ("if it isn't from acme.com, stop").
- It runs as whoever saves it, with their apps: connect any it needs first. List under actions: every app action its runs
  take that sends, creates, changes or deletes something (reading needs no listing). Saving it asks the person to allow
  them and waits for their answer; runs may then do exactly those and nothing else that changes things. Read the
  reply to add: it says whether they allowed it, and if something stops it from running.
- Write the prompt for a run nobody watches: what to do, and what to leave for a person to decide. Look up each app action
  now (emplio apps info <action>) and write the exact commands into the prompt, inputs filled from the event's fields,
  e.g. emplio apps run todoist.add_task '{"content": "Reply to <sender>: <subject>"}', so runs go straight to work.
- Each run is its own chat in the list of the person it runs as. Test with emplio automations run <name>; a trigger one
  run by hand gets no event, so test it with a real one (send the email).`;

// `emplio automations ...`, as text for the agent. `caughtUp` brings the chat's computer up to date after a change;
// `ask` puts a card in the chat to allow what a saved one does.
export async function automationsCommand(who: Ctx, args: string[], caughtUp: () => Promise<unknown>, ask?: (a: Automation) => Promise<string>) {
  const [sub, name = "", text] = args;
  try {
    switch (sub) {
      case undefined:
      case "list": {
        const list = await listAutomations(who.workspaceId);
        if (!list.length) return "No automations yet. Create one with emplio automations add <name> (see emplio automations help).";
        return list
          .map((a) => {
            const when = a.when === "trigger" ? `on ${a.trigger}` : a.when === "schedule" ? `at "${a.schedule}" ${a.timezone}` : "manual";
            const state = a.error ? `BROKEN: ${a.error}` : a.enabled ? "on" : "off";
            const last = a.lastRun ? `, last run ${a.lastRun.startedAt.slice(0, 16).replace("T", " ")} ${a.lastRun.status}` : "";
            return `${a.name}\t${when}\t${state}\tas ${a.owner?.name ?? "nobody"}${last}`;
          })
          .join("\n");
      }
      case "show":
        if (!name) break;
        return await readAutomation(who.workspaceId, name);
      case "add":
      case "update": {
        if (!name) break;
        // a name with no file: say what's missing, not the whole usage (#195)
        if (!text?.trim())
          return `error: ${name} needs its file (settings, then the prompt): emplio automations ${sub} ${name} - <<'MD' ... MD, or input="..." in Python. See emplio automations help.`;
        const a = await saveAutomation(who, name, text, sub);
        await caughtUp();
        const state = a.error ? `saved, but it can't run yet: ${a.error}` : a.enabled ? "saved and on" : "saved, turned off";
        const allowed = (await ask?.(a)) ?? "";
        return `${name}: ${state}. It's company/automations/${name}.md and runs as ${a.owner?.name}.${allowed ? `\n${allowed}` : ""}`;
      }
      case "on":
      case "off": {
        if (!name) break;
        const a = await setEnabled(who, name, sub === "on");
        await caughtUp();
        return a.error ? `${name} is ${sub}, but it can't run: ${a.error}` : `${name} is ${sub}.`;
      }
      case "remove":
        if (!name) break;
        await removeAutomation(who, name);
        await caughtUp();
        return `Removed ${name}.`;
      case "run": {
        if (!name) break;
        const started = await runAutomation(who, name);
        return started.conversationId
          ? `Started: it runs in its own chat, "Automation: ${name}". Check how it went with emplio automations history ${name}.`
          : "error: it has nobody to run as.";
      }
      case "history": {
        const runs = await listAutomationRuns(who.workspaceId, name || undefined, 20);
        return runs.length
          ? runs.map((r) => `${r.startedAt.slice(0, 16).replace("T", " ")}\t${r.name}\t${r.reason}\t${r.status}${r.error ? `: ${r.error}` : ""}`).join("\n")
          : "No runs yet.";
      }
      case "triggers": {
        if (!name) break;
        const list = await listTriggers(name.toLowerCase(), args.slice(2).join(" ") || undefined, who);
        return list.length ? list.map((t) => `${t.action}\t${t.description}`).join("\n") : `No triggers for ${name}. Check the app name with emplio apps search.`;
      }
      case "trigger": {
        if (!name) break;
        const t = await getTrigger(name.toLowerCase(), who);
        if (!t) return `error: no trigger ${name}. List them with emplio automations triggers <app>.`;
        const line = (p: (typeof t.input)[number]) => `  ${p.name}${p.required ? " (required)" : ""}: ${p.type}. ${p.description}`;
        return [`${t.action}: ${t.description}`, "Settings (config:):", ...(t.input.length ? t.input.map(line) : ["  none"]), "Each event carries:", ...t.output.map(line)].join("\n");
      }
    }
    return USAGE;
  } catch (error) {
    if (error instanceof AutomationError || error instanceof AppsError) return `error: ${error.message}`;
    throw error;
  }
}
