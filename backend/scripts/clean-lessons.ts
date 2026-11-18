// One-time tidy of every agent's LESSONS.md, a line at a time:
//   keep  a lesson (LESSON_RULE): it stays
//   tip   how to do a step on a site or app that would help the next job: it moves to the agent's own tips skill
//         (skillset/<agent>-tips/SKILL.md, added to the agent's skills), so it's kept but read only when used
//   drop  a log of the work or a one-time detail: it goes
// One commit per agent, as Emplio's upkeep. Re-running finds the lessons already tidy.
//
//   bun scripts/clean-lessons.ts            what it would do, changing nothing
//   bun scripts/clean-lessons.ts --apply    do it
import { generateText } from "ai";
import { eq } from "drizzle-orm";
import { agentMd, LESSON_RULE, parseAgent } from "../src/agents";
import { db } from "../src/db";
import { users, workspaceMembers, workspaces } from "../src/db/schema";
import { listPaths, readFile, UPKEEP, writeFiles } from "../src/gitea";
import { model } from "../src/models";

const APPLY = process.argv.includes("--apply");
const MODEL = "anthropic/claude-haiku-5.5";

const SYSTEM = `You sort an AI agent's notes. ${LESSON_RULE}
Mark each numbered line:
K  a lesson by that rule: keep it
T  not a lesson, but how to do a step on a particular site or app that the next job of this kind would want (an address, a setting, a button to use, a quirk to work around), with nothing about one person or one case in it
D  a log of the work, what was found, a one-time detail (one person, one date's numbers), or anything private
Reply with one line per note, "<number> <K|T|D>", nothing else.`;

// "<number> <K|T|D>" lines; null when the answer doesn't cover every line
export function marks(reply: string, count: number) {
  const got = new Map<number, string>();
  for (const m of reply.matchAll(/^\s*(\d+)\s*[.:)-]?\s*([KTD])\b/gim)) got.set(Number(m[1]), m[2]!.toUpperCase());
  return Array.from({ length: count }, (_, i) => got.get(i + 1)).every(Boolean) ? Array.from({ length: count }, (_, i) => got.get(i + 1)!) : null;
}

// a note as a tip: no date in front
export const asTip = (line: string) => line.replace(/^-\s*/, "").replace(/^\d{4}-\d{2}-\d{2}:\s*/, "");

export function tipsSkill(slug: string, name: string, old: string | null, tips: string[]) {
  const have = new Set((old ?? "").split("\n").filter((l) => l.startsWith("- ")).map((l) => l.slice(2)));
  const fresh = tips.filter((t) => !have.has(t));
  const head = `---\nname: ${slug}-tips\ndescription: How-to tips ${name} learned on the sites and apps it works with; read before a step there.\n---\n\n# ${name}: tips\n\n`;
  return (old?.trimEnd() || head.trimEnd()) + "\n" + fresh.map((t) => `- ${t}`).join("\n") + "\n";
}

async function tidy(w: typeof workspaces.$inferSelect) {
  const people = await db.select({ id: users.id }).from(workspaceMembers).innerJoin(users, eq(users.id, workspaceMembers.userId)).where(eq(workspaceMembers.workspaceId, w.id));
  for (const repo of ["company", "restricted", ...people.map((p) => `me-${p.id}`)]) {
    for (const p of (await listPaths(w.id, repo).catch(() => [])).filter((p) => /^agents\/[^/]+\/LESSONS\.md$/.test(p.path))) {
      const slug = p.path.split("/")[1]!;
      const lines = ((await readFile(w.id, repo, p.path)) ?? "").split("\n").filter((l) => l.startsWith("- "));
      if (!lines.length) continue;
      const { text: reply } = await generateText({
        model: model({}, MODEL, { workspaceId: w.id, agent: "upkeep" }),
        system: SYSTEM,
        prompt: lines.map((l, i) => `${i + 1}. ${l.slice(2)}`).join("\n"),
      });
      const got = marks(reply, lines.length);
      if (!got) {
        console.log(`  SKIPPED ${w.name} ${repo}/${p.path}: unclear answer ${JSON.stringify(reply.slice(0, 80))}`);
        continue;
      }
      const kept = lines.filter((_, i) => got[i] === "K");
      const tips = lines.filter((_, i) => got[i] === "T").map(asTip);
      const dropped = lines.filter((_, i) => got[i] === "D");
      if (kept.length === lines.length) continue;
      console.log(`  ${w.name} ${repo}/${p.path}: keeps ${kept.length}, moves ${tips.length} to tips, drops ${dropped.length}`);
      for (const t of tips) console.log(`    > ${t.slice(0, 160)}`);
      for (const l of dropped) console.log(`    - ${l.slice(2, 160)}`);
      if (!APPLY) continue;
      const files: { path: string; content: string }[] = [{ path: p.path, content: kept.length ? `${kept.join("\n")}\n` : "" }];
      if (tips.length) {
        const agentPath = `agents/${slug}/AGENT.md`;
        const agent = parseAgent(slug, (await readFile(w.id, repo, agentPath)) ?? "");
        const skill = `${slug}-tips`;
        const skillPath = `skillset/${skill}/SKILL.md`;
        files.push({ path: skillPath, content: tipsSkill(slug, agent.name, await readFile(w.id, repo, skillPath), tips) });
        if (!agent.skills.includes(skill)) files.push({ path: agentPath, content: agentMd({ ...agent, skills: [...agent.skills, skill] }) });
      }
      // an automation keeps running as the person who last saved it: lastAuthor passes over UPKEEP commits
      await writeFiles(w.id, repo, files, `Lessons tidied for ${slug}: how-to tips moved to its tips skill, logs dropped`, UPKEEP);
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
