// One-time move of the old saved functions into tools: every skills/<name>/functions.py and lib/<name>.py becomes
// toolset/<area>.py in the same repo, its public functions labelled with a risk; emplio.skill("x") / emplio.lib("x")
// and the old paths in the business's files point at the tools instead; agents that list the skill get its tools;
// lesson lines with their date written twice are fixed. Then the old files are deleted.
//
//   bun scripts/migrate-toolset.ts            what it would do, changing nothing
//   bun scripts/migrate-toolset.ts --apply    do it
import { eq } from "drizzle-orm";
import { agentMd, parseAgent, toolsIn } from "../src/agents";
import { db } from "../src/db";
import { users, workspaceMembers, workspaces } from "../src/db/schema";
import { listPaths, readFile, writeFile, writeFiles } from "../src/gitea";

const APPLY = process.argv.includes("--apply");
const AUTHOR = { name: "Emplio", email: "noreply@emplio.app" };
const KEYWORDS = new Set(["and", "as", "class", "def", "del", "for", "from", "global", "if", "import", "in", "is", "not", "or", "pass", "return", "try", "while", "with", "tools", "emplio"]);
// a function that changes something outside the computer: sends, clicks on a site, posts, writes a database or an
// app. Files it writes on the computer don't count: asking each time for those would be noise.
const WRITES = new RegExp(
  [
    /\.(click|fill|type|press|select|check|upload|drag|dblclick)\(/, // a page, also .click() inside page code
    /\bemplio\.(?!tools\b|apps\b|browser\b)\w+\.(send|add|create|update|remove|delete|post|reply|grant|cancel|set|done|hand)\b/,
    /\bapps\.run\(\s*["'][a-z0-9_]+\.[a-z_]*(send|create|update|delete|add|post|remove|move|upload|reply|forward|insert|set|cancel|refund|charge|pay|archive|trash|label|modify|patch|put|write|append|share|invite|publish|merge|close|comment)/,
    /requests\.(post|put|patch|delete)\(|method\s*=\s*["'](POST|PUT|PATCH|DELETE)|\bsmtplib\b|\bgit\s+push\b/,
    /\b(insert\s+into|update\s+\w+\s+set|delete\s+from)\b/,
  ]
    .map((r) => r.source)
    .join("|"),
  "i",
);

export const areaOf = (name: string) => {
  let a = name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40) || "tools";
  if (/^\d/.test(a)) a = `t_${a}`.slice(0, 40);
  return KEYWORDS.has(a) ? `${a}_tools` : a;
};

// Label each public top-level function with a risk (unless it has one), right above its decorators or def: "changes"
// when it, or a function of the file it calls, changes something outside (WRITES).
export function labelled(py: string) {
  const lines = py.split("\n");
  // a body runs to the next top-level def or class: a multi-line string inside it can start at the line's beginning
  const starts = lines.flatMap((l, i) => (/^(?:async\s+def|def|class|@)\b|^@/.test(l) ? [i] : []));
  const defs = lines.flatMap((l, i) => {
    const m = /^(?:async\s+)?def\s+(\w+)\s*\(/.exec(l);
    const end = starts.find((s) => s > i) ?? lines.length;
    return m ? [{ name: m[1]!, at: i, body: lines.slice(i, end).join("\n") }] : [];
  });
  const changes = new Set(defs.filter((d) => WRITES.test(d.body)).map((d) => d.name));
  for (let grew = true; grew; ) {
    grew = false;
    for (const d of defs)
      if (!changes.has(d.name) && [...changes].some((n) => n !== d.name && new RegExp(`\\b${n}\\(`).test(d.body.slice(d.body.indexOf("\n")))))
        changes.add(d.name), (grew = true);
  }
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const d = defs.find((d) => d.at === i);
    if (d && !d.name.startsWith("_")) {
      // the decorators just above are already in out: the label goes above them
      let at = out.length;
      while (at > 0 && out[at - 1]!.startsWith("@")) at--;
      let c = at;
      let has = false;
      while (c > 0 && out[c - 1]!.startsWith("#")) if (/^#\s*risk:/i.test(out[--c]!)) has = true;
      if (!has) out.splice(at, 0, `# risk: ${changes.has(d.name) ? "changes" : "reads"}`);
    }
    out.push(lines[i]!);
  }
  return out.join("\n");
}

// emplio.skill("x") / emplio.lib("x") → emplio.tools.<area>; a folder found by __file__ → where the skill still is.
export function pointed(text: string, area: (kind: "skill" | "lib", name: string) => string | undefined, here?: string) {
  let t = text.replace(/emplio\.(skill|lib)\(\s*["']([\w-]+)["']\s*\)/g, (all, kind, name) => {
    const a = area(kind, name);
    return a ? `emplio.tools.${a}` : all;
  });
  t = t.replace(/\b(skills\/([\w-]+)\/functions\.py|lib\/([\w-]+)\.py)\b/g, (all, _p, s, l) => {
    const a = s ? area("skill", s) : area("lib", l);
    return a ? `toolset/${a}.py` : all;
  });
  if (here)
    t = t
      .replace(/os\.path\.dirname\(\s*(?:os\.path\.(?:abspath|realpath)\(\s*)?__file__\s*\)?\s*\)/g, JSON.stringify(here))
      .replace(/Path\(\s*__file__\s*\)(?:\.resolve\(\))?\.parent/g, `Path(${JSON.stringify(here)})`);
  return t;
}

const syntaxOk = (py: string) => {
  const p = Bun.spawnSync(["python3", "-c", "import ast, sys; ast.parse(sys.stdin.read())"], { stdin: new TextEncoder().encode(py) });
  return p.exitCode === 0 ? null : p.stderr.toString().trim().split("\n").pop();
};

const TEXT = /\.(md|py|txt|json|ya?ml)$/;
const dirOf = (repo: string) => (repo.startsWith("me-") ? "me" : repo);

async function migrate(w: typeof workspaces.$inferSelect) {
  const people = await db.select({ id: users.id }).from(workspaceMembers).innerJoin(users, eq(users.id, workspaceMembers.userId)).where(eq(workspaceMembers.workspaceId, w.id));
  const repos = ["company", "restricted", ...people.map((p) => `me-${p.id}`)];
  const trees = new Map<string, { path: string }[]>();
  for (const r of repos) trees.set(r, await listPaths(w.id, r).catch(() => []));
  const taken = new Set([...trees.values()].flatMap((t) => t.flatMap((p) => /^toolset\/([a-z][a-z0-9_]*)\.py$/.exec(p.path)?.[1] ?? [])));
  // every old file, and the area it becomes (unique in the business: one area lives in one bucket)
  const moves: { repo: string; path: string; kind: "skill" | "lib"; name: string; area: string }[] = [];
  for (const r of repos)
    for (const p of trees.get(r)!) {
      const m = /^skills\/([^/]+)\/functions\.py$/.exec(p.path) ?? /^lib\/([^/]+)\.py$/.exec(p.path);
      if (!m) continue;
      let area = areaOf(m[1]!);
      for (let n = 2; taken.has(area); n++) area = `${areaOf(m[1]!)}_${n}`;
      taken.add(area);
      moves.push({ repo: r, path: p.path, kind: p.path.startsWith("lib/") ? "lib" : "skill", name: m[1]!, area });
    }
  const lessonsFix = repos.flatMap((r) => trees.get(r)!.filter((p) => /^agents\/[^/]+\/LESSONS\.md$/.test(p.path)).map((p) => ({ repo: r, path: p.path })));
  if (!moves.length && !lessonsFix.length) return;

  for (const r of repos) {
    const mine = moves.filter((m) => m.repo === r);
    // own repo's names first (a person's skill over the company's), as emplio.skill looked them up
    const area = (kind: "skill" | "lib", name: string) =>
      (mine.find((m) => m.kind === kind && m.name === name) ?? moves.find((m) => m.kind === kind && m.name === name && (m.repo === "company" || m.repo === "restricted")))?.area;
    const files: { path: string; content: string }[] = [];
    const gone: string[] = [];
    for (const m of mine) {
      const old = (await readFile(w.id, r, m.path)) ?? "";
      const here = `/work/${dirOf(r)}/${m.kind === "skill" ? `skills/${m.name}` : "lib"}`;
      const py = labelled(pointed(old, area, here));
      const bad = syntaxOk(py);
      if (bad) {
        console.log(`  SKIP ${w.name} ${r}/${m.path}: ${bad}`);
        continue;
      }
      if (/__file__/.test(py)) console.log(`  NOTE ${w.name} ${r}/${m.path}: still uses __file__`);
      const tools = toolsIn(m.area, py).map((t) => t.name);
      console.log(`  ${r}/${m.path} -> toolset/${m.area}.py (${tools.length} tools: ${tools.join(", ")})`);
      files.push({ path: `toolset/${m.area}.py`, content: py.endsWith("\n") ? py : `${py}\n` });
      gone.push(m.path);
    }
    // the business's own text that names the old way: skills, automations, agents, knowledge
    for (const p of trees.get(r)!) {
      if (!TEXT.test(p.path) || gone.includes(p.path) || p.path.startsWith("toolset/")) continue;
      if (!moves.length) break;
      const own = /^skills\/([^/]+)\/SKILL\.md$/.exec(p.path)?.[1];
      const moved = own ? mine.find((m) => m.kind === "skill" && m.name === own && gone.includes(m.path)) : undefined;
      const text = await readFile(w.id, r, p.path);
      if (!text || (!moved && !/emplio\.(skill|lib)\(|functions\.py|lib\//.test(text))) continue;
      let next = pointed(text, area);
      if (moved) {
        // the skill's own page: its "functions.py" is that area's tools now, and it says how to use them
        const names = toolsIn(moved.area, files.find((f) => f.path === `toolset/${moved.area}.py`)?.content ?? "").map((x) => x.name.split(".")[1]);
        next = next.replace(/\bfunctions\.py\b/g, `tools.${moved.area}`);
        if (names.length && !next.includes(`from tools.${moved.area} import`))
          next = `${next.trimEnd()}\n\nIts tools: \`from tools.${moved.area} import ${names.join(", ")}\`.\n`;
      }
      if (next !== text) files.push({ path: p.path, content: next }), console.log(`  ${r}/${p.path}: points at the tools now`);
    }
    for (const p of trees.get(r)!.filter((p) => /^agents\/[^/]+\/AGENT\.md$/.test(p.path))) {
      const md = files.find((f) => f.path === p.path)?.content ?? (await readFile(w.id, r, p.path)) ?? "";
      const a = parseAgent(p.path.split("/")[1]!, md);
      const add = [...new Set(moves
        .filter((m) => a.skills.includes(m.name) && (m.repo === r || m.repo === "company" || (m.repo === "restricted" && r !== "company")))
        .flatMap((m) => toolsIn(m.area, files.find((f) => f.path === `toolset/${m.area}.py`)?.content ?? "").map((t) => t.name))
        .filter((n) => !a.tools.includes(n)))];
      if (!add.length) continue;
      const next = agentMd({ ...a, tools: [...a.tools, ...add] });
      const i = files.findIndex((f) => f.path === p.path);
      if (i >= 0) files[i]!.content = next;
      else files.push({ path: p.path, content: next });
      console.log(`  ${r}/${p.path}: + tools ${add.join(", ")}`);
    }
    for (const l of lessonsFix.filter((l) => l.repo === r)) {
      const text = (await readFile(w.id, r, l.path)) ?? "";
      const next = text.replace(/^- (\d{4}-\d{2}-\d{2}): \d{4}-\d{2}-\d{2}:\s*/gm, "- $1: ");
      if (next !== text) files.push({ path: l.path, content: next }), console.log(`  ${r}/${l.path}: dates written twice fixed`);
    }
    if (!APPLY || !files.length) continue;
    await writeFiles(w.id, r, files, "Saved functions moved into tools (toolset/)", AUTHOR);
    for (const path of gone) await writeFile(w.id, r, path, null, `Moved ${path} into tools`, AUTHOR);
  }
}

if (import.meta.main) {
  const all = await db.select().from(workspaces);
  for (const w of all) {
    try {
      await migrate(w);
    } catch (error) {
      console.log(`  FAILED ${w.name} (${w.id}): ${error instanceof Error ? error.message : error}`);
    }
  }
  console.log(APPLY ? "done" : "dry run: nothing changed (--apply to do it)");
  process.exit(0);
}
