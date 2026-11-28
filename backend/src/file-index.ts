// Searching the files in git (company/, restricted/, each me/) without reading them all each time: their text
// is mirrored in file_index, brought up to date after every commit (gitea.ts), reading only the files whose
// blob sha changed; a repo never indexed is filled on its first search. Text files only (TEXT below), up to MAX_BYTES each. Who may search which repo is the
// caller's to decide. The agent's own chats search the files on their computer instead (emplio search); this is
// for what has no computer, like the chat review.
import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "./db";
import { fileIndex } from "./db/schema";
import { listPaths, readFile } from "./gitea";
import { toQuery } from "./search";

// .media: the pointer to a big file kept in storage, with its name and, for a document, its words
const TEXT = /\.(md|txt|csv|tsv|json|jsonl|ya?ml|toml|ini|html?|xml|py|js|mjs|ts|sh|sql|media)$|(^|\/)[^./]+$/i;
const MAX_BYTES = 200_000;

const syncing = new Map<string, Promise<unknown>>();
export function syncFiles(workspaceId: string, repo: string) {
  const key = `${workspaceId}/${repo}`;
  const run = (syncing.get(key) ?? Promise.resolve()).then(async () => {
    const files = (await listPaths(workspaceId, repo)).filter((f) => TEXT.test(f.path) && f.size <= MAX_BYTES);
    const rows = await db
      .select({ path: fileIndex.path, sha: fileIndex.sha })
      .from(fileIndex)
      .where(and(eq(fileIndex.workspaceId, workspaceId), eq(fileIndex.repo, repo)));
    const gone = rows.filter((r) => !files.some((f) => f.path === r.path)).map((r) => r.path);
    if (gone.length) await db.delete(fileIndex).where(and(eq(fileIndex.workspaceId, workspaceId), eq(fileIndex.repo, repo), inArray(fileIndex.path, gone)));
    for (const f of files) {
      if (rows.some((r) => r.path === f.path && r.sha === f.sha)) continue;
      const text = await readFile(workspaceId, repo, f.path);
      // a binary file under a text name: leave it out
      if (text === null || text.includes("\0")) continue;
      const values = { workspaceId, repo, path: f.path, sha: f.sha, text, updatedAt: new Date() };
      await db.insert(fileIndex).values(values).onConflictDoUpdate({ target: [fileIndex.workspaceId, fileIndex.repo, fileIndex.path], set: values });
    }
  });
  syncing.set(key, run.catch(() => {}));
  return run;
}

// Lines with every word (any case) in these repos' files. A file that matches
// as a whole but has no single line with every word gives its first line with any of them.
export async function searchFiles(workspaceId: string, repos: string[], words: string, limit = 40) {
  const query = toQuery(words);
  if (!query || !repos.length) return [];
  const indexed = new Set(
    (await db.selectDistinct({ repo: fileIndex.repo }).from(fileIndex).where(and(eq(fileIndex.workspaceId, workspaceId), inArray(fileIndex.repo, repos)))).map((r) => r.repo),
  );
  await Promise.all(repos.filter((r) => !indexed.has(r)).map((r) => syncFiles(workspaceId, r)));
  const rows = await db
    .select({ repo: fileIndex.repo, path: fileIndex.path, text: fileIndex.text })
    .from(fileIndex)
    .where(and(eq(fileIndex.workspaceId, workspaceId), inArray(fileIndex.repo, repos), sql`${fileIndex.search} @@ to_tsquery('simple', ${query})`))
    .orderBy(sql`ts_rank(${fileIndex.search}, to_tsquery('simple', ${query})) desc`)
    .limit(limit);
  const terms = words.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  return rows.flatMap((r) => {
    const lines = r.text.split("\n").map((text, i) => ({ text, n: i + 1, low: text.toLowerCase() }));
    const all = lines.filter((l) => terms.every((t) => l.low.includes(t)));
    const shown = all.length ? all : lines.filter((l) => terms.some((t) => l.low.includes(t))).slice(0, 1);
    return shown.map((l) => ({ repo: r.repo, path: r.path, line: l.n, text: l.text }));
  }).slice(0, limit);
}
