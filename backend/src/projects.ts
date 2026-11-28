// Projects: one client buying one service (Northwind's website, Acme's FY26 audit, a monthly retainer with no due
// date). The client it's for, the service, who leads it, its status, start and due dates and its fee. Its tasks and
// process runs point at it, and so at its client. Rows, by the rules in records.ts. Anyone adds one and moves it along;
// the lead, the fee, moving it to another client and archiving are the owner's and admins'.
import { and, asc, eq, inArray, isNotNull, isNull, sql, type SQL } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { MONEY_PERIODS, PROJECT_STATUSES, type MoneyPeriod, type Project, type ProjectInput, type ProjectStatus } from "@emplio/shared";
import { context } from "./auth";
import { findClient } from "./clients";
import { db } from "./db";
import { detailChanges, detailsOf, fieldsCommand, listFields, nextDetails } from "./fields";
import { followNotes, notesDir, setPrivate, notesAt } from "./private";
import { clients, processRuns, projects, services, tasks, users } from "./db/schema";
import { purging, clean, count, currencyOf, dateOnly, diff, findIn, freeSlug, historyOf, isAdmin, logChange, money, orNull, parseAmount, parseArgs, periodOf, personIn, slugOf, stale, type Who, matchOf, type Match, privateOf, seesPrivate, type Viewer, wsOf, visibleProject } from "./records";
import { findService } from "./services";
import { listTeam } from "./team";

type Result = { ok: true; project: Project; started?: string } | { ok: false; error: string; match?: Match };
export const notesPath = (p: { slug: string; private?: boolean }) => `${notesDir("project", p)}/index.md`;
const STATUS_WORDS: Record<string, ProjectStatus> = { active: "active", "on hold": "on_hold", on_hold: "on_hold", hold: "on_hold", paused: "on_hold", done: "done", finished: "done", complete: "done", cancelled: "cancelled", canceled: "cancelled", dropped: "cancelled" };
export const statusName = (s: ProjectStatus) => (s === "on_hold" ? "on hold" : s);

type F = { clientId?: string; serviceId?: string; leadId?: string; status?: ProjectStatus; open?: boolean; archived?: boolean; ids?: string[] };
export async function listProjects(v: Viewer, f: F = {}): Promise<Project[]> {
  const workspaceId = wsOf(v);
  const all = seesPrivate(v);
  const where: (SQL | undefined)[] = [eq(projects.workspaceId, workspaceId), f.archived ? isNotNull(projects.archivedAt) : isNull(projects.archivedAt)];
  // everyone's, or a private one at a client they handle, or one they lead
  where.push(visibleProject(v));
  if (f.ids) where.push(f.ids.length ? inArray(projects.id, f.ids) : sql`false`);
  if (f.clientId) where.push(eq(projects.clientId, f.clientId));
  if (f.serviceId) where.push(eq(projects.serviceId, f.serviceId));
  if (f.leadId) where.push(eq(projects.leadId, f.leadId));
  if (f.status) where.push(eq(projects.status, f.status));
  if (f.open) where.push(inArray(projects.status, ["active", "on_hold"]));
  const rows = await db
    .select({ p: projects, client: { id: clients.id, slug: clients.slug, name: clients.name }, clientPrivate: clients.private, service: { id: services.id, slug: services.slug, name: services.name }, servicePrivate: services.private, lead: { id: users.id, name: users.name, email: users.email } })
    .from(projects)
    .innerJoin(clients, eq(clients.id, projects.clientId))
    .leftJoin(services, eq(services.id, projects.serviceId))
    .leftJoin(users, eq(users.id, projects.leadId))
    .where(and(...where))
    // active first, then on hold, done, cancelled; soonest due first
    .orderBy(sql`array_position(array['active','on_hold','done','cancelled'], ${projects.status})`, sql`${projects.dueOn} asc nulls last`, asc(projects.name));
  if (!rows.length) return [];
  const fieldList = await listFields(workspaceId, "project");
  const open = await db
    .select({ projectId: tasks.projectId, n: sql<number>`count(*)`.mapWith(Number) })
    .from(tasks)
    .where(and(inArray(tasks.projectId, rows.map((r) => r.p.id)), inArray(tasks.status, ["todo", "doing", "waiting"])))
    .groupBy(tasks.projectId);
  return rows.map(({ p, client, clientPrivate, service, servicePrivate, lead }) => ({
    id: p.id,
    slug: p.slug,
    name: p.name,
    client,
    // a private service isn't named to someone who can't see it
    service: service?.id && (all || !servicePrivate) ? service : null,
    lead: lead?.id ? { id: lead.id, name: lead.name ?? lead.email } : null,
    status: p.status,
    startOn: p.startOn,
    dueOn: p.dueOn,
    amount: p.amount === null ? null : Number(p.amount),
    currency: p.currency,
    period: p.period,
    feeNote: p.feeNote,
    openTasks: open.find((o) => o.projectId === p.id)?.n ?? 0,
    details: detailsOf(fieldList, p.details),
    // its own switch, or its client's
    private: p.private || clientPrivate,
    privateBecause: !p.private && clientPrivate ? client.name : null,
    doneAt: p.doneAt?.toISOString() ?? null,
    archivedAt: p.archivedAt?.toISOString() ?? null,
    updatedAt: p.updatedAt.toISOString(),
  }));
}

// By slug, exact name, then a unique part of a name (a client's name in it too: "northwind website")
export async function findProject(v: Viewer, q: string, exact = false, archived = false) {
  const all = await listProjects(v, { archived });
  const hit = findIn(all, q, "project", exact);
  if (typeof hit !== "string" || exact) return hit;
  const s = clean(q).toLowerCase();
  const loose = all.filter((p) => `${p.client.name} ${p.name}`.toLowerCase().includes(s));
  return loose.length === 1 ? loose[0]! : hit;
}
const one = async (workspaceId: string, id: string, archived = false) => (await listProjects(workspaceId, { ids: [id], archived }))[0]!;

// The columns for what's given; a string is what's wrong
async function values(w: Who, i: ProjectInput) {
  const v: Partial<typeof projects.$inferInsert> = {};
  const named: Record<string, unknown> = {};
  if (i.name !== undefined) {
    v.name = clean(i.name).slice(0, 200);
    if (!slugOf(v.name)) return "a project needs a name";
  }
  if (i.client !== undefined) {
    const c = await findClient(w, i.client);
    if (typeof c === "string") return c;
    if (c.archivedAt) return `${c.name} is archived`;
    v.clientId = c.id;
    named.client = c;
  }
  if (i.service !== undefined) {
    if (i.service === null || !clean(i.service)) v.serviceId = null;
    else {
      const s = await findService(w, i.service);
      if (typeof s === "string") return s;
      v.serviceId = s.id;
      named.service = s;
    }
  }
  if (i.lead !== undefined) {
    if (i.lead === null || !clean(i.lead) || clean(i.lead).toLowerCase() === "none") v.leadId = null;
    else {
      const m = personIn(await listTeam(w.workspaceId), i.lead, w.userId);
      if (typeof m === "string") return m;
      v.leadId = m.id;
    }
  }
  if (i.status !== undefined) {
    const s = STATUS_WORDS[clean(i.status).toLowerCase().replace(/_/g, " ")] ?? STATUS_WORDS[clean(i.status).toLowerCase()];
    if (!s) return `the status is one of ${PROJECT_STATUSES.map(statusName).join(", ")}`;
    v.status = s;
  }
  for (const [k, col] of [["startOn", "startOn"], ["dueOn", "dueOn"]] as const)
    if (i[k] !== undefined) {
      const d = dateOnly(i[k]);
      if (d !== null && typeof d === "object") return d.error;
      v[col] = d;
    }
  if (i.amount !== undefined) {
    const currency = await currencyOf(w.workspaceId);
    const a = parseAmount(i.amount, currency);
    if (a !== null && typeof a === "object") return a.error;
    v.amount = a === null ? null : String(a);
    v.currency = a === null ? null : currency;
  }
  if (i.period !== undefined) {
    if (i.period !== null && !MONEY_PERIODS.includes(i.period)) return `the period is one of ${MONEY_PERIODS.join(", ")}`;
    v.period = i.period;
  }
  if (i.feeNote !== undefined) v.feeNote = orNull(i.feeNote)?.slice(0, 200) ?? null;
  if (v.startOn && v.dueOn && v.dueOn < v.startOn) return "it can't be due before it starts";
  return { v, named: named as { client?: { id: string; slug: string; name: string; private: boolean }; service?: { id: string; name: string; amount: number | null; currency: string | null; period: MoneyPeriod | null; priceNote: string | null; process: string | null } } };
}
const ADMIN_ONLY = ["lead", "amount", "period", "feeNote"] as const;

// For history: names, not ids
async function readable(workspaceId: string, v: Record<string, unknown>) {
  const out = { ...v };
  delete out.clientId;
  delete out.serviceId;
  delete out.leadId;
  delete out.currency;
  const name = async (t: typeof clients | typeof services, id: unknown) => (id ? ((await db.select({ name: t.name }).from(t).where(eq(t.id, id as string)))[0]?.name ?? null) : null);
  if ("clientId" in v) out.client = await name(clients, v.clientId);
  if ("serviceId" in v) out.service = await name(services, v.serviceId);
  if ("leadId" in v) out.lead = v.leadId ? ((await listTeam(workspaceId)).find((m) => m.id === v.leadId)?.name ?? null) : null;
  if (out.amount !== undefined && out.amount !== null) out.amount = Number(out.amount);
  if (typeof out.status === "string") out.status = statusName(out.status as ProjectStatus);
  if (out.doneAt) delete out.doneAt;
  return out;
}

export async function addProject(w: Who, input: ProjectInput & { force?: boolean }): Promise<Result> {
  if (!clean(input.name)) return { ok: false, error: "a project needs a name" };
  if (!clean(input.client)) return { ok: false, error: "a project is for a client: say which (--client <name>)" };
  if (input.private && !isAdmin(w)) return { ok: false, error: "only the owner or an admin can make a project private" };
  if (!isAdmin(w) && (["amount", "period", "feeNote"] as const).some((k) => input[k] !== undefined && input[k] !== null))
    return { ok: false, error: "only the owner or an admin sets a fee; add it without one (it takes the service's price)" };
  const r = await values(w, input);
  if (typeof r === "string") return { ok: false, error: r };
  const { v, named } = r;
  const client = named.client!;
  const all = [...(await listProjects(w.workspaceId)), ...(await listProjects(w.workspaceId, { archived: true }))];
  const same = all.find((p) => p.client.id === client.id && p.name.toLowerCase() === v.name!.toLowerCase() && !p.archivedAt && (p.status === "active" || p.status === "on_hold"));
  if (same && !input.force) return { ok: false,
      match: matchOf(same), error: `${client.name} has ${same.name} already (emplio projects show ${same.slug}); another one: add with --force` };
  // the service's price when no fee is given
  const s = named.service;
  if (s && input.amount === undefined && s.amount !== null) Object.assign(v, { amount: String(s.amount), currency: s.currency, period: s.period });
  if (s && input.feeNote === undefined && s.priceNote) v.feeNote = s.priceNote;
  if (s && input.period === undefined && !v.period) v.period = s.period;
  const own = slugOf(v.name!);
  const slug = freeSlug(own.startsWith(client.slug) ? own : `${client.slug}-${own}`, all.map((p) => p.slug), "project");
  const fieldList = await listFields(w.workspaceId, "project");
  const id = await db.transaction(async (tx) => {
    const d = await nextDetails(tx, w, "project", fieldList, {}, input.details ?? {});
    if ("error" in d) return { error: d.error! };
    const [row] = await tx
      .insert(projects)
      // a private client's projects are private with it
      .values({ ...v, details: d.details, private: !!input.private, workspaceId: w.workspaceId, slug, name: v.name!, clientId: client.id, status: v.status ?? "active", doneAt: v.status === "done" ? new Date() : null, startOn: v.startOn ?? new Date().toISOString().slice(0, 10) })
      .returning();
    await logChange(tx, w, {
      kind: "project",
      id: row!.id,
      clientId: client.id,
      summary: `Added project ${v.name} for ${client.name}`,
      changes: [...diff(null, await readable(w.workspaceId, { ...v, clientId: client.id })), ...detailChanges(fieldList, null, d.details)],
      detail: same ? { forced: true, matched: { slug: same.slug, name: same.name } } : undefined,
    });
    return row!.id;
  });
  if (typeof id === "object") return { ok: false, error: id.error };
  // the service's process starts for it
  let started: string | undefined;
  if (s?.process) {
    const { startRun } = await import("./processes");
    started = await startRun(w, s.process, { client: client.slug, projectId: id })
      .then((run) => (run ? `started "${run.processTitle}" for it` : undefined))
      .catch((error) => `its process "${s.process}" didn't start: ${error instanceof Error ? error.message : error}`);
  }
  return { ok: true, project: await one(w.workspaceId, id), started };
}

export async function updateProject(w: Who, q: string, input: ProjectInput, exact = false): Promise<Result> {
  const adminAsked = [...ADMIN_ONLY.filter((k) => input[k] !== undefined), ...(input.client !== undefined ? ["client"] : []), ...(input.private !== undefined ? ["private"] : [])];
  if (!isAdmin(w) && adminAsked.length) return { ok: false, error: `only the owner or an admin changes a project's ${adminAsked.join(", ")}` };
  const p = await findProject(w, q, exact);
  if (typeof p === "string") return { ok: false, error: p };
  const r = await values(w, input);
  if (typeof r === "string") return { ok: false, error: r };
  const { v, named } = r;
  const fieldList = await listFields(w.workspaceId, "project");
  const err = await db.transaction(async (tx) => {
    const [row] = await tx.select().from(projects).where(eq(projects.id, p.id)).for("update");
    const late = await stale(row!, input.updatedAt, p.name, "project", w);
    if (late) return late;
    const d = input.details ? await nextDetails(tx, w, "project", fieldList, row!.details, input.details) : { details: row!.details };
    if ("error" in d) return d.error!;
    const fieldChanges = detailChanges(fieldList, row!.details, d.details);
    const start = v.startOn !== undefined ? v.startOn : row!.startOn;
    const due = v.dueOn !== undefined ? v.dueOn : row!.dueOn;
    if (start && due && due < start) return "it can't be due before it starts";
    if (v.status && v.status !== row!.status) v.doneAt = v.status === "done" ? new Date() : null;
    const old = { ...row!, amount: row!.amount === null ? null : String(Number(row!.amount)) };
    const next = { ...v, ...(v.amount !== undefined && { amount: v.amount === null ? null : String(Number(v.amount)) }) };
    // by column name (diff's own labels are for people), so readable turns ids into names
    const keys = Object.keys(next).filter((k) => k !== "doneAt" && k !== "currency");
    const changed = diff(old, Object.fromEntries(keys.map((k) => [k, next[k as keyof typeof next]])), Object.fromEntries(keys.map((k) => [k, k])));
    if (!changed.length && !fieldChanges.length) return null;
    const changes = [...fieldChanges, ...diff(await readable(w.workspaceId, Object.fromEntries(changed.map((c) => [c.field, c.from]))), await readable(w.workspaceId, Object.fromEntries(changed.map((c) => [c.field, c.to]))), { amount: "fee", period: "fee period" })];
    await tx.update(projects).set({ ...v, details: d.details, updatedAt: new Date() }).where(eq(projects.id, p.id));
    // moved to another client: its work moves with it
    if (v.clientId && v.clientId !== row!.clientId)
      for (const t of [tasks, processRuns]) await tx.update(t).set({ clientId: v.clientId }).where(eq(t.projectId, p.id));
    await logChange(tx, w, { kind: "project", id: p.id, clientId: [v.clientId ?? row!.clientId, row!.clientId], summary: `Changed ${changes.map((c) => c.field).join(", ")} of ${p.name}`, changes });
    return null;
  });
  if (err) return { ok: false, error: err };
  if (input.private === false && p.privateBecause) return { ok: false, error: `${p.name} is private because ${p.privateBecause} is; share ${p.privateBecause} to share it` };
  if (input.private !== undefined) {
    const e = await setPrivate(w, "project", p.id, input.private);
    if (e) return { ok: false, error: e };
  }
  const now = await one(w.workspaceId, p.id);
  // moved to a client that's private, or away from one: its notes follow
  const e = await followNotes(w.workspaceId, "project", now, p.private, now.private);
  if (e) return { ok: false, error: e };
  return { ok: true, project: now };
}

export async function archiveProject(w: Who, q: string, archive: boolean, o: { exact?: boolean; withWork?: boolean } = {}): Promise<Result> {
  if (!isAdmin(w)) return { ok: false, error: `only the owner or an admin can ${archive ? "archive" : "bring back"} a project; mark it done or cancelled instead` };
  const p = await findProject(w, q, o.exact, !archive);
  if (typeof p === "string") return { ok: false, error: p };
  if (archive && p.openTasks && !o.withWork) return { ok: false, error: `${p.name} has ${count(p.openTasks, "open task")}; finish them first, or archive with the work (--with-work)` };
  await db.transaction(async (tx) => {
    await tx.update(projects).set({ archivedAt: archive ? new Date() : null, updatedAt: new Date() }).where(eq(projects.id, p.id));
    await logChange(tx, w, { kind: "project", id: p.id, clientId: p.client.id, summary: `${archive ? "Archived" : "Brought back"} ${p.name}`, changes: [{ field: "archived", from: !archive, to: archive }] });
  });
  return { ok: true, project: await one(w.workspaceId, p.id, archive) };
}

export async function purgeProject(w: Who, slug: string) {
  if (w.role !== "owner") return { ok: false as const, error: "only the owner can delete a project for good" };
  const p = await findProject(w.workspaceId, slug, true, true);
  if (typeof p === "string") return { ok: false as const, error: "archive it first" };
  const n = async (t: typeof tasks | typeof processRuns) => (await db.select({ n: sql<number>`count(*)`.mapWith(Number) }).from(t).where(eq(t.projectId, p.id)))[0]!.n;
  const [t, r] = await Promise.all([n(tasks), n(processRuns)]);
  if (t || r) return { ok: false as const, error: `${p.name} still has ${[t && count(t, "task"), r && count(r, "process run")].filter(Boolean).join(" and ")}; it stays archived` };
  return purging(p.name, () =>
    db.transaction(async (tx) => {
      await tx.delete(projects).where(eq(projects.id, p.id));
      await logChange(tx, w, { kind: "project", id: p.id, clientId: p.client.id, summary: `Deleted ${p.name} for good`, changes: [] });
    }),
  );
}

// --- `emplio projects` ---

export const USAGE = `usage: emplio projects list [--client <name>] [--service <name>] [--lead <name>] [--status <status>] [--all] [--archived]
                                                    open projects (active, on hold); --all: done and cancelled too
       emplio projects show <name>
       emplio projects add <name> --client <name> [options]   one client buying one service
       emplio projects update <name> [options]          only what you name changes
       emplio projects archive <name> [--with-work] | restore <name>   (owner and admins)
       emplio projects fields list|add|update|remove   this business's project fields (owner and admins change them)
options: --service <name>      what they bought (emplio services list); its price is the fee unless one is given, its process starts
         --lead <name>         who on the team leads it: a name, email or "me"; "none" clears it
         --status active|on hold|done|cancelled
         --start <YYYY-MM-DD> --due <YYYY-MM-DD>   "none" clears one; a retainer has no due date
         --amount <fee> --period once|monthly|yearly|hourly --note <about the fee>
         --client <name>       update: move it (and its work) to another client
         --name <new name>     update only; its slug stays
         --private yes|no      owners and admins only see it (a private client's projects are); its notes move to restricted/
         --updated-at <time>   update only: the updatedAt you read
         "Field=value"         one of the business's project fields: "PO number=4500123"; "Field=" empties it
Projects live in the database: change them only with this command. A task in one: emplio tasks add ... --project <name>.`;

const feeOf = (p: Project) => [money(p.amount, p.currency, p.period), p.feeNote].filter(Boolean).join(" ");
const line = (p: Project) => [p.slug, statusName(p.status), p.client.name, p.name, p.lead ? `led by ${p.lead.name}` : "no lead", p.dueOn ? `due ${p.dueOn}` : "", `${p.openTasks} open`].join("\t");

export async function projectsCommand(base: Omit<Who, "via" | "conversationId">, conversationId: string, args: string[], data = false): Promise<string> {
  const w: Who = { ...base, via: "emplio", conversationId };
  const [sub, ...rest] = args;
  if (sub === "fields") return fieldsCommand(w, "project", rest);
  const { words, opts, flags, pairs } = parseArgs(rest);
  const name = words.join(" ");
  const none = (v: string | undefined) => (v === undefined ? undefined : v.trim().toLowerCase() === "none" ? null : v);
  const input = (): ProjectInput => {
    const i: ProjectInput = {};
    if (pairs.length) i.details = Object.fromEntries(pairs);
    if (opts.name !== undefined) i.name = opts.name;
    if (opts.client !== undefined) i.client = opts.client;
    if (opts.service !== undefined) i.service = none(opts.service);
    if (opts.lead !== undefined) i.lead = none(opts.lead);
    if (opts.status !== undefined) i.status = opts.status as ProjectStatus;
    if (opts.start !== undefined) i.startOn = none(opts.start);
    if (opts.due !== undefined) i.dueOn = none(opts.due);
    if (opts.amount !== undefined) i.amount = none(opts.amount);
    if (opts.period !== undefined) i.period = (none(opts.period) === null ? null : periodOf(opts.period)) as MoneyPeriod | null;
    if (opts.note !== undefined) i.feeNote = none(opts.note);
    if (opts["updated-at"]) i.updatedAt = opts["updated-at"];
    const priv = privateOf(opts, flags);
    if (priv !== undefined) i.private = priv;
    return i;
  };
  if (sub === "list") {
    const f: F = { archived: flags.has("archived"), open: !flags.has("all") && !opts.status };
    if (opts.client) {
      const c = await findClient(w, opts.client);
      if (typeof c === "string") return `error: ${c}`;
      f.clientId = c.id;
    }
    if (opts.service) {
      const s = await findService(w, opts.service);
      if (typeof s === "string") return `error: ${s}`;
      f.serviceId = s.id;
    }
    if (opts.lead) {
      const m = personIn(await listTeam(w.workspaceId), opts.lead, w.userId);
      if (typeof m === "string") return `error: ${m}`;
      f.leadId = m.id;
    }
    if (opts.status) {
      const s = STATUS_WORDS[clean(opts.status).toLowerCase()];
      if (!s) return `error: the status is one of ${PROJECT_STATUSES.map(statusName).join(", ")}`;
      f.status = s;
    }
    const list = await listProjects(w, f);
    if (data) return JSON.stringify(list);
    return list.length ? list.map(line).join("\n") : "No projects here. Add one with emplio projects add <name> --client <client> --service <service>.";
  }
  if (sub === "show" && name) {
    const p = await findProject(w, name);
    if (typeof p === "string") return `error: ${p}`;
    if (data) return JSON.stringify(p);
    const [history, open] = await Promise.all([
      historyOf(w.workspaceId, { kind: "project", id: p.id }, 8),
      db.select({ id: tasks.id, title: tasks.title, status: tasks.status, dueAt: tasks.dueAt }).from(tasks).where(and(eq(tasks.projectId, p.id), inArray(tasks.status, ["todo", "doing", "waiting"]))).orderBy(sql`${tasks.dueAt} asc nulls last`).limit(30),
    ]);
    return [
      `${p.name} (${p.slug}) · ${statusName(p.status)}${p.private ? " · PRIVATE (owners, admins, its client's handlers and its lead)" : ""}${p.archivedAt ? " · ARCHIVED" : ""} · updatedAt ${p.updatedAt}`,
      `client: ${p.client.name} (${p.client.slug})`,
      `service: ${p.service ? `${p.service.name} (${p.service.slug})` : "none"}`,
      `lead: ${p.lead?.name ?? "nobody yet"}`,
      `dates: ${p.startOn ? `from ${p.startOn}` : "no start"}${p.dueOn ? `, due ${p.dueOn}` : ", no due date"}${p.doneAt ? `, done ${p.doneAt.slice(0, 10)}` : ""}`,
      ...(feeOf(p) ? [`fee: ${feeOf(p)}`] : []),
      ...p.details.map((d) => `${d.name}: ${d.value}`),
      ...(open.length ? [`open tasks (${p.openTasks}):`, ...open.map((t) => `- ${t.id.slice(0, 8)} ${t.status} ${t.dueAt ? t.dueAt.toISOString().slice(0, 10) : "no due date"} ${t.title}`)] : ["no open tasks"]),
      ...(history.length ? ["recent changes:", ...history.map((h) => `- ${h.at.slice(0, 10)} ${h.who ?? "Emplio"}: ${h.summary}`)] : []),
      `notes: ${notesAt(w, "project", p)}`,
    ].join("\n");
  }
  if (sub === "add" && name) {
    const r = await addProject(w, { ...input(), name, force: flags.has("force") });
    return r.ok ? `added ${line(r.project)}${r.started ? `; ${r.started}` : ""}` : `error: ${r.error}`;
  }
  if (sub === "update" && name) {
    const i = input();
    if (!Object.keys(i).filter((k) => k !== "updatedAt").length) return USAGE;
    if (ADMIN_ONLY.some((k) => k !== "lead" && i[k] !== undefined) && !i.updatedAt) return `error: a fee change needs --updated-at (the updatedAt from emplio projects show ${name}), so a newer change isn't overwritten`;
    const r = await updateProject(w, name, i);
    return r.ok ? `updated ${line(r.project)}` : `error: ${r.error}`;
  }
  if ((sub === "archive" || sub === "remove" || sub === "restore") && name) {
    const r = await archiveProject(w, name, sub !== "restore", { withWork: flags.has("with-work") });
    return r.ok ? `${sub === "restore" ? "brought back" : "archived"} ${r.project.name}` : `error: ${r.error}`;
  }
  return USAGE;
}

const BODY = {
  type: "object",
  additionalProperties: false,
  properties: {
    name: { type: "string", maxLength: 200 },
    client: { type: "string", maxLength: 200 },
    service: { type: ["string", "null"], maxLength: 200 },
    lead: { type: ["string", "null"], maxLength: 200 },
    status: { type: "string", maxLength: 20 },
    startOn: { type: ["string", "null"], maxLength: 10 },
    dueOn: { type: ["string", "null"], maxLength: 10 },
    amount: { anyOf: [{ type: "number" }, { type: "string", maxLength: 40 }, { type: "null" }] },
    period: { type: ["string", "null"] },
    feeNote: { type: ["string", "null"], maxLength: 200 },
    private: { type: "boolean" },
    details: { type: "object", maxProperties: 50, additionalProperties: { type: ["string", "null"], maxLength: 500 } },
    updatedAt: { type: "string", maxLength: 40 },
    force: { type: "boolean" },
  },
};

export async function projectRoutes(app: FastifyInstance) {
  app.get<{ Querystring: { archived?: string; client?: string; all?: string } }>("/projects", async (req, reply) => {
    const ctx = await context(req, reply);
    if (!ctx) return;
    const c = req.query.client ? await findClient(ctx, req.query.client, true) : null;
    if (typeof c === "string") return reply.code(400).send({ error: c });
    return listProjects(ctx, { archived: req.query.archived === "1", clientId: c?.id, open: req.query.all !== "1" && req.query.archived !== "1" });
  });
  app.get<{ Params: { slug: string } }>("/projects/:slug", async (req, reply) => {
    const ctx = await context(req, reply);
    if (!ctx) return;
    const p = await findProject(ctx, req.params.slug, true);
    const found = typeof p === "string" ? await findProject(ctx, req.params.slug, true, true) : p;
    if (typeof found === "string") return reply.code(404).send({ error: "No such project." });
    const { listTasks } = await import("./tasks");
    return { project: found, tasks: await listTasks(ctx, { projectId: found.id }), history: await historyOf(ctx.workspaceId, { kind: "project", id: found.id }) };
  });
  app.post<{ Body: ProjectInput & { force?: boolean } }>("/projects", { schema: { body: { ...BODY, required: ["name", "client"] } } }, async (req, reply) => {
    const ctx = await context(req, reply);
    if (!ctx) return;
    const r = await addProject(ctx, req.body);
    return r.ok ? { ...r.project, started: r.started ?? null } : reply.code(400).send({ error: r.error, match: r.match });
  });
  app.patch<{ Params: { slug: string }; Body: ProjectInput }>("/projects/:slug", { schema: { body: BODY } }, async (req, reply) => {
    const ctx = await context(req, reply);
    if (!ctx) return;
    const r = await updateProject(ctx, req.params.slug, req.body, true);
    return r.ok ? r.project : reply.code(400).send({ error: r.error, match: r.match });
  });
  for (const [path, archive] of [["archive", true], ["restore", false]] as const)
    app.post<{ Params: { slug: string }; Body: { withWork?: boolean } }>(`/projects/:slug/${path}`, async (req, reply) => {
      const ctx = await context(req, reply);
      if (!ctx) return;
      const r = await archiveProject(ctx, req.params.slug, archive, { exact: true, withWork: !!req.body?.withWork });
      return r.ok ? r.project : reply.code(400).send({ error: r.error, match: r.match });
    });
  app.delete<{ Params: { slug: string } }>("/projects/:slug", async (req, reply) => {
    const ctx = await context(req, reply);
    if (!ctx) return;
    const r = await purgeProject(ctx, req.params.slug);
    return r.ok ? r : reply.code(400).send({ error: r.error });
  });
}
