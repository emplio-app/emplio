// Processes: work done the same way every time, as steps in order (onboarding a client, a yearly filing, hiring for a
// role). Each is a file in the company repo, processes/<name>.md: settings and its steps between --- lines, then how
// it's done in words. Emplio writes them (from a chat, or when it sees the same steps done again and again); owners
// change them later. A go of one (a run, process_runs) is for one client, or for anything else with a name (a
// candidate, an opening) or for a record (records.ts: an invoice, a project), and keeps the steps it started with. Each step is a task, made when the one before it is
// done: for whoever looks after the client, the owner, a named person, Emplio or one of its agents, or "client" (a
// task waiting on them, with the handler). An OK step can be sent back to an earlier one.
// Started by hand (`emplio processes start`, the app), for each client won ("starts: new client"), or on a schedule
// for each client ("every:" with "clients:", as an automation that starts one per client and period).
// The files are the truth; syncProcesses keeps one row per file in the processes table (like automations), and keeps
// each scheduled one's automation in step with its file, however the file was changed.
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { Process, ProcessRun, ProcessStep, Role } from "@emplio/shared";
import { record } from "./activity";
import { context, type Ctx } from "./auth";
import { db } from "./db";
import { clients, processes, processRuns, records, tasks, workspaceMembers, type ProcessStepDef } from "./db/schema";
import { addRecord, findRecord, KIND, RecordError } from "./records";
import { findAgent } from "./agents";
import { findClient } from "./clients";
import { lastAuthor, listFolder, readFile, writeFile } from "./gitea";
import { listTeam } from "./team";
import { DEFAULT_ZONE } from "./time";

type Who = { workspaceId: string; userId: string; role: Role };
type Run = typeof processRuns.$inferSelect;

const REPO = "company";
const FOLDER = "processes";
const NAME = /^[a-z0-9][a-z0-9-]{0,50}$/;
const DAY = 86_400_000;
const isAdmin = (w: Pick<Who, "role">) => w.role !== "member";
// the automation that starts a process on its schedule
export const autoName = (name: string) => `process-${name}`;

export class ProcessError extends Error {}

const pathOf = (name: string) => {
  if (!NAME.test(name)) throw new ProcessError("a process name is lowercase letters, digits and dashes, like client-onboarding");
  return `${FOLDER}/${name}.md`;
};

// --- the file ---

type Parsed = Omit<Process, "name" | "error" | "active">;

// Its settings and steps, or what's wrong with it. Steps refer to each other by number (1 = the first) or by name.
export function parseProcess(text: string): Parsed | { error: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)([\s\S]*)$/.exec(text);
  if (!m) return { error: "the file must start with settings and steps between --- lines, then how it's done" };
  let s: Record<string, unknown>;
  try {
    s = (Bun.YAML.parse(m[1]!) ?? {}) as Record<string, unknown>;
  } catch (error) {
    return { error: `the settings aren't valid YAML: ${(error as Error).message}` };
  }
  if (typeof s !== "object" || Array.isArray(s)) return { error: "the settings must be key: value lines" };
  const title = typeof s.title === "string" && s.title.trim() ? s.title.trim() : null;
  if (!title) return { error: 'title: is missing (like "Annual filing")' };
  const forWhat = typeof s.for === "string" ? s.for.trim().toLowerCase() : s.for === undefined ? "client" : "";
  if (forWhat !== "client" && forWhat !== "other" && !KIND.test(forWhat))
    return { error: "for: is client (each go is for a client), a kind of record (invoice, candidate, project: one word, singular), or other (just a name)" };
  const every = s.every ?? null;
  if (every !== null && typeof every !== "string") return { error: 'every: is a schedule, like "0 9 1 4 *" (9 am on 1 April)' };
  const starts = every ? "schedule" : (s.starts ?? "manual");
  if (starts !== "manual" && starts !== "new client" && starts !== "schedule") return { error: "starts: is manual or new client (or give every: for a schedule)" };
  if (starts === "schedule" && !every) return { error: "starts: schedule needs every:" };
  if (forWhat !== "client" && starts !== "manual") return { error: "a process for other things (not clients) is started by hand" };
  const rawClients = s.clients ?? (every ? "all" : null);
  const clientsList = rawClients === null ? null : rawClients === "all" ? ["*"] : rawClients;
  if (clientsList !== null && (!Array.isArray(clientsList) || !clientsList.length || clientsList.some((c) => typeof c !== "string" || !c.trim())))
    return { error: "clients: is all, or a list like [Northwind Traders, Contoso]" };
  if (!Array.isArray(s.steps) || !s.steps.length) return { error: "steps: is missing: a list of steps, each with a name: and who:" };
  if (s.steps.length > 40) return { error: "at most 40 steps" };
  const raw = s.steps as unknown[];
  const names = raw.map((x) => (typeof x === "string" ? x : typeof (x as { name?: unknown })?.name === "string" ? ((x as { name: string }).name) : "").trim());
  // a step it refers to: by number (1-based) or name, before this one
  const ref = (v: unknown, i: number, key: string): number | "start" | { error: string } => {
    if (v === "start") return "start";
    const n = typeof v === "number" ? v : typeof v === "string" ? names.findIndex((x) => x.toLowerCase() === v.trim().toLowerCase()) + 1 : 0;
    if (!Number.isInteger(n) || n < 1 || n > i) return { error: `step ${i + 1}: ${key}: must be an earlier step, by number or name` };
    return n;
  };
  const steps: ProcessStep[] = [];
  for (const [i, x] of raw.entries()) {
    const o = (typeof x === "string" ? { name: x } : x) as Record<string, unknown>;
    if (!names[i]) return { error: `step ${i + 1} needs a name:` };
    const step: ProcessStep = { name: names[i]!, who: typeof o.who === "string" && o.who.trim() ? o.who.trim() : forWhat === "client" ? "handler" : "owner" };
    // a record may have a client (an invoice does): handler and client work for those, falling back to whoever started it
    if (forWhat === "other" && ["handler", "client"].includes(step.who.toLowerCase())) return { error: `step ${i + 1}: who: ${step.who} only goes with a process for clients or records` };
    if (typeof o.how === "string" && o.how.trim()) step.how = o.how.trim();
    if (o.days !== undefined) {
      if (!Number.isInteger(o.days) || (o.days as number) < 0 || (o.days as number) > 400) return { error: `step ${i + 1}: days: is a number of days, like 7` };
      step.days = o.days as number;
    }
    if (o.after !== undefined) {
      if (step.days === undefined) return { error: `step ${i + 1}: after: goes with days: (days after that step)` };
      const r = ref(o.after, i, "after");
      if (typeof r === "object") return r;
      step.after = r;
    }
    if (o.back !== undefined) {
      const r = ref(o.back, i, "back");
      if (typeof r === "object") return r;
      if (r === "start") return { error: `step ${i + 1}: back: is an earlier step` };
      step.back = r;
    }
    steps.push(step);
  }
  return { title, for: forWhat, starts, every, clients: clientsList as string[] | null, steps, about: m[2]!.trim() };
}

type ProcessRow = typeof processes.$inferSelect;

// Make the rows match the files in git: new and changed files read again, removed ones dropped. A schedule that
// changed (or a process removed) has its automation rewritten, as whoever last saved the file.
const syncing = new Map<string, Promise<unknown>>();
export function syncProcesses(workspaceId: string): Promise<void> {
  const run = (syncing.get(workspaceId) ?? Promise.resolve()).then(async () => {
    const files = (await listFolder(workspaceId, REPO, FOLDER).catch(() => [])).filter((f) => f.name.endsWith(".md") && NAME.test(f.name.slice(0, -3)));
    const rows = await db.select().from(processes).where(eq(processes.workspaceId, workspaceId));
    for (const row of rows)
      if (!files.some((f) => f.name === `${row.name}.md`)) {
        await db.delete(processes).where(eq(processes.id, row.id));
        if (row.every) await scheduleAs(workspaceId, null, row.name, null);
      }
    for (const f of files) {
      const name = f.name.slice(0, -3);
      const old = rows.find((r) => r.name === name);
      if (old?.sha === f.sha) continue;
      const text = (await readFile(workspaceId, REPO, `${FOLDER}/${f.name}`)) ?? "";
      const parsed = parseProcess(text);
      const values =
        "error" in parsed
          ? { workspaceId, name, sha: f.sha, title: name, for: "client", starts: "manual" as const, every: null, clients: null, steps: [], about: "", error: parsed.error, updatedAt: new Date() }
          : { workspaceId, name, sha: f.sha, ...parsed, steps: parsed.steps as ProcessStepDef[], error: null, updatedAt: new Date() };
      await db.insert(processes).values(values).onConflictDoUpdate({ target: [processes.workspaceId, processes.name], set: values });
      const sameSchedule = (old?.every ?? null) === values.every && JSON.stringify(old?.clients ?? null) === JSON.stringify(values.clients) && old?.title === values.title;
      if (!sameSchedule) {
        const author = await lastAuthor(workspaceId, REPO, `${FOLDER}/${f.name}`).catch(() => null);
        await scheduleAs(workspaceId, author?.email ?? null, name, "error" in parsed ? null : parsed);
      }
    }
  });
  syncing.set(workspaceId, run.catch(() => {}));
  return run;
}

const toProcess = (r: ProcessRow, active: number): Process => ({
  name: r.name,
  title: r.title,
  for: r.for,
  starts: r.starts,
  every: r.every,
  clients: r.clients,
  steps: r.steps,
  about: r.about,
  error: r.error,
  active,
});

export async function listProcesses(workspaceId: string): Promise<Process[]> {
  await syncProcesses(workspaceId);
  const [rows, counts] = await Promise.all([
    db.select().from(processes).where(eq(processes.workspaceId, workspaceId)).orderBy(processes.title),
    db
      .select({ process: processRuns.process, n: sql<number>`count(*)`.mapWith(Number) })
      .from(processRuns)
      .where(and(eq(processRuns.workspaceId, workspaceId), eq(processRuns.status, "active")))
      .groupBy(processRuns.process),
  ]);
  const n = new Map(counts.map((c) => [c.process, c.n]));
  return rows.map((r) => toProcess(r, n.get(r.name) ?? 0));
}

async function getProcess(workspaceId: string, name: string) {
  pathOf(name);
  await syncProcesses(workspaceId);
  const row = await db.query.processes.findFirst({ where: and(eq(processes.workspaceId, workspaceId), eq(processes.name, name)) });
  if (!row) throw new ProcessError(`no process ${name} (emplio processes list)`);
  if (row.error) throw new ProcessError(`${name} can't run: ${row.error}`);
  return toProcess(row, 0);
}

// Saved by the owner or an admin; one with every: gets its automation (company/automations/process-<name>.md) made,
// changed or dropped with it.
export async function saveProcess(who: Ctx, name: string, text: string, mode: "add" | "update") {
  if (!isAdmin(who)) throw new ProcessError("only the owner or an admin can change processes");
  const path = pathOf(name);
  const exists = (await readFile(who.workspaceId, REPO, path)) !== null;
  if (mode === "add" && exists) throw new ProcessError(`${name} already exists; change it with update`);
  if (mode === "update" && !exists) throw new ProcessError(`no process ${name}; create it with add`);
  const p = parseProcess(text);
  if ("error" in p) throw new ProcessError(p.error);
  await checkWho(who.workspaceId, p.steps);
  const author = { name: who.userName, email: who.userEmail };
  await writeFile(who.workspaceId, REPO, path, text.endsWith("\n") ? text : `${text}\n`, `${exists ? "Edited" : "Added"} process ${name}\n\nBy ${who.userName}`, author);
  await syncProcesses(who.workspaceId);
  return p;
}

export async function removeProcess(who: Ctx, name: string) {
  if (!isAdmin(who)) throw new ProcessError("only the owner or an admin can change processes");
  const author = { name: who.userName, email: who.userEmail };
  if (!(await writeFile(who.workspaceId, REPO, pathOf(name), null, `Removed process ${name}\n\nBy ${who.userName}`, author))) throw new ProcessError(`no process ${name}`);
  await syncProcesses(who.workspaceId);
}

// The schedule's automation, saved as the file's last author when they're an owner or admin, else as the owner.
async function scheduleAs(workspaceId: string, email: string | null, name: string, p: Parsed | null) {
  const { personFor } = await import("./automations");
  const team = await db
    .select({ id: workspaceMembers.userId, role: workspaceMembers.role })
    .from(workspaceMembers)
    .where(eq(workspaceMembers.workspaceId, workspaceId));
  const people = await listTeam(workspaceId);
  const authorId = email ? people.find((m) => m.email.toLowerCase() === email.toLowerCase())?.id : undefined;
  const pick = team.find((m) => m.id === authorId && m.role !== "member") ?? team.find((m) => m.role === "owner");
  const who = pick && (await personFor(workspaceId, pick.id));
  if (!who) return console.error("no one to save a process's schedule as", workspaceId, name);
  await schedule(who, name, p).catch((error) => console.error("scheduling a process failed", name, error));
}

async function schedule(who: Ctx, name: string, p: Parsed | null) {
  const { readAutomation, removeAutomation, saveAutomation } = await import("./automations");
  const auto = autoName(name);
  const had = await readAutomation(who.workspaceId, auto).then(() => true, () => false);
  if (p?.every) {
    const list = p.clients!.includes("*") ? "all" : JSON.stringify(p.clients);
    const text = ["---", "when: schedule", `schedule: ${JSON.stringify(p.every)}`, `clients: ${list}`, `process: ${name}`, "---", `Start "${p.title}" for each client (company/processes/${name}.md).`, ""].join("\n");
    await saveAutomation(who, auto, text, "put");
  } else if (had) await removeAutomation(who, auto);
}

// Every who: must be someone: a role word, a person on the team, or one of Emplio's agents.
async function checkWho(workspaceId: string, steps: ProcessStep[]) {
  const team = await listTeam(workspaceId);
  for (const [i, s] of steps.entries()) {
    if (ROLES.includes(s.who.toLowerCase())) continue;
    if (person(team, s.who)) continue;
    if (await findAgent(workspaceId, s.who, { admin: true })) continue;
    throw new ProcessError(`step ${i + 1}: who: ${s.who} isn't someone on the team or an agent; use handler, owner, emplio, client, a person's name or email, or an agent's name`);
  }
}
const ROLES = ["handler", "owner", "emplio", "client"];
const person = (team: { id: string; name: string | null; email: string }[], q: string) => {
  const s = q.trim().toLowerCase();
  return team.find((m) => m.email.toLowerCase() === s || m.name?.toLowerCase() === s) ?? team.find((m) => m.name?.toLowerCase().split(/\s+/)[0] === s);
};

// --- runs ---

// Start one: for a client (subject is their name) or for anything else named by subject. A repeatKey already used
// starts nothing (null).
export async function startRun(
  w: { workspaceId: string; userId: string },
  name: string,
  o: { clientId?: string | null; recordId?: string | null; subject?: string; period?: string | null; repeatKey?: string },
): Promise<Run | null> {
  const p = await getProcess(w.workspaceId, name);
  let subject = o.subject?.trim() ?? "";
  let clientId: string | null = null;
  let recordId: string | null = null;
  if (p.for !== "client" && p.for !== "other") {
    // for a record: the one named, else the one with that title, else a new one
    let rec;
    try {
      rec = o.recordId ? await findRecord(w.workspaceId, o.recordId, p.for) : subject ? await findRecord(w.workspaceId, subject, p.for).catch(() => null) : null;
      if (!rec && subject) rec = await addRecord({ ...w, role: "owner" }, { kind: p.for, title: subject, clientId: o.clientId ?? null });
    } catch (error) {
      if (error instanceof RecordError) throw new ProcessError(error.message);
      throw error;
    }
    if (!rec) throw new ProcessError(`say which ${p.for} this "${p.title}" is for (--for "<its title>", made if it isn't there yet)`);
    subject = rec.title;
    recordId = rec.id;
    clientId = rec.clientId;
  } else if (p.for === "client") {
    if (!o.clientId) throw new ProcessError(`"${p.title}" is done for a client: say which (--client <name>)`);
    const c = await db.query.clients.findFirst({ where: and(eq(clients.workspaceId, w.workspaceId), eq(clients.id, o.clientId)) });
    if (!c) throw new ProcessError("no such client (emplio clients list)");
    subject = c.name;
    clientId = c.id;
  } else if (!subject) throw new ProcessError(`say who or what this "${p.title}" is for (--for "Sarah Lee, React developer")`);
  const [run] = await db
    .insert(processRuns)
    .values({
      workspaceId: w.workspaceId,
      process: name,
      processTitle: p.title,
      subject: subject.slice(0, 200),
      clientId,
      recordId,
      period: o.period ?? null,
      steps: p.steps as ProcessStepDef[],
      finished: p.steps.map(() => null),
      startedBy: w.userId,
      repeatKey: o.repeatKey ?? null,
    })
    .onConflictDoNothing()
    .returning();
  if (!run) return null;
  record({ workspaceId: w.workspaceId, userId: w.userId, kind: "process", summary: `Started "${p.title}" for ${subject}${o.period ? ` (${o.period})` : ""}` });
  await makeStep(run, 0);
  return run;
}

// The task for step i of a run: who does it, when it's due, and what it's part of.
async function makeStep(run: Run, i: number, note?: string) {
  const step = run.steps[i]!;
  const who = step.who.toLowerCase();
  const client = run.clientId ? await db.query.clients.findFirst({ where: eq(clients.id, run.clientId) }) : null;
  const fallback = run.startedBy;
  let assigneeId: string | null = null;
  let agent: string | null = null;
  let missing = "";
  if (who === "handler" || who === "client") assigneeId = client?.handlerIds[0] ?? fallback;
  else if (who === "owner") {
    const [o] = await db.select({ id: workspaceMembers.userId }).from(workspaceMembers).where(and(eq(workspaceMembers.workspaceId, run.workspaceId), eq(workspaceMembers.role, "owner")));
    assigneeId = o?.id ?? fallback;
  } else if (who !== "emplio") {
    const m = person(await listTeam(run.workspaceId), step.who);
    const a = m ? null : await findAgent(run.workspaceId, step.who, { admin: true });
    if (m) assigneeId = m.id;
    else if (a) agent = a.slug;
    else {
      assigneeId = fallback;
      missing = `(The process says ${step.who} does this, but nobody by that name is on the team now.)`;
    }
  }
  const from = step.after === "start" ? run.startedAt.getTime() : step.after ? Date.parse(run.finished[step.after - 1] ?? "") || Date.now() : Date.now();
  const dueAt = step.days === undefined ? null : endOfDay(new Date(from + step.days * DAY));
  const waiting = who === "client";
  // a client's name shows beside the task anyway; anything else goes in the title
  const label = run.clientId && !run.recordId ? "" : ` · ${run.subject}`;
  const notes = [
    step.how,
    note && `Sent back: ${note}`,
    missing,
    `Step ${i + 1} of ${run.steps.length} of "${run.processTitle}" for ${run.subject}${run.period ? ` (${run.period})` : ""}; how this process goes: company/processes/${run.process}.md.`,
    step.back ? `An OK step: if it isn't right, send it back to step ${step.back} (emplio processes back ${run.id.slice(0, 8)} --note "<what to fix>").` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
  const [t] = await db
    .insert(tasks)
    .values({
      workspaceId: run.workspaceId,
      title: `${step.name}${label}${run.period ? ` · ${run.period}` : ""}`.slice(0, 300),
      notes,
      status: waiting ? "waiting" : "todo",
      waitingOn: waiting ? `${run.subject}: ${step.name}` : null,
      assigneeId,
      agent,
      requesterId: run.startedBy,
      clientId: run.clientId,
      dueAt,
      runId: run.id,
      stepIndex: i,
    })
    .returning();
  if (!assigneeId) {
    const { startDueTasks } = await import("./tasks");
    void startDueTasks().catch((error) => console.error("starting tasks failed", error));
  }
  return t!;
}

// 6 pm that day, the business's time
function endOfDay(d: Date) {
  const day = d.toLocaleDateString("en-CA", { timeZone: DEFAULT_ZONE });
  return new Date(`${day}T18:00:00+05:30`);
}

// A step's task finished (done, or cancelled: skipped): the next step's task, or the run is done. Called by tasks.ts.
export async function stepFinished(task: { runId: string | null; stepIndex: number | null }) {
  if (!task.runId || task.stepIndex === null) return;
  const run = await db.query.processRuns.findFirst({ where: eq(processRuns.id, task.runId) });
  if (!run || run.status !== "active" || run.step !== task.stepIndex) return;
  const i = task.stepIndex;
  const finished = [...run.finished];
  finished[i] = new Date().toISOString();
  const last = i + 1 >= run.steps.length;
  // claimed: two finishes at once move it on once
  const [moved] = await db
    .update(processRuns)
    .set({ step: i + 1, finished, ...(last && { status: "done" as const, doneAt: new Date() }) })
    .where(and(eq(processRuns.id, run.id), eq(processRuns.step, i), eq(processRuns.status, "active")))
    .returning();
  if (!moved) return;
  if (last) record({ workspaceId: run.workspaceId, userId: run.startedBy, kind: "process", summary: `Finished "${run.processTitle}" for ${run.subject}` });
  else await makeStep(moved, i + 1);
}

const findRun = async (workspaceId: string, id: string) => {
  const run = await db.query.processRuns.findFirst({ where: and(eq(processRuns.workspaceId, workspaceId), sql`${processRuns.id}::text like ${`${id.trim()}%`}`) });
  if (!id.trim() || !run) throw new ProcessError(`no process run ${id} (emplio processes runs)`);
  return run;
};
const currentTask = (run: Run) =>
  db.query.tasks.findFirst({ where: and(eq(tasks.runId, run.id), eq(tasks.stepIndex, run.step), inArray(tasks.status, ["todo", "doing", "waiting"])) });

// An OK step not OK: its task is cancelled and the step it names starts again, with what to fix.
export async function sendBack(w: Who, id: string, note: string) {
  const run = await findRun(w.workspaceId, id);
  const step = run.steps[run.step];
  if (run.status !== "active" || !step) throw new ProcessError("it isn't running");
  if (!step.back) throw new ProcessError(`step ${run.step + 1} (${step.name}) can't be sent back; only an OK step (back: in the process) can`);
  const t = await currentTask(run);
  if (!isAdmin(w) && t?.assigneeId !== w.userId) throw new ProcessError("only whoever does this step, the owner or an admin can send it back");
  const to = step.back - 1;
  const finished = run.finished.map((f, k) => (k >= to ? null : f));
  const [moved] = await db.update(processRuns).set({ step: to, finished }).where(and(eq(processRuns.id, run.id), eq(processRuns.step, run.step))).returning();
  if (!moved) throw new ProcessError("it moved on meanwhile; try again");
  if (t) await db.update(tasks).set({ status: "cancelled", updatedAt: new Date() }).where(eq(tasks.id, t.id));
  record({ workspaceId: w.workspaceId, userId: w.userId, kind: "process", summary: `Sent "${run.processTitle}" for ${run.subject} back to "${run.steps[to]!.name}"${note ? `: ${note}` : ""}` });
  await makeStep(moved, to, note || "see the earlier step's work and the chat");
  return moved;
}

export async function stopRun(w: Who, id: string) {
  const run = await findRun(w.workspaceId, id);
  if (!isAdmin(w) && run.startedBy !== w.userId) throw new ProcessError("only whoever started it, the owner or an admin can stop it");
  if (run.status !== "active") throw new ProcessError(`it's ${run.status} already`);
  await db.update(processRuns).set({ status: "stopped", doneAt: new Date() }).where(eq(processRuns.id, run.id));
  await db.update(tasks).set({ status: "cancelled", updatedAt: new Date() }).where(and(eq(tasks.runId, run.id), inArray(tasks.status, ["todo", "doing", "waiting"])));
  record({ workspaceId: w.workspaceId, userId: w.userId, kind: "process", summary: `Stopped "${run.processTitle}" for ${run.subject}` });
  return run;
}

// A client just won: every process that starts for new clients, for them.
export async function startForNewClient(w: { workspaceId: string; userId: string }, clientId: string) {
  for (const p of await listProcesses(w.workspaceId))
    if (!p.error && p.starts === "new client") await startRun(w, p.name, { clientId, repeatKey: `${p.name}/new/${clientId}` }).catch((error) => console.error("starting a process failed", p.name, error));
}

export async function listRuns(workspaceId: string, f: { process?: string; clientId?: string; recordId?: string; all?: boolean } = {}): Promise<ProcessRun[]> {
  const rows = await db
    .select()
    .from(processRuns)
    .where(
      and(
        eq(processRuns.workspaceId, workspaceId),
        f.process ? eq(processRuns.process, f.process) : undefined,
        f.clientId ? eq(processRuns.clientId, f.clientId) : undefined,
        f.recordId ? eq(processRuns.recordId, f.recordId) : undefined,
        f.all ? undefined : eq(processRuns.status, "active"),
      ),
    )
    .orderBy(desc(processRuns.startedAt))
    .limit(300);
  if (!rows.length) return [];
  const open = await db
    .select()
    .from(tasks)
    .where(and(inArray(tasks.runId, rows.map((r) => r.id)), inArray(tasks.status, ["todo", "doing", "waiting"])));
  const names = new Map((await listTeam(workspaceId)).map((m) => [m.id, m.name ?? m.email]));
  return rows.map((r) => {
    const t = open.find((x) => x.runId === r.id && x.stepIndex === r.step);
    return {
      id: r.id,
      process: r.process,
      processTitle: r.processTitle,
      subject: r.subject,
      clientId: r.clientId,
      recordId: r.recordId,
      period: r.period,
      status: r.status,
      step: r.step,
      steps: r.steps.map((s, k) => ({ ...s, finishedAt: r.finished[k] ?? null })),
      current: t
        ? { taskId: t.id, assigneeName: t.assigneeId ? (names.get(t.assigneeId) ?? "(left the team)") : t.agent ? `the ${t.agent} agent` : "Emplio", status: t.status, dueAt: t.dueAt?.toISOString() ?? null, waitingOn: t.waitingOn }
        : null,
      startedAt: r.startedAt.toISOString(),
      doneAt: r.doneAt?.toISOString() ?? null,
    };
  });
}

// For tasks.ts: each step task's run (title, its place, where sending back goes).
export async function stepInfo(runIds: string[]) {
  if (!runIds.length) return new Map<string, Run>();
  return new Map((await db.select().from(processRuns).where(inArray(processRuns.id, runIds))).map((r) => [r.id, r]));
}

// --- `emplio processes` ---

const USAGE = `usage: emplio processes list                                   the processes (steps done the same way every time)
       emplio processes show <name>                            one, with its file
       emplio processes add <name> - <<'MD' ... MD             a new one (owner or admin): company/processes/<name>.md, as below
       emplio processes update <name> - <<'MD' ... MD          change it (runs already going keep their steps)
       emplio processes remove <name>                          remove it (runs going carry on)
       emplio processes start <name> --client <name>           start one for a client (anyone on the team)
       emplio processes start <name> --for "<title>"           one for a record (an invoice: made if new) or anything else by name
       emplio processes start <name> --record <id>             one for a record already there (emplio records list)
       emplio processes runs [--client <name>] [--record <id>] [--all]   what's going (a process's name first: just that one; --all: finished ones too)
       emplio processes back <run> --note "<what to fix>"      an OK step not OK: back to the step it names
       emplio processes stop <run>                             stop one; its open step is cancelled
A process file:
  ---
  title: Annual filing
  for: client              # client (default); a kind of record: invoice, candidate, project (one word,
                           #   singular; emplio records); or other: just a name
  starts: manual           # manual (default), or new client: for each client won
  every: "0 9 1 4 *"       # instead: on a schedule, for each client (clients: all, or [a, b])
  steps:
    - name: Get the audited accounts
      who: client          # handler (default: who looks after the client), owner, emplio, client (waiting on
      days: 30             #   them), a person's name or email, or an agent's name
    - name: Draft the notice and resolution
      who: emplio
      days: 2
    - name: Approve the draft
      who: owner
      back: 2              # an OK step: sending it back starts step 2 again
    - name: File AOC-4
      days: 30
      after: Hold the AGM  # due 30 days after that step finished (or after: start), not after this one starts
      how: Attach the signed accounts and the AGM minutes.
  ---
  How it's done, in words: what good looks like, the usual snags.`;

export async function processesCommand(who: Ctx, args: string[], caughtUp: () => Promise<unknown>, data = false) {
  const [sub, ...rest] = args;
  const opts: Record<string, string> = {};
  const words: string[] = [];
  // add/update: the name, then the whole file (which starts with ---), as they are
  if (sub === "add" || sub === "update") words.push(...rest.slice(0, 2));
  else for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (a === "--all") opts.all = "1";
    else if (a.startsWith("--")) opts[a.slice(2)] = rest[++i] ?? "";
    else words.push(a);
  }
  const clientOf = async (q: string | undefined) => {
    if (!q) return undefined;
    const c = await findClient(who.workspaceId, q);
    if (typeof c === "string") throw new ProcessError(c);
    return c.id;
  };
  try {
    switch (sub) {
      case undefined:
      case "list": {
        const list = await listProcesses(who.workspaceId);
        if (data) return JSON.stringify(list);
        if (!list.length) return "No processes yet. Write one with emplio processes add (emplio processes help).";
        return list
          .map((p) => `${p.name}\t${p.error ? `BROKEN: ${p.error}` : `${p.steps.length} steps`}\t${p.starts === "schedule" ? `every "${p.every}" for ${p.clients?.includes("*") ? "every active client" : p.clients?.join(", ")}` : p.starts === "new client" ? "for each new client" : "by hand"}\t${p.active} going\t${p.title}`)
          .join("\n");
      }
      case "show": {
        if (!words[0]) break;
        const text = await readFile(who.workspaceId, REPO, pathOf(words[0]));
        if (text === null) return `error: no process ${words[0]}`;
        return `company/processes/${words[0]}.md:\n${text}`;
      }
      case "add":
      case "update": {
        const [name, text] = words;
        if (!name) break;
        if (!text?.trim()) return `error: ${name} needs its file: emplio processes ${sub} ${name} - <<'MD' ... MD (emplio processes help)`;
        const p = await saveProcess(who, name, text, sub);
        await caughtUp();
        return `Saved: company/processes/${name}.md, ${p.steps.length} steps${p.starts === "schedule" ? `; starts on its schedule for each client (automation ${autoName(name)})` : p.starts === "new client" ? "; starts for each client won" : "; start it with emplio processes start"}.`;
      }
      case "remove":
        if (!words[0]) break;
        await removeProcess(who, words[0]);
        await caughtUp();
        return `Removed ${words[0]}; runs going carry on.`;
      case "start": {
        if (!words[0]) break;
        const run = await startRun(who, words[0], { clientId: await clientOf(opts.client), recordId: opts.record, subject: opts.for });
        const [r] = await listRuns(who.workspaceId, { process: words[0], all: true }).then((l) => l.filter((x) => x.id === run!.id));
        return `Started ${run!.id.slice(0, 8)}: "${run!.processTitle}" for ${run!.subject}. Step 1, ${r?.steps[0]?.name}: ${r?.current ? `${r.current.assigneeName}${r.current.dueAt ? `, due ${r.current.dueAt.slice(0, 10)}` : ""}` : "made"}.`;
      }
      case "runs": {
        const recordId = opts.record ? (await findRecord(who.workspaceId, opts.record).catch((e: Error) => { throw new ProcessError(e.message); })).id : undefined;
        const runs = await listRuns(who.workspaceId, { process: words[0], clientId: await clientOf(opts.client), recordId, all: !!opts.all });
        if (data) return JSON.stringify(runs);
        if (!runs.length) return opts.all ? "No runs." : "Nothing going. (--all for finished ones)";
        return runs
          .map((r) => {
            const at = r.status === "active" ? `step ${r.step + 1}/${r.steps.length} ${r.steps[r.step]?.name}${r.current ? ` (${r.current.assigneeName}, ${r.current.status}${r.current.dueAt ? `, due ${r.current.dueAt.slice(0, 10)}` : ""})` : ""}` : r.status;
            return `${r.id.slice(0, 8)}\t${r.processTitle}\t${r.subject}${r.period ? ` · ${r.period}` : ""}\t${at}`;
          })
          .join("\n");
      }
      case "back": {
        if (!words[0]) break;
        const run = await sendBack(who, words[0], opts.note ?? "");
        return `Sent back to step ${run.step + 1}, ${run.steps[run.step]!.name}.`;
      }
      case "stop": {
        if (!words[0]) break;
        const run = await stopRun(who, words[0]);
        return `Stopped "${run.processTitle}" for ${run.subject}.`;
      }
      case "help":
        return USAGE;
    }
  } catch (error) {
    if (error instanceof ProcessError) return `error: ${error.message}`;
    throw error;
  }
  return USAGE;
}

// --- the app ---

export async function processRoutes(app: FastifyInstance) {
  const fail = (reply: { code: (n: number) => { send: (b: unknown) => unknown } }, error: unknown) => {
    if (error instanceof ProcessError) return reply.code(400).send({ error: error.message });
    throw error;
  };
  app.get("/processes", async (req, reply) => {
    const ctx = await context(req, reply);
    if (!ctx) return;
    return listProcesses(ctx.workspaceId);
  });
  app.get<{ Querystring: { process?: string; client?: string; record?: string; all?: string } }>("/process-runs", async (req, reply) => {
    const ctx = await context(req, reply);
    if (!ctx) return;
    return listRuns(ctx.workspaceId, { process: req.query.process, clientId: req.query.client, recordId: req.query.record, all: req.query.all === "1" });
  });
  app.post<{ Body: { process?: string; clientId?: string | null; recordId?: string | null; subject?: string } }>("/process-runs", async (req, reply) => {
    const ctx = await context(req, reply);
    if (!ctx) return;
    try {
      const run = await startRun(ctx, req.body?.process ?? "", { clientId: req.body?.clientId, recordId: req.body?.recordId, subject: req.body?.subject });
      return (await listRuns(ctx.workspaceId, { process: run!.process })).find((r) => r.id === run!.id);
    } catch (error) {
      return fail(reply, error);
    }
  });
  app.post<{ Params: { id: string }; Body: { note?: string } }>("/process-runs/:id/back", async (req, reply) => {
    const ctx = await context(req, reply);
    if (!ctx) return;
    try {
      await sendBack(ctx, req.params.id, req.body?.note ?? "");
      return { ok: true };
    } catch (error) {
      return fail(reply, error);
    }
  });
  app.post<{ Params: { id: string } }>("/process-runs/:id/stop", async (req, reply) => {
    const ctx = await context(req, reply);
    if (!ctx) return;
    try {
      await stopRun(ctx, req.params.id);
      return { ok: true };
    } catch (error) {
      return fail(reply, error);
    }
  });
}

if (import.meta.main) {
  const ok = parseProcess(`---\ntitle: Annual filing\nsteps:\n  - name: Get accounts\n    who: client\n    days: 30\n  - name: Draft\n    who: emplio\n  - name: Approve\n    who: owner\n    back: Draft\n  - name: File\n    days: 30\n    after: 1\n---\nWords.\n`);
  console.assert(!("error" in ok) && ok.steps[2]!.back === 2 && ok.steps[3]!.after === 1 && ok.steps[0]!.who === "client" && ok.steps[3]!.who === "handler", ok);
  console.assert("error" in parseProcess(`---\ntitle: X\nsteps:\n  - name: A\n    back: 2\n---\n`));
  const inv = parseProcess(`---\ntitle: Chase\nfor: Invoice\nsteps:\n  - name: Remind\n    who: handler\n---\n`);
  console.assert(!("error" in inv) && inv.for === "invoice", inv);
  console.assert("error" in parseProcess(`---\ntitle: X\nfor: two words\nsteps: [A]\n---\n`));
  console.log("ok");
}
