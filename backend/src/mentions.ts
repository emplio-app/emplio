// @mentions in the chat box: teammates, files, clients and suppliers, tasks, earlier chats, connected apps and database
// tables, searched here as the person types (GET /mentions?q=). Picked ones travel in the message as a
// data-mentions part (so they're saved and shown with it); they're looked up again here, never trusted, and
// the agent gets one line per mention saying exactly what it is and where to find it.
import { FUZZY, matchScore, NO_MATCH, type Mention, type MentionKind } from "@emplio/shared";
import { and, desc, eq, ilike, notLike } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { context, type Ctx } from "./auth";
import { db } from "./db";
import { connections, conversations } from "./db/schema";
import { dayIn, timezoneOf } from "./time";
import { listTables } from "./database";
import { listTasks } from "./tasks";
import { listPaths } from "./gitea";
import { availableApps } from "./integrations";
import { listTeam } from "./team";
import { listAgents } from "./agents";

type Who = Pick<Ctx, "workspaceId" | "userId" | "role">;
const PER_KIND = 4;
const FUZZY_CHATS = 200;
// git's own files, and the pointers to big files kept in storage; everything else the Knowledge page shows can be @mentioned
const HIDDEN = /(^|\/)\.|\.media$/;
const RECORDS = /^knowledge\/(clients|suppliers|people)\/([^/]+)\.md$/;
const RECORD_KIND = { clients: "Client", suppliers: "Supplier", people: "Contact" } as const;

const pretty = (slug: string) => slug.replace(/[-_]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
const repos = (who: Who) => [
  { dir: "company", repo: "company" },
  ...(who.role !== "member" ? [{ dir: "restricted", repo: "restricted" }] : []),
  { dir: "me", repo: `me-${who.userId}` },
];

// every file the person can see, as file and client/supplier mentions; id is the path under /work
async function fileMentions(who: Who): Promise<Mention[]> {
  const lists = await Promise.all(
    repos(who).map(async (r) => (await listPaths(who.workspaceId, r.repo).catch(() => [])).map((f) => ({ ...f, dir: r.dir }))),
  );
  return lists.flat().flatMap(({ path, dir }): Mention[] => {
    if (HIDDEN.test(path)) return [];
    const record = dir === "company" ? RECORDS.exec(path) : null;
    if (record) return [{ kind: "record", id: `${dir}/${path}`, label: pretty(record[2]!), detail: RECORD_KIND[record[1] as keyof typeof RECORD_KIND] }];
    return [{ kind: "file", id: `${dir}/${path}`, label: path.split("/").pop()!, detail: `${dir}/${path.split("/").slice(0, -1).join("/")}`.replace(/\/$/, "") }];
  });
}

async function chatMentions(who: Who, q: string): Promise<Mention[]> {
  const select = (matching: boolean, limit: number) =>
    db
      .select({ id: conversations.id, title: conversations.title, updatedAt: conversations.updatedAt })
      .from(conversations)
      // automation runs are many chats with one title: left out
      .where(and(eq(conversations.workspaceId, who.workspaceId), eq(conversations.userId, who.userId), notLike(conversations.title, "Automation:%"), matching ? ilike(conversations.title, `%${q.replace(/[%_\\]/g, "\\$&")}%`) : undefined))
      .orderBy(desc(conversations.updatedAt))
      .limit(limit);
  // exact words in any chat; a typo or skipped letters only among the recent ones, the database can't rank those
  // ponytail: FUZZY_CHATS recent titles; pg_trgm if older chats need finding by a misspelling
  const [exact, recent] = await Promise.all(q ? [select(true, PER_KIND), select(false, FUZZY_CHATS)] : [select(false, PER_KIND), []]);
  const seen = new Set(exact.map((c) => c.id));
  const fuzzy = recent
    .filter((c) => !seen.has(c.id) && matchScore(c.title, "", q) < NO_MATCH)
    .sort((a, b) => matchScore(a.title, "", q) - matchScore(b.title, "", q));
  const rows = [...exact, ...fuzzy].slice(0, PER_KIND);
  const tz = await timezoneOf(who.userId);
  return rows.map((c) => ({ kind: "chat", id: c.id, label: c.title, detail: `Chat · ${dayIn(c.updatedAt, tz)}` }));
}

// the tasks they can see (open ones first, as listTasks orders by due date); id is the task's id
const STATUS = { todo: "To do", doing: "Doing", waiting: "Waiting", done: "Done", cancelled: "Cancelled" } as const;
const taskMentions = async (who: Who): Promise<Mention[]> =>
  (await listTasks(who, {}))
    .sort((a, b) => Number(["done", "cancelled"].includes(a.status)) - Number(["done", "cancelled"].includes(b.status)))
    .map((t) => ({ kind: "task", id: t.id, label: t.title.slice(0, 80), detail: `Task · ${STATUS[t.status]} · ${t.assigneeName}` }));

const people = async (who: Who): Promise<Mention[]> =>
  (await listTeam(who.workspaceId)).map((m) => ({ kind: "person", id: m.id, label: m.name ?? m.email, detail: m.name ? m.email : m.role }));

// Emplio's agents (Supplier Finder, ...), so work can be pointed at one; id is its slug
const agents = async (who: Who): Promise<Mention[]> =>
  (await listAgents(who.workspaceId)).filter((a) => !a.archived).map((a) => ({ kind: "agent", id: a.slug, label: a.name, detail: "Agent" }));

// straight from the table (listConnections asks the provider about each one, too slow per keystroke)
const apps = async (who: Who): Promise<Mention[]> => {
  const [rows, offered] = await Promise.all([
    db
      .select({ id: connections.id, app: connections.app, label: connections.label })
      .from(connections)
      .where(and(eq(connections.workspaceId, who.workspaceId), eq(connections.userId, who.userId), eq(connections.status, "active"))),
    availableApps().catch(() => []),
  ]);
  return rows.map((c) => {
    const app = offered.find((a) => a.app === c.app);
    const name = app?.name ?? c.app;
    return { kind: "app", id: c.id, label: c.label && c.label !== name ? `${name} (${c.label})` : name, detail: "Connected app", logo: app?.logo };
  });
};

// ponytail: table list cached a minute per business; it opens the business's database
const tableCache = new Map<string, { at: number; list: Promise<Mention[]> }>();
const tables = (who: Who) => {
  // staff don't see private tables, so theirs is a different list
  const key = `${who.workspaceId}:${who.role === "member"}`;
  const hit = tableCache.get(key);
  if (hit && Date.now() - hit.at < 60_000) return hit.list;
  const list = listTables(who).then((ts) =>
    ts.map((t): Mention => ({ kind: "table", id: t.name, label: t.name, detail: `Table${t.rows === null ? "" : ` · ${t.rows.toLocaleString()} rows`}` })),
  );
  tableCache.set(key, { at: Date.now(), list });
  list.catch(() => tableCache.delete(key));
  return list;
};

// best first (matchScore in shared)
const scoreOf = (m: Mention, q: string) => matchScore(m.label, m.detail ?? "", q);
function rank(items: Mention[], q: string) {
  if (!q) return items;
  return items.filter((m) => scoreOf(m, q) < NO_MATCH).sort((a, b) => scoreOf(a, q) - scoreOf(b, q) || a.label.length - b.label.length);
}

// apps before files and chats: "@gma" means Gmail more often than a chat about Gmail
const ORDER: MentionKind[] = ["person", "agent", "app", "record", "task", "file", "chat", "table"];

export async function searchMentions(who: Who, query: string): Promise<Mention[]> {
  const q = query.trim().toLowerCase().slice(0, 60);
  // a source that fails (git down, no database yet) just shows nothing
  const safe = (p: Promise<Mention[]>) => p.catch(() => []);
  const [team, agentList, files, chats, connected, tbls, tsks] = await Promise.all([
    safe(people(who)),
    safe(agents(who)),
    // with nothing typed yet: people, recent chats and apps, not the whole file tree
    q ? safe(fileMentions(who)) : Promise.resolve([]),
    safe(chatMentions(who, q)),
    safe(apps(who)),
    q ? safe(tables(who)) : Promise.resolve([]),
    q ? safe(taskMentions(who)) : Promise.resolve([]),
  ]);
  const all = [...rank(team.filter((m) => m.id !== who.userId), q), ...rank(agentList, q), ...rank(files, q), ...chats, ...rank(connected, q), ...rank(tbls, q), ...rank(tsks, q)];
  // letters in order or a typo only count when nothing matches properly, so they never crowd out what was meant
  const proper = all.filter((m) => scoreOf(m, q) < FUZZY);
  const shown = proper.length ? proper : all;
  return ORDER.flatMap((k) => shown.filter((m) => m.kind === k).slice(0, PER_KIND));
}

// What the agent is told about the mentions in a message; unknown or not-theirs ones are dropped.
export async function describeMentions(who: Who, picked: unknown): Promise<string | null> {
  if (!Array.isArray(picked) || !picked.length) return null;
  const wanted = picked
    .slice(0, 10)
    .filter((m): m is { kind: MentionKind; id: string } => !!m && ORDER.includes(m.kind) && typeof m.id === "string" && m.id.length < 400);
  const need = (k: MentionKind) => wanted.some((m) => m.kind === k);
  const safe = (p: Promise<Mention[]>) => p.catch(() => []);
  const known = (
    await Promise.all([
      need("person") ? safe(people(who)) : [],
      need("agent") ? safe(agents(who)) : [],
      need("file") || need("record") ? safe(fileMentions(who)) : [],
      need("app") ? safe(apps(who)) : [],
      need("table") ? safe(tables(who)) : [],
      need("task") ? safe(taskMentions(who)) : [],
      need("chat")
        ? db
            .select({ id: conversations.id, title: conversations.title })
            .from(conversations)
            .where(and(eq(conversations.workspaceId, who.workspaceId), eq(conversations.userId, who.userId)))
            .then((rows) => rows.map((c): Mention => ({ kind: "chat", id: c.id, label: c.title })))
        : [],
    ])
  ).flat();
  const lines = wanted.flatMap((w) => {
    // a client's notes mentioned as a file (from the Knowledge page) are still that client
    const m = known.find((k) => k.id === w.id && (k.kind === w.kind || (w.kind === "file" && k.kind === "record")));
    if (!m) return [];
    switch (m.kind) {
      case "person":
        return [`- @${m.label}: the teammate ${m.label} (${m.detail}).`];
      case "agent":
        return [`- @${m.label}: your agent ${m.label}; this work is for it: emplio hand ${m.id}.`];
      case "record":
        return [`- @${m.label}: ${m.detail?.toLowerCase()}; their notes are in /work/${m.id}: read it first.`];
      case "file":
        return [`- @${m.label}: the file /work/${m.id}; use this exact one.`];
      case "chat":
        return [`- @${m.label}: an earlier chat of theirs; read it with emplio history show ${m.id.slice(0, 8)}.`];
      case "app":
        return [`- @${m.label}: use this connected account${m.label.includes("(") ? ` (--account "${m.label.slice(m.label.indexOf("(") + 1, -1)}")` : ""}.`];
      case "task":
        return [`- @${m.label}: the task ${m.id.slice(0, 8)} (emplio tasks show ${m.id.slice(0, 8)}).`];
      case "table":
        return [`- @${m.label}: the database table ${m.label} (emplio db schema ${m.label}).`];
    }
  });
  return lines.length ? ["The person pointed at these with @ (exactly these, not similar ones):", ...lines].join("\n") : null;
}

export async function mentionRoutes(app: FastifyInstance) {
  app.get<{ Querystring: { q?: string } }>("/mentions", async (req, reply) => {
    const ctx = await context(req, reply);
    if (!ctx) return;
    return searchMentions(ctx, req.query.q ?? "");
  });
}
