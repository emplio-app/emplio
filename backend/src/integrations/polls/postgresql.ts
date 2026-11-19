// Database triggers, polled through the app's own read actions (own/sql): a new row, a changed row, or a saved
// query whose answer changed. polls/mysql.ts is the same for MySQL.
import { createHash } from "node:crypto";
import { z } from "zod";
import type { PollTrigger } from "./index";

// ponytail: the newest 100 rows by the column each check; more than 100 new rows between checks and the older ones are missed
const LATEST = 100;

export function sqlPolls(app: "postgresql" | "mysql"): Record<string, PollTrigger> {
  const table = z.string().min(1).describe("The table to watch");
  const schema = z.string().optional().describe(app === "postgresql" ? 'Its schema (default "public")' : "Its database (default: the one in the connection)");
  const filters = z.array(z.object({ column: z.string(), op: z.string().default("="), value: z.unknown().optional() })).optional().describe("Only rows meeting these conditions, as in find_rows");
  const latest = async (run: (a: string, i: unknown) => Promise<unknown>, c: { table: string; schema?: string; filters?: unknown[] }, column: string) =>
    ((await run(`${app}.find_rows`, { table: c.table, schema: c.schema, filters: c.filters, order_by: column, descending: true, limit: LATEST })) as { rows: Record<string, unknown>[] }).rows;
  const row = [{ name: "row", type: "object", required: true, description: "The row, column → value" }];

  return {
    new_row: {
      description: `A row is added to a ${app === "postgresql" ? "PostgreSQL" : "MySQL"} table (checked every 5 minutes by default). Needs a column that grows with each new row: an auto-increment id or a created-at time.`,
      config: z.object({
        table,
        schema,
        column: z.string().default("id").describe('A column that grows with each new row: an auto-increment id or a created-at time (default "id")'),
        id_column: z.string().optional().describe("The column that tells rows apart, when `column` is a time (default: `column` itself)"),
        filters,
      }),
      output: row,
      every: 5,
      min: 1,
      async poll(c, run) {
        return (await latest(run, c, c.column)).map((r) => ({ id: String(r[c.id_column ?? c.column]), item: { row: r } }));
      },
    },
    row_updated: {
      description: `A row in a ${app === "postgresql" ? "PostgreSQL" : "MySQL"} table is changed (or added). Needs an updated-at column the app sets on every change.`,
      config: z.object({
        table,
        schema,
        column: z.string().default("updated_at").describe('The column set to the time of each change (default "updated_at")'),
        id_column: z.string().default("id").describe('The column that tells rows apart (default "id")'),
        filters,
      }),
      output: row,
      every: 5,
      min: 1,
      async poll(c, run) {
        return (await latest(run, c, c.column)).map((r) => ({ id: `${String(r[c.id_column])}:${JSON.stringify(r[c.column])}`, item: { row: r } }));
      },
    },
    query_result_changed: {
      description: `A saved read-only query on the ${app === "postgresql" ? "PostgreSQL" : "MySQL"} database gives a different answer than last time, e.g. "stock below 5" or "orders waiting over a day".`,
      config: z.object({
        query: z.string().min(1).describe("One read-only query (SELECT…), as for run_query; add an ORDER BY so the same rows come back in the same order"),
        params: z.array(z.unknown()).optional().describe(`Values for its ${app === "postgresql" ? "$1, $2…" : "?"} placeholders`),
      }),
      output: [
        { name: "rows", type: "object[]", required: true, description: "The query's rows now" },
        { name: "row_count", type: "number", required: true, description: "How many rows" },
      ],
      every: 5,
      min: 1,
      // ponytail: one id per answer, so an answer seen before (within the last 1000 checks' ids) doesn't fire again
      async poll(c, run) {
        const out = (await run(`${app}.run_query`, { query: c.query, params: c.params })) as { rows: unknown[]; row_count: number };
        return [{ id: createHash("sha256").update(JSON.stringify(out.rows)).digest("hex"), item: { rows: out.rows, row_count: out.row_count } }];
      },
    },
  };
}

export const postgresql = sqlPolls("postgresql");
