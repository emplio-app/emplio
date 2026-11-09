// Google Sheets on sign-in: every method of its API from its Discovery document (`bun scripts/openapi-actions.ts googlesheets`), each common
// request inside batchUpdate as its own action the way Composio had them, and rows as rows. Drive reach is limited to files Emplio made (google-drive.ts).
import { z } from "zod";
import { AppsError } from "../../types";
import { exportFile, fileMetadata, listChanges, moveFile, searchFiles } from "../google-drive";
import { googleApi, googleCheck, googleOAuth } from "../google-login";
import type { OwnAction, OwnApp } from "../index";
import { call, type Send, specActions } from "../openapi";
import { aggregate, columnIndex, letter, quoteSheet, same, toObject } from "./rows";

const api = googleApi("Google Sheets", "https://sheets.googleapis.com");
const actions = await specActions(new URL("./actions.json", import.meta.url), api);

const ROOT = "/v4/spreadsheets/{spreadsheetId}";
const BATCH: Send = { method: "POST", path: `${ROOT}:batchUpdate`, query: [], headers: [], body: { kind: "fields", fields: [["requests", "requests"]] } };
const META: Send = { method: "GET", path: ROOT, query: ["fields", "ranges"], headers: [] };
const VALUES: Send = { method: "GET", path: `${ROOT}/values/{range}`, query: [], headers: [] };
const WRITE: Send = { method: "PUT", path: `${ROOT}/values/{range}`, query: ["valueInputOption"], headers: [], body: { kind: "fields", fields: [["values", "values"]] } };
const APPEND: Send = { method: "POST", path: `${ROOT}/values/{range}:append`, query: ["valueInputOption", "insertDataOption"], headers: [], body: { kind: "fields", fields: [["values", "values"]] } };
const MANY: Send = { method: "POST", path: `${ROOT}/values:batchUpdate`, query: [], headers: [], body: { kind: "fields", fields: [["valueInputOption", "valueInputOption"], ["data", "data"]] } };
const CREATE: Send = { method: "POST", path: "/v4/spreadsheets", query: [], headers: [], body: { kind: "fields", fields: [["properties", "properties"]] } };

export const SPREADSHEET_ID = z.string().describe("The spreadsheet's id, the long part of its link: docs.google.com/spreadsheets/d/<id>/edit");
const spreadsheetId = SPREADSHEET_ID;
const open = z.record(z.string(), z.any());
const sheet = z.string().optional().describe("Which tab, by name (default: the first)");
const sheetId = z.number().int().describe("The tab's number id, from googlesheets.get_sheet_names (0 is usually the first tab)");
const grid = open.describe('Cells by number, counting from 0, end not included: {"sheetId": 0, "startRowIndex": 0, "endRowIndex": 5, "startColumnIndex": 0, "endColumnIndex": 2}');
const dimensions = open.describe('Rows or columns by number, counting from 0, end not included: {"sheetId": 0, "dimension": "ROWS", "startIndex": 1, "endIndex": 3}');
const fields = (eg: string) => z.string().describe(`Which settings to change, like ${eg}`);
const table = z.string().optional().describe("A table by name, a tab's name or a range like Sheet1!A1:D50 (default: the first tab)");
const inputOption = z.enum(["USER_ENTERED", "RAW"]).default("USER_ENTERED").describe("USER_ENTERED (default) reads values as if typed, so =SUM(A1:A3) works; RAW stores exactly what's given");

type Grid = { sheets?: { properties: { sheetId: number; title: string }; tables?: any[]; charts?: any[]; conditionalFormats?: any[]; data?: any[] }[] };
const meta = (key: string, id: string, fields: string, ranges?: string[]) => call(api, key, META, { spreadsheetId: id, fields, ranges }) as Promise<Grid>;
const firstSheet = async (key: string, id: string) => {
  const title = (await meta(key, id, "sheets.properties.title")).sheets?.[0]?.properties.title;
  if (!title) throw new AppsError("this spreadsheet has no tabs");
  return title;
};
const tab = async (key: string, id: string, s?: string) => quoteSheet(s ?? (await firstSheet(key, id)));
const valuesOf = async (key: string, id: string, range: string) => ((await call(api, key, VALUES, { spreadsheetId: id, range })) as { values?: unknown[][] }).values ?? [];

// a table's name becomes its range; anything else is already a range or a tab's name
async function rangeOf(key: string, id: string, what?: string) {
  if (what?.includes("!")) return what;
  if (!what) return tab(key, id);
  const grid = await meta(key, id, "sheets(properties.title,tables(name,range))");
  for (const s of grid.sheets ?? []) {
    const t = s.tables?.find((x) => x.name === what);
    if (t) {
      const r = t.range;
      return `${quoteSheet(s.properties.title)}!${letter(r.startColumnIndex ?? 0)}${(r.startRowIndex ?? 0) + 1}:${letter((r.endColumnIndex ?? 1) - 1)}${r.endRowIndex ?? ""}`;
    }
  }
  return quoteSheet(what);
}

const readRows = async (key: string, id: string, what?: string) => {
  const values = await valuesOf(key, id, await rangeOf(key, id, what));
  return { header: values[0] ?? [], rows: values.slice(1) };
};

// one of batchUpdate's requests as an action; `build` turns the input into the request
const one = (request: string, description: string, shape: z.ZodRawShape, build: (i: any) => unknown = (i) => i): OwnAction => ({
  description,
  input: z.object({ spreadsheetId, ...shape }).loose(),
  run: ({ spreadsheetId: id, ...rest }, key) => call(api, key, BATCH, { spreadsheetId: id, requests: [{ [request]: build(rest) }] }),
});
const insertOne = (dimension: "ROWS" | "COLUMNS") => ({ sheetId: id, index, inheritFromBefore }: { sheetId: number; index: number; inheritFromBefore?: boolean }) => ({
  range: { sheetId: id, dimension, startIndex: index, endIndex: index + 1 },
  ...(inheritFromBefore !== undefined && { inheritFromBefore }),
});

const singles: Record<string, OwnAction> = {
  add_sheet: one("addSheet", "Add a tab to a spreadsheet.", { properties: open.describe('Its settings, e.g. {"title": "Leads"}') }),
  delete_sheet: one("deleteSheet", "Delete a tab and everything on it.", { sheetId }),
  update_sheet_properties: one("updateSheetProperties", "Rename a tab, hide it, freeze rows and the like.", { properties: open.describe('The tab and the new values: {"sheetId": 0, "title": "Leads"}'), fields: fields("title or gridProperties.frozenRowCount") }),
  update_spreadsheet_properties: one("updateSpreadsheetProperties", "Change the spreadsheet's title, time zone or locale.", { properties: open.describe('The new values: {"title": "2026 budget"}'), fields: fields("title or timeZone") }),
  append_dimension: one("appendDimension", "Add empty rows or columns at the end of a tab.", { sheetId, dimension: z.enum(["ROWS", "COLUMNS"]), length: z.number().int().describe("How many") }),
  insert_dimension: one("insertDimension", "Insert empty rows or columns.", { range: dimensions, inheritFromBefore: z.boolean().optional().describe("Copy the formatting from before them") }),
  delete_dimension: one("deleteDimension", "Delete rows or columns.", { range: dimensions }),
  auto_resize_dimensions: one("autoResizeDimensions", "Resize rows or columns to fit their contents.", { dimensions }),
  update_dimension_properties: one("updateDimensionProperties", "Set the size of rows or columns, or hide them.", { range: dimensions, properties: open.describe('The new values: {"pixelSize": 200} or {"hiddenByUser": true}'), fields: fields("pixelSize") }),
  create_spreadsheet_row: one("insertDimension", "Insert one empty row.", { sheetId, index: z.number().int().describe("Where, counting from 0"), inheritFromBefore: z.boolean().optional().describe("Copy the formatting from the row above") }, insertOne("ROWS")),
  create_spreadsheet_column: one("insertDimension", "Insert one empty column.", { sheetId, index: z.number().int().describe("Where, counting from 0"), inheritFromBefore: z.boolean().optional().describe("Copy the formatting from the column before") }, insertOne("COLUMNS")),
  find_replace: one("findReplace", "Find and replace text across a spreadsheet, one tab or a range.", { find: z.string().describe("The text to find"), replacement: z.string().describe("What to put instead"), allSheets: z.boolean().optional().describe("Every tab"), sheetId: sheetId.optional(), range: grid.optional(), matchCase: z.boolean().optional() }),
  format_cell: one("repeatCell", "Format a block of cells: bold, colours, font size, number format.", { range: grid, format: open.describe('The look, in Google\'s cell format: {"textFormat": {"bold": true}, "backgroundColor": {"red": 1, "green": 0.9, "blue": 0.6}}'), fields: z.string().default("userEnteredFormat").describe("Which parts to change") }, ({ range, format, fields: f }) => ({ range, cell: { userEnteredFormat: format }, fields: f })),
  sort_range: one("sortRange", "Sort a block of cells by one or more columns.", { range: grid, sortSpecs: z.array(open).describe('How: [{"dimensionIndex": 0, "sortOrder": "ASCENDING"}]') }),
  set_basic_filter: one("setBasicFilter", "Put a filter on a tab.", { filter: open.describe('{"range": {...}, "filterSpecs": [...]}') }),
  clear_basic_filter: one("clearBasicFilter", "Remove a tab's filter.", { sheetId }),
  set_data_validation_rule: one("setDataValidation", "Limit what can be typed in some cells, such as a dropdown list. Leave out rule to remove it.", { range: grid, rule: open.optional().describe('{"condition": {"type": "ONE_OF_LIST", "values": [{"userEnteredValue": "Open"}]}, "showCustomUi": true}') }),
  create_chart: one("addChart", "Add a chart.", { chart: open.describe("The chart, in Google's EmbeddedChart format: spec and position") }),
  update_chart: one("updateChartSpec", "Change a chart.", { chartId: z.number().int().describe("From googlesheets.list_charts"), spec: open.describe("The chart's new settings, in Google's ChartSpec format") }),
  delete_chart: one("deleteEmbeddedObject", "Delete a chart.", { objectId: z.number().int().describe("The chart's id, from googlesheets.list_charts") }),
  move_chart: one("updateEmbeddedObjectPosition", "Move or resize a chart.", { objectId: z.number().int().describe("The chart's id, from googlesheets.list_charts"), newPosition: open.describe('Where: {"overlayPosition": {"anchorCell": {"sheetId": 0, "rowIndex": 1, "columnIndex": 4}}}'), fields: z.string().default("*").describe("Which settings to change") }),
};

const helpers: Record<string, OwnAction> = {
  get_sheet_names: { description: "List a spreadsheet's tabs: name, number id and size.", readOnly: true, input: z.object({ spreadsheetId }), run: async (i, key) => ({ sheets: (await meta(key, i.spreadsheetId, "sheets.properties")).sheets?.map((s) => s.properties) ?? [] }) },
  find_worksheet_by_title: {
    description: "Find a tab by its exact name.",
    readOnly: true,
    input: z.object({ spreadsheetId, title: z.string().describe("The tab's name") }),
    async run(i, key) {
      const hit = (await meta(key, i.spreadsheetId, "sheets.properties")).sheets?.find((s) => s.properties.title === i.title.trim());
      return hit ? { found: true, sheet: hit.properties } : { found: false };
    },
  },
  get_conditional_format_rules: { description: "List the conditional formatting on each tab.", readOnly: true, input: z.object({ spreadsheetId }), run: async (i, key) => ({ sheets: (await meta(key, i.spreadsheetId, "sheets(properties(sheetId,title),conditionalFormats)")).sheets ?? [] }) },
  get_data_validation_rules: {
    description: "List the cells that limit what can be typed (dropdowns and the like), with their rules. Large sheets are slow, so give ranges where you can.",
    readOnly: true,
    input: z.object({ spreadsheetId, ranges: z.array(z.string()).optional().describe("Only these ranges, like Sheet1!A1:D50 (default: everything)") }),
    async run(i, key) {
      const g = await meta(key, i.spreadsheetId, "sheets(properties(sheetId,title),data(startRow,startColumn,rowData.values.dataValidation))", i.ranges);
      const rules = (g.sheets ?? []).flatMap((s) =>
        (s.data ?? []).flatMap((d: any) =>
          (d.rowData ?? []).flatMap((r: any, row: number) =>
            (r.values ?? []).flatMap((c: any, col: number) => (c.dataValidation ? [{ sheet: s.properties.title, cell: `${letter((d.startColumn ?? 0) + col)}${(d.startRow ?? 0) + row + 1}`, rule: c.dataValidation }] : [])),
          ),
        ),
      );
      return { rules };
    },
  },
  list_charts: { description: "List the charts on each tab, with their ids.", readOnly: true, input: z.object({ spreadsheetId }), run: async (i, key) => ({ charts: (await meta(key, i.spreadsheetId, "sheets(properties.title,charts)")).sheets?.flatMap((s) => (s.charts ?? []).map((c) => ({ sheet: s.properties.title, ...c }))) ?? [] }) },
  list_tables: { description: "List the named tables in a spreadsheet.", readOnly: true, input: z.object({ spreadsheetId }), run: async (i, key) => ({ tables: (await meta(key, i.spreadsheetId, "sheets(properties.title,tables)")).sheets?.flatMap((s) => (s.tables ?? []).map((t) => ({ sheet: s.properties.title, ...t }))) ?? [] }) },
  get_table_schema: {
    description: "The columns of a table: their names, and their types where the table sets them.",
    readOnly: true,
    input: z.object({ spreadsheetId, table }),
    async run(i, key) {
      const { header, rows } = await readRows(key, i.spreadsheetId, i.table);
      const typed = i.table && (await meta(key, i.spreadsheetId, "sheets.tables(name,columnProperties)")).sheets?.flatMap((s) => s.tables ?? []).find((t) => t.name === i.table);
      return { columns: header, columnProperties: typed?.columnProperties, rows: rows.length };
    },
  },
  read_rows: {
    description: "Read a tab or range as rows, each row keyed by its column headings. The first row is taken as the headings.",
    readOnly: true,
    input: z.object({ spreadsheetId, table, limit: z.number().int().optional().describe("Only the first this many rows") }),
    async run(i, key) {
      const { header, rows } = await readRows(key, i.spreadsheetId, i.table);
      return { columns: header, rows: (i.limit ? rows.slice(0, i.limit) : rows).map((r) => toObject(header, r)), total: rows.length };
    },
  },
  query_table: {
    description: "Look through a table: keep rows matching a value, choose columns, sort, limit. Not SQL: one column equals one value.",
    readOnly: true,
    input: z.object({
      spreadsheetId,
      table,
      column: z.string().optional().describe("Keep rows where this column (by name or letter)..."),
      value: z.string().optional().describe("...equals this, ignoring capitals and spaces"),
      select: z.array(z.string()).optional().describe("Only these columns (default: all)"),
      orderBy: z.string().optional().describe("Sort by this column"),
      descending: z.boolean().optional(),
      limit: z.number().int().optional().describe("At most this many rows"),
    }),
    async run(i, key) {
      const { header, rows } = await readRows(key, i.spreadsheetId, i.table);
      let kept = rows;
      if (i.column) {
        const c = columnIndex(header, i.column);
        kept = kept.filter((r) => same(r[c], i.value));
      }
      if (i.orderBy) {
        const c = columnIndex(header, i.orderBy);
        kept = [...kept].sort((a, b) => String(a[c] ?? "").localeCompare(String(b[c] ?? ""), undefined, { numeric: true }) * (i.descending ? -1 : 1));
      }
      if (i.limit) kept = kept.slice(0, i.limit);
      const chosen = (i.select ?? (header as string[])).map(String);
      return { columns: chosen, rows: kept.map((r) => Object.fromEntries(chosen.map((c: string) => [c, r[columnIndex(header, c)] ?? ""]))), count: kept.length };
    },
  },
  lookup_spreadsheet_row: {
    description: "Find the first row where a value appears: in one column, or anywhere. Capitals and spaces around the value don't matter.",
    readOnly: true,
    input: z.object({ spreadsheetId, table, query: z.string().describe("The value to look for"), column: z.string().optional().describe("Only this column, by name or letter") }),
    async run(i, key) {
      const { header, rows } = await readRows(key, i.spreadsheetId, i.table);
      const c = i.column ? columnIndex(header, i.column) : -1;
      const at = rows.findIndex((r) => (c >= 0 ? same(r[c], i.query) : r.some((v) => same(v, i.query))));
      // +2: rows counted from 1, and the header is row 1
      return at < 0 ? { found: false } : { found: true, rowNumber: at + 2, row: toObject(header, rows[at]!), values: rows[at] };
    },
  },
  aggregate_column_data: {
    description: "Add up, average, count, or find the minimum, maximum or share of a column, across all rows or only those matching a value.",
    readOnly: true,
    input: z.object({
      spreadsheetId,
      table,
      column: z.string().describe("The column to work on, by name or letter"),
      operation: z.enum(["sum", "average", "count", "min", "max", "percentage"]),
      where: z.string().optional().describe("Only rows where this column (by name or letter)..."),
      equals: z.string().optional().describe("...equals this. For percentage: the share of rows that do"),
    }),
    async run(i, key) {
      const { header, rows } = await readRows(key, i.spreadsheetId, i.table);
      const w = i.where ? columnIndex(header, i.where) : -1;
      const kept = w >= 0 ? rows.filter((r) => same(r[w], i.equals)) : rows;
      const c = columnIndex(header, i.column);
      return { operation: i.operation, column: i.column, result: aggregate(kept.map((r) => r[c]).filter((v) => v !== undefined && v !== ""), i.operation, rows.length), rows: kept.length };
    },
  },
  append_rows: {
    description: "Add rows at the bottom of a tab. Give lists in column order, or objects keyed by column heading.",
    input: z.object({
      spreadsheetId,
      sheet,
      rows: z.array(z.union([z.array(z.any()), open])).min(1).describe('The rows: [["Asha", 5]] or [{"Name": "Asha", "Qty": 5}]'),
      valueInputOption: inputOption,
    }),
    async run(i, key) {
      const range = await tab(key, i.spreadsheetId, i.sheet);
      let values = i.rows;
      if (i.rows.some((r: unknown) => !Array.isArray(r))) {
        const header = (await valuesOf(key, i.spreadsheetId, `${range}!1:1`))[0] ?? [];
        values = i.rows.map((r: any) => (Array.isArray(r) ? r : header.map((h) => r[String(h)] ?? "")));
      }
      return call(api, key, APPEND, { spreadsheetId: i.spreadsheetId, range, values, valueInputOption: i.valueInputOption, insertDataOption: "INSERT_ROWS" });
    },
  },
  upsert_rows: {
    description: "Update rows that match on a key column and add the rest at the bottom. Columns are found by heading; missing ones are added to the header row.",
    input: z.object({
      spreadsheetId,
      sheet,
      keyColumn: z.string().describe("The column that identifies a row, like Email"),
      rows: z.array(open).min(1).describe('The rows, keyed by column heading: [{"Email": "a@b.co", "Status": "Paid"}]'),
      valueInputOption: inputOption,
    }),
    async run(i, key) {
      const range = await tab(key, i.spreadsheetId, i.sheet);
      const all = await valuesOf(key, i.spreadsheetId, range);
      const header = [...(all[0] ?? [])].map(String);
      for (const r of i.rows) for (const k of Object.keys(r)) if (!header.includes(k)) header.push(k);
      if (!header.includes(i.keyColumn)) throw new AppsError(`no column "${i.keyColumn}" in the rows or the sheet`);
      const keyAt = header.indexOf(i.keyColumn);
      const where = new Map(all.slice(1).map((r, n) => [String(r[keyAt] ?? "").trim().toLowerCase(), n] as const));
      const data: { range: string; values: unknown[][] }[] = [{ range: `${range}!A1`, values: [header] }];
      const fresh: unknown[][] = [];
      for (const r of i.rows) {
        const n = where.get(String(r[i.keyColumn] ?? "").trim().toLowerCase());
        if (n === undefined) fresh.push(header.map((h) => r[h] ?? ""));
        else data.push({ range: `${range}!A${n + 2}`, values: [header.map((h, c) => (h in r ? r[h] : (all[n + 1]![c] ?? "")))] });
      }
      await call(api, key, MANY, { spreadsheetId: i.spreadsheetId, valueInputOption: i.valueInputOption, data });
      if (fresh.length) await call(api, key, APPEND, { spreadsheetId: i.spreadsheetId, range, values: fresh, valueInputOption: i.valueInputOption, insertDataOption: "INSERT_ROWS" });
      return { updated: data.length - 1, added: fresh.length };
    },
  },
  sheet_from_json: {
    description: "Make a new spreadsheet from a list of objects: the keys become the headings.",
    input: z.object({ title: z.string().describe("The spreadsheet's name"), rows: z.array(open).describe('The rows: [{"Name": "Asha", "Qty": 5}]') }),
    async run(i, key) {
      const made = (await call(api, key, CREATE, { properties: { title: i.title } })) as { spreadsheetId: string; spreadsheetUrl?: string };
      const header = [...new Set(i.rows.flatMap((r: object) => Object.keys(r)))] as string[];
      if (header.length) await call(api, key, WRITE, { spreadsheetId: made.spreadsheetId, range: "A1", valueInputOption: "USER_ENTERED", values: [header, ...i.rows.map((r: any) => header.map((h) => r[h] ?? ""))] });
      return { spreadsheetId: made.spreadsheetId, url: made.spreadsheetUrl };
    },
  },
  batch_update: {
    description: "Write values into a range, or add them as new rows if no start cell is given.",
    input: z.object({
      spreadsheetId,
      sheet,
      range: z.string().optional().describe("Where to start, like A2 or Sheet1!C3. Leave out to add below what's there"),
      values: z.array(z.array(z.any())).describe('The values, row by row: [["Asha", 5]]'),
      valueInputOption: inputOption,
    }),
    run: async (i, key) => {
      const { spreadsheetId: id, values, valueInputOption } = i;
      const base = await tab(key, id, i.sheet);
      if (i.range) return call(api, key, WRITE, { spreadsheetId: id, range: i.range.includes("!") ? i.range : `${base}!${i.range}`, values, valueInputOption });
      return call(api, key, APPEND, { spreadsheetId: id, range: base, values, valueInputOption, insertDataOption: "INSERT_ROWS" });
    },
  },
  mutate_conditional_format_rules: {
    description: "Add, replace, remove or reorder a tab's conditional formatting. Rules are numbered from 0 in the order googlesheets.get_conditional_format_rules lists them.",
    input: z.object({
      spreadsheetId,
      sheetId,
      operation: z.enum(["ADD", "UPDATE", "DELETE", "MOVE"]),
      index: z.number().int().default(0).describe("Which rule (ADD: where it goes)"),
      newIndex: z.number().int().optional().describe("Where a MOVE puts it"),
      rule: open.optional().describe('The rule, for ADD and UPDATE, in Google\'s ConditionalFormatRule format, with "ranges" and a booleanRule or gradientRule'),
    }),
    run: (i, key) => {
      const request =
        i.operation === "ADD" ? { addConditionalFormatRule: { rule: i.rule, index: i.index } }
        : i.operation === "UPDATE" ? { updateConditionalFormatRule: { index: i.index, sheetId: i.sheetId, rule: i.rule } }
        : i.operation === "DELETE" ? { deleteConditionalFormatRule: { index: i.index, sheetId: i.sheetId } }
        : { updateConditionalFormatRule: { index: i.index, sheetId: i.sheetId, newIndex: i.newIndex } };
      return call(api, key, BATCH, { spreadsheetId: i.spreadsheetId, requests: [request] });
    },
  },
};

export const GOOGLE_SHEET = "application/vnd.google-apps.spreadsheet";
const drive: Record<string, OwnAction> = {
  search_spreadsheets: searchFiles(GOOGLE_SHEET, "spreadsheets"),
  get_drive_file_metadata: fileMetadata,
  export_drive_file: exportFile(),
  export_sheet_as_pdf: exportFile({ mimeType: "application/pdf", extension: "pdf" }),
  move_spreadsheet_to_folder: moveFile,
  list_drive_changes: listChanges,
};

export const googlesheets: OwnApp = {
  app: "googlesheets",
  name: "Google Sheets",
  logo: "/logos/googlesheets.svg",
  check: googleCheck,
  oauth: googleOAuth("Google Sheets", "googlesheets"),
  actions: { ...actions, ...singles, ...helpers, ...drive, get_batch_values: actions.batch_get! },
};
