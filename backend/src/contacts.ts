// Contacts: people the business deals with: at its clients (with their role there: Director, Approves designs; one
// person can be at several clients, a director on four group companies) or elsewhere (org: the auditor's firm).
// Rows, by the rules in records.ts; their notes are company/contacts/<slug>/index.md. Anyone adds and changes them;
// archiving is the owner's and admins'.
import { and, asc, eq, inArray, isNotNull, isNull, sql, type SQL } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { Contact, ContactInput } from "@emplio/shared";
import { context } from "./auth";
import { findClient } from "./clients";
import { db } from "./db";
import { detailChanges, detailsOf, fieldsCommand, listFields, nextDetails } from "./fields";
import { followNotes, notesDir, setPrivate, notesAt } from "./private";
import { clients, contactClients, contacts } from "./db/schema";
import { purging, clean, diff, findIn, freeSlug, historyOf, isAdmin, logChange, orNull, parseArgs, plainName, similarity, slugOf, stale, type Who, matchOf, type Match, privateOf, seesPrivate, type Viewer, wsOf, say, visibleClient, visibleContact, allClientsPrivate } from "./records";

type Result = { ok: true; contact: Contact } | { ok: false; error: string; match?: Match };
export const notesPath = (c: { slug: string; private?: boolean }) => `${notesDir("contact", c)}/index.md`;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function listContacts(v: Viewer, f: { clientId?: string; archived?: boolean; ids?: string[] } = {}): Promise<Contact[]> {
  const workspaceId = wsOf(v);
  const all = seesPrivate(v);
  const where: (SQL | undefined)[] = [eq(contacts.workspaceId, workspaceId), f.archived ? isNotNull(contacts.archivedAt) : isNull(contacts.archivedAt)];
  // everyone's, or a private one at a client they handle
  where.push(visibleContact(v));
  if (f.ids) where.push(f.ids.length ? inArray(contacts.id, f.ids) : sql`false`);
  if (f.clientId) where.push(sql`exists (select 1 from ${contactClients} where ${contactClients.contactId} = ${contacts.id} and ${contactClients.clientId} = ${f.clientId})`);
  const [rows, fieldList] = await Promise.all([
    db.select({ c: contacts, withClients: allClientsPrivate() }).from(contacts).where(and(...where)).orderBy(asc(sql`lower(${contacts.name})`)),
    listFields(workspaceId, "contact"),
  ]);
  if (!rows.length) return [];
  const links = await db
    .select({ contactId: contactClients.contactId, role: contactClients.role, id: clients.id, slug: clients.slug, name: clients.name })
    .from(contactClients)
    .innerJoin(clients, eq(clients.id, contactClients.clientId))
    // a private client isn't named to someone who can't see it
    .where(and(inArray(contactClients.contactId, rows.map((r) => r.c.id)), visibleClient(v, clients.id, clients.private)))
    .orderBy(asc(clients.name));
  return rows.map(({ c: r, withClients }) => ({
    id: r.id,
    slug: r.slug,
    name: r.name,
    email: r.email,
    phone: r.phone,
    title: r.title,
    org: r.org,
    clients: links.filter((l) => l.contactId === r.id).map(({ id, slug, name, role }) => ({ id, slug, name, role })),
    details: detailsOf(fieldList, r.details),
    private: r.private || withClients,
    privateBecause: !r.private && withClients ? links.filter((l) => l.contactId === r.id).map((l) => l.name).join(", ") : null,
    archivedAt: r.archivedAt?.toISOString() ?? null,
    updatedAt: r.updatedAt.toISOString(),
  }));
}

export async function findContact(v: Viewer, q: string, exact = false, archived = false) {
  return findIn(await listContacts(v, { archived }), q, "contact", exact);
}
const one = async (workspaceId: string, id: string, archived = false) => (await listContacts(workspaceId, { ids: [id], archived }))[0]!;

// The clients given, as ids with their roles; a string is what's wrong
async function clientLinks(v: Viewer, given: { client: string; role?: string | null }[]) {
  const out: { clientId: string; role: string | null; name: string; private: boolean }[] = [];
  for (const g of given) {
    const c = await findClient(v, g.client);
    if (typeof c === "string") return c;
    if (c.archivedAt) return `${c.name} is archived`;
    if (!out.some((o) => o.clientId === c.id)) out.push({ clientId: c.id, role: orNull(g.role)?.slice(0, 80) ?? null, name: c.name, private: c.private });
  }
  return out;
}

const fields = (i: ContactInput) => {
  const v: Record<string, string | null> = {};
  if (i.name !== undefined) v.name = clean(i.name).slice(0, 200);
  for (const k of ["email", "phone", "title", "org"] as const) if (i[k] !== undefined) v[k] = orNull(i[k])?.slice(0, 200) ?? null;
  if (v.email) v.email = v.email.toLowerCase();
  return v;
};
const checkFields = (v: Record<string, string | null>) =>
  v.name !== undefined && !v.name ? "a contact needs a name" : v.email && !EMAIL.test(v.email) ? `"${v.email}" isn't an email address` : v.phone && v.phone.replace(/\D/g, "").length < 6 ? `"${v.phone}" isn't a phone number` : null;
const linksText = (l: { name: string; role: string | null }[]) => l.map((x) => (x.role ? `${x.name} (${x.role})` : x.name));

// A close match: the same email or phone anywhere, or a close name at one of the same clients (two Rahuls at
// different firms are two people)
function duplicate(all: Contact[], name: string, email: string | null, phone: string | null, clientIds: string[]) {
  const digits = (p: string | null) => (p ?? "").replace(/\D/g, "").slice(-10);
  const same = all.find((c) => (email && c.email === email) || (digits(phone).length >= 8 && digits(c.phone) === digits(phone)));
  if (same) return same;
  return all.find((c) => (plainName(c.name) === plainName(name) || similarity(c.name, name) >= 0.6) && (!clientIds.length || !c.clients.length || c.clients.some((k) => clientIds.includes(k.id)))) ?? null;
}

export async function addContact(w: Who, input: ContactInput): Promise<Result> {
  const v = fields(input);
  if (!v.name) return { ok: false, error: "a contact needs a name" };
  const bad = checkFields(v);
  if (bad) return { ok: false, error: bad };
  const links = await clientLinks(w, input.clients ?? []);
  if (typeof links === "string") return { ok: false, error: links };
  if (input.private && !isAdmin(w)) return { ok: false, error: "only the owner or an admin can make a contact private" };
  const [current, archived] = await Promise.all([listContacts(w.workspaceId), listContacts(w.workspaceId, { archived: true })]);
  const match = duplicate([...current, ...archived], v.name, v.email ?? null, v.phone ?? null, links.map((l) => l.clientId));
  if (match?.private && !seesPrivate(w)) return { ok: false, error: "the owner or an admin already keeps someone like that; ask them" };
  if (match && !input.force)
    return {
      ok: false,
      match: matchOf(match),
      error: match.archivedAt
        ? `${match.name} is an archived contact; ${say(w, "bring them back from the archived contacts, or add a new one anyway", `bring them back with emplio contacts restore ${match.slug}, or add with --force`)}`
        : `did you mean ${match.name}${match.clients.length ? ` at ${match.clients.map((c) => c.name).join(", ")}` : ""}? (emplio contacts show ${match.slug}); to link them to another client: emplio contacts update ${match.slug} --client <name>; if this is someone else, add with --force`,
    };
  const slug = freeSlug(v.name, [...current, ...archived].map((c) => c.slug), "contact");
  const fieldList = await listFields(w.workspaceId, "contact");
  const id = await db.transaction(async (tx) => {
    const d = await nextDetails(tx, w, "contact", fieldList, {}, input.details ?? {});
    if ("error" in d) return { error: d.error! };
    // at private clients only, they're private with them without a switch of their own (listContacts)
    const priv = !!input.private;
    const [row] = await tx.insert(contacts).values({ workspaceId: w.workspaceId, slug, name: v.name!, email: v.email, phone: v.phone, title: v.title, org: v.org, details: d.details, private: priv }).returning();
    if (links.length) await tx.insert(contactClients).values(links.map((l) => ({ contactId: row!.id, clientId: l.clientId, role: l.role })));
    // ponytail: on the first client's history only; a contact at several shows on the others' contact lists
    await logChange(tx, w, {
      kind: "contact",
      id: row!.id,
      clientId: links[0]?.clientId ?? null,
      summary: `Added contact ${v.name}${links.length ? ` at ${links.map((l) => l.name).join(", ")}` : ""}`,
      changes: [...diff(null, { ...v, clients: linksText(links), ...(priv && { private: true }) }), ...detailChanges(fieldList, null, d.details)],
      detail: match ? { forced: true, matched: { slug: match.slug, name: match.name } } : undefined,
    });
    return row!.id;
  });
  if (typeof id === "object") return { ok: false, error: id.error };
  return { ok: true, contact: await one(w.workspaceId, id) };
}

// Only what's given changes; clients, when given, is their whole list
export async function updateContact(w: Who, q: string, input: ContactInput, exact = false): Promise<Result> {
  if (input.private !== undefined && !isAdmin(w)) return { ok: false, error: "only the owner or an admin can make a contact private" };
  const found = await findContact(w, q, exact);
  if (typeof found === "string") return { ok: false, error: found };
  const v = fields(input);
  const bad = checkFields(v);
  if (bad) return { ok: false, error: bad };
  // someone who can't see a private client keeps the contact's link to it
  const hidden = seesPrivate(w) ? [] : (await listContacts(w.workspaceId, { ids: [found.id] }))[0]!.clients.filter((c) => !found.clients.some((k) => k.id === c.id));
  const links = input.clients ? await clientLinks(w, input.clients).then((l) => (typeof l === "string" ? l : [...l, ...hidden.map((h) => ({ clientId: h.id, role: h.role, name: h.name, private: true }))])) : null;
  if (typeof links === "string") return { ok: false, error: links };
  if (input.private === false && found.privateBecause) return { ok: false, error: `${found.name} is private because ${found.privateBecause} is; share them to share ${found.name}` };
  // as everyone sees it: changing their clients can make them private or not
  const was = (await one(w.workspaceId, found.id)).private;
  const fieldList = await listFields(w.workspaceId, "contact");
  const err = await db.transaction(async (tx) => {
    const [row] = await tx.select().from(contacts).where(eq(contacts.id, found.id)).for("update");
    if (!row) return `${found.name} was deleted meanwhile`;
    const late = await stale(row, input.updatedAt, found.name, "contact", w);
    if (late) return late;
    const d = input.details ? await nextDetails(tx, w, "contact", fieldList, row.details, input.details) : { details: row.details };
    if ("error" in d) return d.error!;
    const changes = [...diff(row, v), ...detailChanges(fieldList, row.details, d.details)];
    if (links) {
      const before = linksText(found.clients);
      const after = linksText(links.filter((l) => !hidden.some((h) => h.id === l.clientId)));
      if (JSON.stringify(before) !== JSON.stringify(after)) {
        changes.push({ field: "clients", from: before, to: after });
        await tx.delete(contactClients).where(eq(contactClients.contactId, row.id));
        if (links.length) await tx.insert(contactClients).values(links.map((l) => ({ contactId: row.id, clientId: l.clientId, role: l.role })));
      }
    }
    if (!changes.length) return null;
    await tx.update(contacts).set({ ...v, details: d.details, updatedAt: new Date() }).where(eq(contacts.id, row.id));
    await logChange(tx, w, { kind: "contact", id: row.id, clientId: [...found.clients.map((c) => c.id), ...(links ?? []).map((l) => l.clientId)], summary: `Changed ${changes.map((c) => c.field).join(", ")} of ${row.name}`, changes });
    return null;
  });
  if (err) return { ok: false, error: err };
  if (input.private !== undefined) {
    const e = await setPrivate(w, "contact", found.id, input.private);
    if (e) return { ok: false, error: e };
  }
  const now = await one(w.workspaceId, found.id);
  // a switch moved their notes already; a change of clients may have to
  const e = input.private === undefined ? await followNotes(w.workspaceId, "contact", now, was, now.private) : null;
  if (e) return { ok: false, error: e };
  return { ok: true, contact: now };
}

export async function archiveContact(w: Who, q: string, archive: boolean, exact = false): Promise<Result> {
  if (!isAdmin(w)) return { ok: false, error: `only the owner or an admin can ${archive ? "archive" : "bring back"} a contact` };
  const c = await findContact(w, q, exact, !archive);
  if (typeof c === "string") return { ok: false, error: c };
  await db.transaction(async (tx) => {
    await tx.update(contacts).set({ archivedAt: archive ? new Date() : null, updatedAt: new Date() }).where(eq(contacts.id, c.id));
    await logChange(tx, w, { kind: "contact", id: c.id, clientId: c.clients.length ? c.clients.map((x) => x.id) : null, summary: `${archive ? "Archived" : "Brought back"} ${c.name}`, changes: [{ field: "archived", from: !archive, to: archive }] });
  });
  return { ok: true, contact: await one(w.workspaceId, c.id, archive) };
}

// The owner, from the app: an archived contact added by mistake
export async function purgeContact(w: Who, slug: string) {
  if (w.role !== "owner") return { ok: false as const, error: "only the owner can delete a contact for good" };
  const c = await findContact(w.workspaceId, slug, true, true);
  if (typeof c === "string") return { ok: false as const, error: "archive them first" };
  return purging(c.name, () =>
    db.transaction(async (tx) => {
      await tx.delete(contacts).where(eq(contacts.id, c.id));
      // their links to clients go with them: said so, on each of those clients' timelines
      const at = c.clients.map((k) => k.name);
      await logChange(tx, w, {
        kind: "contact",
        id: c.id,
        clientId: c.clients.length ? c.clients.map((k) => k.id) : null,
        summary: `Deleted ${c.name} for good${at.length ? `, and their link to ${at.join(", ")}` : ""}`,
        changes: at.length ? [{ field: "clients", from: at.join(", "), to: null }] : [],
      });
    }),
  );
}

// --- `emplio contacts` ---

export const USAGE = `usage: emplio contacts list [--client <name>] [--archived]   people the business deals with, and where
       emplio contacts show <name>
       emplio contacts add <name> [options]
       emplio contacts update <name> [options]          only what you name changes
       emplio contacts archive <name> | restore <name>  (owner and admins)
       emplio contacts fields list|add|update|remove   this business's contact fields (owner and admins change them)
options: --email <email> --phone <phone> --title <their job title> --org <firm, when not a client>
         --client <name> [--role <their role there>]   at a client (add: their first; update: adds one, or changes the role)
         --unlink <client name>                         update: no longer at that client
         --name <new name>                              update only; their slug stays
         --private yes|no                               owners and admins only see them; their notes move to restricted/
         --force                                        add even though someone close is there (it's recorded)
         --updated-at <time>                            update only: the updatedAt you read
         "Field=value"                                  one of the business's contact fields: "Birthday=1984-03-02"; "Field=" empties it
Contacts live in the database: change them only with this command; their notes (words) are company/contacts/<slug>/index.md.`;

const line = (c: Contact) => [c.slug, c.name, c.clients.map((k) => (k.role ? `${k.name} (${k.role})` : k.name)).join(", ") || c.org || "no client", c.email ?? "", c.phone ?? ""].join("\t");

export async function contactsCommand(base: Omit<Who, "via" | "conversationId">, conversationId: string, args: string[], data = false): Promise<string> {
  const w: Who = { ...base, via: "emplio", conversationId };
  const [sub, ...rest] = args;
  if (sub === "fields") return fieldsCommand(w, "contact", rest);
  const { words, opts, flags, pairs } = parseArgs(rest);
  const name = words.join(" ");
  const input = (): ContactInput => {
    const i: ContactInput = {};
    if (pairs.length) i.details = Object.fromEntries(pairs);
    if (opts.name !== undefined) i.name = opts.name;
    for (const k of ["email", "phone", "title", "org"] as const) if (opts[k] !== undefined) i[k] = opts[k];
    if (opts["updated-at"]) i.updatedAt = opts["updated-at"];
    if (flags.has("force")) i.force = true;
    const priv = privateOf(opts, flags);
    if (priv !== undefined) i.private = priv;
    return i;
  };
  if (sub === "list") {
    let clientId: string | undefined;
    if (opts.client) {
      const c = await findClient(w, opts.client);
      if (typeof c === "string") return `error: ${c}`;
      clientId = c.id;
    }
    const list = await listContacts(w, { clientId, archived: flags.has("archived") });
    if (data) return JSON.stringify(list);
    return list.length ? list.map(line).join("\n") : "No contacts yet. Add one with emplio contacts add <name> --client <client>.";
  }
  if (sub === "show" && name) {
    const c = await findContact(w, name);
    if (typeof c === "string") return `error: ${c}`;
    if (data) return JSON.stringify(c);
    const history = await historyOf(w.workspaceId, { kind: "contact", id: c.id }, 8);
    return [
      `${c.name} (${c.slug})${c.private ? " · PRIVATE (owners, admins and the handlers of its clients)" : ""}${c.archivedAt ? " · ARCHIVED" : ""} · updatedAt ${c.updatedAt}`,
      ...(c.title ? [`title: ${c.title}`] : []),
      ...(c.email ? [`email: ${c.email}`] : []),
      ...(c.phone ? [`phone: ${c.phone}`] : []),
      ...(c.org ? [`works at: ${c.org}`] : []),
      ...c.details.map((d) => `${d.name}: ${d.value}`),
      `clients: ${c.clients.map((k) => `${k.name} (${k.slug})${k.role ? `, ${k.role}` : ""}`).join("; ") || "none"}`,
      ...(history.length ? ["recent changes:", ...history.map((h) => `- ${h.at.slice(0, 10)} ${h.who ?? "Emplio"}: ${h.summary}`)] : []),
      `notes: ${notesAt(w, "contact", c)}`,
    ].join("\n");
  }
  if (sub === "add" && name) {
    const r = await addContact(w, { ...input(), name, clients: opts.client ? [{ client: opts.client, role: opts.role }] : [] });
    return r.ok ? `added ${line(r.contact)}` : `error: ${r.error}`;
  }
  if (sub === "update" && name) {
    const i = input();
    if (opts.client || opts.unlink) {
      const c = await findContact(w, name);
      if (typeof c === "string") return `error: ${c}`;
      let list = c.clients.map((k) => ({ client: k.slug, role: k.role }));
      if (opts.unlink) {
        const gone = await findClient(w, opts.unlink);
        if (typeof gone === "string") return `error: ${gone}`;
        list = list.filter((k) => k.client !== gone.slug);
      }
      if (opts.client) {
        const add = await findClient(w, opts.client);
        if (typeof add === "string") return `error: ${add}`;
        const at = list.find((k) => k.client === add.slug);
        if (at) at.role = opts.role ?? at.role;
        else list.push({ client: add.slug, role: opts.role ?? null });
      }
      i.clients = list;
    } else if (opts.role) return "error: --role goes with --client <name>";
    if (!Object.keys(i).filter((k) => k !== "updatedAt").length) return USAGE;
    const r = await updateContact(w, name, i);
    return r.ok ? `updated ${line(r.contact)}` : `error: ${r.error}`;
  }
  if ((sub === "archive" || sub === "remove" || sub === "restore") && name) {
    const r = await archiveContact(w, name, sub !== "restore");
    return r.ok ? `${sub === "restore" ? "brought back" : "archived"} ${r.contact.name}` : `error: ${r.error}`;
  }
  return USAGE;
}

const BODY = {
  type: "object",
  additionalProperties: false,
  properties: {
    name: { type: "string", maxLength: 200 },
    email: { type: ["string", "null"], maxLength: 254 },
    phone: { type: ["string", "null"], maxLength: 40 },
    title: { type: ["string", "null"], maxLength: 200 },
    org: { type: ["string", "null"], maxLength: 200 },
    private: { type: "boolean" },
    details: { type: "object", maxProperties: 50, additionalProperties: { type: ["string", "null"], maxLength: 500 } },
    clients: { type: "array", maxItems: 50, items: { type: "object", required: ["client"], additionalProperties: false, properties: { client: { type: "string", maxLength: 200 }, role: { type: ["string", "null"], maxLength: 80 } } } },
    updatedAt: { type: "string", maxLength: 40 },
    force: { type: "boolean" },
  },
};

export async function contactRoutes(app: FastifyInstance) {
  app.get<{ Querystring: { archived?: string; client?: string } }>("/contacts", async (req, reply) => {
    const ctx = await context(req, reply);
    if (!ctx) return;
    const client = req.query.client ? await findClient(ctx, req.query.client, true) : null;
    if (typeof client === "string") return reply.code(400).send({ error: client });
    return listContacts(ctx, { archived: req.query.archived === "1", clientId: client?.id });
  });
  app.get<{ Params: { slug: string } }>("/contacts/:slug", async (req, reply) => {
    const ctx = await context(req, reply);
    if (!ctx) return;
    const c = (await findContact(ctx, req.params.slug, true)) as Contact | string;
    const found = typeof c === "string" ? await findContact(ctx, req.params.slug, true, true) : c;
    if (typeof found === "string") return reply.code(404).send({ error: "No such contact." });
    return { contact: found, history: await historyOf(ctx.workspaceId, { kind: "contact", id: found.id }) };
  });
  app.post<{ Body: ContactInput }>("/contacts", { schema: { body: { ...BODY, required: ["name"] } } }, async (req, reply) => {
    const ctx = await context(req, reply);
    if (!ctx) return;
    const r = await addContact(ctx, req.body);
    return r.ok ? r.contact : reply.code(400).send({ error: r.error, match: r.match });
  });
  app.patch<{ Params: { slug: string }; Body: ContactInput }>("/contacts/:slug", { schema: { body: BODY } }, async (req, reply) => {
    const ctx = await context(req, reply);
    if (!ctx) return;
    const r = await updateContact(ctx, req.params.slug, req.body, true);
    return r.ok ? r.contact : reply.code(400).send({ error: r.error, match: r.match });
  });
  for (const [path, archive] of [["archive", true], ["restore", false]] as const)
    app.post<{ Params: { slug: string } }>(`/contacts/:slug/${path}`, async (req, reply) => {
      const ctx = await context(req, reply);
      if (!ctx) return;
      const r = await archiveContact(ctx, req.params.slug, archive, true);
      return r.ok ? r.contact : reply.code(400).send({ error: r.error, match: r.match });
    });
  app.delete<{ Params: { slug: string } }>("/contacts/:slug", async (req, reply) => {
    const ctx = await context(req, reply);
    if (!ctx) return;
    const r = await purgeContact(ctx, req.params.slug);
    return r.ok ? r : reply.code(400).send({ error: r.error });
  });
}

if (import.meta.main) {
  const c = (name: string, email: string | null, clients: string[]): Contact => ({ id: name, slug: slugOf(name), name, email, phone: null, title: null, org: null, clients: clients.map((id) => ({ id, slug: id, name: id, role: null })), details: [], private: false, privateBecause: null, archivedAt: null, updatedAt: "" });
  const all = [c("Sarah Lee", "sarah@northwind.com", ["northwind"]), c("Rahul Shah", null, ["acme"])];
  console.assert(duplicate(all, "Someone", "SARAH@northwind.com".toLowerCase(), null, [])?.name === "Sarah Lee", "email");
  console.assert(duplicate(all, "Rahul Shah", null, null, ["globex"]) === null, "same name, other client: another person");
  console.assert(duplicate(all, "Rahul Sha", null, null, ["acme"])?.name === "Rahul Shah", "close name, same client");
  console.assert(checkFields({ email: "nope" }) !== null && checkFields({ name: "A", email: "a@b.co" }) === null);
  console.log("ok");
}
