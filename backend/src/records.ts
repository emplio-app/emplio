// Records: what a client-servicing firm runs on — clients (clients.ts), contacts (contacts.ts), services (services.ts),
// projects (projects.ts). Rows, never files. The server is the only writer; the app and Emplio's commands call the
// same functions. The rules every kind keeps, here once:
// - a slug is set once and never changes (URLs, [[clients/x]] links in notes, --client x); renaming changes the name
// - nothing is deleted by an everyday command: archive (archivedAt) and restore; purge is the owner's, refused while
//   anything points at it
// - every change is one history row (activity) written in the same transaction: each field from and to, who, and
//   whether it came from the app, Emplio, the move from files, or the server
// - a write carrying the updatedAt it read is refused when the row changed since (two people, or Emplio and a person)
// - Emplio acts with the role of whoever it's working for, never above it
// Notes about a record are the file company/<kind>/<slug>/index.md: words only, no facts at its top.
import { and, Column, desc, eq, getTableName, is, sql, type SQL } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import type { HistoryEntry, RecordChange, Role } from "@emplio/shared";
import { db } from "./db";
import { activity, clientHandlers, clients, contactClients, contacts, meetings, projects, services, users, workspaces } from "./db/schema";

export type Via = "app" | "emplio" | "import" | "system";
// who's changing something: the app's signed-in person, or Emplio working for someone (conversationId: where)
// the record a new one looks like (a close name, the same email): the app offers to open it or add anyway
export type Match = { slug: string; name: string; archived: boolean };
export const matchOf = (m: { slug: string; name: string; archivedAt: string | null }): Match => ({ slug: m.slug, name: m.name, archived: !!m.archivedAt });
export type Who = { workspaceId: string; userId: string; role: Role; via?: Via; conversationId?: string | null };
export type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
export type Kind = "client" | "contact" | "project" | "service";

export const isAdmin = (w: Pick<Who, "role">) => w.role !== "member";
// Who's looking at records: a business's id alone is the server itself (sees everything); a person sees private ones
// (private.ts) only as an owner or admin
export type Viewer = string | { workspaceId: string; role?: Role; userId?: string };
export const wsOf = (v: Viewer) => (typeof v === "string" ? v : v.workspaceId);
// no role given: treated as staff, so a caller that forgot it never shows a private record
export const seesPrivate = (v: Viewer) => typeof v === "string" || (!!v.role && v.role !== "member");
// A client this viewer may see (id and private: that client's columns in the query): everyone's, or a private one
// they handle. undefined: they see them all
// A column with its table's name. Drizzle writes a column bare in a one-table query, and bare inside a subquery it means
// that subquery's own column when it has one by that name ("id" of clients c, "client_id" of client_handlers h).
export const q = (c: SQL | AnyPgColumn) => (is(c, Column) ? sql.raw(`"${getTableName(c.table)}"."${c.name.replace(/[A-Z]/g, (m) => `_${m.toLowerCase()}`)}"`) : c);
export const visibleClient = (v: Viewer, id: SQL | AnyPgColumn, priv: SQL | AnyPgColumn) =>
  seesPrivate(v)
    ? undefined
    : typeof v !== "string" && v.userId
      ? sql`(not ${q(priv)} or ${handles(v.userId, id)})`
      : sql`not ${q(priv)}`;
// A contact at clients, every one of them private (`as`: that client taken as switched to on already)
export const allClientsPrivate = (as?: { id: string; on: boolean }) =>
  sql<boolean>`(exists (select 1 from ${contactClients} l where l.contact_id = ${q(contacts.id)})
    and not exists (select 1 from ${contactClients} l join ${clients} c on c.id = l.client_id where l.contact_id = ${q(contacts.id)}
      and not ${as ? sql`(case when c.id = ${as.id} then ${as.on} else c.private end)` : sql`c.private`}))`;
const userOf = (v: Viewer) => (typeof v === "string" ? undefined : v.userId);
export const handles = (userId: string, clientId: SQL | AnyPgColumn) => sql`exists (select 1 from ${clientHandlers} h where h.client_id = ${q(clientId)} and h.user_id = ${userId})`;
// private, on its own or with its client
export const projectPrivate = sql<boolean>`(${q(projects.private)} or exists (select 1 from ${clients} c where c.id = ${q(projects.clientId)} and c.private))`;
export const contactPrivate = sql<boolean>`(${q(contacts.private)} or ${allClientsPrivate()})`;
// A project this viewer may see (in a query on projects): everyone's, or a private one at a client they handle, or one
// they lead. undefined: they see them all
export const visibleProject = (v: Viewer) => {
  const u = userOf(v);
  return seesPrivate(v) ? undefined : u ? sql`(not ${projectPrivate} or ${handles(u, projects.clientId)} or ${q(projects.leadId)} = ${u})` : sql`not ${projectPrivate}`;
};
// A contact this viewer may see (in a query on contacts): everyone's, or a private one at a client they handle
export const visibleContact = (v: Viewer) => {
  const u = userOf(v);
  return seesPrivate(v)
    ? undefined
    : u
      ? sql`(not ${contactPrivate} or exists (select 1 from ${contactClients} l where l.contact_id = ${q(contacts.id)} and ${handles(u, sql`l.client_id`)}))`
      : sql`not ${contactPrivate}`;
};
// A meeting is private on its own switch, or while its client or project is
export const meetingPrivate = sql<boolean>`(${q(meetings.private)}
  or exists (select 1 from ${clients} c where c.id = ${q(meetings.clientId)} and c.private)
  or exists (select 1 from ${projects} p left join ${clients} c on c.id = p.client_id where p.id = ${q(meetings.projectId)} and (p.private or c.private)))`;
// Someone's own meeting: they were in it or added it, or it's about a client they handle or a project they lead
export const meetingOf = (u: string) => sql`(${u} = any(${q(meetings.teamIds)}) or ${q(meetings.createdById)} = ${u}
  or (${q(meetings.clientId)} is not null and ${handles(u, meetings.clientId)})
  or exists (select 1 from ${projects} p where p.id = ${q(meetings.projectId)} and (p.lead_id = ${u} or ${handles(u, sql`p.client_id`)})))`;
// A meeting this viewer may see (in a query on meetings): everyone's, or a private one of their own
export const visibleMeeting = (v: Viewer) => {
  const u = userOf(v);
  return seesPrivate(v) ? undefined : u ? sql`(not ${meetingPrivate} or ${meetingOf(u)})` : sql`not ${meetingPrivate}`;
};
// `--private yes|no` on a command (alone: yes)
export const privateOf = (opts: Record<string, string>, flags: Set<string>) =>
  flags.has("private") ? true : opts.private === undefined ? undefined : !/^(no|false|off|0)$/i.test(opts.private.trim());
export const viaOf = (w: Pick<Who, "via">): Via => w.via ?? "app";
// an error's way out: the command for Emplio, plain words for a person in the app
export const say = (w: Pick<Who, "via">, app: string, command: string) => (viaOf(w) === "emplio" ? command : app);

// "Acme Foods Pvt. Ltd." -> "acme-foods-pvt-ltd"
export const slugOf = (name: string) =>
  name.normalize("NFKD").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60);

// One line, trimmed; "" is nothing
export const clean = (s: string | null | undefined) => (s ?? "").replace(/\s+/g, " ").trim();
export const orNull = (s: string | null | undefined) => clean(s) || null;

// A slug no other row of the kind has: acme, acme-2, ...
export function freeSlug(name: string, taken: Iterable<string>, fallback: string) {
  const used = new Set(taken);
  const base = slugOf(name) || fallback;
  let slug = base;
  for (let n = 2; used.has(slug); n++) slug = `${base}-${n}`;
  return slug;
}

// A name as compared for duplicates: legal suffixes and punctuation gone, so "Acme Pvt. Ltd." is "acme"
const SUFFIX = /\b(pvt|private|ltd|limited|llp|llc|inc|incorporated|co|company|corp|corporation|plc|gmbh|the|and)\b/g;
export const plainName = (name: string) => clean(name.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(SUFFIX, " "));

// Letter-pair overlap of two plain names, 0..1 (pg_trgm's idea, done here on lists already loaded)
function trigrams(s: string) {
  const out = new Set<string>();
  for (const w of s.split(" ").filter(Boolean)) {
    const p = `  ${w} `;
    for (let i = 0; i < p.length - 2; i++) out.add(p.slice(i, i + 3));
  }
  return out;
}
export function similarity(a: string, b: string) {
  const x = trigrams(plainName(a));
  const y = trigrams(plainName(b));
  if (!x.size || !y.size) return 0;
  let both = 0;
  for (const t of x) if (y.has(t)) both++;
  return both / (x.size + y.size - both);
}

// The existing one a new name (or email, phone) most likely means; null: none close.
// ponytail: compares against the loaded list; a business with 10k+ contacts wants pg_trgm's % in SQL instead
export function closeMatch<T extends { name: string; email?: string | null; phone?: string | null; archivedAt?: Date | string | null }>(
  all: T[],
  name: string,
  more: { email?: string | null; phone?: string | null } = {},
): T | null {
  const email = clean(more.email).toLowerCase();
  const phone = (more.phone ?? "").replace(/\D/g, "");
  const same = all.find((r) => (email && clean(r.email).toLowerCase() === email) || (phone.length >= 8 && (r.phone ?? "").replace(/\D/g, "").endsWith(phone.slice(-10))));
  if (same) return same;
  const plain = plainName(name);
  let best: T | null = null;
  let score = 0;
  for (const r of all) {
    const s = plainName(r.name) === plain ? 1 : similarity(r.name, name);
    if (s > score) [best, score] = [r, s];
  }
  return score >= 0.6 ? best : null;
}

// By slug, exact name, then a unique part of the name. A string is what's wrong.
export function findIn<T extends { slug: string; name: string }>(all: T[], q: string, what: string, exact = false): T | string {
  const s = clean(q).toLowerCase();
  if (!s) return `which ${what}?`;
  const hit = all.find((r) => r.slug === s) ?? all.find((r) => r.slug === slugOf(s)) ?? (exact ? undefined : all.find((r) => r.name.toLowerCase() === s));
  if (hit) return hit;
  if (exact) return `no ${what} "${q}"`;
  const loose = all.filter((r) => r.name.toLowerCase().includes(s) || r.slug.includes(slugOf(s) || s));
  if (loose.length === 1) return loose[0]!;
  return loose.length ? `"${q}" matches ${loose.slice(0, 8).map((r) => `${r.name} (${r.slug})`).join(", ")}; say which` : `no ${what} "${q}" (emplio ${what === "client" ? "clients" : `${what}s`} list)`;
}

// Money as written: 18000, "18,000", "₹18k", "1.5L", "2 Cr" (lakh and crore only for INR), "$999". null: nothing given.
// A string is what's wrong.
export function parseAmount(v: number | string | null | undefined, currency: string): number | null | { error: string } {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v === "number") return Number.isFinite(v) && v >= 0 ? Math.round(v * 100) / 100 : { error: "an amount is a number, 0 or more" };
  const s = v.toLowerCase().replace(/[,\s]/g, "").replace(/^(rs\.?|inr|usd|eur|gbp|aed|sgd|aud|[₹$€£])/, "").replace(/\/-$/, "");
  const m = /^(\d+(?:\.\d+)?)(k|l|lakh|lakhs|lac|cr|crore|crores|m)?$/.exec(s);
  if (!m) return { error: `"${v}" isn't an amount: write it as a number (18000, 18,000, 18k${currency === "INR" ? ", 1.5L, 2Cr" : ""})` };
  const unit = m[2] ?? "";
  const indian = ["l", "lakh", "lakhs", "lac", "cr", "crore", "crores"].includes(unit);
  if (indian && currency !== "INR") return { error: `lakh and crore are for amounts in INR; this business uses ${currency}: write the number` };
  const times = { "": 1, k: 1e3, m: 1e6, l: 1e5, lakh: 1e5, lakhs: 1e5, lac: 1e5, cr: 1e7, crore: 1e7, crores: 1e7 }[unit]!;
  return Math.round(Number(m[1]) * times * 100) / 100;
}

export async function currencyOf(workspaceId: string) {
  const w = await db.query.workspaces.findFirst({ where: eq(workspaces.id, workspaceId), columns: { currency: true } });
  return w?.currency ?? "INR";
}

// "12,34,000" for INR, "1,234,000" for the rest; null: nothing
export const money = (amount: number | string | null, currency: string | null, period?: string | null) => {
  if (amount === null) return null;
  const n = Number(amount);
  const s = n.toLocaleString(currency === "INR" ? "en-IN" : "en-US", { maximumFractionDigits: 2 });
  return `${currency ?? ""} ${s}${period && period !== "once" ? ` ${period === "hourly" ? "an hour" : period === "monthly" ? "a month" : "a year"}` : ""}`.trim();
};

// A write that carries the updatedAt it read, refused when the row changed after it, naming who changed it. me: the
// one writing; their own last change in the app (two quick edits, the second sent before the first came back) isn't
// someone else's
export async function stale(row: { id?: string; updatedAt: Date }, given: string | undefined, what: string, kind?: Kind, me?: Pick<Who, "userId" | "via">) {
  if (!given) return null;
  const t = Date.parse(given);
  if (Number.isNaN(t)) return "updatedAt isn't a time";
  // the database keeps microseconds, JSON milliseconds
  if (row.updatedAt.getTime() - t < 1) return null;
  if (kind && row.id && me?.userId && viaOf(me) === "app") {
    const [mine] = await db
      .select({ userId: activity.userId, via: activity.via })
      .from(activity)
      .where(and(eq(activity.subjectKind, kind), eq(activity.subjectId, row.id)))
      .orderBy(desc(activity.createdAt))
      .limit(1);
    if (mine?.userId === me.userId && mine.via === "app") return null;
  }
  const [last] = kind && row.id ? await historyOf("", { kind, id: row.id }, 1, true) : [];
  const by = last ? ` by ${last.who ?? "Emplio"}${last.via === "emplio" ? " (via Emplio)" : ""}` : "";
  return `${what} was changed${by} at ${row.updatedAt.toISOString().slice(0, 16).replace("T", " ")} UTC, after you read it; read it again and redo the change`;
}

// How a column is named in a record's history
const LABELS: Record<string, string> = { dueOn: "due date", startOn: "start date", feeNote: "fee note", priceNote: "price note", doneAt: "done", archivedAt: "archived" };
export const label = (field: string) => LABELS[field] ?? field.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase();

// The fields that differ between a row and the values about to be written (names: what a key is called)
export function diff(old: Record<string, unknown> | null, next: Record<string, unknown>, names: Record<string, string> = {}): RecordChange[] {
  const norm = (v: unknown) => (v instanceof Date ? v.toISOString() : v === undefined || v === "" ? null : v);
  return Object.entries(next).flatMap(([field, to]) => {
    const from = old ? norm(old[field]) : null;
    return JSON.stringify(from) === JSON.stringify(norm(to)) ? [] : [{ field: names[field] ?? label(field), from, to: norm(to) }];
  });
}

// The history row for a change, in the change's own transaction
// A delete for good that something linked to in the meantime: the database refuses it at commit (its links are checked
// then, see the records migration); said as the purge checks say it, not as a server error
export async function purging(name: string, run: () => Promise<unknown>): Promise<{ ok: true; name: string } | { ok: false; error: string }> {
  try {
    await run();
    return { ok: true, name };
  } catch (e) {
    const code = (e as { code?: string; cause?: { code?: string } }).cause?.code ?? (e as { code?: string }).code;
    if (code === "23503") return { ok: false, error: `${name} still has something linked to it (just added); it stays archived` };
    throw e;
  }
}

// A fee's period as people write it: "month", "per month", "pm", "annual", "one-time" (MONEY_PERIODS otherwise)
export const periodOf = (v: string) => {
  const t = v.trim().toLowerCase().replace(/^(a|per|every)\s+/, "");
  return /^(month|monthly|mo|pm|p\.m\.)$/.test(t) ? "monthly" : /^(year|yearly|annual|annually|pa|p\.a\.)$/.test(t) ? "yearly" : /^(hour|hourly|hr|ph)$/.test(t) ? "hourly" : /^(once|one[- ]?time|one[- ]?off|fixed)$/.test(t) ? "once" : v;
};

// clientId: the client(s) whose timeline shows it too: a contact at two clients, a project moved from one to another.
// The first row is the record's own; each further client gets a copy for its timeline only.
export async function logChange(
  tx: Tx,
  w: Who,
  e: { kind: Kind | "meeting"; id: string; clientId: string | null | (string | null)[]; summary: string; changes: RecordChange[]; detail?: Record<string, unknown> },
) {
  const all = [...new Set([e.clientId].flat())];
  const ids = all.length ? all : [null];
  const row = (clientId: string | null, own: boolean) => ({
    workspaceId: w.workspaceId,
    userId: w.userId || null,
    conversationId: w.conversationId || null,
    kind: e.kind,
    summary: clean(e.summary).slice(0, 300),
    detail: e.detail,
    subjectKind: own ? e.kind : null,
    // on the copies too (with no kind, so a record's own history still finds only its row): what hides them for staff
    subjectId: e.id,
    clientId,
    via: viaOf(w),
    changes: e.changes,
  });
  await tx.insert(activity).values(ids.map((c, i) => row(c, i === 0)));
}

// A record's history (or a client's: theirs and their contacts' and projects'), newest first
// anyWorkspace: by the record's id alone (ids are never shared across businesses)
// viewer: staff don't see a private contact's or project's lines on a client's timeline
export async function historyOf(workspaceId: string, of: { kind: Kind | "meeting"; id: string } | { clientId: string }, limit = 30, anyWorkspace = false, viewer: Viewer = workspaceId): Promise<HistoryEntry[]> {
  const ws = anyWorkspace ? undefined : eq(activity.workspaceId, workspaceId);
  const hide = seesPrivate(viewer)
    ? undefined
    : sql`not exists (select 1 from ${contacts} x where x.id = ${activity.subjectId} and x.private)
        and not exists (select 1 from ${projects} x where x.id = ${activity.subjectId} and x.private)
        and not exists (select 1 from ${services} x where x.id = ${activity.subjectId} and x.private)
        and not exists (select 1 from ${meetings} x where x.id = ${activity.subjectId} and x.private)`;
  const where = "clientId" in of ? and(ws, eq(activity.clientId, of.clientId), hide) : and(ws, eq(activity.subjectKind, of.kind), eq(activity.subjectId, of.id));
  const rows = await db
    .select({ id: activity.id, at: activity.createdAt, who: users.name, email: users.email, via: activity.via, summary: activity.summary, changes: activity.changes })
    .from(activity)
    .leftJoin(users, eq(users.id, activity.userId))
    .where(where)
    .orderBy(desc(activity.createdAt))
    .limit(limit);
  return rows.map((r) => ({ id: r.id, at: r.at.toISOString(), who: r.who ?? r.email ?? null, via: r.via, summary: r.summary, changes: r.changes ?? [] }));
}

// "--name X --stage Y word word Key=value": options, the words, and key=value pairs (details). The on/off ones
// (--force, --archived, --with-work, --all) never take the word after them.
const FLAGS = new Set(["force", "archived", "with-work", "all"]);
export function parseArgs(rest: string[], keep: string[] = []) {
  const words: string[] = [];
  const opts: Record<string, string> = {};
  const pairs: [string, string][] = [];
  const flags = new Set<string>();
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (a.startsWith("--")) {
      const [k, inline] = a.slice(2).split(/=(.*)/s, 2) as [string, string | undefined];
      if (inline !== undefined) opts[k] = inline;
      else if (FLAGS.has(k) || rest[i + 1] === undefined || rest[i + 1]!.startsWith("--")) flags.add(k);
      else opts[k] = rest[++i]!;
    } else if (a.includes("=")) {
      const k = a.slice(0, a.indexOf("=")).trim();
      const v = a.slice(a.indexOf("=") + 1).trim();
      if (keep.includes(k.toLowerCase())) opts[k.toLowerCase()] = v;
      else pairs.push([k, v]);
    } else words.push(a);
  }
  return { words, opts, pairs, flags };
}

// The person a given name, email, id or "me" means, among the team. A string is what's wrong.
export function personIn<T extends { id: string; name: string | null; email: string }>(team: T[], q: string, me: string): T | string {
  const s = clean(q).toLowerCase();
  if (s === "me") return team.find((m) => m.id === me) ?? "you aren't on the team";
  const hits = team.filter((m) => m.id === s || m.email === s || m.name?.toLowerCase() === s);
  const loose = hits.length ? hits : team.filter((m) => m.name?.toLowerCase().includes(s) || m.email.startsWith(s));
  if (loose.length === 1) return loose[0]!;
  return loose.length ? `"${q}" matches ${loose.map((m) => m.name ?? m.email).join(", ")}; use their email` : `nobody on the team matches "${q}" (emplio team list; add them with emplio team add <email>)`;
}

export const dateOnly = (v: string | null | undefined): string | null | { error: string } => {
  if (v === null || v === undefined || clean(v) === "") return null;
  const s = clean(v);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || Number.isNaN(Date.parse(`${s}T00:00:00Z`))) return { error: `"${v}" isn't a date: write it as YYYY-MM-DD` };
  return s;
};

export const count = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

if (import.meta.main) {
  console.assert(slugOf("Acme Foods Pvt. Ltd.") === "acme-foods-pvt-ltd");
  console.assert(plainName("Acme Pvt. Ltd.") === "acme", plainName("Acme Pvt. Ltd."));
  console.assert(closeMatch([{ name: "Acme Industries Pvt Ltd" }], "Acme Pvt Ltd") === null, "suffixes alone don't match");
  console.assert(closeMatch([{ name: "Northwind Coffee" }], "Northwind Cofee")?.name === "Northwind Coffee", "typo matches");
  console.assert(closeMatch([{ name: "X", email: "a@b.com" }], "Y", { email: "A@b.com" })?.name === "X", "email matches");
  console.assert(parseAmount("1.5L", "INR") === 150000 && parseAmount("₹18,000", "INR") === 18000 && parseAmount("18k", "USD") === 18000);
  console.assert(typeof parseAmount("1.5L", "USD") === "object" && typeof parseAmount("about 5", "INR") === "object");
  console.assert(parseAmount("2 Cr", "INR") === 20000000 && parseAmount("$999", "USD") === 999);
  console.assert(freeSlug("Acme", ["acme", "acme-2"], "x") === "acme-3");
  console.assert(diff({ a: 1, b: "x" }, { a: 1, b: "y", c: "" }).length === 1);
  console.assert(diff(null, { dueOn: "2026-01-01", tax: "1" }, { tax: "Tax number" }).map((c) => c.field).join() === "due date,Tax number");
  const p = parseArgs(["Acme", "Co", "--stage", "active", "--force", "Tax no=1", "stage=x"], ["stage"]);
  console.assert(p.words.join(" ") === "Acme Co" && p.opts.stage === "x" && p.flags.has("force") && p.pairs[0]![0] === "Tax no", p);
  console.assert(typeof dateOnly("2026-13-45") === "object" && dateOnly("2026-12-01") === "2026-12-01");
  console.log("ok");
}

export { sql };
