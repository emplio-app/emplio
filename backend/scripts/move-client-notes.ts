// One-time: client notes move from company/knowledge/clients/ to company/clients/ (things.ts), in every business, as one
// commit each. A file already at the new place is left alone and the old one stays for Emplio to merge.
//
//   bun scripts/move-client-notes.ts            what it would move, changing nothing
//   bun scripts/move-client-notes.ts --apply    move them
//   ... <workspace id>                           only that business
import { db } from "../src/db";
import { workspaces } from "../src/db/schema";
import { listPaths, readFile, UPKEEP, writeFiles } from "../src/gitea";

const APPLY = process.argv.includes("--apply");
const ONLY = process.argv.slice(2).find((a) => !a.startsWith("--"));
const OLD = /^knowledge\/clients\/([^/]+\.md)$/;

let moved = 0;
for (const w of await db.select({ id: workspaces.id, name: workspaces.name }).from(workspaces)) {
  if (ONLY && w.id !== ONLY) continue;
  const paths = (await listPaths(w.id, "company").catch(() => [])).map((f) => f.path);
  const files = paths.flatMap((p) => {
    const name = OLD.exec(p)?.[1];
    return name && !paths.includes(`clients/${name}`) ? [{ from: p, to: `clients/${name}` }] : [];
  });
  if (!files.length) continue;
  console.log(`${w.name}: ${files.map((f) => f.to).join(", ")}`);
  if (!APPLY) continue;
  const texts = await Promise.all(files.map((f) => readFile(w.id, "company", f.from)));
  await writeFiles(
    w.id,
    "company",
    files.flatMap((f, i) => (texts[i] === null ? [] : [{ path: f.to, content: texts[i]! }, { path: f.from, content: null }])),
    "Client notes moved to clients/",
    UPKEEP,
  );
  moved += files.length;
}
console.log(APPLY ? `moved ${moved}` : "dry run: --apply to move them");
process.exit(0);
