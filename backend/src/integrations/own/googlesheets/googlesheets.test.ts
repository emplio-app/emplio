import { afterEach, expect, test } from "bun:test";
import { z } from "zod";
import { listPolls, pollOnce } from "../../polls/index";
import { own } from "../index";
import { googlesheets } from "./index";
import { aggregate, columnIndex, letter } from "./rows";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
type Call = { url: URL; method: string; body: any };
const stub = (answer: (c: Call) => Response) => {
  const calls: Call[] = [];
  globalThis.fetch = (async (url: string, init: RequestInit = {}) => {
    const c = { url: new URL(String(url)), method: init.method ?? "GET", body: init.body ? JSON.parse(String(init.body)) : undefined };
    calls.push(c);
    return answer(c);
  }) as typeof fetch;
  return calls;
};
const login = { externalId: "c1", secret: "tok" };
const run = (a: string, i: unknown) => own.run(a, i, login, "o");
const TAB = { sheets: [{ properties: { sheetId: 0, title: "Leads" } }] };
const isMeta = (c: Call) => c.url.pathname === "/v4/spreadsheets/s1" && c.method === "GET";

test("reads run unasked (the read-only POSTs too), writes ask, every input is a usable schema", async () => {
  for (const r of ["values_get", "batch_get", "get_spreadsheet_info", "get_spreadsheet_by_data_filter", "spreadsheets_values_batch_get_by_data_filter", "search_developer_metadata", "read_rows", "lookup_spreadsheet_row", "query_table", "aggregate_column_data", "get_sheet_names", "search_spreadsheets"]) expect((await own.getAction(`googlesheets.${r}`))?.readOnly, r).toBe(true);
  for (const w of ["spreadsheets_values_append", "values_update", "clear_values", "spreadsheets_batch_update", "append_rows", "upsert_rows", "add_sheet", "delete_sheet", "sheet_from_json", "format_cell"]) expect((await own.getAction(`googlesheets.${w}`))?.readOnly, w).toBeFalsy();
  for (const a of Object.values(googlesheets.actions)) z.toJSONSchema(a.input, { io: "input" });
});

test("values_get encodes the range in the path", async () => {
  const calls = stub(() => json({ values: [] }));
  await run("googlesheets.values_get", { spreadsheetId: "s1", range: "My Sheet!A1:B2" });
  expect(calls[0]!.url.pathname).toBe("/v4/spreadsheets/s1/values/My%20Sheet!A1%3AB2");
});

test("spreadsheets_batch_update passes requests through deep, and append says how to read values", async () => {
  const calls = stub(() => json({ replies: [] }));
  const requests = [{ repeatCell: { range: { sheetId: 0 }, cell: { userEnteredFormat: { textFormat: { bold: true } } }, fields: "userEnteredFormat.textFormat.bold" } }];
  await run("googlesheets.spreadsheets_batch_update", { spreadsheetId: "s1", requests });
  expect(calls[0]!.body).toEqual({ requests });
  await run("googlesheets.spreadsheets_values_append", { spreadsheetId: "s1", range: "A1", values: [[1]], valueInputOption: "USER_ENTERED" });
  expect(calls[1]!.url.pathname).toBe("/v4/spreadsheets/s1/values/A1:append");
  expect(calls[1]!.url.searchParams.get("valueInputOption")).toBe("USER_ENTERED");
  expect(calls[1]!.body.values).toEqual([[1]]);
});

test("append_rows maps objects onto the headings, and works out the tab", async () => {
  const calls = stub((c) => (isMeta(c) ? json(TAB) : c.url.pathname.includes("1%3A1") ? json({ values: [["Name", "Qty"]] }) : json({ updates: {} })));
  await run("googlesheets.append_rows", { spreadsheetId: "s1", rows: [{ Qty: 5, Name: "Asha" }] });
  const append = calls.at(-1)!;
  expect(append.url.pathname).toBe("/v4/spreadsheets/s1/values/'Leads':append");
  expect(append.url.searchParams.get("valueInputOption")).toBe("USER_ENTERED");
  expect(append.body.values).toEqual([["Asha", 5]]);
});

test("read_rows, lookup and query work on the header row", async () => {
  stub((c) => (isMeta(c) ? json(TAB) : json({ values: [["Name", "City"], ["Asha", "Pune"], ["Ravi", "Delhi"]] })));
  expect(await run("googlesheets.read_rows", { spreadsheetId: "s1" })).toEqual({ columns: ["Name", "City"], rows: [{ Name: "Asha", City: "Pune" }, { Name: "Ravi", City: "Delhi" }], total: 2 });
  expect(await run("googlesheets.lookup_spreadsheet_row", { spreadsheetId: "s1", query: " RAVI ", column: "name" })).toEqual({ found: true, rowNumber: 3, row: { Name: "Ravi", City: "Delhi" }, values: ["Ravi", "Delhi"] });
  expect(await run("googlesheets.query_table", { spreadsheetId: "s1", column: "City", value: "pune", select: ["Name"] })).toEqual({ columns: ["Name"], rows: [{ Name: "Asha" }], count: 1 });
  await expect(run("googlesheets.query_table", { spreadsheetId: "s1", orderBy: "Zip Code" })).rejects.toThrow("no column");
});

test("upsert updates the match by key and adds the rest", async () => {
  const calls = stub((c) => {
    if (isMeta(c)) return json(TAB);
    if (c.method === "GET") return json({ values: [["Email", "Status"], ["a@b.co", "Open"]] });
    return json({});
  });
  expect(await run("googlesheets.upsert_rows", { spreadsheetId: "s1", keyColumn: "Email", rows: [{ Email: "a@b.co", Status: "Paid" }, { Email: "new@b.co", Status: "Open" }] })).toEqual({ updated: 1, added: 1 });
  const update = calls.find((c) => c.url.pathname.endsWith("values:batchUpdate"))!;
  expect(update.body.data[1]).toEqual({ range: "'Leads'!A2", values: [["a@b.co", "Paid"]] });
  const append = calls.find((c) => c.url.pathname.endsWith(":append"))!;
  expect(append.body.values).toEqual([["new@b.co", "Open"]]);
});

test("rows helpers", () => {
  expect(columnIndex(["Name", "City"], "city")).toBe(1);
  expect(columnIndex(["Name", "City"], "C")).toBe(2);
  expect(letter(27)).toBe("AB");
  expect(aggregate(["1", "2,000", "x"], "sum")).toBe(2001);
  expect(aggregate(["1", "3"], "average")).toBe(2);
  expect(aggregate([], "max")).toBeNull();
});

test("every trigger Composio has is here", () => {
  expect(listPolls("googlesheets").length).toBe(16);
});

test("polled: only new rows, and the filter holds", async () => {
  let values = [["Name", "City"], ["Asha", "Pune"]];
  const calls = stub((c) => (isMeta(c) ? json(TAB) : json({ values })));
  const c = { spreadsheet_id: "s1", column: "City", value: "Delhi" };
  const first = await pollOnce("googlesheets.new_rows_trigger", c, null, run);
  expect(first.fresh).toEqual([]);
  expect(calls.at(-1)!.url.pathname).toBe("/v4/spreadsheets/s1/values/'Leads'");
  values = [...values, ["Ravi", "Delhi"], ["Mira", "Goa"]];
  const later = await pollOnce("googlesheets.new_rows_trigger", c, first.seen, run);
  expect(later.fresh).toEqual([{ spreadsheet_id: "s1", row: { Name: "Ravi", City: "Delhi", row_number: 3 } }]);
});

test("polled: a watched range reports a change once, and a new tab shows up", async () => {
  let values: unknown[][] = [[1]];
  stub(() => json({ values }));
  const c = { spreadsheet_id: "s1", range: "A1:A1" };
  const first = await pollOnce("googlesheets.cell_range_values_changed_trigger", c, null, run);
  values = [[2]];
  const later = await pollOnce("googlesheets.cell_range_values_changed_trigger", c, first.seen, run);
  expect(later.fresh).toEqual([{ spreadsheet_id: "s1", values: [[2]] }]);
  expect((await pollOnce("googlesheets.cell_range_values_changed_trigger", c, later.seen, run)).fresh).toEqual([]);
  let sheets = [{ properties: { sheetId: 0, title: "A" } }];
  stub(() => json({ sheets }));
  const tabs = await pollOnce("googlesheets.new_sheet_added_trigger", { spreadsheet_id: "s1" }, null, run);
  sheets = [...sheets, { properties: { sheetId: 7, title: "B" } }];
  expect((await pollOnce("googlesheets.new_sheet_added_trigger", { spreadsheet_id: "s1" }, tabs.seen, run)).fresh).toEqual([{ spreadsheet_id: "s1", sheet: { sheetId: 7, title: "B" } }]);
});

test("polled: a new spreadsheet is looked for in Drive, among what Emplio can see", async () => {
  const calls = stub(() => json({ files: [{ id: "f1", createdTime: new Date().toISOString() }] }));
  const out = await pollOnce("googlesheets.new_spreadsheet_created_trigger", {}, [], run);
  expect((out.fresh[0] as any).file.id).toBe("f1");
  expect(calls[0]!.url.href).toStartWith("https://www.googleapis.com/drive/v3/files?");
});
