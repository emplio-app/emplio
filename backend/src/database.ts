// Each business's own SQL database (SQLite): for structured records the agent keeps and queries
// (leads, orders, stock, ...), with real tables, indexes, foreign keys, views, triggers and transactions.
// The agent gets plain SQL through `emplio db`; this server runs every statement and records each one in
// db_queries. Made on first use, one per business, as a SQLite file in ./data (DATA_DB_DIR).
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createClient, type Client, type InValue, type ResultSet } from "@libsql/client";
import type { DbRows, DbTable } from "@emplio/shared";
import { and, desc, eq, isNull, sql as dsql } from "drizzle-orm";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { context } from "./auth";
import { db } from "./db";
import { record } from "./activity";
import { dbQueries, users, workspaces } from "./db/schema";
import { cloud } from "./cloud";

const LOCAL_DIR = resolve(process.env.DATA_DB_DIR ?? "./data");

export class DbError extends Error {}

type Who = { workspaceId: string; userId: string; role: "owner" | "admin" | "member" };
export const canChangeSchema = (who: Who) => who.role !== "member";
const VISIBLE = "type in ('table', 'view') and name not like 'sqlite_%' and name not like '_litestream%' and name not like 'libsql_%'";

export const dbName = (workspaceId: string, suffix = "") => `e0-${cloud.records.group}-${workspaceId}${suffix}`;


// One client per database for the life of the process, with foreign keys on (SQLite's default is off).
const opened = new Map<string, Promise<Client>>();
export function connect(url: string) {
  let client = opened.get(url);
  if (!client) {
    const c = createClient({ url, authToken: url.startsWith("file:") ? undefined : cloud.records.authToken });
    client = c.execute("pragma foreign_keys = on").then(() => c);
    opened.set(url, client);
    // a failure isn't remembered: the next use tries again
    client.catch(() => opened.delete(url));
  }
  return client;
}

// The business's database, made on first use.
async function dbFor(workspaceId: string) {
  const [row] = await db.select({ url: workspaces.dataDb }).from(workspaces).where(eq(workspaces.id, workspaceId));
  if (row?.url) return connect(row.url);
  let url = (await cloud.records.create?.(dbName(workspaceId))) ?? "";
  if (!url) {
    await mkdir(LOCAL_DIR, { recursive: true });
    url = `file:${join(LOCAL_DIR, `${dbName(workspaceId)}.db`)}`;
  }
  // two first uses at once both create (the same database) and both save; the first one wins
  await db.update(workspaces).set({ dataDb: url }).where(and(eq(workspaces.id, workspaceId), isNull(workspaces.dataDb)));
  const [saved] = await db.select({ url: workspaces.dataDb }).from(workspaces).where(eq(workspaces.id, workspaceId));
  return connect(saved!.url!);
}

// What a statement does, read off its words (string literals blanked first so their text can't fool it).
export function classify(sql: string) {
  // one pass, left to right: a quote inside a comment (or the reverse) can't hide what's after it
  const code = sql.replace(/'(?:[^']|'')*'|"(?:[^"]|"")*"|`(?:[^`]|``)*`|--[^\n]*|\/\*[\s\S]*?(?:\*\/|$)/g, (m) => (m[0] === "-" || m[0] === "/" ? " " : "''"));
  if (/\b(attach|detach|vacuum)\b/i.test(code) || /\bpragma\s+(?!(table_x?info|table_list|index_list|index_info|index_xinfo|foreign_key_list|foreign_key_check|integrity_check|quick_check)\b)/i.test(code))
    return "forbidden" as const;
  if (/\b(create|alter|drop)\s+(temp\s+|temporary\s+|unique\s+|virtual\s+)?(table|index|view|trigger)\b/i.test(code)) return "schema" as const;
  if (/\b(insert|update|delete|replace|upsert)\b/i.test(code)) return "write" as const;
  return "read" as const;
}

// --- private tables ---
// Staff can use every table except private ones. Emplio marks a table private when it makes it, in an owner's or
// admin's chat; a table nobody decided about goes by its name; the owner can change either in the Database tab.
// What's decided lives in Postgres, so restoring the database to an earlier time can't reopen a table.
// ponytail: renaming a table loses what was decided about it; it goes by its new name until someone decides again
const SENSITIVE = /(^|[_\W])(api_?keys?|keys|secrets?|tokens?|passwords?|credentials?|logins?|salar(y|ies)|payrolls?|wages|banks?|banking|bank_?accounts?|compensation|hr|finances?|financials?)($|[_\W])/i;

type Entry = { name: string; type: string; sql: string | null };

// Every name in a statement, lowercase, however it's written: bare, "quoted", `quoted`, [quoted], or 'quoted' (which
// SQLite also takes as a table's name). Read left to right, so a quote in a comment can't hide what follows.
export function namesIn(sql: string) {
  const names = new Set<string>();
  const tokens = /'((?:[^']|'')*)'|"((?:[^"]|"")*)"|`((?:[^`]|``)*)`|\[([^\]]*)\]|--[^\n]*|\/\*[\s\S]*?(?:\*\/|$)|([\p{L}_][\p{L}\p{N}_$]*)/gu;
  for (const m of sql.matchAll(tokens)) {
    const name = m[1]?.replaceAll("''", "'") ?? m[2]?.replaceAll('""', '"') ?? m[3]?.replaceAll("``", "`") ?? m[4] ?? m[5];
    if (name !== undefined) names.add(name.toLowerCase());
  }
  return names;
}

// The private ones among a database's tables and views, including what would show them anyway: views over one
// and full-text search's own tables (name_data, ...). A view someone opened on purpose stays open.
export function privateTables(entries: Entry[], access: Record<string, "private" | "staff">) {
  const out = new Set<string>();
  const decided = (e: Entry) => access[e.name.toLowerCase()];
  for (const e of entries) if ((decided(e) ?? (SENSITIVE.test(e.name) ? "private" : "staff")) === "private") out.add(e.name.toLowerCase());
  for (let grew = true; grew; ) {
    grew = false;
    for (const e of entries) {
      const name = e.name.toLowerCase();
      if (out.has(name) || decided(e) === "staff") continue;
      const showsOne = e.type === "view" ? [...namesIn(e.sql ?? "")].some((n) => out.has(n)) : [...out].some((p) => name.startsWith(`${p}_`));
      if (showsOne) grew = !!out.add(name);
    }
  }
  return out;
}

// Why a staff chat may not run this, if so. It goes by names, so it can refuse a statement that only has a private
// table's name as a column or a value; never the other way round, since SQLite has no way to build a name while running.
export function refusedForStaff(sql: string, hidden: Set<string>) {
  const names = [...namesIn(sql)];
  // what lists every table, or reads one's definition, whatever it's called
  if (names.some((n) => n === "pragma" || n === "dbstat" || n === "load_extension" || n.startsWith("sqlite_") || n.startsWith("pragma_")))
    return "this chat sees tables and their columns through emplio db tables and emplio db schema";
  const hit = names.find((n) => hidden.has(n));
  return hit ? `${hit} is private: only the owner or an admin can use it` : null;
}

async function hiddenFrom(client: Client, workspaceId: string) {
  const [[row], { rows }] = await Promise.all([
    db.select({ access: workspaces.dbAccess }).from(workspaces).where(eq(workspaces.id, workspaceId)),
    client.execute(`select name, type, sql from sqlite_schema where ${VISIBLE}`),
  ]);
  return privateTables(rows.map((r) => ({ name: String(r.name), type: String(r.type), sql: r.sql === null ? null : String(r.sql) })), row?.access ?? {});
}

async function staffGuard(who: Who, client: Client, sql: string) {
  if (who.role !== "member") return;
  const refused = refusedForStaff(sql, await hiddenFrom(client, who.workspaceId));
  if (refused) throw new DbError(refused);
}

// Make a table private, or open to staff.
export async function setPrivate(who: Who, table: string, on: boolean) {
  if (!canChangeSchema(who)) throw new DbError("only the owner or an admin can change who sees a table");
  const client = await dbFor(who.workspaceId);
  const known = await client.execute({ sql: `select name from sqlite_schema where ${VISIBLE} and name = ? collate nocase`, args: [table] });
  if (!known.rows.length) throw new DbError(`No table ${table}.`);
  const setting = JSON.stringify({ [String(known.rows[0]!.name).toLowerCase()]: on ? "private" : "staff" });
  await db.update(workspaces).set({ dbAccess: dsql`${workspaces.dbAccess} || ${setting}::jsonb` }).where(eq(workspaces.id, who.workspaceId));
  record({ ...who, conversationId: null, kind: "database", summary: `Made the table ${known.rows[0]!.name} ${on ? "private" : "open to staff"}` });
}

// Run something and record it, whatever happens.
export async function logged<T>(
  who: Who,
  conversationId: string | null,
  kind: (typeof dbQueries.$inferInsert)["kind"],
  sql: string,
  fn: () => Promise<T>,
  count: (result: T) => number,
) {
  const started = Date.now();
  const done = await fn().then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  );
  const error = done.ok ? null : done.error instanceof Error ? done.error.message : String(done.error);
  record({ ...who, conversationId, kind: "database", summary: `${kind}: ${sql.slice(0, 200)}${error ? ` (failed: ${error})` : ""}` });
  await db.insert(dbQueries).values({
    workspaceId: who.workspaceId,
    userId: who.userId,
    conversationId,
    kind,
    sql: sql.slice(0, 20_000),
    ok: done.ok,
    error,
    rows: done.ok ? count(done.value) : null,
    ms: Date.now() - started,
  });
  // SQLite's own messages ("no such table: leads") are what the agent needs to fix its SQL
  if (!done.ok) throw done.error instanceof DbError ? done.error : new DbError(error!.replace(/^SQLITE_\w+: /, ""));
  return done.value;
}

function permit(who: Who, kind: ReturnType<typeof classify>): asserts kind is Exclude<ReturnType<typeof classify>, "forbidden"> {
  if (kind === "forbidden") throw new DbError("ATTACH, DETACH and PRAGMAs that change settings aren't allowed; PRAGMA table_info and the other read-only ones are");
  if (kind === "schema" && !canChangeSchema(who)) throw new DbError("only the owner or an admin can create, change or drop tables, indexes, views and triggers");
}

// One statement, with ? or :name parameters. Returns its rows (or how many rows it changed).
export async function runSql(who: Who, sql: string, args: InValue[] | Record<string, InValue> = [], conversationId: string | null = null) {
  const kind = classify(sql);
  permit(who, kind);
  const client = await dbFor(who.workspaceId);
  return logged(
    who,
    conversationId,
    kind,
    sql,
    async () => {
      await staffGuard(who, client, sql);
      return client.execute({ sql, args });
    },
    (r) => (r.columns.length ? r.rows.length : r.rowsAffected),
  );
}

// Several statements as one transaction: all of them happen, or none.
export async function runScript(who: Who, script: string, conversationId: string | null = null) {
  const kind = classify(script);
  permit(who, kind);
  const client = await dbFor(who.workspaceId);
  return logged(
    who,
    conversationId,
    kind,
    script,
    async () => {
      await staffGuard(who, client, script);
      const tx = await client.transaction("write");
      try {
        await tx.executeMultiple(script);
        await tx.commit();
      } catch (error) {
        await tx.rollback().catch(() => {});
        throw error;
      } finally {
        tx.close();
      }
      return null;
    },
    () => 0,
  );
}

// Rows (objects) into a table that exists, in one transaction. Nested values are stored as JSON.
export async function importRows(who: Who, table: string, rows: Record<string, unknown>[], conversationId: string | null = null) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(table)) throw new DbError(`"${table}" isn't a plain table name`);
  if (!rows.length) throw new DbError("no rows to import");
  const columns = [...new Set(rows.flatMap((r) => Object.keys(r)))];
  const insert = `insert into "${table}" (${columns.map((c) => `"${c.replaceAll('"', '""')}"`).join(", ")}) values (${columns.map(() => "?").join(", ")})`;
  const value = (v: unknown): InValue =>
    v === undefined || v === null ? null : typeof v === "boolean" ? Number(v) : typeof v === "object" ? JSON.stringify(v) : (v as InValue);
  const client = await dbFor(who.workspaceId);
  return logged(
    who,
    conversationId,
    "import",
    `${insert} -- ${rows.length} rows`,
    async () => {
      await staffGuard(who, client, insert);
      await client.batch(rows.map((r) => ({ sql: insert, args: columns.map((c) => value(r[c])) })), "write");
      return rows.length;
    },
    (n) => n,
  );
}

// Tables, views and their row counts.
export async function listTables(who: Who) {
  const client = await dbFor(who.workspaceId);
  const [{ rows }, hidden] = await Promise.all([client.execute(`select name, type from sqlite_schema where ${VISIBLE} order by type, name`), hiddenFrom(client, who.workspaceId)]);
  return Promise.all(
    rows
      .filter((r) => who.role !== "member" || !hidden.has(String(r.name).toLowerCase()))
      .map(async (r) => {
      const name = String(r.name);
      const count = await client.execute(`select count(*) as n from "${name.replaceAll('"', '""')}"`).catch(() => null);
      return { name, type: String(r.type), rows: count ? Number(count.rows[0]!.n) : null, private: hidden.has(name.toLowerCase()) };
    }),
  );
}

// Rows in any table that have every word (any case) somewhere in their text, up to 5 a table.
// ponytail: a LIKE scan of every table; fine for a business's records, full-text tables if one grows huge
export async function searchRows(who: Who, words: string[]) {
  const client = await dbFor(who.workspaceId);
  const out: string[] = [];
  for (const { name, type } of await listTables(who)) {
    if (type !== "table") continue;
    const q = `"${name.replaceAll('"', '""')}"`;
    const cols = (await client.execute(`select name from pragma_table_info('${name.replaceAll("'", "''")}')`)).rows.map((r) => `"${String(r.name).replaceAll('"', '""')}"`);
    if (!cols.length) continue;
    const row = `(${cols.map((c) => `coalesce(${c}, '')`).join(" || ' ' || ")})`;
    const where = words.map(() => `${row} like ? escape '\\'`).join(" and ");
    const args = words.map((w) => `%${w.replace(/[\\%_]/g, "\\$&")}%`);
    const r = await client.execute({ sql: `select * from ${q} where ${where} limit 5`, args }).catch(() => null);
    if (!r?.rows.length) continue;
    const total = r.rows.length < 5 ? r.rows.length : Number((await client.execute({ sql: `select count(*) as n from ${q} where ${where}`, args })).rows[0]!.n);
    out.push(`${name}:`, asTable(r), ...(total > 5 ? [`${total - 5} more rows in ${name} not shown: query it with emplio db sql.`] : []));
  }
  return out.join("\n");
}

// How a table (or everything) is defined: the CREATE statements, indexes and triggers included.
export async function schemaOf(who: Who, table?: string) {
  const client = await dbFor(who.workspaceId);
  const { rows } = await client.execute({
    sql: "select sql, type, tbl_name from sqlite_schema where sql is not null and name not like 'sqlite_%' and name not like 'libsql_%' and (?1 is null or tbl_name = ?1) order by tbl_name, type desc, name",
    args: [table ?? null],
  });
  const hidden = who.role === "member" ? await hiddenFrom(client, who.workspaceId) : new Set<string>();
  // a table's foreign key may name a private one; a view or trigger that reads one would show how it's used
  const shown = (r: (typeof rows)[number]) =>
    !hidden.has(String(r.tbl_name).toLowerCase()) && (r.type === "table" || ![...namesIn(String(r.sql))].some((n) => hidden.has(n)));
  return rows.filter(shown).map((r) => `${r.sql};`).join("\n\n");
}

// Recent statements: owners and admins see the business's, staff their own.
export async function dbHistory(who: Who, limit = 20) {
  return db
    .select({ at: dbQueries.createdAt, kind: dbQueries.kind, sql: dbQueries.sql, ok: dbQueries.ok, error: dbQueries.error, rows: dbQueries.rows, by: users.name })
    .from(dbQueries)
    .leftJoin(users, eq(users.id, dbQueries.userId))
    .where(and(eq(dbQueries.workspaceId, who.workspaceId), who.role === "member" ? eq(dbQueries.userId, who.userId) : undefined))
    .orderBy(desc(dbQueries.createdAt))
    .limit(limit);
}

// "2026-10-22T09:30:00Z", "30 minutes ago", "2 hours ago", "1 day ago" → a Date
export function parseWhen(text: string, now = Date.now()) {
  const ago = /^(\d+)\s*(minute|min|hour|hr|day)s?\s+ago$/i.exec(text.trim());
  if (ago) {
    const unit = { minute: 60_000, min: 60_000, hour: 3_600_000, hr: 3_600_000, day: 86_400_000 }[ago[2]!.toLowerCase()]!;
    return new Date(now - Number(ago[1]) * unit);
  }
  const at = new Date(text);
  return Number.isNaN(at.getTime()) ? null : at;
}


// --- the Database tab in Memory: view only ---

const PAGE_ROWS = 50;
// ponytail: built in the browser from one JSON answer, on a small shared server; stream it if 50k gets too few
const EXPORT_ROWS = 50_000;

const quoted = (name: string) => `"${name.replaceAll('"', '""')}"`;
const contains = (text: string) => `%${text.replace(/[\\%_]/g, "\\$&")}%`;

export type TableView = { search?: string; sort?: string; dir?: "asc" | "desc"; filters?: Record<string, string> };

// One page of a table, searched, filtered and sorted. Only names that exist reach the SQL, quoted; everything
// typed goes in as a parameter; and the only statements here are selects.
export async function readTable(client: Client, table: string, view: TableView, offset: number, limit = PAGE_ROWS): Promise<DbRows> {
  const known = await client.execute({ sql: `select 1 from sqlite_schema where ${VISIBLE} and name = ?`, args: [table] });
  if (!known.rows.length) throw new DbError(`No table ${table}.`);
  const names = (await client.execute({ sql: "select name from pragma_table_info(?)", args: [table] })).rows.map((r) => String(r.name));
  const filters = Object.entries(view.filters ?? {}).filter(([, text]) => text.trim());
  for (const name of [...filters.map(([n]) => n), ...(view.sort ? [view.sort] : [])])
    if (!names.includes(name)) throw new DbError(`No column ${name}.`);

  const wholeRow = `(${names.map((n) => `coalesce(${quoted(n)}, '')`).join(" || ' ' || ")})`;
  const words = (view.search ?? "").split(/\s+/).filter(Boolean);
  const tests = [...words.map(() => `${wholeRow} like ? escape '\\'`), ...filters.map(([n]) => `${quoted(n)} like ? escape '\\'`)];
  const args = [...words, ...filters.map(([, text]) => text.trim())].map(contains);
  const where = tests.length ? `where ${tests.join(" and ")}` : "";
  const order = view.sort ? `order by ${quoted(view.sort)} ${view.dir === "desc" ? "desc" : "asc"}` : "";

  const q = quoted(table);
  const total = Number((await client.execute({ sql: `select count(*) as n from ${q} ${where}`, args })).rows[0]!.n);
  if (limit === EXPORT_ROWS && total > limit) throw new DbError(`That's ${total} rows; Excel export takes up to ${limit}. Narrow it with search or a filter.`);
  const page = await client.execute({ sql: `select * from ${q} ${where} ${order} limit ? offset ?`, args: [...args, limit, offset] });
  return {
    columns: page.columns,
    rows: page.rows.map((row) => page.columns.map((_, i) => (row[i] === null || typeof row[i] === "number" ? (row[i] as number | null) : cell(row[i])))),
    total,
    offset,
    limit,
  };
}

// The tab is the owner's and admins': tables can hold things staff shouldn't browse.
export async function adminContext(req: FastifyRequest, reply: FastifyReply, who = context) {
  const ctx = await who(req, reply);
  if (!ctx) return null;
  if (ctx.role === "member") {
    reply.code(403).send({ error: "Only the owner and admins can see the database." });
    return null;
  }
  return ctx;
}

// Looking isn't first use: a business with no database yet stays without one. Browsing isn't recorded in
// db_queries, which is what was run on the data; an export is, since the data leaves.
// ponytail: whole cell values are sent; clip them here if a table of huge texts makes the page heavy
export async function databaseRoutes(app: FastifyInstance) {
  type Query = { table?: string; offset?: string; search?: string; sort?: string; dir?: string; filters?: string };
  const saved = async (workspaceId: string) => (await db.select({ url: workspaces.dataDb }).from(workspaces).where(eq(workspaces.id, workspaceId)))[0]?.url;
  const viewOf = (q: Query): TableView => {
    let filters: unknown;
    try {
      filters = JSON.parse(q.filters ?? "{}");
    } catch {
      throw new DbError("Those filters can't be read.");
    }
    if (!filters || typeof filters !== "object" || Object.values(filters).some((v) => typeof v !== "string")) throw new DbError("Those filters can't be read.");
    return { search: q.search, sort: q.sort || undefined, dir: q.dir === "desc" ? "desc" : "asc", filters: filters as Record<string, string> };
  };

  app.get("/database/tables", async (req, reply): Promise<DbTable[] | void> => {
    const ctx = await adminContext(req, reply);
    if (!ctx) return;
    return (await saved(ctx.workspaceId)) ? ((await listTables(ctx)) as DbTable[]) : [];
  });

  app.put<{ Params: { name: string }; Body: { private: boolean } }>(
    "/database/tables/:name/private",
    { schema: { body: { type: "object", required: ["private"], properties: { private: { type: "boolean" } } } } },
    async (req, reply) => {
      const ctx = await adminContext(req, reply);
      if (!ctx) return;
      if (!(await saved(ctx.workspaceId))) return reply.code(400).send({ error: "No table." });
      try {
        await setPrivate(ctx, req.params.name, req.body.private);
        return { ok: true };
      } catch (error) {
        if (error instanceof DbError) return reply.code(400).send({ error: error.message });
        throw error;
      }
    },
  );

  app.get<{ Querystring: Query }>("/database/rows", async (req, reply) => {
    const ctx = await adminContext(req, reply);
    if (!ctx) return;
    const url = await saved(ctx.workspaceId);
    if (!url) return reply.code(400).send({ error: "No table." });
    try {
      return await readTable(await connect(url), req.query.table ?? "", viewOf(req.query), Math.max(0, Math.floor(Number(req.query.offset)) || 0));
    } catch (error) {
      if (error instanceof DbError) return reply.code(400).send({ error: error.message });
      throw error;
    }
  });

  // Every row that matches (not just the page), for the browser to turn into an Excel file.
  app.get<{ Querystring: Query }>("/database/export", async (req, reply) => {
    const ctx = await adminContext(req, reply);
    if (!ctx) return;
    const url = await saved(ctx.workspaceId);
    if (!url) return reply.code(400).send({ error: "No table." });
    try {
      const table = req.query.table ?? "";
      const view = viewOf(req.query);
      const client = await connect(url);
      return await logged(ctx, null, "export", `export ${table} to Excel ${JSON.stringify(view)}`, () => readTable(client, table, view, 0, EXPORT_ROWS), (r) => r.rows.length);
    } catch (error) {
      if (error instanceof DbError) return reply.code(400).send({ error: error.message });
      throw error;
    }
  });
}

// --- output for the agent ---

const cell = (v: unknown) =>
  v === null ? "NULL" : v instanceof ArrayBuffer ? `<blob ${v.byteLength} bytes>` : typeof v === "object" ? JSON.stringify(v) : String(v);

// Rows as a tab-separated table with a header.
export const asTable = (r: ResultSet, max = Infinity) =>
  [r.columns.join("\t"), ...r.rows.slice(0, max).map((row) => r.columns.map((_, i) => cell(row[i]).replace(/[\t\n]/g, " ")).join("\t"))].join("\n");

const csvCell = (v: unknown) => {
  const s = v === null ? "" : cell(v);
  return /[",\n\r]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
};
export const asCsv = (r: ResultSet) => [r.columns.map(csvCell).join(","), ...r.rows.map((row) => r.columns.map((_, i) => csvCell(row[i])).join(","))].join("\n") + "\n";
export const asJson = (r: ResultSet) =>
  JSON.stringify(
    r.rows.map((row) => Object.fromEntries(r.columns.map((c, i) => [c, typeof row[i] === "bigint" ? Number(row[i]) : row[i]]))),
    null,
    2,
  );

const SHOW_ROWS = 50;

const USAGE = () => [
  `usage: emplio db sql "<one statement>"              run it: its rows come back (? params: emplio db sql "<sql>" -- 'v1' 'v2')
       emplio db sql - <<'SQL' ... SQL               the same, statement from stdin
       emplio db script - <<'SQL' ... SQL            several statements as ONE transaction (all or nothing), no results
       emplio db search <words>                      rows in any table with every word somewhere in their text columns
       emplio db tables                              tables and views, with row counts
       emplio db schema [table]                      how they're defined (CREATE statements, indexes, triggers)
       emplio db import <table> <file.json>          rows from a JSON array of objects into an existing table
       emplio db export <file.csv|file.json> "<select>"  a query's full result into a file on this computer
       emplio db history                             recent statements and who ran them`,
  ...(cloud.records.restore ? [`       emplio db restore "<when>"                    put the whole database back as it was then ("30 minutes ago", an ISO time); owner/admin`] : []),
  `       emplio db private                             tables only the owner and admins can use; owner/admin
       emplio db private add|remove <table>          make one private, or open it to staff; owner/admin
It's SQLite: STRICT tables, foreign keys (on), indexes, views, triggers, json_* functions, datetime('now').
New tables: STRICT, an id primary key, created_at/updated_at, foreign keys between related tables, indexes on what you
filter by. Change several things at once with emplio db script (one transaction).
Staff can use every table unless it's private. Decide yourself, right after creating a table, without asking: anything staff
shouldn't see (pay, HR, bank details, keys and passwords, the owner's own matters) gets emplio db private add <table>.`,
].join("\n");

// `emplio db ...` from a chat. `box` reads and writes files on the chat's computer; `park` keeps a big result there.
export async function dbCommand(
  who: Who,
  conversationId: string,
  args: string[],
  box: { read(path: string): Promise<string>; write(path: string, text: string): Promise<void>; park(name: string, text: string): Promise<string> },
  // asked by code (the Python library): rows as JSON, every one of them
  data = false,
) {
  const [sub, first = "", ...rest] = args;
  try {
    switch (sub) {
      case "sql": {
        if (!first.trim()) break;
        const params = rest[0] === "--" ? rest.slice(1) : [];
        const r = await runSql(who, first, params, conversationId);
        if (data) return r.columns.length ? asJson(r) : JSON.stringify({ changed: r.rowsAffected, last_id: r.lastInsertRowid === undefined ? null : Number(r.lastInsertRowid) });
        if (!r.columns.length)
          return `ok: ${r.rowsAffected} row${r.rowsAffected === 1 ? "" : "s"} changed${r.lastInsertRowid !== undefined && r.rowsAffected ? `, last id ${r.lastInsertRowid}` : ""}`;
        if (!r.rows.length) return `${r.columns.join("\t")}\n(no rows)`;
        if (r.rows.length <= SHOW_ROWS) return `${asTable(r)}\n(${r.rows.length} row${r.rows.length === 1 ? "" : "s"})`;
        const path = await box.park("db-result", asCsv(r));
        return `${asTable(r, SHOW_ROWS)}\n(first ${SHOW_ROWS} of ${r.rows.length} rows; all of them are in ${path})`;
      }
      case "script":
        if (!first.trim()) break;
        await runScript(who, first, conversationId);
        return "ok: the script ran as one transaction";
      case "search": {
        const words = [first, ...rest].filter((w) => w.trim());
        if (!words.length) break;
        return (await searchRows(who, words)) || "No rows match.";
      }
      case "tables": {
        const list = await listTables(who);
        if (data) return JSON.stringify(list.map((t) => ({ name: t.name, type: t.type, rows: t.rows ?? null, ...(who.role !== "member" && { private: !!t.private }) })));
        return list.length ? list.map((t) => `${t.name}\t${t.type}\t${t.rows ?? "?"} rows${who.role !== "member" && t.private ? "\tprivate" : ""}`).join("\n") : "No tables yet. Create one with emplio db sql \"create table ...\".";
      }
      case "schema":
        return (await schemaOf(who, first || undefined)) || (first ? `No table ${first}.` : "No tables yet.");
      case "import": {
        const file = rest[0];
        if (!first || !file) break;
        let rows: unknown;
        try {
          rows = JSON.parse(await box.read(file));
        } catch (error) {
          return `error: couldn't read ${file} as JSON (${(error as Error).message}); it must be a JSON array of objects`;
        }
        if (!Array.isArray(rows) || rows.some((r) => !r || typeof r !== "object" || Array.isArray(r)))
          return "error: the file must be a JSON array of objects, one per row";
        return `ok: imported ${await importRows(who, first, rows, conversationId)} rows into ${first}`;
      }
      case "export": {
        const query = rest.join(" ");
        if (!first || !query.trim()) break;
        if (!first.startsWith("/work/") || first.includes("..")) return "error: export to a path under /work/ (e.g. /work/out/leads.csv)";
        if (classify(query) !== "read") return "error: export takes a SELECT";
        const r = await runSql(who, query, [], conversationId);
        await box.write(first, first.endsWith(".json") ? asJson(r) : asCsv(r));
        return `ok: ${r.rows.length} rows written to ${first}`;
      }
      case "history": {
        const rows = await dbHistory(who);
        return rows.length
          ? rows
              .map((q) => `${q.at.toISOString().slice(0, 16).replace("T", " ")}\t${q.by ?? "?"}\t${q.kind}\t${q.ok ? `ok${q.rows === null ? "" : `, ${q.rows} rows`}` : `failed: ${q.error}`}\t${q.sql.replace(/\s+/g, " ").slice(0, 160)}`)
              .join("\n")
          : "Nothing run yet.";
      }
      case "private": {
        if (!canChangeSchema(who)) return "error: only the owner or an admin can see or change which tables are private";
        if (!first || first === "list") return (await listTables(who)).filter((t) => t.private).map((t) => t.name).join("\n") || "No private tables.";
        if ((first !== "add" && first !== "remove") || !rest[0]) break;
        await setPrivate(who, rest[0], first === "add");
        return first === "add" ? `ok: ${rest[0]} is private; only the owner and admins can use it` : `ok: staff can use ${rest[0]}`;
      }
      case "restore":
        if (!first || !cloud.records.restore) break;
        return await cloud.records.restore(who, [first, ...rest].join(" "), conversationId);
    }
    return USAGE();
  } catch (error) {
    if (error instanceof DbError) return `error: ${error.message}`;
    throw error;
  }
}
