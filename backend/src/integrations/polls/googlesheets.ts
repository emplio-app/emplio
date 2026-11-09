import { z } from "zod";
import { recent, type PollTrigger, type Run } from "./index";

const stamp = (v: unknown) => Bun.hash(JSON.stringify(v)).toString(36);
const SHEET = { spreadsheet_id: z.string().describe("The spreadsheet to watch: the long part of its link, docs.google.com/spreadsheets/d/<id>/edit") };
const ONLY_OURS = "Only spreadsheets Emplio made: Google doesn't let it see the rest of the person's Drive";
const RANGE = z.string().describe("A range like Sheet1!A1:D50, or a tab's name");
const TABLE = { table: z.string().optional().describe("A table by name, a tab's name or a range like Sheet1!A1:D50 (default: the first tab)") };
const FILTER = { column: z.string().optional().describe("Only rows where this column (by name or letter)..."), value: z.string().optional().describe("...equals this") };

const output = (name: string, description: string): PollTrigger["output"] => [
  { name: "spreadsheet_id", type: "string", required: true, description: "The spreadsheet's id" },
  { name, type: "object", required: true, description },
];
const meta = (run: Run, id: string, fields: string) => run("googlesheets.get_spreadsheet_info", { spreadsheetId: id, fields }) as Promise<any>;
const values = (run: Run, id: string, range: string) => run("googlesheets.values_get", { spreadsheetId: id, range }) as Promise<{ range?: string; values?: unknown[][] }>;

// reported whenever what it reads differs from every earlier check; a change back to an earlier state isn't new, so no report
const snapshot = (description: string, field: string, shape: z.ZodRawShape, read: (c: any, run: Run) => Promise<unknown>): PollTrigger => ({
  description: `${description}.`,
  config: z.object({ ...SHEET, ...shape }),
  output: output(field, `What's there now (${field})`),
  every: 5,
  min: 5,
  async poll(c, run) {
    const value = await read(c, run);
    return [{ id: stamp(value), item: { spreadsheet_id: c.spreadsheet_id, [field]: value } }];
  },
});
const inDrive = (description: string, input: (c: any) => Record<string, unknown>, keep: (f: any) => boolean, config: z.ZodRawShape = {}): PollTrigger => ({
  description: `${description}. ${ONLY_OURS}.`,
  config: z.object(config),
  output: [{ name: "file", type: "object", required: true, description: "The Drive file: id, name, createdTime, modifiedTime, webViewLink" }],
  every: 5,
  min: 5,
  poll: async (c, run) => (((await run("googlesheets.search_spreadsheets", { pageSize: 100, ...input(c) })) as any).files ?? []).filter(keep).map((file: any) => ({ id: file.id, item: { file } })),
});
const query = (c: any, run: Run) => run("googlesheets.query_table", { spreadsheetId: c.spreadsheet_id, table: c.table, column: c.column, value: c.value });

export const googlesheets: Record<string, PollTrigger> = {
  new_rows_trigger: {
    description: "A new row is added at the bottom of a tab. A row inserted higher up pushes the last row down, which looks like a new one.",
    config: z.object({ ...SHEET, sheet: z.string().optional().describe("Which tab, by name (default: the first)"), ...FILTER }),
    output: output("row", "The row, keyed by its column headings, and row_number"),
    every: 5,
    min: 5,
    async poll({ spreadsheet_id, sheet, column, value }, run) {
      const { columns, rows } = (await run("googlesheets.read_rows", { spreadsheetId: spreadsheet_id, table: sheet })) as { columns: string[]; rows: Record<string, unknown>[] };
      const key = column && columns.find((c) => c.trim().toLowerCase() === column.trim().toLowerCase());
      // ponytail: the last 500 rows, so a very long sheet's seen list stays under the 1000 kept
      return rows
        .map((r, i) => ({ row: { ...r, row_number: i + 2 }, keep: !key || String(r[key]).trim().toLowerCase() === String(value).trim().toLowerCase() }))
        .slice(-500)
        .filter((r) => r.keep)
        .map(({ row }) => ({ id: `row:${row.row_number}`, item: { spreadsheet_id, row } }));
    },
  },
  new_sheet_added_trigger: {
    description: "A new tab is added to a spreadsheet.",
    config: z.object(SHEET),
    output: output("sheet", "The new tab: sheetId, title"),
    every: 5,
    min: 5,
    poll: async ({ spreadsheet_id }, run) => ((await meta(run, spreadsheet_id, "sheets.properties(sheetId,title)")).sheets ?? []).map((s: any) => ({ id: String(s.properties.sheetId), item: { spreadsheet_id, sheet: s.properties } })),
  },
  new_spreadsheet_created_trigger: inDrive("A new spreadsheet appears", () => ({ orderBy: "createdTime desc" }), (f) => recent(f.createdTime)),
  spreadsheet_search_match_trigger: inDrive("A new spreadsheet matches a saved search", (c) => ({ name: c.name, text: c.text }), () => true, { name: z.string().optional().describe("Names containing this"), text: z.string().optional().describe("Spreadsheets containing this text") }),
  worksheet_names_changed_trigger: snapshot("A tab is added, removed or renamed", "tabs", {}, async (c, run) => ((await meta(run, c.spreadsheet_id, "sheets.properties.title")).sheets ?? []).map((s: any) => s.properties.title)),
  cell_range_values_changed_trigger: snapshot("Values change in a range of cells", "values", { range: RANGE }, async (c, run) => (await values(run, c.spreadsheet_id, c.range)).values ?? []),
  filtered_range_values_changed_trigger: snapshot("Rows matching a value change: one is added, removed or edited", "rows", { ...TABLE, column: z.string().describe("The column to match, by name or letter"), value: z.string().describe("The value it must equal") }, async (c, run) => ((await query(c, run)) as any).rows),
  table_query_result_changed_trigger: snapshot("The rows a table lookup finds change. A column-equals-value lookup, not SQL", "rows", TABLE, async (c, run) => ((await query(c, run)) as any).rows),
  spreadsheet_row_changed_trigger: snapshot("One row, found by a value in it, changes, appears or disappears", "row", { ...TABLE, query: z.string().describe("The value that identifies the row"), column: z.string().optional().describe("Only look in this column") }, (c, run) => run("googlesheets.lookup_spreadsheet_row", { spreadsheetId: c.spreadsheet_id, table: c.table, query: c.query, column: c.column })),
  aggregate_metric_changed_trigger: snapshot(
    "A sum, average, count, minimum or maximum of a column changes",
    "metric",
    { ...TABLE, target_column: z.string().describe("The column to work on"), operation: z.enum(["sum", "average", "count", "min", "max"]).default("sum"), ...FILTER },
    (c, run) => run("googlesheets.aggregate_column_data", { spreadsheetId: c.spreadsheet_id, table: c.table, column: c.target_column, operation: c.operation, where: c.column, equals: c.value }),
  ),
  table_schema_changed_trigger: snapshot("A table's columns change: added, removed or renamed", "columns", TABLE, async (c, run) => ((await run("googlesheets.get_table_schema", { spreadsheetId: c.spreadsheet_id, table: c.table })) as any).columns),
  conditional_format_rule_changed_trigger: snapshot("Conditional formatting is added, changed or removed", "rules", {}, (c, run) => meta(run, c.spreadsheet_id, "sheets(properties.sheetId,conditionalFormats)")),
  data_validation_rule_changed_trigger: snapshot("A dropdown or other limit on what can be typed is added, changed or removed. Big sheets are slow, so set ranges where you can", "rules", { ranges: z.array(z.string()).optional().describe("Only these ranges (default: everything)") }, async (c, run) => ((await run("googlesheets.get_data_validation_rules", { spreadsheetId: c.spreadsheet_id, ranges: c.ranges })) as any).rules),
  developer_metadata_changed_trigger: snapshot("Developer metadata on the spreadsheet is added, changed or removed", "metadata", {}, (c, run) => meta(run, c.spreadsheet_id, "developerMetadata,sheets(properties.sheetId,developerMetadata)")),
  spreadsheet_properties_changed_trigger: snapshot("The spreadsheet's title, time zone, locale or calculation settings change", "properties", {}, async (c, run) => (await meta(run, c.spreadsheet_id, "properties")).properties),
  spreadsheet_metadata_changed_trigger: snapshot("The spreadsheet's details change: its settings, tabs, named ranges or data sources", "metadata", {}, (c, run) => meta(run, c.spreadsheet_id, "properties,sheets.properties,namedRanges,developerMetadata,dataSources")),
};
