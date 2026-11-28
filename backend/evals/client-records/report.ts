// What failed in a run, case by case: `bun evals/client-records/report.ts .evals/client-records.jsonl [name words]`
import { cases } from "./cases";
import { rightCall, rightDetails } from "./scorers";

const [file, ...only] = process.argv.slice(2);
const all = await cases();
const rows = (await Bun.file(file!).text()).trim().split("\n").map((l) => JSON.parse(l));
for (const r of rows) {
  if (only.length && !only.some((w) => r.name.includes(w))) continue;
  if (Object.values(r.marks).every((m) => m !== 0)) continue;
  const c = all.find((x) => x.name === r.name)!;
  const out = { text: r.text ?? "", last: r.text ?? "", commands: r.commands, failed: r.failed ?? [] };
  console.log(`--- ${r.name} ${JSON.stringify(r.marks)}`);
  const call = rightCall({ output: out, expected: c.expect }).metadata!;
  if (r.marks.right_call === 0) console.log(`  missing ${call.missing} extra ${call.extra}`);
  if (r.marks.right_details === 0) console.log(`  ${(rightDetails({ output: out, expected: c.expect }).metadata!.wrong as string[]).join("\n  ")}`);
  for (const cmd of r.commands) console.log(`  $ ${cmd.slice(0, 260).replace(/\n/g, " | ")}`);
  console.log(`  > ${(r.text ?? "").replace(/\n+/g, " / ").slice(0, 400)}`);
}
