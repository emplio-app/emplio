// A run's answers by category, then each failed try: `bun evals/client-work/report.ts .evals/client-work.jsonl`
// (also for process-steps). Reads what EVAL_DUMP kept (bun run evals keeps it in .evals/<name>.jsonl).
export {};
type Row = { name: string; category: string; marks: Record<string, number | null>; commands: string[]; text: string };
const rows = (await Bun.file(process.argv[2]!).text()).trim().split("\n").map((l) => JSON.parse(l) as Row);
const main = (r: Row) => r.marks.right_call;
const pct = (rs: Row[]) => `${Math.round((100 * rs.filter((r) => main(r) === 1).length) / rs.length)}% (${rs.filter((r) => main(r) === 1).length}/${rs.length})`;
console.log(`right_call ${pct(rows)}`);
for (const k of [...new Set(rows.flatMap((r) => Object.keys(r.marks)))].filter((k) => k !== "right_call")) {
  const m = rows.filter((r) => r.marks[k] !== null && r.marks[k] !== undefined);
  if (m.length) console.log(`${k} ${Math.round((100 * m.filter((r) => r.marks[k] === 1).length) / m.length)}% (${m.filter((r) => r.marks[k] === 1).length}/${m.length})`);
}
console.log("");
for (const cat of [...new Set(rows.map((r) => r.category))].sort()) console.log(`  ${cat.padEnd(14)} ${pct(rows.filter((r) => r.category === cat))}`);
for (const r of rows.filter((r) => Object.values(r.marks).some((s) => s === 0)))
  console.log(`\n✗ ${r.category} · ${r.name}  ${Object.entries(r.marks).filter(([, s]) => s === 0).map(([k]) => k).join(", ")}\n${r.commands.map((c) => `  $ ${c.replace(/\s+/g, " ").slice(0, 300)}`).join("\n")}\n  » ${r.text.replace(/\s+/g, " ").slice(0, 300)}`);
