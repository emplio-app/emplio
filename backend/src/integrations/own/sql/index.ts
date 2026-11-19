// A business's own PostgreSQL or MySQL database, reached directly with its connection string (own/postgresql,
// own/mysql). The host is the person's to choose, so every connection is first looked up and refused if it points
// inside a network (this machine, the cloud's metadata address, our own database), then made to that looked-up
// address, so a name can't change its answer between the check and the connect (DNS rebinding). One connection per
// call, closed after it, with a 30-second limit on each statement. Reads run inside a READ ONLY transaction, one
// statement at a time, and answer at most 1000 rows.
import { SQL } from "bun";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { z } from "zod";
import { isPrivate } from "../../../link-title";
import { AppsError } from "../../types";
import type { OwnAction, OwnApp } from "../index";
import { clientIp } from "../namecheap/client";

export type Kind = "postgresql" | "mysql";
const NAME: Record<Kind, string> = { postgresql: "PostgreSQL", mysql: "MySQL" };
const EXAMPLE: Record<Kind, string> = {
  postgresql: "postgres://emplio_reader:password@db.example.com:5432/shop",
  mysql: "mysql://emplio_reader:password@db.example.com:3306/shop",
};
export const ROW_CAP = 1000;
const TIMEOUT_S = 30;
const CUT = `Only the first ${ROW_CAP} rows are shown. Add filters or a LIMIT to see the rest.`;

export type Target = { kind: Kind; host: string; port: number; user: string; password: string; database: string; tls: "disable" | "require" | "verify" };

// The connection string pasted as the key. TLS unless the string itself says sslmode=disable (ssl-mode=DISABLED, ssl=false).
export function parseKey(kind: Kind, key: string): Target {
  const bad = () => new AppsError(`${NAME[kind]}: paste the database's connection string, like ${EXAMPLE[kind]}`);
  let u: URL;
  try {
    u = new URL(key.trim());
  } catch {
    throw bad();
  }
  const schemes = kind === "postgresql" ? ["postgres:", "postgresql:"] : ["mysql:", "mariadb:"];
  if (!schemes.includes(u.protocol) || !u.hostname) throw bad();
  const p = u.searchParams;
  const ssl = p.get("ssl");
  const mode = (p.get("sslmode") ?? p.get("ssl-mode") ?? p.get("ssl_mode") ?? (ssl === "false" || ssl === "0" ? "disable" : "")).toLowerCase().replace("_", "-");
  let decoded: string[];
  try {
    decoded = [u.username, u.password, u.pathname.slice(1)].map(decodeURIComponent);
  } catch {
    throw new AppsError(`${NAME[kind]}: the connection string has a broken %-code; write special characters in the password as %40 for @, %23 for #, %2F for /`);
  }
  const [user = "", password = "", database = ""] = decoded;
  if (!user) throw new AppsError(`${NAME[kind]}: the connection string needs a user name, like ${EXAMPLE[kind]}`);
  return {
    kind,
    host: u.hostname.replace(/^\[|\]$/g, ""),
    port: Number(u.port) || (kind === "postgresql" ? 5432 : 3306),
    user,
    password,
    database: database || (kind === "postgresql" ? user : ""),
    tls: ["disable", "disabled"].includes(mode) ? "disable" : ["verify-ca", "verify-full", "verify-identity"].includes(mode) ? "verify" : "require",
  };
}

// --- the address guard ---

type Resolve = (host: string) => Promise<string[]>;
const dns: Resolve = async (host) => (await lookup(host, { all: true })).map((a) => a.address);
// ponytail: tests add their local database's host here; nothing else does
export const allowForTests = new Set<string>();
let ownDb: Promise<string[]> | undefined;
// Emplio's own database: never a business's, even when it has a public address
const ownDbAddresses = (resolve: Resolve) =>
  (ownDb ??= (async () => {
    const url = process.env.DATABASE_URL;
    const host = url ? new URL(url).hostname.replace(/^\[|\]$/g, "") : "";
    return host ? (isIP(host) ? [host] : await resolve(host)) : [];
  })().catch(() => []));

// The public address to connect to, or an AppsError. Every address the name has must be public.
export async function publicAddress(host: string, resolve: Resolve = dns): Promise<string> {
  const ips = isIP(host) ? [host] : await resolve(host).catch(() => [] as string[]);
  if (!ips.length) throw new AppsError(`can't find the database host ${host}: check the host name in the connection string`);
  if (allowForTests.has(host)) return ips[0]!;
  const own = await ownDbAddresses(resolve);
  if (ips.some((ip) => isPrivate(ip) || own.includes(ip)))
    throw new AppsError(`${host} is a private or internal address. Emplio only connects to databases that are reachable from the internet.`);
  return ips.find((ip) => isIP(ip) === 4) ?? ips[0]!;
}

// --- connecting ---

async function open(t: Target): Promise<SQL> {
  const ip = await publicAddress(t.host);
  const sql = new SQL({
    adapter: t.kind === "postgresql" ? "postgres" : "mysql",
    hostname: ip,
    port: t.port,
    username: t.user,
    password: t.password,
    database: t.database || undefined,
    // connected by address, so the certificate is checked against the name it was given
    tls: t.tls === "disable" ? false : { serverName: isIP(t.host) ? undefined : t.host, rejectUnauthorized: t.tls === "verify" },
    max: 1,
    connectionTimeout: 10,
    idleTimeout: 10,
    // works through poolers (PgBouncer, Supabase) that can't keep prepared statements
    ...(t.kind === "postgresql" && { prepare: false }),
  });
  if (t.kind === "mysql") {
    // MySQL's limit (SELECTs only), then MariaDB's; a server with neither still has the timer in withDb
    await sql.unsafe(`set session max_execution_time = ${TIMEOUT_S * 1000}`).catch(() => sql.unsafe(`set session max_statement_time = ${TIMEOUT_S}`).catch(() => {}));
  }
  return sql;
}

const hint =
  " Check the host and port, and that the database accepts connections from the internet: its firewall or hosting panel (\"Remote MySQL\", \"trusted sources\") must allow Emplio's server" +
  (clientIp() ? ` (${clientIp()})` : "") +
  ".";

function friendly(kind: Kind, e: unknown, password: string): AppsError {
  if (e instanceof AppsError) return e;
  const err = e as { message?: string; code?: string };
  let msg = String(err.message ?? e);
  if (password) msg = msg.split(password).join("***");
  const unreachable = /ECONNREFUSED|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|ECONNRESET|CONNECTION_TIMEOUT|CONNECTION_CLOSED|timed out/i.test(`${err.code} ${msg}`);
  return new AppsError(`${NAME[kind]}: ${msg}${unreachable ? `.${hint}` : ""}`);
}

// One connection for one call, always closed after it; a call still going after the limit is cut off.
export async function withDb<T>(kind: Kind, key: string, fn: (sql: SQL, t: Target) => Promise<T>): Promise<T> {
  const t = parseKey(kind, key);
  let sql: SQL | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    sql = await open(t);
    const late = new Promise<never>((_, no) => {
      timer = setTimeout(() => no(new AppsError(`${NAME[kind]}: stopped after ${TIMEOUT_S} seconds. Narrow the query (filters, a LIMIT, an index).`)), (TIMEOUT_S + 5) * 1000);
    });
    return await Promise.race([fn(sql, t), late]);
  } catch (e) {
    throw friendly(kind, e, t.password);
  } finally {
    clearTimeout(timer);
    await sql?.close({ timeout: 0 }).catch(() => {});
  }
}

// --- statements ---

const skipComments = (q: string) => q.replace(/^(\s+|--[^\n]*(\n|$)|#[^\n]*(\n|$)|\/\*[\s\S]*?\*\/)+/, "");
const firstWord = (q: string) => /^[\s(]*([a-z]+)/i.exec(skipComments(q))?.[1]?.toLowerCase() ?? "";
const READS: Record<Kind, string[]> = {
  postgresql: ["select", "with", "table", "values", "show", "explain"],
  mysql: ["select", "with", "table", "values", "show", "describe", "desc", "explain"],
};

// One statement, trailing semicolons dropped. ponytail: any other ";" is refused rather than parsed around quotes and
// comments (the drivers run several statements in one call, and a COMMIT in the middle would end the read-only
// transaction); a value with a semicolon goes in params instead.
export function oneStatement(q: string): string {
  const s = q.trim().replace(/[;\s]+$/, "");
  if (!s) throw new AppsError("the query is empty");
  if (s.includes(";")) throw new AppsError("one statement at a time: remove the ';' (a value containing ';' goes in params)");
  return s;
}

// A query safe to run without asking: one statement that only reads.
export function readOnlyQuery(kind: Kind, q: string): string {
  const s = oneStatement(q);
  if (!READS[kind].includes(firstWord(s)))
    throw new AppsError(`run_query only reads (${READS[kind].join(", ").toUpperCase()}). Use run_statement to change data, which asks first.`);
  if (kind === "mysql" && /\binto\s+(outfile|dumpfile)\b/i.test(s)) throw new AppsError("run_query can't write files on the database server");
  return s;
}

const cell = (v: unknown) => (typeof v === "bigint" ? String(v) : v instanceof Uint8Array ? `[binary, ${v.byteLength} bytes]` : v);
type Result = unknown[] & { count?: number; command?: string | null; affectedRows?: number; lastInsertRowid?: number | bigint | null };

// rows for the person: at most ROW_CAP, and says when there were more
export function shape(r: Result, extra: Record<string, unknown> = {}) {
  const rows = r.slice(0, ROW_CAP).map((row) => (row && typeof row === "object" ? Object.fromEntries(Object.entries(row).map(([k, v]) => [k, cell(v)])) : row));
  return { ...extra, rows, row_count: rows.length, ...(r.length > ROW_CAP && { note: CUT }) };
}

const isSelect = (s: string) => ["select", "with", "table", "values"].includes(firstWord(s));

// Runs inside a READ ONLY transaction; at most ROW_CAP + 1 rows come back (a cursor on Postgres, sql_select_limit on MySQL).
async function read(kind: Kind, sql: SQL, s: string, params: unknown[] = []): Promise<Result> {
  if (kind === "postgresql")
    return sql.begin("read only", async (tx) => {
      await tx.unsafe(`set local statement_timeout = ${TIMEOUT_S * 1000}`);
      if (!isSelect(s)) return tx.unsafe(s, params);
      await tx.unsafe(`declare emplio_rows no scroll cursor for ${s}`, params);
      return tx.unsafe(`fetch ${ROW_CAP + 1} from emplio_rows`);
    }) as Promise<Result>;
  // ponytail: an explicit LIMIT above the cap still reads every row it names into memory before the cut
  await sql.unsafe(`set session sql_select_limit = ${ROW_CAP + 1}`);
  return sql.begin("read only", (tx) => tx.unsafe(s, params)) as Promise<Result>;
}

// Changes: in a transaction on Postgres (all or nothing, with the time limit); MySQL commits as it goes.
async function write(kind: Kind, sql: SQL, s: string, params: unknown[] = []): Promise<Result | Result[]> {
  if (kind === "mysql") return sql.unsafe(s, params);
  return sql.begin(async (tx) => {
    await tx.unsafe(`set local statement_timeout = ${TIMEOUT_S * 1000}`);
    return tx.unsafe(s, params);
  }) as Promise<Result | Result[]>;
}

const changed = (r: Result) =>
  shape(r, { command: r.command ?? undefined, affected_rows: r.affectedRows ?? r.count, ...(r.lastInsertRowid ? { inserted_id: cell(r.lastInsertRowid) } : {}) });

// --- tables and filters ---

const quote = (kind: Kind, id: string) => (kind === "postgresql" ? `"${id.replaceAll('"', '""')}"` : `\`${id.replaceAll("`", "``")}\``);
const tableName = (kind: Kind, schema: string | undefined, table: string) => (schema ? `${quote(kind, schema)}.` : "") + quote(kind, table);
// values bound as parameters: objects and arrays go as JSON text (json/jsonb columns take it)
const bind = (v: unknown) => (v !== null && typeof v === "object" && !(v instanceof Date) ? JSON.stringify(v) : v);

const OPS = ["=", "!=", "<", "<=", ">", ">=", "like", "not like", "ilike", "in", "not in", "is null", "is not null"] as const;
const filter = z.object({
  column: z.string().min(1).describe("Column name"),
  op: z.enum(OPS).default("=").describe('How to compare: = != < <= > >=, "like"/"not like" with % as a wildcard ("%gmail.com"), "ilike" ignores case, "in"/"not in" with a list, "is null"/"is not null" with no value'),
  value: z.unknown().optional().describe('The value to compare with; a list for "in"/"not in"'),
});
type Filter = z.infer<typeof filter>;
const filters = z.array(filter).describe("Conditions every row must meet (AND)");

// "where …" with values as parameters; `params` collects them in order
function where(kind: Kind, fs: Filter[] | undefined, params: unknown[]): string {
  if (!fs?.length) return "";
  const add = (v: unknown) => (params.push(bind(v)), kind === "postgresql" ? `$${params.length}` : "?");
  return (
    " where " +
    fs
      .map((f) => {
        const col = quote(kind, f.column);
        if (f.op === "is null" || f.op === "is not null") return `${col} ${f.op}`;
        if (f.op === "in" || f.op === "not in") {
          const list = Array.isArray(f.value) ? f.value : [f.value];
          if (!list.length) return f.op === "in" ? "1 = 0" : "1 = 1";
          return `${col} ${f.op} (${list.map(add).join(", ")})`;
        }
        if (f.op === "ilike") return kind === "postgresql" ? `${col} ilike ${add(f.value)}` : `lower(${col}) like lower(${add(f.value)})`;
        return `${col} ${f.op} ${add(f.value)}`;
      })
      .join(" and ")
  );
}

// --- what the database has ---

type Dialect = {
  schemas: string;
  tables: string;
  views: string;
  columns: string;
  constraints: string;
  indexes: string;
  functions: string;
  info: string;
};
// Postgres takes $1 (schema, null for all/the default) and $2 (table); MySQL's "?" are bound in the order written.
const PG_HIDDEN = "not in ('pg_catalog', 'information_schema') and n.nspname not like 'pg\\_toast%' and n.nspname not like 'pg\\_temp%'";
const DIALECTS: Record<Kind, Dialect> = {
  postgresql: {
    schemas: `select n.nspname as schema, pg_get_userbyid(n.nspowner) as owner from pg_namespace n where n.nspname ${PG_HIDDEN} order by 1`,
    tables: `select n.nspname as schema, c.relname as table, case c.relkind when 'p' then 'partitioned table' when 'f' then 'foreign table' else 'table' end as type,
      case when c.reltuples < 0 then null else c.reltuples::bigint end as estimated_rows, pg_total_relation_size(c.oid) as size_bytes, obj_description(c.oid, 'pg_class') as comment
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where c.relkind in ('r', 'p', 'f') and not c.relispartition and n.nspname ${PG_HIDDEN} and ($1::text is null or n.nspname = $1) order by 1, 2`,
    views: `select schemaname as schema, viewname as view, 'view' as type, definition from pg_views where schemaname not in ('pg_catalog', 'information_schema') and ($1::text is null or schemaname = $1)
      union all select schemaname, matviewname, 'materialized view', definition from pg_matviews where ($1::text is null or schemaname = $1) order by 1, 2`,
    columns: `select a.attname as column, format_type(a.atttypid, a.atttypmod) as type, not a.attnotnull as nullable, pg_get_expr(d.adbin, d.adrelid) as default, col_description(a.attrelid, a.attnum) as comment
      from pg_attribute a left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
      where a.attrelid = to_regclass(format('%I.%I', coalesce($1::text, current_schema()), $2::text)) and a.attnum > 0 and not a.attisdropped order by a.attnum`,
    constraints: `select conname as name, case contype when 'p' then 'primary key' when 'f' then 'foreign key' when 'u' then 'unique' when 'c' then 'check' when 'x' then 'exclusion' else contype::text end as type,
      pg_get_constraintdef(oid) as definition from pg_constraint where conrelid = to_regclass(format('%I.%I', coalesce($1::text, current_schema()), $2::text)) order by contype, conname`,
    indexes: `select indexname as name, indexdef as definition from pg_indexes where schemaname = coalesce($1::text, current_schema()) and tablename = $2 order by 1`,
    functions: `select n.nspname as schema, p.proname as name, case p.prokind when 'p' then 'procedure' when 'a' then 'aggregate' when 'w' then 'window function' else 'function' end as type,
      pg_get_function_arguments(p.oid) as arguments, pg_get_function_result(p.oid) as returns, l.lanname as language, obj_description(p.oid, 'pg_proc') as comment
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace join pg_language l on l.oid = p.prolang
      where n.nspname ${PG_HIDDEN} and ($1::text is null or n.nspname = $1)
      and not exists (select 1 from pg_depend dep where dep.objid = p.oid and dep.deptype = 'e') order by 1, 2`,
    info: `select version() as version, current_database() as database, current_user as user, current_schema() as default_schema,
      pg_database_size(current_database()) as size_bytes, current_setting('TimeZone') as time_zone,
      (select coalesce(json_agg(extname order by extname), '[]') from pg_extension) as extensions,
      (select count(*) from pg_stat_activity where datname = current_database()) as open_connections`,
  },
  mysql: {
    schemas: "select schema_name as `schema`, default_character_set_name as charset from information_schema.schemata where schema_name not in ('mysql', 'information_schema', 'performance_schema', 'sys') order by 1",
    tables: `select table_schema as \`schema\`, table_name as \`table\`, lower(table_type) as type, table_rows as estimated_rows, data_length + index_length as size_bytes, engine, table_comment as comment
      from information_schema.tables where table_type = 'BASE TABLE' and table_schema = coalesce(?, database()) order by 1, 2`,
    views: "select table_schema as `schema`, table_name as `view`, 'view' as type, view_definition as definition from information_schema.views where table_schema = coalesce(?, database()) order by 1, 2",
    columns: `select column_name as \`column\`, column_type as type, is_nullable = 'YES' as nullable, column_default as \`default\`, column_key as \`key\`, extra, column_comment as comment
      from information_schema.columns where table_schema = coalesce(?, database()) and table_name = ? order by ordinal_position`,
    constraints: `select tc.constraint_name as name, lower(tc.constraint_type) as type, group_concat(k.column_name order by k.ordinal_position) as columns,
      max(k.referenced_table_name) as references_table, group_concat(k.referenced_column_name order by k.ordinal_position) as references_columns
      from information_schema.table_constraints tc left join information_schema.key_column_usage k
      on k.constraint_schema = tc.constraint_schema and k.constraint_name = tc.constraint_name and k.table_name = tc.table_name
      where tc.table_schema = coalesce(?, database()) and tc.table_name = ? group by tc.constraint_name, tc.constraint_type order by 2, 1`,
    indexes: `select index_name as name, max(non_unique) = 0 as \`unique\`, group_concat(column_name order by seq_in_index) as columns, max(index_type) as type
      from information_schema.statistics where table_schema = coalesce(?, database()) and table_name = ? group by index_name order by 1`,
    functions: `select r.routine_schema as \`schema\`, r.routine_name as name, lower(r.routine_type) as type,
      (select group_concat(concat_ws(' ', p.parameter_mode, p.parameter_name, p.dtd_identifier) order by p.ordinal_position separator ', ')
        from information_schema.parameters p where p.specific_schema = r.routine_schema and p.specific_name = r.specific_name and p.ordinal_position > 0) as arguments,
      r.dtd_identifier as returns, r.routine_comment as comment
      from information_schema.routines r where r.routine_schema = coalesce(?, database()) order by 1, 2`,
    info: `select version() as version, @@version_comment as server, database() as \`database\`, current_user() as user,
      (select sum(data_length + index_length) from information_schema.tables where table_schema = database()) as size_bytes,
      @@time_zone as time_zone, @@system_time_zone as system_time_zone, @@character_set_database as charset`,
  },
};

// the schema/table binds in the order each dialect's SQL takes them
const binds = (schema: string | undefined, table?: string) => (table === undefined ? [schema ?? null] : [schema ?? null, table]);

// --- actions ---

export function sqlActions(kind: Kind): Record<string, OwnAction> {
  const N = NAME[kind];
  const d = DIALECTS[kind];
  const ph = kind === "postgresql" ? "$1, $2…" : "?";
  const schemaWord = kind === "postgresql" ? 'The schema (default: the connection\'s default, usually "public")' : "The database (default: the one in the connection string)";
  const schema = z.string().optional().describe(schemaWord);
  const table = z.string().min(1).describe("The table's name, from list_tables");
  const params = z.array(z.unknown()).optional().describe(`Values for the ${ph} placeholders, in order`);
  const db = <T>(key: string, fn: (sql: SQL) => Promise<T>) => withDb(kind, key, fn);
  const lookupRows = (s: string, b: unknown[]) => (key: string) => db(key, async (sql) => shape(await read(kind, sql, s, b)));

  return {
    run_query: {
      description: `Run one read-only SQL query on the ${N} database and get the rows back (SELECT, WITH, SHOW, EXPLAIN…). It runs in a read-only transaction, so it can't change anything; at most ${ROW_CAP} rows come back. Put values in params with ${ph} placeholders instead of pasting them into the query.`,
      input: z.object({ query: z.string().min(1).describe(`One SQL statement, e.g. "select id, total from orders where status = ${kind === "postgresql" ? "$1" : "?"} order by id desc limit 50"`), params }),
      readOnly: true,
      run: (i: { query: string; params?: unknown[] }, key) => db(key, async (sql) => shape(await read(kind, sql, readOnlyQuery(kind, i.query), (i.params ?? []).map(bind)))),
    },
    run_statement: {
      description: `Run SQL that changes the ${N} database: INSERT, UPDATE, DELETE, CREATE/ALTER/DROP, CALL a procedure, GRANT… Asks first. Several statements may be given, separated by ";" (only without params). Prefer insert_rows/update_rows/delete_rows for simple row changes.`,
      input: z.object({ query: z.string().min(1).describe("The SQL to run"), params }),
      run: (i: { query: string; params?: unknown[] }, key) =>
        db(key, async (sql) => {
          const r = await write(kind, sql, i.query.trim(), (i.params ?? []).map(bind));
          // several statements answer one result each
          return Array.isArray(r[0]) && (r as Result).command === undefined && (r as Result).count === undefined ? { results: (r as Result[]).map(changed) } : changed(r as Result);
        }),
    },
    list_schemas: {
      description: kind === "postgresql" ? "List the schemas in the PostgreSQL database (groups of tables, like public)." : "List the databases on the MySQL server this login can see.",
      input: z.object({}),
      readOnly: true,
      run: (_i, key) => lookupRows(d.schemas, [])(key),
    },
    list_tables: {
      description: `List the tables in the ${N} database with their estimated row counts, size on disk and comments.`,
      input: z.object({ schema }),
      readOnly: true,
      run: (i: { schema?: string }, key) => lookupRows(d.tables, binds(i.schema))(key),
    },
    list_views: {
      description: `List the views${kind === "postgresql" ? " and materialized views" : ""} in the ${N} database, with the query each one runs.`,
      input: z.object({ schema }),
      readOnly: true,
      run: (i: { schema?: string }, key) =>
        lookupRows(d.views, binds(i.schema))(key),
    },
    describe_table: {
      description: `Describe a table (or view) in the ${N} database: its columns with types, nullability and defaults, its primary key, foreign keys and other constraints, and its indexes. Look here before writing a query.`,
      input: z.object({ table, schema }),
      readOnly: true,
      run: (i: { table: string; schema?: string }, key) =>
        db(key, async (sql) => {
          const b = binds(i.schema, i.table);
          const columns = shape(await read(kind, sql, d.columns, b)).rows;
          if (!columns.length) throw new AppsError(`${N}: no table called ${i.table}${i.schema ? ` in ${i.schema}` : ""}. list_tables shows the ones there are.`);
          return { table: i.table, columns, constraints: shape(await read(kind, sql, d.constraints, b)).rows, indexes: shape(await read(kind, sql, d.indexes, b)).rows };
        }),
    },
    table_row_count: {
      description: `Count the rows in a ${N} table exactly, optionally only those matching filters.`,
      input: z.object({ table, schema, filters: filters.optional() }),
      readOnly: true,
      run: (i: { table: string; schema?: string; filters?: Filter[] }, key) =>
        db(key, async (sql) => {
          const p: unknown[] = [];
          const s = `select count(*) as count from ${tableName(kind, i.schema, i.table)}${where(kind, i.filters, p)}`;
          const [row] = shape(await read(kind, sql, s, p)).rows as { count: unknown }[];
          return { table: i.table, count: Number(row?.count ?? 0) };
        }),
    },
    sample_rows: {
      description: `A few rows from a ${N} table, to see what its data looks like.`,
      input: z.object({ table, schema, limit: z.number().int().min(1).max(100).default(10).describe("How many rows (default 10, up to 100)") }),
      readOnly: true,
      run: (i: { table: string; schema?: string; limit: number }, key) => lookupRows(`select * from ${tableName(kind, i.schema, i.table)} limit ${i.limit}`, [])(key),
    },
    find_rows: {
      description: `Find rows in a ${N} table by simple conditions, without writing SQL: pick columns, filters, sort and a page. Use run_query for joins and totals.`,
      input: z.object({
        table,
        schema,
        filters: filters.optional(),
        columns: z.array(z.string()).optional().describe("Only these columns (default: all)"),
        order_by: z.string().optional().describe("Column to sort by"),
        descending: z.boolean().default(false).describe("Sort largest/newest first"),
        limit: z.number().int().min(1).max(ROW_CAP).default(100).describe(`How many rows (default 100, up to ${ROW_CAP})`),
        offset: z.number().int().min(0).default(0).describe("Rows to skip, for the next page"),
      }),
      readOnly: true,
      run: (i: { table: string; schema?: string; filters?: Filter[]; columns?: string[]; order_by?: string; descending: boolean; limit: number; offset: number }, key) => {
        const p: unknown[] = [];
        const cols = i.columns?.length ? i.columns.map((c) => quote(kind, c)).join(", ") : "*";
        const order = i.order_by ? ` order by ${quote(kind, i.order_by)}${i.descending ? " desc" : ""}` : "";
        return lookupRows(`select ${cols} from ${tableName(kind, i.schema, i.table)}${where(kind, i.filters, p)}${order} limit ${i.limit} offset ${i.offset}`, p)(key);
      },
    },
    insert_rows: {
      description: `Add one or more rows to a ${N} table. Asks first.${kind === "postgresql" ? " Answers the rows as saved (with their new ids and defaults)." : " Answers how many were added and the first new id."}`,
      input: z.object({
        table,
        schema,
        rows: z.array(z.record(z.string(), z.unknown())).min(1).max(ROW_CAP).describe('The rows, each as column → value, e.g. [{"name": "Asha", "phone": "+919800000000"}]. Columns left out get their default.'),
      }),
      run: (i: { table: string; schema?: string; rows: Record<string, unknown>[] }, key) =>
        db(key, async (sql) => {
          const cols = [...new Set(i.rows.flatMap((r) => Object.keys(r)))];
          if (!cols.length) throw new AppsError("each row needs at least one column");
          const p: unknown[] = [];
          const values = i.rows
            .map((r) => `(${cols.map((c) => (c in r ? (p.push(bind(r[c])), kind === "postgresql" ? `$${p.length}` : "?") : "default")).join(", ")})`)
            .join(", ");
          const s = `insert into ${tableName(kind, i.schema, i.table)} (${cols.map((c) => quote(kind, c)).join(", ")}) values ${values}${kind === "postgresql" ? " returning *" : ""}`;
          return changed((await write(kind, sql, s, p)) as Result);
        }),
    },
    update_rows: {
      description: `Change rows in a ${N} table: set columns to new values on the rows matching filters. Asks first. Filters are required; to change every row use run_statement.`,
      input: z.object({
        table,
        schema,
        set: z.record(z.string(), z.unknown()).describe('Column → new value, e.g. {"status": "shipped"}'),
        filters: filters.min(1),
      }),
      run: (i: { table: string; schema?: string; set: Record<string, unknown>; filters: Filter[] }, key) =>
        db(key, async (sql) => {
          const cols = Object.keys(i.set);
          if (!cols.length) throw new AppsError("set: give at least one column to change");
          const p: unknown[] = [];
          const sets = cols.map((c) => (p.push(bind(i.set[c])), `${quote(kind, c)} = ${kind === "postgresql" ? `$${p.length}` : "?"}`)).join(", ");
          const s = `update ${tableName(kind, i.schema, i.table)} set ${sets}${where(kind, i.filters, p)}${kind === "postgresql" ? " returning *" : ""}`;
          return changed((await write(kind, sql, s, p)) as Result);
        }),
    },
    delete_rows: {
      description: `Delete the rows matching filters from a ${N} table. Asks first. Filters are required; to empty a table use run_statement.`,
      input: z.object({ table, schema, filters: filters.min(1) }),
      run: (i: { table: string; schema?: string; filters: Filter[] }, key) =>
        db(key, async (sql) => {
          const p: unknown[] = [];
          const s = `delete from ${tableName(kind, i.schema, i.table)}${where(kind, i.filters, p)}${kind === "postgresql" ? " returning *" : ""}`;
          return changed((await write(kind, sql, s, p)) as Result);
        }),
    },
    explain_query: {
      description: `Show how ${N} would run a query (its plan: which indexes, how many rows it expects), without running it. Use it to find out why a query is slow.`,
      input: z.object({ query: z.string().min(1).describe("One SQL statement"), params }),
      readOnly: true,
      run: (i: { query: string; params?: unknown[] }, key) =>
        db(key, async (sql) => {
          const r = shape(await read(kind, sql, `explain ${oneStatement(i.query)}`, (i.params ?? []).map(bind)));
          return kind === "postgresql" ? { plan: r.rows.map((row) => Object.values(row as object)[0]).join("\n") } : r;
        }),
    },
    list_functions: {
      description: `List the functions and stored procedures in the ${N} database, with their arguments and what they return.`,
      input: z.object({ schema }),
      readOnly: true,
      run: (i: { schema?: string }, key) => lookupRows(d.functions, binds(i.schema))(key),
    },
    database_info: {
      description: `About the ${N} database: server version, database name, the user Emplio connects as, size on disk, time zone${kind === "postgresql" ? ", extensions and open connections" : " and character set"}.`,
      input: z.object({}),
      readOnly: true,
      run: (_i, key) =>
        db(key, async (sql) => {
          const [row] = shape(await read(kind, sql, d.info, [])).rows;
          return row;
        }),
    },
  };
}

export function sqlApp(kind: Kind): OwnApp {
  const N = NAME[kind];
  const readOnlyUser =
    kind === "postgresql"
      ? "create user emplio_reader with password '…'; grant connect on database shop to emplio_reader; grant usage on schema public to emplio_reader; grant select on all tables in schema public to emplio_reader;"
      : "create user 'emplio_reader'@'%' identified by '…'; grant select, show view on shop.* to 'emplio_reader'@'%';";
  return {
    app: kind,
    name: N,
    logo: `/logos/${kind}.svg`,
    keyField: {
      label: "Connection string",
      placeholder: EXAMPLE[kind],
      help:
        `Paste the database's connection string: ${EXAMPLE[kind].replace("emplio_reader:password", "user:password")}. Your hosting panel usually shows it; write special characters in the password as %-codes (@ is %40). ` +
        `Emplio connects with TLS; add ${kind === "postgresql" ? "?sslmode=disable" : "?ssl-mode=DISABLED"} only if your database has no TLS. ` +
        `Best: a user that can only read, so Emplio can look but not change anything (${readOnlyUser}). Give it write rights only if you want Emplio to add or change rows; it asks before every change. ` +
        `The database must be reachable from the internet: allow Emplio's server${clientIp() ? ` (${clientIp()})` : ""} in its firewall${kind === "mysql" ? ' or your host\'s "Remote MySQL" page' : ""}.`,
    },
    async check(key) {
      return withDb(kind, key, async (sql, t) => {
        await read(kind, sql, "select 1", []);
        return `${t.database || t.user}@${t.host}`;
      });
    },
    actions: sqlActions(kind),
  };
}
