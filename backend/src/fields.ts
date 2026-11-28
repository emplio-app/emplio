// The business's own fields on each kind of record, beyond the built-in ones: a client's Tax number, a contact's
// Birthday, a project's PO number, a service's SAC code. Each has a type (text, number, date, choice); the values are
// in the record's own details, by the field's key, as text. Anyone fills them in where they can change the record;
// the list of fields is the owner's and admins' (Settings, or `emplio <kind>s fields`).
import { and, asc, eq, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { FIELD_KINDS, FIELD_TYPES, type ClientDetail, type ClientField, type FieldKind, type RecordChange } from "@emplio/shared";
import { context } from "./auth";
import { db } from "./db";
import { clientFields, clients, contacts, projects, services } from "./db/schema";
import { clean, count, diff, isAdmin, logChange, parseArgs, type Tx, type Who } from "./records";

const MAX = 50;
// ponytail: typed as clients' table; every one has id, name, workspaceId, details, updatedAt
const TABLES = { client: clients, contact: contacts, project: projects, service: services } as unknown as Record<FieldKind, typeof clients>;

// "Contact email" → contact-email: a field's key, and how a process input of the same name finds it (processes.ts)
export const detailKey = (name: string) =>
  name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

export async function listFields(workspaceId: string, kind: FieldKind = "client"): Promise<ClientField[]> {
  const rows = await db
    .select()
    .from(clientFields)
    .where(and(eq(clientFields.workspaceId, workspaceId), eq(clientFields.kind, kind)))
    .orderBy(asc(clientFields.position), asc(clientFields.name));
  return rows.map(({ id, key, name, type, options, position }) => ({ id, key, name, type, options, position }));
}

// A value as the field keeps it, or what's wrong with it
export function fieldValue(f: Pick<ClientField, "name" | "type" | "options">, raw: string): string | { error: string } {
  const v = clean(raw);
  if (v.length > 500) return { error: `${f.name} is at most 500 characters` };
  if (f.type === "number") {
    const n = v.replace(/,/g, "");
    return /^-?\d+(\.\d+)?$/.test(n) ? n : { error: `${f.name} is a number; "${raw}" isn't one` };
  }
  if (f.type === "date") return /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v)) ? v : { error: `${f.name} is a date: YYYY-MM-DD` };
  if (f.type === "choice") return f.options.find((o) => o.toLowerCase() === v.toLowerCase()) ?? { error: `${f.name} is one of ${f.options.join(", ")}` };
  return v;
}

// The details after the changes given (by a field's name or key; "" or null empties one). A field not there yet is
// added (as text) when an owner or admin fills it in; anyone else is told to ask for it.
export async function nextDetails(tx: Tx, w: Who, kind: FieldKind, fields: ClientField[], old: Record<string, string>, given: Record<string, string | null>) {
  const out = { ...old };
  const added: string[] = [];
  for (const [raw, v] of Object.entries(given)) {
    const key = detailKey(raw);
    if (!key) return { error: `"${raw}" isn't a field's name` };
    let f = fields.find((x) => x.key === key || detailKey(x.name) === key);
    if (!f) {
      if (!clean(v)) continue;
      // the record's own facts have their own options (--amount, --email, --lead): never a field of the same name
      const own = /^(name|amount|price|fee|period|email|e-mail|phone|mobile|title|role|org|lead|status|stage|handler|handlers|client|service|project|start|due|date|private|people|note)$/.exec(key);
      if (own) return { error: `"${clean(raw)}" isn't a field: use --${own[1] === "price" || own[1] === "fee" ? "amount" : own[1] === "e-mail" ? "email" : own[1] === "mobile" ? "phone" : own[1] === "handlers" ? "handler" : own[1]} (emplio ${kind}s help)` };
      // words aren't a field: what was said, decided or noted goes in the notes file
      if (/^(notes?|comments?|remarks?|summary|history|updates?|log|status-notes?|description|meeting-notes?)$/.test(key))
        return { error: `"${clean(raw)}" isn't a field: notes are words, in the ${kind}'s notes file (its show gives the path)` };
      if (!isAdmin(w)) return { error: `no ${kind} field "${clean(raw)}" (emplio ${kind}s fields list); an owner or admin adds one` };
      if (fields.length >= MAX) return { error: `a business has at most ${MAX} ${kind} fields` };
      const [row] = await tx
        .insert(clientFields)
        .values({ workspaceId: w.workspaceId, kind, key, name: clean(raw).slice(0, 60), position: fields.length })
        .returning();
      f = { ...row!, type: "text" };
      fields.push(f);
      added.push(f.name);
    }
    if (!clean(v)) delete out[f.key];
    else if (f.type === "text" && clean(v).length > 200) return { error: `${f.name} holds a short fact; longer words go in the ${kind}'s notes file` };
    else {
      const value = fieldValue(f, v!);
      if (typeof value === "object") return value;
      out[f.key] = value;
    }
  }
  return { details: out, added };
}

// The filled-in ones, in the fields' order
export const detailsOf = (fields: ClientField[], values: Record<string, string>): ClientDetail[] =>
  fields.flatMap((f) => (values[f.key] ? [{ key: f.key, name: f.name, value: values[f.key]! }] : []));

// Each detail that changed, by the field's name
export function detailChanges(fields: ClientField[], old: Record<string, string> | null, next: Record<string, string>): RecordChange[] {
  const keys = new Set([...Object.keys(old ?? {}), ...Object.keys(next)]);
  return diff(old, Object.fromEntries([...keys].map((k) => [k, next[k] ?? null])), Object.fromEntries(fields.map((f) => [f.key, f.name])));
}

// --- the lists themselves ---

async function logSetting(w: Who, summary: string) {
  const { record } = await import("./activity");
  record({ workspaceId: w.workspaceId, userId: w.userId, conversationId: w.conversationId || null, kind: "client", summary });
}

const find = (all: ClientField[], q: string) => all.find((f) => f.key === detailKey(q) || f.name.toLowerCase() === clean(q).toLowerCase());

export async function saveField(w: Who, kind: FieldKind, q: string | null, input: { name?: string; type?: string; options?: string[]; position?: number }) {
  if (!isAdmin(w)) return `only the owner or an admin can change the ${kind} fields`;
  const all = await listFields(w.workspaceId, kind);
  const name = input.name !== undefined ? clean(input.name).slice(0, 60) : undefined;
  if (name !== undefined && !detailKey(name)) return "a field needs a name";
  if (input.type !== undefined && !FIELD_TYPES.includes(input.type as ClientField["type"])) return `type is one of ${FIELD_TYPES.join(", ")}`;
  const options = input.options?.map(clean).filter(Boolean);
  const old = q === null ? null : find(all, q);
  if (q !== null && !old) return `no ${kind} field "${q}" (emplio ${kind}s fields list)`;
  if (name && all.some((f) => f.key === detailKey(name) && f.id !== old?.id)) return `there's a field ${name} already`;
  const type = (input.type ?? old?.type ?? "text") as ClientField["type"];
  const opts = options ?? old?.options ?? [];
  if (type === "choice" && !opts.length) return 'a choice field needs its options (--options "Monthly,Quarterly")';
  if (old && (input.type || options)) {
    // a type change is refused while any record's value doesn't fit it
    const t = TABLES[kind];
    const rows = await db.select({ name: t.name, details: t.details }).from(t).where(and(eq(t.workspaceId, w.workspaceId), sql`${t.details} ? ${old.key}`));
    const bad = rows.filter((r) => typeof fieldValue({ name: old.name, type, options: opts }, r.details[old.key]!) === "object");
    if (bad.length)
      return `${count(bad.length, kind)} ${bad.length === 1 ? "has" : "have"} a ${old.name} that isn't a ${type}${type === "choice" ? ` of ${opts.join(", ")}` : ""}: ${bad
        .slice(0, 5)
        .map((b) => `${b.name} (${b.details[old.key]})`)
        .join(", ")}; change those first`;
  }
  if (!old) {
    if (!name) return "a new field needs a name";
    if (all.length >= MAX) return `a business has at most ${MAX} ${kind} fields`;
    await db.insert(clientFields).values({ workspaceId: w.workspaceId, kind, key: detailKey(name), name, type, options: opts, position: input.position ?? all.length });
  } else {
    // the key stays: values and process inputs keep finding it
    await db.update(clientFields).set({ ...(name && { name }), type, options: opts, ...(input.position !== undefined && { position: input.position }) }).where(eq(clientFields.id, old.id));
  }
  await logSetting(w, old ? `Changed the ${kind} field ${old.name}` : `Added the ${kind} field ${name}`);
  return null;
}

export async function removeField(w: Who, kind: FieldKind, q: string) {
  if (!isAdmin(w)) return `only the owner or an admin can change the ${kind} fields`;
  const f = find(await listFields(w.workspaceId, kind), q);
  if (!f) return `no ${kind} field "${q}"`;
  const t = TABLES[kind];
  await db.transaction(async (tx) => {
    const had = await tx
      .select({ id: t.id, name: t.name, details: t.details, clientId: kind === "project" ? projects.clientId : sql<string | null>`null` })
      .from(t)
      .where(and(eq(t.workspaceId, w.workspaceId), sql`${t.details} ? ${f.key}`));
    for (const r of had) {
      await tx.update(t).set({ details: sql`${t.details} - ${f.key}`, updatedAt: new Date() }).where(eq(t.id, r.id));
      await logChange(tx, w, {
        kind,
        id: r.id,
        clientId: kind === "client" ? r.id : r.clientId,
        summary: `${f.name} removed from ${r.name} (the field was removed)`,
        changes: [{ field: f.name, from: r.details[f.key], to: null }],
      });
    }
    await tx.delete(clientFields).where(eq(clientFields.id, f.id));
  });
  await logSetting(w, `Removed the ${kind} field ${f.name}`);
  return null;
}

export const fieldsUsage = (kind: FieldKind) => `usage: emplio ${kind}s fields list
       emplio ${kind}s fields add <name> [--type text|number|date|choice] [--options "A,B,C"] [--position <n>]
       emplio ${kind}s fields update <name> [--name <new name>] [--type ...] [--options ...] [--position <n>]
       emplio ${kind}s fields remove <name>                 removes its value from every ${kind}`;

// `emplio <kind>s fields ...`
export async function fieldsCommand(w: Who, kind: FieldKind, args: string[]) {
  const [sub, ...rest] = args;
  const { words, opts } = parseArgs(rest);
  const name = words.join(" ");
  const position = opts.position !== undefined ? Number(opts.position) : undefined;
  if (position !== undefined && !Number.isInteger(position)) return "error: --position is a whole number";
  const options = opts.options?.split(",");
  const show = async () =>
    (await listFields(w.workspaceId, kind)).map((f) => `${f.name}\t${f.type}${f.options.length ? ` (${f.options.join(", ")})` : ""}`).join("\n") || `No ${kind} fields yet.`;
  if (sub === "list") return show();
  const usage = fieldsUsage(kind);
  const err =
    sub === "add" && name ? await saveField(w, kind, null, { name, type: opts.type, options, position })
    : sub === "update" && name ? await saveField(w, kind, name, { name: opts.name, type: opts.type, options, position })
    : sub === "remove" && name ? await removeField(w, kind, name)
    : usage;
  return err === usage ? err : err ? `error: ${err}` : `done; the ${kind} fields now:\n${await show()}`;
}

// --- routes: /fields/:kind ---

const BODY = {
  type: "object",
  additionalProperties: false,
  properties: { name: { type: "string", maxLength: 60 }, type: { type: "string" }, options: { type: "array", items: { type: "string", maxLength: 60 }, maxItems: 30 }, position: { type: "integer" } },
};
type Body = { name?: string; type?: string; options?: string[]; position?: number };
const fail = (reply: { code: (n: number) => { send: (b: unknown) => unknown } }, error: string) => reply.code(400).send({ error });

export async function fieldRoutes(app: FastifyInstance) {
  const kindOf = (k: string) => (FIELD_KINDS as readonly string[]).includes(k) ? (k as FieldKind) : null;
  app.get<{ Params: { kind: string } }>("/fields/:kind", async (req, reply) => {
    const ctx = await context(req, reply);
    if (!ctx) return;
    const kind = kindOf(req.params.kind);
    return kind ? listFields(ctx.workspaceId, kind) : fail(reply, "no such kind");
  });
  app.post<{ Params: { kind: string }; Body: Body }>("/fields/:kind", { schema: { body: { ...BODY, required: ["name"] } } }, async (req, reply) => {
    const ctx = await context(req, reply);
    if (!ctx) return;
    const kind = kindOf(req.params.kind);
    if (!kind) return fail(reply, "no such kind");
    const e = await saveField(ctx, kind, null, req.body);
    return e ? fail(reply, e) : listFields(ctx.workspaceId, kind);
  });
  app.patch<{ Params: { kind: string; id: string }; Body: Body }>("/fields/:kind/:id", { schema: { body: BODY } }, async (req, reply) => {
    const ctx = await context(req, reply);
    if (!ctx) return;
    const kind = kindOf(req.params.kind);
    const f = kind && (await listFields(ctx.workspaceId, kind)).find((x) => x.id === req.params.id);
    if (!kind || !f) return fail(reply, "no such field");
    const e = await saveField(ctx, kind, f.key, req.body);
    return e ? fail(reply, e) : listFields(ctx.workspaceId, kind);
  });
  app.delete<{ Params: { kind: string; id: string } }>("/fields/:kind/:id", async (req, reply) => {
    const ctx = await context(req, reply);
    if (!ctx) return;
    const kind = kindOf(req.params.kind);
    const f = kind && (await listFields(ctx.workspaceId, kind)).find((x) => x.id === req.params.id);
    if (!kind || !f) return fail(reply, "no such field");
    const e = await removeField(ctx, kind, f.key);
    return e ? fail(reply, e) : listFields(ctx.workspaceId, kind);
  });
}

if (import.meta.main) {
  console.assert(detailKey(" Contact email ") === "contact-email");
  console.assert(fieldValue({ name: "Fee", type: "number", options: [] }, "18,000") === "18000");
  console.assert(typeof fieldValue({ name: "Fee", type: "number", options: [] }, "lots") === "object");
  console.assert(fieldValue({ name: "Files", type: "choice", options: ["Monthly", "Quarterly"] }, "monthly") === "Monthly");
  console.assert(typeof fieldValue({ name: "Due", type: "date", options: [] }, "next week") === "object");
  const fs = [{ id: "1", key: "po", name: "PO number", type: "text" as const, options: [], position: 0 }];
  const ch = detailChanges(fs, { po: "1" }, { po: "2" });
  console.assert(ch.length === 1 && ch[0]!.field === "PO number" && ch[0]!.from === "1" && ch[0]!.to === "2", "named change");
  console.assert(detailChanges(fs, { po: "1" }, {})[0]?.to === null, "emptied");
  console.log("ok");
}
