import { afterEach, expect, test } from "bun:test";
import { z } from "zod";
import { pollOnce } from "../../polls/index";
import { AppFile, AppsError } from "../../types";
import { harvest } from "./index";

type Call = { method: string; url: URL; headers: Record<string, string>; body: any };
const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

// records every request and answers with reply(call); anything unanswered is a test bug, not a trip to Harvest
function stub(reply: (c: Call) => { status?: number; body?: unknown; type?: string } | undefined = () => ({ body: {} })) {
  const calls: Call[] = [];
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    const raw = init.body;
    const c = { method: init.method!, url: new URL(url), headers: init.headers as Record<string, string>, body: typeof raw === "string" ? JSON.parse(raw) : raw };
    calls.push(c);
    const r = reply(c);
    if (!r) throw new Error(`unexpected ${c.method} ${c.url}`);
    const type = r.type ?? "application/json";
    const body = r.body === undefined ? "" : type.includes("json") ? JSON.stringify(r.body) : (r.body as BodyInit);
    return new Response(body, { status: r.status ?? 200, headers: { "content-type": type } });
  }) as typeof fetch;
  return calls;
}

const KEY = "1234567:1111.pt.secret";
const API = "https://api.harvestapp.com/v2";
// as own.run does it: check the input, then run
const run = (action: string, input: unknown, key = KEY) => {
  const a = harvest.actions[action];
  if (!a) throw new Error(`no action ${action}`);
  return a.run(a.input.parse(input), key);
};
const fails = (p: Promise<unknown>) =>
  p.then(
    () => {
      throw new Error("expected it to fail");
    },
    (e: AppsError) => e,
  );

test("every operation is an action with a usable input", () => {
  const names = Object.keys(harvest.actions);
  expect(names.length).toBeGreaterThan(250);
  for (const [name, a] of Object.entries(harvest.actions)) {
    expect(name).toMatch(/^[a-z0-9_]+$/);
    expect(() => z.toJSONSchema(a.input, { io: "input" })).not.toThrow();
  }
  // Composio's names, so automations made on Composio carry over
  for (const n of ["create_time_entry", "get_company_info", "create_client_contact", "list_invoice_messages", "create_invoice_payment"]) expect(names).toContain(n);
});

test("check sends the token, account id and a User-Agent, and names the connection after the company", async () => {
  const calls = stub(() => ({ body: { name: "Northwind Studio" } }));
  expect(await harvest.check(KEY)).toBe("Northwind Studio");
  expect(calls[0]!.url.href).toBe(`${API}/company`);
  expect(calls[0]!.headers).toMatchObject({ Authorization: "Bearer 1111.pt.secret", "Harvest-Account-Id": "1234567", "User-Agent": "Emplio (https://emplio.app)" });
  // pasted the other way round
  await harvest.check("1111.pt.secret:1234567");
  expect(calls[1]!.headers).toMatchObject({ Authorization: "Bearer 1111.pt.secret", "Harvest-Account-Id": "1234567" });
});

test("a key without the account id is refused before calling Harvest; a rejected one asks for reconnecting", async () => {
  const calls = stub();
  expect(await fails(harvest.check("1111.pt.secret"))).toBeInstanceOf(AppsError);
  expect(calls).toHaveLength(0);
  stub(() => ({ status: 401, body: { error: "invalid_token", error_description: "The access token provided is expired" } }));
  expect((await fails(harvest.check(KEY))).expired).toBe(true);
  stub(() => ({ status: 422, body: { message: "Project can't be blank" } }));
  const e = await fails(run("create_time_entry", { project_id: 1, task_id: 2, spent_date: "2026-11-22" }));
  expect(e.expired).toBe(false);
  expect(e.message).toContain("Project can't be blank");
});

test("reads run unasked, writes ask; a list sends its filters in the query", async () => {
  const calls = stub(() => ({ body: { time_entries: [] } }));
  await run("list_time_entries", { project_id: 9, from: "2026-11-01", is_running: true });
  expect(calls[0]!.method).toBe("GET");
  expect(calls[0]!.url.href).toBe(`${API}/time_entries?project_id=9&is_running=true&from=2026-11-01`);
  expect(harvest.actions.list_time_entries!.readOnly).toBe(true);
  expect(harvest.actions.generate_report!.readOnly).toBe(true);
  for (const w of ["create_time_entry", "delete_invoice", "stop_time_entry", "approve_expense", "create_invoice_message"]) expect(harvest.actions[w]!.readOnly).toBe(false);
});

test("a time entry is made with a JSON body, and its id fills the path of a stop", async () => {
  const calls = stub(() => ({ body: { id: 5 } }));
  await run("create_time_entry", { project_id: 1, task_id: 2, spent_date: "2026-11-22", hours: 1.5, notes: "Call with Sarah" });
  expect(calls[0]!.method).toBe("POST");
  expect(calls[0]!.url.href).toBe(`${API}/time_entries`);
  expect(calls[0]!.body).toEqual({ project_id: 1, task_id: 2, spent_date: "2026-11-22", hours: 1.5, notes: "Call with Sarah" });
  await run("stop_time_entry", { time_entry_id: 5 });
  expect(calls[1]!.method).toBe("PATCH");
  expect(calls[1]!.url.href).toBe(`${API}/time_entries/5/stop`);
  // an update can clear a field with null
  await run("update_time_entry", { time_entry_id: 5, notes: null });
  expect(calls[2]!.body).toEqual({ notes: null });
});

test("marking an invoice sent and archiving a person send their fixed fields", async () => {
  const calls = stub();
  await run("mark_invoice_as_sent", { invoice_id: 7 });
  expect(calls[0]!.url.href).toBe(`${API}/invoices/7/messages`);
  expect(calls[0]!.body).toEqual({ event_type: "send" });
  await run("reopen_estimate", { estimate_id: 3 });
  expect(calls[1]!.body).toEqual({ event_type: "re-open" });
  await run("archive_user", { user_id: 4 });
  expect(calls[2]!.method).toBe("PATCH");
  expect(calls[2]!.body).toEqual({ is_active: false });
});

test("array filters go as name[]= repeated", async () => {
  const calls = stub(() => ({ body: { pto_allocations: [] } }));
  await run("list_time_off_allocations", { user_ids: [1, 2], year: 2026 });
  expect(calls[0]!.url.search).toBe("?year=2026&user_ids%5B%5D=1&user_ids%5B%5D=2");
});

test("an expense receipt goes as a file in a multipart body", async () => {
  const calls = stub(() => ({ body: { id: 1 } }));
  const receipt = new AppFile("taxi.pdf", "application/pdf", new Uint8Array([1, 2, 3]));
  await run("create_expense", { project_id: 1, expense_category_id: 2, spent_date: "2026-11-22", total_cost: 12.5, receipt });
  const form = calls[0]!.body as FormData;
  expect(form.get("project_id")).toBe("1");
  expect(form.get("total_cost")).toBe("12.5");
  expect((form.get("receipt") as File).name).toBe("taxi.pdf");
});

test("a report export comes back as a file", async () => {
  stub(() => ({ body: new Uint8Array([80, 75, 3, 4]), type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }));
  const out = await run("download_report_export", { export_id: "ex1" });
  expect(out).toBeInstanceOf(AppFile);
  expect((out as AppFile).bytes.length).toBe(4);
});

test("polled triggers: the first check only notes, then new and changed items fire once, with filters passed on", async () => {
  const now = new Date().toISOString();
  const old = "2020-01-01T00:00:00Z";
  let rows: any[] = [{ id: 1, created_at: now, updated_at: now }];
  const inputs: any[] = [];
  const list = async (action: string, input: any) => {
    inputs.push({ action, input });
    return { time_entries: rows, invoices: rows };
  };
  const first = await pollOnce("harvest.new_time_entry", { project_id: 9 }, null, list);
  expect(first.fresh).toHaveLength(0);
  expect(inputs[0]).toMatchObject({ action: "harvest.list_time_entries", input: { project_id: 9, per_page: 2000 } });
  expect(typeof inputs[0].input.updated_since).toBe("string");
  rows = [...rows, { id: 2, created_at: now, updated_at: now }, { id: 3, created_at: old, updated_at: now }];
  const second = await pollOnce("harvest.new_time_entry", { project_id: 9 }, first.seen, list);
  expect(second.fresh).toEqual([{ time_entry: rows[1] }]);

  // changed: the same item again only when updated_at moves
  rows = [{ id: 1, created_at: old, updated_at: now }];
  const a = await pollOnce("harvest.invoice_updated", {}, null, list);
  rows = [{ id: 1, created_at: old, updated_at: new Date(Date.now() + 1000).toISOString() }];
  expect((await pollOnce("harvest.invoice_updated", {}, a.seen, list)).fresh).toHaveLength(1);

  // paid: asks Harvest for paid invoices only, fires once per invoice
  inputs.length = 0;
  rows = [{ id: 8, state: "paid", updated_at: now }];
  const p = await pollOnce("harvest.invoice_paid", {}, [], list);
  expect(p.fresh).toHaveLength(1);
  expect(inputs[0].input.state).toBe("paid");
  expect((await pollOnce("harvest.invoice_paid", {}, p.seen, list)).fresh).toHaveLength(0);
});
