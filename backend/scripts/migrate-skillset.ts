// One-time move of every repo's skills/ folder to skillset/, in one commit per repo, with the business's own text
// that names company/skills/, me/skills/ or restricted/skills/ pointed at skillset/. Re-running finds nothing to do.
//
//   bun scripts/migrate-skillset.ts            what it would do, changing nothing
//   bun scripts/migrate-skillset.ts --apply    do it
import { eq } from "drizzle-orm";
import { db } from "../src/db";
import { users, workspaceMembers, workspaces } from "../src/db/schema";
import { listPaths, readFile, UPKEEP, writeFiles } from "../src/gitea";

const APPLY = process.argv.includes("--apply");
// git holds text only (big and binary files are .media pointers), so every file reads as text
const TEXT = /\.(md|txt|py|js|ts|sh|json|jsonl|csv|tsv|ya?ml|toml|sql|media)$/;

export const repointed = (text: string) => text.replace(/\b(company|me|restricted)\/skills\b/g, "$1/skillset");

async function migrate(w: typeof workspaces.$inferSelect) {
  const people = await db.select({ id: users.id }).from(workspaceMembers).innerJoin(users, eq(users.id, workspaceMembers.userId)).where(eq(workspaceMembers.workspaceId, w.id));
  for (const repo of ["company", "restricted", ...people.map((p) => `me-${p.id}`)]) {
    const tree = await listPaths(w.id, repo).catch(() => []);
    const files: { path: string; content: string | null }[] = [];
    for (const p of tree) {
      const moving = p.path.startsWith("skills/");
      if (!moving && !TEXT.test(p.path)) continue;
      // a skill already in skillset/ wins over an old copy of the same file
      if (moving && tree.some((x) => x.path === `skillset/${p.path.slice(7)}`)) {
        files.push({ path: p.path, content: null });
        continue;
      }
      const text = await readFile(w.id, repo, p.path);
      if (text === null) throw new Error(`can't read ${repo}/${p.path}`);
      const next = repointed(text);
      if (moving) files.push({ path: `skillset/${p.path.slice(7)}`, content: next }, { path: p.path, content: null });
      else if (next !== text) files.push({ path: p.path, content: next });
    }
    if (!files.length) continue;
    const moved = files.filter((f) => f.path.startsWith("skills/")).length;
    const other = files.filter((f) => !f.path.startsWith("skills/") && !f.path.startsWith("skillset/")).length;
    console.log(`  ${w.name} ${repo}: ${moved} files to skillset/, ${other} other files repointed`);
    if (!APPLY) continue;
    // an automation keeps running as the person who last saved it: lastAuthor passes over UPKEEP commits
    await writeFiles(w.id, repo, files, "Skills moved to skillset/", UPKEEP);
  }
}

if (import.meta.main) {
  for (const w of await db.select().from(workspaces)) {
    try {
      await migrate(w);
    } catch (error) {
      console.log(`  FAILED ${w.name} (${w.id}): ${error instanceof Error ? error.message : error}`);
    }
  }
  console.log(APPLY ? "done" : "dry run: nothing changed (--apply to do it)");
  process.exit(0);
}
