import { afterEach, expect, test } from "bun:test";
import { z } from "zod";
import { listPolls, pollOnce } from "../../polls/index";
import { AppFile, AppsError } from "../../types";
import { own } from "../index";
import { airtable } from "./index";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
type Call = { url: string; method: string; body: any; headers: Record<string, string> };
const stub = (answer: (c: Call) => Response = () => json({})) => {
  const calls: Call[] = [];
  globalThis.fetch = (async (url: string, init: RequestInit = {}) => {
    const c = { url: String(url), method: init.method ?? "GET", body: init.body ? JSON.parse(String(init.body)) : undefined, headers: init.headers as Record<string, string> };
    calls.push(c);
    return answer(c);
  }) as typeof fetch;
  return calls;
};
const login = { externalId: "c1", secret: "patX" };
const B = "https://api.airtable.com/v0";

test("a token is checked and labelled, a bad one is refused", async () => {
  const calls = stub(() => json({ id: "usr1", email: "a@b.co", scopes: [] }));
  expect(await own.connectWithKey!("airtable", " patX ")).toEqual({ secret: "patX", label: "a@b.co" });
  expect(calls[0]!.url).toBe(`${B}/meta/whoami`);
  expect(calls[0]!.headers.Authorization).toBe("Bearer patX");
  stub(() => json({ error: { type: "AUTHENTICATION_REQUIRED", message: "no" } }, 401));
  await expect(own.connectWithKey!("airtable", "nope")).rejects.toBeInstanceOf(AppsError);
});

test("reads run unasked, writes ask, and every input is a usable schema", async () => {
  for (const read of ["list_records", "get_record", "list_bases", "get_base_schema", "get_base_metadata", "list_comments", "who_am_i", "get_attachment_info"]) expect((await own.getAction(`airtable.${read}`))?.readOnly).toBe(true);
  for (const write of ["create_record", "create_records", "update_record", "delete_record", "delete_multiple_records", "create_table", "create_comment", "create_webhook", "upload_attachment"]) expect((await own.getAction(`airtable.${write}`))?.readOnly).toBeFalsy();
  for (const a of Object.values(airtable.actions)) z.toJSONSchema(a.input, { io: "input" });
});

test("records go in Airtable's shape", async () => {
  const calls = stub(() => json({ records: [] }));
  await own.run("airtable.create_record", { base_id: "app1", table: "Leads", fields: { Name: "Asha" }, typecast: true }, login, "o");
  expect(calls[0]!.url).toBe(`${B}/app1/Leads`);
  expect(calls[0]!.method).toBe("POST");
  expect(calls[0]!.body).toEqual({ fields: { Name: "Asha" }, typecast: true });
  await own.run("airtable.create_records", { base_id: "app1", table: "Leads", records: [{ fields: { Name: "A" } }] }, login, "o");
  expect(calls[1]!.body).toEqual({ records: [{ fields: { Name: "A" } }] });
  await own.run("airtable.update_multiple_records", { base_id: "app1", table: "My Leads", records: [{ id: "rec1", fields: { A: 1 } }], performUpsert: { fieldsToMergeOn: ["Email"] } }, login, "o");
  expect(calls[2]!.url).toBe(`${B}/app1/My%20Leads`);
  expect(calls[2]!.method).toBe("PATCH");
  expect(calls[2]!.body).toEqual({ records: [{ id: "rec1", fields: { A: 1 } }], performUpsert: { fieldsToMergeOn: ["Email"] } });
  await expect(own.run("airtable.create_records", { base_id: "a", table: "t", records: Array(11).fill({ fields: {} }) }, login, "o")).rejects.toBeInstanceOf(AppsError);
});

test("a list of records is read by POST, so filters and sorts stay in the body", async () => {
  const calls = stub(() => json({ records: [] }));
  await own.run("airtable.list_records", { base_id: "app1", table: "T", filterByFormula: '{Status}="Open"', sort: [{ field: "Name", direction: "desc" }], fields: ["Name"] }, login, "o");
  expect(calls[0]!.url).toBe(`${B}/app1/T/listRecords`);
  expect(calls[0]!.method).toBe("POST");
  expect(calls[0]!.body).toEqual({ filterByFormula: '{Status}="Open"', sort: [{ field: "Name", direction: "desc" }], fields: ["Name"] });
});

test("lists in the query use Airtable's bracket form", async () => {
  const calls = stub(() => json({}));
  await own.run("airtable.delete_multiple_records", { base_id: "app1", table: "T", records: ["rec1", "rec2"] }, login, "o");
  expect(calls[0]!.method).toBe("DELETE");
  expect(new URL(calls[0]!.url).search).toBe("?records%5B%5D=rec1&records%5B%5D=rec2");
  await own.run("airtable.get_base_schema", { base_id: "app1", include: ["visibleFieldIds"] }, login, "o");
  expect(calls[1]!.url).toBe(`${B}/meta/bases/app1/tables?include%5B%5D=visibleFieldIds`);
});

test("an attachment goes to the content host as base64, and a CSV as text/csv", async () => {
  const calls = stub(() => json({ id: "rec1" }));
  await own.run("airtable.upload_attachment", { base_id: "app1", record_id: "rec1", field: "Files", file: new AppFile("a.png", "image/png", new Uint8Array([1, 2])) }, login, "o");
  expect(calls[0]!.url).toBe("https://content.airtable.com/v0/app1/rec1/Files/uploadAttachment");
  expect(calls[0]!.body).toEqual({ contentType: "image/png", filename: "a.png", file: "AQI=" });
  await expect(own.run("airtable.upload_attachment", { base_id: "a", record_id: "r", field: "f", file: new AppFile("b", "x/y", new Uint8Array(6 * 1024 * 1024)) }, login, "o")).rejects.toThrow(/5 MB/);

  let sent: BodyInit | null | undefined;
  let type: string | undefined;
  globalThis.fetch = (async (_u: string, init: RequestInit) => {
    sent = init.body;
    type = (init.headers as Record<string, string>)["Content-Type"];
    return json({ success: true });
  }) as unknown as typeof fetch;
  await own.run("airtable.sync_csv_data", { base_id: "app1", table: "T", sync_id: "s1", csv: "a,b\n1,2" }, login, "o");
  expect(type).toBe("text/csv");
  expect(new TextDecoder().decode(sent as Uint8Array)).toBe("a,b\n1,2");
});

test("attachment info reads the cell; base metadata finds the base across pages", async () => {
  stub(() => json({ fields: { Files: [{ id: "att1", filename: "a.png" }] } }));
  expect(await own.run("airtable.get_attachment_info", { base_id: "app1", table: "T", record_id: "rec1", field: "Files" }, login, "o")).toEqual({ attachments: [{ id: "att1", filename: "a.png" }] });
  const calls = stub((c) => json(c.url.includes("offset") ? { bases: [{ id: "app2", name: "Two", permissionLevel: "create" }] } : { bases: [{ id: "app1" }], offset: "next" }));
  expect(await own.run("airtable.get_base_metadata", { base_id: "app2" }, login, "o")).toEqual({ id: "app2", name: "Two", permissionLevel: "create" });
  expect(calls).toHaveLength(2);
});

// ── polled triggers
const schema = (views: any[]) => ({ tables: [{ id: "tbl1", name: "Leads", fields: [{ name: "Name", type: "singleLineText" }, { name: "Age", type: "formula" }], views }] });
const route = (answers: Record<string, unknown>) => async (action: string, input: any) => {
  const a = answers[action];
  if (a === undefined) throw new Error(`unexpected ${action}`);
  return typeof a === "function" ? a(input) : a;
};
const v = (id: string, name = "Grid") => ({ id, name, type: "grid" });

test("new_record: first poll only notes, later ones report new rows, and the filters reach Airtable", async () => {
  const list = (records: any[]) => route({ "airtable.list_records": { records } });
  const config = { base_id: "app1", table: "Leads" };
  const first = await pollOnce("airtable.new_record", config, null, list([{ id: "rec1", fields: {} }]));
  expect(first.fresh).toEqual([]);
  const second = await pollOnce("airtable.new_record", config, first.seen, list([{ id: "rec1", fields: {} }, { id: "rec2", fields: { N: 1 } }]));
  expect(second.fresh).toEqual([{ record: { id: "rec2", fields: { N: 1 } } }]);

  const seen: any[] = [];
  await pollOnce("airtable.new_record", { ...config, view: "Open", formula: "{N}>0" }, null, route({ "airtable.list_records": (i: any) => (seen.push(i), { records: [] }) }));
  expect(seen[0].view).toBe("Open");
  expect(seen[0].filterByFormula).toBe("AND(IS_AFTER(CREATED_TIME(), DATEADD(NOW(), -1, 'days')), {N}>0)");
});

test("record_updated: a real edit reports, a formula column changing doesn't", async () => {
  const base = { "airtable.get_base_schema": schema([]) };
  const config = { base_id: "app1", table: "Leads" };
  const list = (fields: object) => route({ ...base, "airtable.list_records": { records: [{ id: "rec1", fields }] } });
  const first = await pollOnce("airtable.record_updated", config, null, list({ Name: "A", Age: 1 }));
  expect((await pollOnce("airtable.record_updated", config, first.seen, list({ Name: "A", Age: 2 }))).fresh).toEqual([]);
  expect((await pollOnce("airtable.record_updated", config, first.seen, list({ Name: "B", Age: 1 }))).fresh).toHaveLength(1);
});

test("views: created, renamed, and deleted (a deletion reaches every automation on the base)", async () => {
  const on = (views: any[]) => route({ "airtable.get_base_schema": schema(views) });
  const created = await pollOnce("airtable.view_created_trigger", { base_id: "app9" }, null, on([v("v1")]));
  expect((await pollOnce("airtable.view_created_trigger", { base_id: "app9" }, created.seen, on([v("v1"), v("v2")]))).fresh.map((f: any) => f.view.id)).toEqual(["v2"]);

  const meta = await pollOnce("airtable.view_metadata_changed_trigger", { base_id: "app9" }, null, on([v("v1", "Grid")]));
  expect((await pollOnce("airtable.view_metadata_changed_trigger", { base_id: "app9" }, meta.seen, on([v("v1", "Grid")]))).fresh).toEqual([]);
  expect((await pollOnce("airtable.view_metadata_changed_trigger", { base_id: "app9" }, meta.seen, on([v("v1", "Renamed")]))).fresh).toHaveLength(1);

  const d1 = await pollOnce("airtable.view_deleted_trigger", { base_id: "appDel" }, null, on([v("a"), v("b")]));
  expect(d1.fresh).toEqual([]);
  const d2 = await pollOnce("airtable.view_deleted_trigger", { base_id: "appDel" }, d1.seen, on([v("a")]));
  expect(d2.fresh).toEqual([{ view: v("b"), table: { id: "tbl1", name: "Leads" } }]);
  // nothing new the next time round, and a second automation still gets it
  expect((await pollOnce("airtable.view_deleted_trigger", { base_id: "appDel" }, d2.seen, on([v("a")]))).fresh).toEqual([]);
  expect((await pollOnce("airtable.view_deleted_trigger", { base_id: "appDel" }, [], on([v("a")]))).fresh).toHaveLength(1);
  // a table filter narrows it
  expect((await pollOnce("airtable.view_deleted_trigger", { base_id: "appDel", table: "Other" }, [], on([v("a")]))).fresh).toEqual([]);
});

test("base metadata, base schema and user profile report changes only", async () => {
  const bases = (name: string) => route({ "airtable.list_bases": { bases: [{ id: "app1", name, permissionLevel: "create" }] } });
  const b = await pollOnce("airtable.base_metadata_changed_trigger", {}, null, bases("One"));
  expect((await pollOnce("airtable.base_metadata_changed_trigger", {}, b.seen, bases("One"))).fresh).toEqual([]);
  expect((await pollOnce("airtable.base_metadata_changed_trigger", {}, b.seen, bases("Two"))).fresh).toHaveLength(1);

  const s = (extra: any[]) => route({ "airtable.get_base_schema": { tables: [{ id: "t", fields: extra }] } });
  const first = await pollOnce("airtable.base_schema_changed_trigger", { base_id: "a" }, null, s([]));
  expect((await pollOnce("airtable.base_schema_changed_trigger", { base_id: "a" }, first.seen, s([]))).fresh).toEqual([]);
  expect((await pollOnce("airtable.base_schema_changed_trigger", { base_id: "a" }, first.seen, s([{ name: "New" }]))).fresh).toHaveLength(1);

  const u = (email: string) => route({ "airtable.who_am_i": { id: "usr1", email } });
  const me = await pollOnce("airtable.user_profile_changed_trigger", {}, null, u("a@b.co"));
  expect((await pollOnce("airtable.user_profile_changed_trigger", {}, me.seen, u("a@b.co"))).fresh).toEqual([]);
  expect((await pollOnce("airtable.user_profile_changed_trigger", {}, me.seen, u("c@d.co"))).fresh).toHaveLength(1);
});

test("what the triggers send passes the real actions' input checks", async () => {
  stub(() => json({ records: [], tables: [], bases: [] }));
  const real = (a: string, i: unknown) => own.run(a, i, login, "o");
  await pollOnce("airtable.new_record", { base_id: "app1", table: "T", view: "V", formula: "1" }, null, real);
  await pollOnce("airtable.record_updated", { base_id: "app1", table: "T" }, null, real);
  await pollOnce("airtable.base_metadata_changed_trigger", {}, null, real);
  await pollOnce("airtable.view_created_trigger", { base_id: "app1" }, null, real);
});

test("every Composio trigger name is a trigger", () => {
  const names = listPolls("airtable").map((p) => p.action.split(".")[1]);
  for (const n of ["base_metadata_changed_trigger", "base_schema_changed_trigger", "user_profile_changed_trigger", "view_created_trigger", "view_deleted_trigger", "view_metadata_changed_trigger", "new_record", "record_updated"]) expect(names).toContain(n);
});
