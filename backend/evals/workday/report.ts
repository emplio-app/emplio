// Runs side by side: `bun evals/workday/report.ts old.jsonl new.jsonl` (files from EVAL_DUMP), then what went wrong
// in the last one.
import { readFileSync } from "node:fs";
import type { StepResult } from "./workday.eval";

type Row = { name: string; output: { steps: StepResult[] } };
const files = process.argv.slice(2);
const runs = files.map((f) => readFileSync(f, "utf8").trim().split("\n").map((l) => JSON.parse(l) as Row));
const pct = (n: number, d: number) => `${Math.round((100 * n) / (d || 1))}%`;
const cols = (f: (rows: Row[]) => string) => runs.map(f).join("\t");
const steps = (rows: Row[]) => rows.flatMap((r) => r.output.steps);
console.log(`\t${files.map((f) => f.split("/").at(-1)).join("\t")}`);
console.log(`steps right\t${cols((rows) => pct(steps(rows).filter((s) => s.ok).length, steps(rows).length))}`);
console.log(`whole chats right\t${cols((rows) => `${rows.filter((r) => r.output.steps.every((s) => s.ok)).length}/${rows.length}`)}`);
console.log(`used a browser itself\t${cols((rows) => `${steps(rows).filter((s) => s.browser).length} steps`)}`);
console.log(`own commands per step\t${cols((rows) => (steps(rows).reduce((n, s) => n + s.byHand, 0) / (steps(rows).length || 1)).toFixed(1))}`);
const sum = (rows: Row[], k: "input" | "output" | "cost") => steps(rows).reduce((n, s) => n + (s.usage?.[k] ?? 0), 0) / (rows.length || 1);
console.log(`Emplio's tokens in, per chat\t${cols((rows) => Math.round(sum(rows, "input")).toLocaleString())}`);
console.log(`Emplio's tokens out, per chat\t${cols((rows) => Math.round(sum(rows, "output")).toLocaleString())}`);
console.log(`Emplio's cost per chat\t${cols((rows) => `$${sum(rows, "cost").toFixed(4)}`)}`);
for (const name of [...new Set(runs.flat().map((r) => r.name))])
  console.log(`  ${name}\t${cols((rows) => pct(steps(rows.filter((r) => r.name === name)).filter((s) => s.ok).length, steps(rows.filter((r) => r.name === name)).length))}`);
console.log(`\nWrong in ${files.at(-1)}:`);
for (const r of runs.at(-1)!) for (const s of r.output.steps.filter((s) => !s.ok)) console.log(`- ${r.name}, step ${s.step}: ${s.why.join("; ")}`);
