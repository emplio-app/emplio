// Services: what the business sells (GST filing, Website build, Monthly retainer): its price (an amount in the
// business's currency, once, monthly, yearly or hourly, and a note: "+ GST", "80 h/month") and the process a project
// of it runs. Rows, by the rules in records.ts. Anyone adds one; prices and archiving are the owner's and admins'.
import { and, asc, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { MONEY_PERIODS, type MoneyPeriod, type Service, type ServiceInput } from "@emplio/shared";
import { context } from "./auth";
import { db } from "./db";
import { detailChanges, detailsOf, fieldsCommand, listFields, nextDetails } from "./fields";
import { setPrivate } from "./private";
import { clients, projects, services } from "./db/schema";
import { purging, clean, currencyOf, diff, findIn, freeSlug, historyOf, isAdmin, logChange, money, orNull, parseAmount, parseArgs, periodOf, slugOf, stale, type Who, matchOf, type Match, privateOf, seesPrivate, type Viewer, wsOf, say, visibleProject } from "./records";

type Result = { ok: true; service: Service } | { ok: false; error: string; match?: Match };

export async function listServices(v: Viewer, f: { archived?: boolean; ids?: string[] } = {}): Promise<Service[]> {
  const workspaceId = wsOf(v);
  const where = [eq(services.workspaceId, workspaceId), f.archived ? isNotNull(services.archivedAt) : isNull(services.archivedAt)];
  if (!seesPrivate(v)) where.push(eq(services.private, false));
  if (f.ids) where.push(f.ids.length ? inArray(services.id, f.ids) : sql`false`);
  const [rows, fieldList] = await Promise.all([db.select().from(services).where(and(...where)).orderBy(asc(sql`lower(${services.name})`)), listFields(workspaceId, "service")]);
  if (!rows.length) return [];
  const active = await db
    .select({ serviceId: projects.serviceId, n: sql<number>`count(*)`.mapWith(Number) })
    .from(projects)
    .where(and(inArray(projects.serviceId, rows.map((r) => r.id)), eq(projects.status, "active"), isNull(projects.archivedAt), visibleProject(v)))
    .groupBy(projects.serviceId);
  return rows.map((r) => ({
    id: r.id,
    slug: r.slug,
    name: r.name,
    amount: r.amount === null ? null : Number(r.amount),
    currency: r.currency,
    period: r.period,
    priceNote: r.priceNote,
    process: r.process,
    activeProjects: active.find((a) => a.serviceId === r.id)?.n ?? 0,
    details: detailsOf(fieldList, r.details),
    private: r.private,
    archivedAt: r.archivedAt?.toISOString() ?? null,
    updatedAt: r.updatedAt.toISOString(),
  }));
}

export async function findService(v: Viewer, q: string, exact = false, archived = false) {
  return findIn(await listServices(v, { archived }), q, "service", exact);
}
const one = async (workspaceId: string, id: string, archived = false) => (await listServices(workspaceId, { ids: [id], archived }))[0]!;

// The columns for what's given; a string is what's wrong
async function values(w: Who, i: ServiceInput) {
  const v: Partial<typeof services.$inferInsert> = {};
  if (i.name !== undefined) {
    v.name = clean(i.name).slice(0, 200);
    if (!slugOf(v.name)) return "a service needs a name";
  }
  if (i.amount !== undefined) {
    const currency = await currencyOf(w.workspaceId);
    const a = parseAmount(i.amount, currency);
    if (a !== null && typeof a === "object") return a.error;
    v.amount = a === null ? null : String(a);
    v.currency = a === null ? null : currency;
  }
  if (i.period !== undefined) {
    if (i.period !== null && !MONEY_PERIODS.includes(i.period)) return `the period is one of ${MONEY_PERIODS.join(", ")}`;
    v.period = i.period;
  }
  if (i.priceNote !== undefined) v.priceNote = orNull(i.priceNote)?.slice(0, 200) ?? null;
  if (i.process !== undefined) {
    const name = orNull(i.process);
    if (name) {
      const { listProcesses } = await import("./processes");
      const p = (await listProcesses(w.workspaceId, w)).find((x) => x.name === name || x.title.toLowerCase() === name.toLowerCase());
      if (!p) return `no process "${name}" (emplio processes list)`;
      v.process = p.name;
    } else v.process = null;
  }
  return v;
}
const priceFields = ["amount", "period", "priceNote"] as const;

export async function addService(w: Who, input: ServiceInput & { force?: boolean }): Promise<Result> {
  if (!clean(input.name)) return { ok: false, error: "a service needs a name" };
  if (!isAdmin(w) && priceFields.some((k) => input[k] !== undefined && input[k] !== null)) return { ok: false, error: "only the owner or an admin sets prices; add it without one" };
  const v = await values(w, input);
  if (typeof v === "string") return { ok: false, error: v };
  const all = [...(await listServices(w.workspaceId)), ...(await listServices(w.workspaceId, { archived: true }))];
  const same = all.find((s) => s.name.toLowerCase() === v.name!.toLowerCase());
  if (input.private && !isAdmin(w)) return { ok: false, error: "only the owner or an admin can make a service private" };
  if (same?.private && !seesPrivate(w)) return { ok: false, error: "the owner or an admin already keeps a service like that; ask them" };
  if (same && !input.force) return { ok: false,
      match: matchOf(same), error: same.archivedAt ? `${same.name} is archived; ${say(w, "bring it back from the archived services", `emplio services restore ${same.slug}`)}` : `there's ${same.name} already${say(w, "", ` (emplio services show ${same.slug})`)}` };
  const slug = freeSlug(v.name!, all.map((s) => s.slug), "service");
  const fieldList = await listFields(w.workspaceId, "service");
  const id = await db.transaction(async (tx) => {
    const d = await nextDetails(tx, w, "service", fieldList, {}, input.details ?? {});
    if ("error" in d) return { error: d.error! };
    const [row] = await tx.insert(services).values({ ...v, workspaceId: w.workspaceId, slug, name: v.name!, details: d.details, private: !!input.private }).returning();
    await logChange(tx, w, { kind: "service", id: row!.id, clientId: null, summary: `Added service ${v.name}`, changes: [...diff(null, v), ...detailChanges(fieldList, null, d.details)] });
    return row!.id;
  });
  if (typeof id === "object") return { ok: false, error: id.error };
  return { ok: true, service: await one(w.workspaceId, id) };
}

export async function updateService(w: Who, q: string, input: ServiceInput, exact = false): Promise<Result> {
  if (!isAdmin(w) && Object.keys(input).some((k) => k !== "updatedAt")) return { ok: false, error: "only the owner or an admin changes a service" };
  const s = await findService(w, q, exact);
  if (typeof s === "string") return { ok: false, error: s };
  const v = await values(w, input);
  if (typeof v === "string") return { ok: false, error: v };
  const fieldList = await listFields(w.workspaceId, "service");
  const err = await db.transaction(async (tx) => {
    const [row] = await tx.select().from(services).where(eq(services.id, s.id)).for("update");
    const late = await stale(row!, input.updatedAt, s.name, "service", w);
    if (late) return late;
    const d = input.details ? await nextDetails(tx, w, "service", fieldList, row!.details, input.details) : { details: row!.details };
    if ("error" in d) return d.error!;
    const changes = [...detailChanges(fieldList, row!.details, d.details), ...diff({ ...row!, amount: row!.amount === null ? null : String(Number(row!.amount)) }, { ...v, ...(v.amount !== undefined && { amount: v.amount === null ? null : String(Number(v.amount)) }) }, { amount: "price", period: "price period" })];
    if (!changes.length) return null;
    await tx.update(services).set({ ...v, details: d.details, updatedAt: new Date() }).where(eq(services.id, s.id));
    await logChange(tx, w, { kind: "service", id: s.id, clientId: null, summary: `Changed ${changes.map((c) => c.field).join(", ")} of ${s.name}`, changes });
    return null;
  });
  if (err) return { ok: false, error: err };
  if (input.private !== undefined && input.private !== s.private) {
    const e = await setPrivate(w, "service", s.id, input.private);
    if (e) return { ok: false, error: e };
  }
  return { ok: true, service: await one(w.workspaceId, s.id) };
}

// Archived: no new projects of it; its projects keep it
export async function archiveService(w: Who, q: string, archive: boolean, exact = false): Promise<Result> {
  if (!isAdmin(w)) return { ok: false, error: "only the owner or an admin archives a service" };
  const s = await findService(w, q, exact, !archive);
  if (typeof s === "string") return { ok: false, error: s };
  await db.transaction(async (tx) => {
    await tx.update(services).set({ archivedAt: archive ? new Date() : null, updatedAt: new Date() }).where(eq(services.id, s.id));
    await logChange(tx, w, { kind: "service", id: s.id, clientId: null, summary: `${archive ? "Archived" : "Brought back"} ${s.name}`, changes: [{ field: "archived", from: !archive, to: archive }] });
  });
  return { ok: true, service: await one(w.workspaceId, s.id, archive) };
}

export async function purgeService(w: Who, slug: string) {
  if (w.role !== "owner") return { ok: false as const, error: "only the owner can delete a service for good" };
  const s = await findService(w.workspaceId, slug, true, true);
  if (typeof s === "string") return { ok: false as const, error: "archive it first" };
  const [{ n }] = (await db.select({ n: sql<number>`count(*)`.mapWith(Number) }).from(projects).where(eq(projects.serviceId, s.id))) as [{ n: number }];
  if (n) return { ok: false as const, error: `${n} project${n === 1 ? "" : "s"} ${n === 1 ? "is" : "are"} of ${s.name}; it stays archived` };
  return purging(s.name, () =>
    db.transaction(async (tx) => {
      await tx.delete(services).where(eq(services.id, s.id));
      await logChange(tx, w, { kind: "service", id: s.id, clientId: null, summary: `Deleted ${s.name} for good`, changes: [] });
    }),
  );
}

// --- `emplio services` ---

export const USAGE = `usage: emplio services list [--archived]          what the business sells, and its price
       emplio services show <name>
       emplio services add <name> [options]
       emplio services update <name> [options]          only what you name changes (owner and admins)
       emplio services archive <name> | restore <name>  (owner and admins)
       emplio services fields list|add|update|remove   this business's service fields (owner and admins change them)
options: --amount <amount>     the price: 18000, "18,000", 18k (and 1.5L, 2Cr in INR); "none" clears it
         --period once|monthly|yearly|hourly
         --note <text>         about the price: "+ GST", "80 h/month"
         --process <name>      the process a project of it runs (emplio processes list); "none" clears it
         --name <new name>     update only; its slug stays
         --private yes|no      owners and admins only see it
         "Field=value"         one of the business's service fields: "SAC code=998231"; "Field=" empties it
Services live in the database: change them only with this command.`;

const priceOf = (s: Pick<Service, "amount" | "currency" | "period" | "priceNote">) => [money(s.amount, s.currency, s.period), s.priceNote].filter(Boolean).join(" ") || "no price set";
const line = (s: Service) => [s.slug, s.name, priceOf(s), s.process ? `runs ${s.process}` : "", `${s.activeProjects} active`].join("\t");

export async function servicesCommand(base: Omit<Who, "via" | "conversationId">, conversationId: string, args: string[], data = false): Promise<string> {
  const w: Who = { ...base, via: "emplio", conversationId };
  const [sub, ...rest] = args;
  if (sub === "fields") return fieldsCommand(w, "service", rest);
  const { words, opts, flags, pairs } = parseArgs(rest);
  const name = words.join(" ");
  const none = (v: string | undefined) => (v === undefined ? undefined : v.trim().toLowerCase() === "none" ? null : v);
  const input = (): ServiceInput => {
    const i: ServiceInput = {};
    if (pairs.length) i.details = Object.fromEntries(pairs);
    if (opts.name !== undefined) i.name = opts.name;
    if (opts.amount !== undefined) i.amount = none(opts.amount);
    if (opts.period !== undefined) i.period = (none(opts.period) === null ? null : periodOf(opts.period)) as MoneyPeriod | null;
    if (opts.note !== undefined) i.priceNote = none(opts.note);
    if (opts.process !== undefined) i.process = none(opts.process);
    if (opts["updated-at"]) i.updatedAt = opts["updated-at"];
    const priv = privateOf(opts, flags);
    if (priv !== undefined) i.private = priv;
    return i;
  };
  if (sub === "list") {
    const list = await listServices(w, { archived: flags.has("archived") });
    if (data) return JSON.stringify(list);
    return list.length ? list.map(line).join("\n") : "No services yet. Add what the business sells with emplio services add <name> --amount <price> --period monthly.";
  }
  if (sub === "show" && name) {
    const s = await findService(w, name);
    if (typeof s === "string") return `error: ${s}`;
    if (data) return JSON.stringify(s);
    const history = await historyOf(w.workspaceId, { kind: "service", id: s.id }, 8);
    return [`${s.name} (${s.slug})${s.private ? " · PRIVATE (owners and admins only)" : ""}${s.archivedAt ? " · ARCHIVED" : ""} · updatedAt ${s.updatedAt}`, `price: ${priceOf(s)}`, `process: ${s.process ?? "none"}`, ...s.details.map((d) => `${d.name}: ${d.value}`), `active projects: ${s.activeProjects} (emplio projects list --service ${s.slug})`, ...history.map((h) => `- ${h.at.slice(0, 10)} ${h.who ?? "Emplio"}: ${h.summary}`)].join("\n");
  }
  if (sub === "add" && name) {
    const r = await addService(w, { ...input(), name, force: flags.has("force") });
    return r.ok ? `added ${line(r.service)}` : `error: ${r.error}`;
  }
  if (sub === "update" && name) {
    const i = input();
    if (!Object.keys(i).filter((k) => k !== "updatedAt").length) return USAGE;
    if ((i.amount !== undefined || i.period !== undefined || i.priceNote !== undefined) && !i.updatedAt)
      return `error: a price change needs --updated-at (the updatedAt from emplio services show ${name}), so a newer change isn't overwritten`;
    const r = await updateService(w, name, i);
    return r.ok ? `updated ${line(r.service)}` : `error: ${r.error}`;
  }
  if ((sub === "archive" || sub === "remove" || sub === "restore") && name) {
    const r = await archiveService(w, name, sub !== "restore");
    return r.ok ? `${sub === "restore" ? "brought back" : "archived"} ${r.service.name}` : `error: ${r.error}`;
  }
  return USAGE;
}

const BODY = {
  type: "object",
  additionalProperties: false,
  properties: {
    name: { type: "string", maxLength: 200 },
    amount: { anyOf: [{ type: "number" }, { type: "string", maxLength: 40 }, { type: "null" }] },
    period: { type: ["string", "null"] },
    priceNote: { type: ["string", "null"], maxLength: 200 },
    private: { type: "boolean" },
    details: { type: "object", maxProperties: 50, additionalProperties: { type: ["string", "null"], maxLength: 500 } },
    process: { type: ["string", "null"], maxLength: 100 },
    updatedAt: { type: "string", maxLength: 40 },
    force: { type: "boolean" },
  },
};

export async function serviceRoutes(app: FastifyInstance) {
  app.get<{ Querystring: { archived?: string } }>("/services", async (req, reply) => {
    const ctx = await context(req, reply);
    if (!ctx) return;
    return listServices(ctx, { archived: req.query.archived === "1" });
  });
  app.get<{ Params: { slug: string } }>("/services/:slug", async (req, reply) => {
    const ctx = await context(req, reply);
    if (!ctx) return;
    const live = await findService(ctx, req.params.slug, true);
    const s = typeof live === "string" ? await findService(ctx, req.params.slug, true, true) : live;
    if (typeof s === "string") return reply.code(404).send({ error: "No such service." });
    return { service: s, history: await historyOf(ctx.workspaceId, { kind: "service", id: s.id }) };
  });
  app.post<{ Body: ServiceInput & { force?: boolean } }>("/services", { schema: { body: { ...BODY, required: ["name"] } } }, async (req, reply) => {
    const ctx = await context(req, reply);
    if (!ctx) return;
    const r = await addService(ctx, req.body);
    return r.ok ? r.service : reply.code(400).send({ error: r.error, match: r.match });
  });
  app.patch<{ Params: { slug: string }; Body: ServiceInput }>("/services/:slug", { schema: { body: BODY } }, async (req, reply) => {
    const ctx = await context(req, reply);
    if (!ctx) return;
    const r = await updateService(ctx, req.params.slug, req.body, true);
    return r.ok ? r.service : reply.code(400).send({ error: r.error, match: r.match });
  });
  for (const [path, archive] of [["archive", true], ["restore", false]] as const)
    app.post<{ Params: { slug: string } }>(`/services/:slug/${path}`, async (req, reply) => {
      const ctx = await context(req, reply);
      if (!ctx) return;
      const r = await archiveService(ctx, req.params.slug, archive, true);
      return r.ok ? r.service : reply.code(400).send({ error: r.error, match: r.match });
    });
  app.delete<{ Params: { slug: string } }>("/services/:slug", async (req, reply) => {
    const ctx = await context(req, reply);
    if (!ctx) return;
    const r = await purgeService(ctx, req.params.slug);
    return r.ok ? r : reply.code(400).send({ error: r.error });
  });
}
