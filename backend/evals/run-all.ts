// Every eval at once, each in its own process (in one process, evaluators loading the app side by side race on its
// imports), each with its cases run side by side too (EVAL_CONCURRENCY, default 24). Logs in .evals/<name>.log, the
// scores printed at the end. `bun run evals` in backend; extra arguments go to each `bt eval` (--no-send-logs).
// Some evals only: `bun run evals manager job-report`.
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const dir = import.meta.dir;
const args = process.argv.slice(2);
const only = args.filter((a) => !a.startsWith("-"));
const flags = args.filter((a) => a.startsWith("-"));
const evals = readdirSync(dir, { withFileTypes: true })
  .filter((d) => d.isDirectory() && readdirSync(join(dir, d.name)).includes(`${d.name}.eval.ts`))
  .map((d) => d.name)
  .filter((n) => !only.length || only.includes(n));
mkdirSync(join(dir, "../.evals"), { recursive: true });
const began = Date.now();
const strip = (s: string) => s.replace(/\x1B\[[0-9;]*m/g, "");
const results = await Promise.all(
  evals.map(async (name) => {
    const p = Bun.spawn(["bt", "eval", "--runner", "bun", join(dir, name, `${name}.eval.ts`), ...flags], { cwd: join(dir, ".."), stdout: "pipe", stderr: "pipe" });
    const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
    const log = strip(out + err);
    writeFileSync(join(dir, "../.evals", `${name}.log`), log);
    // the run's own column: the last figure on each score's row
    const scores = [...log.matchAll(/^[│|]\s*◯\s+(\w+)\s+(.*?)\s*[│|]\s*$/gm)].filter((m) => m[2]!.includes("%")).map((m) => `${m[1]} ${m[2]!.replace(/^-\s+/, "").replace(/\s+/g, " ")}`);
    console.log(`${name} (${((Date.now() - began) / 60_000).toFixed(1)} min)${code ? `: exit ${code}` : ""}\n  ${scores.join("\n  ") || "(no scores: see .evals/" + name + ".log)"}`);
    return code;
  }),
);
console.log(`all done in ${((Date.now() - began) / 60_000).toFixed(1)} min`);
process.exit(results.some(Boolean) ? 1 : 0);
