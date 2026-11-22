// Records: things a business tracks that aren't clients (an invoice, a candidate, a project), so a process can be
// run for one (process_runs.recordId) and the app can list them. A record has a kind (lowercase, singular), a title,
// maybe a client, a status in its own words, and fields: whatever that kind needs (amount, due date, role).
// Emplio picks the fields; there's no schema per kind.
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { BizRecord, Role } from "@emplio/shared";
import { context } from "./auth";
import { db } from "./db";
import { clients, processRuns, records } from "./db/schema";
import { findClient } from "./clients";

type Who = { workspaceId: string; userId: string; role: Role };
type Row = typeof records.$inferSelect;
export type RecordInput = { kind?: string; title?: string; clientId?: string | null; status?: string; fields?: Record<string, string> };

export const KIND = /^[a-z][a-z-]{0,30}$/;
// kinds that mean something else in a process file's for:
const TAKEN = ["client", "other"];
const isAdmin = (w: Pick<Who, "role">) => w.role !== "member";

export class RecordError extends Error {}

export async function toRecords(rows: Row[]): Promise<BizRecord[]> {
  if (!rows.length) return [];
  const ws = rows[0]!.workspaceId;
  const ids = [...new Set(rows.map((r) => r.clientId).filter((x): x is string => !!x))];
  const names = new Map(ids.length ? (await db.select({ id: clients.id, name: clients.name }).from(clients).where(inArray(clients.id, ids))).map((c) => [c.id, c.name]) : []);
  const going = new Map(
    (
      await db
        .select({ id: processRuns.recordId, n: sql<number>`count(*)`.mapWith(Number) })
        .from(processRuns)
        .where(and(eq(processRuns.workspaceId, ws), eq(processRuns.status, "active"), inArray(processRuns.recordId, rows.map((r) => r.id))))
        .groupBy(processRuns.recordId)
    ).map((r) => [r.id, r.n]),
  );
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    title: r.title,
    clientId: r.clientId,
    clientName: r.clientId ? (names.get(r.clientId) ?? null) : null,
    fields: r.fields,
    status: r.status,
    active: going.get(r.id) ?? 0,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  }));
}

export async function listRecords(workspaceId: string, f: { kind?: string; clientId?: string } = {}) {
  const rows = await db
    .select()
    .from(records)
    .where(and(eq(records.workspaceId, workspaceId), f.kind ? eq(records.kind, f.kind) : undefined, f.clientId ? eq(records.clientId, f.clientId) : undefined))
    .orderBy(desc(records.updatedAt))
    .limit(500);
  return toRecords(rows);
}

// The kinds in use, with how many of each.
export async function listKinds(workspaceId: string) {
  return db
    .select({ kind: records.kind, n: sql<number>`count(*)`.mapWith(Number) })
    .from(records)
    .where(eq(records.workspaceId, workspaceId))
    .groupBy(records.kind)
    .orderBy(records.kind);
}

// By id (or its start), else by title (within a kind when given).
export async function findRecord(workspaceId: string, q: string, kind?: string): Promise<Row> {
  const s = q.trim();
  if (!s) throw new RecordError("which record?");
  const scope = and(eq(records.workspaceId, workspaceId), kind ? eq(records.kind, kind) : undefined);
  if (/^[0-9a-f-]{6,36}$/i.test(s)) {
    const byId = await db.select().from(records).where(and(scope, sql`${records.id}::text like ${`${s.toLowerCase()}%`}`)).limit(2);
    if (byId.length === 1) return byId[0]!;
  }
  const all = await db.select().from(records).where(scope);
  const low = s.toLowerCase();
  const exact = all.filter((r) => r.title.toLowerCase() === low);
  if (exact.length === 1) return exact[0]!;
  const loose = exact.length ? exact : all.filter((r) => r.title.toLowerCase().includes(low));
  if (loose.length === 1) return loose[0]!;
  throw new RecordError(
    loose.length
      ? `"${q}" matches ${loose.slice(0, 8).map((r) => `${r.title} (${r.id.slice(0, 8)})`).join(", ")}; say which by id`
      : `no ${kind ?? "record"} "${q}" (emplio records list${kind ? ` --kind ${kind}` : ""})`,
  );
}

function clean(input: RecordInput, creating: boolean) {
  const out: Partial<typeof records.$inferInsert> = {};
  if (input.kind !== undefined || creating) {
    const k = (input.kind ?? "").trim().toLowerCase();
    if (!KIND.test(k) || TAKEN.includes(k)) throw new RecordError("a kind is one lowercase word for the thing, singular: invoice, candidate, project");
    out.kind = k;
  }
  if (input.title !== undefined || creating) {
    const t = (input.title ?? "").trim();
    if (!t) throw new RecordError("a record needs a title, like INV-1042 or Sarah Lee");
    out.title = t.slice(0, 200);
  }
  if (input.status !== undefined) {
    const st = input.status.trim().toLowerCase();
    if (!st || st.length > 30) throw new RecordError("status is a word or two, like open, paid, hired");
    out.status = st;
  }
  if (input.clientId !== undefined) out.clientId = input.clientId;
  return out;
}

const mergeFields = (old: Record<string, string>, next?: Record<string, string>) => {
  const f = { ...old };
  for (const [k, v] of Object.entries(next ?? {})) {
    const key = k.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
    if (!key) continue;
    if (v === "" || v === null) delete f[key];
    else f[key] = String(v).slice(0, 2000);
  }
  if (Object.keys(f).length > 40) throw new RecordError("at most 40 fields");
  return f;
};

export async function addRecord(w: Who, input: RecordInput): Promise<Row> {
  const values = clean(input, true);
  const [row] = await db
    .insert(records)
    .values({ workspaceId: w.workspaceId, kind: values.kind!, title: values.title!, clientId: values.clientId ?? null, status: values.status ?? "open", fields: mergeFields({}, input.fields), createdBy: w.userId })
    .returning();
  return row!;
}

export async function updateRecord(w: Who, id: string, input: RecordInput): Promise<Row> {
  const old = await findRecord(w.workspaceId, id);
  const values = clean(input, false);
  const [row] = await db
    .update(records)
    .set({ ...values, ...(input.fields && { fields: mergeFields(old.fields, input.fields) }), updatedAt: new Date() })
    .where(eq(records.id, old.id))
    .returning();
  return row!;
}

export async function removeRecord(w: Who, id: string) {
  if (!isAdmin(w)) throw new RecordError("only the owner or an admin can remove records");
  const old = await findRecord(w.workspaceId, id);
  await db.delete(records).where(eq(records.id, old.id));
  return old;
}

// --- `emplio records` ---

const USAGE = `usage: emplio records list [--kind <kind>] [--client <name>]    things tracked that aren't clients: invoices, candidates, projects
       emplio records kinds                                     the kinds in use, and how many of each
       emplio records show <id or title>                        one, with its fields
       emplio records add <kind> "<title>" [--client <name>] [--status <word>] [--<field> <value>]...
                                                                e.g. emplio records add invoice "INV-1042" --client Northwind --amount 85000 --due 2026-12-01
       emplio records update <id or title> [--title "<t>"] [--status <word>] [--client <name>|none] [--<field> <value>]...
                                                                a field set to "" is removed
       emplio records remove <id or title>                      (owner or admin)
A kind is one lowercase word, singular (invoice, candidate, project); fields are yours to pick, keep them the same within a kind.
A process with for: <kind> is started for one: emplio processes start <name> --for "<title>" (made here if it isn't yet).`;

const show = (r: BizRecord) =>
  [`${r.id.slice(0, 8)}\t${r.kind}\t${r.title}\t${r.status}${r.clientName ? `\tclient: ${r.clientName}` : ""}${r.active ? `\t${r.active} process${r.active === 1 ? "" : "es"} going` : ""}`, ...Object.entries(r.fields).map(([k, v]) => `  ${k}: ${v}`)].join("\n");

export async function recordsCommand(who: Who, args: string[], data = false) {
  const [sub, ...rest] = args;
  const words: string[] = [];
  const opts: Record<string, string> = {};
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (a.startsWith("--") && a.length > 2) opts[a.slice(2)] = rest[++i] ?? "";
    else words.push(a);
  }
  const { kind, client, status, title, ...fields } = opts;
  const clientId = async () => {
    if (client === undefined) return undefined;
    if (client.trim().toLowerCase() === "none" || !client.trim()) return null;
    const c = await findClient(who.workspaceId, client);
    if (typeof c === "string") throw new RecordError(c);
    return c.id;
  };
  try {
    switch (sub) {
      case undefined:
      case "list": {
        const list = await listRecords(who.workspaceId, { kind: kind?.toLowerCase(), clientId: (await clientId()) ?? undefined });
        if (data) return JSON.stringify(list);
        if (!list.length) return kind ? `No ${kind} records.` : "No records yet. Add one with emplio records add (emplio records help).";
        return list.map(show).join("\n");
      }
      case "kinds": {
        const k = await listKinds(who.workspaceId);
        return k.length ? k.map((x) => `${x.kind}\t${x.n}`).join("\n") : "No records yet.";
      }
      case "show": {
        if (!words[0]) break;
        const [r] = await toRecords([await findRecord(who.workspaceId, words.join(" "))]);
        return data ? JSON.stringify(r) : show(r!);
      }
      case "add": {
        const [k, t] = words;
        if (!k || !t) break;
        const row = await addRecord(who, { kind: k, title: t, clientId: await clientId(), status, fields });
        return `Added ${row.kind} ${row.id.slice(0, 8)}: ${row.title}.`;
      }
      case "update": {
        if (!words[0]) break;
        const row = await updateRecord(who, words.join(" "), { title, status, clientId: await clientId(), fields: Object.keys(fields).length ? fields : undefined });
        return `Updated ${row.kind} ${row.title}.`;
      }
      case "remove": {
        if (!words[0]) break;
        const row = await removeRecord(who, words.join(" "));
        return `Removed ${row.kind} ${row.title}; its process runs stay, no longer linked.`;
      }
      case "help":
        return USAGE;
    }
  } catch (error) {
    if (error instanceof RecordError) return `error: ${error.message}`;
    throw error;
  }
  return USAGE;
}

// --- the app ---

export async function recordRoutes(app: FastifyInstance) {
  const fail = (reply: { code: (n: number) => { send: (b: unknown) => unknown } }, error: unknown) => {
    if (error instanceof RecordError) return reply.code(400).send({ error: error.message });
    throw error;
  };
  app.get<{ Querystring: { kind?: string; client?: string } }>("/records", async (req, reply) => {
    const ctx = await context(req, reply);
    if (!ctx) return;
    return listRecords(ctx.workspaceId, { kind: req.query.kind, clientId: req.query.client });
  });
  app.get("/record-kinds", async (req, reply) => {
    const ctx = await context(req, reply);
    if (!ctx) return;
    return listKinds(ctx.workspaceId);
  });
  app.post<{ Body: RecordInput }>("/records", async (req, reply) => {
    const ctx = await context(req, reply);
    if (!ctx) return;
    try {
      return (await toRecords([await addRecord(ctx, req.body ?? {})]))[0];
    } catch (error) {
      return fail(reply, error);
    }
  });
  app.patch<{ Params: { id: string }; Body: RecordInput }>("/records/:id", async (req, reply) => {
    const ctx = await context(req, reply);
    if (!ctx) return;
    try {
      return (await toRecords([await updateRecord(ctx, req.params.id, req.body ?? {})]))[0];
    } catch (error) {
      return fail(reply, error);
    }
  });
  app.delete<{ Params: { id: string } }>("/records/:id", async (req, reply) => {
    const ctx = await context(req, reply);
    if (!ctx) return;
    try {
      await removeRecord(ctx, req.params.id);
      return { ok: true };
    } catch (error) {
      return fail(reply, error);
    }
  });
}
