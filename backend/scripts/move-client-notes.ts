// One-time: every thing gets a folder of its own, its page <kind>/<slug>/index.md (things.ts), in every business, as
// one commit each: company/<kind>/<slug>.md (the files before the folders) and production's older client notes,
// company/knowledge/clients/<slug>.md, move there. Their top lines become real YAML: each value read as YAML when it
// reads as one plain value, else kept as text; links quoted, several on one line made a list. A page already at the
// new place is left alone and the old file stays for Emplio to merge.
//
//   bun scripts/move-client-notes.ts            what it would move, changing nothing
//   bun scripts/move-client-notes.ts --apply    move them
//   ... <workspace id>                           only that business
import { parse, stringify } from "yaml";
import { THING_KINDS } from "@emplio/shared";
import { db } from "../src/db";
import { workspaces } from "../src/db/schema";
import { syncFiles } from "../src/file-index";
import { listPaths, readFile, UPKEEP, writeFiles } from "../src/gitea";
import { TOP } from "../src/things";

const APPLY = process.argv.includes("--apply");
const ONLY = process.argv.slice(2).find((a) => !a.startsWith("--"));
const OLD = new RegExp(`^(?:knowledge/(?=clients/))?(${THING_KINDS.join("|")})/([a-z0-9][a-z0-9-]*)\\.md$`);

// "key: value" lines (as they were written before) to YAML; the words below as they were. A key's "- item" lines under
// it are its list; any other line in the top isn't lost: it goes to the top of the words.
const valueOf = (v: string): unknown => {
  const links = v.match(/\[\[[^\]]+\]\]/g) ?? [];
  if (links.length && !v.replace(/\[\[[^\]]+\]\]|[\s,]/g, "")) return links.length > 1 ? links : links[0];
  let read: unknown = v;
  try {
    read = parse(v);
  } catch {}
  // a number or yes/no only when it reads back the same (+91…, 007, "#4" after an address stay text)
  return (typeof read === "number" || typeof read === "boolean") && String(read) === v ? read : v;
};

export function toYaml(text: string) {
  const top = TOP.exec(text);
  if (!top) return text;
  const fields: Record<string, unknown> = {};
  const rest: string[] = [];
  let last: string | null = null;
  for (const line of (top[1] ?? "").split(/\r?\n/)) {
    const item = /^\s*-\s+(.*)$/.exec(line);
    if (item && last) {
      const cur = fields[last];
      fields[last] = [...(Array.isArray(cur) ? cur : cur === "" ? [] : [cur]), ...[valueOf(item[1]!.trim())].flat()];
      continue;
    }
    const kv = /^([A-Za-z][\w -]*?)\s*:\s*(.*)$/.exec(line);
    if (!kv) {
      if (line.trim()) rest.push(line);
      last = null;
      continue;
    }
    last = kv[1]!;
    fields[last] = valueOf(kv[2]!.trim());
  }
  for (const [k, v] of Object.entries(fields)) if (v === "") delete fields[k];
  const body = text.slice(top[0].length);
  return `---\n${Object.keys(fields).length ? stringify(fields) : ""}---\n${rest.length ? `${rest.join("\n")}\n\n` : ""}${body}`;
}

if (import.meta.main) {
  let moved = 0;
  for (const w of await db.select({ id: workspaces.id, name: workspaces.name }).from(workspaces)) {
    if (ONLY && w.id !== ONLY) continue;
    const paths = (await listPaths(w.id, "company").catch(() => [])).map((f) => f.path);
    const files = paths.flatMap((p) => {
      const m = OLD.exec(p);
      const to = m && `${m[1]}/${m[2]}/index.md`;
      return to && !paths.includes(to) ? [{ from: p, to }] : [];
    });
    // both an old client note and the newer file for one client: the newer one moves
    const once = files.filter((f, i) => files.findIndex((x) => x.to === f.to) === i || !f.from.startsWith("knowledge/"));
    const todo = once.filter((f) => !(f.from.startsWith("knowledge/") && once.some((x) => x !== f && x.to === f.to)));
    if (!todo.length) continue;
    const texts = await Promise.all(todo.map((f) => readFile(w.id, "company", f.from)));
    console.log(`${w.name}: ${todo.length} files${todo.length < files.length ? ` (${files.length - todo.length} old client notes left for Emplio to merge)` : ""}`);
    for (const [i, f] of todo.entries()) console.log(`  ${f.from} -> ${f.to}${i < 2 && texts[i] ? `\n${toYaml(texts[i]!).split("\n").slice(0, 10).map((l) => `      ${l}`).join("\n")}` : ""}`);
    if (!APPLY) continue;
    await writeFiles(
      w.id,
      "company",
      todo.flatMap((f, i) => (texts[i] === null ? [] : [{ path: f.to, content: toYaml(texts[i]!) }, { path: f.from, content: null }])),
      "Each client, contact, teammate, service and project in a folder of its own: <name>/index.md",
      UPKEEP,
    );
    await syncFiles(w.id, "company");
    moved += todo.length;
  }
  console.log(APPLY ? `moved ${moved}` : "dry run: --apply to move them");
  process.exit(0);
}
