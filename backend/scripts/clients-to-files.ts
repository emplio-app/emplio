// One-time: the clients table becomes the client files (clients.ts). For every business with clients rows, each one's
// name, stage, handlers (as [[team/<name>]] links, team files made or given an email as needed) and details go into the
// top lines of company/clients/<slug>.md, keeping the notes below; one commit per business. Run before the migration
// that drops the table.
//
//   bun scripts/clients-to-files.ts            what it would write, changing nothing
//   bun scripts/clients-to-files.ts --apply    write them
import { sql } from "drizzle-orm";
import type { Thing } from "@emplio/shared";
import { handlerLinks, mergeDetails, setFields } from "../src/clients";
import { db } from "../src/db";
import { syncFiles } from "../src/file-index";
import { readFile, UPKEEP, writeFiles } from "../src/gitea";
import { listTeam } from "../src/team";
import { listThings } from "../src/things";

const APPLY = process.argv.includes("--apply");
type Row = { workspace_id: string; ws: string; slug: string; name: string; stage: string; handler_ids: string[]; details: { name: string; value: string }[] };
const rows = (await db.execute(sql`select c.workspace_id, w.name as ws, c.slug, c.name, c.stage, c.handler_ids, c.details from clients c join workspaces w on w.id = c.workspace_id order by c.workspace_id, c.slug`)).rows as Row[];
const won = (await db.execute(sql`select workspace_id, name from automations where "when" = 'new client' and enabled`)).rows;
// a client file new as active starts these (file-index.ts): held off while the files are written, these clients aren't new
if (won.length) console.log(`holding off ${won.length} new-client automations while writing`);
const held = APPLY ? (await db.execute(sql`update automations set enabled = false where "when" = 'new client' and enabled returning id`)).rows.map((r) => r.id as string) : [];

let written = 0;
for (const workspaceId of new Set(rows.map((r) => r.workspace_id))) {
  const mine = rows.filter((r) => r.workspace_id === workspaceId);
  const [team, things] = await Promise.all([listTeam(workspaceId), listThings(workspaceId, "team")]);
  const files: { path: string; content: string }[] = [];
  for (const r of mine) {
    const links: string[] = [];
    for (const id of r.handler_ids) {
      // someone who left the team was no longer shown as handling them
      if (!team.some((m) => m.id === id)) continue;
      const h = await handlerLinks(workspaceId, [id], null, team, things);
      if (typeof h === "string") throw new Error(h);
      links.push(...h.links);
      for (const f of h.files) {
        const i = files.findIndex((x) => x.path === f.path);
        if (i >= 0) files[i] = f;
        else files.push(f);
        const m = team.find((x) => x.id === id)!;
        // later clients find this one's file (and its email) instead of making another
        const at = things.findIndex((t) => `${t.path}.md` === f.path);
        const t: Thing = { path: f.path.slice(0, -3), kind: "team", title: at >= 0 ? things[at]!.title : (m.name ?? m.email), fields: { ...(at >= 0 ? things[at]!.fields : {}), email: m.email }, body: "", links: [], error: null };
        if (at >= 0) things[at] = t;
        else things.push(t);
      }
    }
    const set: Record<string, string | null> = { name: r.name, stage: r.stage, handler: links.length ? [...new Set(links)].map((l) => `[[${l}]]`).join(", ") : null };
    for (const d of r.details) {
      const ok = mergeDetails([], { [d.name]: d.value });
      if (typeof ok === "string") console.log(`  ${r.ws} / ${r.slug}: detail left out: ${ok}`);
      else for (const x of ok) set[x.name.toLowerCase()] = x.value;
    }
    const path = `clients/${r.slug}.md`;
    const old = (await readFile(workspaceId, "company", path).catch(() => null)) ?? "";
    files.push({ path, content: setFields(old, set) });
  }
  console.log(`${mine[0]!.ws}: ${mine.length} clients, files: ${files.map((f) => f.path).join(", ")}`);
  console.log(files.find((f) => f.path.startsWith("clients/"))!.content.split("\n").slice(0, 8).map((l) => `    ${l}`).join("\n"));
  if (!APPLY) continue;
  await writeFiles(workspaceId, "company", files, "Clients' stage, handlers and details moved into their files", UPKEEP);
  await syncFiles(workspaceId, "company");
  written += files.length;
}
if (held.length) {
  // ponytail: they're looked up just after each sync; a few seconds covers that
  await new Promise((r) => setTimeout(r, 5000));
  await db.execute(sql`update automations set enabled = true where id in ${sql.raw(`(${held.map((id) => `'${id}'`).join(",")})`)}`);
}
console.log(APPLY ? `wrote ${written} files` : "dry run: --apply to write them");
process.exit(0);
