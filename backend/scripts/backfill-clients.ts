// One-time: a Clients row for every notes file already in company/knowledge/clients/, in every business. The name is
// the file's first "# " heading (else its file name); a file that calls them a prospect near the top makes them one,
// the rest are active. The background agent corrects stages and who handles them later. Re-running adds only new ones.
//
//   bun scripts/backfill-clients.ts            what it would add, changing nothing
//   bun scripts/backfill-clients.ts --apply    add them
import { db } from "../src/db";
import { clients, workspaces } from "../src/db/schema";
import { listPaths, readFile } from "../src/gitea";
import { FOLDER } from "../src/clients";

const APPLY = process.argv.includes("--apply");
const FILE = new RegExp(`^${FOLDER}/([^/]+)\\.md$`);

export function clientFromNotes(slug: string, text: string) {
  // "Thallo Ventures / Umeed — Project Alchemy" -> "Thallo Ventures": the name, not the notes about them
  const heading = /^#\s+(.+?)\s*$/m.exec(text)?.[1]?.replace(/[*_`]/g, "").split(/\s+[—–-]\s+|\s+\(|\s+\/\s+/)[0]?.trim();
  const name = heading || slug.replace(/[-_]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
  const top = text.split("\n").slice(0, 6).join(" ").toLowerCase();
  return { name: name.slice(0, 200), stage: /\bprospect\b/.test(top) ? ("prospect" as const) : ("active" as const) };
}

if (import.meta.main) {
  let added = 0;
  for (const w of await db.select({ id: workspaces.id, name: workspaces.name }).from(workspaces)) {
    const paths = (await listPaths(w.id, "company").catch(() => [])).flatMap((f) => FILE.exec(f.path)?.[1] ?? []);
    for (const slug of paths) {
      const c = clientFromNotes(slug, (await readFile(w.id, "company", `${FOLDER}/${slug}.md`)) ?? "");
      console.log(`${w.name}\t${slug}\t${c.stage}\t${c.name}`);
      if (!APPLY) continue;
      const rows = await db.insert(clients).values({ workspaceId: w.id, slug, ...c }).onConflictDoNothing().returning({ id: clients.id });
      added += rows.length;
    }
  }
  console.log(APPLY ? `added ${added}` : "dry run: --apply to add them");
  process.exit(0);
}
