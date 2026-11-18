// One-time tidy of every agent's LESSONS.md: lines that are a log of the work ("re-checked, nothing found") or how to
// do a step go, so only lessons (LESSON_RULE) stay. One commit per file, as Emplio's upkeep. Re-running keeps what's left.
//
//   bun scripts/clean-lessons.ts            what it would drop, changing nothing
//   bun scripts/clean-lessons.ts --apply    drop them
import { generateText } from "ai";
import { eq } from "drizzle-orm";
import { LESSON_RULE } from "../src/agents";
import { db } from "../src/db";
import { users, workspaceMembers, workspaces } from "../src/db/schema";
import { listPaths, readFile, UPKEEP, writeFile } from "../src/gitea";
import { model } from "../src/models";

const APPLY = process.argv.includes("--apply");
const MODEL = "anthropic/claude-haiku-5.5";

// the numbers (1 is the first line) of the lines to keep, from the model's reply
export const keptNumbers = (reply: string, count: number) =>
  new Set((reply.match(/\d+/g) ?? []).map(Number).filter((n) => n >= 1 && n <= count));

async function tidy(w: typeof workspaces.$inferSelect) {
  const people = await db.select({ id: users.id }).from(workspaceMembers).innerJoin(users, eq(users.id, workspaceMembers.userId)).where(eq(workspaceMembers.workspaceId, w.id));
  for (const repo of ["company", "restricted", ...people.map((p) => `me-${p.id}`)]) {
    for (const p of (await listPaths(w.id, repo).catch(() => [])).filter((p) => /^agents\/[^/]+\/LESSONS\.md$/.test(p.path))) {
      const text = (await readFile(w.id, repo, p.path)) ?? "";
      const lines = text.split("\n").filter((l) => l.startsWith("- "));
      if (!lines.length) continue;
      const { text: reply } = await generateText({
        model: model({}, MODEL, { workspaceId: w.id, agent: "upkeep" }),
        system: `You tidy an AI agent's lessons. ${LESSON_RULE}\nThe lines come numbered. Reply with only the numbers of the lines that are lessons by that rule, comma separated, or NONE.`,
        prompt: lines.map((l, i) => `${i + 1}. ${l.slice(2)}`).join("\n"),
      });
      // an answer that's neither numbers nor NONE drops nothing
      if (!/^\s*(NONE|[\d,\s]+)\s*$/i.test(reply)) {
        console.log(`  SKIPPED ${w.name} ${repo}/${p.path}: unclear answer ${JSON.stringify(reply.slice(0, 80))}`);
        continue;
      }
      const keep = keptNumbers(reply, lines.length);
      const dropped = lines.filter((_, i) => !keep.has(i + 1));
      if (!dropped.length) continue;
      console.log(`  ${w.name} ${repo}/${p.path}: keeps ${keep.size}, drops ${dropped.length}`);
      for (const l of dropped) console.log(`    - ${l.slice(2, 160)}`);
      if (!APPLY) continue;
      const kept = lines.filter((_, i) => keep.has(i + 1));
      await writeFile(w.id, repo, p.path, kept.length ? `${kept.join("\n")}\n` : "", "Lessons tidied: logs of the work and how-to steps dropped", UPKEEP);
    }
  }
}

if (import.meta.main) {
  for (const w of await db.select().from(workspaces)) {
    try {
      await tidy(w);
    } catch (error) {
      console.log(`  FAILED ${w.name} (${w.id}): ${error instanceof Error ? error.message : error}`);
    }
  }
  console.log(APPLY ? "done" : "dry run: nothing changed (--apply to do it)");
  process.exit(0);
}
