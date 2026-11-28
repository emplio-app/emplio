// Moves clients, contacts, services, projects and team facts out of the YAML tops of company/<kind>/<slug>/index.md
// into their tables (records.ts), and points tasks, process runs and chats at the client ids. Per business; safe to
// run again (a slug already there is left as it is).
//   bun scripts/files-to-records.ts                  dry run (the default): what would move, and what wouldn't
//   bun scripts/files-to-records.ts --apply          move it; each file keeps its words, its leftover facts under "## Facts"
//   bun scripts/files-to-records.ts --apply --keep-files   rows only, files untouched (a database copy sharing a git server)
//   bun scripts/files-to-records.ts --reconcile [--keep-files]   "clean" per business, or what's still missing
//   --workspace <id>                                 one business only
// Nobody is invited and no email is sent: people in team files who aren't members are listed for the owner.
import { and, eq, isNotNull, isNull, sql } from "drizzle-orm";
import { parse } from "yaml";
import { db } from "../src/db";
import { clientFields, clientHandlers, clients, clientStages, contactClients, contacts, conversations, fileIndex, processRuns, projects, services, tasks, workspaceMembers, workspaces } from "../src/db/schema";
import { detailKey, listStages } from "../src/clients";
import { syncFiles } from "../src/file-index";
import { listPaths, readFile, UPKEEP, writeFiles } from "../src/gitea";
import { clean, logChange, parseAmount, type Who } from "../src/records";
import { listTeam } from "../src/team";
import type { StageCategory } from "@emplio/shared";

const TOP = /^---\r?\n(?:([\s\S]*?)\r?\n)?---[ \t]*(?:\r?\n|$)/;
const FILE = /^(clients|contacts|team|services|projects)\/([a-z0-9][a-z0-9-]*)\/index\.md$/;
const LINK = /\[\[([a-z]+)\/([a-z0-9][a-z0-9-]*)\]\]/;
const args = process.argv.slice(2);
const mode = args.includes("--reconcile") ? "reconcile" : args.includes("--apply") ? "apply" : "dry";
const keepFiles = args.includes("--keep-files");
const only = args.includes("--workspace") ? args[args.indexOf("--workspace") + 1] : null;

// broken: a facts block at its top that isn't readable YAML; such a file is left alone and reported
type Page = { kind: string; slug: string; path: string; facts: Record<string, unknown>; body: string; text: string; broken: boolean };
const words = (slug: string) => slug.split("-").map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
// a list as "a, b"; a nested map as JSON, never "[object Object]"
const str = (v: unknown): string =>
  (v === null || v === undefined ? "" : Array.isArray(v) ? v.map(str).join(", ") : v instanceof Date ? v.toISOString().slice(0, 10) : typeof v === "object" ? JSON.stringify(v) : String(v)).trim();
// what a client field holds (the app takes up to 500 characters); a longer one stays in the file's words
const FIELD_MAX = 500;
const links = (v: unknown, kind: string) => (Array.isArray(v) ? v : [v]).flatMap((x) => {
  const m = LINK.exec(str(x));
  return m && m[1] === kind ? [m[2]!] : [];
});
const categoryOf = (stage: string): StageCategory =>
  /^(prospect|lead|pitch|proposal|pipeline|negotiation|not won|enquiry|inquiry)/i.test(stage) ? "prospect" : /^(past|lost|former|churned|ended|closed|inactive|archived|dropped)/i.test(stage) ? "past" : "active";
const STATUS: Record<string, "active" | "on_hold" | "done" | "cancelled"> = { active: "active", ongoing: "active", "in progress": "active", live: "active", "on hold": "on_hold", paused: "on_hold", hold: "on_hold", done: "done", finished: "done", complete: "done", completed: "done", delivered: "done", cancelled: "cancelled", canceled: "cancelled", dropped: "cancelled" };
const PERIOD = (s: string) => (/(month|\/mo\b|pm\b|retainer)/i.test(s) ? "monthly" : /(year|annual|\/yr|p\.a\.)/i.test(s) ? "yearly" : /(hour|\/h\b|\/hr|per h)/i.test(s) ? "hourly" : /(flat|one[- ]?off|once|fixed|project)/i.test(s) ? "once" : null);
const date = (v: unknown) => (/^\d{4}-\d{2}-\d{2}$/.test(str(v)) ? str(v) : v instanceof Date ? v.toISOString().slice(0, 10) : null);

function read(path: string, text: string): Page | null {
  const m = FILE.exec(path);
  if (!m) return null;
  const top = TOP.exec(text);
  let facts: Record<string, unknown> = {};
  let broken = false;
  try {
    const v = top?.[1] ? parse(top[1]) : {};
    if (v && typeof v === "object" && !Array.isArray(v)) facts = Object.fromEntries(Object.entries(v).map(([k, x]) => [k.trim().toLowerCase(), Array.isArray(x) && x.length === 1 && Array.isArray(x[0]) ? `[[${x[0][0]}]]` : x]));
    else if (v !== null && v !== undefined) broken = true;
  } catch {
    broken = true;
  }
  return { kind: m[1]!, slug: m[2]!, path, facts, body: (top ? text.slice(top[0].length) : text).trim(), text, broken };
}

// The file after: its title, its words, and the facts no column took (so nothing is lost)
const rewrite = (p: Page, name: string, left: Record<string, unknown>) => {
  const body = p.body.startsWith("# ") ? p.body : `# ${name}\n\n${p.body}`.trim();
  const rest = Object.entries(left).filter(([, v]) => str(v));
  return `${body}${rest.length ? `\n\n## Facts\n\n${rest.map(([k, v]) => `- ${k}: ${str(v)}`).join("\n")}` : ""}\n`;
};

// the record files as they are in git now (not the search index, which can lag behind)
async function pagesOf(workspaceId: string) {
  const paths = (await listPaths(workspaceId, "company")).map((p) => p.path).filter((p) => FILE.test(p));
  const all = await Promise.all(
    paths.map(async (path) => {
      const text = await readFile(workspaceId, "company", path);
      if (text === null) throw new Error(`couldn't read ${path}`);
      return read(path, text);
    }),
  );
  return all.flatMap((p) => p ?? []);
}

async function one(ws: { id: string; name: string; currency: string }) {
  const parsed = await pagesOf(ws.id);
  const pages = parsed.filter((p) => !p.broken);
  const of = (kind: string) => pages.filter((p) => p.kind === kind);
  const team = await listTeam(ws.id);
  const owner = team.find((m) => m.role === "owner") ?? team[0];
  const report: string[] = parsed.filter((p) => p.broken).map((p) => `${p.path}: its facts at the top can't be read; left as it is, fix it by hand`);
  if (!owner) return [`${ws.name}: no members; skipped`];
  const who: Who = { workspaceId: ws.id, userId: owner.id, role: "owner", via: "import" };

  // team files -> members (by email, else by name)
  const teamFile = new Map<string, (typeof team)[number] | null>();
  for (const p of of("team")) {
    const email = str(p.facts.email).toLowerCase();
    const name = str(p.facts.name) || words(p.slug);
    const m = team.find((x) => email && x.email === email) ?? team.find((x) => x.name?.toLowerCase() === name.toLowerCase()) ?? null;
    teamFile.set(p.slug, m);
    if (!m) report.push(`not a member (left out, not invited): team/${p.slug} ${name}${email ? ` <${email}>` : ""}`);
  }
  const person = (slug: string) => teamFile.get(slug) ?? team.find((m) => m.name && m.name.toLowerCase().replace(/[^a-z0-9]+/g, "-") === slug) ?? null;

  const existing = async <T extends typeof clients | typeof contacts | typeof services | typeof projects>(t: T) =>
    new Map((await db.select({ slug: t.slug, id: t.id }).from(t).where(eq(t.workspaceId, ws.id))).map((r) => [r.slug, r.id]));
  const [haveClients, haveContacts, haveServices, haveProjects] = await Promise.all([existing(clients), existing(contacts), existing(services), existing(projects)]);
  const files: { path: string; content: string }[] = [];
  const counts: Record<string, number> = { clients: 0, contacts: 0, services: 0, projects: 0, team: 0 };

  // stages: the three, plus each word in use
  const stageWords = [...new Set(of("clients").map((p) => str(p.facts.stage) || "active"))];
  // client fields: every other key, its type guessed from its values
  const KEPT = ["name", "stage", "handler", "handlers"];
  const fieldKeys = [...new Set(of("clients").flatMap((p) => Object.keys(p.facts).filter((k) => !KEPT.includes(k))))].filter((k) => !/^test$/i.test(k));
  const typeOf = (k: string) => {
    const vals = of("clients").map((p) => str(p.facts[k])).filter(Boolean);
    return vals.every((v) => /^-?[\d,]+(\.\d+)?$/.test(v)) ? "number" : vals.every((v) => /^\d{4}-\d{2}-\d{2}$/.test(v)) ? "date" : "text";
  };
  if (!pages.length && !report.length) return null;
  report.push(`client fields: ${fieldKeys.map((k) => `${k} (${typeOf(k)})`).join(", ") || "none"}`);
  report.push(`stages: ${stageWords.map((s) => `${s} (${categoryOf(s)})`).join(", ")}`);
  if (of("clients").some((p) => "test" in p.facts)) report.push(`left out: a "test" field on some clients`);

  const apply = mode === "apply";
  await db.transaction(async (tx) => {
    if (apply) {
      const stages = await listStages(ws.id);
      for (const s of stageWords)
        if (!stages.some((x) => x.name.toLowerCase() === s.toLowerCase() || x.category === s.toLowerCase()))
          await tx.insert(clientStages).values({ workspaceId: ws.id, name: s.charAt(0).toUpperCase() + s.slice(1), category: categoryOf(s), position: stages.length + stageWords.indexOf(s) }).onConflictDoNothing();
      const have = new Set((await tx.select({ key: clientFields.key }).from(clientFields).where(eq(clientFields.workspaceId, ws.id))).map((f) => f.key));
      for (const [i, k] of fieldKeys.entries())
        if (!have.has(detailKey(k))) await tx.insert(clientFields).values({ workspaceId: ws.id, key: detailKey(k), name: k.charAt(0).toUpperCase() + k.slice(1), type: typeOf(k), position: have.size + i });
    }
    const stageRows = apply ? await tx.select().from(clientStages).where(eq(clientStages.workspaceId, ws.id)) : [];
    const stageId = (s: string) => (stageRows.find((x) => x.name.toLowerCase() === s.toLowerCase()) ?? stageRows.find((x) => x.category === categoryOf(s)))!.id;

    for (const p of of("clients")) {
      const name = str(p.facts.name) || /^#\s+(.+)$/m.exec(p.body)?.[1] || words(p.slug);
      const handlers = links(p.facts.handler ?? p.facts.handlers, "team").map(person);
      const lost = links(p.facts.handler ?? p.facts.handlers, "team").filter((s) => !person(s));
      if (lost.length) report.push(`clients/${p.slug}: handler not a member: ${lost.join(", ")}`);
      const long = fieldKeys.filter((k) => str(p.facts[k]).length > FIELD_MAX);
      const details = Object.fromEntries(fieldKeys.flatMap((k) => (str(p.facts[k]) && !long.includes(k) ? [[detailKey(k), typeOf(k) === "number" ? str(p.facts[k]).replace(/,/g, "") : str(p.facts[k])]] : [])));
      if (long.length) report.push(`clients/${p.slug}: ${long.join(", ")} too long for a field; kept in the file's words`);
      const ids = [...new Set(handlers.flatMap((m) => (m ? [m.id] : [])))];
      // a handler who isn't on the team yet is kept in words, for the owner to add them
      const left = Object.fromEntries(Object.entries(p.facts).filter(([k]) => !KEPT.includes(k) && (!fieldKeys.includes(k) || long.includes(k))));
      if (lost.length) left["handled by (not on the team yet)"] = lost.map(words).join(", ");
      const there = haveClients.get(p.slug);
      // added in the app since (same slug): the file's facts fill in only what it doesn't have yet, then the file is tidied
      if (there) {
        if (!Object.keys(p.facts).length) continue;
        counts.clients!++;
        if (!apply) continue;
        const [row] = await tx.select({ details: clients.details }).from(clients).where(eq(clients.id, there));
        const now = (row?.details ?? {}) as Record<string, string>;
        const add = Object.fromEntries(Object.entries(details).filter(([k]) => !now[k]));
        if (Object.keys(add).length) await tx.update(clients).set({ details: { ...now, ...add } }).where(eq(clients.id, there));
        const had = await tx.select({ userId: clientHandlers.userId }).from(clientHandlers).where(eq(clientHandlers.clientId, there));
        if (!had.length && ids.length) await tx.insert(clientHandlers).values(ids.map((userId) => ({ clientId: there, userId })));
        await logChange(tx, who, { kind: "client", id: there, clientId: there, summary: `Filled in ${name} from their file`, changes: [] });
        files.push({ path: p.path, content: rewrite(p, name, left) });
        continue;
      }
      counts.clients!++;
      if (!apply) continue;
      const [row] = await tx.insert(clients).values({ workspaceId: ws.id, slug: p.slug, name: name.slice(0, 200), stageId: stageId(str(p.facts.stage) || "active"), details }).returning();
      haveClients.set(p.slug, row!.id);
      if (ids.length) await tx.insert(clientHandlers).values(ids.map((userId) => ({ clientId: row!.id, userId })));
      await logChange(tx, who, { kind: "client", id: row!.id, clientId: row!.id, summary: `Moved ${name} from their file`, changes: [] });
      files.push({ path: p.path, content: rewrite(p, name, left) });
    }
    // in a dry run, one about to be moved counts as there
    const clientId = (slug: string) => haveClients.get(slug) ?? (!apply && of("clients").some((c) => c.slug === slug) ? "(new)" : null);

    for (const p of of("contacts")) {
      const name = str(p.facts.name) || words(p.slug);
      const at = links(p.facts.client ?? p.facts.clients, "clients");
      const missing = at.filter((s) => !clientId(s) && !of("clients").some((c) => c.slug === s));
      if (missing.length) report.push(`contacts/${p.slug}: links to no client: ${missing.join(", ")}`);
      const email = str(p.facts.email).toLowerCase() || null;
      const role = str(p.facts.role) || null;
      if (haveContacts.has(p.slug)) continue;
      counts.contacts!++;
      if (!apply) continue;
      const org = str(p.facts.org ?? p.facts.company ?? p.facts.firm) || (at.length ? null : role?.split(",").slice(1).join(",").trim() || null);
      const [row] = await tx
        .insert(contacts)
        .values({ workspaceId: ws.id, slug: p.slug, name, email, phone: str(p.facts.phone ?? p.facts.mobile) || null, title: str(p.facts.title) || null, org })
        .returning();
      const ids = at.flatMap((s) => (clientId(s) ? [clientId(s)!] : []));
      if (ids.length) await tx.insert(contactClients).values([...new Set(ids)].map((id) => ({ contactId: row!.id, clientId: id, role: role?.slice(0, 80) ?? null })));
      await logChange(tx, who, { kind: "contact", id: row!.id, clientId: ids[0] ?? null, summary: `Moved ${name} from their file`, changes: [] });
      const used = ["name", "email", "role", "client", "clients", "phone", "mobile", "title", "org", "company", "firm"];
      files.push({ path: p.path, content: rewrite(p, name, Object.fromEntries(Object.entries(p.facts).filter(([k]) => !used.includes(k)))) });
    }

    const money = (raw: string) => {
      const a = parseAmount(raw.replace(/\s*(flat|fixed|\+.*|\/.*|per .*|a month|monthly|yearly|per year|an hour)$/i, "").trim(), ws.currency);
      return typeof a === "number" ? a : null;
    };
    for (const p of of("services")) {
      const name = str(p.facts.name) || words(p.slug);
      const price = str(p.facts.price ?? p.facts.fee ?? p.facts.amount);
      const amount = price ? money(price) : null;
      if (price && amount === null) report.push(`services/${p.slug}: price "${price}" kept as a note`);
      if (haveServices.has(p.slug)) continue;
      counts.services!++;
      if (!apply) continue;
      const proc = str(p.facts.process).replace(/^\[\[processes\/(.+)\]\]$/, "$1") || null;
      const [row] = await tx
        .insert(services)
        .values({ workspaceId: ws.id, slug: p.slug, name, amount: amount === null ? null : String(amount), currency: amount === null ? null : ws.currency, period: PERIOD(`${price} ${str(p.facts.billing ?? p.facts.period)}`), priceNote: amount === null ? price || null : null, process: proc })
        .returning();
      haveServices.set(p.slug, row!.id);
      await logChange(tx, who, { kind: "service", id: row!.id, clientId: null, summary: `Moved ${name} from its file`, changes: [] });
      files.push({ path: p.path, content: rewrite(p, name, Object.fromEntries(Object.entries(p.facts).filter(([k]) => !["name", "price", "fee", "amount", "billing", "period", "process"].includes(k)))) });
    }

    for (const p of of("projects")) {
      const name = str(p.facts.name) || words(p.slug);
      const c = links(p.facts.client, "clients")[0];
      if (!c || !clientId(c)) {
        report.push(`projects/${p.slug}: no client it can belong to${c ? ` (clients/${c} isn't there)` : ""}; left as a note`);
        continue;
      }
      const s = links(p.facts.service, "services")[0];
      if (s && !haveServices.has(s) && (apply || !of("services").some((x) => x.slug === s))) report.push(`projects/${p.slug}: service ${s} isn't there; left out`);
      const lead = links(p.facts.lead, "team")[0];
      if (lead && !person(lead)) report.push(`projects/${p.slug}: lead ${lead} isn't a member; left out`);
      const fee = str(p.facts.fee ?? p.facts.price ?? p.facts.amount);
      const amount = fee ? money(fee) : null;
      if (haveProjects.has(p.slug)) continue;
      counts.projects!++;
      if (!apply) continue;
      const status = STATUS[str(p.facts.status).toLowerCase()] ?? "active";
      const [row] = await tx
        .insert(projects)
        .values({
          workspaceId: ws.id,
          slug: p.slug,
          name,
          clientId: clientId(c)!,
          serviceId: (s && haveServices.get(s)) || null,
          leadId: (lead && person(lead)?.id) || null,
          status,
          startOn: date(p.facts.start),
          dueOn: date(p.facts.due),
          amount: amount === null ? null : String(amount),
          currency: amount === null ? null : ws.currency,
          period: fee ? PERIOD(fee) : null,
          feeNote: amount === null ? fee || null : null,
          doneAt: status === "done" ? new Date() : null,
        })
        .returning();
      haveProjects.set(p.slug, row!.id);
      await logChange(tx, who, { kind: "project", id: row!.id, clientId: clientId(c), summary: `Moved ${name} from its file`, changes: [] });
      const left = Object.fromEntries(Object.entries(p.facts).filter(([k]) => !["name", "client", "service", "lead", "status", "start", "due", "fee", "price", "amount"].includes(k)));
      if (lead && !person(lead)) left["lead (not on the team yet)"] = words(lead);
      files.push({ path: p.path, content: rewrite(p, name, left) });
    }

    for (const p of of("team")) {
      const m = teamFile.get(p.slug);
      if (!m) continue;
      const role = str(p.facts.title) || (["owner", "admin", "member"].includes(str(p.facts.role).toLowerCase()) ? "" : str(p.facts.role));
      if (m.slug) continue;
      counts.team!++;
      if (!apply) continue;
      await tx.update(workspaceMembers).set({ slug: p.slug, ...(role && !m.title && { title: role.slice(0, 80) }) }).where(and(eq(workspaceMembers.workspaceId, ws.id), eq(workspaceMembers.userId, m.id)));
      files.push({ path: p.path, content: rewrite(p, m.name ?? words(p.slug), Object.fromEntries(Object.entries(p.facts).filter(([k]) => !["name", "email", "role", "title"].includes(k)))) });
    }
    // members without a team file get their slug too
    if (apply) {
      const taken = new Set((await tx.select({ slug: workspaceMembers.slug }).from(workspaceMembers).where(eq(workspaceMembers.workspaceId, ws.id))).flatMap((r) => (r.slug ? [r.slug] : [])));
      for (const m of team)
        if (!m.slug && ![...teamFile.values()].some((x) => x?.id === m.id)) {
          const base = (m.name ?? m.email.split("@")[0]!).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "teammate";
          let slug = base;
          for (let n = 2; taken.has(slug); n++) slug = `${base}-${n}`;
          taken.add(slug);
          await tx.update(workspaceMembers).set({ slug }).where(and(eq(workspaceMembers.workspaceId, ws.id), eq(workspaceMembers.userId, m.id)));
        }
    }

    // the old client text on tasks, runs and chats -> the id
    for (const t of [tasks, processRuns, conversations]) {
      const legacy = await tx
        .select({ slug: t.legacyClient, n: sql<number>`count(*)`.mapWith(Number) })
        .from(t)
        .where(and(eq(t.workspaceId, ws.id), isNotNull(t.legacyClient), isNull(t.clientId)))
        .groupBy(t.legacyClient);
      for (const l of legacy) {
        const id = clientId(l.slug!);
        if (!id) {
          report.push(`${l.n} ${t === tasks ? "task" : t === processRuns ? "process run" : "chat"}${l.n === 1 ? "" : "s"} name a client "${l.slug}" that isn't there`);
          continue;
        }
        if (apply) await tx.update(t).set({ clientId: id }).where(and(eq(t.workspaceId, ws.id), eq(t.legacyClient, l.slug!)));
      }
    }
  });
  if (apply && files.length && !keepFiles) {
    await writeFiles(ws.id, "company", files, `Records moved to the app: facts out of ${files.length} file${files.length === 1 ? "" : "s"}, the words kept`, UPKEEP);
    await syncFiles(ws.id, "company");
  }
  return [`${ws.name}: ${Object.entries(counts).map(([k, n]) => `${n} ${k}`).join(", ")}${apply ? (keepFiles ? " moved (files untouched)" : ` moved, ${files.length} files rewritten`) : " to move"}`, ...report.map((r) => `  - ${r}`)];
}

async function reconcile(ws: { id: string; name: string }) {
  const problems: string[] = [];
  for (const [t, what] of [[tasks, "tasks"], [processRuns, "process runs"], [conversations, "chats"]] as const) {
    const [r] = await db.select({ n: sql<number>`count(*)`.mapWith(Number) }).from(t).where(and(eq(t.workspaceId, ws.id), isNotNull(t.legacyClient), isNull(t.clientId)));
    if (r!.n) problems.push(`${r!.n} ${what} still name a client only by text`);
  }
  for (const p of await pagesOf(ws.id)) {
    if (p.broken) {
      problems.push(`${p.path}: its facts at the top can't be read`);
      continue;
    }
    const t = { clients, contacts, services, projects }[p.kind as "clients"];
    if (t) {
      const [hit] = await db.select({ id: t.id }).from(t).where(and(eq(t.workspaceId, ws.id), eq(t.slug, p.slug)));
      if (!hit && !(p.kind === "projects" && !links(p.facts.client, "clients").length)) problems.push(`${p.path} has no row`);
    }
    if (!keepFiles && TOP.test(p.text) && Object.keys(p.facts).length) problems.push(`${p.path} still has facts at its top`);
  }
  return problems.length ? [`${ws.name}:`, ...problems.map((x) => `  - ${x}`)] : [`${ws.name}: clean`];
}

const list = await db.select({ id: workspaces.id, name: workspaces.name, currency: workspaces.currency }).from(workspaces).where(only ? eq(workspaces.id, only) : undefined);
for (const ws of list) {
  const [any] = await db.select({ p: fileIndex.path }).from(fileIndex).where(and(eq(fileIndex.workspaceId, ws.id), eq(fileIndex.repo, "company"))).limit(1);
  const [legacy] = await db.select({ n: sql<number>`count(*)`.mapWith(Number) }).from(tasks).where(and(eq(tasks.workspaceId, ws.id), isNotNull(tasks.legacyClient)));
  if (!any && !legacy!.n) continue;
  const out = mode === "reconcile" ? await reconcile(ws) : await one(ws).catch((error) => [`${ws.name}: FAILED, nothing moved: ${error instanceof Error ? error.message : error}`]);
  if (out) console.log(out.join("\n"));
}
if (mode === "dry") console.log("\nDry run: nothing changed. --apply to move it.");
process.exit(0);
