import { afterEach, beforeAll, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { pollTrigger } from "../../polls/index";
import { AppFile, AppsError } from "../../types";
import { own } from "../index";
import { triggers, wanted } from "./triggers";
import { smartsheet } from "./index";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});
beforeAll(() => {
  process.env.ENCRYPTION_KEY ??= "test-key";
  process.env.WEBHOOK_URL = "https://api.test";
});
const US = "https://api.smartsheet.com/2.0";
const EU = "https://api.smartsheet.eu/2.0";
const SHEET = "4583173393803140";
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
type Call = { url: string; method: string; body: BodyInit | null | undefined; headers: Record<string, string> };
const stub = (answer: (c: Call) => Response) => {
  const calls: Call[] = [];
  globalThis.fetch = (async (url: string, init: RequestInit = {}) => {
    const c = { url: String(url), method: init.method ?? "GET", body: init.body, headers: (init.headers ?? {}) as Record<string, string> };
    calls.push(c);
    return answer(c);
  }) as typeof fetch;
  return calls;
};
// each test uses its own token, since a token's region is remembered
let n = 0;
const login = () => ({ externalId: "c1", secret: `tok${++n}` });
const me = (c: Call) => (c.url.endsWith("/users/me") ? json({ id: 1, firstName: "Sarah", lastName: "Lee", email: "sarah@northwind.com", account: { name: "Northwind" } }) : undefined);
const token = (scope = SHEET) => createHmac("sha256", process.env.ENCRYPTION_KEY!).update(`smartsheet-webhook:c1:${scope}`).digest("hex");
const target = (scope = SHEET) => `https://api.test/webhooks/app/smartsheet/c1/${scope}/${token(scope)}`;
const delivery = (body: unknown, rest = `${SHEET}/${token()}`, headers = {}) => ({ body: JSON.stringify(body), headers, connection: "c1", rest });
const callback = (...events: object[]) => ({ nonce: "n1", timestamp: "2026-11-22T10:00:00Z", webhookId: 9, scope: "sheet", scopeObjectId: Number(SHEET), events });
const ev = (objectType: string, eventType: string, extra: object = {}) => ({ objectType, eventType, userId: 5, timestamp: "2026-11-22T10:00:00Z", ...extra });
const ROW = { id: 11, rowNumber: 3, columns: [{ id: 21, title: "Task" }, { id: 22, title: "Status" }], cells: [{ columnId: 21, value: "Call Northwind" }, { columnId: 22, value: "Done", displayValue: "Done" }] };
const sheetApi = (c: Call) => me(c) ?? (c.url.includes("/rows/11") ? json(ROW) : c.url.includes("/comments/") ? json({ id: 31, text: "Looks good" }) : json({}, 404));
const fired = async (...events: object[]) => {
  stub(sheetApi);
  return (await (await smartsheet.push!.receive!(delivery(callback(...events)), login().secret))!.events()).map((e) => e.triggers);
};

test("a token is checked and labelled, an EU token finds its region, and a bad one is refused as dead", async () => {
  const calls = stub((c) => me(c)!);
  expect(await own.connectWithKey!("smartsheet", " tokA ")).toEqual({ secret: "tokA", label: "Sarah Lee (Northwind)" });
  expect(calls[0]!.url).toBe(`${US}/users/me`);
  expect(calls[0]!.headers.Authorization).toBe("Bearer tokA");
  const eu = stub((c) => (c.url.startsWith(EU) ? (me(c) ?? json({ data: [] })) : json({ errorCode: 1002, message: "Your Access Token is invalid." }, 401)));
  await own.connectWithKey!("smartsheet", "tokEU");
  await own.run("smartsheet.list_sheets", {}, { externalId: "c1", secret: "tokEU" }, "o");
  expect(eu.at(-1)!.url).toBe(`${EU}/sheets`);
  stub(() => json({ errorCode: 1002, message: "Your Access Token is invalid." }, 401));
  const refused = await own.connectWithKey!("smartsheet", "nope").catch((e) => e);
  expect(refused).toBeInstanceOf(AppsError);
  expect(refused.expired).toBe(true);
});

test("reads run unasked, writes ask, and secrets ask", async () => {
  for (const a of ["get_sheet", "list_sheets", "get_row", "list_filtered_events", "export_sheet", "download_attachment"]) expect((await own.getAction(`smartsheet.${a}`))?.readOnly).toBe(true);
  for (const a of ["add_rows", "update_rows", "delete_sheet", "attach_link", "list_webhooks", "share_asset"]) expect((await own.getAction(`smartsheet.${a}`))?.readOnly).toBeFalsy();
});

test("rows are added with the body as given, marked as Emplio's change", async () => {
  const l = login();
  const calls = stub((c) => me(c) ?? json({ message: "SUCCESS", result: [] }));
  await own.run("smartsheet.add_rows", { sheetId: 7, body: [{ toBottom: true, cells: [{ columnId: 21, value: "Call Northwind" }] }] }, l, "o");
  const post = calls.at(-1)!;
  expect([post.method, post.url]).toEqual(["POST", `${US}/sheets/7/rows`]);
  expect(JSON.parse(String(post.body))).toEqual([{ toBottom: true, cells: [{ columnId: 21, value: "Call Northwind" }] }]);
  expect(post.headers["Smartsheet-Change-Agent"]).toBe("emplio");
});

test("a file is uploaded raw with its name, and an attachment comes back as a file", async () => {
  const l = login();
  const calls = stub((c) => me(c) ?? json({ result: { id: 1 } }));
  await own.run("smartsheet.attach_to_row", { sheetId: 7, rowId: 11, file: new AppFile("quote.pdf", "application/pdf", new Uint8Array([1, 2])) }, l, "o");
  const up = calls.at(-1)!;
  expect(up.url).toBe(`${US}/sheets/7/rows/11/attachments`);
  expect(up.headers["Content-Disposition"]).toBe('attachment; filename="quote.pdf"');
  expect(up.headers["Content-Type"]).toBe("application/pdf");
  stub((c) => me(c) ?? (c.url.startsWith("https://s3.test") ? new Response(new Uint8Array([7])) : json({ name: "quote.pdf", attachmentType: "FILE", mimeType: "application/pdf", url: "https://s3.test/q" })));
  const f = await own.run("smartsheet.download_attachment", { sheetId: 7, attachmentId: 1 }, l, "o");
  expect(f).toBeInstanceOf(AppFile);
  expect((f as AppFile).name).toBe("quote.pdf");
  const x = stub((c) => me(c) ?? new Response(new Uint8Array([1]), { headers: { "content-type": "application/vnd.ms-excel" } }));
  const sheet = await own.run("smartsheet.export_sheet", { sheetId: 7, format: "xlsx" }, l, "o");
  expect((sheet as AppFile).name).toBe("sheet-7.xlsx");
  expect(x.at(-1)!.headers.Accept).toBe("application/vnd.ms-excel");
});

test("the first automation makes the sheet's webhook and switches it on; the next reuses it", async () => {
  const l = login();
  const none = stub((c) => me(c) ?? (c.method === "GET" ? json({ data: [] }) : c.method === "POST" ? json({ result: { id: 99 } }) : json({ result: { id: 99, status: "ENABLED" } })));
  expect(await own.startPush!("smartsheet.new_row", l, { sheet_id: SHEET })).toBe(`smartsheet:c1:${SHEET}`);
  const post = none.find((c) => c.method === "POST")!;
  expect(JSON.parse(String(post.body))).toEqual({ name: "Emplio", callbackUrl: target(), scope: "sheet", scopeObjectId: Number(SHEET), events: ["*.*"], version: 1 });
  const put = none.find((c) => c.method === "PUT")!;
  expect([put.url, JSON.parse(String(put.body))]).toEqual([`${US}/webhooks/99`, { enabled: true }]);
  const live = stub((c) => me(c) ?? json({ data: [{ id: 99, callbackUrl: target(), enabled: true, status: "ENABLED" }] }));
  await own.startPush!("smartsheet.cell_changed", l, { sheet_id: SHEET });
  expect(live.filter((c) => c.method !== "GET")).toHaveLength(0);
  const off = stub((c) => me(c) ?? (c.method === "GET" ? json({ data: [{ id: 99, callbackUrl: target(), enabled: false, status: "DISABLED_CALLBACK_FAILED" }] }) : json({ result: { id: 99, status: "ENABLED" } })));
  await own.startPush!("smartsheet.cell_changed", l, { sheet_id: SHEET });
  expect(off.filter((c) => c.method === "PUT")).toHaveLength(1);
  expect(off.filter((c) => c.method === "POST")).toHaveLength(0);
  stub((c) => me(c) ?? (c.method === "GET" ? json({ data: [] }) : c.method === "POST" ? json({ result: { id: 99 } }) : json({ result: { id: 99, status: "DISABLED_VERIFICATION_FAILED" } })));
  await expect(own.startPush!("smartsheet.new_row", l, { sheet_id: SHEET })).rejects.toThrow(/DISABLED_VERIFICATION_FAILED/);
});

test("a sheet id is required, and the seat trigger finds the admin's plan", async () => {
  stub((c) => me(c) ?? json({}));
  await expect(own.startPush!("smartsheet.new_row", login(), {})).rejects.toThrow(/sheet_id/);
  await expect(own.startPush!("smartsheet.new_row", login(), { sheet_id: "../x" })).rejects.toThrow(/sheet_id/);
  const calls = stub((c) => me(c) ?? (c.url.endsWith("/users/1/plans") ? json({ data: [{ planId: 555 }] }) : c.method === "GET" ? json({ data: [] }) : json({ result: { id: 1, status: "ENABLED" } })));
  expect(await own.startPush!("smartsheet.user_seat_type_updated", login(), {})).toBe("smartsheet:c1:plan-555");
  expect(JSON.parse(String(calls.find((c) => c.method === "POST")!.body))).toMatchObject({ scope: "plan", scopeObjectId: 555, callbackUrl: target("plan-555") });
});

test("the last automation removes the webhook, found by its URL", async () => {
  const l = login();
  const calls = stub((c) => me(c) ?? json({ data: [{ id: 1, callbackUrl: "https://other" }, { id: 99, callbackUrl: target() }] }));
  await smartsheet.push!.stop!(l.secret, `smartsheet:c1:${SHEET}`);
  expect([calls.at(-1)!.method, calls.at(-1)!.url]).toEqual(["DELETE", `${US}/webhooks/99`]);
});

test("the challenge is echoed, and a bad token in the URL is refused", async () => {
  const got = await smartsheet.push!.receive!(delivery({ challenge: "abc", webhookId: 99 }, undefined, { "smartsheet-hook-challenge": "abc" }), "k");
  expect(got!.headers).toEqual({ "Smartsheet-Hook-Response": "abc" });
  expect(got!.reply).toEqual({ smartsheetHookResponse: "abc" });
  expect(await got!.events()).toEqual([]);
  expect(await smartsheet.push!.receive!(delivery({ challenge: "abc" }, `${SHEET}/nope`), "k")).toBeNull();
  expect(await smartsheet.push!.receive!(delivery({ challenge: "abc" }, `123/${token()}`), "k")).toBeNull();
  expect(await smartsheet.push!.receive!(delivery({ challenge: "abc" }, ""), "k")).toBeNull();
});

test("each event starts only the right triggers, and the catch-all", async () => {
  const cases: [object, string[]][] = [
    [ev("row", "created", { id: 11 }), ["new_row"]],
    [ev("row", "updated", { id: 11 }), ["row_updated"]],
    [ev("row", "deleted", { id: 11 }), ["row_deleted"]],
    [ev("cell", "updated", { rowId: 11, columnId: 22 }), ["cell_changed", "cell_updated"]],
    [ev("cell", "created", { rowId: 11, columnId: 22 }), ["cell_changed", "cell_created"]],
    [ev("comment", "created", { id: 31 }), ["comment_created"]],
    [ev("attachment", "deleted", { id: 41 }), ["attachment_deleted"]],
    [ev("sheet", "updated", { id: Number(SHEET) }), ["sheet_updated"]],
    [ev("mystery", "created", { id: 1 }), []],
  ];
  for (const [e, want] of cases) expect((await fired(e))[0]!.sort()).toEqual([...want, "sheet_activity"].sort());
  stub(sheetApi);
  const seat = { scope: "plan", scopeObjectId: 555, events: [{ objectType: "user.seatType", eventType: "updated", userId: 5, seatType: "MEMBER", timestamp: "2026-11-22T10:00:00Z" }] };
  const [s] = await (await smartsheet.push!.receive!(delivery(seat, `plan-555/${token("plan-555")}`), login().secret))!.events();
  expect(s!.triggers).toEqual(["user_seat_type_updated"]);
  expect(s!.data).toMatchObject({ event: "user.seatType.updated", seatType: "MEMBER" });
});

test("a cell event carries the row by column name, the column and the value; a retry has the same id", async () => {
  stub(sheetApi);
  const body = callback(ev("cell", "updated", { rowId: 11, columnId: 22 }), ev("comment", "created", { id: 31 }));
  const k = login().secret;
  const [a, c] = await (await smartsheet.push!.receive!(delivery(body), k))!.events();
  expect(a!.data).toMatchObject({ event: "cell.updated", sheet_id: SHEET, row_id: "11", column_id: "22", column: "Status", value: "Done", row: { id: "11", row_number: 3, values: { Task: "Call Northwind", Status: "Done" } } });
  expect(c!.data).toMatchObject({ event: "comment.created", id: "31", item: { text: "Looks good" } });
  const [again] = await (await smartsheet.push!.receive!(delivery(body), k))!.events();
  expect(again!.id).toBe(a!.id!);
  expect(a!.id).toStartWith(`smartsheet:c1:${SHEET}:`);
  // a status change carries no events
  expect(await (await smartsheet.push!.receive!(delivery({ newWebhookStatus: "DISABLED_SCOPE_INACCESSIBLE" }), k))!.events()).toEqual([]);
});

test("filters narrow what runs, and Emplio's own changes are left out unless asked for", () => {
  const cell = { event: "cell.updated", sheet_id: SHEET, row_id: "11", column_id: "22", column: "Status", value: "Done" };
  expect(wanted({}, cell)).toBe(true);
  expect(wanted({ column: "status", value: "done" }, cell)).toBe(true);
  expect(wanted({ column: "22" }, cell)).toBe(true);
  expect(wanted({ column: "Task" }, cell)).toBe(false);
  expect(wanted({ value: "Open" }, cell)).toBe(false);
  expect(wanted({ row_id: 11 }, cell)).toBe(true);
  expect(wanted({ row_id: 12 }, cell)).toBe(false);
  const ours = { ...cell, change_agent: "zapier,emplio" };
  expect(wanted({}, ours)).toBe(false);
  expect(wanted({ include_emplio_changes: true }, ours)).toBe(true);
});

test("every sheet trigger needs a sheet", () => {
  for (const [name, t] of Object.entries(triggers)) expect(t.config[0]!.name).toBe(name === "user_seat_type_updated" ? "plan_id" : "sheet_id");
});

test("polls report new sheets, changed sheets with the change in the id, and filtered admin events", async () => {
  const now = new Date().toISOString();
  const sheets = { data: [{ id: 1, createdAt: now, modifiedAt: now, version: 4 }, { id: 2, createdAt: "2020-01-01T00:00:00Z", modifiedAt: now, version: 9 }] };
  const run = async (action: string) =>
    action === "smartsheet.list_events"
      ? { data: [{ eventId: "e1", objectType: "SHEET", action: "EXPORT", eventTimestamp: now }, { eventId: "e2", objectType: "USER", action: "LOGIN", eventTimestamp: now }] }
      : action === "smartsheet.list_reports" ? { data: [{ id: 8 }] } : sheets;
  const poll = (t: string) => pollTrigger(`smartsheet.${t}`)!;
  expect((await poll("new_sheet").poll({}, run)).map((i) => i.id)).toEqual(["1"]);
  expect((await poll("sheet_modified").poll({}, run)).map((i) => i.id)).toEqual(["1:4", "2:9"]);
  expect((await poll("new_report").poll({}, run)).map((i) => i.id)).toEqual(["8"]);
  expect((await poll("new_admin_event").poll({ object_type: "sheet" }, run)).map((i) => i.id)).toEqual(["e1"]);
  expect(await poll("new_dashboard").poll({}, async () => ({ data: null }))).toEqual([]);
});
