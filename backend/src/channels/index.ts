// Channels: ways to talk to the AI employee besides the web app. The product has ONE of each (one Telegram
// bot, later one WhatsApp number and one phone number) shared by every business; who's talking is worked
// out from them: their mobile number, or a link from the web app. On every channel they talk in their main
// chat (mainChat) in the business they used last: the same conversation as in the web app, where check-ins,
// tasks and automations report back (post), so answering on the phone carries on from what was reported.
//
// A channel only moves messages: it turns what arrives into a message for `converse` and shows what comes
// back through its `Out`. Add one: write channels/<name>.ts like telegram.ts and list it in CHANNELS.
// (WhatsApp: messages the agent starts outside the 24-hour window need approved templates; phone calls:
// speech both ways. Both fit here: `send` and `Out` are what they must provide.)
import { cloud } from "../cloud";
import type { Approval, AskCard, ConnectCard, PlanStep } from "@emplio/shared";
import { generateId, type UIMessage } from "ai";
import { createHmac, timingSafeEqual } from "node:crypto";
import { and, asc, eq, isNull } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { context } from "../auth";
import { personFor } from "../automations";
import { generateReply, postMessage } from "../chat";
import { db } from "../db";
import { channelLinks, conversations, users, workspaceMembers, workspaces } from "../db/schema";
import { readStored } from "../files";
import { phoneAppUrl } from "../logins";
import { notify } from "../live";
import { pushTo } from "../push";
import { telegram } from "./telegram";

export type ChannelName = (typeof channelLinks.$inferSelect)["channel"];
export type Link = typeof channelLinks.$inferSelect;

// A question as a message: what to read first, then what's asked.
export const askText = (card: AskCard) => `${card.text ? `${card.text}\n\n` : ""}**${card.question}**`;

// What a reply needs from the channel it's shown on.
export type Out = {
  text(markdown: string): Promise<void>;
  // an action waiting for the person's OK; their answer goes to approvals.ts decide()
  approval(a: Approval): Promise<void>;
  connect(card: ConnectCard): Promise<unknown>;
  // a question with answers to tap (emplio ask); the tapped one comes back as their next message
  ask(card: AskCard): Promise<unknown>;
  file(name: string, mediaType: string, bytes: Uint8Array): Promise<void>;
  // the agent's checklist (emplio plan): the first time a reply sends one, later the same message is
  // edited (`shown`: what the last call returned), so a long job is one message that fills in, not one per step
  plan(steps: PlanStep[], shown?: number): Promise<number | undefined>;
};

export type Channel = {
  // the agent writing first (emplio channels send); throws if it can't reach them
  send(address: string, markdown: string): Promise<void>;
  // an action's OK asked outside a reply on this channel (a job's); closeApproval: answered elsewhere, buttons off
  approval(address: string, card: Approval): Promise<void>;
  closeApproval(address: string, cardId: string, decision: NonNullable<Approval["decision"]>): void;
};

// a function, as telegram.ts imports this file back
const CHANNELS = (): Record<ChannelName, Channel> => ({ telegram });

// Mobile numbers as stored: digits with the country code. Typed ones must start with + (or 00).
export function normalPhone(raw: string, typed = true) {
  const s = raw.trim();
  if (typed && !/^(\+|00)/.test(s)) return null;
  const digits = s.replace(/\D/g, "").replace(/^00/, "");
  return /^[1-9]\d{7,14}$/.test(digits) ? digits : null;
}

// The person's businesses, oldest membership first.
export const membershipsOf = (userId: string) =>
  db
    .select({ workspaceId: workspaceMembers.workspaceId, name: workspaces.name })
    .from(workspaceMembers)
    .innerJoin(workspaces, eq(workspaces.id, workspaceMembers.workspaceId))
    .where(eq(workspaceMembers.userId, userId))
    .orderBy(asc(workspaceMembers.createdAt));

export const findLink = (channel: ChannelName, address: string) =>
  db.query.channelLinks.findFirst({ where: and(eq(channelLinks.channel, channel), eq(channelLinks.address, address)) });

// Ties a channel address to a person, in the business they joined first (or `workspaceId`). Null: not on any team.
export async function link(channel: ChannelName, address: string, userId: string, workspaceId?: string) {
  const ws = workspaceId ?? (await membershipsOf(userId))[0]?.workspaceId;
  if (!ws) return null;
  const [row] = await db
    .insert(channelLinks)
    .values({ channel, address, userId, workspaceId: ws })
    .onConflictDoUpdate({ target: [channelLinks.channel, channelLinks.address], set: { userId, workspaceId: ws, conversationId: null } })
    .returning();
  return row!;
}

export const setLink = (l: Link, set: Partial<Pick<Link, "workspaceId" | "conversationId">>) =>
  db.update(channelLinks).set(set).where(and(eq(channelLinks.channel, l.channel), eq(channelLinks.address, l.address)));

export const userByPhone = (phone: string) => db.query.users.findFirst({ where: eq(users.phone, phone) });

// A "Connect Telegram" link from the web app carries this, so the bot knows who opened it.
// ponytail: never expires; a leaked link links that chat to the person until they disconnect it
const sign = (userId: string) => createHmac("sha256", process.env.ENCRYPTION_KEY!).update(`channel-link:${userId}`).digest("hex").slice(0, 24);
export const linkToken = (userId: string) => userId.replaceAll("-", "") + sign(userId);
export function tokenUser(token: string) {
  const hex = token.slice(0, 32);
  if (!/^[0-9a-f]{32}$/.test(hex)) return null;
  const userId = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  const want = Buffer.from(sign(userId));
  const got = Buffer.from(token.slice(32));
  return got.length === want.length && timingSafeEqual(got, want) ? userId : null;
}

export const MAIN_TITLE = "Emplio";

// The person's main chat in this business, made on first use.
export async function mainChat(workspaceId: string, userId: string): Promise<string> {
  const who = and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, userId));
  const m = await db.query.workspaceMembers.findFirst({ where: who, columns: { mainChatId: true } });
  // someone removed from the team: without this the update below never matches, and it would try again forever
  if (!m) throw new Error("not on this team");
  if (m.mainChatId && (await db.query.conversations.findFirst({ where: eq(conversations.id, m.mainChatId), columns: { id: true } }))) return m.mainChatId;
  const id = crypto.randomUUID();
  await db.insert(conversations).values({ id, workspaceId, userId, title: MAIN_TITLE, kind: "main" });
  // two at once (a check-in and a message): the first one's stays
  const [set] = await db
    .update(workspaceMembers)
    .set({ mainChatId: id })
    .where(and(who, m.mainChatId ? eq(workspaceMembers.mainChatId, m.mainChatId) : isNull(workspaceMembers.mainChatId)))
    .returning({ id: workspaceMembers.mainChatId });
  if (set) return id;
  await db.delete(conversations).where(eq(conversations.id, id));
  return mainChat(workspaceId, userId);
}

// Where to reach this person on their phone for this business: their channels now pointed at it.
async function linksHere(workspaceId: string, userId: string) {
  return db.query.channelLinks.findMany({ where: and(eq(channelLinks.userId, userId), eq(channelLinks.workspaceId, workspaceId)) });
}

// A chat in the web app, as a link that also works from a phone.
export const chatLink = (conversationId: string) => `${phoneAppUrl()}/chat/${conversationId}`;

// Something the person should see that was written outside their main chat (a check-in's finding, a task's
// result, a reminder): onto their channel when they have one in this business, and into the main chat (unless
// it's already there, `inChat`), so whatever they answer, wherever, carries on from it. `from`: the chat it
// was worked out in, so the AI there knows it didn't make it up (chat.ts fromNote).
export async function post(workspaceId: string, userId: string, markdown: string, o: { inChat?: boolean; from?: string } = {}) {
  const links = await linksHere(workspaceId, userId);
  for (const l of links) await CHANNELS()[l.channel].send(l.address, markdown).catch((error) => console.error(`posting to ${l.channel} failed`, error));
  if (!o.inChat) {
    const id = await mainChat(workspaceId, userId);
    await postMessage(id, { id: generateId(), role: "assistant", parts: [{ type: "text", text: markdown }, ...(o.from ? [{ type: "data-from", data: o.from }] : [])] });
    await db.update(conversations).set({ unread: true }).where(eq(conversations.id, id));
  }
  notify(userId);
  void pushTo(userId, markdown, await mainChat(workspaceId, userId));
  return links[0]?.channel ?? null;
}

// A reply nobody was waiting on (a job finished, a restart): it goes to their phone too only if that's where they last wrote.
export async function wroteFromPhone(conversationId: string) {
  const chat = await db.query.conversations.findFirst({ where: eq(conversations.id, conversationId), columns: { wroteFrom: true } });
  return !!chat && chat.wroteFrom !== "web";
}

// Background work (check-ins, tasks, automations) asks this before it starts. While a business is paused (pausedReason)
// the work holds off and says nothing, and its owner hears why once per pause, not once per run. The reason, or null to go ahead.
export async function heldBack(workspaceId: string) {
  const reason = await cloud.credit.pausedReason(workspaceId);
  if (!reason) return null;
  await cloud.credit.notePaused(workspaceId, reason);
  return reason;
}

// A job's OK on the person's phone, so it doesn't sit unanswered when they aren't in the web app.
export async function askOnPhone(workspaceId: string, userId: string, card: Approval) {
  void pushTo(userId, `Needs your OK: ${card.title}`, await mainChat(workspaceId, userId));
  for (const l of await linksHere(workspaceId, userId)) await CHANNELS()[l.channel].approval(l.address, card).catch((error) => console.error(`asking on ${l.channel} failed`, error));
}
export async function closeOnPhone(workspaceId: string, userId: string, card: Approval) {
  for (const l of await linksHere(workspaceId, userId)) CHANNELS()[l.channel].closeApproval(l.address, card.id, card.decision!);
}

type Log = { error(obj: unknown, msg: string): void };

// A message from the person on a channel: the AI employee's reply, shown through `out` as it goes.
export async function converse(l: Link, parts: UIMessage["parts"], out: Out, log: Log) {
  const ctx = await personFor(l.workspaceId, l.userId);
  if (!ctx) return out.text("You're not on that team any more. Send /switch to pick another.");
  const paused = await cloud.credit.pausedReason(l.workspaceId);
  if (paused) return out.text(paused);
  const id = await mainChat(l.workspaceId, l.userId);
  const stream = await generateReply(ctx, id, { id: generateId(), role: "user", parts }, log, undefined, l.channel);
  if (!stream) return;
  const texts = new Map<string, string>();
  const asked = new Set<string>();
  let planShown: number | undefined;
  for await (const chunk of stream) {
    if (chunk.type === "text-start") texts.set(chunk.id, "");
    else if (chunk.type === "text-delta") texts.set(chunk.id, (texts.get(chunk.id) ?? "") + chunk.delta);
    else if (chunk.type === "text-end") {
      const t = texts.get(chunk.id)?.trim();
      if (t) await out.text(t);
    } else if (chunk.type === "tool-output-available") {
      const o = (chunk.output ?? {}) as { plan?: PlanStep[]; approvals?: Approval[]; connect?: ConnectCard[]; asks?: AskCard[]; saved?: { url: string; mediaType: string; filename: string; id?: string }[] };
      for (const a of o.approvals ?? [])
        if (!a.decision && !asked.has(a.id)) {
          asked.add(a.id);
          await out.approval(a);
        }
      if (o.plan) planShown = await out.plan(o.plan, planShown);
      if (chunk.preliminary) continue;
      for (const card of o.connect ?? []) await out.connect(card);
      // several at once: one numbered message to answer in one go (a keyboard holds one question's answers)
      const asks = o.asks ?? [];
      if (asks.length === 1) await out.ask(asks[0]!);
      else if (asks.length)
        await out.text(
          asks.map((a, i) => `${i + 1}. ${askText(a)}${a.options.length ? `\n${a.options.join(" / ")}` : ""}`).join("\n") +
            "\n\nReply with your answers in one message, like: 1 " + (asks[0]!.options[0] ?? "...") + ", 2 ...",
        );
      // a web page doesn't open in a phone chat app, and over 50 MB Telegram won't take it: a link to it in the app
      for (const f of o.saved ?? []) {
        const bytes = await readStored(f.url);
        if (f.id && (f.mediaType === "text/html" || bytes.length > 50 * 1024 * 1024)) await out.text(`**${f.filename}**: open it here: ${phoneAppUrl()}/files?open=${f.id}`);
        else await out.file(f.filename, f.mediaType, bytes);
      }
    } else if (chunk.type === "error") await out.text("Something went wrong while replying. Try again in a moment.");
  }
}

// The agent writing to a teammate first (emplio channels send, task reminders): `post`, after switching their
// channel to this business if they were talking to another, so their answer comes back here.
export async function sendTo(workspaceId: string, userId: string, markdown: string, channel?: ChannelName) {
  const links = await db.query.channelLinks.findMany({ where: eq(channelLinks.userId, userId) });
  const l = links.find((x) => !channel || x.channel === channel);
  if (l && l.workspaceId !== workspaceId) await setLink(l, { workspaceId });
  return post(workspaceId, userId, markdown);
}

const CHANNELS_USAGE = `usage: emplio channels list                      teammates and where you can message them (Telegram, ...)
       emplio channels send <email> <message>     message a teammate on their channel (Telegram), e.g. a finished report
                                              or a reminder; add --via telegram to pick one. Their reply comes back to you.`;

// `emplio channels ...` from a chat.
export async function channelsCommand(workspaceId: string, args: string[]) {
  const via = args.indexOf("--via");
  const channel = via >= 0 ? (args[via + 1] as ChannelName) : undefined;
  if (via >= 0) args = args.filter((_, i) => i !== via && i !== via + 1);
  const [sub, email, ...rest] = args;
  const team = await db
    .select({ id: users.id, name: users.name, email: users.email })
    .from(workspaceMembers)
    .innerJoin(users, eq(users.id, workspaceMembers.userId))
    .where(eq(workspaceMembers.workspaceId, workspaceId));
  if (sub === "list") {
    const links = await db.query.channelLinks.findMany();
    return team
      .map((m) => {
        const on = links.filter((l) => l.userId === m.id).map((l) => l.channel);
        return `${m.name ?? "(no name)"} <${m.email}>\t${on.length ? on.join(", ") : "web app only"}`;
      })
      .join("\n");
  }
  if (sub === "send" && email && rest.length) {
    if (channel && !(channel in CHANNELS())) return `error: no channel ${channel}; there's ${Object.keys(CHANNELS()).join(", ")}.`;
    const m = team.find((t) => t.email.toLowerCase() === email.toLowerCase());
    if (!m) return `error: ${email} isn't on the team (emplio team list).`;
    const sent = await sendTo(workspaceId, m.id, rest.join(" "), channel).catch((error: Error) => `error: ${error.message}`);
    if (sent?.startsWith("error:")) return sent;
    return sent ? `Sent to ${m.name ?? email} on ${sent}, and in their Emplio chat.` : `Sent to ${m.name ?? email} in their Emplio chat (they haven't connected a phone channel, so they'll see it next time they open Emplio).`;
  }
  return CHANNELS_USAGE;
}

export async function channelRoutes(app: FastifyInstance) {
  // the person's number and channels, for the Channels window
  app.get("/channels", async (req, reply) => {
    const ctx = await context(req, reply);
    if (!ctx) return;
    const me = await db.query.users.findFirst({ where: eq(users.id, ctx.userId), columns: { phone: true } });
    const links = await db.query.channelLinks.findMany({ where: eq(channelLinks.userId, ctx.userId) });
    const bot = await telegram.username();
    return {
      phone: me?.phone ? `+${me.phone}` : null,
      telegram: {
        connected: links.some((l) => l.channel === "telegram"),
        url: bot ? `https://t.me/${bot}?start=${linkToken(ctx.userId)}` : null,
      },
    };
  });

  app.put<{ Body: { phone: string | null } }>(
    "/channels/phone",
    { schema: { body: { type: "object", required: ["phone"], properties: { phone: { type: ["string", "null"], maxLength: 30 } } } } },
    async (req, reply) => {
      const ctx = await context(req, reply);
      if (!ctx) return;
      const phone = req.body.phone?.trim() ? normalPhone(req.body.phone) : null;
      if (req.body.phone?.trim() && !phone) return reply.code(400).send({ error: "Write it with the country code, like +91 98765 43210." });
      const taken = phone && (await userByPhone(phone));
      if (taken && taken.id !== ctx.userId) return reply.code(409).send({ error: "That number is already someone else's." });
      await db.update(users).set({ phone }).where(eq(users.id, ctx.userId));
      return { phone: phone ? `+${phone}` : null };
    },
  );

  app.delete<{ Params: { channel: string } }>("/channels/:channel", async (req, reply) => {
    const ctx = await context(req, reply);
    if (!ctx) return;
    await db.delete(channelLinks).where(and(eq(channelLinks.userId, ctx.userId), eq(channelLinks.channel, req.params.channel as ChannelName)));
    return { ok: true };
  });
}

if (import.meta.main) {
  console.assert(normalPhone("+91 98765 43210") === "919876543210");
  console.assert(normalPhone("0091-98765-43210") === "919876543210");
  console.assert(normalPhone("98765 43210") === null);
  console.assert(normalPhone("919876543210", false) === "919876543210");
  const id = "6386a0fb-6ef1-404c-9934-88e548257ad3";
  process.env.ENCRYPTION_KEY ??= "test";
  console.assert(tokenUser(linkToken(id)) === id && linkToken(id).length <= 64);
  console.assert(tokenUser(linkToken(id).replace(/.$/, (c) => (c === "0" ? "1" : "0"))) === null);
  console.log("channels ok");
  process.exit(0);
}
