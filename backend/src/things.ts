// Things kept as folders in company/, one folder per kind and one folder per thing: clients/ (a client: name, stage,
// handler and details at the top, their notes below; clients.ts), contacts/ (someone at a client), team/ (someone on
// the team: role, skills, hours), services/ (what the business sells), projects/ (one client buying one service).
// A thing's main page is <kind>/<slug>/index.md; other files beside it (decisions.md, meeting notes) are plain notes.
// Kinds stay side by side, never inside a client: a contact for two clients, or a project that moves, breaks nothing.
// A page starts with YAML between --- lines, flat as Obsidian's properties (text, number, true/false, a YYYY-MM-DD date
// or a list of those), then words. A link is [[clients/northwind]] (that folder's index.md) or
// [[clients/northwind/decisions]] (a note in it), quoted in the YAML; written once, in one of the two files: the way
// back is worked out here, so a client's page lists the contacts and projects that name it. A page that breaks a rule
// is still read (what could be), with its problems listed: Emplio fixes them, nothing is refused.
// ponytail: parsed from the search copy (file_index) on every call; a table of its own when lists get long. That copy
// follows every commit (gitea.ts indexLater), so it's read as it is; only a repo never indexed is filled first.
import { and, eq, inArray, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { isMap, isSeq, LineCounter, parseDocument, type Node } from "yaml";
import { STAGE_RULE, THING_KINDS, type Thing, type ThingKind, type ThingPage, type ThingProblem } from "@emplio/shared";
import { context } from "./auth";
import { db } from "./db";
import { fileIndex, processRuns, tasks } from "./db/schema";
import { syncFiles } from "./file-index";
import { linkedFrom } from "./knowledge";

const FILE = new RegExp(`^(${THING_KINDS.join("|")})/([a-z0-9][a-z0-9-]*)/index\\.md$`);
const LINK = /\[\[([a-z]+\/[a-z0-9][a-z0-9-]*(?:\/[a-z0-9][a-z0-9-]*)?)\]\]/g;
export const TOP = /^---\r?\n(?:([\s\S]*?)\r?\n)?---[ \t]*(?:\r?\n|$)/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
// the few fields the app reads, and what they must be
const BUILT_IN: Record<string, (v: unknown, kind: ThingKind) => string | null> = {
  stage: (v, kind) => (kind !== "clients" || STAGE_RULE.test(String(v)) ? null : "stage is a word or two in lowercase: prospect, active, past, or the business's own (onboarding, on hold)"),
  due: (v) => (typeof v === "string" && DATE.test(v) ? null : "due is a date: YYYY-MM-DD"),
  start: (v) => (typeof v === "string" && DATE.test(v) ? null : "start is a date: YYYY-MM-DD"),
};

// "sarah-lee" -> "Sarah Lee"
export const words = (name: string) => name.split("-").map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
export const thingFile = (path: string) => `${path}/index.md`;

// a value's type, as Obsidian names them; a link is text
const typeOf = (v: unknown) => (Array.isArray(v) ? "list" : typeof v === "number" ? "number" : typeof v === "boolean" ? "checkbox" : DATE.test(String(v)) ? "date" : "text");
// [[x]] left unquoted is a list in a list to YAML: read back as the link it was meant to be
const unquoted = (v: unknown) => Array.isArray(v) && v.length === 1 && Array.isArray(v[0]) && v[0].length === 1 && typeof v[0][0] === "string";
const asLink = (v: unknown) => (unquoted(v) ? `[[${(v as string[][])[0]![0]}]]` : v);

// The YAML at the top of a file, read (keys lowercase), with what's wrong in it and the line of each key (the file's
// line numbers: the --- line is 1). Used for any file with a top, things or not.
export function readTop(text: string) {
  const top = TOP.exec(text);
  const values: Record<string, unknown> = {};
  const lines: Record<string, number> = {};
  const problems: ThingProblem[] = [];
  if (!top) return { values, lines, problems, top };
  const counter = new LineCounter();
  const doc = parseDocument(top[1] ?? "", { lineCounter: counter });
  const at = (n?: Node | null) => (n?.range ? counter.linePos(n.range[0]).line + 1 : null);
  for (const e of doc.errors) problems.push({ line: (e.linePos?.[0].line ?? 0) + 1, text: e.message.split("\n")[0]!.replace(/ at line \d+, column \d+:?$/, "") });
  if (problems.length) return { values, lines, problems, top };
  if (doc.contents && !isMap(doc.contents)) return { values, lines, problems: [{ line: 2, text: "the top is key: value lines" }], top };
  for (const pair of isMap(doc.contents) ? doc.contents.items : []) {
    const key = String((pair.key as { value?: unknown })?.value ?? pair.key).trim().toLowerCase();
    const node = pair.value as Node | null;
    const line = at(pair.key as Node) ?? 2;
    lines[key] = line;
    const v = node?.toJSON();
    const items = isSeq(node) ? node.items : [node];
    if (isMap(node) || items.some((i) => isMap(i))) {
      problems.push({ line, text: `${key} has fields inside it; keep it flat: one value or a list` });
      continue;
    }
    if (unquoted(v)) problems.push({ line, text: `put links in quotes: "${asLink(v)}"` });
    else
      for (const [i, item] of items.entries()) {
        const one = isSeq(node) ? (v as unknown[])[i] : v;
        if (unquoted(one)) problems.push({ line: at(item as Node) ?? line, text: `put links in quotes: "${asLink(one)}"` });
        else if (Array.isArray(one)) problems.push({ line: at(item as Node) ?? line, text: `${key} has a list inside a list; keep it to one list` });
      }
    if (v === null || v === undefined || v === "") continue;
    values[key] = Array.isArray(v) && !unquoted(v) ? v.map(asLink) : asLink(v);
  }
  return { values, lines, problems, top };
}

// A thing's page, read; null for any other file. types and lines: each field's, for the checks across files.
export function parseThing(file: string, text: string): (Thing & { types: Record<string, string>; lines: Record<string, number> }) | null {
  const m = FILE.exec(file);
  if (!m) return null;
  const kind = m[1] as ThingKind;
  const { values, lines, problems, top } = readTop(text);
  const fields: Record<string, string> = {};
  const types: Record<string, string> = {};
  for (const [k, v] of Object.entries(values)) {
    types[k] = typeOf(v);
    fields[k] = Array.isArray(v) ? v.map(String).join(", ") : String(v);
    const wrong = BUILT_IN[k]?.(v, kind);
    if (wrong) problems.push({ line: lines[k]!, text: wrong });
  }
  const body = (top ? text.slice(top[0].length) : text).trim();
  const links = [
    ...Object.entries(fields).flatMap(([field, v]) => [...v.matchAll(LINK)].map((l) => ({ field, to: l[1]! }))),
    ...[...body.matchAll(LINK)].map((l) => ({ field: "text", to: l[1]! })),
  ];
  return {
    path: file.slice(0, -"/index.md".length),
    kind,
    title: fields.name || /^#\s+(.+?)\s*$/m.exec(body)?.[1] || words(m[2]!),
    fields,
    body,
    links,
    problems,
    types,
    lines,
  };
}

// The checks that need the other files: one type per field name in a kind (the most used one; a single value is
// fine where others have a list of them), and links to a thing that isn't there (a warning: it may come later).
// ponytail: a link to a note inside a folder ([[clients/x/decisions]]) or outside the kinds (processes/) isn't checked;
// only things are read here
export function checkThings<T extends Thing & { types: Record<string, string>; lines: Record<string, number> }>(all: T[]) {
  const paths = new Set(all.map((t) => t.path));
  for (const kind of THING_KINDS) {
    const mine = all.filter((t) => t.kind === kind);
    const count = new Map<string, Map<string, number>>();
    for (const t of mine) for (const [k, type] of Object.entries(t.types)) count.set(k, (count.get(k) ?? new Map()).set(type, (count.get(k)?.get(type) ?? 0) + 1));
    for (const t of mine)
      for (const [k, type] of Object.entries(t.types)) {
        // Map keeps the first use first: a tie goes to it
        const main = [...count.get(k)!].reduce((a, b) => (b[1] > a[1] ? b : a))[0];
        if (type !== main && !(main === "list" && type === "text"))
          t.problems.push({ line: t.lines[k] ?? null, text: `${k} is a ${type} here but a ${main} in other ${kind} files; use one type` });
      }
  }
  for (const t of all)
    for (const l of t.links)
      if (l.to.split("/").length === 2 && THING_KINDS.includes(l.to.split("/")[0] as ThingKind) && !paths.has(l.to)) t.problems.push({ line: t.lines[l.field] ?? null, text: `[[${l.to}]] links to nothing yet`, warning: true });
  return all;
}

export async function listThings(workspaceId: string, kind?: ThingKind): Promise<Thing[]> {
  const indexed = await db.select({ path: fileIndex.path }).from(fileIndex).where(and(eq(fileIndex.workspaceId, workspaceId), eq(fileIndex.repo, "company"))).limit(1);
  if (!indexed.length) await syncFiles(workspaceId, "company");
  const rows = await db
    .select({ path: fileIndex.path, text: fileIndex.text })
    .from(fileIndex)
    .where(and(eq(fileIndex.workspaceId, workspaceId), eq(fileIndex.repo, "company"), sql`${fileIndex.path} ~ ${FILE.source}`));
  const all = checkThings(rows.flatMap((r) => parseThing(r.path, r.text) ?? []));
  return all
    .map(({ types: _, lines: __, ...t }) => t)
    .filter((t) => !kind || t.kind === kind)
    .sort((a, b) => a.title.localeCompare(b.title));
}

// A client's folder removed (or renamed: its old name removed) while open tasks or running processes still point at
// its name: what to do about it, a line each.
export async function removedClients(workspaceId: string, paths: string[]) {
  const slugs = paths.flatMap((p) => /^clients\/([a-z0-9][a-z0-9-]*)\/index\.md$/.exec(p)?.[1] ?? []);
  if (!slugs.length) return [];
  const count = (t: typeof tasks | typeof processRuns, open: ReturnType<typeof sql>) =>
    db.select({ client: t.client, n: sql<number>`count(*)`.mapWith(Number) }).from(t).where(and(eq(t.workspaceId, workspaceId), inArray(t.client, slugs), open)).groupBy(t.client);
  const [open, runs] = await Promise.all([count(tasks, sql`${tasks.status} in ('todo', 'doing', 'waiting')`), count(processRuns, sql`${processRuns.status} = 'active'`)]);
  return slugs.flatMap((slug) => {
    const n = open.find((r) => r.client === slug)?.n ?? 0;
    const r = runs.find((x) => x.client === slug)?.n ?? 0;
    if (!n && !r) return [];
    const what = [n && `${n} open task${n === 1 ? "" : "s"}`, r && `${r} running process${r === 1 ? "" : "es"}`].filter(Boolean).join(" and ");
    return [`company/clients/${slug} was removed but ${what} ${n + r === 1 ? "points" : "point"} at it — put it back (git -C /work/company checkout HEAD -- clients/${slug}), or if they're really gone: emplio clients remove ${slug}`];
  });
}

// What's wrong in a computer's changed thing pages (company/ paths and their text; null: removed), checked with the
// saved others, as lines for Emplio: errors only, warnings are for the app.
export async function thingProblems(workspaceId: string, changed: { path: string; text: string | null }[]) {
  const gone = await removedClients(workspaceId, changed.filter((f) => f.text === null).map((f) => f.path));
  const mine = changed.flatMap((f) => (f.text === null ? [] : (parseThing(f.path, f.text) ?? [])));
  if (!mine.length) return gone;
  const rows = await db
    .select({ path: fileIndex.path, text: fileIndex.text })
    .from(fileIndex)
    .where(and(eq(fileIndex.workspaceId, workspaceId), eq(fileIndex.repo, "company"), sql`${fileIndex.path} ~ ${FILE.source}`));
  const others = rows.filter((r) => !changed.some((f) => f.path === r.path)).flatMap((r) => parseThing(r.path, r.text) ?? []);
  checkThings([...mine, ...others]);
  return [...gone, ...mine.flatMap((t) => t.problems.filter((p) => !p.warning).map((p) => `company/${thingFile(t.path)}${p.line ? ` line ${p.line}` : ""}: ${p.text} — fix it`))];
}

// One thing (null when its file isn't there yet), with the title of each it links to (null: nothing there, a broken
// link) and everything that links to it.
export async function thingPage(workspaceId: string, path: string): Promise<ThingPage> {
  const all = await listThings(workspaceId);
  const titles = new Map(all.map((t) => [t.path, t.title]));
  const thing = all.find((t) => t.path === path) ?? null;
  // a meeting's note: 2026-11-26-northwind-kickoff.md -> 2026-11-26, "Northwind kickoff"
  const meetings = (await linkedFrom(workspaceId, "company", thingFile(path))).filter((p) => p.startsWith("meetings/")).map((p) => {
    const [, date = null, name = ""] = /^meetings\/(?:(\d{4}-\d{2}-\d{2})-?)?(.*)\.md$/.exec(p) ?? [];
    return { path: p, date, title: words(name || "meeting") };
  });
  return {
    path,
    thing,
    links: (thing?.links ?? []).map((l) => ({ ...l, title: titles.get(l.to) ?? null })),
    linkedFrom: all.flatMap((t) => t.links.filter((l) => l.to === path).map((l) => ({ field: l.field, from: t.path, kind: t.kind, title: t.title, fields: t.fields }))),
    meetings: meetings.sort((a, b) => b.path.localeCompare(a.path)),
  };
}

export async function thingsRoutes(app: FastifyInstance) {
  app.get<{ Querystring: { kind?: string } }>("/things", async (req, reply) => {
    const ctx = await context(req, reply);
    if (!ctx) return;
    const kind = req.query.kind as ThingKind | undefined;
    if (kind && !THING_KINDS.includes(kind)) return reply.code(400).send({ error: `kind is one of ${THING_KINDS.join(", ")}` });
    return listThings(ctx.workspaceId, kind);
  });
  app.get<{ Querystring: { path?: string } }>("/things/page", async (req, reply) => {
    const ctx = await context(req, reply);
    if (!ctx) return;
    const path = req.query.path ?? "";
    if (!FILE.test(thingFile(path))) return reply.code(400).send({ error: "No such thing." });
    return thingPage(ctx.workspaceId, path);
  });
}
