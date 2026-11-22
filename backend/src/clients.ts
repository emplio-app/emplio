// Clients: who the business works for, at what stage (prospect, active, past) and who on the team handles each.
// Their story stays in their notes file, company/knowledge/clients/<slug>.md (the slug is this row's, kept when they're
// renamed); the row is what tasks and chats point at. The web app's Clients page and `emplio clients` share these.
// Everyone on the team sees them and may add one; changing or removing is for the owner and admins.
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { CLIENT_STAGES, type Client, type ClientInput, type ClientStage, type Role } from "@emplio/shared";
import { record } from "./activity";
import { context } from "./auth";
import { db } from "./db";
import { clients, conversations, tasks } from "./db/schema";
import { listTeam } from "./team";

type Who = { workspaceId: string; userId: string; role: Role };
type Row = typeof clients.$inferSelect;
type Result = { ok: true; client: Client } | { ok: false; error: string };

const isAdmin = (w: Who) => w.role !== "member";
export const FOLDER = "knowledge/clients";
export const notesPath = (c: Pick<Row, "slug">) => `company/${FOLDER}/${c.slug}.md`;

// "Acme Foods Pvt. Ltd." -> "acme-foods-pvt-ltd": the notes file's name
export const slugOf = (name: string) =>
  name.normalize("NFKD").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60);

async function toClients(rows: Row[], workspaceId: string): Promise<Client[]> {
  if (!rows.length) return [];
  const names = new Map((await listTeam(workspaceId)).map((m) => [m.id, m.name ?? m.email]));
  const counts = await db
    .select({
      clientId: tasks.clientId,
      open: sql<number>`count(*) filter (where ${tasks.status} in ('todo', 'doing', 'waiting'))`.mapWith(Number),
      waiting: sql<number>`count(*) filter (where ${tasks.status} = 'waiting')`.mapWith(Number),
    })
    .from(tasks)
    .where(inArray(tasks.clientId, rows.map((r) => r.id)))
    .groupBy(tasks.clientId);
  const by = new Map(counts.map((c) => [c.clientId, c]));
  return rows.map((r) => ({
    id: r.id,
    slug: r.slug,
    name: r.name,
    stage: r.stage,
    // someone who left the team is no longer handling anything
    handlers: r.handlerIds.flatMap((id) => (names.has(id) ? [{ id, name: names.get(id)! }] : [])),
    openTasks: by.get(r.id)?.open ?? 0,
    waitingTasks: by.get(r.id)?.waiting ?? 0,
    updatedAt: r.updatedAt.toISOString(),
  }));
}

export async function listClients(w: Pick<Who, "workspaceId">, f: { stage?: ClientStage } = {}) {
  const rows = await db
    .select()
    .from(clients)
    .where(and(eq(clients.workspaceId, w.workspaceId), f.stage ? eq(clients.stage, f.stage) : undefined))
    .orderBy(sql`lower(${clients.name})`);
  return toClients(rows, w.workspaceId);
}

// By id, slug or name: exact first, then a unique part of the name. A string is what's wrong.
export async function findClient(workspaceId: string, q: string): Promise<Row | string> {
  const all = await db.select().from(clients).where(eq(clients.workspaceId, workspaceId));
  const s = q.trim().toLowerCase();
  if (!s) return "which client?";
  const exact = all.find((c) => c.id === s || c.slug === s || c.slug === slugOf(s) || c.name.toLowerCase() === s);
  if (exact) return exact;
  const loose = all.filter((c) => c.name.toLowerCase().includes(s) || c.slug.includes(slugOf(s) || s));
  if (loose.length === 1) return loose[0]!;
  return loose.length
    ? `"${q}" matches ${loose.map((c) => c.name).join(", ")}; say which`
    : `no client "${q}" (emplio clients list; add one with emplio clients add)`;
}

async function check(w: Who, input: ClientInput) {
  if (input.name !== undefined && !slugOf(input.name)) return "a client needs a name";
  if (input.stage !== undefined && !CLIENT_STAGES.includes(input.stage)) return `stage is one of ${CLIENT_STAGES.join(", ")}`;
  if (input.handlerIds?.length) {
    const team = new Set((await listTeam(w.workspaceId)).map((m) => m.id));
    if (input.handlerIds.some((id) => !team.has(id))) return "everyone handling a client must be on the team";
  }
  return null;
}

const one = async (row: Row) => (await toClients([row], row.workspaceId))[0]!;

export async function addClient(w: Who, input: ClientInput, conversationId?: string): Promise<Result> {
  const error = (await check(w, input)) ?? (input.name === undefined ? "a client needs a name" : null);
  if (error) return { ok: false, error };
  const name = input.name!.trim();
  const slug = slugOf(name);
  const [row] = await db
    .insert(clients)
    .values({ workspaceId: w.workspaceId, slug, name, stage: input.stage ?? "active", handlerIds: [...new Set(input.handlerIds ?? [])] })
    .onConflictDoNothing()
    .returning();
  if (!row) return { ok: false, error: `already a client: emplio clients show ${slug}` };
  record({ workspaceId: w.workspaceId, userId: w.userId, conversationId: conversationId || null, kind: "client", summary: `Added client ${name}` });
  return { ok: true, client: await one(row) };
}

export async function updateClient(w: Who, q: string, input: ClientInput, conversationId?: string): Promise<Result> {
  if (!isAdmin(w)) return { ok: false, error: "only the owner or an admin can change a client" };
  const c = await findClient(w.workspaceId, q);
  if (typeof c === "string") return { ok: false, error: c };
  const error = await check(w, input);
  if (error) return { ok: false, error };
  const set: Partial<Row> = { updatedAt: new Date() };
  // the slug, and so the notes file, stays
  if (input.name !== undefined) set.name = input.name.trim();
  if (input.stage !== undefined) set.stage = input.stage;
  if (input.handlerIds !== undefined) set.handlerIds = [...new Set(input.handlerIds)];
  const [row] = await db.update(clients).set(set).where(eq(clients.id, c.id)).returning();
  record({ workspaceId: w.workspaceId, userId: w.userId, conversationId: conversationId || null, kind: "client", summary: `Changed client ${row!.name}` });
  return { ok: true, client: await one(row!) };
}

// Their tasks and chats stay, without the label; their notes file stays too.
export async function removeClient(w: Who, q: string, conversationId?: string) {
  if (!isAdmin(w)) return { ok: false as const, error: "only the owner or an admin can remove a client; set them to past instead" };
  const c = await findClient(w.workspaceId, q);
  if (typeof c === "string") return { ok: false as const, error: c };
  await db.delete(clients).where(eq(clients.id, c.id));
  record({ workspaceId: w.workspaceId, userId: w.userId, conversationId: conversationId || null, kind: "client", summary: `Removed client ${c.name}` });
  return { ok: true as const, name: c.name };
}

// A chat is about the first client it's tied to (a task for them added in it, or them @mentioned); kept after that.
export async function labelChat(conversationId: string | null | undefined, clientId: string | null | undefined) {
  if (!conversationId || !clientId) return;
  await db.update(conversations).set({ clientId }).where(and(eq(conversations.id, conversationId), isNull(conversations.clientId)));
}

// @mentioned clients (their notes path, mentions.ts) in a message: the first one labels the chat
export async function labelFromMentions(workspaceId: string, conversationId: string, picked: unknown) {
  const ids = (Array.isArray(picked) ? picked : []).flatMap((m) => {
    const slug = m?.kind === "record" && typeof m.id === "string" ? new RegExp(`^company/${FOLDER}/([^/]+)\\.md$`).exec(m.id)?.[1] : null;
    return slug ? [slug] : [];
  });
  if (!ids.length) return;
  const c = await db.query.clients.findFirst({ where: and(eq(clients.workspaceId, workspaceId), eq(clients.slug, ids[0]!)) });
  await labelChat(conversationId, c?.id);
}

// What the model is told each turn in a chat about one client: who they are and where the rest is.
export async function clientNote(workspaceId: string, clientId: string) {
  const row = await db.query.clients.findFirst({ where: and(eq(clients.workspaceId, workspaceId), eq(clients.id, clientId)) });
  if (!row) return "";
  const [c] = await toClients([row], workspaceId);
  return `This chat is about the client ${c!.name} (${c!.stage}; handled by ${c!.handlers.map((h) => h.name).join(", ") || "nobody named yet"}; ${c!.openTasks} open task${c!.openTasks === 1 ? "" : "s"}${c!.waitingTasks ? `, ${c!.waitingTasks} waiting` : ""}). Their notes: /work/${notesPath(c!)}; their open work: emplio clients show ${c!.slug}. Tasks you add here are for them (--client ${c!.slug}) unless plainly not.`;
}

// --- `emplio clients` ---

const USAGE = `usage: emplio clients list [--stage prospect|active|past]   every client: stage, who handles them, open tasks
       emplio clients show <name>                         one client: who handles them, their open tasks, their notes file
       emplio clients add <name> [options]                a new client (anyone); their notes go in company/${FOLDER}/<slug>.md
       emplio clients update <name> [options]             change one (owner and admins)
       emplio clients remove <name>                       delete one added by mistake (owner and admins); otherwise --stage past
options: --stage prospect|active|past   prospect: not won yet; past: no longer working with them (default: active)
         --handler <names or emails>    who on the team looks after them, comma-separated; "none" clears it
         --name <new name>              update only; the notes file keeps its name
A task for a client: emplio tasks add ... --client <name>; theirs: emplio tasks list --client <name>.`;

const line = (c: Client) =>
  [c.slug, c.stage, c.handlers.length ? c.handlers.map((h) => h.name).join(", ") : "nobody named", `${c.openTasks} open${c.waitingTasks ? ` (${c.waitingTasks} waiting)` : ""}`, c.name].join("\t");

const asData = (c: Client) => ({ slug: c.slug, name: c.name, stage: c.stage, handled_by: c.handlers.map((h) => h.name), open_tasks: c.openTasks, waiting_tasks: c.waitingTasks, notes: notesPath(c) });

export async function clientsCommand(w: Who, conversationId: string, args: string[], data = false) {
  const [sub, ...rest] = args;
  const words: string[] = [];
  const opts: Record<string, string> = {};
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (a.startsWith("--")) opts[a.slice(2)] = rest[++i] ?? "";
    else words.push(a);
  }
  const team = await listTeam(w.workspaceId);
  // names or emails, comma-separated, to user ids; a string is what's wrong
  const handlers = (s: string): string[] | string => {
    if (s.trim().toLowerCase() === "none") return [];
    const ids: string[] = [];
    for (const part of s.split(",").map((p) => p.trim().toLowerCase()).filter(Boolean)) {
      if (part === "me") {
        ids.push(w.userId);
        continue;
      }
      const hits = team.filter((m) => m.email === part || m.name?.toLowerCase() === part);
      const loose = hits.length ? hits : team.filter((m) => m.name?.toLowerCase().includes(part) || m.email.includes(part));
      if (loose.length !== 1) return `error: ${loose.length ? `"${part}" matches ${loose.map((m) => m.name ?? m.email).join(", ")}; use their email` : `nobody on the team matches "${part}" (emplio team list)`}`;
      ids.push(loose[0]!.id);
    }
    return ids;
  };
  const input = (): ClientInput | string => {
    const i: ClientInput = {};
    if (opts.stage !== undefined) i.stage = opts.stage as ClientStage;
    if (opts.name !== undefined) i.name = opts.name;
    if (opts.handler !== undefined) {
      const h = handlers(opts.handler);
      if (typeof h === "string") return h;
      i.handlerIds = h;
    }
    return i;
  };

  if (sub === "list") {
    if (opts.stage && !CLIENT_STAGES.includes(opts.stage as ClientStage)) return `error: stage is one of ${CLIENT_STAGES.join(", ")}`;
    const list = await listClients(w, { stage: opts.stage as ClientStage | undefined });
    if (data) return JSON.stringify(list.map(asData));
    if (!list.length) return "No clients yet. Add them with emplio clients add <name>.";
    return [...list.map(line), "", "In full: emplio clients show <name>."].join("\n");
  }
  if (sub === "show" && words.length) {
    const c = await findClient(w.workspaceId, words.join(" "));
    if (typeof c === "string") return `error: ${c}`;
    const [client] = await toClients([c], w.workspaceId);
    if (data) return JSON.stringify(asData(client!));
    const open = await db
      .select({ id: tasks.id, title: tasks.title, status: tasks.status, waitingOn: tasks.waitingOn, dueAt: tasks.dueAt })
      .from(tasks)
      .where(and(eq(tasks.clientId, c.id), inArray(tasks.status, ["todo", "doing", "waiting"])))
      .orderBy(sql`${tasks.dueAt} asc nulls last`)
      .limit(30);
    return [
      `${client!.name} (${client!.stage})`,
      `handled by: ${client!.handlers.map((h) => h.name).join(", ") || "nobody named yet"}`,
      `notes: /work/${notesPath(c)}`,
      ...(open.length
        ? ["open tasks:", ...open.map((t) => `- ${t.id.slice(0, 8)} ${t.status} ${t.dueAt ? t.dueAt.toISOString().slice(0, 10) : "no due date"} ${t.title}${t.waitingOn ? ` (waiting on ${t.waitingOn})` : ""}`)]
        : ["no open tasks"]),
    ].join("\n");
  }
  if (sub === "add" && words.length) {
    const i = input();
    if (typeof i === "string") return i;
    const r = await addClient(w, { ...i, name: words.join(" ") }, conversationId);
    return r.ok ? `added ${line(r.client)}; their notes go in /work/${notesPath(r.client)}` : `error: ${r.error}`;
  }
  if (sub === "update" && words.length) {
    const i = input();
    if (typeof i === "string") return i;
    if (!Object.keys(i).length) return USAGE;
    const r = await updateClient(w, words.join(" "), i, conversationId);
    return r.ok ? `updated ${line(r.client)}` : `error: ${r.error}`;
  }
  if (sub === "remove" && words.length) {
    const r = await removeClient(w, words.join(" "), conversationId);
    return r.ok ? `removed ${r.name} (their notes file stays)` : `error: ${r.error}`;
  }
  return USAGE;
}

const BODY = {
  type: "object",
  properties: {
    name: { type: "string", maxLength: 200 },
    stage: { type: "string", enum: [...CLIENT_STAGES] },
    handlerIds: { type: "array", items: { type: "string", format: "uuid" }, maxItems: 20 },
  },
};

export async function clientRoutes(app: FastifyInstance) {
  app.get("/clients", async (req, reply) => {
    const ctx = await context(req, reply);
    if (!ctx) return;
    return listClients(ctx);
  });

  app.post<{ Body: ClientInput }>("/clients", { schema: { body: { ...BODY, required: ["name"] } } }, async (req, reply) => {
    const ctx = await context(req, reply);
    if (!ctx) return;
    const r = await addClient(ctx, req.body);
    return r.ok ? r.client : reply.code(400).send({ error: r.error });
  });

  app.patch<{ Params: { id: string }; Body: ClientInput }>("/clients/:id", { schema: { body: BODY } }, async (req, reply) => {
    const ctx = await context(req, reply);
    if (!ctx) return;
    const r = await updateClient(ctx, req.params.id, req.body);
    return r.ok ? r.client : reply.code(400).send({ error: r.error });
  });

  app.delete<{ Params: { id: string } }>("/clients/:id", async (req, reply) => {
    const ctx = await context(req, reply);
    if (!ctx) return;
    const r = await removeClient(ctx, req.params.id);
    return r.ok ? r : reply.code(400).send({ error: r.error });
  });
}

if (import.meta.main) {
  console.assert(slugOf("Acme Foods Pvt. Ltd.") === "acme-foods-pvt-ltd");
  console.assert(slugOf("  Café Noir ") === "cafe-noir");
  console.assert(slugOf("!!!") === "");
  console.log("ok");
}
