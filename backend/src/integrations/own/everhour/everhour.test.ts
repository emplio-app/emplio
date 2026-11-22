import { afterEach, beforeAll, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { AppsError } from "../../types";
import { own } from "../index";
import { pollTrigger } from "../../polls/index";
import { triggers, wanted } from "./triggers";
import { everhour } from "./index";

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
const login = { externalId: "c1", secret: "key" };
const token = () => createHmac("sha256", process.env.ENCRYPTION_KEY!).update("everhour-webhook:c1").digest("hex");
const target = () => `https://api.test/webhooks/app/everhour/c1/all/${token()}`;
const delivery = (body: unknown, rest = `all/${token()}`) => ({ body: typeof body === "string" ? body : JSON.stringify(body), headers: {}, connection: "c1", rest });
const event = (name: string, data: unknown = { id: "ev:7" }) => ({ event: name, createdAt: "2026-11-22 10:00:00", data: { id: "ev:7", data }, attributes: { projects: ["ev:1"], users: [5] }, user: { id: 5, teamId: 9 } });
const fire = async (body: unknown) => (await (await everhour.push!.receive!(delivery(body), "k"))!.events())[0]?.triggers ?? [];

test("a key is checked with X-Api-Key and labelled, and a bad one is refused", async () => {
  const calls = stub(() => json({ id: 5, name: "Sarah", email: "sarah@northwind.test", apiKey: "secret" }));
  expect(await own.connectWithKey!("everhour", " key ")).toEqual({ secret: "key", label: "Sarah" });
  expect(calls[0]!.url).toBe("https://api.everhour.com/users/me");
  expect(calls[0]!.headers["X-Api-Key"]).toBe("key");
  expect(calls[0]!.headers.Authorization).toBeUndefined();
  stub(() => json({ code: 403, message: "Access denied" }, 403));
  await expect(own.connectWithKey!("everhour", "nope")).rejects.toBeInstanceOf(AppsError);
});

test("calls go to api.everhour.com with their fields, and errors say Everhour's message", async () => {
  const calls = stub(() => json({ id: 1 }));
  await own.run("everhour.add_time", { time: 3600, date: "2026-11-22", task: "ev:7", user: 5 }, login, "o");
  expect(`${calls[0]!.method} ${calls[0]!.url}`).toBe("POST https://api.everhour.com/time");
  expect(JSON.parse(calls[0]!.body)).toEqual({ time: 3600, date: "2026-11-22", task: "ev:7", user: 5 });
  await own.run("everhour.list_project_tasks", { project_id: "ev:1", limit: 10 }, login, "o");
  expect(calls[1]!.url).toBe("https://api.everhour.com/projects/ev%3A1/tasks?limit=10");
  stub(() => json({ code: 404, message: "Task not found" }, 404));
  await expect(own.run("everhour.get_task", { task_id: "ev:9" }, login, "o")).rejects.toThrow(/Task not found/);
});

test("the profile never hands back the person's API key, and tags and the team are there too", async () => {
  stub(() => json({ id: 5, name: "Sarah", apiKey: "secret" }));
  expect(await own.run("everhour.get_user_profile", {}, login, "o")).toEqual({ id: 5, name: "Sarah" });
  const calls = stub(() => json([]));
  await own.run("everhour.list_tags", {}, login, "o");
  await own.run("everhour.list_teams", {}, login, "o");
  expect(calls.map((c) => c.url)).toEqual(["https://api.everhour.com/tags", "https://api.everhour.com/team"]);
});

test("reads run unasked, writes ask, and webhook addresses ask first", async () => {
  for (const a of ["get_task", "list_projects", "list_team_time_records", "get_user_profile", "list_tags", "get_current_timer"]) expect((await own.getAction(`everhour.${a}`))?.readOnly).toBe(true);
  for (const a of ["add_time", "timer_start", "stop_timer", "delete_task", "create_invoice", "review_timesheet_approval", "list_hooks", "get_webhook"])
    expect((await own.getAction(`everhour.${a}`))?.readOnly).toBe(false);
});

test("an attachment comes back as a file", async () => {
  stub(() => new Response(new Uint8Array([37, 80, 68, 70]), { headers: { "content-type": "application/pdf" } }));
  const got = (await own.run("everhour.download_attachment", { attachment_token: "t1" }, login, "o")) as { mimetype?: string };
  expect(got.mimetype).toBe("application/pdf");
});

test("the first automation makes the webhook with every event, the next reuses it, a switched-off one is switched back on", async () => {
  const none = stub((c) => (c.method === "GET" ? json([{ id: 2, targetUrl: "https://other", events: [], active: true }]) : json({ id: 3 }, 201)));
  expect(await own.startPush!("everhour.new_task", login, {})).toBe("everhour:c1:all");
  expect(none.map((c) => `${c.method} ${c.url}`)).toEqual(["GET https://api.everhour.com/hooks", "POST https://api.everhour.com/hooks"]);
  const sent = JSON.parse(none[1]!.body);
  expect(sent.targetUrl).toBe(target());
  expect(sent.events).toHaveLength(20);
  expect(sent.events).toContain("api:timer:started");
  const live = { id: 3, targetUrl: target(), events: sent.events, active: true };
  const same = stub(() => json([live]));
  await own.startPush!("everhour.timer_started", login, {});
  expect(same).toHaveLength(1);
  const off = stub((c) => (c.method === "GET" ? json([{ ...live, active: false }]) : json({})));
  await own.startPush!("everhour.timer_started", login, {});
  expect(off.slice(1).map((c) => `${c.method} ${c.url}`)).toEqual(["PUT https://api.everhour.com/hooks/3"]);
  expect(JSON.parse(off[1]!.body).events).toHaveLength(20);
});

test("the last automation removes only our webhook", async () => {
  const calls = stub((c) => (c.method === "GET" ? json([{ id: 4, targetUrl: "https://other" }, { id: 3, targetUrl: target() }]) : new Response(null, { status: 204 })));
  await everhour.push!.stop!("k", "everhour:c1:all");
  expect(calls.slice(1).map((c) => `${c.method} ${c.url}`)).toEqual(["DELETE https://api.everhour.com/hooks/3"]);
});

test("a wrong or missing token is refused, and the handshake gets its 200", async () => {
  expect(await everhour.push!.receive!(delivery(event("api:task:created"), "all/nope"), "k")).toBeNull();
  expect(await everhour.push!.receive!(delivery(event("api:task:created"), "all"), "k")).toBeNull();
  const handshake = await everhour.push!.receive!(delivery(""), "k");
  expect(await handshake!.events()).toEqual([]);
});

test("each event starts only its trigger", async () => {
  expect(await fire(event("api:task:created"))).toEqual(["new_task"]);
  expect(await fire(event("api:task:recovered"))).toEqual(["task_restored"]);
  expect(await fire(event("api:timer:stopped"))).toEqual(["timer_stopped"]);
  expect(await fire(event("api:time:updated"))).toEqual(["time_updated"]);
  expect(await fire(event("api:project:removed"))).toEqual(["project_deleted"]);
  expect(await fire(event("api:invoice:deleted"))).toEqual(["invoice_deleted"]);
  expect(await fire(event("api:mystery"))).toEqual([]);
});

test("the event keeps the item and who did it, and a retry has the same id", async () => {
  const body = event("api:task:updated", { id: "ev:7", name: "Logo" });
  const [a] = await (await everhour.push!.receive!(delivery(body), "k"))!.events();
  const [b] = await (await everhour.push!.receive!(delivery(body), "k"))!.events();
  expect(a!.id).toBe(b!.id!);
  expect(a!.id).toStartWith("c1:");
  expect(a!.data).toEqual({ event: "api:task:updated", id: "ev:7", item: { id: "ev:7", name: "Logo" }, projects: ["ev:1"], users: [5], user: { id: 5, teamId: 9 }, created_at: "2026-11-22 10:00:00" });
});

test("filters narrow what runs", () => {
  const data = { event: "api:time:updated", id: "1", item: { user: 8 }, projects: ["ev:1"], users: [5], user: { id: 6 }, created_at: "" };
  expect(wanted({}, data)).toBe(true);
  expect(wanted({ project_id: "ev:1", user_id: 5 }, data)).toBe(true);
  expect(wanted({ user_id: 6 }, data)).toBe(true);
  expect(wanted({ user_id: "8" }, data)).toBe(true);
  expect(wanted({ project_id: "ev:2" }, data)).toBe(false);
  expect(wanted({ user_id: 9 }, data)).toBe(false);
});

test("every Everhour webhook event has a trigger", () => {
  expect(Object.keys(triggers)).toHaveLength(20);
});

test("polls report new expenses, time off, approvals and clock-ins once each", async () => {
  const poll = (t: string) => pollTrigger(`everhour.${t}`)!;
  const got: Record<string, unknown>[] = [];
  const run = async (action: string, input: unknown) => {
    got.push({ action, input });
    if (action === "everhour.expenses_list") return [{ id: 1, user: 5, project: "ev:1" }, { id: 3, user: 6, project: "ev:2" }];
    if (action === "everhour.list_schedule_assignments") return [{ id: 9, user: 5, type: "time-off" }];
    if (action === "everhour.list_team_timesheets") return [{ id: 4, user: 5, approval: { status: "pending", history: [{}] } }, { id: 6, user: 5, approval: { status: "approved", history: [{}, {}] } }];
    if (action === "everhour.list_timecards") return [{ user: 5, date: "2026-11-22", clockIn: "09:00", lastClockIn: "13:00" }, { user: 6, date: "2026-11-22", clockIn: "09:00", clockOut: "17:00" }];
    return [];
  };
  expect((await poll("new_expense").poll({}, run)).map((i) => i.id)).toEqual(["3", "1"]);
  expect((await poll("new_expense").poll({ user_id: 5 }, run)).map((i) => i.id)).toEqual(["1"]);
  expect((await poll("new_time_off").poll({}, run)).map((i) => i.id)).toEqual(["9"]);
  expect(got.at(-1)).toMatchObject({ action: "everhour.list_schedule_assignments", input: { type: "time-off" } });
  expect((await poll("timesheet_submitted").poll({}, run)).map((i) => i.id)).toEqual(["4:pending:1"]);
  expect((await poll("timesheet_approved").poll({}, run)).map((i) => i.id)).toEqual(["6:approved:2"]);
  expect((await poll("clocked_in").poll({}, run)).map((i) => i.id)).toEqual(["5:2026-11-22:13:00", "6:2026-11-22:09:00"]);
  expect((await poll("clocked_out").poll({}, run)).map((i) => i.id)).toEqual(["6:2026-11-22:17:00"]);
  expect(await poll("new_team_member").poll({}, async () => null)).toEqual([]);
});
