import { afterEach, beforeAll, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { AppsError } from "../../types";
import { own } from "../index";
import { pollTrigger } from "../../polls/index";
import { events, triggers, wanted } from "./triggers";
import { toggl } from "./index";

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
const login = { externalId: "c1", secret: "tok" };
const BASIC = `Basic ${btoa("tok:api_token")}`;
const HOOKS = "https://api.track.toggl.com/webhooks/api/v1";
const URL_ = "https://api.test/webhooks/app/toggl/c1/42";
const secret = () => createHmac("sha256", process.env.ENCRYPTION_KEY!).update("toggl-webhook:c1:42").digest("hex");
const sign = (body: string, key = secret()) => `sha256=${createHmac("sha256", key).update(body).digest("hex")}`;
const delivery = (payload: unknown, opts: { sig?: string; rest?: string } = {}) => {
  const body = JSON.stringify(payload);
  return { body, headers: { "x-webhook-signature-256": opts.sig ?? sign(body) }, connection: "c1", rest: opts.rest ?? "42" };
};
const event = (model: string, action: string, payload: object = { id: 7 }, id = 99) => ({ event_id: id, created_at: "2026-11-22T10:00:00Z", metadata: { model, action, workspace_id: 42 }, payload, subscription_id: 1 });
const receive = async (payload: unknown) => (await (await toggl.push!.receive!(delivery(payload), "k"))!.events())[0]!;

test("a token is checked with basic auth and labelled, and a bad one is refused as dead", async () => {
  const calls = stub(() => json({ id: 1, fullname: "Asha", api_token: "tok" }));
  expect(await own.connectWithKey!("toggl", " tok ")).toEqual({ secret: "tok", label: "Asha" });
  expect(calls[0]!.url).toBe("https://api.track.toggl.com/api/v9/me");
  expect(calls[0]!.headers.Authorization).toBe(BASIC);
  stub(() => new Response("Incorrect username and/or password", { status: 403 }));
  const refused = await own.connectWithKey!("toggl", "nope").catch((e) => e);
  expect(refused).toBeInstanceOf(AppsError);
  expect(refused.expired).toBe(true);
});

test("a missing permission isn't a dead login", async () => {
  stub(() => new Response("\"User does not have access to this resource.\"", { status: 403, headers: { "content-type": "application/json" } }));
  const refused = (await own.run("toggl.get_projects", { workspace_id: 1 }, login, "o").catch((e) => e)) as AppsError;
  expect(refused).toBeInstanceOf(AppsError);
  expect(refused.expired).toBeFalsy();
});

test("reads run unasked, writes ask, reports are reads, secrets ask", async () => {
  expect((await own.getAction("toggl.get_time_entries"))?.readOnly).toBe(true);
  expect((await own.getAction("toggl.search_detailed_report_time_entries"))?.readOnly).toBe(true);
  expect((await own.getAction("toggl.reports_summary_time_entries"))?.readOnly).toBe(true);
  expect((await own.getAction("toggl.create_time_entry"))?.readOnly).toBe(false);
  expect((await own.getAction("toggl.delete_time_entry"))?.readOnly).toBe(false);
  expect((await own.getAction("toggl.get_subscriptions"))?.readOnly).toBe(false);
  expect(await own.getAction("toggl.post_reset_token")).toBeFalsy();
});

test("get_me never hands back the API token", async () => {
  stub(() => json({ id: 1, fullname: "Asha", api_token: "tok" }));
  expect(await own.run("toggl.get_me", {}, login, "o")).toEqual({ id: 1, fullname: "Asha" });
});

test("a new time entry says Emplio made it and runs as a timer unless it has an end", async () => {
  const calls = stub(() => json({ id: 5 }));
  await own.run("toggl.create_time_entry", { workspace_id: 42, description: "Call Ravi", start: "2026-11-22T10:00:00Z" }, login, "o");
  expect(calls[0]!.url).toBe("https://api.track.toggl.com/api/v9/workspaces/42/time_entries");
  expect(calls[0]!.headers.Authorization).toBe(BASIC);
  expect(JSON.parse(calls[0]!.body)).toEqual({ workspace_id: 42, description: "Call Ravi", start: "2026-11-22T10:00:00Z", created_with: "Emplio", duration: -1 });
  await own.run("toggl.create_time_entry", { workspace_id: 42, start: "2026-11-22T10:00:00Z", duration: 600, created_with: "x" }, login, "o");
  expect(JSON.parse(calls[1]!.body)).toMatchObject({ duration: 600, created_with: "x" });
});

test("reports go to the Reports API with the same login, and an export comes back as a file", async () => {
  const calls = stub(() => json([]));
  await own.run("toggl.search_detailed_report_time_entries", { workspace_id: 42, start_date: "2026-11-01" }, login, "o");
  expect(calls[0]!.url).toBe("https://api.track.toggl.com/reports/api/v3/workspace/42/search/time_entries");
  expect(calls[0]!.method).toBe("POST");
  expect(JSON.parse(calls[0]!.body)).toEqual({ start_date: "2026-11-01" });
  stub(() => new Response(new Uint8Array([37, 80, 68, 70]), { headers: { "content-type": "application/pdf" } }));
  const file = (await own.run("toggl.reports_summary_time_entries_pdf", { workspace_id: 42, start_date: "2026-11-01" }, login, "o")) as { name: string; mimetype: string };
  expect(file.mimetype).toBe("application/pdf");
});

test("the first automation makes the workspace's subscription with our secret and pings it to validate", async () => {
  const calls = stub((c) => json(c.method === "GET" ? null : c.url.includes("/ping/") ? { status: "ok" } : { subscription_id: 3, validated_at: null }));
  expect(await own.startPush!("toggl.time_entry_created", login, { workspace_id: 42 })).toBe("toggl:c1:42");
  expect(calls[0]!.url).toBe(`${HOOKS}/subscriptions/42`);
  expect(calls[1]!.method).toBe("POST");
  expect(calls[1]!.url).toBe(`${HOOKS}/subscriptions/42`);
  expect(JSON.parse(calls[1]!.body)).toEqual({ url_callback: URL_, event_filters: [{ entity: "time_entry", action: "created" }], enabled: true, description: "Emplio c1", secret: secret() });
  expect(calls[2]!.url).toBe(`${HOOKS}/ping/42/3`);
});

test("the next automation extends the subscription; one already covered needs no change", async () => {
  const hook = { subscription_id: 3, url_callback: URL_, event_filters: [{ entity: "time_entry", action: "created" }], enabled: true, validated_at: "2026-11-01" };
  const add = stub((c) => json(c.method === "GET" ? [{ ...hook, subscription_id: 1, url_callback: "https://other" }, hook] : hook));
  await own.startPush!("toggl.project_deleted", login, { workspace_id: "42" });
  expect(add[1]!.method).toBe("PUT");
  expect(add[1]!.url).toBe(`${HOOKS}/subscriptions/42/3`);
  expect(JSON.parse(add[1]!.body).event_filters).toEqual([{ entity: "time_entry", action: "created" }, { entity: "project", action: "deleted" }]);
  expect(add).toHaveLength(2);
  const same = stub(() => json([hook]));
  await own.startPush!("toggl.time_entry_created", login, { workspace_id: 42 });
  expect(same).toHaveLength(1);
  const off = stub((c) => json(c.method === "GET" ? [{ ...hook, enabled: false }] : hook));
  await own.startPush!("toggl.time_entry_created", login, { workspace_id: 42 });
  expect(JSON.parse(off[1]!.body)).toMatchObject({ enabled: true, event_filters: hook.event_filters });
});

test("a workspace is required and must be a number", async () => {
  await expect(own.startPush!("toggl.time_entry_created", login, {})).rejects.toThrow(/workspace_id/);
  await expect(own.startPush!("toggl.time_entry_created", login, { workspace_id: "4:2" })).rejects.toThrow(/workspace_id/);
});

test("the last automation removes the subscription, found by its URL", async () => {
  const calls = stub((c) => json(c.method === "GET" ? [{ subscription_id: 1, url_callback: "https://x" }, { subscription_id: 3, url_callback: URL_ }] : {}));
  await toggl.push!.stop!("tok", "toggl:c1:42");
  expect(calls[1]!.method).toBe("DELETE");
  expect(calls[1]!.url).toBe(`${HOOKS}/subscriptions/42/3`);
});

test("a bad or missing signature, or another workspace's, is refused (the route answers 401)", async () => {
  const body = event("time_entry", "created");
  expect(await toggl.push!.receive!(delivery(body, { sig: "sha256=00" }), "k")).toBeNull();
  expect(await toggl.push!.receive!(delivery(body, { sig: sign(JSON.stringify(body), "wrong") }), "k")).toBeNull();
  expect(await toggl.push!.receive!({ ...delivery(body), headers: {} }, "k")).toBeNull();
  expect(await toggl.push!.receive!(delivery(body, { rest: "43" }), "k")).toBeNull();
});

test("the validation ping is answered with its code and starts nothing", async () => {
  const got = await toggl.push!.receive!(delivery({ event_id: 0, payload: "ping", validation_code: "abc", metadata: {} }), "k");
  expect(got!.reply).toEqual({ validation_code: "abc" });
  expect(await got!.events()).toEqual([]);
});

test("each event starts only its own trigger, with a delivery id; an unknown one starts none", async () => {
  for (const [name, e] of Object.entries(events)) {
    const [model, action] = e.split(":");
    expect((await receive(event(model!, action!))).triggers).toEqual([name]);
  }
  expect((await receive(event("invoice", "created"))).triggers).toEqual([]);
  expect((await receive(event("tag", "created", {}, 5))).id).toBe("c1:5");
});

test("filters narrow what runs", async () => {
  const data = (await receive(event("time_entry", "created", { id: 7, project_id: 8, user_id: 9 }))).data;
  expect(wanted({ workspace_id: 42 }, data)).toBe(true);
  expect(wanted({ project_id: 8 }, data)).toBe(true);
  expect(wanted({ project_id: "8" }, data)).toBe(true);
  expect(wanted({ project_id: 1 }, data)).toBe(false);
  expect(wanted({ user_id: 9 }, data)).toBe(true);
  expect(wanted({ user_id: 2 }, data)).toBe(false);
});

test("every Toggl event filter is a trigger needing a workspace", () => {
  expect(Object.keys(triggers)).toHaveLength(28);
  for (const t of Object.values(triggers)) expect(t.config[0]).toMatchObject({ name: "workspace_id", required: true });
});

test("the polled new time entry finds the person's recent entries", async () => {
  const now = new Date().toISOString();
  const run = async () => [{ id: 1, project_id: 8, at: now }, { id: 2, project_id: 3, at: now }, { id: 3, at: "2020-01-01T00:00:00Z" }];
  const poll = pollTrigger("toggl.new_time_entry")!;
  expect((await poll.poll({}, run)).map((i) => i.id)).toEqual(["1", "2"]);
  expect((await poll.poll({ project_id: 8 }, run)).map((i) => i.id)).toEqual(["1"]);
});
