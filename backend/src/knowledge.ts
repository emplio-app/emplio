// The Knowledge page: the notes (.md files) and the other text files (tools, scripts, lists) in the business's git
// repos, to read in the app. Everyone sees the
// company's and their own; owners and admins also see restricted/. Read only: changes go through the AI employee,
// so they're made (and, for staff on company files, proposed) the way the rest of its files are.
import type { KnowledgeFolder } from "@emplio/shared";
import type { FastifyInstance } from "fastify";
import { and, eq, sql } from "drizzle-orm";
import { type Ctx, context } from "./auth";
import { db } from "./db";
import { fileIndex } from "./db/schema";
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

export async function knowledgeRoutes(app: FastifyInstance) {
  app.get("/knowledge", async (req, reply) => {
    const ctx = await context(req, reply);
    if (!ctx) return;
    return Promise.all(
      foldersFor(ctx).map(async (f): Promise<KnowledgeFolder> => ({
        ...f,
        files: (await listPaths(ctx.workspaceId, f.repo)).filter((p) => shown(p.path)).map((p) => p.path).sort(),
      })),
    );
  });

  // notes with these words in them, best first, each once with its first matching line
  app.get<{ Querystring: { q?: string } }>("/knowledge/search", async (req, reply) => {
    const ctx = await context(req, reply);
    if (!ctx) return;
    const hits = await searchFiles(ctx.workspaceId, foldersFor(ctx).map((f) => f.repo), (req.query.q ?? "").slice(0, 100), 100);
    const seen = new Set<string>();
    return hits.filter((h) => shown(h.path) && !seen.has(`${h.repo}/${h.path}`) && seen.add(`${h.repo}/${h.path}`)).slice(0, 30)
      .map((h) => ({ repo: h.repo, path: h.path, line: h.text.trim().slice(0, 160) }));
  });

  app.get<{ Querystring: { repo: string; path: string } }>("/knowledge/file", async (req, reply) => {
    const ctx = await context(req, reply);
    if (!ctx) return;
    const { repo, path } = req.query;
    if (!foldersFor(ctx).some((f) => f.repo === repo)) return reply.code(400).send({ error: "No such folder." });
    if (!shown(path ?? "") || path.split("/").some((p) => p.trim() === "")) return reply.code(400).send({ error: "No such note." });
    const text = await readFile(ctx.workspaceId, repo, path);
    if (text === null) return reply.code(404).send({ error: "That note isn't there any more." });
    return { text };
  });

  app.get<{ Querystring: { repo: string; path: string } }>("/knowledge/links", async (req, reply) => {
    const ctx = await context(req, reply);
    if (!ctx) return;
    const { repo, path } = req.query;
    if (!foldersFor(ctx).some((f) => f.repo === repo) || !path?.endsWith(".md")) return reply.code(400).send({ error: "No such note." });
    return linkedFrom(ctx.workspaceId, repo, path);
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
