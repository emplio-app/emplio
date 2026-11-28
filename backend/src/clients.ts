// Clients: who the business works for. Rows (records.ts says the rules every record keeps): a name, a stage from the
// business's own list (client_stages: Onboarding, Retainer, On hold, each a prospect, active or past one), who on the
// team handles them, and the business's own client fields (client_fields: Tax number, Files) filled in. Their notes
// are the file company/clients/<slug>/index.md, words only. Tasks, process runs, chats and projects point at the id.
// Anyone adds clients and fills in their fields; the stage, who handles them, archiving and the lists of stages and
// fields are the owner's and admins'; deleting for good is the owner's alone, and only for one nothing points at.
import { and, asc, eq, inArray, isNotNull, isNull, sql, type SQL } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import {
  STAGE_CATEGORIES,
  type Client,
  type ClientDetail,
  type ClientField,
  type ClientInput,
  type ClientPage,
  type ClientStage,
  type StageCategory,
} from "@emplio/shared";
import { context } from "./auth";
import { db } from "./db";
import { detailKey, detailsOf, fieldsCommand, listFields, nextDetails } from "./fields";
import { notesDir, setPrivate, notesAt } from "./private";
import { clientHandlers, clients, clientStages, contactClients, conversations, processRuns, projects, tasks, users } from "./db/schema";
import { linkedFrom } from "./knowledge";
import { listTeam } from "./team";
import { purging,
  clean,
  closeMatch,
  count,
  diff,
  findIn,
  freeSlug,
  historyOf,
  isAdmin,
  logChange,
  parseArgs,
  personIn,
  slugOf,
  stale,
  type Tx,
  type Who, matchOf, type Match, privateOf, seesPrivate, type Viewer, wsOf, say, visibleClient, visibleProject } from "./records";

export { slugOf, detailKey };
type Result = { ok: true; client: Client } | { ok: false; error: string; match?: Match };
type Row = typeof clients.$inferSelect;

export const FOLDER = "clients";
export const notesPath = (c: { slug: string; private?: boolean }) => `${notesDir("client", c)}/index.md`;
const OPEN = ["todo", "doing", "waiting"] as const;

export const detailOf = (c: { details: ClientDetail[] }, name: string) => c.details.find((d) => d.key === detailKey(name) || detailKey(d.name) === detailKey(name))?.value;

// --- stages ---

const SEED: [string, StageCategory][] = [
  ["Prospect", "prospect"],
  ["Active", "active"],
  ["Past", "past"],
];

export async function listStages(workspaceId: string): Promise<ClientStage[]> {
  const read = () => db.select().from(clientStages).where(eq(clientStages.workspaceId, workspaceId)).orderBy(asc(clientStages.position), asc(clientStages.name));
  let rows = await read();
  if (!rows.length) {
    // every business starts with these three; renamed, added to or removed from in Settings
    await db.insert(clientStages).values(SEED.map(([name, category], position) => ({ workspaceId, name, category, position }))).onConflictDoNothing();
    rows = await read();
  }
  return rows.map(({ id, name, category, position }) => ({ id, name, category, position }));
}

// By name (any case), or a category's word (active: the first active stage). A string is what's wrong.
export function stageIn(all: ClientStage[], q: string): ClientStage | string {
  const s = clean(q).toLowerCase();
  const hit = all.find((x) => x.name.toLowerCase() === s) ?? all.find((x) => x.category === s) ?? all.find((x) => slugOf(x.name) === slugOf(s));
  return hit ?? `"${q}" isn't one of this business's stages: ${all.map((x) => x.name).join(", ")} (an owner or admin adds one: emplio clients stages add "${clean(q)}" --category prospect|active|past)`;
}

// --- reading ---

export async function listClients(v: Viewer, f: { archived?: boolean; ids?: string[]; category?: StageCategory } = {}): Promise<Client[]> {
  const w = { workspaceId: wsOf(v) };
  const where: (SQL | undefined)[] = [eq(clients.workspaceId, w.workspaceId), f.archived ? isNotNull(clients.archivedAt) : isNull(clients.archivedAt)];
  // a private one only to owners, admins and whoever handles them
  where.push(visibleClient(v, clients.id, clients.private));
  if (f.ids) where.push(f.ids.length ? inArray(clients.id, f.ids) : sql`false`);
  if (f.category) where.push(eq(clientStages.category, f.category));
  const [rows, fields] = await Promise.all([
    db
      .select({ c: clients, stage: clientStages.name, category: clientStages.category })
      .from(clients)
      .innerJoin(clientStages, eq(clientStages.id, clients.stageId))
      .where(and(...where))
      .orderBy(asc(sql`lower(${clients.name})`)),
    listFields(w.workspaceId, "client"),
  ]);
  if (!rows.length) return [];
  const ids = rows.map((r) => r.c.id);
  const [handlers, work, active] = await Promise.all([
    db
      .select({ clientId: clientHandlers.clientId, id: users.id, name: users.name, email: users.email })
      .from(clientHandlers)
      .innerJoin(users, eq(users.id, clientHandlers.userId))
      .where(inArray(clientHandlers.clientId, ids)),
    db
      .select({
        clientId: tasks.clientId,
        open: sql<number>`count(*) filter (where ${tasks.status} in ('todo', 'doing', 'waiting'))`.mapWith(Number),
        waiting: sql<number>`count(*) filter (where ${tasks.status} = 'waiting')`.mapWith(Number),
      })
      .from(tasks)
      .where(and(eq(tasks.workspaceId, w.workspaceId), inArray(tasks.clientId, ids)))
      .groupBy(tasks.clientId),
    db
      .select({ clientId: projects.clientId, n: sql<number>`count(*)`.mapWith(Number) })
      .from(projects)
      .where(and(inArray(projects.clientId, ids), eq(projects.status, "active"), isNull(projects.archivedAt), visibleProject(v)))
      .groupBy(projects.clientId),
  ]);
  return rows.map(({ c, stage, category }) => ({
    id: c.id,
    slug: c.slug,
    name: c.name,
    stage,
    stageCategory: category,
    handlers: handlers.filter((h) => h.clientId === c.id).map((h) => ({ id: h.id, name: h.name ?? h.email })),
    details: detailsOf(fields, c.details),
    openTasks: work.find((x) => x.clientId === c.id)?.open ?? 0,
    waitingTasks: work.find((x) => x.clientId === c.id)?.waiting ?? 0,
    activeProjects: active.find((x) => x.clientId === c.id)?.n ?? 0,
    externalIds: c.externalIds,
    private: c.private,
    archivedAt: c.archivedAt?.toISOString() ?? null,
    updatedAt: c.updatedAt.toISOString(),
  }));
}

// By slug, exact name, then a unique part of a name; archived ones only when nothing current matches.
// ponytail: loads the business's clients to look; a firm with 10k+ wants a query of its own
export async function findClient(v: Viewer, q: string, exact = false): Promise<Client | string> {
  const hit = findIn(await listClients(v), q, "client", exact);
  if (typeof hit !== "string") return hit;
  const old = findIn(await listClients(v, { archived: true }), q, "client", true);
  return typeof old === "string" ? hit : old;
}
const one = async (workspaceId: string, id: string, archived = false) => (await listClients(workspaceId, { ids: [id], archived }))[0]!;

// A schedule's clients: list: all (*), names, and Field=value (every active client with that value, any case)
export function pickClients<T extends { slug: string; name: string; stageCategory: StageCategory; details: ClientDetail[] }>(all: T[], list: string[]): T[] {
  const wanted = list.map((c) => c.trim().toLowerCase());
  const working = (c: T) => c.stageCategory === "active";
  if (wanted.includes("*")) return all.filter(working);
  const byDetail = wanted.flatMap((w) => (w.includes("=") ? [w.split("=").map((s) => s.trim()) as [string, string]] : []));
  return all.filter(
    (c) =>
      (c.stageCategory !== "past" && (wanted.includes(c.slug) || wanted.includes(c.name.toLowerCase()) || wanted.includes(slugOf(c.name)))) ||
      (working(c) && byDetail.some(([k, v]) => detailOf(c, k)?.toLowerCase() === v)),
  );
}

// --- writing ---

async function handlerIds(w: Who, asked: string[]) {
  const team = await listTeam(w.workspaceId);
  const ids: string[] = [];
  for (const raw of asked) {
    if (!clean(raw)) continue;
    const m = personIn(team, raw, w.userId);
    if (typeof m === "string") return { error: m };
    ids.push(m.id);
  }
  return { ids: [...new Set(ids)], names: (ids: string[]) => ids.map((id) => team.find((m) => m.id === id)?.name ?? team.find((m) => m.id === id)?.email ?? id) };
}

// New-client automations run when a client becomes active: added as one, or moved from a prospect stage
// ponytail: imported when needed; automations.ts reads clients through this file
const becameActive = (workspaceId: string, slug: string) =>
  void import("./automations").then((a) => a.forNewClient(workspaceId, slug)).catch((error) => console.error("new-client automations failed", slug, error));

export async function addClient(w: Who, input: ClientInput): Promise<Result> {
  const name = clean(input.name).slice(0, 200);
  if (!slugOf(name)) return { ok: false, error: "a client needs a name" };
  const [stages, fields, current, archived] = await Promise.all([listStages(w.workspaceId), listFields(w.workspaceId, "client"), listClients(w.workspaceId), listClients(w.workspaceId, { archived: true })]);
  const stage = stageIn(stages, input.stage ?? "active");
  if (typeof stage === "string") return { ok: false, error: stage };
  const match = closeMatch([...current, ...archived], name);
  if (input.private && !isAdmin(w)) return { ok: false, error: "only the owner or an admin can make a client private" };
  // one they can't see: not named to them
  if (match?.private && !seesPrivate(w)) return { ok: false, error: "the owner or an admin already keeps a client like that; ask them" };
  if (match && !input.force)
    return {
      ok: false,
      match: matchOf(match),
      error: match.archivedAt
        ? `${match.name} is an archived client; ${say(w, "bring them back from the archived clients, or add a new one anyway", `bring them back with emplio clients restore ${match.slug}, or add a new one with --force`)}`
        : `did you mean ${match.name}? (emplio clients show ${match.slug}); if this is another client, add it with --force`,
    };
  const people = input.handlers ? await handlerIds(w, input.handlers) : null;
  if (people && "error" in people) return { ok: false, error: people.error! };
  const slug = freeSlug(name, [...current, ...archived].map((c) => c.slug), "client");
  const made = await db.transaction(async (tx) => {
    const d = await nextDetails(tx, w, "client", fields, {}, input.details ?? {});
    if ("error" in d) return d.error!;
    const [row] = await tx
      .insert(clients)
      .values({ workspaceId: w.workspaceId, slug, name, stageId: stage.id, details: d.details, externalIds: cleanIds({}, input.externalIds), private: !!input.private })
      .returning();
    if (people?.ids.length) await tx.insert(clientHandlers).values(people.ids.map((userId) => ({ clientId: row!.id, userId })));
    await logChange(tx, w, {
      kind: "client",
      id: row!.id,
      clientId: row!.id,
      summary: `Added client ${name}`,
      changes: diff(null, { name, stage: stage.name, ...(people?.ids.length && { handlers: people.names(people.ids) }), ...(input.private && { private: true }), ...d.details }, Object.fromEntries(fields.map((f) => [f.key, f.name]))),
      detail: match ? { forced: true, matched: { slug: match.slug, name: match.name } } : undefined,
    });
    return row!;
  });
  if (typeof made === "string") return { ok: false, error: made };
  if (stage.category === "active") becameActive(w.workspaceId, slug);
  return { ok: true, client: await one(w.workspaceId, made.id) };
}

const cleanIds = (old: Record<string, string>, given: Record<string, string | null> | undefined) => {
  const out = { ...old };
  for (const [k, v] of Object.entries(given ?? {})) {
    const key = clean(k).toLowerCase();
    if (!key) continue;
    if (clean(v)) out[key] = clean(v);
    else delete out[key];
  }
  return out;
};

// exact: the app names one by its slug; a part of a name is for chats. Only the fields given change.
export async function updateClient(w: Who, q: string, input: ClientInput, exact = false): Promise<Result> {
  const admin = ["name", "stage", "handlers", "externalIds", "private"].filter((k) => input[k as keyof ClientInput] !== undefined);
  if (!isAdmin(w) && admin.length) return { ok: false, error: `only the owner or an admin can change a client's ${admin.join(", ")} (anyone can fill in their fields)` };
  const found = await findClient(w, q, exact);
  if (typeof found === "string") return { ok: false, error: found };
  if (found.archivedAt) return { ok: false, error: `${found.name} is archived; bring them back first${say(w, "", `: emplio clients restore ${found.slug}`)}` };
  const [stages, fields] = await Promise.all([listStages(w.workspaceId), listFields(w.workspaceId, "client")]);
  const stage = input.stage !== undefined ? stageIn(stages, input.stage) : null;
  if (typeof stage === "string") return { ok: false, error: stage };
  if (input.name !== undefined && !slugOf(input.name)) return { ok: false, error: "a client needs a name" };
  const people = input.handlers ? await handlerIds(w, input.handlers) : null;
  if (people && "error" in people) return { ok: false, error: people.error! };
  let won = false;
  const done = await db.transaction(async (tx) => {
    const [row] = await tx.select().from(clients).where(eq(clients.id, found.id)).for("update");
    if (!row) return `${found.name} was deleted meanwhile`;
    const late = await stale(row, input.updatedAt, found.name, "client", w);
    if (late) return late;
    const d = input.details ? await nextDetails(tx, w, "client", fields, row.details, input.details) : { details: row.details, added: [] };
    if ("error" in d) return d.error!;
    const oldStage = stages.find((s) => s.id === row.stageId)!;
    const before: Record<string, unknown> = { ...row.details, name: row.name, stage: oldStage.name };
    const next: Record<string, unknown> = {};
    if (input.name !== undefined) next.name = clean(input.name).slice(0, 200);
    if (stage) next.stage = stage.name;
    for (const k of new Set([...Object.keys(row.details), ...Object.keys(d.details)])) if (row.details[k] !== d.details[k]) next[k] = d.details[k] ?? null;
    const changes = diff(before, next, Object.fromEntries(fields.map((f) => [f.key, f.name])));
    if (people) {
      const had = await tx.select({ userId: clientHandlers.userId }).from(clientHandlers).where(eq(clientHandlers.clientId, row.id));
      const oldIds = had.map((h) => h.userId).sort();
      if (oldIds.join() !== [...people.ids].sort().join()) {
        changes.push({ field: "handlers", from: people.names(oldIds), to: people.names(people.ids) });
        await tx.delete(clientHandlers).where(eq(clientHandlers.clientId, row.id));
        if (people.ids.length) await tx.insert(clientHandlers).values(people.ids.map((userId) => ({ clientId: row.id, userId })));
      }
    }
    const ids = input.externalIds ? cleanIds(row.externalIds, input.externalIds) : row.externalIds;
    if (JSON.stringify(ids) !== JSON.stringify(row.externalIds)) changes.push({ field: "external ids", from: row.externalIds, to: ids });
    if (!changes.length) return null;
    await tx
      .update(clients)
      .set({ name: (next.name as string) ?? row.name, stageId: stage?.id ?? row.stageId, details: d.details, externalIds: ids, updatedAt: new Date() })
      .where(eq(clients.id, row.id));
    await logChange(tx, w, { kind: "client", id: row.id, clientId: row.id, summary: `Changed ${changes.map((c) => c.field).join(", ")} of ${row.name}`, changes });
    won = !!stage && stage.category === "active" && oldStage.category === "prospect";
    return null;
  });
  if (done) return { ok: false, error: done };
  if (input.private !== undefined && input.private !== found.private) {
    const e = await setPrivate(w, "client", found.id, input.private);
    if (e) return { ok: false, error: e };
  }
  if (won) becameActive(w.workspaceId, found.slug);
  return { ok: true, client: await one(w.workspaceId, found.id) };
}

// Out of the lists, kept with all their work; refused while work is open, unless withWork.
export async function archiveClient(w: Who, q: string, o: { exact?: boolean; withWork?: boolean } = {}): Promise<Result> {
  if (!isAdmin(w)) return { ok: false, error: "only the owner or an admin can archive a client; move them to a past stage instead" };
  const c = await findClient(w, q, o.exact);
  if (typeof c === "string") return { ok: false, error: c };
  if (c.archivedAt) return { ok: false, error: `${c.name} is archived already` };
  if (!o.withWork && (c.openTasks || c.activeProjects))
    return { ok: false, error: `${c.name} has ${[c.openTasks && count(c.openTasks, "open task"), c.activeProjects && count(c.activeProjects, "active project")].filter(Boolean).join(" and ")}; finish or move them first, or archive with the work (--with-work)` };
  await db.transaction(async (tx) => {
    await tx.update(clients).set({ archivedAt: new Date(), updatedAt: new Date() }).where(eq(clients.id, c.id));
    await logChange(tx, w, { kind: "client", id: c.id, clientId: c.id, summary: `Archived ${c.name}`, changes: [{ field: "archived", from: false, to: true }] });
  });
  return { ok: true, client: await one(w.workspaceId, c.id, true) };
}

export async function restoreClient(w: Who, q: string, exact = false): Promise<Result> {
  if (!isAdmin(w)) return { ok: false, error: "only the owner or an admin can bring back an archived client" };
  const hit = findIn(await listClients(w, { archived: true }), q, "archived client", exact);
  if (typeof hit === "string") return { ok: false, error: hit };
  await db.transaction(async (tx) => {
    await tx.update(clients).set({ archivedAt: null, updatedAt: new Date() }).where(eq(clients.id, hit.id));
    await logChange(tx, w, { kind: "client", id: hit.id, clientId: hit.id, summary: `Brought back ${hit.name}`, changes: [{ field: "archived", from: true, to: false }] });
  });
  return { ok: true, client: await one(w.workspaceId, hit.id) };
}

// Deleted for good: the owner, from the app, for an archived client nothing points at (one added by mistake).
// Their history rows stay.
export async function purgeClient(w: Who, slug: string) {
  if (w.role !== "owner") return { ok: false as const, error: "only the owner can delete a client for good" };
  const [c] = await db.select().from(clients).where(and(eq(clients.workspaceId, w.workspaceId), eq(clients.slug, slug)));
  if (!c) return { ok: false as const, error: "no such client" };
  if (!c.archivedAt) return { ok: false as const, error: `archive ${c.name} first` };
  const n = async (t: typeof tasks | typeof processRuns | typeof conversations | typeof projects) =>
    (await db.select({ n: sql<number>`count(*)`.mapWith(Number) }).from(t).where(eq(t.clientId, c.id)))[0]!.n;
  const [t, r, ch, p, k] = await Promise.all([
    n(tasks),
    n(processRuns),
    n(conversations),
    n(projects),
    db.select({ n: sql<number>`count(*)`.mapWith(Number) }).from(contactClients).where(eq(contactClients.clientId, c.id)).then((x) => x[0]!.n),
  ]);
  const linked = [t && count(t, "task"), r && count(r, "process run"), ch && count(ch, "chat"), p && count(p, "project"), k && count(k, "contact")].filter(Boolean);
  if (linked.length) return { ok: false as const, error: `${c.name} still has ${linked.join(", ")}; they stay archived` };
  return purging(c.name, () =>
    db.transaction(async (tx) => {
      await tx.delete(clients).where(eq(clients.id, c.id));
      await logChange(tx, w, { kind: "client", id: c.id, clientId: c.id, summary: `Deleted ${c.name} for good`, changes: [] });
    }),
  );
}

// --- chats ---

// A chat is about the first client it's tied to (a task for them added in it, or them @mentioned); kept after that.
export async function labelChat(conversationId: string | null | undefined, clientId: string | null | undefined) {
  if (!conversationId || !clientId) return;
  await db.update(conversations).set({ clientId }).where(and(eq(conversations.id, conversationId), isNull(conversations.clientId)));
}

// @mentioned clients (their notes' path, mentions.ts) in a message: the first one labels the chat
export async function labelFromMentions(workspaceId: string, conversationId: string, picked: unknown) {
  const slugs = (Array.isArray(picked) ? picked : []).flatMap((m) => {
    const slug = m?.kind === "record" && typeof m.id === "string" ? new RegExp(`^(?:company|restricted)/${FOLDER}/([^/]+)/index\\.md$`).exec(m.id)?.[1] : null;
    return slug ? [slug] : [];
  });
  if (!slugs.length) return;
  const [c] = await db.select({ id: clients.id }).from(clients).where(and(eq(clients.workspaceId, workspaceId), eq(clients.slug, slugs[0]!)));
  if (c) await labelChat(conversationId, c.id);
}

// What the model is told each turn in a chat about one client: who they are and where the rest is. Nothing when
// the person can't see them (made private after the chat was linked).
export async function clientNote(v: Viewer, clientId: string) {
  const c = (await listClients(v, { ids: [clientId] }))[0];
  return c ? clientNoteText(c, v) : "";
}
// the words of it, for a client as the app lists them (the evals use these too)
export const clientNoteText = (c: Client, v?: Viewer) =>
  `This chat is about the client ${c.name} (${c.stage}; handled by ${c.handlers.map((h) => h.name).join(", ") || "nobody named yet"}; ${count(c.openTasks, "open task")}${c.waitingTasks ? `, ${c.waitingTasks} waiting` : ""})${c.details.length ? `; ${c.details.map((d) => `${d.name}: ${d.value}`).join("; ")}` : ""}. Everything on them: emplio clients show ${c.slug}; their notes (words only): ${notesAt(v, "client", c)}. Tasks you add here are for them (--client ${c.slug}) unless plainly not.`;

// --- the client page ---

export async function clientPage(w: Who, slug: string): Promise<ClientPage | null> {
  const c = await findClient(w, slug, true);
  if (typeof c === "string") return null;
  const [{ listContacts }, { listProjects }, { listTasks }, { listRuns }, { listMeetings }] = await Promise.all([import("./contacts"), import("./projects"), import("./tasks"), import("./processes"), import("./meetings")]);
  const [contacts, projectList, open, runs, meetingList, linking, history] = await Promise.all([
    listContacts(w, { clientId: c.id }),
    listProjects(w, { clientId: c.id }),
    listTasks(w, { clientId: c.id, open: true }),
    listRuns(w.workspaceId, { clientId: c.id, all: true, viewer: w }),
    listMeetings(w, { clientId: c.id }),
    // a private one's are in restricted/ (and older ones may still be shared); paths start with their repo
    Promise.all(
      (c.private ? ["company", "restricted"] : ["company"]).map(async (repo) => (await linkedFrom(w.workspaceId, repo, `${FOLDER}/${c.slug}/index.md`)).map((p) => `${repo}/${p}`)),
    ).then((x) => x.flat()),
    historyOf(w.workspaceId, { clientId: c.id }, 30, false, w),
  ]);
  const title = (p: string) => p.replace(/^.*\//, "").replace(/\.md$/, "").replace(/^(\d{4}-\d{2}-\d{2})-?/, "").replace(/-/g, " ") || "note";
  return {
    client: c,
    contacts,
    projects: projectList,
    tasks: open.slice(0, 50),
    tasksTotal: open.length,
    runs: [...runs.filter((r) => r.status === "active"), ...runs.filter((r) => r.status !== "active").slice(0, 10)],
    meetings: meetingList.map((m) => ({ path: m.path, date: m.on, title: m.title })),
    // other notes; a contact's or project's own notes are on its card already
    notes: linking.filter((p) => !/^\w+\/meetings\//.test(p) && !/^\w+\/(clients|contacts|projects|services|team)\/[^/]+\/index\.md$/.test(p)).map((p) => ({ path: p, title: title(p) })),
    history,
  };
}

// --- `emplio clients` ---

export const USAGE = `usage: emplio clients list [--stage <stage>] [--archived]   every client: stage, who handles them, open work
       emplio clients show <name>                       everything on one: stage, fields, contacts, projects, open work, history
       emplio clients add <name> [options] ["Field=value"]...      a new client (anyone)
       emplio clients update <name> [options] ["Field=value"]...   change one; only what you name changes
       emplio clients archive <name> [--with-work]       out of the lists, kept with all their work (owner and admins)
       emplio clients restore <name>                     bring an archived one back
       emplio clients stages list|add|update|remove      this business's stages (owner and admins change them)
       emplio clients fields list|add|update|remove      this business's client fields (owner and admins change them)
options: --stage <stage>      one of this business's stages (emplio clients stages list); prospect, active or past means the first of those
         --handler <names>    who on the team looks after them: names, emails or "me", comma-separated; "none" clears it
         --private yes|no     owners and admins only see it (and its projects, and contacts at no other client); notes move to restricted/
         --name <new name>    update only; their slug (in links and --client) stays
         --force              add even though a client with a close name exists (it's recorded)
         --updated-at <time>  update only: the updatedAt you read; refused if someone changed them since
         "Field=value"        one of the business's client fields: "Tax number=27AAACN1234F1Z5" "Files=monthly"; "Field=" empties it.
                              A process input of the same name is filled in from it; a schedule can pick clients by one.
Clients live in the database: change them only with this command. Their notes file holds words (what they're like,
decisions, history in prose), never their stage, fields or who handles them.
A task for a client: emplio tasks add ... --client <name>; a project: emplio projects add <name> --client <name>.`;

const STAGES_USAGE = `usage: emplio clients stages list
       emplio clients stages add <name> --category prospect|active|past [--position <n>]
       emplio clients stages update <name> [--name <new name>] [--category ...] [--position <n>]
       emplio clients stages remove <name> [--to <stage>]   its clients move to --to (needed when it has any)`;

const line = (c: Client) =>
  [c.slug, c.stage, c.handlers.length ? c.handlers.map((h) => h.name).join(", ") : "nobody named", `${c.openTasks} open${c.waitingTasks ? ` (${c.waitingTasks} waiting)` : ""}`, c.name].join("\t");

const asData = (c: Client) => ({
  slug: c.slug,
  name: c.name,
  stage: c.stage,
  stage_category: c.stageCategory,
  private: c.private,
  handled_by: c.handlers.map((h) => h.name),
  fields: Object.fromEntries(c.details.map((d) => [d.name, d.value])),
  open_tasks: c.openTasks,
  waiting_tasks: c.waitingTasks,
  active_projects: c.activeProjects,
  archived: !!c.archivedAt,
  updated_at: c.updatedAt,
  notes: notesPath(c),
});

export async function clientsCommand(base: Omit<Who, "via" | "conversationId">, conversationId: string, args: string[], data = false): Promise<string> {
  const w: Who = { ...base, via: "emplio", conversationId };
  const [sub, ...rest] = args;
  if (sub === "stages") return stagesCommand(w, rest);
  if (sub === "fields") return fieldsCommand(w, "client", rest);
  const { words, opts, pairs, flags } = parseArgs(rest, ["stage", "handler", "name"]);
  const name = words.join(" ");
  const input = (): ClientInput => {
    const i: ClientInput = {};
    if (opts.stage !== undefined) i.stage = opts.stage;
    if (opts.name !== undefined) i.name = opts.name;
    if (opts.handler !== undefined) i.handlers = opts.handler.trim().toLowerCase() === "none" ? [] : opts.handler.split(",");
    const priv = privateOf(opts, flags);
    if (priv !== undefined) i.private = priv;
    if (pairs.length) i.details = Object.fromEntries(pairs);
    if (opts["updated-at"]) i.updatedAt = opts["updated-at"];
    if (flags.has("force")) i.force = true;
    return i;
  };

  if (sub === "list") {
    const list = (await listClients(w, { archived: flags.has("archived") })).filter((c) => !opts.stage || c.stage.toLowerCase() === opts.stage.toLowerCase() || c.stageCategory === opts.stage.toLowerCase());
    if (data) return JSON.stringify(list.map(asData));
    if (!list.length) return flags.has("archived") ? "No archived clients." : "No clients yet. Add them with emplio clients add <name>.";
    return [...list.map(line), "", "In full: emplio clients show <name>."].join("\n");
  }
  if (sub === "show" && name) {
    const c = await findClient(w, name);
    if (typeof c === "string") return `error: ${c}`;
    const page = (await clientPage(w, c.slug))!;
    if (data) return JSON.stringify({ ...asData(c), contacts: page.contacts.map((x) => ({ slug: x.slug, name: x.name, email: x.email, role: x.clients.find((k) => k.id === c.id)?.role ?? null })), projects: page.projects.map((p) => ({ slug: p.slug, name: p.name, status: p.status })),
      // the work going for them, so news about it finds its run and task (a call held: that step's task done)
      processes: page.runs.map((r) => ({ id: r.id.slice(0, 8), process: r.processTitle, subject: r.subject, status: r.status, step: r.status === "active" ? `${r.step + 1} of ${r.steps.length}` : null })),
      open_tasks: page.tasks.slice(0, 30).map((t) => ({ id: t.id.slice(0, 8), title: t.title, status: t.status, due: t.dueAt?.slice(0, 10) ?? null, waiting_on: t.waitingOn ?? null })),
      meetings: page.meetings.slice(0, 5).map((m) => ({ date: m.date, title: m.title })) });
    const day = (s: string | null) => (s ? s.slice(0, 10) : "no due date");
    return [
      `${c.name} (${c.slug}) · ${c.stage}${c.private ? " · PRIVATE (owners, admins and its handlers)" : ""}${c.archivedAt ? " · ARCHIVED" : ""} · updatedAt ${c.updatedAt}`,
      `handled by: ${c.handlers.map((h) => h.name).join(", ") || "nobody named yet"}`,
      ...c.details.map((d) => `${d.name}: ${d.value}`),
      ...(page.contacts.length ? ["contacts:", ...page.contacts.map((x) => `- ${x.name} (${x.slug})${x.clients.find((k) => k.id === c.id)?.role ? `, ${x.clients.find((k) => k.id === c.id)!.role}` : ""}${x.email ? ` <${x.email}>` : ""}${x.phone ? ` ${x.phone}` : ""}`)] : ["no contacts yet"]),
      ...(page.projects.length ? ["projects:", ...page.projects.map((p) => `- ${p.name} (${p.slug}) ${p.status}${p.lead ? `, led by ${p.lead.name}` : ""}${p.dueOn ? `, due ${p.dueOn}` : ""}`)] : []),
      ...(page.runs.length ? ["processes:", ...page.runs.map((r) => `- ${r.processTitle}: ${r.subject} (${r.status === "active" ? `step ${r.step + 1} of ${r.steps.length}` : r.status})`)] : []),
      ...(page.tasks.length
        ? [`open tasks (${page.tasksTotal}):`, ...page.tasks.slice(0, 30).map((t) => `- ${t.id.slice(0, 8)} ${t.status} ${day(t.dueAt)} ${t.title}${t.waitingOn ? ` (waiting on ${t.waitingOn})` : ""}`)]
        : ["no open tasks"]),
      ...(page.history.length ? ["recent changes:", ...page.history.slice(0, 8).map((h) => `- ${h.at.slice(0, 10)} ${h.who ?? "Emplio"}${h.via === "emplio" ? " (via Emplio)" : ""}: ${h.summary}`)] : []),
      `notes: ${notesAt(w, "client", c)}${page.meetings.length ? `; meetings (emplio meetings list --client ${c.slug}): ${page.meetings.slice(0, 5).map((m) => `/work/${m.path.startsWith("restricted/") && !seesPrivate(w) ? m.path.replace(/^restricted/, "shared") : m.path}`).join(", ")}` : ""}`,
    ].join("\n");
  }
  if (sub === "add" && name) {
    const r = await addClient(w, { ...input(), name });
    return r.ok ? `added ${line(r.client)}; notes about them (words only) go in /work/${notesPath(r.client)}` : `error: ${r.error}`;
  }
  if (sub === "update" && name) {
    const i = input();
    if (!Object.keys(i).filter((k) => k !== "updatedAt").length) return USAGE;
    if (i.stage !== undefined && !i.updatedAt) return `error: a stage change needs --updated-at (the updatedAt from emplio clients show ${name}), so a newer change isn't overwritten`;
    const r = await updateClient(w, name, i);
    if (!r.ok) return `error: ${r.error}`;
    // its notes moved by themselves: say where, so nobody copies them by hand
    const priv = i.private === undefined ? "" : r.client.private ? `\nprivate now: only owners, admins and whoever handles them see them, their projects, tasks and notes (their open tasks too, nothing to change on those); notes moved to /work/${notesPath(r.client)}` : `\nshared with the team again; notes are back in /work/${notesPath(r.client)}`;
    return `updated ${line(r.client)}${priv}`;
  }
  if ((sub === "archive" || sub === "remove") && name) {
    const r = await archiveClient(w, name, { withWork: flags.has("with-work") });
    return r.ok ? `archived ${r.client.name}: out of the lists, their work and history kept (emplio clients restore ${r.client.slug} brings them back)` : `error: ${r.error}`;
  }
  if (sub === "restore" && name) {
    const r = await restoreClient(w, name);
    return r.ok ? `brought back ${line(r.client)}` : `error: ${r.error}`;
  }
  return USAGE;
}

// --- stages and fields: the lists themselves ---

async function logSetting(w: Who, summary: string) {
  const { record } = await import("./activity");
  record({ workspaceId: w.workspaceId, userId: w.userId, conversationId: w.conversationId || null, kind: "client", summary });
}

export async function saveStage(w: Who, q: string | null, input: { name?: string; category?: string; position?: number }) {
  if (!isAdmin(w)) return "only the owner or an admin can change the stages";
  const all = await listStages(w.workspaceId);
  const name = input.name !== undefined ? clean(input.name).slice(0, 40) : undefined;
  if (name !== undefined && !name) return "a stage needs a name";
  if (input.category !== undefined && !STAGE_CATEGORIES.includes(input.category as StageCategory)) return "category is prospect (not won yet), active (being worked for) or past (no longer)";
  const old = q === null ? null : all.find((s) => s.name.toLowerCase() === clean(q).toLowerCase());
  if (q !== null && !old) return `no stage "${q}" (${all.map((s) => s.name).join(", ")})`;
  if (name && all.some((s) => s.name.toLowerCase() === name.toLowerCase() && s.id !== old?.id)) return `there's a stage ${name} already`;
  if (old && input.category && input.category !== old.category && !all.some((s) => s.id !== old.id && s.category === old.category))
    return `${old.name} is the only ${old.category} stage; add another first`;
  if (!old) {
    if (!name || !input.category) return "a new stage needs a name and a category (prospect, active or past)";
    if (all.length >= 30) return "a business has at most 30 stages";
    await db.insert(clientStages).values({ workspaceId: w.workspaceId, name, category: input.category as StageCategory, position: input.position ?? all.length });
  } else {
    await db
      .update(clientStages)
      .set({ ...(name && { name }), ...(input.category && { category: input.category as StageCategory }), ...(input.position !== undefined && { position: input.position }) })
      .where(eq(clientStages.id, old.id));
  }
  await logSetting(w, old ? `Changed the stage ${old.name}` : `Added the stage ${name}`);
  return null;
}

// Its clients move to `to` (in one go, each change in their history)
export async function removeStage(w: Who, q: string, to?: string) {
  if (!isAdmin(w)) return "only the owner or an admin can change the stages";
  const all = await listStages(w.workspaceId);
  const old = all.find((s) => s.name.toLowerCase() === clean(q).toLowerCase());
  if (!old) return `no stage "${q}"`;
  if (!all.some((s) => s.id !== old.id && s.category === old.category)) return `${old.name} is the only ${old.category} stage; a business keeps at least one of each`;
  const using = await db.select({ id: clients.id, name: clients.name }).from(clients).where(eq(clients.stageId, old.id));
  const target = to ? stageIn(all.filter((s) => s.id !== old.id), to) : null;
  if (typeof target === "string") return target;
  if (using.length && !target) return `${count(using.length, "client")} ${using.length === 1 ? "is" : "are"} at ${old.name}; say where they move (--to <stage>)`;
  await db.transaction(async (tx) => {
    for (const c of using) {
      await tx.update(clients).set({ stageId: target!.id, updatedAt: new Date() }).where(eq(clients.id, c.id));
      await logChange(tx, w, { kind: "client", id: c.id, clientId: c.id, summary: `Moved ${c.name} to ${target!.name} (${old.name} removed)`, changes: [{ field: "stage", from: old.name, to: target!.name }] });
    }
    await tx.delete(clientStages).where(eq(clientStages.id, old.id));
  });
  await logSetting(w, `Removed the stage ${old.name}`);
  return null;
}

async function stagesCommand(w: Who, args: string[]) {
  const [sub, ...rest] = args;
  const { words, opts } = parseArgs(rest);
  const name = words.join(" ");
  const position = opts.position !== undefined ? Number(opts.position) : undefined;
  if (position !== undefined && !Number.isInteger(position)) return "error: --position is a whole number";
  if (sub === "list") return (await listStages(w.workspaceId)).map((s) => `${s.name}\t${s.category}`).join("\n");
  const err =
    sub === "add" && name ? await saveStage(w, null, { name, category: opts.category, position })
    : sub === "update" && name ? await saveStage(w, name, { name: opts.name, category: opts.category, position })
    : sub === "remove" && name ? await removeStage(w, name, opts.to)
    : STAGES_USAGE;
  return err === STAGES_USAGE ? err : err ? `error: ${err}` : `done; the stages now:\n${(await listStages(w.workspaceId)).map((s) => `${s.name}\t${s.category}`).join("\n")}`;
}

// --- routes ---

const BODY = {
  type: "object",
  additionalProperties: false,
  properties: {
    name: { type: "string", maxLength: 200 },
    stage: { type: "string", maxLength: 40 },
    handlers: { type: "array", items: { type: "string", maxLength: 200 }, maxItems: 20 },
    details: { type: "object", maxProperties: 50, additionalProperties: { type: ["string", "null"], maxLength: 500 } },
    externalIds: { type: "object", maxProperties: 20, additionalProperties: { type: ["string", "null"], maxLength: 200 } },
    updatedAt: { type: "string", maxLength: 40 },
    force: { type: "boolean" },
    private: { type: "boolean" },
  },
};
const STAGE_BODY = { type: "object", additionalProperties: false, properties: { name: { type: "string", maxLength: 40 }, category: { type: "string" }, position: { type: "integer" }, to: { type: "string" } } };
export async function clientRoutes(app: FastifyInstance) {
  const fail = (reply: { code: (n: number) => { send: (b: unknown) => unknown } }, error: string, match?: Match) => reply.code(400).send({ error, match });

  app.get<{ Querystring: { archived?: string } }>("/clients", async (req, reply) => {
    const ctx = await context(req, reply);
    if (!ctx) return;
    return listClients(ctx, { archived: req.query.archived === "1" });
  });
  app.get<{ Params: { slug: string } }>("/clients/:slug/page", async (req, reply) => {
    const ctx = await context(req, reply);
    if (!ctx) return;
    return (await clientPage(ctx, req.params.slug)) ?? reply.code(404).send({ error: "No such client." });
  });
  app.post<{ Body: ClientInput }>("/clients", { schema: { body: { ...BODY, required: ["name"] } } }, async (req, reply) => {
    const ctx = await context(req, reply);
    if (!ctx) return;
    const r = await addClient(ctx, req.body);
    return r.ok ? r.client : fail(reply, r.error, r.match);
  });
  app.patch<{ Params: { slug: string }; Body: ClientInput }>("/clients/:slug", { schema: { body: BODY } }, async (req, reply) => {
    const ctx = await context(req, reply);
    if (!ctx) return;
    const r = await updateClient(ctx, req.params.slug, req.body, true);
    return r.ok ? r.client : fail(reply, r.error);
  });
  app.post<{ Params: { slug: string }; Body: { withWork?: boolean } }>("/clients/:slug/archive", async (req, reply) => {
    const ctx = await context(req, reply);
    if (!ctx) return;
    const r = await archiveClient(ctx, req.params.slug, { exact: true, withWork: !!req.body?.withWork });
    return r.ok ? r.client : fail(reply, r.error);
  });
  app.post<{ Params: { slug: string } }>("/clients/:slug/restore", async (req, reply) => {
    const ctx = await context(req, reply);
    if (!ctx) return;
    const r = await restoreClient(ctx, req.params.slug, true);
    return r.ok ? r.client : fail(reply, r.error);
  });
  app.delete<{ Params: { slug: string } }>("/clients/:slug", async (req, reply) => {
    const ctx = await context(req, reply);
    if (!ctx) return;
    const r = await purgeClient(ctx, req.params.slug);
    return r.ok ? r : fail(reply, r.error);
  });

  app.get("/client-stages", async (req, reply) => {
    const ctx = await context(req, reply);
    if (!ctx) return;
    return listStages(ctx.workspaceId);
  });
  app.post<{ Body: { name: string; category: string; position?: number } }>("/client-stages", { schema: { body: { ...STAGE_BODY, required: ["name", "category"] } } }, async (req, reply) => {
    const ctx = await context(req, reply);
    if (!ctx) return;
    const e = await saveStage(ctx, null, req.body);
    return e ? fail(reply, e) : listStages(ctx.workspaceId);
  });
  app.patch<{ Params: { id: string }; Body: { name?: string; category?: string; position?: number } }>("/client-stages/:id", { schema: { body: STAGE_BODY } }, async (req, reply) => {
    const ctx = await context(req, reply);
    if (!ctx) return;
    const s = (await listStages(ctx.workspaceId)).find((x) => x.id === req.params.id);
    if (!s) return fail(reply, "no such stage");
    const e = await saveStage(ctx, s.name, req.body);
    return e ? fail(reply, e) : listStages(ctx.workspaceId);
  });
  app.delete<{ Params: { id: string }; Querystring: { to?: string } }>("/client-stages/:id", async (req, reply) => {
    const ctx = await context(req, reply);
    if (!ctx) return;
    const s = (await listStages(ctx.workspaceId)).find((x) => x.id === req.params.id);
    if (!s) return fail(reply, "no such stage");
    const e = await removeStage(ctx, s.name, req.query.to);
    return e ? fail(reply, e) : listStages(ctx.workspaceId);
  });

}

if (import.meta.main) {
  const st: ClientStage[] = [
    { id: "1", name: "Lead", category: "prospect", position: 0 },
    { id: "2", name: "Onboarding", category: "active", position: 1 },
    { id: "3", name: "Retainer", category: "active", position: 2 },
  ];
  console.assert((stageIn(st, "active") as ClientStage).name === "Onboarding" && (stageIn(st, "retainer") as ClientStage).id === "3" && typeof stageIn(st, "won") === "string");
  const cs = [
    { slug: "a", name: "A", stageCategory: "active" as const, details: [{ key: "files", name: "Files", value: "Monthly" }] },
    { slug: "b", name: "B", stageCategory: "active" as const, details: [] },
    { slug: "c", name: "C", stageCategory: "prospect" as const, details: [{ key: "files", name: "Files", value: "monthly" }] },
  ];
  console.assert(pickClients(cs, ["files=monthly"]).map((c) => c.slug).join() === "a", "by field");
  console.assert(pickClients(cs, ["B", "Files = Monthly"]).map((c) => c.slug).join() === "a,b", "mixed");
  console.assert(pickClients(cs, ["*"]).length === 2, "all active");
  console.log("ok");
}
