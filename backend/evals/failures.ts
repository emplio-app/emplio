// What went wrong in a run, in the terminal: `bun evals/failures.ts <experiment name>` (the name `bun run eval`
// printed). One block per failed try: the case, the mark it lost, why, and what the model wrote.
import { $ } from "bun";

const name = process.argv[2];
if (!name) throw new Error("usage: bun evals/failures.ts <experiment name>");

const sql = async <T>(query: string) => ((await $`bt sql ${query} --json`.quiet().json()) as { data: T[] }).data;
const experiments = (await $`bt experiments list --json`.quiet().json()) as { id: string; name: string }[];
const id = experiments.find((e) => e.name === name)?.id;
if (!id) throw new Error(`no experiment called ${name}; there are: ${experiments.map((e) => e.name).join(", ")}`);

type Mark = { root_span_id: string; scores: Record<string, number | null>; metadata: Record<string, unknown> | null };
const marks = (await sql<Mark>(`SELECT root_span_id, scores, metadata FROM experiment('${id}') WHERE created > now() - interval 30 day AND span_attributes.type = 'score' LIMIT 1000`)).filter((m) =>
  Object.values(m.scores ?? {}).some((s) => s !== null && s < 1),
);
if (!marks.length) {
  console.log("Nothing failed.");
  process.exit(0);
}

type Row = { root_span_id: string; metadata: { name: string; category: string }; output: { said: string } };
const roots = [...new Set(marks.map((m) => m.root_span_id))];
const rows: Row[] = [];
// big fields come back at most 100 rows a query
for (let i = 0; i < roots.length; i += 50)
  rows.push(...(await sql<Row>(`SELECT root_span_id, metadata, output FROM experiment('${id}') WHERE created > now() - interval 30 day AND is_root AND root_span_id IN (${roots.slice(i, i + 50).map((r) => `'${r}'`).join(", ")}) LIMIT 100`)));

const byCase = new Map<string, string[]>();
for (const m of marks) {
  const row = rows.find((r) => r.root_span_id === m.root_span_id);
  if (!row) continue;
  const lost = Object.keys(m.scores).join(", ");
  const key = `${row.metadata.category} · ${row.metadata.name}`;
  byCase.set(key, [...(byCase.get(key) ?? []), `  ✗ ${lost}  ${JSON.stringify(m.metadata ?? {})}\n    wrote: ${row.output.said.replace(/\s+/g, " ").slice(0, 400)}`]);
}
for (const [key, lines] of [...byCase].sort()) console.log(`\n${key}\n${lines.join("\n")}`);
console.log(`\n${marks.length} failed marks in ${byCase.size} cases`);
