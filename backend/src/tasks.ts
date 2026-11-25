// Tasks: every task in a business, for a person or for the AI itself (assigneeId null): what's to be
// done, how, who asked, when it's due. The web app's Tasks page and `emplio tasks` share these functions.
// Owner and admins see and change all of them; staff the ones they asked for or have to do.
// Chasing (`chase`, run by the check-in timer, in each person's own work hours): once a person's task is due they get a reminder
// on their channel, once (their morning brief lists it as late after that); two days late, whoever asked (or the owner) is told, once.
// One of the AI's own can name the agent of its that does it (`agent`): its run hands it over (`emplio hand`).
// The AI's own tasks (`startDueTasks`) start on their own at their due time (straight away without one), as whoever
// asked, with their apps and view: back in the chat they came from, with everything said there,
// or in a new background chat when there's none (added on the Tasks page, or the chat was deleted). The background agent's hand-offs always get a new one.
// Its last words reach that person in their main chat (and on their phone), with a link when it was done elsewhere.
import { generateId, type UIMessage } from "ai";
import { and, asc, eq, gte, inArray, isNotNull, isNull, lte, or, sql, type SQL } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { TASK_PREFIX, TASK_STATUSES, type Role, type Task, type TaskInput, type TaskStatus } from "@emplio/shared";
import { record } from "./activity";
import { findAgent, listAgents } from "./agents";
import { context } from "./auth";
import { listAutomations, personFor } from "./automations";
import { generateReply, lastWords, quiet } from "./chat";
import { isReplying } from "./live";
import { chatLink, heldBack, mainChat, post, sendTo } from "./channels";
import { db } from "./db";
import { at, DEFAULT_ZONE, hourIn, timezoneOf, when } from "./time";
import { clients, conversations, jobs, tasks, workspaceMembers, workspaces } from "./db/schema";
import { findClient, labelChat } from "./clients";
import { stepFinished, stepInfo } from "./processes";
import { listTeam } from "./team";

type Who = { workspaceId: string; userId: string; role: Role };
type Row = typeof tasks.$inferSelect;

const OPEN: TaskStatus[] = ["todo", "doing", "waiting"];
const AI = "the AI employee";
const DAY = 24 * 3_600_000;
// generateReply's marker for a task run (chat.ts, approvals.ts)
export const TASK = "task";

const isAdmin = (w: Who) => w.role !== "member";
// the people who report to this person (team.ts setManager): they see and change their tasks
const reportsOf = (w: Who) =>
  db.select({ id: workspaceMembers.userId }).from(workspaceMembers).where(and(eq(workspaceMembers.workspaceId, w.workspaceId), eq(workspaceMembers.reportsTo, w.userId)));
const manages = async (w: Who, userId: string | null) => !!userId && (await reportsOf(w)).some((r) => r.id === userId);
const mayChange = (w: Who, t: Row) => isAdmin(w) || t.assigneeId === w.userId || t.requesterId === w.userId;
// when people get reminders, on their own clock
const HOURS = { start: 9, end: 20 };

// "2026-10-25" (by 6 pm that day) or "2026-10-25 15:30" on the clock of `tz` (whoever set it); or an ISO time from the web app.
export function parseDue(s: string, tz = DEFAULT_ZONE) {
  const m = /^(\d{4}-\d{2}-\d{2})(?:[ T](\d{2}:\d{2}))?$/.exec(s.trim());
  const d = m ? at(m[1]!, m[2] ?? "18:00", tz) : new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

// what each task's agent is called now, as whoever asked sees their agents (the run hands it over as them)
async function agentNames(rows: Row[], workspaceId: string) {
  const names = new Map<string, string>();
  for (const userId of new Set(rows.flatMap((t) => (t.agent && t.requesterId ? [t.requesterId] : []))))
    for (const a of await listAgents(workspaceId, { userId, admin: true }).catch(() => [])) names.set(`${userId}/${a.slug}`, a.name);
  return names;
}

async function toTask(rows: Row[], workspaceId: string): Promise<Task[]> {
  const names = new Map((await listTeam(workspaceId)).map((m) => [m.id, m.name ?? m.email]));
  const agents = await agentNames(rows, workspaceId);
  const ids = [...new Set(rows.flatMap((t) => (t.clientId ? [t.clientId] : [])))];
  const clientNames = new Map(ids.length ? (await db.select({ id: clients.id, name: clients.name }).from(clients).where(inArray(clients.id, ids))).map((c) => [c.id, c.name]) : []);
  const runs = await stepInfo([...new Set(rows.flatMap((t) => (t.runId ? [t.runId] : [])))]);
  return rows.map((t) => withName({
    id: t.id,
    title: t.title,
    notes: t.notes,
    status: t.status,
    waitingOn: t.waitingOn,
    assigneeId: t.assigneeId,
    agent: t.agent,
    agentName: t.agent ? (agents.get(`${t.requesterId}/${t.agent}`) ?? t.agent) : null,
    requesterId: t.requesterId,
    requesterName: t.requesterId ? (names.get(t.requesterId) ?? "(left the team)") : null,
    dueAt: t.dueAt?.toISOString() ?? null,
    conversationId: t.conversationId,
    workConversationId: t.workConversationId,
    // "doing" says it was picked up, not that a run is going now (a run cut off, or set by hand)
    running: !!t.workConversationId && isReplying(t.workConversationId),
    chases: t.chases,
    clientId: t.clientId,
    clientName: t.clientId ? (clientNames.get(t.clientId) ?? null) : null,
    process: processOf(t, runs.get(t.runId ?? "")),
    createdAt: t.createdAt.toISOString(),
    doneAt: t.doneAt?.toISOString() ?? null,
    assigneeName: t.assigneeId ? (names.get(t.assigneeId) ?? "(left the team)") : AI,
  }));
}
const processOf = (t: Row, run: Awaited<ReturnType<typeof stepInfo>> extends Map<string, infer R> ? R | undefined : never): Task["process"] => {
  if (!run || t.stepIndex === null) return null;
  const back = run.steps[t.stepIndex]?.back;
  // sending back only from the step it's on
  return {
    runId: run.id,
    name: run.process,
    title: run.processTitle,
    step: t.stepIndex + 1,
    of: run.steps.length,
    backTo: back && run.step === t.stepIndex && run.status === "active" ? (run.steps[back - 1]?.name ?? null) : null,
    inputs: run.inputs,
  };
};
const withName = (t: Task): Task => (t.agentName ? { ...t, assigneeName: `the ${t.agentName} agent` } : t);

// assignee: a user id, null for the AI, undefined for anyone. open: not done or cancelled. due: due by now. client: theirs only.
// Finished ones only from the last 30 days unless old: a firm with 80 clients finishes hundreds of steps a month, and
// those mustn't push open work off the list.
export async function listTasks(w: Who, f: { assignee?: string | null; open?: boolean; due?: boolean; mine?: boolean; client?: string; old?: boolean } = {}) {
  const where: (SQL | undefined)[] = [eq(tasks.workspaceId, w.workspaceId)];
  // ponytail: direct reports only; walk the whole chain below them if teams get deep
  if (f.mine) where.push(or(eq(tasks.assigneeId, w.userId), eq(tasks.requesterId, w.userId)));
  else if (!isAdmin(w)) where.push(or(eq(tasks.assigneeId, w.userId), eq(tasks.requesterId, w.userId), inArray(tasks.assigneeId, reportsOf(w))));
  if (f.assignee === null) where.push(isNull(tasks.assigneeId));
  else if (f.assignee) where.push(eq(tasks.assigneeId, f.assignee));
  if (f.open) where.push(inArray(tasks.status, OPEN));
  else if (!f.old) where.push(or(inArray(tasks.status, OPEN), gte(tasks.updatedAt, new Date(Date.now() - 30 * 86_400_000))));
  if (f.due) where.push(lte(tasks.dueAt, new Date()));
  if (f.client) where.push(eq(tasks.clientId, f.client));
  const rows = await db
    .select()
    .from(tasks)
    .where(and(...where))
    .orderBy(sql`${tasks.dueAt} asc nulls last`, asc(tasks.createdAt))
    // ponytail: no paging; a workspace with over 5000 open tasks needs it
    .limit(5000);
  return toTask(rows, w.workspaceId);
}

async function check(w: Who, input: TaskInput) {
  if (input.title !== undefined && !input.title.trim()) return "a task needs a title";
  if (input.status !== undefined && !TASK_STATUSES.includes(input.status)) return `status is one of ${TASK_STATUSES.join(", ")}`;
  if (input.dueAt && !parseDue(input.dueAt)) return "the due date should look like 2026-10-25 or 2026-10-25 15:30";
  if (input.assigneeId) {
    const m = await db.query.workspaceMembers.findFirst({
      where: and(eq(workspaceMembers.workspaceId, w.workspaceId), eq(workspaceMembers.userId, input.assigneeId)),
    });
    if (!m) return "that person isn't on the team";
  }
  if (input.clientId) {
    const c = await db.query.clients.findFirst({ where: and(eq(clients.workspaceId, w.workspaceId), eq(clients.id, input.clientId)) });
    if (!c) return "no such client (emplio clients list)";
  }
  if (input.agent) {
    if (input.assigneeId) return "a task goes to a person or to an agent, not both";
    // by its id (slug) or its name, renamed ones too; saved by id, which stays when it's renamed
    const viewer = { userId: w.userId, admin: isAdmin(w) };
    const q = input.agent.trim().toLowerCase();
    const a = (await findAgent(w.workspaceId, input.agent, viewer)) ?? (await listAgents(w.workspaceId, viewer)).find((x) => x.name.toLowerCase() === q);
    if (!a || a.archived) return `no agent named "${input.agent}" (emplio agents list)`;
    input.agent = a.slug;
  }
  return null;
}

type Result = { ok: true; task: Task } | { ok: false; error: string };
const one = async (row: Row) => (await toTask([row], row.workspaceId))[0]!;

// The one way a task is made: requests (addTask), automations and process steps all come here, so every task is the
// same however it came. One of Emplio's own starts at once (when due). null: one with that repeatKey is there already.
export async function makeTask(values: typeof tasks.$inferInsert) {
  const [row] = await db.insert(tasks).values(values).onConflictDoNothing().returning();
  if (row && !row.assigneeId) void startDueTasks().catch((error) => console.error("starting tasks failed", error));
  return row ?? null;
}

export async function addTask(w: Who, input: TaskInput, conversationId?: string): Promise<Result> {
  const error = (await check(w, input)) ?? (input.title === undefined ? "a task needs a title" : null);
  if (error) return { ok: false, error };
  const status = input.status ?? "todo";
  const row = await makeTask({
      workspaceId: w.workspaceId,
      title: input.title!.trim(),
      notes: input.notes?.trim() || null,
      status,
      waitingOn: input.waitingOn?.trim() || null,
      assigneeId: input.assigneeId ?? null,
      agent: input.agent || null,
      requesterId: w.userId,
      dueAt: input.dueAt ? parseDue(input.dueAt, await timezoneOf(w.userId)) : null,
      conversationId: conversationId || null,
      clientId: input.clientId ?? null,
      doneAt: status === "done" ? new Date() : null,
  });
  const task = await one(row!);
  await labelChat(conversationId, task.clientId);
  record({ workspaceId: w.workspaceId, userId: w.userId, conversationId, kind: "task", summary: `Added task "${task.title}" for ${task.assigneeName}` });
  return { ok: true, task };
}

const find = (w: Who, id: string) =>
  db.query.tasks.findFirst({ where: and(eq(tasks.workspaceId, w.workspaceId), sql`${tasks.id}::text like ${`${id}%`}`) });

// The AI runs a task as whoever asked for it, with their apps and what they may see. So anyone else who writes what it
// should do, or hands it to the AI, becomes who asked: nobody gets to borrow someone's access by rewriting their task.
export function takesOver(w: Pick<Who, "userId">, t: Pick<Row, "assigneeId" | "requesterId">, input: TaskInput) {
  const forAI = input.agent ? true : (input.assigneeId === undefined ? t.assigneeId : input.assigneeId) === null;
  const steered = input.title !== undefined || input.notes !== undefined || input.assigneeId !== undefined || input.agent !== undefined;
  return forAI && steered && t.requesterId !== w.userId;
}

export async function updateTask(w: Who, id: string, input: TaskInput, conversationId?: string): Promise<Result> {
  const t = await find(w, id);
  if (!t || (!mayChange(w, t) && !(await manages(w, t.assigneeId)))) return { ok: false, error: `no task ${id}` };
  const error = await check(w, input);
  if (error) return { ok: false, error };
  const set: Partial<Row> = { updatedAt: new Date() };
  if (input.title !== undefined) set.title = input.title.trim();
  if (input.notes !== undefined) set.notes = input.notes?.trim() || null;
  if (input.waitingOn !== undefined) set.waitingOn = input.waitingOn?.trim() || null;
  if (input.clientId !== undefined) set.clientId = input.clientId;
  if (input.assigneeId !== undefined) set.assigneeId = input.assigneeId;
  // a person or an agent: picking one drops the other
  if (input.assigneeId) set.agent = null;
  if (input.agent !== undefined) set.agent = input.agent || null;
  if (input.agent) set.assigneeId = null;
  if (takesOver(w, t, input)) set.requesterId = w.userId;
  if (input.status !== undefined) {
    set.status = input.status;
    set.doneAt = input.status === "done" ? new Date() : null;
  }
  // a new due date or a new person starts the reminders over
  if (input.dueAt !== undefined || input.assigneeId !== undefined) Object.assign(set, { chasedAt: null, chases: 0, escalatedAt: null });
  if (input.dueAt !== undefined) set.dueAt = input.dueAt ? parseDue(input.dueAt, await timezoneOf(w.userId)) : null;
  const [row] = await db.update(tasks).set(set).where(eq(tasks.id, t.id)).returning();
  const task = await one(row!);
  const what = input.status === "done" ? "Finished" : input.status === "cancelled" ? "Cancelled" : "Changed";
  // a process's step done (or cancelled: skipped): its next step starts
  if ((input.status === "done" || input.status === "cancelled") && OPEN.includes(t.status) && row!.runId)
    await stepFinished(row!).catch((error) => console.error("moving the process on failed", t.id, error));
  record({ workspaceId: w.workspaceId, userId: w.userId, conversationId, kind: "task", summary: `${what} task "${task.title}"` });
  if (!task.assigneeId) void startDueTasks().catch((error) => console.error("starting tasks failed", error));
  return { ok: true, task };
}

export async function removeTask(w: Who, id: string, conversationId?: string) {
  const t = await find(w, id);
  if (!t || (!isAdmin(w) && !mayChange(w, t))) return { ok: false as const, error: `no task ${id}` };
  if (!isAdmin(w) && t.requesterId !== w.userId) return { ok: false as const, error: "only whoever asked for it or an admin can remove it; mark it cancelled instead" };
  await db.delete(tasks).where(eq(tasks.id, t.id));
  record({ workspaceId: w.workspaceId, userId: w.userId, conversationId, kind: "task", summary: `Removed task "${t.title}"` });
  return { ok: true as const };
}

// The AI's own tasks that are ready (to do, due by now or no due date): each claimed (to do → doing, so it
// starts once) and run in its own chat. Called every 30 s and whenever one is added or changed.
// ponytail: no cap on how many run at once; one per workspace at a time if they pile up
// A few due tasks at a time per business: a pile due at once (6 pm) would otherwise all start together, crowd its
// computer and fail. The rest start on later ticks as these finish, soonest due first.
// ponytail: counted in memory, so one server; a restart forgets runs cut off by it (they're left as doing anyway)
const AT_ONCE = 2;
const running = new Map<string, number>();
const busy = (workspaceId: string, by: number) => running.set(workspaceId, (running.get(workspaceId) ?? 0) + by);

export async function startDueTasks() {
  const ready = await db
    .select()
    .from(tasks)
    .where(and(isNull(tasks.assigneeId), eq(tasks.status, "todo"), or(isNull(tasks.dueAt), lte(tasks.dueAt, new Date()))))
    .orderBy(sql`${tasks.dueAt} asc nulls first`);
  for (const t of ready) {
    if ((running.get(t.workspaceId) ?? 0) >= AT_ONCE) continue;
    // stays to do, and starts once there's credit again
    if (await heldBack(t.workspaceId)) continue;
    const [claimed] = await db
      .update(tasks)
      .set({ status: "doing", chases: t.chases + 1, updatedAt: new Date() })
      .where(and(eq(tasks.id, t.id), eq(tasks.status, "todo"), isNull(tasks.assigneeId)))
      .returning();
    if (!claimed) continue;
    busy(t.workspaceId, 1);
    void work(claimed)
      .catch((error) => console.error("task run failed", t.id, error))
      .finally(() => busy(t.workspaceId, -1));
  }
}

// Reports of tasks that finish close together reach the person as one message, not one each.
// ponytail: held in memory; a restart in the wait drops them (each is still in its task's chat and in Tasks)
const QUIET_MS = 2 * 60_000;
const MAX_HOLD_MS = 10 * 60_000;
const held = new Map<string, { lines: string[]; first: number; timer?: ReturnType<typeof setTimeout> }>();
function report(workspaceId: string, userId: string, line: string) {
  const key = `${workspaceId}/${userId}`;
  const h = held.get(key) ?? { lines: [], first: Date.now() };
  clearTimeout(h.timer);
  h.lines.push(line);
  held.set(key, h);
  const send = () => {
    held.delete(key);
    const text = h.lines.length === 1 ? h.lines[0]! : [`${h.lines.length} tasks need a look:`, ...h.lines].join("\n\n");
    void post(workspaceId, userId, text).catch((e) => console.error("task report failed", e));
  };
  h.timer = setTimeout(send, Math.max(0, Math.min(QUIET_MS, h.first + MAX_HOLD_MS - Date.now())));
}

// "Start now" on one of the AI's tasks, whatever its due date.
export async function startTask(w: Who, id: string) {
  const t = await find(w, id);
  if (!t || !mayChange(w, t)) return { ok: false as const, error: `no task ${id}` };
  if (t.assigneeId) return { ok: false as const, error: "only the AI employee's own tasks can be started here" };
  const paused = await heldBack(w.workspaceId);
  if (paused) return { ok: false as const, error: paused };
  const [claimed] = await db
    .update(tasks)
    .set({ status: "doing", waitingOn: null, updatedAt: new Date() })
    .where(and(eq(tasks.id, t.id), isNull(tasks.assigneeId), inArray(tasks.status, ["todo", "waiting"])))
    .returning();
  if (!claimed) return { ok: false as const, error: "it's already being worked on or finished" };
  // they pressed Start: they want to hear how it went, whatever happens
  void work(claimed, true).catch((error) => console.error("task run failed", t.id, error));
  return { ok: true as const, task: await one(claimed) };
}

// The result reaches the person straight away only when it needs them (it's waiting on someone, or it failed) or
// they started it by hand (`asked`). Otherwise (done, or put off to try again) it's left for their morning brief
// and end-of-day report, which read the activity log: a pile of tasks no longer means a pile of messages.
async function work(t: Row, asked = false) {
  // as whoever asked (their apps, what they may see); the owner when nobody did
  let userId = t.requesterId;
  if (!userId || !(await personFor(t.workspaceId, userId))) {
    const [owner] = await db
      .select({ userId: workspaceMembers.userId })
      .from(workspaceMembers)
      .where(and(eq(workspaceMembers.workspaceId, t.workspaceId), eq(workspaceMembers.role, "owner")));
    userId = owner?.userId ?? null;
  }
  const person = userId && (await personFor(t.workspaceId, userId));
  if (!person) return;
  // the chat it came from, while it's still there and still theirs; not the background agent's (heartbeat.ts), which
  // stays its own, nor their main chat, which a long job would crowd: those get a chat of its own, and only the
  // result is posted back
  const w = await db.query.workspaces.findFirst({ where: eq(workspaces.id, t.workspaceId), columns: { heartbeatChatId: true } });
  const from =
    t.conversationId && t.conversationId !== w?.heartbeatChatId
      ? await db.query.conversations.findFirst({ where: and(eq(conversations.id, t.conversationId), eq(conversations.userId, person.userId)) })
      : null;
  const source = from?.kind === "main" ? null : from;
  const chatId = source?.id ?? crypto.randomUUID();
  if (!source) await db.insert(conversations).values({ id: chatId, workspaceId: t.workspaceId, userId: person.userId, title: `Task: ${t.title}`.slice(0, 80), kind: "background" });
  await db.update(tasks).set({ workConversationId: chatId }).where(eq(tasks.id, t.id));
  // they're mid-conversation there: generateReply waits for that reply (holdChat)
  // ponytail: waits in memory; a restart meanwhile leaves it doing (shown as such), like any task cut off by one
  const id = t.id.slice(0, 8);
  // its agent's own chat (the agent added it there): it does it itself, rather than hand it to a copy of itself
  const handTo =
    t.agent && !(source?.kind === "job" && (await db.query.jobs.findFirst({ where: eq(jobs.chatId, source.id), columns: { agent: true } }))?.agent === t.agent)
      ? (await one(t)).agentName
      : null;
  const text = [
    `${TASK_PREFIX}Task ${id} from the Tasks list, for you, asked by ${person.userName}: ${t.title}`,
    ...(t.dueAt ? [`Due: ${when(t.dueAt, await timezoneOf(person.userId))}`] : []),
    ...(t.chases > 1 ? [`This is run ${t.chases} of this task.`] : []),
    ...(t.notes ? ["", "How to do it:", t.notes] : []),
    ...(source ? ["", "You set it up earlier in this chat: what was said above is its background."] : []),
    ...(from && !source ? ["", `You set it up in your main chat with ${person.userName}; for what was said there: \`emplio history search <words> --chat ${from.id.slice(0, 8)}\`.`] : []),
    "",
    `First check it's still needed: ${person.userName} may have answered it or done it since (\`emplio history search <words>\`, recent messages first). If so, mark it done and say so in one line.`,
    ...(t.chases > 2 ? [`It has run ${t.chases - 1} times already: if nothing has changed, don't push it again; set it waiting on ${person.userName} instead of rescheduling.`] : []),
    handTo
      ? `Hand it to your ${handTo} agent now: \`emplio hand ${JSON.stringify(t.agent)}\`, with the task and how to do it as its brief. Wait for its report and check it, then update the task:`
      : "Do it now. Then update the task:",
    `- finished: \`emplio tasks done ${id}\``,
    `- needs a person (a decision, an OK, a reply): \`emplio tasks update ${id} --status waiting --waiting "<who and what>"\``,
    `- can't be done yet: \`emplio tasks update ${id} --status todo --due <when to try again>\` (it starts again then)`,
    `End with a line or two for ${person.userName}: what you did, the result, anything they must decide.`,
  ].join("\n");
  const message: UIMessage = { id: generateId(), role: "user", parts: [{ type: "text", text }] };
  const log = { error: (obj: unknown, msg: string) => console.error(`task ${id}: ${msg}`, obj) };
  let error: string | null = null;
  try {
    for await (const chunk of (await generateReply(person, chatId, message, log, TASK))!) if (chunk.type === "error") error = chunk.errorText;
    // the reply is saved when it lets go of the chat (holdChat)
    await quiet(chatId);
  } catch (e) {
    error = String(e);
  }

  // left as doing (it didn't say how it went, or it failed): waiting on the person, never retried in a loop
  const now = await db.query.tasks.findFirst({ where: eq(tasks.id, t.id) });
  if (now?.status === "doing")
    await db
      .update(tasks)
      .set({ status: "waiting", waitingOn: error ? "a fix: the AI hit an error" : `a look from ${person.userName}`, updatedAt: new Date() })
      .where(eq(tasks.id, t.id));
  const last = await lastWords(chatId);
  const note = error ? `I couldn't finish "${t.title}": something went wrong. It's waiting in Tasks.` : last && `"${t.title}": ${last}`;
  record({
    workspaceId: t.workspaceId,
    userId: person.userId,
    conversationId: chatId,
    kind: "task",
    summary: `Worked on task "${t.title}"${error ? `, failed: ${error}` : last ? `: ${last.replace(/\s+/g, " ").slice(0, 400)}` : ""}`,
  });
  const after = await db.query.tasks.findFirst({ where: eq(tasks.id, t.id), columns: { status: true } });
  const needsThem = !!error || after?.status === "waiting";
  // done in their main chat: it's there already, only their phone needs it; done elsewhere: posted to the main
  // chat with the way to where it was done, so it reads in context and an answer can follow it up there
  if (!note || !(needsThem || asked)) return;
  const inMain = chatId === (await mainChat(t.workspaceId, person.userId));
  if (inMain) return void (await post(t.workspaceId, person.userId, error ? note : last!, { inChat: true, from: chatId }).catch((e) => console.error("task report failed", t.id, e)));
  report(t.workspaceId, person.userId, `${note} [Open](${chatLink(chatId)})`);
}

export function startTasks() {
  setInterval(() => void startDueTasks().catch((error) => console.error("starting tasks failed", error)), 30_000);
}

// Reminders and escalations for people's tasks; called every minute, sent only in the receiver's own work hours
// (HOURS on their clock). Each send is claimed with a compare-and-set first, so a second server (or an
// overlapping tick) never sends it twice.
export async function chase() {
  const now = new Date();
  const zones = new Map<string, string>();
  const zone = async (userId: string) => zones.get(userId) ?? zones.set(userId, await timezoneOf(userId)).get(userId)!;
  const awake = async (userId: string) => {
    const hour = hourIn(await zone(userId));
    return hour >= HOURS.start && hour < HOURS.end;
  };
  const open = and(isNotNull(tasks.assigneeId), inArray(tasks.status, OPEN), isNotNull(tasks.dueAt));
  const remind = await db
    .select()
    .from(tasks)
    // once, when it comes due; after that their morning brief lists it as late every day, not a reminder of its own
    .where(and(open, lte(tasks.dueAt, now), isNull(tasks.chasedAt)));
  // one message per person with all their due tasks, not one each
  const toRemind = new Map<string, Row[]>();
  for (const t of remind) {
    if (!(await awake(t.assigneeId!))) continue;
    const [claimed] = await db
      .update(tasks)
      .set({ chasedAt: now, chases: t.chases + 1 })
      .where(and(eq(tasks.id, t.id), t.chasedAt ? eq(tasks.chasedAt, t.chasedAt) : isNull(tasks.chasedAt)))
      .returning({ id: tasks.id });
    if (claimed) toRemind.set(`${t.workspaceId}/${t.assigneeId}`, [...(toRemind.get(`${t.workspaceId}/${t.assigneeId}`) ?? []), t]);
  }
  for (const due of toRemind.values()) {
    const { workspaceId, assigneeId } = due[0]!;
    const tz = await zone(assigneeId!);
    const text =
      due.length === 1
        ? `Reminder: "${due[0]!.title}" was due ${when(due[0]!.dueAt!, tz)}. Is it done? Reply here and I'll update it.`
        : [`Reminder: ${due.length} tasks are due. Which are done? Reply here and I'll update them.`, ...due.map((t) => `- ${t.title} (due ${when(t.dueAt!, tz)})`)].join("\n");
    const sent = await sendTo(workspaceId, assigneeId!, text).catch((error) => (console.error("task reminder failed", assigneeId, error), null));
    for (const t of due) record({ workspaceId, userId: assigneeId, kind: "task", summary: `Reminded about "${t.title}"${sent ? ` on ${sent}` : " (no channel connected)"}` });
  }

  const late = await db
    .select()
    .from(tasks)
    .where(and(open, lte(tasks.dueAt, new Date(now.getTime() - 2 * DAY)), isNull(tasks.escalatedAt)));
  const toTell = new Map<string, string[]>();
  for (const t of late) {
    // who they report to; else whoever asked; else the owner when it was their own idea
    const lead = await db.query.workspaceMembers.findFirst({
      where: and(eq(workspaceMembers.workspaceId, t.workspaceId), eq(workspaceMembers.userId, t.assigneeId!)),
      columns: { reportsTo: true },
    });
    let to = lead?.reportsTo ?? (t.requesterId !== t.assigneeId ? t.requesterId : null);
    if (!to) {
      const [owner] = await db
        .select({ userId: workspaceMembers.userId })
        .from(workspaceMembers)
        .where(and(eq(workspaceMembers.workspaceId, t.workspaceId), eq(workspaceMembers.role, "owner")));
      to = owner && owner.userId !== t.assigneeId ? owner.userId : null;
    }
    // asleep: told once their day starts
    if (to && !(await awake(to))) continue;
    const [claimed] = await db
      .update(tasks)
      .set({ escalatedAt: now })
      .where(and(eq(tasks.id, t.id), isNull(tasks.escalatedAt)))
      .returning({ id: tasks.id });
    if (!claimed || !to) continue;
    const [task] = await toTask([t], t.workspaceId);
    const key = `${t.workspaceId}/${to}`;
    toTell.set(key, [...(toTell.get(key) ?? []), `${task!.assigneeName} hasn't finished "${t.title}", due ${when(t.dueAt!, await zone(to))} (reminded ${t.chases} time${t.chases === 1 ? "" : "s"})`]);
  }
  // one message per person told, however many tasks are late
  for (const [key, lines] of toTell) {
    const [workspaceId, to] = key.split("/") as [string, string];
    const text = lines.length === 1 ? `${lines[0]}.` : [`${lines.length} tasks are two days late:`, ...lines.map((l) => `- ${l}`)].join("\n");
    const sent = await sendTo(workspaceId, to, text).catch((error) => (console.error("task escalation failed", to, error), null));
    record({ workspaceId, userId: to, kind: "task", summary: `Told that ${lines.length} task${lines.length === 1 ? " is" : "s are"} two days late${sent ? ` on ${sent}` : " (no channel connected)"}` });
  }
}

// --- `emplio tasks` ---

const USAGE = `usage: emplio tasks list [--all] [--ai] [--who <name or email>] [--client <name>] [--due] [--done]
                                        open tasks, soonest due first (staff: theirs only; --all: everyone's,
                                        owner and admins; --ai: yours; --client: one client's, everyone's you
                                        may see; --due: due by now; --done: finished too)
       emplio tasks search <words>                tasks with every word in the title, notes or waiting-on, done ones too
       emplio tasks show <id>                     one task in full
       emplio tasks add <title> [options]         a new task, asked for by this chat's person
       emplio tasks update <id> [options]         change one
       emplio tasks done <id>                     mark it finished
       emplio tasks remove <id>                   delete it (wrongly added); otherwise --status cancelled
options: --to <email, name, me or ai>  who does it (default: ai)
         --due <YYYY-MM-DD[ HH:MM]>    when it's due, on this chat's person's clock (a date alone: 6 pm); "none" clears it
         --notes <text>                how to do it: steps, the skill to follow, links
         --status todo|doing|waiting|done|cancelled
         --waiting <text>              who or what it's waiting on (a client: their name)
         --client <name>               the client it's for (emplio clients list); "none" clears it
         --agent <name>                the agent of yours that does it (emplio agents list); "none": you
                                       do it yourself
         --actions a,b                 with --every: every app action its runs take that sends or changes something
                                       (gmail.send_email); the person allows them once on a card, and runs may do
                                       only those
         --every "<cron>"              repeats (add only; owner and admins): minute hour day month weekday, on this
                                       chat's person's clock, e.g. "0 9 * * 1" every Monday 9 am. Its title and
                                       --notes are what to do each time; with --to a person, it's a task for them
                                       each time (due --due-days later, default 1), else you do it. Repeating ones show in tasks list;
                                       change, pause or remove them with emplio automations. For "when something
                                       happens" (a new email), use emplio automations add.
         --clients all|<a,b>           with --every: the same job for each client (all: every active one): each
                                       time it comes round, one task per client, titled with the client and the
                                       period ("Monthly report · Northwind · Nov 2026"), for who handles them
                                       (or the AI with --agent), never twice for one client and period
         --due-days <n>                with --clients: each of those tasks is due n days after (default 7)`;

export const line = (t: Task, tz: string) =>
  [
    t.id.slice(0, 8),
    t.status,
    t.dueAt ? when(new Date(t.dueAt), tz) : "no due date",
    t.assigneeName,
    (t.clientName ? `${t.clientName}: ` : "") + t.title + (t.waitingOn ? ` (waiting on ${t.waitingOn})` : "") + (t.requesterName ? ` [asked by ${t.requesterName}]` : ""),
  ].join("\t");

// A repeating task is an automation underneath (automations.ts): `repeat` saves one, as this chat's person.
// asked by code (the Python library): a task as data
const asData = (t: Task) => ({ id: t.id.slice(0, 8), title: t.title, status: t.status, due: t.dueAt ? new Date(t.dueAt).toISOString() : null, assignee: t.assigneeName, agent: t.agentName, waiting_on: t.waitingOn ?? null, asked_by: t.requesterName ?? null, client: t.clientName ?? null });

export async function tasksCommand(w: Who, conversationId: string, args: string[], repeat?: (name: string, file: string) => Promise<string>, data = false) {
  const [sub, ...rest] = args;
  const tz = await timezoneOf(w.userId);
  const words: string[] = [];
  const opts: Record<string, string> = {};
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    // list's options are on/off but --who; the others take a value (add's --due is a date)
    if (a.startsWith("--")) opts[a.slice(2)] = sub === "list" && a !== "--who" && a !== "--client" ? "" : (rest[++i] ?? "");
    else words.push(a);
  }
  const team = await listTeam(w.workspaceId);
  // undefined: not given; null: the AI; a string starting "error:" when it can't be told who
  const person = (s: string | undefined): string | null | undefined => {
    if (s === undefined) return undefined;
    const q = s.trim().toLowerCase();
    if (q === "ai") return null;
    if (q === "me") return w.userId;
    const hits = team.filter((m) => m.email === q || m.name?.toLowerCase() === q);
    const loose = hits.length ? hits : team.filter((m) => m.name?.toLowerCase().includes(q) || m.email.includes(q));
    if (loose.length === 1) return loose[0]!.id;
    return `error: ${loose.length ? `"${s}" matches ${loose.map((m) => m.name ?? m.email).join(", ")}; use their email` : `nobody on the team matches "${s}" (emplio team list)`}`;
  };
  // the client named in --client: its id, null for "none", undefined when not given, or "error: ..."
  const client = async (): Promise<string | null | undefined> => {
    if (opts.client === undefined) return undefined;
    if (opts.client.trim().toLowerCase() === "none") return null;
    const c = await findClient(w.workspaceId, opts.client);
    return typeof c === "string" ? `error: ${c}` : c.id;
  };
  const input = async (): Promise<TaskInput | string> => {
    const to = person(opts.to);
    if (typeof to === "string" && to.startsWith("error:")) return to;
    const c = await client();
    if (c?.startsWith("error:")) return c;
    const i: TaskInput = {};
    if (c !== undefined) i.clientId = c;
    if (to !== undefined) i.assigneeId = to;
    if (opts.due !== undefined) i.dueAt = opts.due === "none" ? null : opts.due;
    if (opts.notes !== undefined) i.notes = opts.notes;
    if (opts.status !== undefined) i.status = opts.status as TaskStatus;
    if (opts.waiting !== undefined) i.waitingOn = opts.waiting;
    if (opts.title !== undefined) i.title = opts.title;
    if (opts.agent !== undefined) i.agent = opts.agent === "none" ? null : opts.agent;
    return i;
  };
  const show = (t: Task) =>
    [
      line(t, tz),
      ...(t.notes ? ["", t.notes] : []),
      ...(t.chases ? [`reminded ${t.chases} time${t.chases === 1 ? "" : "s"}`] : []),
      ...(t.conversationId ? [`from chat ${t.conversationId.slice(0, 8)}`] : []),
    ].join("\n");

  if (sub === "list") {
    const who = person(opts.who);
    if (typeof who === "string" && who.startsWith("error:")) return who;
    const c = await client();
    if (c?.startsWith("error:")) return c;
    const list = await listTasks(w, {
      assignee: "ai" in opts ? null : (who ?? undefined),
      open: !("done" in opts),
      due: "due" in opts,
      mine: !("all" in opts) && !("ai" in opts) && who === undefined && !c,
      client: c ?? undefined,
    });
    // the repeating and event ones too, so the work list is one list (not when filtered to done, due or someone's: a
    // run once couldn't find the reminder it had just set up with --all, and set it up twice more)
    const plain = !["done", "due", "who"].some((k) => k in opts);
    const repeating = plain ? (await listAutomations(w.workspaceId).catch(() => [])).filter((a) => a.enabled && !a.error && a.when !== "manual") : [];
    if (data) return JSON.stringify([...list.map(asData), ...repeating.map((a) => ({ repeats: a.when === "schedule" ? a.schedule : a.when === "new client" ? "for each new client" : `on ${a.trigger}`, agent: a.agent ?? null, who: a.who, process: a.process, name: a.name }))]);
    const rep = repeating.map((a) => `repeats\t${a.when === "schedule" ? `"${a.schedule}"` : a.when === "new client" ? "for each new client" : `on ${a.trigger}`}\t${a.process ? `process ${a.process}` : (a.agent ?? a.who ?? "you")}\t${a.name}${a.clients ? ` (for ${a.clients.includes("*") ? "every active client" : a.clients.join(", ")})` : ""}`);
    if (!list.length && !rep.length) return "No tasks match.";
    return [...list.map((t) => line(t, tz)), ...rep, "", "In full: emplio tasks show <id>; repeating ones: emplio automations show <name>."].join("\n");
  }
  if (sub === "search" && words.length) {
    const terms = words.map((x) => x.toLowerCase());
    const list = (await listTasks(w, { old: true })).filter((t) => terms.every((x) => [t.title, t.notes, t.waitingOn].join(" ").toLowerCase().includes(x)));
    if (data) return JSON.stringify(list.map(asData));
    if (!list.length) return "No tasks match.";
    const more = list.length - 30;
    return [...list.slice(0, 30).map((t) => line(t, tz)), "", ...(more > 0 ? [`${more} more not shown: add words.`] : []), "In full: emplio tasks show <id>."].join("\n");
  }
  if (sub === "show" && words[0]) {
    const t = (await listTasks(w, { old: true })).find((x) => x.id.startsWith(words[0]!));
    return t ? show(t) : `error: no task ${words[0]}`;
  }
  if (sub === "add" && words.length && opts.every !== undefined) {
    if (!repeat || w.role === "member") return "error: only the owner or an admin can set up repeating tasks";
    // a person each time it comes round (a task for them); none or ai: Emplio does it
    const to = person(opts.to);
    if (typeof to === "string" && to.startsWith("error:")) return to;
    const who = to ? team.find((m) => m.id === to)!.email : null;
    const title = words.join(" ");
    const name = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "task";
    const file = [
      "---",
      "when: schedule",
      `schedule: ${JSON.stringify(opts.every)}`,
      ...(opts.agent ? [`agent: ${JSON.stringify(opts.agent)}`] : []),
      ...(who ? [`who: ${JSON.stringify(who)}`] : []),
      ...(opts.clients ? [`clients: ${opts.clients.trim().toLowerCase() === "all" ? "all" : JSON.stringify(opts.clients.split(",").map((c) => c.trim()).filter(Boolean))}`] : []),
      ...(opts["due-days"] ? [`due: ${Number.parseInt(opts["due-days"], 10) || 7}`] : []),
      ...(opts.actions ? [`actions: [${opts.actions.split(",").map((a) => a.trim()).filter(Boolean).join(", ")}]`] : []),
      "enabled: true",
      "---",
      title,
      ...(opts.notes ? ["", opts.notes] : []),
    ].join("\n");
    return await repeat(name, file);
  }
  if (sub === "add" && words.length) {
    const i = await input();
    if (typeof i === "string") return i;
    const r = await addTask(w, { assigneeId: null, ...i, title: words.join(" ") }, conversationId);
    return r.ok ? `added ${show(r.task)}` : `error: ${r.error}`;
  }
  if (sub === "update" && words[0]) {
    const i = await input();
    if (typeof i === "string") return i;
    if (!Object.keys(i).length) return USAGE;
    const r = await updateTask(w, words[0], i, conversationId);
    return r.ok ? `updated ${show(r.task)}` : `error: ${r.error}`;
  }
  if (sub === "done" && words[0]) {
    const r = await updateTask(w, words[0], { status: "done" }, conversationId);
    return r.ok ? `done: ${r.task.title}` : `error: ${r.error}`;
  }
  if (sub === "remove" && words[0]) {
    const r = await removeTask(w, words[0], conversationId);
    return r.ok ? "removed" : `error: ${r.error}`;
  }
  return USAGE;
}

const BODY = {
  type: "object",
  properties: {
    title: { type: "string", maxLength: 300 },
    notes: { type: ["string", "null"], maxLength: 10_000 },
    status: { type: "string", enum: [...TASK_STATUSES] },
    waitingOn: { type: ["string", "null"], maxLength: 300 },
    assigneeId: { type: ["string", "null"], format: "uuid" },
    agent: { type: ["string", "null"], maxLength: 100 },
    dueAt: { type: ["string", "null"], maxLength: 40 },
    clientId: { type: ["string", "null"], format: "uuid" },
  },
};

export async function taskRoutes(app: FastifyInstance) {
  app.get("/tasks", async (req, reply) => {
    const ctx = await context(req, reply);
    if (!ctx) return;
    return listTasks(ctx, {});
  });

  app.post<{ Body: TaskInput }>("/tasks", { schema: { body: { ...BODY, required: ["title"] } } }, async (req, reply) => {
    const ctx = await context(req, reply);
    if (!ctx) return;
    const r = await addTask(ctx, req.body);
    return r.ok ? r.task : reply.code(400).send({ error: r.error });
  });

  app.patch<{ Params: { id: string }; Body: TaskInput }>("/tasks/:id", { schema: { body: BODY } }, async (req, reply) => {
    const ctx = await context(req, reply);
    if (!ctx) return;
    const r = await updateTask(ctx, req.params.id, req.body);
    return r.ok ? r.task : reply.code(400).send({ error: r.error });
  });

  app.post<{ Params: { id: string } }>("/tasks/:id/start", async (req, reply) => {
    const ctx = await context(req, reply);
    if (!ctx) return;
    const r = await startTask(ctx, req.params.id);
    return r.ok ? r.task : reply.code(400).send({ error: r.error });
  });

  app.delete<{ Params: { id: string } }>("/tasks/:id", async (req, reply) => {
    const ctx = await context(req, reply);
    if (!ctx) return;
    const r = await removeTask(ctx, req.params.id);
    return r.ok ? r : reply.code(400).send({ error: r.error });
  });
}

if (import.meta.main) {
  console.assert(parseDue("2026-10-25")!.toISOString() === "2026-10-25T12:30:00.000Z");
  console.assert(parseDue("2026-10-25 09:15")!.toISOString() === "2026-10-25T03:45:00.000Z");
  console.assert(parseDue("next week") === null);
  console.log("ok");
}
