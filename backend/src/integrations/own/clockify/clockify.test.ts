import { afterEach, beforeAll, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { AppFile, AppsError } from "../../types";
import { own } from "../index";
import { events, triggers, wanted } from "./triggers";
import { clockify } from "./index";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});
beforeAll(() => {
  process.env.ENCRYPTION_KEY ??= "test-key";
  process.env.WEBHOOK_URL = "https://api.test";
});
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
type Call = { url: string; method: string; body: string; headers: Record<string, string> };
const stub = (answer: (c: Call) => Response) => {
  const calls: Call[] = [];
  globalThis.fetch = (async (url: string, init: RequestInit = {}) => {
    const c = { url: String(url), method: init.method ?? "GET", body: String(init.body ?? ""), headers: init.headers as Record<string, string> };
    calls.push(c);
    return answer(c);
  }) as typeof fetch;
  return calls;
};
const login = { externalId: "c1", secret: "k" };
const at = "w1-NEW_TIME_ENTRY";
const token = (a = at) => createHmac("sha256", process.env.ENCRYPTION_KEY!).update(`clockify-webhook:c1:${a}`).digest("hex");
const target = (a = at) => `https://api.test/webhooks/app/clockify/c1/${a}/${token(a)}`;
const HOOKS = "https://api.clockify.me/api/v1/workspaces/w1/webhooks";
const hooks = (list: unknown[]) => (c: Call) => (c.method === "GET" && c.url === HOOKS ? json({ webhooks: list, workspaceWebhookCount: list.length }) : json({ id: "h9" }));
const delivery = (body: unknown, rest = `${at}/${token()}`) => ({ body: JSON.stringify(body), headers: {}, connection: "c1", rest });

test("a key is checked and labelled, and a bad one is refused as dead", async () => {
  const calls = stub(() => json({ id: "u1", name: "Sarah", email: "sarah@northwind.test" }));
  expect(await own.connectWithKey!("clockify", " k ")).toEqual({ secret: "k", label: "Sarah" });
  expect(calls[0]!.url).toBe("https://api.clockify.me/api/v1/user");
  expect(calls[0]!.headers["X-Api-Key"]).toBe("k");
  stub(() => json({ message: "Full authentication is required", code: 1000 }, 401));
  const refused = await own.connectWithKey!("clockify", "nope").catch((e) => e);
  expect(refused).toBeInstanceOf(AppsError);
  expect(refused.expired).toBe(true);
});

test("a regional key goes to its region's servers, reports too, with the bare key", async () => {
  const calls = stub(() => json({ id: "u1" }));
  await clockify.check("euc1:k");
  await own.run("clockify.generate_summary_report", { workspaceId: "w1", dateRangeStart: "2026-11-01T00:00:00Z", dateRangeEnd: "2026-11-30T23:59:59Z", summaryFilter: { groups: ["PROJECT"] } }, { externalId: "c1", secret: "euc1:k" }, "o");
  expect(calls[0]!.url).toBe("https://euc1.clockify.me/api/v1/user");
  expect(calls[1]!.url).toBe("https://euc1.clockify.me/report/v1/workspaces/w1/reports/summary");
  expect(calls.every((c) => c.headers["X-Api-Key"] === "k")).toBe(true);
});

test("reports go to the reports server, with their fields in the body", async () => {
  const calls = stub(() => json({ totals: [] }));
  await own.run("clockify.generate_detailed_report", { workspaceId: "w1", dateRangeStart: "2026-11-01T00:00:00Z", dateRangeEnd: "2026-11-30T23:59:59Z", detailedFilter: { page: 1, pageSize: 50 } }, login, "o");
  expect(calls[0]!.method).toBe("POST");
  expect(calls[0]!.url).toBe("https://reports.api.clockify.me/v1/workspaces/w1/reports/detailed");
  expect(JSON.parse(calls[0]!.body)).toMatchObject({ dateRangeStart: "2026-11-01T00:00:00Z" });
});

test("reads run unasked, writes and webhook tokens ask", async () => {
  for (const a of ["get_projects", "get_time_entries", "generate_detailed_report", "generate_weekly_report", "filter_workspace_users", "generate_audit_log_report"])
    expect((await own.getAction(`clockify.${a}`))?.readOnly).toBe(true);
  for (const a of ["create_time_entry", "delete_project", "stop_user_timer", "get_all_webhooks", "get_webhook_by_id"])
    expect((await own.getAction(`clockify.${a}`))?.readOnly).toBe(false);
});

test("a time entry's fields are the action's own and path ids stay out of the body", async () => {
  const calls = stub(() => json({ id: "t1" }));
  await own.run("clockify.create_time_entry", { workspaceId: "w1", start: "2026-11-22T09:00:00Z", description: "Call with Northwind", projectId: "p1" }, login, "o");
  expect(calls[0]!.url).toBe("https://api.clockify.me/api/v1/workspaces/w1/time-entries");
  expect(JSON.parse(calls[0]!.body)).toEqual({ start: "2026-11-22T09:00:00Z", description: "Call with Northwind", projectId: "p1" });
});

test("a receipt comes back as a file", async () => {
  stub(() => new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "image/png" } }));
  const out = await clockify.actions.download_receipt!.run({ workspaceId: "w1", expenseId: "e1", fileId: "f1" }, "k");
  expect(out).toBeInstanceOf(AppFile);
});

test("the first automation makes the event's webhook, the next reuses it, and a switched-off one is replaced", async () => {
  const none = stub(hooks([]));
  expect(await own.startPush!("clockify.new_time_entry", login, { workspace_id: "w1" })).toBe(`clockify:c1:${at}`);
  expect(none[1]!.method).toBe("POST");
  expect(none[1]!.url).toBe(HOOKS);
  expect(JSON.parse(none[1]!.body)).toEqual({ name: "Emplio", url: target(), webhookEvent: "NEW_TIME_ENTRY", triggerSourceType: "WORKSPACE_ID", triggerSource: ["w1"] });
  const same = stub(hooks([{ id: "h1", url: target(), enabled: true }]));
  await own.startPush!("clockify.new_time_entry", login, { workspace_id: "w1" });
  expect(same).toHaveLength(1);
  const off = stub(hooks([{ id: "h1", url: target(), enabled: false }]));
  await own.startPush!("clockify.new_time_entry", login, { workspace_id: "w1" });
  expect(off.slice(1).map((c) => c.method)).toEqual(["DELETE", "POST"]);
  expect(off[1]!.url).toBe(`${HOOKS}/h1`);
});

test("with no workspace given, the account's current one is watched", async () => {
  const calls = stub((c) => (c.url.endsWith("/v1/user") ? json({ id: "u1", activeWorkspace: "w1" }) : hooks([])(c)));
  expect(await own.startPush!("clockify.new_time_entry", login, {})).toBe(`clockify:c1:${at}`);
  expect(calls.map((c) => c.method)).toEqual(["GET", "GET", "POST"]);
  await expect(own.startPush!("clockify.new_time_entry", login, { workspace_id: "w/../1" })).rejects.toThrow(/workspace_id/);
});

test("the last automation removes that event's webhook, found by its URL", async () => {
  const calls = stub(hooks([{ id: "other", url: "https://x" }, { id: "h1", url: target() }]));
  await clockify.push!.stop!("k", `clockify:c1:${at}`);
  expect(calls[1]!.method).toBe("DELETE");
  expect(calls[1]!.url).toBe(`${HOOKS}/h1`);
});

test("a bad token in the URL is refused", async () => {
  expect(await clockify.push!.receive!(delivery({}, `${at}/nope`), "k")).toBeNull();
  expect(await clockify.push!.receive!(delivery({}, `w1-TIMER_STOPPED/${token()}`), "k")).toBeNull();
  expect(await clockify.push!.receive!(delivery({}, ""), "k")).toBeNull();
});

test("each event starts only its trigger, and a retry has the same id", async () => {
  for (const e of ["NEW_TIME_ENTRY", "TIMER_STOPPED", "PROJECT_DELETED", "TIME_OFF_REQUEST_APPROVED"]) {
    const a = `w1-${e}`;
    const [out] = await (await clockify.push!.receive!(delivery({ id: "x" }, `${a}/${token(a)}`), "k"))!.events();
    expect(out!.triggers).toEqual([e.toLowerCase()]);
    expect(out!.data).toMatchObject({ event: e, id: "x" });
  }
  const one = await (await clockify.push!.receive!(delivery({ id: "t1", description: "a" }), "k"))!.events();
  const again = await (await clockify.push!.receive!(delivery({ id: "t1", description: "a" }), "k"))!.events();
  const changed = await (await clockify.push!.receive!(delivery({ id: "t1", description: "b" }), "k"))!.events();
  expect(again[0]!.id).toBe(one[0]!.id!);
  expect(changed[0]!.id).not.toBe(one[0]!.id!);
});

test("filters narrow what runs", () => {
  const entry = { event: "NEW_TIME_ENTRY", id: "t1", projectId: "p1", userId: "u1" };
  expect(wanted({}, entry)).toBe(true);
  expect(wanted({ project_id: "p1", user_id: "u1" }, entry)).toBe(true);
  expect(wanted({ project_id: "p2" }, entry)).toBe(false);
  expect(wanted({ user_id: "u2" }, entry)).toBe(false);
  expect(wanted({ project_id: "p1" }, { event: "PROJECT_UPDATED", id: "p1" })).toBe(true);
  expect(wanted({ user_id: "u1" }, { event: "USER_JOINED_WORKSPACE", id: "u1" })).toBe(true);
  expect(wanted({ project_id: "p1" }, { event: "NEW_TAG", id: "g1" })).toBe(false);
});

test("every Clockify webhook event is a trigger", () => {
  expect(Object.keys(triggers)).toHaveLength(51);
  expect(events.timer_stopped).toBe("TIMER_STOPPED");
  for (const t of Object.values(triggers)) expect(t.config.map((c) => c.name)).toEqual(["workspace_id", "project_id", "user_id"]);
});
