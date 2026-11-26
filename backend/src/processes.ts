// Processes: work done the same way every time, as steps in order (onboarding a client, a yearly filing, hiring for a
// role). Each is a file in the company repo, processes/<name>.md: settings and its steps between --- lines, then how
// it's done in words. Emplio writes them (from a chat, or when it sees the same steps done again and again); owners
// change them later. A go of one (a run, process_runs) is for one client, or for anything else with a name (a
// candidate, an opening), with what its inputs ask for filled in (an invoice number, an amount, a deadline), and keeps
// the steps and inputs it started with. Each step is a task, made when the one before it is
// done: for whoever looks after the client, the owner, a named person, Emplio or one of its agents, or "client" (a
// task waiting on them, with the handler). An OK step can be sent back to an earlier one.
// Started by hand (`emplio processes start`, the app), or by an automation (process: <name>) on a schedule for each
// client, or for each new client: the file says what's done, never when; that's the automation's.
// The files are the truth; syncProcesses keeps one row per file in the processes table (like automations).
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { INPUT_TYPES, type Process, type ProcessInput, type ProcessRun, type ProcessStep, type Role, type RunInput } from "@emplio/shared";
import { record } from "./activity";
import { context, type Ctx } from "./auth";
import { db } from "./db";
import { automations, processes, processRuns, tasks, workspaceMembers, type ProcessStepDef } from "./db/schema";
import { findAgent } from "./agents";
import { detailOf, findClient, listClients } from "./clients";
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

export class ProcessError extends Error {}

const pathOf = (name: string) => {
  if (!NAME.test(name)) throw new ProcessError("a process name is lowercase letters, digits and dashes, like client-onboarding");
  return `${FOLDER}/${name}.md`;
};

// --- the file ---

type Parsed = Omit<Process, "name" | "error" | "active" | "startedBy">;

// Its settings, inputs and steps, or what's wrong with it. Steps refer to each other by number (1 = the first) or
// by name, and to a date input by its name.
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
  if (forWhat !== "client" && forWhat !== "other")
    return { error: "for: is client (each go is for a client) or other (for anything else with a name: a candidate, an opening); what each go needs goes in inputs:" };
  // starts: manual (the old default) is harmless; anything else is an automation's job now
  if ("every" in s || "clients" in s || (s.starts !== undefined && s.starts !== "manual"))
    return { error: "when it starts isn't set here: take out every:, starts: and clients:, and start it on a schedule or for each new client with an automation (process: <name>, emplio automations help)" };

  const inputs = parseInputs(s.inputs);
  if ("error" in inputs) return inputs;

  if (!Array.isArray(s.steps) || !s.steps.length) return { error: "steps: is missing: a list of steps, each with a name: and who:" };
  if (s.steps.length > 40) return { error: "at most 40 steps" };
  const raw = s.steps as unknown[];
  const names = raw.map((x) => (typeof x === "string" ? x : typeof (x as { name?: unknown })?.name === "string" ? ((x as { name: string }).name) : "").trim());
  // a step it refers to: by number (1-based) or name, before this one
  const ref = (v: unknown, i: number, key: string): number | "start" | { error: string } => {
    if (v === "start") return "start";
    const n = typeof v === "number" ? v : typeof v === "string" ? names.findIndex((x) => x.toLowerCase() === v.trim().toLowerCase()) + 1 : 0;
    if (!Number.isInteger(n) || n < 1 || n > i) return { error: `step ${i + 1}: ${key}: must be an earlier step, by number or name${key === "after" && inputs.some((x) => x.type === "date") ? ", or a date input" : ""}` };
    return n;
  };
  const steps: ProcessStep[] = [];
  for (const [i, x] of raw.entries()) {
    const o = (typeof x === "string" ? { name: x } : x) as Record<string, unknown>;
    if (!names[i]) return { error: `step ${i + 1} needs a name:` };
    const step: ProcessStep = { name: names[i]!, who: typeof o.who === "string" && o.who.trim() ? o.who.trim() : forWhat === "client" ? "handler" : "owner" };
    if (forWhat === "other" && ["handler", "client"].includes(step.who.toLowerCase())) return { error: `step ${i + 1}: who: ${step.who} only goes with a process for clients` };
    if (typeof o.how === "string" && o.how.trim()) step.how = o.how.trim();
    if (o.days !== undefined) {
      if (!Number.isInteger(o.days) || Math.abs(o.days as number) > 400) return { error: `step ${i + 1}: days: is a number of days, like 7` };
      step.days = o.days as number;
    }
    if (o.after !== undefined) {
      if (step.days === undefined) return { error: `step ${i + 1}: after: goes with days: (days after that step, or that date)` };
      // a date filled in when it starts, by name, unless a step has that name
      const date = typeof o.after === "string" && !names.slice(0, i).some((n) => n.toLowerCase() === (o.after as string).trim().toLowerCase()) ? findInput(inputs, o.after) : undefined;
      if (date) {
        if (date.type !== "date") return { error: `step ${i + 1}: after: ${date.name} is an input but not a date (type: date)` };
        step.afterInput = date.key;
      } else {
        const r = ref(o.after, i, "after");
        if (typeof r === "object") return r;
        step.after = r;
      }
    }
    if (step.days !== undefined && step.days < 0 && !step.afterInput) return { error: `step ${i + 1}: days: is below 0 only with after: a date input (that many days before it)` };
    if (o.back !== undefined) {
      const r = ref(o.back, i, "back");
      if (typeof r === "object") return r;
      if (r === "start") return { error: `step ${i + 1}: back: is an earlier step` };
      step.back = r;
    }
    steps.push(step);
  }
  return { title, for: forWhat, inputs, steps, about: m[2]!.trim() };
}

// "Due date" → due-date: what an input is passed as (--due-date; due_date= from Python, made --due-date)
export const inputKey = (name: string) =>
  name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
const findInput = <T extends ProcessInput>(inputs: T[], q: unknown) => (typeof q === "string" ? inputs.find((x) => x.key === inputKey(q)) : undefined);
// what start and set already take as flags
const TAKEN = ["client", "for", "all", "note"];

function parseInputs(v: unknown): ProcessInput[] | { error: string } {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) return { error: "inputs: is a list of what's filled in when it starts, each with a name: (and type: number, date or choice)" };
  if (v.length > 20) return { error: "at most 20 inputs" };
  const out: ProcessInput[] = [];
  for (const [i, x] of v.entries()) {
    const o = (typeof x === "string" ? { name: x } : x) as Record<string, unknown>;
    const name = typeof o?.name === "string" ? o.name.trim().slice(0, 60) : "";
    const key = inputKey(name);
    if (!key) return { error: `input ${i + 1} needs a name: (like Invoice, or Due date)` };
    if (TAKEN.includes(key)) return { error: `input ${i + 1}: ${name} means something else when starting; call it something else` };
    if (out.some((x) => x.key === key)) return { error: `input ${i + 1}: ${name} is there twice` };
    const type = o.type === undefined ? "text" : String(o.type).trim().toLowerCase();
    if (!(INPUT_TYPES as readonly string[]).includes(type)) return { error: `input ${i + 1}: type: is text (the default), number, date or choice` };
    if (o.required !== undefined && typeof o.required !== "boolean") return { error: `input ${i + 1}: required: is true (the default) or false` };
    const input: ProcessInput = { name, key, type: type as ProcessInput["type"], required: o.required !== false };
    if (type === "choice") {
      const options = Array.isArray(o.options) ? o.options.map((x) => (typeof x === "string" || typeof x === "number" ? String(x).trim() : "")) : [];
      if (!options.length || options.some((x) => !x) || new Set(options.map((x) => x.toLowerCase())).size !== options.length)
        return { error: `input ${i + 1}: a choice needs options:, a list like [Bank, Card, Cheque]` };
      input.options = options;
    } else if (o.options !== undefined) return { error: `input ${i + 1}: options: goes with type: choice` };
    out.push(input);
  }
  return out;
}

// What was given for a process's inputs (by name or key, any case), checked and tidied: a number as plain digits, a
// date as 2026-12-01, a choice as its option. "" or null empties one. Unknown names are refused. Starting (whole):
// every required one must be there; changing: only what's given is checked.
export function checkInputs(inputs: ProcessInput[], given: Record<string, unknown>, whole: boolean): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  for (const [k, raw] of Object.entries(given)) {
    const input = findInput(inputs, k);
    if (!input) throw new ProcessError(inputs.length ? `no input ${k}; this process takes ${inputs.map((x) => `--${x.key}`).join(", ")}` : `this process takes no inputs (${k})`);
    const v = raw === null || raw === undefined ? "" : String(raw).trim();
    if (!v) {
      if (input.required && !whole) throw new ProcessError(`${input.name} can't be left empty`);
      out[input.key] = null;
      continue;
    }
    if (input.type === "number") {
      const n = Number(v.replace(/[,\s_]/g, ""));
      if (!Number.isFinite(n)) throw new ProcessError(`${input.name} is a number, not "${v}"`);
      out[input.key] = String(n);
    } else if (input.type === "date") {
      const d = /^\d{4}-\d{2}-\d{2}$/.test(v) ? new Date(`${v}T12:00:00Z`) : new Date(v);
      if (Number.isNaN(d.getTime())) throw new ProcessError(`${input.name} is a date, like 2026-12-01, not "${v}"`);
      out[input.key] = /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : d.toLocaleDateString("en-CA", { timeZone: DEFAULT_ZONE });
    } else if (input.type === "choice") {
      const o = input.options!.find((x) => x.toLowerCase() === v.toLowerCase());
      if (!o) throw new ProcessError(`${input.name} is one of ${input.options!.join(", ")}, not "${v}"`);
      out[input.key] = o;
    } else out[input.key] = v.slice(0, 1000);
  }
  if (whole) {
    const missing = inputs.filter((x) => x.required && !out[x.key]);
    if (missing.length) throw new ProcessError(`it needs ${missing.map((x) => `${x.name} (--${x.key})`).join(", ")}`);
  }
  return out;
}

// What was filled in, for a person or Emplio to read: "Invoice: INV-1042 · Amount: 85000 · Due date: 2026-12-01"
export const inputsLine = (inputs: RunInput[]) =>
  inputs
    .filter((x) => x.value)
    .map((x) => `${x.name}: ${x.value}`)
    .join(" · ");

type ProcessRow = typeof processes.$inferSelect;

// Make the rows match the files in git: new and changed files read again, removed ones dropped.
const syncing = new Map<string, Promise<unknown>>();
export function syncProcesses(workspaceId: string): Promise<void> {
  const run = (syncing.get(workspaceId) ?? Promise.resolve()).then(async () => {
    const files = (await listFolder(workspaceId, REPO, FOLDER).catch(() => [])).filter((f) => f.name.endsWith(".md") && NAME.test(f.name.slice(0, -3)));
    const rows = await db.select().from(processes).where(eq(processes.workspaceId, workspaceId));
    for (const row of rows)
      if (!files.some((f) => f.name === `${row.name}.md`)) await db.delete(processes).where(eq(processes.id, row.id));
    for (const f of files) {
      const name = f.name.slice(0, -3);
      const old = rows.find((r) => r.name === name);
      if (old?.sha === f.sha) continue;
      const text = (await readFile(workspaceId, REPO, `${FOLDER}/${f.name}`)) ?? "";
      const parsed = parseProcess(text);
      const values =
        "error" in parsed
          ? { workspaceId, name, sha: f.sha, title: name, for: "client", inputs: [], steps: [], about: "", error: parsed.error, updatedAt: new Date() }
          : { workspaceId, name, sha: f.sha, ...parsed, steps: parsed.steps as ProcessStepDef[], error: null, updatedAt: new Date() };
      await db.insert(processes).values(values).onConflictDoUpdate({ target: [processes.workspaceId, processes.name], set: values });
    }
  });
  syncing.set(workspaceId, run.catch(() => {}));
  return run;
}

const toProcess = (r: ProcessRow, active: number, startedBy: Process["startedBy"] = []): Process => ({
  name: r.name,
  title: r.title,
  for: r.for === "other" ? "other" : "client",
  inputs: r.inputs,
  startedBy,
  steps: r.steps,
  about: r.about,
  error: r.error,
  active,
});

export async function listProcesses(workspaceId: string): Promise<Process[]> {
  await syncProcesses(workspaceId);
  const [rows, counts, starters] = await Promise.all([
    db.select().from(processes).where(eq(processes.workspaceId, workspaceId)).orderBy(processes.title),
    db
      .select({ process: processRuns.process, n: sql<number>`count(*)`.mapWith(Number) })
      .from(processRuns)
      .where(and(eq(processRuns.workspaceId, workspaceId), eq(processRuns.status, "active")))
      .groupBy(processRuns.process),
    // what starts each: the automations naming it (synced when the app or Emplio lists them)
    db
      .select({ name: automations.name, when: automations.when, schedule: automations.schedule, trigger: automations.trigger, clients: automations.clients, process: automations.process })
      .from(automations)
      .where(and(eq(automations.workspaceId, workspaceId), eq(automations.enabled, true), sql`${automations.process} is not null`)),
  ]);
  const n = new Map(counts.map((c) => [c.process, c.n]));
  return rows.map((r) => toProcess(r, n.get(r.name) ?? 0, starters.filter((a) => a.process === r.name).map(({ process: _, ...a }) => a)));
}

async function getProcess(workspaceId: string, name: string) {
  pathOf(name);
  await syncProcesses(workspaceId);
  const row = await db.query.processes.findFirst({ where: and(eq(processes.workspaceId, workspaceId), eq(processes.name, name)) });
  if (!row) throw new ProcessError(`no process ${name} (emplio processes list)`);
  if (row.error) throw new ProcessError(`${name} can't run: ${row.error}`);
  return toProcess(row, 0);
}

// Saved by the owner or an admin.
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

// Start one: for a client (subject is their name) or for anything else named by subject (else by its first input),
// with its inputs filled in. A repeatKey already used starts nothing (null).
export async function startRun(
  w: { workspaceId: string; userId: string },
  name: string,
  o: { client?: string | null; subject?: string; inputs?: Record<string, unknown>; period?: string | null; repeatKey?: string },
): Promise<Run | null> {
  const p = await getProcess(w.workspaceId, name);
  const c = p.for === "client" && o.client ? (await listClients(w)).find((x) => x.slug === o.client) : null;
  // an input not given, filled in from the client's detail of the same name (their Tax number), when it fits its type
  const fromClient = Object.fromEntries(
    p.inputs.flatMap((x) => {
      const v = c && !Object.keys(o.inputs ?? {}).some((k) => inputKey(k) === x.key) ? detailOf(c, x.name) : undefined;
      if (!v) return [];
      try {
        return Object.entries(checkInputs([x], { [x.key]: v }, false));
      } catch {
        return [];
      }
    }),
  );
  const given = { ...fromClient, ...checkInputs(p.inputs, { ...fromClient, ...(o.inputs ?? {}) }, true) };
  const inputs: RunInput[] = p.inputs.map((x) => ({ ...x, value: given[x.key] ?? null }));
  let subject = o.subject?.trim() || (p.for === "other" ? (inputs[0]?.value ?? "") : "");
  let client: string | null = null;
  if (p.for === "client") {
    if (!o.client) throw new ProcessError(`"${p.title}" is done for a client: say which (--client <name>)`);
    if (!c) throw new ProcessError("no such client (emplio clients list)");
    subject = c.name;
    client = c.slug;
  } else if (!subject) throw new ProcessError(`say who or what this "${p.title}" is for (--for "Sarah Lee, React developer"${p.inputs[0] ? `, or its ${p.inputs[0].name}: --${p.inputs[0].key}` : ""})`);
  const [run] = await db
    .insert(processRuns)
    .values({
      workspaceId: w.workspaceId,
      process: name,
      processTitle: p.title,
      subject: subject.slice(0, 200),
      client,
      inputs,
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

// Who does a step or an automation's task, from its who: (handler and client: whoever looks after the client; owner;
// emplio; a person by name or email; one of Emplio's agents). Someone no longer there: fallback, with a line saying so.
export async function assign(workspaceId: string, who: string, handlerId: string | null | undefined, fallback: string | null) {
  const w = who.trim().toLowerCase();
  if (w === "emplio") return { assigneeId: null, agent: null, missing: "" };
  if (w === "handler" || w === "client") return { assigneeId: handlerId ?? fallback, agent: null, missing: "" };
  if (w === "owner") {
    const [o] = await db.select({ id: workspaceMembers.userId }).from(workspaceMembers).where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.role, "owner")));
    return { assigneeId: o?.id ?? fallback, agent: null, missing: "" };
  }
  const m = person(await listTeam(workspaceId), who);
  if (m) return { assigneeId: m.id, agent: null, missing: "" };
  const a = await findAgent(workspaceId, who, { admin: true });
  if (a) return { assigneeId: null, agent: a.slug, missing: "" };
  return { assigneeId: fallback, agent: null, missing: `(${who} was to do this, but nobody by that name is on the team now.)` };
}

// The task for step i of a run: who does it, when it's due, and what it's part of.
async function makeStep(run: Run, i: number, note?: string) {
  const step = run.steps[i]!;
  const client = run.client ? (await listClients(run)).find((c) => c.slug === run.client) : null;
  // the first handler who's on the team
  const { assigneeId, agent, missing } = await assign(run.workspaceId, step.who, client?.handlers.find((h) => h.id)?.id, run.startedBy);
  const dueAt = dueOf(run, step);
  const waiting = step.who.toLowerCase() === "client";
  const notes = stepNotes(run, i, note, missing);
  const { makeTask } = await import("./tasks");
  return (await makeTask({
    workspaceId: run.workspaceId,
    title: taskTitle(run, i),
    notes,
    status: waiting ? "waiting" : "todo",
    waitingOn: waiting ? `${run.subject}: ${step.name}` : null,
    assigneeId,
    agent,
    requesterId: run.startedBy,
    client: run.client,
    dueAt,
    runId: run.id,
    stepIndex: i,
  }))!;
}

// A step's task's notes: how to do it, what was filled in, where it sits in the process (the evals use these too)
export function stepNotes(run: Pick<Run, "id" | "steps" | "inputs" | "processTitle" | "subject" | "period" | "process">, i: number, note?: string, missing = "") {
  const step = run.steps[i]!;
  const details = inputsLine(run.inputs);
  return [
    step.how,
    note && `Sent back: ${note}`,
    missing,
    details && `${DETAILS}${details}`,
    `Step ${i + 1} of ${run.steps.length} of "${run.processTitle}" for ${run.subject}${run.period ? ` (${run.period})` : ""}; how this process goes: company/processes/${run.process}.md.`,
    step.back ? `An OK step: if it isn't right, send it back to step ${step.back} (emplio processes back ${run.id.slice(0, 8)} --note "<what to fix>").` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

// What a step's task is called: the step, then what the go is for (a client's name shows beside the task anyway, so
// for one its first input instead, if any), then the period.
function taskTitle(run: Run, i: number) {
  const first = run.inputs[0]?.value;
  const label = run.client ? (first ? ` · ${first}` : "") : ` · ${run.subject}`;
  return `${run.steps[i]!.name}${label}${run.period ? ` · ${run.period}` : ""}`.slice(0, 300);
}

// When a step is due: days after it starts, after an earlier step finished, after the start, or before or after a date
// filled in (none if that date was left empty).
function dueOf(run: Run, step: ProcessStepDef) {
  if (step.days === undefined) return null;
  if (step.afterInput) {
    const v = run.inputs.find((x) => x.key === step.afterInput)?.value;
    const d = v ? new Date(`${v}T12:00:00Z`) : null;
    return d && !Number.isNaN(d.getTime()) ? endOfDay(new Date(d.getTime() + step.days * DAY)) : null;
  }
  const from = step.after === "start" ? run.startedAt.getTime() : step.after ? Date.parse(run.finished[step.after - 1] ?? "") || Date.now() : Date.now();
  return endOfDay(new Date(from + step.days * DAY));
}

// the line in a step's notes with what was filled in, kept current when it changes
const DETAILS = "Details: ";

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

// Change what was filled in (a part payment, a new due date): whoever started it, whoever has the step it's on, the
// owner or an admin. The open step's task follows: its title, its details line, and its due date if it hangs off a
// date that changed.
export async function setInputs(w: Who, id: string, given: Record<string, unknown>) {
  const run = await findRun(w.workspaceId, id);
  if (run.status !== "active") throw new ProcessError(`it's ${run.status}; only a go still running can change`);
  if (!run.inputs.length) throw new ProcessError("this one has nothing filled in to change (its process had no inputs when it started)");
  if (!Object.keys(given).length) throw new ProcessError(`say what to change: ${run.inputs.map((x) => `--${x.key}`).join(", ")}`);
  // what's filled in steers the later steps, some done with the owner's access
  if (!isAdmin(w)) throw new ProcessError("only the owner or an admin can change what was filled in; ask them");
  const t = await currentTask(run);
  const next = checkInputs(run.inputs, given, false);
  const changed = run.inputs.filter((x) => x.key in next && next[x.key] !== x.value);
  if (!changed.length) return run;
  const inputs = run.inputs.map((x) => (x.key in next ? { ...x, value: next[x.key]! } : x));
  const [moved] = await db.update(processRuns).set({ inputs }).where(eq(processRuns.id, run.id)).returning();
  if (t) {
    const step = moved!.steps[moved!.step]!;
    const details = inputsLine(inputs);
    const lines = (t.notes ?? "").split("\n").filter((l) => !l.startsWith(DETAILS));
    const at = lines.findIndex((l) => l.startsWith(`Step ${moved!.step + 1} of `));
    if (details) lines.splice(at < 0 ? lines.length : at, 0, `${DETAILS}${details}`, "");
    await db
      .update(tasks)
      .set({
        title: taskTitle(moved!, moved!.step),
        notes: lines.join("\n").replace(/\n{3,}/g, "\n\n").trim(),
        ...(step.afterInput && changed.some((x) => x.key === step.afterInput) && { dueAt: dueOf(moved!, step) }),
        updatedAt: new Date(),
      })
      .where(eq(tasks.id, t.id));
  }
  record({
    workspaceId: w.workspaceId,
    userId: w.userId,
    kind: "process",
    summary: `Changed ${changed.map((x) => `${x.name} to ${next[x.key] ?? "(empty)"}`).join(", ")} on "${run.processTitle}" for ${run.subject}`,
  });
  return moved!;
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

// viewer: a member, who sees only the runs they started or have a step in (inputs can be amounts, salaries)
export async function listRuns(workspaceId: string, f: { process?: string; client?: string; all?: boolean; viewer?: Pick<Who, "userId" | "role"> } = {}): Promise<ProcessRun[]> {
  const member = f.viewer && !isAdmin(f.viewer) ? f.viewer.userId : null;
  const rows = await db
    .select()
    .from(processRuns)
    .where(
      and(
        eq(processRuns.workspaceId, workspaceId),
        f.process ? eq(processRuns.process, f.process) : undefined,
        f.client ? eq(processRuns.client, f.client) : undefined,
        f.all ? undefined : eq(processRuns.status, "active"),
        member ? sql`(${processRuns.startedBy} = ${member} or exists (select 1 from ${tasks} where ${tasks.runId} = ${processRuns.id} and ${tasks.assigneeId} = ${member}))` : undefined,
      ),
    )
    .orderBy(desc(processRuns.startedAt))
    // every one going; with finished ones, the latest 1000
    .limit(f.all ? 1000 : 100_000);
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
      client: r.client,
      inputs: r.inputs,
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

export const USAGE = `usage: emplio processes list                                   the processes (steps done the same way every time)
       emplio processes show <name>                            one, with its file
       emplio processes add <name> - <<'MD' ... MD             a new one (owner or admin): company/processes/<name>.md, as below
       emplio processes update <name> - <<'MD' ... MD          change it (runs already going keep their steps and inputs)
       emplio processes remove <name>                          remove it (runs going carry on)
       emplio processes start <name> --client <name> [--<input> <value>]...   start one for a client, its inputs filled in
       emplio processes start <name> --for "<who or what>" [--<input> <value>]...   one not for a client
       emplio processes runs [<name>] [--client <name>] [--all]  what's going, with what was filled in (--all: finished ones too)
       emplio processes set <run> --<input> <value>...         change what was filled in (a part payment, a new date; "" empties)
       emplio processes back <run> --note "<what to fix>"      an OK step not OK: back to the step it names
       emplio processes stop <run>                             stop one; its open step is cancelled
An input is passed by its name, lowercase with dashes: Due date is --due-date (in Python, due_date=).
A process file:
  ---
  title: Annual filing
  for: client              # client (default), or other: anything else with a name (a candidate, an opening)
  inputs:                  # what's filled in when it starts (none: nothing asked)
    - name: Financial year #   text unless type: says otherwise; one the client has a detail for (Tax number) is
                           #   filled in from it
    - name: AGM date
      type: date           # text, number, date (2026-12-01), or choice with options: [Bank, Card]
      required: false      # needed unless false (one an automation starts: false, or a client detail fills it)
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
      after: AGM date      # due 30 days after that date (or after: an earlier step, or start); days: -7 with a
      how: Attach the signed accounts and the AGM minutes.   #   date: a week before it
  ---
  How it's done, in words: what good looks like, the usual snags.
The file never says when it starts. On a schedule for each client, or for each new client: an automation with
process: <name> (emplio automations help); a process page shows the automations that start it.`;

export async function processesCommand(who: Ctx, args: string[], caughtUp: () => Promise<unknown>, data = false) {
  const [sub, ...rest] = args;
  const opts: Record<string, string> = {};
  const words: string[] = [];
  // add/update: the name, then the whole file (which starts with ---), as they are
  if (sub === "add" || sub === "update") words.push(...rest.slice(0, 2));
  else for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (a === "--all") opts.all = "1";
    else if (a.startsWith("--") && a.length > 2) opts[a.slice(2)] = rest[++i] ?? "";
    else words.push(a);
  }
  // every other --flag is an input (start, set)
  const { client: _client, for: _for, all: _all, note: _note, ...inputFlags } = opts;
  const clientOf = async (q: string | undefined) => {
    if (!q) return undefined;
    const c = await findClient(who.workspaceId, q);
    if (typeof c === "string") throw new ProcessError(c);
    return c.slug;
  };
  try {
    switch (sub) {
      case undefined:
      case "list": {
        const list = await listProcesses(who.workspaceId);
        if (data) return JSON.stringify(list);
        if (!list.length) return "No processes yet. Write one with emplio processes add (emplio processes help).";
        return list
          .map((p) => `${p.name}\t${p.error ? `BROKEN: ${p.error}` : `${p.steps.length} steps`}\t${p.startedBy.length ? `started by automation ${p.startedBy.map((a) => a.name).join(", ")}` : "by hand"}\t${p.active} going\t${p.title}`)
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
        return `Saved: company/processes/${name}.md, ${p.steps.length} steps; start it with emplio processes start, or on a schedule or for each new client with an automation (process: ${name})`;
      }
      case "remove":
        if (!words[0]) break;
        await removeProcess(who, words[0]);
        await caughtUp();
        return `Removed ${words[0]}; runs going carry on.`;
      case "start": {
        if (!words[0]) break;
        const run = await startRun(who, words[0], { client: await clientOf(opts.client), subject: opts.for, inputs: inputFlags });
        const [r] = await listRuns(who.workspaceId, { process: words[0], all: true, viewer: who }).then((l) => l.filter((x) => x.id === run!.id));
        const details = inputsLine(run!.inputs);
        return `Started ${run!.id.slice(0, 8)}: "${run!.processTitle}" for ${run!.subject}${details ? ` (${details})` : ""}. Step 1, ${r?.steps[0]?.name}: ${r?.current ? `${r.current.assigneeName}${r.current.dueAt ? `, due ${r.current.dueAt.slice(0, 10)}` : ""}` : "made"}.`;
      }
      case "set": {
        if (!words[0]) break;
        const run = await setInputs(who, words[0], inputFlags);
        return `Now: ${inputsLine(run.inputs) || "nothing filled in"}.`;
      }
      case "runs": {
        const runs = await listRuns(who.workspaceId, { process: words[0], client: await clientOf(opts.client), all: !!opts.all, viewer: who });
        if (data) return JSON.stringify(runs);
        if (!runs.length) return opts.all ? "No runs." : "Nothing going. (--all for finished ones)";
        return runs
          .map((r) => {
            const at = r.status === "active" ? `step ${r.step + 1}/${r.steps.length} ${r.steps[r.step]?.name}${r.current ? ` (${r.current.assigneeName}, ${r.current.status}${r.current.dueAt ? `, due ${r.current.dueAt.slice(0, 10)}` : ""}, task ${r.current.taskId.slice(0, 8)})` : ""}` : r.status;
            const details = inputsLine(r.inputs);
            return `${r.id.slice(0, 8)}\t${r.processTitle}\t${r.subject}${r.period ? ` · ${r.period}` : ""}\t${at}${details ? `\n\t${details}` : ""}`;
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
  app.get<{ Querystring: { process?: string; client?: string; all?: string } }>("/process-runs", async (req, reply) => {
    const ctx = await context(req, reply);
    if (!ctx) return;
    return listRuns(ctx.workspaceId, { process: req.query.process, client: req.query.client, all: req.query.all === "1", viewer: ctx });
  });
  app.post<{ Body: { process?: string; client?: string | null; subject?: string; inputs?: Record<string, unknown> } }>("/process-runs", async (req, reply) => {
    const ctx = await context(req, reply);
    if (!ctx) return;
    try {
      const run = await startRun(ctx, req.body?.process ?? "", { client: req.body?.client, subject: req.body?.subject, inputs: req.body?.inputs ?? {} });
      return (await listRuns(ctx.workspaceId, { process: run!.process, viewer: ctx })).find((r) => r.id === run!.id);
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
  app.patch<{ Params: { id: string }; Body: { inputs?: Record<string, unknown> } }>("/process-runs/:id", async (req, reply) => {
    const ctx = await context(req, reply);
    if (!ctx) return;
    try {
      const run = await setInputs(ctx, req.params.id, req.body?.inputs ?? {});
      return (await listRuns(ctx.workspaceId, { process: run.process, all: true, viewer: ctx })).find((r) => r.id === run.id);
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
  const pay = parseProcess(`---\ntitle: Chase\ninputs:\n  - Invoice\n  - name: Amount\n    type: number\n  - name: Due date\n    type: date\n  - name: How they pay\n    type: choice\n    options: [Bank, Card]\n    required: false\nsteps:\n  - name: Remind\n  - name: Call\n    days: 3\n    after: Due date\n  - name: Before\n    days: -2\n    after: due date\n---\n`);
  console.assert(!("error" in pay) && pay.inputs.length === 4 && pay.inputs[2]!.key === "due-date" && pay.inputs[3]!.required === false && pay.steps[1]!.afterInput === "due-date" && pay.steps[2]!.days === -2, pay);
  if (!("error" in pay)) {
    const ok = checkInputs(pay.inputs, { invoice: " INV-1042 ", amount: "85,000", due_date: "2026-12-01", "How they pay": "bank" }, true);
    console.assert(ok.invoice === "INV-1042" && ok.amount === "85000" && ok["due-date"] === "2026-12-01" && ok["how-they-pay"] === "Bank", ok);
    const bad = (g: Record<string, unknown>, whole = true) => { try { checkInputs(pay.inputs, g, whole); return false; } catch { return true; } };
    console.assert(bad({ invoice: "X", amount: "lots", "due-date": "2026-12-01" }), "number");
    console.assert(bad({ invoice: "X", amount: "1", "due-date": "someday" }), "date");
    console.assert(bad({ invoice: "X", amount: "1" }), "missing");
    console.assert(bad({ invoice: "X", amount: "1", "due-date": "2026-12-01", colour: "red" }), "unknown");
    console.assert(bad({ invoice: "X", amount: "1", "due-date": "2026-12-01", "how-they-pay": "Cash" }), "choice");
    console.assert(bad({ invoice: "" }, false), "required can't be emptied");
    console.assert(checkInputs(pay.inputs, { "how-they-pay": "" }, false)["how-they-pay"] === null);
  }
  console.assert("error" in parseProcess(`---\ntitle: X\nsteps:\n  - name: A\n    days: -2\n---\n`), "negative days need a date");
  console.assert("error" in parseProcess(`---\ntitle: X\ninputs: [Invoice]\nsteps:\n  - name: A\n    days: 2\n    after: Invoice\n---\n`), "after a text input");
  console.assert("error" in parseProcess(`---\ntitle: X\nevery: "0 9 1 * *"\nsteps: [A]\n---\n`), "when it starts is an automation's");
  console.assert("error" in parseProcess(`---\ntitle: X\ninputs: [Client]\nsteps: [A]\n---\n`), "taken name");
  console.assert("error" in parseProcess(`---\ntitle: X\nfor: invoice\nsteps: [A]\n---\n`), "for: is client or other");
  console.assert("error" in parseProcess(`---\ntitle: X\ninputs:\n  - name: P\n    type: choice\nsteps: [A]\n---\n`), "choice needs options");
  console.log("ok");
}
