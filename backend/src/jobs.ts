// Hand-offs: Emplio hands a piece of work to a named agent or to a copy of itself (`emplio hand`), and that becomes
// a thread: a sub-agent with its own fresh context, the same computer, the same prompt and the same commands, which
// gives back only its report. Several started together run at once. Emplio stays a manager: it plans, delegates,
// checks reports and answers, so its own context holds decisions and results rather than every command's output.
// Threads may hand off too, MAX_DEPTH levels down. Each thread is a chat of its own (a conversation of kind "job"):
// the brief is its first message, and it works there like any reply does (chat.ts runs it, with its rules, agent and
// model from jobReply below), so the person can open it, watch it and write to it like any chat. Whatever it last
// said is its report, which goes back to whoever started it (a "Question:" report climbs to Emplio, which asks the
// person). Its row in `jobs` is the hidden record of the thread: who started it, its agent, its status and its report.
import { generateId, type UIMessage } from "ai";
import { FROM_EMPLIO, JOB_NOTE_PREFIX, JOBS_DONE_PREFIX, runRef, type Approval, type ChatJob, type JobInfo, type JobSummary } from "@emplio/shared";
import { record } from "./activity";
import { detailOf } from "./approvals";
import { and, asc, desc, eq, gt, inArray, isNotNull, isNull, or, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { context, type Ctx } from "./auth";
import { personFor } from "./automations";
import { askOnPhone, closeOnPhone, mainChat, post, wroteFromPhone } from "./channels";
import { generateReply, lastWords, loadMessages, quiet, replyUntil, steer, steered } from "./chat";
import { db } from "./db";
import { actionRuns, conversations, jobs } from "./db/schema";
import { agentPrompt, agentsCommand, findAgent, flags } from "./agents";
import { SILENT } from "./reader";
import { timezoneOf, when } from "./time";

type Action = JobInfo["actions"][number];

// Who runs `emplio hand` or `emplio threads`: Emplio in the chat (depth 0) or one of its threads (1), theirs (2) and so on.
export type Caller = { depth: number; jobId: string | null };
export const EMPLIO: Caller = { depth: 0, jobId: null };
const MAX_DEPTH = 3;

// Jobs whose chat is replying now, so wait and stop can reach them: done resolves when the reply ends. Made when
// a job is started or told something, before its reply begins, so a wait right after doesn't miss it.
type Live = { done: Promise<void>; end: () => void; stop: () => void; began: boolean };
const live = new Map<string, Live>();
function track(id: string) {
  let e = live.get(id);
  if (!e) {
    let end = () => {};
    const done = new Promise<void>((r) => (end = r));
    e = { done, end, stop: () => {}, began: false };
    live.set(id, e);
  }
  return e;
}
// Emplio's jobs being waited on right now, and finished ones whose report it hasn't seen yet
const waited = new Set<string>();
const unseen = new Set<string>();
// Emplio's jobs it's waiting on a result from (it gave them something to do, or they asked it a question): their
// next report wakes it. Reports from work the person gave a job in its chat don't: `untold` holds those until
// Emplio's next reply, which reads them as a note.
// ponytail: in memory like the two above; a restart reports what was working (markOrphanedJobs) and "asking" is saved
const owed = new Set<string>();
const untold = new Set<string>();
// What happens to a report when a job's reply ends: wake Emplio, keep it for its next reply, or nothing.
// interrupted: a message is waiting to go into the job's chat, so it hasn't finished.
export const reportGoes = (o: { depth: number; stopped: boolean; owed: boolean; interrupted: boolean }) =>
  o.depth !== 1 || o.stopped ? "nowhere" : o.owed && !o.interrupted ? "wake" : "untold";

const MAX_RUNNING = 10; // per chat at once, every level: a runaway plan can't fan out forever
const CONTINUE_MS = 24 * 3_600_000; // a thread quiet for longer than this takes new work as a new thread, unless it's waiting on an answer
const LISTED = 8; // threads on Emplio's list
const SIDEBAR_DAYS = 7;
export const JOB_MINUTES = 30; // per reply in a job's chat (chat.ts), where a person's reply gets 15
const WAIT_MS = 10 * 60_000;

export const RULES = (depth: number) => `## You have one piece of work
${depth > 1 ? "Another thread" : "Emplio"} handed you one task, in this chat of your own. Messages starting \
"${FROM_EMPLIO.trim()}" are from ${depth > 1 ? "the thread that started you" : "Emplio"}; any other message is the person, who opened \
your chat and wrote to you directly: answer them, and what they say wins over your brief. Your last message \
each time is your report, which goes back to whoever started you, and the person may read it too. ${
  depth === 1
    ? "When the person writes to you directly, Emplio isn't woken: it reads your latest report the next time it replies. Only if they say something Emplio must act on now, tell it with `emplio threads notify <<'EOF' ... EOF`; never for small talk or what they can already see in your answer. "
    : ""
}${
  depth < MAX_DEPTH
    ? "You may hand big or independent parts of your task off with `emplio hand`, the way the sections above describe; do anything small yourself. If one of them comes back with a question, answer it with `emplio hand <its id>` when you can; if only a person can, end with that question yourself (below)."
    : "You can't hand off: ignore the Handing off section above and do the task yourself."
}
Do the task and check the result. If you worked out how a site works, put it in that site's skill before you report. Then end with a report for whoever started you:
- What you did and the outcome, with every id, path, link, amount and name exactly as it came back.
- Files you made (saved to /work/out to offer them to the person).
- Anything you couldn't do and why, with the exact error, and what a person would need to decide or provide.
No preamble. Don't claim what you didn't verify. If the task is unclear, do the most sensible reading and say \
which one you chose. If you truly can't go on without a decision or a fact only a person has (guessing would \
be wrong or risky), stop and make your report start with "Question:": exactly what you need and why, then what \
you've done so far. The answer comes back to you as a message and you carry on. Whoever started you may also \
send you a message while you work: it arrives as a new message, and it wins over your brief where they differ.
An app action that sends or changes something (an email, a payment, a post) shows the person an Allow card on \
your line in their chat and waits for their tap: just run it. If they don't answer or say no, it says so; report that and \
what was ready, without trying another way.
Other threads may be running at the same time on the same computer: use your own folder under /work/tmp, and \
don't use the browser unless your task says to. Ignore the Checklist section above: the checklist is \
Emplio's, for the person, so don't run \`emplio plan\`.`;

// What Emplio is told when reports come in that it didn't wait for. `going`: its threads still running, which may be
// other parts of the same request, so it can hold back until they're in.
export const reportsNote = (reports: string[], going: string[], asking: boolean) =>
  `${JOBS_DONE_PREFIX}Your threads ended after your last reply did:\n\n${reports.join("\n\n")}\n\nCarry on with what the person asked, using these reports. Name what it's about in your first words: they may be in the middle of something else.${
    asking
      ? " A thread that asks a question waits for the answer: give it with `emplio hand <its id>` if you know it; otherwise ask the person (one message, all the questions), and hand the thread what they say."
      : ""
  }${
    going.length
      ? `\n\nStill running: ${going.join(", ")}. Their reports come here when they finish. Tell the person this result now, and in a few words what's still running, even if the threads came from the same message. Only if they asked in so many words for one combined answer, end instead with exactly ${SILENT} (they see nothing) and answer when the rest are in.`
      : ""
  }`;

// What Emplio reads with its next reply: threads' reports it wasn't woken for, cut short so old chatter stays cheap.
const NOTE_REPORT = 1500;
export const untoldNote = (reports: string[]) =>
  `[The person worked in these threads' chats directly, so you weren't woken. Their latest reports, for you to know; don't mention them unless it matters (\`emplio threads show <id>\` for all of one):\n\n${reports.map((r) => (r.length > NOTE_REPORT ? `${r.slice(0, NOTE_REPORT)}…` : r)).join("\n\n")}\n]`;

export async function untoldReports(conversationId: string) {
  if (!untold.size) return null;
  const rows = await db.select().from(jobs).where(and(eq(jobs.conversationId, conversationId), isNull(jobs.parentId)));
  const finished = rows.filter((r) => untold.has(r.id) && r.status !== "working");
  if (!finished.length) return null;
  for (const r of finished) untold.delete(r.id);
  return untoldNote(await Promise.all(finished.map(full)));
}

// A new turn in the chat that started the job (and on the person's phone if that's where they last wrote), once
// the chat is free. False if no reply came (the business is paused, the AI is down).
// ponytail: the text of the reply goes to the phone, not approval buttons or files (channels.converse does those)
export async function wake(w: Pick<Row, "id" | "workspaceId" | "userId" | "conversationId">, text: string) {
  const person = await personFor(w.workspaceId, w.userId);
  if (!person) return true;
  const message: UIMessage = { id: generateId(), role: "user", parts: [{ type: "text", text }] };
  const log = { error: (obj: unknown, msg: string) => console.error(`job ${w.id}: ${msg}`, obj) };
  let failed = false;
  for await (const chunk of (await generateReply(person, w.conversationId, message, log))!) if (chunk.type === "error") failed = true;
  if (failed) return false;
  await quiet(w.conversationId);
  if (!(await wroteFromPhone(w.conversationId))) return true;
  const said = await lastWords(w.conversationId);
  if (said && !said.includes(SILENT)) await post(w.workspaceId, w.userId, said, { inChat: true });
  return true;
}

// Give Emplio the reports it was waiting for and didn't wait out, as soon as each job ends. Jobs ending meanwhile come in one turn.
async function resume(w: Pick<Row, "id" | "workspaceId" | "userId" | "conversationId">) {
  await quiet(w.conversationId);
  const rows = await db.select().from(jobs).where(and(eq(jobs.conversationId, w.conversationId), isNull(jobs.parentId)));
  const done = rows.filter((r) => unseen.has(r.id));
  if (!done.length) return;
  for (const r of done) unseen.delete(r.id);
  const note = reportsNote(await Promise.all(done.map(full)), rows.filter((r) => live.has(r.id)).map((r) => r.name), done.some((r) => r.status === "asking"));
  // no reply: the reports wait, and the last reply isn't sent to their phone again
  if (!(await wake(w, note))) for (const r of done) unseen.add(r.id);
}

// Jobs that died with the process (a restart, a deploy) are marked so at startup, and Emplio is told in each
// chat, so it can have them carry on from their last step (`emplio hand <id>`).
// ponytail: one server, so anything working at startup is dead; with several, claim each one first
export async function markOrphanedJobs() {
  const report = "Cut off by a server restart. Its work so far is kept: `emplio hand <id>` with \"carry on\" picks it up from where it stopped.";
  const rows = await db.update(jobs).set({ status: "failed", report, finishedAt: new Date() }).where(eq(jobs.status, "working")).returning();
  const chats = new Map(rows.filter((r) => r.depth === 1).map((r) => [r.conversationId, r]));
  for (const r of rows) if (r.depth === 1) unseen.add(r.id);
  for (const r of chats.values()) void resume(r).catch((error) => console.error(`job ${r.id}: resuming the chat failed`, error));
}

type Who = { workspaceId: string; userId: string };
type Row = typeof jobs.$inferSelect;

// What a reply in a job's chat runs with (chat.ts): who `emplio hand` acts for there, its rules and agent on top of
// Emplio's prompt, its model, the chat that started it (whose Stop stops it too), and `began`, called as the
// reply starts with how to stop it, which gives back what to call when it ends.
export async function jobReply(chatId: string) {
  const w = await db.query.jobs.findFirst({ where: eq(jobs.chatId, chatId) });
  if (!w) return null;
  // read each reply, so a follow-up gets the agent's latest instructions and lessons
  const agent = w.agent ? await findAgent(w.workspaceId, w.agent) : null;
  return {
    caller: { depth: w.depth, jobId: w.id } satisfies Caller,
    prompt: [RULES(w.depth), ...(agent ? [await agentPrompt(w.workspaceId, agent)] : [])].join("\n\n"),
    strong: (w.level ?? agent?.level) === "strong",
    agent: agent?.name,
    startedIn: w.conversationId,
    unattended: await unattended(w.conversationId),
    began: (stop: () => void) => began(w, stop),
  };
}

// Started from a run nobody watches (an automation, a task, a check-in), or from a job that was: that run's chat.
// What Emplio tells it then runs the same way, with what that run may do (an automation's allowed actions) and no
// card nobody would see. What the person writes in its chat is watched (chat.ts).
async function unattended(chatId: string): Promise<string | null> {
  const root = await startedIn(chatId);
  const chat = await db.query.conversations.findFirst({ where: eq(conversations.id, root), columns: { kind: true } });
  return chat?.kind === "background" ? root : null;
}

// The chat a job's chat goes back to, through any jobs that started it; any other chat is its own.
async function startedIn(chatId: string): Promise<string> {
  const parent = await db.query.jobs.findFirst({ where: eq(jobs.chatId, chatId), columns: { conversationId: true } });
  return parent ? startedIn(parent.conversationId) : chatId;
}

async function began(w: Row, stop: () => void) {
  const e = track(w.id);
  Object.assign(e, { stop, began: true });
  // it asked a question: whoever answers it here, Emplio is still waiting on the result
  if (w.depth === 1 && w.status === "asking") owed.add(w.id);
  await db.update(jobs).set({ status: "working", report: null, finishedAt: null }).where(eq(jobs.id, w.id));
  // its last words are its report: a question waits for an answer
  return async (answer: string, outcome: "completed" | "failed" | "stopped", interrupted = false) => {
    const report = answer || (outcome === "failed" ? "It failed." : outcome === "stopped" ? "Stopped." : "(it ended without a report)");
    const status = outcome === "completed" ? (asks(report) ? "asking" : "done") : outcome;
    await db.update(jobs).set({ status, report, finishedAt: new Date() }).where(eq(jobs.id, w.id));
    live.delete(w.id);
    e.end();
    const goes = reportGoes({ depth: w.depth, stopped: outcome === "stopped", owed: owed.has(w.id), interrupted });
    if (goes === "untold") untold.add(w.id);
    if (goes === "wake") {
      owed.delete(w.id);
      untold.delete(w.id);
      unseen.add(w.id);
      // Emplio's reply ended first: the chat that started it carries on once its jobs are all done
      if (!waited.has(w.id)) void resume(w).catch((error) => console.error(`job ${w.id}: resuming the chat failed`, error));
    }
  };
}

// The Allow cards in a job's reply that are new, and the ones just answered, of those already shown (`shown` keeps track).
export function cardsIn(chunk: { type: string; output?: unknown }, shown: Set<string>) {
  const cards = chunk.type === "tool-output-available" ? ((chunk.output as { approvals?: Approval[] } | null)?.approvals ?? []) : [];
  const ask = cards.filter((a) => !a.decision && !shown.has(a.id));
  const answered = cards.filter((a) => a.decision && shown.has(a.id));
  for (const a of ask) shown.add(a.id);
  for (const a of answered) shown.delete(a.id);
  return { ask, answered };
}

// A message to the job from whoever started it, as the next message in its chat: after the reply running there,
// if one is (steered: it wraps up after its current command).
// `run`: the prompt's message id, which marks the run in the job's chat (runOf)
async function send(w: Row, text: string, run = generateId()) {
  const e = track(w.id);
  if (w.depth === 1) owed.add(w.id);
  const person = await personFor(w.workspaceId, w.userId);
  const message: UIMessage = { id: run, role: "user", parts: [{ type: "text", text: FROM_EMPLIO + text }] };
  const log = { error: (obj: unknown, msg: string) => console.error(`job ${w.id}: ${msg}`, obj) };
  let error: string | null = null;
  try {
    if (!person || !w.chatId) error = "nobody to run it as";
    else {
      // a job from their main chat, their phone thread too, asks on their phone as well as on its line in the app
      const onPhone = (await startedIn(w.conversationId)) === (await mainChat(w.workspaceId, w.userId));
      const shown = new Set<string>();
      for await (const chunk of (await generateReply(person, w.chatId, message, log)) ?? []) {
        if (chunk.type === "error") error = chunk.errorText;
        if (!onPhone) continue;
        const { ask, answered } = cardsIn(chunk, shown);
        for (const a of ask) await askOnPhone(w.workspaceId, w.userId, a);
        for (const a of answered) await closeOnPhone(w.workspaceId, w.userId, a);
      }
    }
  } catch (err) {
    error = String(err);
  }
  // it never began (the business is paused, say): ended here, so nobody waits on it
  if (live.get(w.id) === e && !e.began) {
    await db.update(jobs).set({ status: "failed", report: `It couldn't start: ${error ?? "unknown error"}`, finishedAt: new Date() }).where(eq(jobs.id, w.id));
    owed.delete(w.id);
    live.delete(w.id);
    e.end();
  }
}

// What it did, from its chat: each command it ran and what came of it (files, cards, the jobs it started)
async function actionsOf(w: Pick<Row, "chatId" | "actions">): Promise<Action[]> {
  if (!w.chatId) return w.actions;
  return actionsIn(await loadMessages(w.chatId));
}

type ChatMessages = Awaited<ReturnType<typeof loadMessages>>;
function actionsIn(msgs: ChatMessages): Action[] {
  type Bash = { type: string; toolCallId: string; state: string; preliminary?: boolean; input?: { description?: string }; output?: Partial<Action> };
  return msgs.flatMap((m) =>
    m.role !== "assistant"
      ? []
      : (m.parts as unknown as (Bash & { input?: { command?: string } })[])
          .filter((p) => p.type === "tool-bash")
          .map((p) => ({
            id: p.toolCallId,
            description: p.input?.description ?? "…",
            done: p.state === "output-available" && !p.preliminary,
            error: p.state === "output-error" || undefined,
            exitCode: p.output?.exitCode,
            saved: p.output?.saved,
            connect: p.output?.connect,
            logins: p.output?.logins,
            approvals: p.output?.approvals,
            jobs: p.output?.jobs,
          })),
  );
}

// A job's card for one run (the prompt that started it, see send). The latest run is the job's own status and
// report; an earlier one is finished, with what it did and said then. A prompt not in the chat yet is queued.
const asks = (report: string) => /^\W*question\b/i.test(report);
const textOf = (m: { parts: unknown }) =>
  ((m.parts as { type?: string; text?: string }[]) ?? []).flatMap((p) => (p.type === "text" && p.text ? [p.text] : [])).join("");

// The messages of one run: from its prompt up to the next prompt from Emplio. null while the prompt isn't in the chat.
export function runSpan<M extends { id: string; role: string; parts: unknown }>(msgs: M[], run: string) {
  const at = msgs.findIndex((m) => m.id === run);
  if (at < 0) return null;
  const next = msgs.findIndex((m, i) => i > at && m.role === "user" && textOf(m).startsWith(FROM_EMPLIO));
  return { msgs: msgs.slice(at, next < 0 ? undefined : next), latest: next < 0 };
}

async function runOf(w: Row, run?: string): Promise<Pick<JobInfo, "status" | "report" | "actions">> {
  if (!run || !w.chatId) return { status: w.status, report: w.report, actions: await actionsOf(w) };
  const span = runSpan(await loadMessages(w.chatId), run);
  if (!span) return { status: "working", report: null, actions: [] };
  const actions = actionsIn(span.msgs);
  if (span.latest) return { status: w.status, report: w.report, actions };
  const last = [...span.msgs].reverse().find((m) => m.role === "assistant" && textOf(m).trim());
  const text = last ? textOf(last).trim() : "";
  return { status: asks(text) ? "asking" : "done", report: text || null, actions };
}

const agentName = (slug: string | null) => slug?.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()) ?? null;
// the caller's own jobs: Emplio's are the chat's top level, a job's are the ones it started
const mine = (who: Who, conversationId: string, caller: Caller) =>
  and(
    eq(jobs.workspaceId, who.workspaceId),
    eq(jobs.userId, who.userId),
    eq(jobs.conversationId, conversationId),
    caller.jobId ? eq(jobs.parentId, caller.jobId) : isNull(jobs.parentId),
  );
const short = (id: string) => id.slice(0, 8);

async function find(who: Who, conversationId: string, caller: Caller, ref: string) {
  const prefix = ref.toLowerCase().replace(/[^0-9a-f-]/g, "");
  if (prefix.length < 4) return null;
  const rows = await db.select().from(jobs).where(and(mine(who, conversationId, caller), sql`${jobs.id}::text like ${`${prefix}%`}`)).limit(2);
  return rows.length === 1 ? rows[0]! : null;
}
const running = (who: Who, conversationId: string, caller: Caller) =>
  db.select().from(jobs).where(and(mine(who, conversationId, caller), eq(jobs.status, "working"))).orderBy(asc(jobs.createdAt));

const line = (w: Row) => `${short(w.id)}\t${w.status}\t${w.name}${w.agent ? ` (${w.agent})` : ""}`;

// The server's own record under a report, so Emplio can trust it without running commands to check.
type Run = { action: string; ok: boolean; error: string | null; createdAt: Date };
export const recordedLine = (runs: Run[], tz: string) =>
  runs.length
    ? `\nApps, as recorded: ${runs.map((r) => `${r.action} ${r.ok ? "ok" : `failed (${r.error})`}, ${when(r.createdAt, tz)}`).join("; ")}`
    : "";
// What the job sent or changed through apps; nothing for read-only look-ups.
// ponytail: this job's own chat only, so not its sub-jobs' or MCP tools'; the last 10 keep a long job's line short
async function recorded(w: Row) {
  if (!w.chatId) return "";
  const runs = await db
    .select({ action: actionRuns.action, ok: actionRuns.ok, error: actionRuns.error, createdAt: actionRuns.createdAt })
    .from(actionRuns)
    .where(eq(actionRuns.conversationId, w.chatId))
    .orderBy(asc(actionRuns.createdAt));
  const details = await Promise.all(runs.map((r) => detailOf(r.action, w)));
  const changes = runs.filter((_, i) => details[i] && !details[i]!.readOnly);
  return recordedLine(changes.slice(-10), await timezoneOf(w.userId));
}

const full = async (w: Row) => {
  const actions = await actionsOf(w);
  const head = `${short(w.id)} "${w.name}"${w.agent ? ` (${w.agent})` : ""}: ${w.status}, ${actions.length} actions\n`;
  return w.status === "working"
    ? `${head}now: ${actions.filter((a) => !a.done).at(-1)?.description ?? "thinking"}`
    : `${head}${w.report ?? ""}${await recorded(w)}`;
};
const notFound = (ref?: string) => `error: none of your threads starts with ${ref ?? "(nothing)"}; see emplio threads list`;

// Too long quiet to carry on: new work goes to a new thread then. Waiting on an answer, it always can.
export const tooOld = (w: Pick<Row, "status" | "finishedAt">, now = Date.now()) =>
  w.status !== "working" && w.status !== "asking" && !!w.finishedAt && now - w.finishedAt.getTime() > CONTINUE_MS;

// The threads Emplio can carry on, for the note on each message (chat.ts) and for a hand-off it got wrong. Dates, not
// "2 hours ago": the note is only sent again when this changes.
export async function threadsNote(who: Who, conversationId: string, caller: Caller) {
  const rows = await db
    .select()
    .from(jobs)
    .where(and(mine(who, conversationId, caller), isNotNull(jobs.chatId), or(inArray(jobs.status, ["working", "asking"]), gt(jobs.finishedAt, new Date(Date.now() - CONTINUE_MS)))))
    .orderBy(desc(sql`coalesce(${jobs.finishedAt}, now())`))
    .limit(LISTED);
  if (!rows.length) return "";
  const tz = await timezoneOf(who.userId);
  return [
    "Threads you can carry on with `emplio hand <id>`, latest first:",
    ...rows.map((w) => `- ${short(w.id)} · ${agentName(w.agent) ?? "myself"} · ${w.name} · ${w.status}${w.finishedAt ? `, ${when(w.finishedAt, tz)}` : ""}`),
  ].join("\n");
}

const USAGE = `usage: emplio hand <pick> [--description <what it does>] [--level light|strong] <<'EOF'
       <brief; its first line names the work in a few words>
       EOF
<pick> is one of:
  <thread id>      the same piece of work: it carries on with everything it knew; running, it reads this after its
                   current step
  <agent name>     new work for that agent, in a new thread
  <new job title>  new work of a kind that will come back: give --description too and the agent is made on the spot
  myself           a one-off nothing like it will come back: a plain copy of you, in a new thread
A new thread sees nothing of this chat: the brief must say everything it needs.

       emplio threads list                      your threads
       emplio threads show <id>                 one thread: what it's doing, or its report
       emplio threads wait [id...]              wait for them (default: all your running ones), print their reports;
                                                only in runs nobody watches and in threads, not in a chat with the person
       emplio threads stop <id|all>             stop working (the threads it started stop too)
       emplio threads remove <id>               stop it and delete it
       emplio threads notify <<'EOF' ... EOF    a thread Emplio started, to Emplio: wakes it, so only when the person
                                                said something it must act on now`;

export type JobsReply = { text: string; started?: string[] };

const THREAD_ID = /^[0-9a-f]{8}$/i;
// what a chat allows when a hand-off makes an agent; left out, it can't
type Maker = { admin: boolean; author: { name: string; email: string } };

// `emplio hand ...` and `emplio threads ...` from Emplio or a thread (`caller`), as text for it; `started`: threads to show.
// watched: Emplio talking with the person, who stays free to write: it doesn't sit waiting there (`wait`). Runs nobody
// watches and threads with threads of their own still wait: their run ends with their reply, and nothing wakes them after.
export async function jobsCommand(who: Who, conversationId: string, args: string[], caller: Caller, watched = false, maker?: Maker): Promise<JobsReply> {
  const [sub, ...rest] = args;
  switch (sub) {
    case "hand": {
      const { set, rest: words } = flags(rest, ["description", "level"]);
      const [pick, ...text] = words.map((x) => x.trim()).filter((x) => x && x !== "-");
      const brief = text.join("\n\n");
      if (!pick || !brief) break;
      const picks = async () => (await threadsNote(who, conversationId, caller)) || "You have no threads to carry on.";
      if (THREAD_ID.test(pick)) {
        const w = await find(who, conversationId, caller, pick);
        if (!w) return { text: `${notFound(pick)}\n${await picks()}` };
        if (!w.chatId) return { text: `error: ${short(w.id)} is from before threads had their own chat and can't carry on; hand it off as new work` };
        if (tooOld(w)) return { text: `error: ${short(w.id)} has been quiet for over a day. Nothing was started: hand this to ${w.agent ?? "myself"} as new work, with everything it needs in the brief.` };
        const busy = live.has(w.id);
        if (busy) steer(w.chatId);
        track(w.id);
        const run = generateId();
        void send(w, brief, run);
        record({ ...who, conversationId, kind: "job", summary: `Carried on "${w.name}"`, detail: { job: w.id, pick: "carry on", agent: w.agent, brief: brief.slice(0, 4000) } });
        return busy
          ? { text: `sent to ${short(w.id)} "${w.name}": it reads it after the step it's on` }
          : { text: `${short(w.id)} "${w.name}" is working on it`, started: [runRef(w.id, run)] };
      }
      const level = set.level === "strong" || set.level === "light" ? set.level : null;
      if (set.level && !level) return { text: "error: --level is light or strong" };
      if (caller.depth >= MAX_DEPTH) return { text: "error: threads this deep can't hand off; do it yourself, or say in your report what's left" };
      const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(jobs).where(and(eq(jobs.conversationId, conversationId), eq(jobs.status, "working")));
      if (n! >= MAX_RUNNING) return { text: `error: ${MAX_RUNNING} threads are already running in this chat; wait for some first` };
      const copy = pick.toLowerCase() === "myself";
      let agent = copy ? null : await findAgent(who.workspaceId, pick);
      const made = !copy && !agent;
      if (made) {
        // only Emplio makes agents, in an owner's or admin's chat (agents.ts)
        if (!maker?.admin || caller.depth) return { text: `error: there's no agent "${pick}", and this chat can't make one. Nothing was started: pick an agent from your list, or myself.` };
        if (!set.description) return { text: `error: there's no agent "${pick}" yet. Nothing was started. If that's the agent you mean, run it again with --description "<the kind of work it does>" and it's made; otherwise pick an agent from your list, or myself.` };
        const added = await agentsCommand({ ...who, admin: true, job: false, author: maker.author }, ["add", pick, "--description", set.description]);
        if (!added.changed) return { text: added.text };
        agent = await findAgent(who.workspaceId, pick);
      }
      if (agent?.archived) return { text: `error: ${agent.name} is archived; emplio agents restore ${agent.slug} first, or pick another` };
      const name = brief.split("\n")[0]!.trim().slice(0, 80);
      // its own chat, where it works and the person can open it
      const chatId = crypto.randomUUID();
      await db.insert(conversations).values({ id: chatId, ...who, title: agent ? `${agent.name}: ${name}` : name, kind: "job" });
      const [w] = await db
        .insert(jobs)
        .values({ ...who, conversationId, chatId, parentId: caller.jobId, depth: caller.depth + 1, name, agent: agent?.slug ?? null, level })
        .returning();
      track(w!.id);
      const run = generateId();
      void send(w!, brief, run);
      // which pick it was, to look back on: agents that never get used are the thing to watch
      record({ ...who, conversationId, kind: "job", summary: `Handed "${w!.name}" to ${agent?.name ?? "a copy of itself"}`, detail: { job: w!.id, depth: w!.depth, pick: made ? "new agent" : copy ? "myself" : "agent", agent: agent?.slug, brief: brief.slice(0, 4000) } });
      return { text: `started ${short(w!.id)} "${w!.name}"${agent ? ` with ${agent.name}` : ""}${made ? " (a new agent)" : ""}`, started: [runRef(w!.id, run)] };
    }
    case "notify": {
      const text = rest.map((x) => x.trim()).filter((x) => x && x !== "-").join("\n\n");
      if (!text) break;
      const w = caller.jobId ? await db.query.jobs.findFirst({ where: eq(jobs.id, caller.jobId) }) : null;
      if (!w) return { text: "error: only a thread can notify Emplio; you are Emplio" };
      if (w.depth !== 1) return { text: "error: only threads Emplio started can notify it; say it in your report to the thread that started you" };
      if (owed.has(w.id)) return { text: "error: Emplio is already waiting for your report, so nothing was sent: say it there" };
      void quiet(w.conversationId)
        .then(() => wake(w, `${JOB_NOTE_PREFIX}Your thread ${short(w.id)} "${w.name}", which the person is talking to in its own chat, says:\n\n${text}\n\nAct on it if it changes what you're doing; \`emplio hand ${short(w.id)}\` answers it.`))
        .catch((error) => console.error(`job ${w.id}: notifying the chat failed`, error));
      return { text: "Emplio has it, and picks it up as soon as it's free." };
    }
    case undefined:
    case "":
    case "list": {
      const rows = await db.select().from(jobs).where(mine(who, conversationId, caller)).orderBy(asc(jobs.createdAt));
      return { text: rows.length ? rows.map(line).join("\n") : "You haven't handed anything off yet." };
    }
    case "show": {
      const w = rest[0] ? await find(who, conversationId, caller, rest[0]) : null;
      if (w?.report) unseen.delete(w.id), untold.delete(w.id);
      return { text: w ? await full(w) : notFound(rest[0]) };
    }
    case "wait": {
      if (watched) return { text: "Not in a chat with the person: end your reply now, in a line. Their reports come to this chat when they finish, and you carry on then." };
      const found = rest.length ? await Promise.all(rest.map((r) => find(who, conversationId, caller, r))) : await running(who, conversationId, caller);
      const ids = found.flatMap((w) => (w ? [w.id] : []));
      if (!ids.length) return { text: rest.length ? notFound(rest.join(" ")) : "None of your threads are running." };
      // Emplio's wait ends a minute and a half before its reply would be cut off
      const ms = caller.depth ? WAIT_MS : Math.min(WAIT_MS, replyUntil(conversationId) - Date.now() - 90_000);
      const finished = Promise.all(ids.map((id) => live.get(id)?.done)).then(() => false);
      if (!caller.depth) for (const id of ids) waited.add(id);
      // the person wrote (steering, chat.ts): stop waiting so the reply can end and theirs go in
      // ponytail: polled each second; an event from chat.ts if that ever shows up
      let poll: Timer | undefined;
      const interrupted = caller.depth
        ? new Promise<never>(() => {})
        : new Promise<"steered">((r) => (poll = setInterval(() => steered(conversationId) && r("steered"), 1000)));
      const timedOut = await Promise.race([finished, new Promise<boolean>((r) => setTimeout(() => r(true), Math.max(0, ms))), interrupted]);
      clearInterval(poll);
      for (const id of ids) waited.delete(id), unseen.delete(id), untold.delete(id);
      const now = await db.select().from(jobs).where(inArray(jobs.id, ids)).orderBy(asc(jobs.createdAt));
      const still = caller.depth
        ? "Still working after 10 minutes: wait again, or stop them."
        : "Still working, and this reply is nearly out of time: don't wait again. End your reply now, saying what's still running; when they finish, their reports come to this chat and you carry on.";
      const busy = "The person just sent a message, so the wait ended. Your reply ends now: answer them next. These threads are still going; their reports come to this chat when they finish.";
      return { text: [...(await Promise.all(now.map(full))), ...(timedOut === "steered" ? [busy] : timedOut ? [still] : [])].join("\n\n") };
    }
    case "stop": {
      const ids =
        rest[0] === "all" ? (await running(who, conversationId, caller)).map((w) => w.id) : [(rest[0] ? await find(who, conversationId, caller, rest[0]) : null)?.id];
      const stopping = ids.filter((id): id is string => !!id);
      if (!stopping.length) return { text: rest[0] === "all" ? "None of your threads are running." : notFound(rest[0]) };
      for (const id of stopping) owed.delete(id), live.get(id)?.stop();
      await Promise.all(stopping.map((id) => live.get(id)?.done));
      return { text: `stopped ${stopping.map(short).join(", ")}` };
    }
    case "remove": {
      const w = rest[0] ? await find(who, conversationId, caller, rest[0]) : null;
      if (!w) return { text: notFound(rest[0]) };
      owed.delete(w.id);
      untold.delete(w.id);
      live.get(w.id)?.stop();
      await live.get(w.id)?.done;
      await db.delete(jobs).where(eq(jobs.id, w.id));
      if (w.chatId) await db.delete(conversations).where(eq(conversations.id, w.chatId));
      return { text: `removed ${short(w.id)} "${w.name}"` };
    }
  }
  return { text: USAGE };
}

// What Emplio is told about delegating (added to its system prompt; threads get it too).
export const MANAGER_PROMPT = `## How to get work done
Before any piece of work, pick the way to do it. The person never has to ask for a hand-off, and you don't ask them.
- **Yourself**: quick work, a few commands at most: a look-up, one app action, one file, a short answer. Also \
work the person is going through with you step by step (each step needs their answer), and signing in to a site.
- **Code**: the same thing over many items (rename 200 files, total a sheet, check 40 links, sort an \
export). Write one script and run it; never step through items one command at a time.
- **Hand it off** (\`emplio hand\`): all long work, always: anything likely to take over a minute or more than about 4 \
commands, browser work included. Also reading or digging that would fill your context (many emails, long files, \
several accounts or folders). Parts that don't depend on each other get one hand-off each (research three suppliers; \
check mail, Drive and the CRM), all started together. Steps where each needs the \
last one's result stay together: never split a chain, but a whole chain can be one hand-off.
- **The browser in a thread**: each thread has its own browser, signed in like yours, so several can browse at once. \
Say in the brief that it should use the browser. If a site needs the person to sign in, get that done first.
- A question doesn't keep work with you: ask before you start, or let the thread ask.
Can't tell how long it is? Start it yourself. Once you're more than about 4 commands in, hand off what's left: \
the brief says what's done, what's left and where the files are (a thread has the same computer and files). In a \
reply to a person, your commands stop running after 8 until you hand off.

## Handing off
One command: \`emplio hand <pick> <<'EOF'\`, then the brief, then EOF. The notes on the person's messages list your \
agents and the threads you can carry on. Pick the first of these that fits:
1. **The same work as a thread on your list** (a fix to what it did, more of the same, a follow-up, an answer it asked \
for): its id. It remembers everything it did and found, so the brief is only what's new. The same site or client \
isn't enough: it has to be the same piece of work.
2. **New work an agent on your list does**: the agent's name. A new thread starts for it.
3. **New work of a kind that will come back, and no agent fits**: a new job title with \`--description\`, and the agent \
is made on the spot: \`emplio hand "Invoice Chaser" --description "Chases unpaid invoices by email" <<'EOF'\`. Only in \
an owner's or admin's chat.
4. **A true one-off, nothing like it will come back**: \`myself\`, a plain copy of you in a new thread.

You are the manager: threads read and dig, you plan, judge and answer.
- A new topic while you're in the middle of something: when they write about something unrelated to the work \
you're on and it needs more than a quick answer, hand it off right away, without asking and without \
waiting for it, say in a line that you're on it, and carry on with your work in this same reply. They never have to ask for \
this. Answer it yourself if you can from what you already know, or if it's about the work at hand.
- Threads keep going when your reply ends; you don't. A message from the person ends your reply after its \
current command; your next reply answers them, then picks your work back up.
- In a chat with the person, never sit waiting for threads: start them, end your reply in a line, and they stay free \
to write. Reports come back to this chat on their own and you carry on from them. Only where nobody is watching \
(a task, an automation, a check-in) or when you are a thread yourself, finish with \`emplio threads wait\`, because \
that run ends with your reply. If the person writes during a wait, it ends so you can answer them.
- When your reply ends, don't say you're working on something or will carry on unless a thread is doing it right \
now. If you truly can't finish, say what you tried and what's left.
- A new thread sees nothing of this chat. Brief it like a new colleague: a first line naming the work in a few words, \
then the goal, every fact it needs (names, ids, dates, accounts, files, the person's preferences, the language and \
tone of anything it writes), anything you've already worked out so it needn't find it again (a site's exact address, \
the calls that work, what failed), what's off limits, and exactly what to report (e.g. "each invoice: number, client, \
amount, due date, link").
- Start them in one command, so the person sees them working:
\`\`\`
emplio hand "Invoice Chaser" <<'EOF'
<the brief>
EOF
emplio hand myself <<'EOF'
<the brief>
EOF
\`\`\`
- A running thread reads what you hand it after its current step (a correction, something the person just added); a \
finished one carries on with everything it knew.
- The person can open a thread's chat from its line and talk to it directly. You aren't woken for that: the thread's \
latest report comes as a note with your next reply, and a thread sends you a message only if you must act now. \
Act on either only if it changes what you're doing.
- A thread's app actions that send or change something (an email to send) show the person the same Allow card \
on the thread's line, and the thread waits for it; don't ask them first yourself, the card is the ask.
- A report starting "Question:" means the thread is waiting for an answer. Give it with \`emplio hand <its id>\` if \
you know it; otherwise ask the person, then hand the thread what they said.
- Trust a thread's report of what it did: don't run commands to check that it was done or sent. "Apps, as recorded:" under a report is the server's own \
list of what the thread sent or changed through apps. If it shows a failure, or the report says something was sent \
through an app and it isn't listed, or something looks missing or wrong, hand the thread a follow-up \
before telling the person it's done.
- Never pass on a report's "please confirm" as it is. If the code, files, apps or web could answer it, look it up \
yourself or hand the thread a follow-up saying where to look. Ask the person only what only they know: their \
reason, preference or decision.
- A thread may hand off parts of its task too.

## Agents
Agents are your saved specialists: a role with its own instructions, skills and notes from past work. What each one \
learns in its threads is saved for it automatically.
- Name one like a person's job title, someone who does the work: "Supplier Finder", "Invoice Chaser", "Task \
Reporter". One agent, one kind of work. Not the task ("Weekly Task Summary") and not one instance ("Flour suppliers \
Pune"). The brief carries this time's details; the agent holds how this kind of work is done. Improve the closest \
agent (\`emplio agents update\`) rather than making a near-copy, and archive ones no longer used (\`emplio agents archive\`).
- Its level: light (the default) for reading, searching, sorting and drafting; strong where judgment matters \
(negotiating, a tricky reply, a decision). \`--level strong\` raises a single hand-off.
- When a report shows an agent did the work wrong, fix its instructions, not only this thread.
- Work that repeats goes on the work list as a repeating task, naming its agent: \`emplio tasks add "Find new \
flour suppliers" --every "0 9 * * 1" --agent "Supplier Finder"\` (every Monday 9 am). A one-off for later: \
\`emplio tasks add "<what>" --due <when> --agent <name>\`.
- Runs nobody watches (repeating tasks, automations) can send or change things only through the app actions \
they list: give a repeating one \`--actions\` with each (\`--actions gmail.send_email\`). Saving it shows the \
person one card to allow them; tell them in a few words what it's for.
- The person doesn't manage agents: don't ask them to, and don't mention them unless they ask. They care that \
the work gets done.
- The person sees each thread's progress in the chat; don't repeat its steps, just give the outcome.

## Checklist
For work with 3 or more real steps, or several things asked at once, keep a checklist with \`emplio plan\`: \
the person sees it update as you go (on their phone too), so they know what's done and what's left. Not for \
quick questions or one-step work, and don't invent steps to fill it.
- One step per thing to do, in plain words. When asked for "all" of something, list each one.
- Give every command the number of the step it works on (bash's \`step\`): the list moves to that step and \
ticks off the one before, so it keeps up with you. When all the work is done, run \`emplio plan done\` (no \
number: ticks off everything left, including what your answer itself covers) before you write the answer.
- Mark a step done only once it's done and checked. If a step fails or isn't needed after all, remove it or \
reword it; don't mark it done. \`emplio plan help\` for the commands.
- Stopping to ask them something, or waiting on someone: the work isn't done, so leave its steps open and reword the \
next one to say what it needs (\`emplio plan update <n>\`). A command for another topic gets no step number.
- A note saying a checklist is unfinished: answer what they wrote first, then in the same reply carry on with \
it. If it needs them, end with one line naming what you still need, as your one offer ("Back to Swipe October: \
is the personal account to be added?"). If its last work is days old, ask in that line rather than carry on. If they \
dropped it or it's finished, \`emplio plan clear\` or tick it, so the note stops.`;

// A job's own chat, opened (chat.ts, GET /conversations/:id): the job it is, for the chat's header, and into the
// sidebar under the chat it came from (first time only, so it keeps its place) until closed there
export async function openJobChat(chatId: string, ctx: Pick<Ctx, "userId" | "workspaceId">): Promise<ChatJob | null> {
  const [w] = await db
    .update(jobs)
    .set({ openedAt: sql`coalesce(${jobs.openedAt}, now())` })
    .where(and(eq(jobs.chatId, chatId), eq(jobs.userId, ctx.userId), eq(jobs.workspaceId, ctx.workspaceId)))
    .returning();
  return w ? { id: w.id, name: w.name, agent: agentName(w.agent), status: w.status } : null;
}

export async function jobRoutes(app: FastifyInstance) {
  const params = { type: "object", required: ["id"], properties: { id: { type: "string", format: "uuid" } } } as const;
  const owned = (id: string, ctx: Who) => and(eq(jobs.id, id), eq(jobs.userId, ctx.userId), eq(jobs.workspaceId, ctx.workspaceId));

  // one job, for its line in the chat, polled while it works
  // run: the card's prompt (runRef); left out, the job as a whole
  app.get<{ Params: { id: string }; Querystring: { run?: string } }>("/jobs/:id", { schema: { params } }, async (req, reply) => {
    const ctx = await context(req, reply);
    if (!ctx) return;
    const w = await db.query.jobs.findFirst({ where: owned(req.params.id, ctx) });
    if (!w) return reply.code(404).send({ error: "Not found" });
    // ponytail: the name from its slug, not AGENT.md (polled every 1.5s); read the file if names drift from slugs
    return { id: w.id, name: w.name, agent: agentName(w.agent), chatId: w.chatId, ...(await runOf(w, req.query.run)) } satisfies JobInfo;
  });

  // the jobs the person opened as their own chat, nested in the sidebar under the chat they came from until closed
  app.get("/jobs", async (req, reply) => {
    const ctx = await context(req, reply);
    if (!ctx) return;
    const rows = await db
      .select({ id: jobs.id, name: jobs.name, agent: jobs.agent, status: jobs.status, chatId: jobs.chatId, conversationId: jobs.conversationId })
      .from(jobs)
      .innerJoin(conversations, eq(conversations.id, jobs.chatId))
      .where(
        and(
          eq(jobs.workspaceId, ctx.workspaceId),
          eq(jobs.userId, ctx.userId),
          isNotNull(jobs.openedAt),
          // quiet for a week: off the sidebar unless it's still going or waiting on them; its line still opens it
          or(inArray(jobs.status, ["working", "asking"]), gt(conversations.updatedAt, new Date(Date.now() - SIDEBAR_DAYS * 86_400_000))),
        ),
      )
      .orderBy(desc(jobs.openedAt));
    // ponytail: one lookup per level per opened job, and people keep a few open; join if the list grows
    return (await Promise.all(rows.map(async ({ conversationId, ...r }) => ({ ...r, agent: agentName(r.agent), startedIn: await startedIn(conversationId) })))) satisfies JobSummary[];
  });

  // out of the sidebar; its line in the chat still opens it
  app.post<{ Params: { id: string } }>("/jobs/:id/close", { schema: { params } }, async (req, reply) => {
    const ctx = await context(req, reply);
    if (!ctx) return;
    await db.update(jobs).set({ openedAt: null }).where(owned(req.params.id, ctx));
    return { ok: true };
  });
}
