// Scores of one or more EVAL_DUMP files side by side, by category, and the cases that failed in the last one:
// `bun evals/manager/report.ts old.jsonl new.jsonl`
import { readFileSync } from "node:fs";
import { scorers } from "./scorers";

type Row = { name: string; category: string; input: never; expected: never; output: { text: string; commands: string[]; byHand: number } };
const runs = process.argv.slice(2).map((file) => ({ file, rows: readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l) as Row) }));
const marked = (rows: Row[]) => rows.map((r) => ({ ...r, scores: Object.fromEntries(scorers.map((s) => { const m = s({ input: r.input, output: r.output, expected: r.expected }); return [m.name, m]; })) }));
const pct = (xs: (number | null)[]) => { const v = xs.filter((x): x is number => x !== null); return v.length ? `${Math.round((100 * v.reduce((a, b) => a + b, 0)) / v.length)}%` : "-"; };

const all = runs.map((r) => ({ ...r, marks: marked(r.rows) }));
const categories = [...new Set(all[0]!.marks.map((m) => m.category))];
console.log(["", ...all.map((r) => r.file.split("/").at(-1))].join("\t"));
for (const name of scorers.map((s) => s({ input: all[0]!.marks[0]!.input, output: all[0]!.marks[0]!.output, expected: all[0]!.marks[0]!.expected }).name))
  console.log([name, ...all.map((r) => pct(r.marks.map((m) => m.scores[name]!.score)))].join("\t"));
for (const c of categories) console.log([`  right_call: ${c}`, ...all.map((r) => pct(r.marks.filter((m) => m.category === c).map((m) => m.scores.right_call!.score)))].join("\t"));
// a case passes when every try passed
console.log(["cases passing every try", ...all.map((r) => { const names = [...new Set(r.marks.map((m) => m.name))]; return `${names.filter((n) => r.marks.filter((m) => m.name === n).every((m) => m.scores.right_call!.score === 1)).length}/${names.length}`; })].join("\t"));

const last = all.at(-1)!;
console.log(`\nFailed in ${last.file}:`);
for (const m of last.marks) {
  const bad = Object.values(m.scores).filter((s) => s.score === 0);
  if (!bad.length) continue;
  console.log(`- ${m.name}: ${bad.map((s) => `${s.name} ${JSON.stringify(s.metadata ?? {}).slice(0, 160)}`).join(" | ")}`);
  console.log(`    ran: ${m.output.commands.map((c) => c.split("\n")[0]!.slice(0, 110)).join(" ;; ") || "(nothing)"}`);
}
