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
import { FROM_EMPLIO, SILENT, HIDDEN_PART, JOB_NOTE_PREFIX, JOBS_DONE_PREFIX, KEEP_TOOLS_PREFIX, NOTHING_TO_KEEP, runRef, type Approval, type AskCard, type ChatJob, type JobInfo, type JobSummary, type PlanStep, type WorkingJob } from "@emplio/shared";
import { record } from "./activity";
import { detailOf } from "./approvals";
import { and, asc, desc, eq, gt, inArray, isNotNull, isNull, lt, or, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { context, type Ctx } from "./auth";
import { personFor, woke } from "./automations";
import { askOnPhone, closeOnPhone, mainChat, post, wroteFromPhone } from "./channels";
import { generateReply, lastWords, loadMessages, quiet, replyFromNotification, replyUntil, steer, steered } from "./chat";
import { db } from "./db";
import { actionRuns, conversations, jobs, messages } from "./db/schema";
import { addTools, agentPrompt, agentsCommand, findAgent, flags, listAgents, skillsUsed, toolsUsed } from "./agents";
import { canReopen, liveView, REOPEN_MS } from "./browser";
import { timezoneOf, when } from "./time";
import { isReplying } from "./live";
import { cloud } from "./cloud";
import { planText } from "./plan";
import { badEnding, DONE_BUT, doneProblem, MAX_PUSHES, openSteps, REPORT_SHAPE, SHAPE_NOTE, shapeProblem, statusOf, type Ending } from "./checks";

type Action = JobInfo["actions"][number];

// Who runs `emplio hand` or `emplio threads`: Emplio in the chat (depth 0) or one of its threads (1), theirs (2) and so on.
export type Caller = { depth: number; jobId: string | null };
export const EMPLIO: Caller = { depth: 0, jobId: null };
const MAX_DEPTH = 3;

// Jobs whose chat is replying now, so wait and stop can reach them: done resolves when the reply ends. Made when
// a job is started or told something, before its reply begins, so a wait right after doesn't miss it.
// run: the reply running for it now, so a reply that was told something new and wrapped up (steered) doesn't end
// the job under the reply that took over
type Live = { done: Promise<void>; end: () => void; stop: () => void; began: boolean; run?: object };
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
// A job that used up a run's steps carries on in a fresh run: when its time (JOB_MINUTES from the run it carries on
// from) runs out. In memory: a restart ends the job anyway (markOrphanedJobs).
const carryUntil = new Map<string, number>();
const deadline = (id: string) => carryUntil.get(id) ?? Date.now() + JOB_MINUTES * 60_000;
export const RESTARTED =
  "The server restarted and cut your last run off mid-work. Carry on from where you stopped, without redoing what's done: what you found is in your files and this chat. Threads you started were cut off too: check them with `emplio threads` before starting any again.";
// A job's run that kept no tool gets this after its report has gone (began, below): every kind of task done once
// is one call the next time. Opening a skill or calling a tool doesn't count: a job that did part of the work inline
// (a write by hand next to a skill that only reads) would never keep that part. Its answer is a line, not the report.
export const SAVE_TOOL =
  KEEP_TOOLS_PREFIX +
  'Your report has gone to whoever asked; nobody is waiting on this. Now keep what the next job like this would call as tools. For each such function: emplio.tools.save(<function>, area="<what it\'s about>", risk="reads" or "changes" or "spends"). Generic and modular: one step each, what changes (a name, a date, an id) as inputs, nothing fixed to this case; it brings the helpers it uses and tells you if something from this job should be an input. What you had to work out about one site or app (its address, the field that holds the answer) goes in a small tool of that site\'s area that calls the general one with those built in (reddit.username() calling sitelogin.account_name(url, field)), so the next job calls it with nothing to look up. A tool you used that failed: fix that same tool and save it again under its name, never a second one next to it. Keep it simple: save the steps that worked as they are, in a few steps. Don\'t debug, retry or redo the work here, and don\'t build more than the job needed; a step that won\'t save cleanly is left out. If every step was already a call to a saved tool, or this was a true one-off, save nothing. Reply with one line: the tools you saved, or "' +
  NOTHING_TO_KEEP +
  '" Not the report again.';
// No nudge for this piece of work: it was the nudge's own run (also when a restart or the step limit cut that run in
// two), or it ran SMALL_WORK commands or fewer. Each follow-up a job is given gets its own nudge.
const NUDGED = /^\[From Emplio\] (\[Keep tools\] )?(Your report has gone|Before your report)/;
const SMALL_WORK = 2;
// a new piece of work handed to a job; a restart's or the step limit's "carry on" goes on with the one before
const brief = (m: { role: string; parts: unknown }) =>
  m.role === "user" && textOf(m).startsWith(FROM_EMPLIO) && ![RESTARTED, CARRY_ON].includes(textOf(m).slice(FROM_EMPLIO.length)) && !CHECKS.test(textOf(m).slice(FROM_EMPLIO.length));
export const nudged = (msgs: { role: string; parts: unknown }[]) => {
  const at = msgs.length - 1 - [...msgs].reverse().findIndex(brief);
  if (at === msgs.length) return true;
  if (NUDGED.test(textOf(msgs[at]!))) return true;
  const commands = msgs.slice(at + 1).flatMap((m) => (m.role === "assistant" ? ((m.parts as { input?: unknown }[]) ?? []) : [])).filter((p) => p.input !== undefined);
  return commands.length <= SMALL_WORK;
};
// jobs in their tool-saving run: its end leaves the report and status as they were and wakes nobody
const saving = new Set<string>();
export const savedTool = (msgs: { role: string; parts: unknown }[]) => {
  const lastAsk = [...msgs].reverse().find((m) => m.role === "user");
  if (!lastAsk || !textOf(lastAsk).startsWith(FROM_EMPLIO)) return true;
  const back = [...msgs].reverse().findIndex((m) => m.role === "user" && textOf(m).startsWith(FROM_EMPLIO));
  return msgs
    .slice(back < 0 ? 0 : msgs.length - back)
    .flatMap((m) => (m.parts as { input?: { code?: string; command?: string }; output?: { output?: unknown } }[]) ?? [])
    .some((p) => {
      const code = p.input?.code ?? p.input?.command ?? "";
      const out = typeof p.output?.output === "string" ? p.output.output : "";
      const wrote = /\.write_text\(|\.write\(|open\([^)]*['"][wa]['"]/.test(code) && /toolset\/\w+\.py/.test(code);
      return /^Saved tool [a-z][a-z0-9_]*\.\w+ \(/m.test(out) || wrote;
    });
};
// its last run answered Emplio, not the person writing in its chat: a report, whose shape is checked
const toEmplio = async (w: Row) => !!w.chatId && textOf([...(await loadMessages(w.chatId))].reverse().find((m) => m.role === "user") ?? { parts: [] }).startsWith(FROM_EMPLIO);
// the report's shape is asked for once: a job that still doesn't write it is let through, its report as it is
const askedShape = async (w: Row) => (await loadMessages(w.chatId!)).some((m) => m.role === "user" && textOf(m).startsWith(FROM_EMPLIO + SHAPE_NOTE.slice(0, 30)));
// a Done its last command says isn't (checks.ts doneProblem)
async function doneCheck(w: Row, report: string) {
  const msgs = await loadMessages(w.chatId!);
  const last = actionsIn(msgs).at(-1);
  const lastSent = textOf([...msgs].reverse().find((m) => m.role === "user") ?? { parts: [] });
  return doneProblem(report, {
    lastFailed: last && (last.error || (last.exitCode ?? 0) !== 0) ? last.description : null,
    askedBefore: lastSent.startsWith(FROM_EMPLIO + DONE_BUT),
  });
}
// how many times this piece of work was sent back by the checks on its last run (checks.ts)
const pushed = new Map<string, number>();
// what the checks send: none of it is new work
const CHECKS = /^(Your run ended without a report|Your last step only thought|Your last message was cut off|You wrote code into your message|Your last message only said|Your report isn't in the shape|Your report says Done, but)/;
export const CARRY_ON =
  "That run used up its steps, so this is a fresh one. Your job card has the work and your checklist: carry on with the next step not ticked, without redoing what's done. What you found is in your files and your notes; keep building the result as you go.";
// What happens to a report when a job's reply ends: wake Emplio, keep it for its next reply, or nothing.
// interrupted: a message is waiting to go into the job's chat, so it hasn't finished.
export const reportGoes = (o: { depth: number; stopped: boolean; owed: boolean; interrupted: boolean }) =>
  o.depth !== 1 || o.stopped ? "nowhere" : o.owed && !o.interrupted ? "wake" : "untold";

const MAX_RUNNING = 10; // per chat at once, every level: a runaway plan can't fan out forever
const LISTED = 8; // threads on Emplio's list
const SIDEBAR_DAYS = 7;
// a job's steps per run; past them it carries on in a fresh run, within JOB_MINUTES
export const JOB_MAX_STEPS = 250;
export const JOB_MINUTES = 120; // a job's runs, carry-ons after the step limit included (chat.ts); a person's reply gets 15
const WAIT_MS = 10 * 60_000;

// from: the chat it was started from, which it can search for what the person said there
export const RULES = (depth: number, from?: string) => `## You have one piece of work
${depth > 1 ? "Another thread" : "Emplio"} handed you one task, in this chat of your own. Messages starting \
"${FROM_EMPLIO.trim()}" are from ${depth > 1 ? "the thread that started you" : "Emplio"}; any other message is the person, who opened \
your chat and wrote to you directly: answer them, and what they say wins over your brief. Your last message \
each time is your report, which goes back to whoever started you, and the person may read it too. ${
  depth === 1
    ? "When the person writes to you directly, Emplio isn't woken: it reads your latest report the next time it replies. Only if they say something Emplio must act on now, tell it with `emplio threads notify <<'EOF' ... EOF`; never for small talk or what they can already see in your answer. "
    : ""
}${
  depth < MAX_DEPTH
    ? "You are the one who does the work: do it yourself, browser included. Only a big part that doesn't depend on the rest may go off with `emplio hand <agent or myself> <<'EOF'`, a brief (the work, the goal, what's known, done when), then EOF; `myself` is a plain copy of you, and you can't make agents. If one comes back with a question, answer it with `emplio hand <its id>` when you can; if only a person can, end with that question yourself (below)."
    : "You are the one who does the work: do it yourself, browser included; you can't hand off."
}
Your job card, at the end of these instructions, holds the work on hand: its brief word for word and everything \
added to it since. Do all of it and check the result: an addition adds to the work and changes it only where it \
says so ("instead", "stop", "drop"), never replacing the rest. Your instructions and skills say how you work, never \
what to do instead, so a brief unlike your usual work or your last one is still the job. Work of more than a few \
steps: write its checklist first (\`emplio plan set\`, a step for each part of the brief and its additions) and tick \
each step as you finish it (\`emplio plan done <n>\`); the person follows your work there, and it stays on your card. \
Work silently: no messages between commands. Write words once, at the end: your report. Long reading goes into files, not your chat: your chat gets folded into short \
notes as it grows, and a run stops after a set number of steps (a fresh one carries on), so anything only in your \
chat is lost and gets read again. Read a big document once, with a script that pulls out what the task needs into a \
small file in your folder (every item with its page, say), and work from that file; never print a whole document \
to read it. When the task makes something (a sheet, a document, a list), start the file early and add to it as you \
go, section by section, so nothing done is lost. If you worked out how a site works, put it in that site's skill before you report. \
Before writing code for a step, look for a tool that does it \
(your tools are listed below; others: \`emplio.tools.search("<words>")\`). None does it: write the step as a small \
function from your first try, what changes (a name, a date, an id) as its inputs, and call it; when it breaks, fix the \
function and run it again, not loose lines, so what works is already a tool to keep. When the task succeeds, keep what the next \
job of this kind would call as tools before you report: \`emplio.tools.save(<function>, area="<what it's about>", \
risk="reads" or "changes" or "spends")\` for each, modular, reusable and generic: one step each, taking what changes \
(a name, a date, an id) as inputs, nothing fixed to this one case, so the next job just calls them; what you worked \
out about one site or app (its address, the field with the answer) goes in a small tool of that site's area that calls \
the general one with those built in. A tool that failed: fix that same tool and save it again under its name, never a \
second one next to it. Judgment the code can't hold (when to ask first, how to word things) goes in a \
skill's SKILL.md.
Getting it right: work out every number, total and date in code, never in your head. After you send or change \
something outside (an email, a post, a record in an app), read it back from where it landed before counting it \
done. A total that a site, app or file states ("52 invoices", "1-50 of 686") is a check: your count must match it, \
or find out why. Copy ids, invoice numbers and amounts exactly; one that looks wrong is flagged, never fixed. Never \
make up data you couldn't get: say it's missing.
Then end with your report for whoever started you, which is checked against your job card, in English (quote the \
person's words and names as they wrote them, in any language; Emplio answers them in theirs), in exactly this shape \
(files you made stay in /work/out, stored in Files; Emplio shows them to the person):
${REPORT_SHAPE}
Never say Done for work you've only started. No preamble. Don't claim what you didn't verify. If the task is unclear, do the most sensible reading and say \
which one you chose. If you truly can't go on without a decision or a fact only a person has (guessing would \
be wrong or risky), ${
  depth === 1 && from
    ? `first look for it in what they said in the chat that started you (\`emplio history search <words> --chat ${from.slice(0, 8)}\`). Still missing: \
ask them yourself with \`emplio ask "<question>" "<answer>" ...\` (2 to 4 short answers to tap; none for an open one; \
several questions, one \`emplio ask\` each in one command), which puts a card over their chat box, then end your \
reply in a few words. Their answer comes back to you as a message and you carry on. Where \`emplio ask\` says \
nobody can answer, stop and make your report start with "Question:" instead: exactly what you need and why, then \
what you've done so far.`
    : `stop and make your report start with "Question:": exactly what you need and why, then what you've done so far. \
The answer comes back to you as a message and you carry on.`
} Whoever started you may also \
send you a message while you work: it arrives as a new message and joins your job card. Do it as well; where it \
contradicts the brief, it wins on that point only.
An app action that sends or changes something (an email, a payment, a post) shows the person an Allow card on \
your line in their chat and waits for their tap: just run it. If they don't answer or say no, it says so; report that and \
what was ready, without trying another way.
Other threads may be running at the same time on the same computer: use your own folder under /work/tmp, and \
don't use the browser unless your task says to.`;

// What Emplio is told when reports come in that it didn't wait for. `going`: its threads still running, which may be
// other parts of the same request, so it can hold back until they're in.
export const reportsNote = (reports: string[], going: string[], asking: boolean) =>
  `${JOBS_DONE_PREFIX}Your threads ended after your last reply did:\n\n${reports.join("\n\n")}\n\nCarry on with what the person asked, using these reports. Name what it's about in your first words: they may be in the middle of something else. If all you do is send work back to a job (it isn't done) or answer its question, there's nothing new for them: write no words before or after the command, just end with exactly ${SILENT}; they see its line at work again.${
    asking
      ? ` A thread that asks a question waits for the answer: give it with \`emplio hand <its id>\` if you know it, and then end with exactly ${SILENT} unless the person must hear something; otherwise ask the person (one message, all the questions), and hand the thread what they say.`
      : ""
  }${
    going.length
      ? `\n\nStill running: ${going.join(", ")}. Their reports come here when they finish; they have their work, don't hand it again. If this result is of use to the person on its own, tell it now, and in a few words what's still running. If it's only a piece the others complete (one half of a comparison, one part of a single file or answer), end instead with exactly ${SILENT} (they see nothing) and answer when the rest are in.`
      : ""
  }`;

// What Emplio reads with its next reply: threads' reports it wasn't woken for, cut short so old chatter stays cheap.
const NOTE_REPORT = 1500;
export const untoldNote = (reports: string[]) =>
  `[The person worked in these threads' chats directly, so you weren't woken. Their latest reports, for you to know; don't mention them unless it matters (\`emplio threads show <id>\` for all of one):\n\n${reports.map((r) => (r.length > NOTE_REPORT ? `${r.slice(0, NOTE_REPORT)}…` : r)).join("\n\n")}\n]`;

// Emplio's threads in this chat still working, or ended with a report it hasn't read yet: a reply here comes once they're in (resume)
export async function reportsDue(conversationId: string) {
  const rows = await db.select({ id: jobs.id, status: jobs.status }).from(jobs).where(and(eq(jobs.conversationId, conversationId), isNull(jobs.parentId)));
  return rows.some((r) => r.status === "working" || unseen.has(r.id));
}

// agents still at it for this chat, or asking the person something: Emplio isn't waiting on the person yet (chat.ts nextStep)
export const stillWorking = async (conversationId: string) =>
  !!(await db.query.jobs.findFirst({ where: and(eq(jobs.conversationId, conversationId), inArray(jobs.status, ["working", "asking"])), columns: { id: true } }));

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
  let error: string | null = null;
  for await (const chunk of (await generateReply(person, w.conversationId, message, log))!) if (chunk.type === "error") error = chunk.errorText;
  // an automation's run ends with the reply its threads' reports woke, not with the one that handed them off
  void woke(w.conversationId, error).catch((err) => console.error(`job ${w.id}: ending the automation's run failed`, err));
  if (error) return false;
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

// A question nobody answered in a day isn't waited on any more: like closing it (the close route), so Emplio stops
// expecting its report and the agent can take new work. A day: its browser can't be reopened after that either.
export async function expireAsking(now = Date.now()) {
  const gone = await db.update(jobs).set({ status: "stopped" }).where(and(eq(jobs.status, "asking"), lt(jobs.finishedAt, new Date(now - REOPEN_MS)))).returning({ id: jobs.id });
  for (const { id } of gone) owed.delete(id), untold.delete(id);
  return gone.length;
}

// Jobs that died with the process (a restart, a deploy) are marked so at startup, and Emplio is told in each
// chat, so it can have them carry on from their last step (`emplio hand <id>`).
// ponytail: one server, so anything working at startup is dead; with several, claim each one first
export async function markOrphanedJobs() {
  const cut = await db.select().from(jobs).where(eq(jobs.status, "working"));
  // Emplio's own jobs asked something within their time carry on by themselves, so nobody has to say "start again".
  // Timed from the last thing asked of it, not when it began: a job given a follow-up hours later is working on that.
  // Once only: one cut off again after carrying on fails as before (something in it may be what stops the server).
  const again = async (r: Row) => {
    if (r.depth !== 1 || !r.chatId) return false;
    const [last] = await db.select({ at: messages.createdAt }).from(messages).where(and(eq(messages.conversationId, r.chatId), eq(messages.role, "user"))).orderBy(desc(messages.createdAt)).limit(1);
    if (Date.now() - (last?.at ?? r.createdAt).getTime() > JOB_MINUTES * 60_000) return false;
    const prompt = (await loadMessages(r.chatId)).reverse().find((m) => m.role === "user" && textOf(m).startsWith(FROM_EMPLIO));
    return !prompt || textOf(prompt) !== FROM_EMPLIO + RESTARTED;
  };
  const carried = new Set<string>();
  // ponytail: a fixed wait for the person's computer to link back up after the restart; wait for its link if 20 s falls short
  for (const r of cut) if (await again(r)) carried.add(r.id), setTimeout(() => void send(r, RESTARTED), 20_000);
  if (carried.size) console.log(`carrying on ${carried.size} job(s) cut off by the restart`);
  const report = "Cut off by a server restart. Its work so far is kept: `emplio hand <id>` with \"carry on\" picks it up from where it stopped.";
  const rest = cut.filter((r) => !carried.has(r.id)).map((r) => r.id);
  if (!rest.length) return;
  const rows = await db.update(jobs).set({ status: "failed", report, finishedAt: new Date() }).where(and(eq(jobs.status, "working"), inArray(jobs.id, rest))).returning();
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
  const admin = w.agent ? (await personFor(w.workspaceId, w.userId))?.role !== "member" : false;
  const agent = w.agent ? await findAgent(w.workspaceId, w.agent, { userId: w.userId, admin }) : null;
  return {
    caller: { depth: w.depth, jobId: w.id } satisfies Caller,
    prompt: [RULES(w.depth, w.conversationId), ...(agent ? [await agentPrompt(w.workspaceId, agent, { userId: w.userId, admin })] : [])].join("\n\n"),
    strong: (w.level ?? agent?.level) === "strong",
    agent: agent?.name,
    startedIn: w.conversationId,
    unattended: await unattended(w.conversationId),
    until: deadline(w.id),
    began: (stop: () => void) => began(w, stop),
    card: async () => jobCard(await loadMessages(chatId), (await db.query.conversations.findFirst({ where: eq(conversations.id, chatId), columns: { plan: true } }))?.plan),
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
export async function startedIn(chatId: string): Promise<string> {
  const parent = await db.query.jobs.findFirst({ where: eq(jobs.chatId, chatId), columns: { conversationId: true } });
  return parent ? startedIn(parent.conversationId) : chatId;
}

async function keepTools(w: Row, chatId: string) {
  const parts = (await loadMessages(chatId)).flatMap((m) => (m.parts as { input?: { code?: string; command?: string }; output?: unknown }[]) ?? []);
  const used = toolsUsed(parts);
  const skills = skillsUsed(parts);
  if (!used.length && !skills.length) return;
  const person = await personFor(w.workspaceId, w.userId);
  const agent = await findAgent(w.workspaceId, w.agent!, { userId: w.userId, admin: person?.role !== "member" });
  if (agent && person) await addTools({ workspaceId: w.workspaceId, author: { name: person.userName, email: person.userEmail }, admin: person.role !== "member" }, agent, used, skills);
}

async function began(w: Row, stop: () => void) {
  const until = deadline(w.id);
  carryUntil.delete(w.id);
  const e = track(w.id);
  const run = {};
  Object.assign(e, { stop, began: true, run });
  // it asked a question: whoever answers it here, Emplio is still waiting on the result
  // the tool-saving run after the report: the job stays done, with its report, and the run's end only ends it
  if (saving.has(w.id))
    return async (answer: string, outcome: "completed" | "failed" | "stopped", interrupted = false) => {
      saving.delete(w.id);
      if (w.agent && w.chatId) await keepTools(w, w.chatId).catch((error) => console.error("keeping an agent's tools failed", error));
      live.delete(w.id);
      e.end();
      // told of unticked checklist steps (openSteps), it found one really undone and wrote a new report: that one goes
      if (outcome !== "completed" || interrupted || !statusOf(answer)) return;
      await db.update(jobs).set({ report: answer, finishedAt: new Date() }).where(eq(jobs.id, w.id));
      if (w.depth !== 1) return;
      unseen.add(w.id);
      if (!waited.has(w.id)) void resume(w).catch((error) => console.error(`job ${w.id}: resuming the chat failed`, error));
    };
  if (w.depth === 1 && w.status === "asking") owed.add(w.id);
  await db.update(jobs).set({ status: "working", report: null, finishedAt: null }).where(eq(jobs.id, w.id));
  // its last words are its report: a question waits for an answer
  // capped: the run ended on the step limit, mid-work
  // carded: it asked the person with a card (emplio ask), which shows over their chat box and sends their answer here
  return async (answer: string, outcome: "completed" | "failed" | "stopped", interrupted = false, capped = false, carded: AskCard[] = [], ending?: Ending) => {
    const timeLeft = Date.now() < until - 60_000;
    // the tools and skills this run saved or used join its agent's list now, so its next job has them up front
    if (w.agent && w.chatId) await keepTools(w, w.chatId).catch((error) => console.error("keeping an agent's tools failed", error));
    // told something new while it ran (carryOn), the next reply has begun on the job: that one ends it, with its report
    if (live.get(w.id)?.run !== run) return;
    // checks on how it ended and on its report's shape (checks.ts): sent back, MAX_PUSHES times at most a piece of work
    const pushes = pushed.get(w.id) ?? 0;
    const sendBack =
      !capped && outcome === "completed" && !interrupted && !carded.length && pushes < MAX_PUSHES
        ? (ending && badEnding(ending)) || (asks(answer) || !answer || !(await toEmplio(w)) ? null : ((await askedShape(w)) ? null : shapeProblem(answer)) ?? (await doneCheck(w, answer)))
        : null;
    if (sendBack) pushed.set(w.id, pushes + 1);
    else pushed.delete(w.id);
    if ((capped || sendBack) && outcome === "completed" && !interrupted && timeLeft) {
      // a new entry for the next run, which ends the old one's waits when it ends; the old send() leaves it be
      carryUntil.set(w.id, until);
      live.delete(w.id);
      track(w.id).done.then(e.end);
      const told = owed.has(w.id);
      void send(w, capped ? CARRY_ON : sendBack!);
      if (!told) owed.delete(w.id);
      return;
    }
    const msgs = outcome === "completed" && !capped && !interrupted && !carded.length && !asks(answer) && w.chatId ? await loadMessages(w.chatId) : null;
    const nudge = !!msgs && !savedTool(msgs) && !nudged(msgs);
    const unfinished =
      outcome === "failed" && !timeLeft ? "Ran out of time, not finished. " : capped && !interrupted ? "Stopped at the step limit, not finished. " : "";
    const asked = outcome === "completed" && !unfinished && carded.length > 0;
    const report = asked
      ? `Question: ${carded.map((c) => `${c.question}${c.options.length ? ` [${c.options.join(" / ")}]` : ""}`).join("\n")}`
      : unfinished + (answer || (outcome === "failed" ? "It failed." : outcome === "stopped" ? "Stopped." : "(it ended without a report)"));
    // a run that ended without a word did nothing anyone can check: failed, so it isn't taken for done (#244)
    const status = unfinished ? "failed" : outcome === "completed" ? (asked || asks(report) ? "asking" : answer ? "done" : "failed") : outcome;
    await db.update(jobs).set({ status, report, finishedAt: new Date() }).where(eq(jobs.id, w.id));
    if (status === "done") cloud.onWork(w.workspaceId, w.userId, "agent");
    live.delete(w.id);
    e.end();
    // its card is the ask: Emplio isn't woken for it, and still gets the report the answer leads to. Unless the
    // person last wrote from their phone, which doesn't show the card: Emplio asks there instead.
    const direct = asked && w.depth === 1 && !(await wroteFromPhone(w.conversationId));
    const goes = direct ? "nowhere" : reportGoes({ depth: w.depth, stopped: outcome === "stopped", owed: owed.has(w.id), interrupted });
    if (goes === "untold") untold.add(w.id);
    if (goes === "wake") {
      owed.delete(w.id);
      untold.delete(w.id);
      unseen.add(w.id);
      // Emplio's reply ended first: the chat that started it carries on once its jobs are all done
      if (!waited.has(w.id)) void resume(w).catch((error) => console.error(`job ${w.id}: resuming the chat failed`, error));
    }
    // after its report, like the tool-saving nudge: a Done with checklist steps unticked (usually only the ticking was
    // missed), then the nudge, in one quiet run
    const open =
      status === "done" && statusOf(report) === "done" && w.chatId
        ? ((await db.query.conversations.findFirst({ where: eq(conversations.id, w.chatId), columns: { plan: true } }))?.plan ?? []).filter((s) => s.status !== "done").map((s) => s.text)
        : [];
    if ((nudge || open.length) && status === "done") {
      saving.add(w.id);
      const told = owed.has(w.id);
      void send(w, open.length ? openSteps(open) + (nudge ? `\n\nThen: ${SAVE_TOOL}` : "") : SAVE_TOOL, undefined, true);
      if (!told) owed.delete(w.id);
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
async function send(w: Row, text: string, run = generateId(), hidden = false, update = false) {
  const e = track(w.id);
  if (w.depth === 1) owed.add(w.id);
  const person = await personFor(w.workspaceId, w.userId);
  const message: UIMessage = { id: run, role: "user", parts: [{ type: "text", text: FROM_EMPLIO + text }, ...(hidden ? [{ type: HIDDEN_PART, data: true } as const] : []), ...(update ? [{ type: UPDATE_PART, data: true } as const] : [])] as UIMessage["parts"] };
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
    // the tool-saving run after a report: the job is done either way
    if (saving.delete(w.id)) {
      live.delete(w.id);
      return e.end();
    }
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
          .filter((p) => p.type === "tool-bash" || p.type === "tool-python")
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

// The question cards (emplio ask) in a job's last reply that nobody has answered yet: a message after it is the answer.
export function openAsks(msgs: { role: string; parts: unknown }[]): AskCard[] {
  const last = msgs.at(-1);
  if (last?.role !== "assistant") return [];
  return (last.parts as { output?: { asks?: AskCard[] } }[]).flatMap((p) => p.output?.asks ?? []);
}

// A job's card for one run (the prompt that started it, see send). The latest run is the job's own status and
// report; an earlier one is finished, with what it did and said then. A prompt not in the chat yet is queued.
// "Question: none." is a report that asks nothing
const asks = (report: string) => /^\W*question\b/i.test(report) && !/^\W*question:\s*(none|no)\b/i.test(report);
const textOf = (m: { parts: unknown }) =>
  ((m.parts as { type?: string; text?: string }[]) ?? []).flatMap((p) => (p.type === "text" && p.text ? [p.text] : [])).join("");

// Marks what Emplio sent a job while it worked: an addition to the work on hand, not new work (jobCard)
export const UPDATE_PART = "data-update";
const isUpdate = (m: { parts: unknown }) => ((m.parts as { type?: string }[]) ?? []).some((p) => p.type === UPDATE_PART);
const CARD_BRIEF = 8_000;
const CARD_ADDED = 2_000;
const CARD_ADDITIONS = 12;
const capped = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}\n[… cut here; all of it is in your chat]` : s);

// The job card: the work on hand, rebuilt from the job's chat each run and after each fold, so neither its notes nor
// a fresh run lose it (a job once forgot its brief after a fold and took an update for the whole task). The latest
// piece of work Emplio handed it, word for word, what Emplio added while it worked and what the person wrote since,
// and its checklist (emplio plan, kept on its chat).
const work = (m: { role: string; parts: unknown }) => brief(m) && !NUDGED.test(textOf(m));
// where the work on hand starts: the latest piece of work Emplio handed it, not an addition to one
const workAt = (msgs: { role: string; parts: unknown }[]) => {
  let at = msgs.length - 1;
  while (at >= 0 && !(work(msgs[at]!) && !isUpdate(msgs[at]!))) at--;
  return at;
};
export function jobCard(msgs: { role: string; parts: unknown }[], steps: PlanStep[] | null | undefined) {
  const at = workAt(msgs);
  if (at < 0) return "";
  const added = msgs.slice(at + 1).flatMap((m) => {
    if (m.role !== "user") return [];
    const text = textOf(m).trim();
    if (work(m) && isUpdate(m)) return [`From Emplio: ${capped(text.slice(FROM_EMPLIO.length).trim(), CARD_ADDED)}`];
    // the person's own words; bracketed lines are ours (reports, restarts, nudges)
    return text && !text.startsWith("[") ? [`From the person: ${capped(text, CARD_ADDED)}`] : [];
  });
  const shown = added.slice(-CARD_ADDITIONS);
  return [
    "## Your job card",
    "Kept for you outside your chat: it stays as it is when your chat is folded into notes or a fresh run starts. It's the work on hand, done when all of it is done.",
    "### The work, word for word",
    capped(textOf(msgs[at]!).slice(FROM_EMPLIO.length).trim(), CARD_BRIEF),
    ...(shown.length
      ? [
          "### Added since, oldest first (each adds to the work, and changes it only where it says so)",
          ...(added.length > shown.length ? [`(${added.length - shown.length} earlier ones are in your chat)`] : []),
          ...shown.map((a, i) => `${i + 1}. ${a}`),
        ]
      : []),
    "### Your checklist",
    steps?.length ? planText(steps) : "None yet. More than a few steps: write one now with `emplio plan set`.",
  ].join("\n");
}

// The messages of one run: from its prompt up to the next piece of work from Emplio (a restart cutting it in two
// doesn't end it). null while the prompt isn't in the chat.
export function runSpan<M extends { id: string; role: string; parts: unknown }>(msgs: M[], run: string) {
  const at = msgs.findIndex((m) => m.id === run);
  if (at < 0) return null;
  const next = msgs.findIndex((m, i) => i > at && brief(m));
  return { msgs: msgs.slice(at, next < 0 ? undefined : next), latest: next < 0 };
}

async function runOf(w: Row, run?: string): Promise<Pick<JobInfo, "status" | "report" | "actions" | "ms">> {
  // how long it's been at it: up to now while it works (the card counts on from there), to its end once finished
  const took = (from?: Date, working = w.status === "working") => {
    const end = working ? Date.now() : w.finishedAt?.getTime();
    return from && end ? { ms: end - new Date(from).getTime() } : {};
  };
  if (!run || !w.chatId) return { status: w.status, report: w.report, actions: await actionsOf(w), ...took(w.createdAt) };
  const all = await loadMessages(w.chatId);
  const span = runSpan(all, run);
  if (!span) return { status: "working", report: null, actions: [] };
  const actions = actionsIn(span.msgs);
  if (span.latest) {
    // just handed it, not begun: the job still holds the run before's status and report, and a finished card stops checking
    const asked = (span.msgs[0]?.metadata as { createdAt?: Date } | undefined)?.createdAt;
    const stale = asked && w.finishedAt && w.finishedAt < new Date(asked);
    return stale && w.status !== "working" ? { status: "working", report: null, actions, ...took(asked, true) } : { status: w.status, report: w.report, actions, ...took(asked) };
  }
  const last = [...span.msgs].reverse().find((m) => m.role === "assistant" && textOf(m).trim());
  const text = last ? textOf(last).trim() : "";
  const ended = runEnd(span.msgs, all[all.indexOf(span.msgs.at(-1)!) + 1]);
  return { status: asks(text) ? "asking" : "done", report: text || null, actions, ...(ended && { ms: ended - sentAt(span.msgs[0]!) }) };
}

const sentAt = (m: UIMessage) => new Date((m.metadata as { createdAt: Date | string }).createdAt).getTime();
// When an earlier run ended, which the job no longer holds (its finishedAt is the latest run's): the tool-saving
// nudge after it is sent the moment it ends; otherwise its last reply's start plus the time its steps and thinking
// took (chat.ts), a little short of the whole.
export function runEnd(span: UIMessage[], after?: UIMessage) {
  if (after && textOf(after).startsWith(FROM_EMPLIO + KEEP_TOOLS_PREFIX)) return sentAt(after);
  const last = [...span].reverse().find((m) => m.role === "assistant");
  if (!last) return undefined;
  type Timed = { output?: { ms?: number }; providerMetadata?: { emplio?: { ms?: number } } };
  return sentAt(last) + (last.parts as Timed[]).reduce((sum, p) => sum + (p.output?.ms ?? p.providerMetadata?.emplio?.ms ?? 0), 0);
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

// Under the report of finished work: the moment to turn a kind of work into an agent, or to give one made without
// instructions (`bare`) its instructions from what just worked.
// ponytail: said in staff chats too, where `emplio agents add|update` refuses with its own clear error; check admin here if that's noisy
export const agentNudge = (w: Pick<Row, "status" | "agent" | "depth">, bare = false) =>
  w.status !== "done" || w.depth !== 1
    ? ""
    : !w.agent
      ? "\n[A plain copy of you did this. If this kind of work will come back, make an agent for it now so the next one goes to it, with its instructions from how this went: `emplio agents add` (emplio agents help). A true one-off: ignore this.]"
      : bare
        ? `\n[${w.agent} has no instructions yet, only its brief each time. Write them now from how this went: emplio agents update ${w.agent} - <<'EOF' (the steps that worked, what to check, what it reports) EOF. They're for every job of this kind: general steps only, never this job's names, ids, amounts or clients.]`
        : "";

const bareAgent = async (w: Row) =>
  !!w.agent && w.status === "done" && w.depth === 1 && (await findAgent(w.workspaceId, w.agent, { userId: w.userId, admin: true }))?.instructions === "";
const full = async (w: Row) => {
  const actions = await actionsOf(w);
  const head = `${short(w.id)} "${w.name}"${w.agent ? ` (${w.agent})` : ""}: ${w.status}, ${actions.length} actions\n`;
  return w.status === "working"
    ? `${head}now: ${actions.filter((a) => !a.done).at(-1)?.description ?? "thinking"}`
    : `${head}${w.report ?? ""}${madeNote(actions)}${await recorded(w)}${agentNudge(w, await bareAgent(w))}`;
};
// what a job already put in the person's chat, so Emplio doesn't show it again
const madeNote = (actions: Action[]) => {
  const made = new Map(actions.flatMap((a) => a.saved ?? []).map((f) => [f.filename, f.id]));
  return made.size ? `\n[Files it already showed the person on its line: ${[...made].map(([name, id]) => (id ? `${name} (${id.slice(0, 8)})` : name)).join(", ")}.]` : "";
};
const notFound = (ref?: string) => `error: none of your threads starts with ${ref ?? "(nothing)"}; see emplio threads list`;

// The threads Emplio can carry on, for the note on each message (chat.ts) and for a hand-off it got wrong. Dates, not
// "2 hours ago": the note is only sent again when this changes.
// The heading of that list (the evals build the same note: evals/emplio.ts)
export const AGENTS_HEADING = "Your agents (`emplio hand <name>`; work for several sites, clients or accounts: a job each, `--new` on each after the first, all in one command):";
export const THREADS_HEADING = "Your agents' jobs in this chat, latest first (`emplio hand <agent>` adds to its job while it works, else starts a fresh one; `emplio hand <id>` carries on a finished one):";
export async function threadsNote(who: Who, conversationId: string, caller: Caller) {
  // each agent's latest job: the one `emplio hand <agent>` goes to
  const all = await db
    .select()
    .from(jobs)
    .where(and(mine(who, conversationId, caller), isNotNull(jobs.chatId)))
    .orderBy(desc(sql`coalesce(${jobs.finishedAt}, now())`))
    .limit(50);
  const seen = new Set<string>();
  const rows = all.filter((w) => (w.agent ? !seen.has(w.agent) && !!seen.add(w.agent) : true)).slice(0, LISTED);
  if (!rows.length) return "";
  const tz = await timezoneOf(who.userId);
  return [
    THREADS_HEADING,
    ...rows.map((w) => `- ${short(w.id)} · ${agentName(w.agent) ?? "myself"} · ${w.name} · ${w.status}${w.finishedAt ? `, ${when(w.finishedAt, tz)}` : ""}`),
  ].join("\n");
}

const USAGE = `usage: emplio hand <agent> [--new] [--description <what it does>] [--level light|strong] <<'EOF'
       <brief; its first line names the work in a few words>
       EOF
Work goes to an agent. In this chat each agent keeps one job going:
  emplio hand <agent>          while that agent's job here is working or waiting on an answer: adds to it (it reads
                               this after its current step); otherwise a fresh job
  emplio hand <id>             carries on that finished job with everything it knew: the same piece of work only
  emplio hand <agent> --new    a second job for the agent while its first is still working
  emplio hand "<New Agent>" --description "<the kind of work it does>"
                               no agent fits: it's made, and its first job starts
A new job sees nothing of this chat: the brief must say everything it needs.

       emplio threads list                      your threads
       emplio threads show <id>                 one thread: what it's doing, or its report
       emplio threads wait [id...]              wait for them (default: all your running ones), print their reports;
                                                only in runs nobody watches and in threads, not in a chat with the person
       emplio threads stop <id|all>             stop working (the threads it started stop too)
       emplio threads remove <id>               stop it and delete it
       emplio threads notify <<'EOF' ... EOF    a thread Emplio started, to Emplio: wakes it, so only when the person
                                                said something it must act on now`;

export type JobsReply = { text: string; started?: string[] };

// New work for a job that has one: running, it reads it after its current step; finished, it carries on with everything it knew.
async function carryOn(who: Who, conversationId: string, w: Row, brief: string): Promise<JobsReply> {
  if (!w.chatId) return { text: `error: ${short(w.id)} is from before jobs had their own chat and can't carry on; hand it off with --new` };
  const busy = live.has(w.id);
  if (busy) steer(w.chatId);
  else {
    // finished, it takes the new work's name (as a fresh job would), so its line and report say what it's on now
    w.name = brief.split("\n")[0]!.trim().slice(0, 80) || w.name;
    await db.update(jobs).set({ name: w.name }).where(eq(jobs.id, w.id));
    await db.update(conversations).set({ title: w.agent ? `${agentName(w.agent)}: ${w.name}` : w.name }).where(eq(conversations.id, w.chatId));
  }
  track(w.id);
  const run = generateId();
  // while it works, this adds to the work on hand (its job card); finished, it's new work
  void send(w, brief, run, false, busy);
  record({ ...who, conversationId, kind: "job", summary: `Carried on "${w.name}"`, detail: { job: w.id, pick: "carry on", agent: w.agent, brief: brief.slice(0, 4000) } });
  return busy
    ? { text: `sent to ${short(w.id)} "${w.name}"${w.agent ? ` (${agentName(w.agent)})` : ""}: it reads it after the step it's on` }
    : { text: `${short(w.id)} "${w.name}"${w.agent ? ` (${agentName(w.agent)})` : ""} is working on it`, started: [runRef(w.id, run)] };
}

// the agents a person's work can go to: theirs, admins' (for an owner or admin) and the company's
const viewerOf = async (who: Who) => ({ userId: who.userId, admin: (await personFor(who.workspaceId, who.userId))?.role !== "member" });
const activeAgents = async (who: Who) => (await listAgents(who.workspaceId, await viewerOf(who))).filter((a) => !a.archived);

// An agent that a new one's name would nearly copy ("Fabric Supplier Finder" next to "Supplier Finder"), or null.
// ponytail: the words of the names; a meaning match if near-copies with other words get through
const WORDS = (name: string) => new Set(name.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2 && !["and", "the", "for"].includes(w)));
export function closeTo(name: string, agents: string[]): string | null {
  const a = WORDS(name);
  for (const other of agents) {
    const b = WORDS(other);
    const shared = [...a].filter((w) => b.has(w)).length;
    if (!a.size || !b.size || !shared) continue;
    if (shared === a.size || shared === b.size || shared / new Set([...a, ...b]).size >= 0.5) return other;
  }
  return null;
}

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
      const fresh = rest.includes("--new");
      const { set, rest: words } = flags(rest.filter((x) => x !== "--new"), ["description", "level"]);
      const [pick, ...text] = words.map((x) => x.trim()).filter((x) => x && x !== "-");
      const brief = text.join("\n\n");
      if (!pick || !brief) break;
      const yours = async () => {
        const names = (await activeAgents(who)).map((a) => a.name);
        return names.length ? `Your agents: ${names.join(", ")}.` : "You have no agents yet.";
      };
      const make = 'Or make one: emplio hand "<Agent Name>" --description "<the kind of work it does>".';
      // a job id still works: that job carries on
      if (THREAD_ID.test(pick)) {
        const w = await find(who, conversationId, caller, pick);
        if (!w) return { text: `error: no job ${pick} here. Nothing was started: hand it to an agent by name (emplio hand <agent>). ${await yours()}` };
        return carryOn(who, conversationId, w, brief);
      }
      const level = set.level === "strong" || set.level === "light" ? set.level : null;
      if (set.level && !level) return { text: "error: --level is light or strong" };
      if (caller.depth >= MAX_DEPTH) return { text: "error: threads this deep can't hand off; do it yourself, or say in your report what's left" };
      // a plain copy: only for a thread splitting off part of its own work, which can't make agents
      const copy = pick.toLowerCase() === "myself";
      if (copy && !caller.depth) return { text: `error: work goes to an agent, not to a copy of you. Nothing was started. ${await yours()} ${make}` };
      let agent = copy ? null : await findAgent(who.workspaceId, pick, await viewerOf(who));
      const made = !copy && !agent;
      if (made) {
        if (!maker || caller.depth) return { text: `error: there's no agent "${pick}", and a thread can't make one. Nothing was started: pick one, or myself. ${await yours()}` };
        if (!set.description) return { text: `error: there's no agent "${pick}". Nothing was started. ${await yours()} If none of them fits, run it again with --description "<the kind of work it does>" and "${pick}" is made.` };
        const close = closeTo(pick, (await activeAgents(who)).map((a) => a.name));
        if (close) return { text: `error: "${pick}" is close to your agent ${close}. Nothing was started: hand it to ${close} (emplio agents update widens what it does), or name the new one for clearly different work.` };
        const added = await agentsCommand({ ...who, admin: true, job: false, author: maker.author }, ["add", pick, "--description", set.description], true);
        if (!added.changed) return { text: added.text };
        agent = await findAgent(who.workspaceId, pick, await viewerOf(who));
      }
      if (agent?.archived) return { text: `error: ${agent.name} is archived; emplio agents restore ${agent.slug} first, or pick another` };
      // the agent's job here: new work goes to it, unless --new
      const current = agent
        ? (await db.select().from(jobs).where(and(mine(who, conversationId, caller), eq(jobs.agent, agent.slug), isNotNull(jobs.chatId))).orderBy(desc(jobs.createdAt)).limit(1))[0]
        : undefined;
      // still at it: this adds to its work. Finished: a fresh job (a finished one carries on only by its id), so one
      // job doesn't pile up unrelated work: a job once went from LinkedIn posts to X sign-in to a video, 446 steps
      const active = current && (current.status === "working" || current.status === "asking");
      if (active && !fresh) return carryOn(who, conversationId, current, brief);
      const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(jobs).where(and(eq(jobs.conversationId, conversationId), eq(jobs.status, "working")));
      if (n! >= MAX_RUNNING) return { text: `error: ${MAX_RUNNING} threads are already running in this chat; wait for some first` };
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
      record({ ...who, conversationId, kind: "job", summary: `Handed "${w!.name}" to ${agent?.name ?? "a copy of itself"}`, detail: { job: w!.id, depth: w!.depth, pick: made ? "new agent" : copy ? "myself" : fresh && current ? "fresh" : "agent", agent: agent?.slug, brief: brief.slice(0, 4000) } });
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
      // with nothing named, the latest job here (`emplio threads show` after a wait)
      const w = rest[0] ? await find(who, conversationId, caller, rest[0]) : (await db.select().from(jobs).where(mine(who, conversationId, caller)).orderBy(desc(jobs.createdAt)).limit(1))[0];
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
You are the manager: you work out what the person wants, plan it, hand the doing to your agents, check what comes \
back and answer. Each agent has its own chat, computer and browser, runs on a cheaper model and remembers its job. \
The person never asks for this; don't ask them.
- **The test**: doable from what's in this chat (their words, your notes, your jobs' reports) with at most two \
commands of your own (each counts, even several in one step)? Yours. Anything more goes to an agent from the first step: finding things out, opening what \
you haven't seen, acting on a site or in an app, working through data. Past three commands of your own in a reply, \
the rest aren't run.
- **Yours**: understanding, deciding, planning, answering, asking the person, checking reports, one quick look-up in \
your notes or files (not a search through mail, chats or apps), and a reply, draft, summary or final report written from your jobs' reports (even a \
"document": one markdown file in /work/out, one command, shown).
- **An agent's**: research; reading mail, sites, files or documents ("has Raj replied?", "did the payment come in?": \
an agent looks; never answer "not yet" from your notes); anything in an app, a database or a server \
(finding the action and its inputs alone takes several commands); anything in a browser, like opening a site or store (you have none); sends and \
changes; sign-ins; data work across sheets or files; a file needing more than the reports hold (a sheet built from \
data, slides, a long document). No saved login or connected app is no reason to stop: the agent opens the site and \
asks the person to save the login when needed. A question doesn't keep work with you: ask before it starts, or let the job ask.
- What the reports lack, or a change to a job's file (a new column too), goes back to that job, never into its files yourself. About to run a third command, or one of \
yours failed: hand it off with what you have (and the error). Don't start work you'll have to hand off.
- A matching skill is an agent's work: hand it to the agent that has it (your agents list says which), naming the \
skill in the brief; don't run it yourself. More of work you did yourself ("send it", "try again"): hand that off too.

### Split big work
Parts that don't need each other (one per site, per client, per account) are separate jobs, all started in one \
command, so they run at the same time and you put their reports together; one brief with all of them runs them one \
after the other. A comparison, or steps needing an earlier step's result, stay in one job; so does small work.
"price of the ivory bedsheet at homecraft, fabindia and urban ladder" is three jobs of one agent, in one command:
\`\`\`
emplio hand 'Price Checker' <<'EOF'
<the brief, for homecraft>
EOF
emplio hand 'Price Checker' --new <<'EOF'
<the brief, for fabindia>
EOF
emplio hand 'Price Checker' --new <<'EOF'
<the brief, for urban ladder>
EOF
\`\`\`

## Handing off
\`emplio hand <agent> <<'EOF'\`, the brief, EOF. The note on the person's message lists your agents and each one's \
job in this chat. Every piece of work goes to an agent; there is no plain copy of you.
1. **Its job here is still working or waiting on an answer**: \`emplio hand <agent>\` adds this to it (it reads it \
after its current step).
2. **Its job here has finished**: \`emplio hand <agent>\` starts a fresh job, so one job never piles up unrelated work. \
Only the same piece of work goes back to the finished job, by its id (\`emplio hand <id>\`, ids in the note on the \
person's message): a fix, a gap, a retry, "send it", the next batch of the same list, an answer it asked for. A new \
goal, site, client or document is a fresh job, even for the same agent.
3. **No agent fits**: make one named like a job title: \`emplio hand "Invoice Chaser" --description "Chases unpaid \
invoices by email" <<'EOF'\`. One of yours is close: use it (\`emplio agents update\` widens it).

The brief carries everything (a job sees nothing of this chat), however long or technical:
- first line: the work in a few words
- **Goal**: what the person wants, and why if known
- **Person said**: their words that matter, quoted exactly, every name and condition kept ("only the ones about \
Kaveri", "skip Sai Residency")
- **Known**: names, ids, dates, accounts, links, files; what you worked out and what failed before
- **Done when**: exactly what to deliver (the file and its columns, the list, the message sent)
- **Ask first**: what needs their OK
To a job that worked on it before: only what's new, plus their exact words.

### Questions
- An agent asks the person itself, on a card; the answer goes straight to it: don't ask again or chase it. They \
answer you instead (here or on their phone): hand it to that agent.
- A report starting "Question:" waits: answer if you know, else ask the person, and hand their answer to that agent \
at once (\`emplio hand <agent>\`, never \`--new\`), quoted exactly, nothing softened, added or argued. Sign-in codes \
go the moment they arrive: they expire.
- Never pass on a report's "please confirm": if the job could look it up, send it back saying where. Ask the person \
only what only they know (a reason, preference, decision).
- A job's sends and changes show the person an Allow card on its line: the card is the ask, don't ask first.

### Reports
- Before telling the person it's done, hold the report against Done when. Stopped partway ("Now building the \
workbook"), a missing file, a failure in "Apps, as recorded:" (the server's list of what it sent or changed), or a \
send it claims that isn't listed: send it back to the same agent at once with exactly what's missing, and end with \
exactly ${SILENT} unless the person must know something now. Sent back once is enough: in later replies, tell the \
person if you must, but don't send it again before its next report.
- Its Checked part is its proof: something that came back from where the work landed (a link, an id, a read-back), \
a count tied to a total, a figure worked out in code. "Checked: all sent fine", "all good", "done" is no proof. A \
part of Done when with no proof at all, or a count that disagrees with a total it states ("the portal lists 40", \
"38 filed"): send it back at once with that part and how to check it, before telling the person anything. Proof \
that's there is enough: don't ask for more. "Partly done" or "Blocked": pass on \
what's left only if it needs the person; else send it back.
- Check by reading the report and that record; doubts go back as a question. Don't open its files or redo its work.
- Done: give the outcome with the file or link, not its steps. An agent that did its work wrong: fix its \
instructions too (\`emplio agents update\`).

### While jobs run
- A new topic mid-work: hand it off at once, say you're on it in a line, and carry on with yours.
- Jobs keep going after your reply; you don't. A message from the person ends your reply after its current \
command; your next reply answers them, then picks your work back up.
- With the person, never wait for jobs: start them and end your reply; reports come back here by themselves. Asked \
how one is going: look (\`emplio threads show\`); don't send it a message for that. Only where nobody watches (a task, an automation, a check-in) or as a \
job yourself, finish with \`emplio threads wait\`.
- Ending a reply, say you're working on something only if a job is doing it right now.
- The person can talk to a job in its own chat; its latest report comes to you with your next reply: act on it if \
it changes your work.

## Agents
Your saved specialists, each with its own instructions, skills, tools and lessons (saved for it automatically).
- One agent per kind of work, named like a job title ("Supplier Finder"), not the task ("Weekly Task Summary") or \
one instance ("Flour suppliers Pune"). Widen the closest rather than make a near-copy; archive unused ones.
- The right size is a role someone could be hired for, with work most weeks: one app or one area of the business, \
never one task. Too narrow → right: "Flight Fare Checker" → "Travel Desk"; "WhatsApp Chat Reader" and "WhatsApp \
Group Poster" → "WhatsApp Assistant"; "Annual Filing Drafter" and "MCA Form Filler" → "Company Filings Clerk"; \
"LinkedIn Invite Sender" and "LinkedIn Request Replier" → "LinkedIn Outreach"; "Menu Card Maker" → "Designer"; \
"Invoice Maker" and "Payment Chaser" → "Accounts Assistant". Too broad: "Assistant", "Helper", "Operations". Before \
making one, read your agents list by what each does, not by name: one that covers the kind of work gets it.
- Level light (default) for reading, searching, sorting, drafting; strong where judgment matters (negotiating, a \
tricky reply, a decision, and money, tax, legal or compliance work: books, reconciliations, filings, contracts); \`--level strong\` raises one hand-off.
- Repeating work is a repeating task naming its agent (\`emplio tasks add "Find new flour suppliers" --every \
"0 9 * * 1" --agent "Supplier Finder"\`); a one-off for later uses \`--due\`. Runs nobody watches send or change \
things only through the app actions listed in \`--actions\`; saving shows the person one card to allow them: say in \
a few words what it's for.
- The person doesn't manage agents: don't ask them to, or mention agents unless asked.

## Checklist
Work of 3 or more real steps, or several asks at once: your first command is \`emplio plan set\` with the steps; the \
person watches it update (phone too), so it keeps them posted. Steps are your agents' work and your checks, not a \
reason to do them yourself. Not for quick or one-step work; no filler steps; asked for "all" of something, one step each.
- Give every command its step's number (the tool's \`step\`): the list moves there. All done: \`emplio plan done\` \
(no number: ticks off everything) before writing the answer.
- A step is done only once done and checked; failed or not needed: remove or reword it. Another topic's command \
gets no step.
- Waiting on them or someone: leave steps open, reword the next to say what it needs (\`emplio plan update\`).
- A note that a checklist is unfinished: answer what they wrote, then carry on with it. Needs them: end with one \
line naming what (your one offer: "Back to Swipe October: is the personal account to be added?"); its last work days \
old: ask in that line instead. Dropped or finished: \`emplio plan clear\` or tick it.`;

// A job's own chat, opened (chat.ts, GET /conversations/:id): the job it is, for the chat's header, and into the
// sidebar under the chat it came from (first time only, so it keeps its place) until closed there
export async function openJobChat(chatId: string, ctx: Pick<Ctx, "userId" | "workspaceId">): Promise<ChatJob | null> {
  const [w] = await db
    .update(jobs)
    .set({ openedAt: sql`coalesce(${jobs.openedAt}, now())` })
    .where(and(eq(jobs.chatId, chatId), eq(jobs.userId, ctx.userId), eq(jobs.workspaceId, ctx.workspaceId)))
    .returning();
  if (!w) return null;
  const from = await db.query.conversations.findFirst({ where: eq(conversations.id, w.conversationId), columns: { id: true, title: true, kind: true } });
  return {
    id: w.id,
    name: w.name,
    agent: agentName(w.agent),
    status: w.status,
    from: from ? { id: from.id, title: from.kind === "main" ? "Main chat" : from.title || "Chat" } : null,
  };
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

  // the agents at work for this chat, or waiting on an answer: a strip over its message box, so the person sees what's
  // still going however far up it was asked; and their live browsers, a tab each in its browser panel (Emplio has none
  // of its own). Polled while the chat is open.
  app.get<{ Params: { id: string } }>("/conversations/:id/working", { schema: { params } }, async (req, reply) => {
    const ctx = await context(req, reply);
    if (!ctx) return;
    const rows = await db
      .select({ id: jobs.id, name: jobs.name, chatId: jobs.chatId, agent: jobs.agent, status: jobs.status, usedAt: conversations.browserUsedAt })
      .from(jobs)
      .innerJoin(conversations, eq(conversations.id, jobs.chatId))
      .where(
        and(
          eq(jobs.conversationId, req.params.id),
          eq(jobs.userId, ctx.userId),
          eq(jobs.workspaceId, ctx.workspaceId),
          isNull(jobs.parentId),
          // finished ones too while their browser may still be open: its tab stays until the browser closes
          or(inArray(jobs.status, ["working", "asking"]), gt(conversations.browserUsedAt, new Date(Date.now() - REOPEN_MS))),
        ),
      )
      .orderBy(asc(jobs.createdAt));
    // ponytail: one browser-service look per job, every poll; a few at most
    const all = await Promise.all(
      rows.map(async (r) => {
        const status = r.status === "working" || r.status === "asking" ? r.status : "done";
        return {
          id: r.id,
          chatId: r.chatId!,
          name: r.name,
          agent: agentName(r.agent) ?? "Emplio",
          status,
          browser: status !== "asking" && canReopen(r.usedAt) && !!(await liveView(r.chatId!)),
          ...(status === "asking" && { asks: openAsks(await loadMessages(r.chatId!)) }),
        } satisfies WorkingJob;
      }),
    );
    return all.filter((w) => w.status !== "done" || w.browser);
  });

  // the person answering a job's question card from the chat that started it: as if typed in the job's chat
  app.post<{ Params: { id: string }; Body: { text: string } }>(
    "/jobs/:id/answer",
    { schema: { params, body: { type: "object", required: ["text"], properties: { text: { type: "string", minLength: 1, maxLength: 20_000 } } } } },
    async (req, reply) => {
      const ctx = await context(req, reply);
      if (!ctx) return;
      const w = await db.query.jobs.findFirst({ where: owned(req.params.id, ctx) });
      if (!w?.chatId) return reply.code(404).send({ error: "Not found" });
      const error = await replyFromNotification(ctx.userId, w.chatId, req.body.text, req.log);
      if (error) return reply.code(400).send({ error });
      return { ok: true };
    },
  );

  // the jobs the person opened as their own chat, nested in the sidebar under the chat they came from until closed
  app.get("/jobs", async (req, reply) => {
    const ctx = await context(req, reply);
    if (!ctx) return;
    const rows = await db
      .select({ id: jobs.id, name: jobs.name, agent: jobs.agent, status: jobs.status, chatId: jobs.chatId, conversationId: jobs.conversationId, updatedAt: conversations.updatedAt })
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
    // updatedAt and running: an open job chat follows a run the server started (a follow-up, the tool-saving run)
    return (await Promise.all(
      rows.map(async ({ conversationId, updatedAt, ...r }) => ({ ...r, agent: agentName(r.agent), startedIn: await startedIn(conversationId), updatedAt: updatedAt.toISOString(), running: isReplying(r.chatId!) })),
    )) satisfies JobSummary[];
  });

  // out of the sidebar; its line in the chat still opens it
  // Close: out of the sidebar. A job waiting on an answer stops waiting too (status stopped), so its line over the chat
  // box goes and Emplio no longer expects its report; a job still working carries on.
  app.post<{ Params: { id: string } }>("/jobs/:id/close", { schema: { params } }, async (req, reply) => {
    const ctx = await context(req, reply);
    if (!ctx) return;
    const [w] = await db.update(jobs).set({ openedAt: null }).where(owned(req.params.id, ctx)).returning({ status: jobs.status });
    if (w?.status === "asking") {
      await db.update(jobs).set({ status: "stopped" }).where(and(owned(req.params.id, ctx), eq(jobs.status, "asking")));
      owed.delete(req.params.id);
      untold.delete(req.params.id);
    }
    return { ok: true };
  });
}
