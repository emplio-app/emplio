// Things kept as files in company/, one folder per kind and one .md file each: clients/ (a client: name, stage,
// handler and details at the top, their notes below; clients.ts), contacts/ (someone at a client), team/ (someone
// on the team: role, skills, hours), services/ (what the business sells), projects/ (one client buying one service).
// A file starts with key: value lines between --- lines, then words. A link is another file's folder and name in
// [[ ]], like [[clients/northwind]], written once in one of the two files: the way back is worked out here, so a
// client's page lists the contacts and projects that name it. Emplio writes the files; the app reads them here.
// ponytail: parsed from the search copy (file_index) on every call; a table of its own when lists get long. That copy
// follows every commit (gitea.ts indexLater), so it's read as it is; only a repo never indexed is filled first.
import { and, eq, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { THING_KINDS, type Thing, type ThingKind, type ThingPage } from "@emplio/shared";
import { context } from "./auth";
import { db } from "./db";
import { fileIndex } from "./db/schema";
import { syncFiles } from "./file-index";

// what each kind must link to
const NEEDS: Partial<Record<ThingKind, string[]>> = { contacts: ["client"], projects: ["client"] };
const FILE = new RegExp(`^(${THING_KINDS.join("|")})/([a-z0-9][a-z0-9-]*)\\.md$`);
const LINK = /\[\[([a-z]+\/[a-z0-9][a-z0-9-]*)\]\]/g;

// "sarah-lee" -> "Sarah Lee"
export const words = (name: string) => name.split("-").map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");

// A file in one of the folders, read; null for any other file.
export function parseThing(file: string, text: string): Thing | null {
  const m = FILE.exec(file);
  if (!m) return null;
  const kind = m[1] as ThingKind;
  const top = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
  const fields: Record<string, string> = {};
  for (const line of top?.[1]?.split(/\r?\n/) ?? []) {
    const kv = /^([A-Za-z][\w -]*?)\s*:\s*(.*)$/.exec(line);
    if (kv) fields[kv[1]!.trim().toLowerCase()] = kv[2]!.trim();
  }
  const body = (top ? text.slice(top[0].length) : text).trim();
  const links = [
    ...Object.entries(fields).flatMap(([field, v]) => [...v.matchAll(LINK)].map((l) => ({ field, to: l[1]! }))),
    ...[...body.matchAll(LINK)].map((l) => ({ field: "text", to: l[1]! })),
  ];
  const missing = (NEEDS[kind] ?? []).filter((f) => !links.some((l) => l.field === f));
  return {
    path: file.slice(0, -3),
    kind,
    title: fields.name || /^#\s+(.+?)\s*$/m.exec(body)?.[1] || words(m[2]!),
    fields,
    body,
    links,
    error: missing.length ? `needs ${missing.map((f) => `${f}: [[...]]`).join(", ")}` : null,
  };
}

export async function listThings(workspaceId: string, kind?: ThingKind): Promise<Thing[]> {
  const indexed = await db.select({ path: fileIndex.path }).from(fileIndex).where(and(eq(fileIndex.workspaceId, workspaceId), eq(fileIndex.repo, "company"))).limit(1);
  if (!indexed.length) await syncFiles(workspaceId, "company");
  const rows = await db
    .select({ path: fileIndex.path, text: fileIndex.text })
    .from(fileIndex)
    .where(and(eq(fileIndex.workspaceId, workspaceId), eq(fileIndex.repo, "company"), sql`${fileIndex.path} ~ ${FILE.source}`));
  return rows.flatMap((r) => parseThing(r.path, r.text) ?? []).filter((t) => !kind || t.kind === kind).sort((a, b) => a.title.localeCompare(b.title));
}

// One thing (null when its file isn't there yet), with the title of each it links to (null: nothing there, a broken
// link) and everything that links to it.
export async function thingPage(workspaceId: string, path: string): Promise<ThingPage> {
  const all = await listThings(workspaceId);
  const titles = new Map(all.map((t) => [t.path, t.title]));
  const thing = all.find((t) => t.path === path) ?? null;
  return {
    path,
    thing,
    links: (thing?.links ?? []).map((l) => ({ ...l, title: titles.get(l.to) ?? null })),
    linkedFrom: all.flatMap((t) => t.links.filter((l) => l.to === path).map((l) => ({ field: l.field, from: t.path, kind: t.kind, title: t.title, fields: t.fields }))),
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
    if (!FILE.test(`${path}.md`)) return reply.code(400).send({ error: "No such thing." });
    return thingPage(ctx.workspaceId, path);
  });
}
