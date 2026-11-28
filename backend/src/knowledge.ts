// The Knowledge page: the notes (.md files) and the other text files (tools, scripts, lists) in the business's git
// repos, to read in the app. Everyone sees the
// company's and their own; owners and admins also see restricted/. Read only: changes go through the AI employee,
// so they're made (and, for staff on company files, proposed) the way the rest of its files are. Staff also see
// the owners' files shared with them ("Shared with me": private.ts sharedWith).
import type { BrainGraph, KnowledgeFolder } from "@emplio/shared";
import type { FastifyInstance } from "fastify";
import { and, eq, sql } from "drizzle-orm";
import { type Ctx, context } from "./auth";
import { db } from "./db";
import { fileIndex, workspaceMembers } from "./db/schema";
import { searchFiles } from "./file-index";
import { listPaths, readFile } from "./gitea";

const foldersFor = (ctx: Ctx): KnowledgeFolder[] => [
  { repo: "company", label: "Company", files: [] },
  ...(ctx.role !== "member" ? [{ repo: "restricted", label: "Restricted", files: [] }] : []),
  { repo: `me-${ctx.userId}`, label: "Mine", files: [] },
];

// a file's path: folders and a name of plain characters, ending in a text kind; Python's cache folders left out
const PATH = /^(?:[\w .-]+\/)*[\w .-]+\.(md|txt|py|js|ts|sh|json|jsonl|csv|tsv|ya?ml|toml|sql)$/;
const shown = (path: string) => PATH.test(path) && !path.split("/").some((p) => p === "__pycache__" || p.startsWith("."));

// the owners' files a team member may read (private.ts sharedWith: their private clients' notes and the like), as their
// "Shared with me"; owners and admins see restricted/ whole. A path test per repo; true: all of it
async function readable(ctx: Ctx): Promise<(repo: string, path: string) => boolean> {
  if (ctx.role !== "member") return (repo) => foldersFor(ctx).some((f) => f.repo === repo);
  const { sharedWith } = await import("./private");
  const { test } = await sharedWith(ctx.workspaceId, ctx.userId);
  return (repo, path) => (repo === "restricted" ? test(path) : foldersFor(ctx).some((f) => f.repo === repo));
}
const sharedFolder = (ctx: Ctx): KnowledgeFolder[] => (ctx.role === "member" ? [{ repo: "restricted", label: "Shared with me", files: [] }] : []);

export async function knowledgeRoutes(app: FastifyInstance) {
  app.get("/knowledge", async (req, reply) => {
    const ctx = await context(req, reply);
    if (!ctx) return;
    const may = await readable(ctx);
    const folders = await Promise.all(
      [...foldersFor(ctx), ...sharedFolder(ctx)].map(async (f): Promise<KnowledgeFolder> => ({
        ...f,
        files: (await listPaths(ctx.workspaceId, f.repo)).filter((p) => shown(p.path) && may(f.repo, p.path)).map((p) => p.path).sort(),
      })),
    );
    // "Shared with me" only when something is
    return folders.filter((f) => f.label !== "Shared with me" || f.files.length);
  });

  // notes with these words in them, best first, each once with its first matching line
  app.get<{ Querystring: { q?: string } }>("/knowledge/search", async (req, reply) => {
    const ctx = await context(req, reply);
    if (!ctx) return;
    const may = await readable(ctx);
    const hits = await searchFiles(ctx.workspaceId, [...foldersFor(ctx), ...sharedFolder(ctx)].map((f) => f.repo), (req.query.q ?? "").slice(0, 100), 100);
    const seen = new Set<string>();
    return hits.filter((h) => shown(h.path) && may(h.repo, h.path) && !seen.has(`${h.repo}/${h.path}`) && seen.add(`${h.repo}/${h.path}`)).slice(0, 30)
      .map((h) => ({ repo: h.repo, path: h.path, line: h.text.trim().slice(0, 160) }));
  });

  app.get<{ Querystring: { repo: string; path: string } }>("/knowledge/file", async (req, reply) => {
    const ctx = await context(req, reply);
    if (!ctx) return;
    const { repo, path } = req.query;
    if (!(await readable(ctx))(repo, path ?? "")) return reply.code(400).send({ error: "No such folder." });
    if (!shown(path ?? "") || path.split("/").some((p) => p.trim() === "")) return reply.code(400).send({ error: "No such note." });
    const text = await readFile(ctx.workspaceId, repo, path);
    if (text === null) return reply.code(404).send({ error: "That note isn't there any more." });
    return { text };
  });

  // The Brain tab: every note the person can read and the [[links]] between them, without their text
  app.get("/knowledge/graph", async (req, reply) => {
    const ctx = await context(req, reply);
    if (!ctx) return;
    const g = await brainGraph(ctx.workspaceId, foldersFor(ctx).map((f) => f.repo));
    return withMeetings(ctx, g);
  });

  app.get<{ Querystring: { repo: string; path: string } }>("/knowledge/links", async (req, reply) => {
    const ctx = await context(req, reply);
    if (!ctx) return;
    const { repo, path } = req.query;
    const may = await readable(ctx);
    if (!may(repo, path ?? "") || !path?.endsWith(".md")) return reply.code(400).send({ error: "No such note." });
    return (await linkedFrom(ctx.workspaceId, repo, path)).filter((p) => may(repo, p));
  });
}

// The notes in the same folder that link to this one: [[knowledge/pricing]] for knowledge/pricing.md,
// [[clients/northwind]] (or a note in it, [[clients/northwind/decisions]]) for clients/northwind/index.md.
// ponytail: read from the search copy, so a link written in this reply shows once it's saved
export async function linkedFrom(workspaceId: string, repo: string, path: string) {
  const to = `[[${path.replace(/(\/index)?\.md$/, "")}`;
  const rows = await db.select({ path: fileIndex.path }).from(fileIndex).where(
    and(eq(fileIndex.workspaceId, workspaceId), eq(fileIndex.repo, repo), sql`(strpos(${fileIndex.text}, ${to + "]]"}) > 0 or strpos(${fileIndex.text}, ${to + "/"}) > 0)`),
  );
  return rows.map((r) => r.path).filter((p) => p !== path && shown(p)).sort();
}
// A client's, contact's, teammate's, service's or project's own page (clients/northwind/index.md) is that record's
// dot (id clients/northwind), so the Brain joins it with the record from the database; a note in its folder hangs off it
const RECORD_KINDS = new Set(["clients", "contacts", "team", "services", "projects"]);
const recordOf = (repo: string, path: string) => {
  const m = /^([a-z]+)\/([^/]+)\/(.+)$/.exec(path);
  return m && RECORD_KINDS.has(m[1]!) && (repo === "company" || repo === "restricted") ? { id: `${m[1]}/${m[2]}`, own: m[3] === "index.md" } : null;
};
// [[clients/northwind]] and [[knowledge/pricing]], as the notes write them (knowledge-page.tsx LINK)
const LINK_SQL = "\\[\\[([a-z0-9][a-z0-9-]*(?:/[a-z0-9][a-z0-9-]*)+)\\]\\]";

// ponytail: read from the search copy (one query, links pulled out in Postgres); a note saved this second shows on the next load
export async function brainGraph(workspaceId: string, repos: string[]): Promise<BrainGraph> {
  const { rows } = await db.execute<{ repo: string; path: string; title: string | null; links: string[] }>(sql`
    select repo, path, substring(text from '(?n)^#[[:space:]]+(.+)$') as title,
      array(select distinct m[1] from regexp_matches(text, ${LINK_SQL}, 'g') as m) as links
    from ${fileIndex} where workspace_id = ${workspaceId} and repo in (${sql.join(repos.map((r) => sql`${r}`), sql`, `)}) and path like '%.md'`);
  return linkGraph(rows);
}

// a meeting's dot joined to its client, project, contacts and teammates from its record, not only the [[links]] its
// notes happen to have; meetings this person may not see aren't listed, and ones without a dot here get none
async function withMeetings(ctx: Ctx, g: BrainGraph): Promise<BrainGraph> {
  const { listMeetings } = await import("./meetings");
  const [ms, team] = await Promise.all([
    listMeetings({ workspaceId: ctx.workspaceId, userId: ctx.userId, role: ctx.role }, {}),
    db.select({ id: workspaceMembers.userId, slug: workspaceMembers.slug }).from(workspaceMembers).where(eq(workspaceMembers.workspaceId, ctx.workspaceId)),
  ]);
  const slugOf = new Map(team.map((t) => [t.id, t.slug]));
  const ids = new Set(g.nodes.map((n) => n.id));
  const have = new Set(g.edges.map(([a, b]) => `${a} ${b}`));
  const edges = [...g.edges];
  for (const m of ms) {
    if (!ids.has(m.path)) continue;
    const to = [m.client && `clients/${m.client.slug}`, m.project && `projects/${m.project.slug}`, ...m.contacts.map((c) => `contacts/${c.slug}`), ...m.team.map((t) => slugOf.get(t.id) && `team/${slugOf.get(t.id)}`)];
    for (const t of to) if (t && !have.has(`${m.path} ${t}`) && !have.has(`${t} ${m.path}`)) (have.add(`${m.path} ${t}`), edges.push([m.path, t]));
  }
  return { nodes: g.nodes, edges };
}

// the notes as dots and their [[links]] as lines (brainGraph's rows: each note's path, first heading and links)
export function linkGraph(rows: { repo: string; path: string; title: string | null; links: string[] | null }[]): BrainGraph {
  const notes = rows.filter((r) => shown(r.path));
  const idOf = (repo: string, path: string) => (recordOf(repo, path)?.own ? recordOf(repo, path)!.id : `${repo}/${path}`);
  const have = new Set(notes.map((n) => `${n.repo}/${n.path}`));
  // where a link goes: a record's in the company's (or, private, restricted) files; anything else in the note's own repo
  const target = (from: string, link: string) => {
    const kind = link.split("/")[0]!;
    if (RECORD_KINDS.has(kind) && link.split("/").length === 2) return link;
    for (const repo of RECORD_KINDS.has(kind) ? ["company", "restricted"] : [from])
      for (const path of [`${link}.md`, `${link}/index.md`]) if (have.has(`${repo}/${path}`)) return idOf(repo, path);
    return RECORD_KINDS.has(kind) ? null : `${from}/${link}.md`;
  };
  const nodes: BrainGraph["nodes"] = notes.map((n) => ({ id: idOf(n.repo, n.path), repo: n.repo, path: n.path, title: n.title?.trim().slice(0, 120) || null }));
  const edges = new Map<string, [string, string]>();
  const join = (a: string, b: string) => a !== b && edges.set(a < b ? `${a} ${b}` : `${b} ${a}`, [a, b]);
  for (const n of notes) {
    const from = idOf(n.repo, n.path);
    for (const l of n.links ?? []) {
      const to = target(n.repo, l);
      if (to) join(from, to);
    }
    const rec = recordOf(n.repo, n.path);
    if (rec && !rec.own) join(from, rec.id);
  }
  return { nodes, edges: [...edges.values()] };
}
