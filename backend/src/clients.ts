// Clients: who the business works for, at what stage (prospect, active, past) and who on the team handles each. All
// of it is their page, company/clients/<slug>/index.md (things.ts): name, stage, handler (a list of "[[team/<name>]]"
// links) and their details (any other key) in the YAML at the top, their notes below; tasks, process runs and chats point at the slug, which stays
// when they're renamed. The web app's Clients page and `emplio clients` change the file here, each change a commit.
// Everyone on the team sees them and may add one; changing or removing is for the owner and admins (details: anyone).
import { and, eq, inArray, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { CLIENT_STAGES, type Client, type ClientDetail, type ClientInput, type ClientStage, type Role, type TeamMember, type Thing } from "@emplio/shared";
import { record } from "./activity";
import { context } from "./auth";
import { db } from "./db";
import { conversations, processRuns, tasks } from "./db/schema";
import { syncFiles } from "./file-index";
import { readFile, UPKEEP, writeFiles } from "./gitea";
import { listTeam } from "./team";
import { parseDocument, isMap, isScalar } from "yaml";
import { listThings, thingFile, thingPage, TOP, words as titleOf } from "./things";

type Who = { workspaceId: string; userId: string; role: Role };
type Result = { ok: true; client: Client } | { ok: false; error: string };
type File = { path: string; content: string };

const isAdmin = (w: Who) => w.role !== "member";
export const FOLDER = "clients";
export const notesPath = (c: { slug: string }) => `company/${thingFile(`${FOLDER}/${c.slug}`)}`;

// "Acme Foods Pvt. Ltd." -> "acme-foods-pvt-ltd": the notes file's name
export const slugOf = (name: string) =>
  name.normalize("NFKD").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60);

// "Contact email" → contact-email: how a detail matches a process input of the same name (processes.ts inputKey)
export const detailKey = (name: string) =>
  name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
export const detailOf = (c: { details: ClientDetail[] }, name: string) => c.details.find((d) => detailKey(d.name) === detailKey(name))?.value;

// the keys at the top of a client's file that aren't details
const KEPT = ["name", "stage", "handler"];

// The changes laid over what's there: a new name added at the end, a known one (any case) given its new value, "" or
// null removing it. A string is what's wrong.
export function mergeDetails(old: ClientDetail[], given: Record<string, string | null>): ClientDetail[] | string {
  const out = [...old];
  for (const [raw, v] of Object.entries(given)) {
    const name = raw.trim();
    if (!detailKey(name)) return `"${raw}" isn't a name for a detail`;
    if (name.length > 60) return `a detail's name is at most 60 characters (${name.slice(0, 20)}…)`;
    if (!/^[a-z][\w -]*$/i.test(name)) return `"${raw}": a detail's name starts with a letter and has only letters, digits, spaces and dashes`;
    if (KEPT.includes(name.toLowerCase())) return `${name} isn't a detail: --${name.toLowerCase()}`;
    // one line in the file
    const value = (v ?? "").replace(/\s+/g, " ").trim();
    if (value.length > 500) return `${name} is at most 500 characters`;
    const i = out.findIndex((d) => detailKey(d.name) === detailKey(name));
    if (!value) {
      if (i >= 0) out.splice(i, 1);
    } else if (i >= 0) out[i] = { name, value };
    else out.push({ name, value });
  }
  return out.length > 50 ? "a client has at most 50 details" : out;
}

// A schedule's clients: list: all (*), names, and Detail=value (every active client with that detail, any case)
export function pickClients<T extends { slug: string; name: string; stage: string; details: ClientDetail[] }>(all: T[], list: string[]): T[] {
  const wanted = list.map((c) => c.trim().toLowerCase());
  if (wanted.includes("*")) return all.filter((c) => c.stage === "active");
  const byDetail = wanted.flatMap((w) => (w.includes("=") ? [w.split("=").map((s) => s.trim()) as [string, string]] : []));
  return all.filter(
    (c) =>
      (c.stage !== "past" && (wanted.includes(c.slug) || wanted.includes(c.name.toLowerCase()) || wanted.includes(slugOf(c.name)))) ||
      (c.stage === "active" && byDetail.some(([k, v]) => detailOf(c, k)?.toLowerCase() === v)),
  );
}


// A file's YAML top changed: each key set (in place, any case, else added at the end) or removed (null); other keys,
// comments and the words below as they were. YAML that doesn't read is left for whoever broke it to fix.
export function setFields(text: string, set: Record<string, unknown>) {
  const top = TOP.exec(text);
  const doc = parseDocument(top?.[1] ?? "");
  if (doc.errors.length) throw new Error(`the YAML at the top of this file doesn't read (${doc.errors[0]!.message.split("\n")[0]}); fix it first`);
  for (const [k, v] of Object.entries(set)) {
    const old = isMap(doc.contents) ? doc.contents.items.find((p) => isScalar(p.key) && String(p.key.value).toLowerCase() === k)?.key : undefined;
    if (v === null) old && doc.delete(old);
    else doc.set(old ?? k, v);
  }
  const yaml = isMap(doc.contents) && doc.contents.items.length ? String(doc) : "";
  return `---\n${yaml}---\n${top ? text.slice(top[0].length) : text ? `\n${text}` : ""}`;
}

// A team file's member: its email: one's, else its name one's (team files written before emails were kept).
const memberOf = (file: Thing | undefined, team: TeamMember[]) =>
  file && (team.find((m) => m.email === file.fields.email?.toLowerCase()) ?? team.find((m) => !file.fields.email && m.name?.toLowerCase() === file.title.toLowerCase()));

const toClient = (t: Thing, things: Thing[], team: TeamMember[], counts: Map<string | null, { open: number; waiting: number }>): Client => {
  const slug = t.path.slice(FOLDER.length + 1);
  const stage = t.fields.stage?.toLowerCase() as ClientStage;
  return {
    slug,
    name: t.title,
    stage: CLIENT_STAGES.includes(stage) ? stage : "active",
    handlers: t.links
      .filter((l) => l.field === "handler" && l.to.startsWith("team/"))
      .map((l) => {
        const file = things.find((x) => x.path === l.to);
        const m = memberOf(file, team);
        return { id: m?.id ?? null, name: file?.title ?? m?.name ?? titleOf(l.to.slice(5)), path: l.to };
      }),
    // keys are lowercase in the file: shown with a capital
    details: Object.entries(t.fields).flatMap(([k, value]) => (KEPT.includes(k) ? [] : [{ name: k.charAt(0).toUpperCase() + k.slice(1), value }])),
    openTasks: counts.get(slug)?.open ?? 0,
    waitingTasks: counts.get(slug)?.waiting ?? 0,
  };
};

export async function listClients(w: Pick<Who, "workspaceId">, f: { stage?: ClientStage } = {}) {
  const [things, team] = await Promise.all([listThings(w.workspaceId), listTeam(w.workspaceId)]);
  const files = things.filter((t) => t.kind === FOLDER);
  if (!files.length) return [];
  const counts = await db
    .select({
      client: tasks.client,
      open: sql<number>`count(*) filter (where ${tasks.status} in ('todo', 'doing', 'waiting'))`.mapWith(Number),
      waiting: sql<number>`count(*) filter (where ${tasks.status} = 'waiting')`.mapWith(Number),
    })
    .from(tasks)
    .where(and(eq(tasks.workspaceId, w.workspaceId), inArray(tasks.client, files.map((t) => t.path.slice(FOLDER.length + 1)))))
    .groupBy(tasks.client);
  const by = new Map(counts.map((c) => [c.client, c]));
  return files.map((t) => toClient(t, things, team, by)).filter((c) => !f.stage || c.stage === f.stage);
}

// By slug or name: exact first, then a unique part of the name. A string is what's wrong.
export async function findClient(workspaceId: string, q: string): Promise<Client | string> {
  const all = await listClients({ workspaceId });
  const s = q.trim().toLowerCase();
  if (!s) return "which client?";
  const exact = all.find((c) => c.slug === s || c.slug === slugOf(s) || c.name.toLowerCase() === s);
  if (exact) return exact;
  const loose = all.filter((c) => c.name.toLowerCase().includes(s) || c.slug.includes(slugOf(s) || s));
  if (loose.length === 1) return loose[0]!;
  return loose.length
    ? `"${q}" matches ${loose.map((c) => c.name).join(", ")}; say which`
    : `no client "${q}" (emplio clients list; add one with emplio clients add)`;
}

// Who handles them, as given (a teammate's user id, email or name, "me", or a team file: team/<name>), to their
// [[team/<name>]] links, with the team files to write for a teammate who has none yet (or whose file has no email:
// it's how a link finds who to give the work to). A string is what's wrong.
export async function handlerLinks(workspaceId: string, asked: string[], me: string | null, team: TeamMember[], things: Thing[]): Promise<{ links: string[]; files: File[] } | string> {
  const people = things.filter((t) => t.kind === "team");
  const links: string[] = [];
  const files: File[] = [];
  for (const raw of asked) {
    const part = raw.trim().toLowerCase();
    if (!part) continue;
    if (/^team\/[a-z0-9-]+$/.test(part) && people.some((t) => t.path === part)) {
      links.push(part);
      continue;
    }
    const hits = part === "me" ? team.filter((m) => m.id === me) : team.filter((m) => m.id === part || m.email === part || m.name?.toLowerCase() === part);
    const loose = hits.length ? hits : team.filter((m) => m.name?.toLowerCase().includes(part) || m.email.includes(part));
    const m = loose.length === 1 ? loose[0]! : null;
    if (!m) {
      // someone with a team file who isn't a member (a freelancer)
      const file = people.filter((t) => t.title.toLowerCase() === part);
      if (!loose.length && file.length === 1) {
        links.push(file[0]!.path);
        continue;
      }
      return loose.length ? `"${raw}" matches ${loose.map((x) => x.name ?? x.email).join(", ")}; use their email` : `nobody on the team matches "${raw}" (emplio team list)`;
    }
    const mine = people.find((t) => memberOf(t, team)?.id === m.id);
    if (mine) {
      if (!mine.fields.email) files.push({ path: thingFile(mine.path), content: setFields((await readFile(workspaceId, "company", thingFile(mine.path))) ?? "", { email: m.email }) });
      links.push(mine.path);
      continue;
    }
    // a new team file, under a name no other file has
    const base = slugOf(m.name ?? m.email.split("@")[0]!) || "teammate";
    let path = `team/${base}`;
    for (let n = 2; people.some((t) => t.path === path) || files.some((f) => f.path === thingFile(path)); n++) path = `team/${base}-${n}`;
    files.push({ path: thingFile(path), content: setFields("", { name: m.name ?? m.email, email: m.email, role: m.role }) });
    links.push(path);
  }
  return { links: [...new Set(links)], files };
}

// One commit to the company files as whoever made the change, read back before anything reads them.
async function commit(w: Who, files: { path: string; content: string | null }[], message: string) {
  const me = (await listTeam(w.workspaceId)).find((m) => m.id === w.userId);
  await writeFiles(w.workspaceId, "company", files, message, me ? { name: me.name ?? me.email, email: me.email } : UPKEEP);
  // this sync also starts the new-client automations for one added as active or won (file-index.ts)
  await syncFiles(w.workspaceId, "company");
}

// The file's top lines for what's asked; a string is what's wrong.
async function changes(w: Who, input: ClientInput, old: Client | null): Promise<{ set: Record<string, unknown>; files: File[] } | string> {
  if (input.name !== undefined && !slugOf(input.name)) return "a client needs a name";
  if (input.stage !== undefined && !CLIENT_STAGES.includes(input.stage)) return `stage is one of ${CLIENT_STAGES.join(", ")}`;
  const set: Record<string, unknown> = {};
  let files: File[] = [];
  if (input.name !== undefined) set.name = input.name.replace(/\s+/g, " ").trim();
  if (input.stage !== undefined) set.stage = input.stage;
  if (input.handlers !== undefined) {
    const [team, things] = await Promise.all([listTeam(w.workspaceId), listThings(w.workspaceId, "team")]);
    const h = await handlerLinks(w.workspaceId, input.handlers, w.userId, team, things);
    if (typeof h === "string") return h;
    set.handler = h.links.length ? h.links.map((l) => `[[${l}]]`) : null;
    files = h.files;
  }
  if (input.details !== undefined) {
    const d = mergeDetails(old?.details ?? [], input.details);
    if (typeof d === "string") return d;
    for (const o of old?.details ?? []) set[o.name.toLowerCase()] = null;
    // a fee is a number in the file (things.ts), the rest text as given
    for (const n of d) set[n.name.toLowerCase()] = n.name.toLowerCase() === "fee" && /^\d+(\.\d+)?$/.test(n.value) ? Number(n.value) : n.value;
  }
  return { set, files };
}

const fileOf = (slug: string) => thingFile(`${FOLDER}/${slug}`);
const reread = async (w: Who, slug: string) => (await listClients(w)).find((c) => c.slug === slug)!;

export async function addClient(w: Who, input: ClientInput, conversationId?: string): Promise<Result> {
  if (input.name === undefined) return { ok: false, error: "a client needs a name" };
  const c = await changes(w, { ...input, stage: input.stage ?? "active" }, null);
  if (typeof c === "string") return { ok: false, error: c };
  const slug = slugOf(input.name);
  if ((await listClients(w)).some((x) => x.slug === slug)) return { ok: false, error: `already a client: emplio clients show ${slug}` };
  // ponytail: a file in clients/ Gitea has but the search copy doesn't yet is replaced; the copy follows every commit
  await commit(w, [{ path: fileOf(slug), content: setFields("", c.set) }, ...c.files], `Client ${c.set.name} added`);
  record({ workspaceId: w.workspaceId, userId: w.userId, conversationId: conversationId || null, kind: "client", summary: `Added client ${c.set.name}` });
  return { ok: true, client: await reread(w, slug) };
}

export async function updateClient(w: Who, q: string, input: ClientInput, conversationId?: string): Promise<Result> {
  // details (a contact's email, a tax number) anyone may fill in; the rest is for the owner and admins
  if (!isAdmin(w) && Object.keys(input).some((k) => k !== "details")) return { ok: false, error: "only the owner or an admin can change a client (anyone can add their details)" };
  const old = await findClient(w.workspaceId, q);
  if (typeof old === "string") return { ok: false, error: old };
  const c = await changes(w, input, old);
  if (typeof c === "string") return { ok: false, error: c };
  // the file keeps its name, and so tasks and chats keep pointing at it
  const text = (await readFile(w.workspaceId, "company", fileOf(old.slug))) ?? "";
  const next = setFields(text, c.set);
  if (next !== text || c.files.length) await commit(w, [{ path: fileOf(old.slug), content: next }, ...c.files], `Client ${old.name} changed`);
  record({ workspaceId: w.workspaceId, userId: w.userId, conversationId: conversationId || null, kind: "client", summary: `Changed client ${c.set.name ?? old.name}` });
  return { ok: true, client: await reread(w, old.slug) };
}

// Their file goes; their tasks, process runs and chats stay, without the label.
export async function removeClient(w: Who, q: string, conversationId?: string) {
  if (!isAdmin(w)) return { ok: false as const, error: "only the owner or an admin can remove a client; set them to past instead" };
  const c = await findClient(w.workspaceId, q);
  if (typeof c === "string") return { ok: false as const, error: c };
  await commit(w, [{ path: fileOf(c.slug), content: null }], `Client ${c.name} removed`);
  for (const t of [tasks, processRuns, conversations])
    await db.update(t).set({ client: null }).where(and(eq(t.workspaceId, w.workspaceId), eq(t.client, c.slug)));
  record({ workspaceId: w.workspaceId, userId: w.userId, conversationId: conversationId || null, kind: "client", summary: `Removed client ${c.name}` });
  return { ok: true as const, name: c.name };
}

// A chat is about the first client it's tied to (a task for them added in it, or them @mentioned); kept after that.
export async function labelChat(conversationId: string | null | undefined, client: string | null | undefined) {
  if (!conversationId || !client) return;
  await db.update(conversations).set({ client }).where(and(eq(conversations.id, conversationId), sql`${conversations.client} is null`));
}

// @mentioned clients (their file's path, mentions.ts) in a message: the first one labels the chat
export async function labelFromMentions(workspaceId: string, conversationId: string, picked: unknown) {
  const slugs = (Array.isArray(picked) ? picked : []).flatMap((m) => {
    const slug = m?.kind === "record" && typeof m.id === "string" ? new RegExp(`^company/${FOLDER}/([^/]+)/index\\.md$`).exec(m.id)?.[1] : null;
    return slug ? [slug] : [];
  });
  if (!slugs.length) return;
  if ((await listThings(workspaceId, FOLDER)).some((t) => t.path === `${FOLDER}/${slugs[0]}`)) await labelChat(conversationId, slugs[0]);
}

// What the model is told each turn in a chat about one client: who they are and where the rest is.
export async function clientNote(workspaceId: string, slug: string) {
  const c = (await listClients({ workspaceId })).find((x) => x.slug === slug);
  return c ? clientNoteText(c) : "";
}
// the words of it, for a client as the app lists them (the evals use these too)
export const clientNoteText = (c: Client) =>
  `This chat is about the client ${c.name} (${c.stage}; handled by ${c.handlers.map((h) => h.name).join(", ") || "nobody named yet"}; ${c.openTasks} open task${c.openTasks === 1 ? "" : "s"}${c.waitingTasks ? `, ${c.waitingTasks} waiting` : ""})${c.details.length ? `; ${c.details.map((d) => `${d.name}: ${d.value}`).join("; ")}` : ""}. Their notes: /work/${notesPath(c)}; their open work: emplio clients show ${c.slug}. Tasks you add here are for them (--client ${c.slug}) unless plainly not.`;

// --- `emplio clients` ---

export const USAGE = `usage: emplio clients list [--stage prospect|active|past]   every client: stage, who handles them, open tasks
       emplio clients show <name>                         one client: who handles them, their details, open tasks, their file
       emplio clients add <name> [options] ["Detail=value"]...      a new client (anyone): their page company/${FOLDER}/<slug>/index.md
       emplio clients update <name> [options] ["Detail=value"]...   change one (owner and admins; details: anyone)
       emplio clients remove <name>                       delete one added by mistake (owner and admins); otherwise --stage past
options: --stage prospect|active|past   prospect: not won yet; past: no longer working with them (default: active)
         --handler <names or emails>    who on the team looks after them, comma-separated; "none" clears it
         --name <new name>              update only; the file keeps its name
Name, stage, handler ("[[team/<name>]]") and details are the YAML at the top of their page, their notes below;
change those with this command (not by editing the file), so the app reacts (a client won starts its automations).
         "Detail=value"                 a short fact kept on them: "Contact email=sarah@northwind.com" "Tax number=27AAACN1234F1Z5"
                                        "Files=monthly"; "Detail=" removes one. A process input of the same name is filled in
                                        from it, and a schedule can pick clients by one (clients: [Files=monthly]). The rest of
                                        what's known goes in their notes, below.
A task for a client: emplio tasks add ... --client <name>; theirs: emplio tasks list --client <name>.`;

const line = (c: Client) =>
  [c.slug, c.stage, c.handlers.length ? c.handlers.map((h) => h.name).join(", ") : "nobody named", `${c.openTasks} open${c.waitingTasks ? ` (${c.waitingTasks} waiting)` : ""}`, c.name].join("\t");

const asData = (c: Client) => ({ slug: c.slug, name: c.name, stage: c.stage, handled_by: c.handlers.map((h) => h.name), details: Object.fromEntries(c.details.map((d) => [d.name, d.value])), open_tasks: c.openTasks, waiting_tasks: c.waitingTasks, notes: notesPath(c) });

export async function clientsCommand(w: Who, conversationId: string, args: string[], data = false) {
  const [sub, ...rest] = args;
  const words: string[] = [];
  const opts: Record<string, string> = {};
  const detailArgs: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (a.startsWith("--")) opts[a.slice(2)] = rest[++i] ?? "";
    // Stage=active, Handler=Raj, Name=X are the options, not details
    else if (["stage", "handler", "name"].includes(a.slice(0, a.indexOf("=")).trim().toLowerCase())) opts[a.slice(0, a.indexOf("=")).trim().toLowerCase()] = a.slice(a.indexOf("=") + 1).trim();
    else if (a.includes("=")) detailArgs.push(a);
    else words.push(a);
  }
  const input = (): ClientInput | string => {
    const i: ClientInput = {};
    if (opts.stage !== undefined) i.stage = opts.stage as ClientStage;
    if (opts.name !== undefined) i.name = opts.name;
    // names, emails or "me", comma-separated
    if (opts.handler !== undefined) i.handlers = opts.handler.trim().toLowerCase() === "none" ? [] : opts.handler.split(",");
    if (detailArgs.length) i.details = Object.fromEntries(detailArgs.map((a) => [a.slice(0, a.indexOf("=")), a.slice(a.indexOf("=") + 1)]));
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
    const client = c;
    if (data) return JSON.stringify(asData(client));
    const open = await db
      .select({ id: tasks.id, title: tasks.title, status: tasks.status, waitingOn: tasks.waitingOn, dueAt: tasks.dueAt })
      .from(tasks)
      .where(and(eq(tasks.workspaceId, w.workspaceId), eq(tasks.client, c.slug), inArray(tasks.status, ["todo", "doing", "waiting"])))
      .orderBy(sql`${tasks.dueAt} asc nulls last`)
      .limit(30);
    // the files that link to them: their contacts, projects
    const linked = (await thingPage(w.workspaceId, `${FOLDER}/${c.slug}`).catch(() => null))?.linkedFrom ?? [];
    return [
      `${client.name} (${client.stage})`,
      `handled by: ${client.handlers.map((h) => h.name).join(", ") || "nobody named yet"}`,
      ...client.details.map((d) => `${d.name}: ${d.value}`),
      `page: /work/${notesPath(c)} (the lines above in its YAML top, their notes below; other notes on them beside it)`,
      ...linked.map((l) => `${l.kind === "contacts" ? "contact" : l.kind === "projects" ? "project" : l.kind}: ${l.title} (/work/company/${thingFile(l.from)}, as ${l.field})`),
      ...(open.length
        ? ["open tasks:", ...open.map((t) => `- ${t.id.slice(0, 8)} ${t.status} ${t.dueAt ? t.dueAt.toISOString().slice(0, 10) : "no due date"} ${t.title}${t.waitingOn ? ` (waiting on ${t.waitingOn})` : ""}`)]
        : ["no open tasks"]),
    ].join("\n");
  }
  if (sub === "add" && words.length) {
    const i = input();
    if (typeof i === "string") return i;
    const r = await addClient(w, { ...i, name: words.join(" ") }, conversationId);
    return r.ok ? `added ${line(r.client)}; their notes go in /work/${notesPath(r.client)}, below its YAML top` : `error: ${r.error}`;
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
    return r.ok ? `removed ${r.name} and their file (their tasks stay, without the client)` : `error: ${r.error}`;
  }
  return USAGE;
}

const BODY = {
  type: "object",
  properties: {
    name: { type: "string", maxLength: 200 },
    stage: { type: "string", enum: [...CLIENT_STAGES] },
    handlers: { type: "array", items: { type: "string", maxLength: 200 }, maxItems: 20 },
    details: { type: "object", maxProperties: 50, additionalProperties: { type: ["string", "null"], maxLength: 500 } },
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

  app.patch<{ Params: { slug: string }; Body: ClientInput }>("/clients/:slug", { schema: { body: BODY } }, async (req, reply) => {
    const ctx = await context(req, reply);
    if (!ctx) return;
    const r = await updateClient(ctx, req.params.slug, req.body);
    return r.ok ? r.client : reply.code(400).send({ error: r.error });
  });

  app.delete<{ Params: { slug: string } }>("/clients/:slug", async (req, reply) => {
    const ctx = await context(req, reply);
    if (!ctx) return;
    const r = await removeClient(ctx, req.params.slug);
    return r.ok ? r : reply.code(400).send({ error: r.error });
  });
}

if (import.meta.main) {
  console.assert(slugOf("Acme Foods Pvt. Ltd.") === "acme-foods-pvt-ltd");
  console.assert(slugOf("  Café Noir ") === "cafe-noir");
  console.assert(slugOf("!!!") === "");
  const d = mergeDetails([{ name: "Email", value: "a@x.com" }], { email: "b@x.com", "Files ": "monthly", Gone: "" }) as ClientDetail[];
  console.assert(d.length === 2 && d[0]!.value === "b@x.com" && d[1]!.name === "Files", "merge", d);
  console.assert((mergeDetails(d, { Files: null }) as ClientDetail[]).length === 1, "remove");
  const cs = [
    { slug: "a", name: "A", stage: "active", details: [{ name: "Files", value: "Monthly" }] },
    { slug: "b", name: "B", stage: "active", details: [] },
    { slug: "c", name: "C", stage: "prospect", details: [{ name: "Files", value: "monthly" }] },
  ];
  console.assert(pickClients(cs, ["files=monthly"]).map((c) => c.slug).join() === "a", "by detail");
  console.assert(pickClients(cs, ["B", "Files = Monthly"]).map((c) => c.slug).join() === "a,b", "mixed");
  const f = setFields("---\nname: A\nfiles: monthly\nOther: x\n---\n# A\nnotes\n", { stage: "past", files: null, name: "B" });
  console.assert(f === "---\nname: B\nOther: x\nstage: past\n---\n# A\nnotes\n", "set fields", f);
  console.assert(setFields("# A\n", { name: "A" }) === "---\nname: A\n---\n\n# A\n", "no top yet");
  const l = setFields("---\nname: A # kept\n---\n", { handler: ["[[team/a]]", "[[team/b]]"] });
  console.assert(l === '---\nname: A # kept\nhandler:\n  - "[[team/a]]"\n  - "[[team/b]]"\n---\n', "links as a quoted list", l);
  console.assert(typeof mergeDetails([], { "Tax no.": "1" }) === "string" && typeof mergeDetails([], { Stage: "x" }) === "string", "bad names");
  console.log("ok");
}
