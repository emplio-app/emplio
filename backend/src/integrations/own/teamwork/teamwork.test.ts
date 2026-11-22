import { afterEach, beforeAll, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { AppsError } from "../../types";
import { own } from "../index";
import { pollTrigger } from "../../polls/index";
import { events, token, triggers, wanted } from "./triggers";
import { parseKey, teamwork } from "./index";

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
const KEY = "acme tkn.v1_secret";
const login = { externalId: "c1", secret: KEY };
const target = "https://api.test/webhooks/app/teamwork/c1/TASK.CREATED";
const sign = (body: string, t = token("c1")) => createHmac("sha256", t).update(body).digest("hex");
const delivery = (event: string, body: unknown, signature?: string) => {
  const raw = JSON.stringify(body);
  return { body: raw, headers: { "x-projects-signature": signature ?? sign(raw) }, connection: "c1", rest: event };
};
const fire = async (event: string, body: unknown) => (await (await teamwork.push!.receive!(delivery(event, body), KEY))!.events())[0]?.triggers ?? [];

test("the site and key go to the person's own site with basic auth, and a bad key is refused as dead", async () => {
  const calls = stub(() => json({ person: { id: 1, firstName: "Sarah", lastName: "Lee" } }));
  expect(await own.connectWithKey!("teamwork", KEY)).toEqual({ secret: KEY, label: "Sarah Lee (acme.teamwork.com)" });
  expect(calls[0]!.url).toBe("https://acme.teamwork.com/projects/api/v3/me.json");
  expect(calls[0]!.headers.Authorization).toBe(`Basic ${Buffer.from("tkn.v1_secret:x").toString("base64")}`);
  stub(() => json({ MESSAGE: "Invalid API key" }, 401));
  const refused = await own.connectWithKey!("teamwork", "acme nope").catch((e) => e);
  expect(refused).toBeInstanceOf(AppsError);
  expect(refused.expired).toBe(true);
});

test("the pasted line is read in either order, EU sites work, and only Teamwork's hosts are accepted", () => {
  expect(parseKey("tkn.v1_abc https://acme.eu.teamwork.com/app/home")).toEqual({ host: "acme.eu.teamwork.com", token: "tkn.v1_abc" });
  expect(parseKey("acme.teamwork.com twp_abcdefghij")).toEqual({ host: "acme.teamwork.com", token: "twp_abcdefghij" });
  expect(() => parseKey("https://evil.example.com tkn.v1_abc")).toThrow(AppsError);
  expect(() => parseKey("acme.teamwork.com.evil.com tkn.v1_abc")).toThrow(AppsError);
  expect(() => parseKey("tkn_only")).toThrow(AppsError);
});

test("v3 and v1 calls both go to the site, with path ids filled in", async () => {
  const calls = stub(() => json({ ok: true }));
  await own.run("teamwork.create_task", { tasklistId: 5, task: { name: "Call Northwind" } }, login, "o");
  expect(calls[0]!.url).toStartWith("https://acme.teamwork.com/projects/api/v3/tasklists/5/tasks.json");
  expect(JSON.parse(calls[0]!.body)).toEqual({ task: { name: "Call Northwind" } });
  await own.run("teamwork.retrieve_single_project", { id: 9 }, login, "o");
  expect(calls[1]!.url).toStartWith("https://acme.teamwork.com/projects/9.json");
});

test("reads run unasked, writes ask, and API keys or webhook tokens ask first", async () => {
  expect((await own.getAction("teamwork.list_projects"))?.readOnly).toBe(true);
  expect((await own.getAction("teamwork.list_tasks"))?.readOnly).toBe(true);
  expect((await own.getAction("teamwork.run_reporting_engine_query"))?.readOnly).toBe(true);
  expect((await own.getAction("teamwork.create_task"))?.readOnly).toBe(false);
  expect((await own.getAction("teamwork.log_time_entry"))?.readOnly).toBe(false);
  expect((await own.getAction("teamwork.retrieve_api_keys_for_people_on_account"))?.readOnly).toBe(false);
  expect((await own.getAction("teamwork.get_webhooks"))?.readOnly).toBe(false);
});

test("every action's input builds", () => {
  for (const [name, a] of Object.entries(teamwork.actions)) expect(() => a.input, name).not.toThrow();
});

test("Composio's action names are all here", async () => {
  for (const n of ["create_tag", "create_task", "list_milestones", "list_people", "list_projects", "list_tags", "list_task_lists", "list_tasks", "list_time_entries", "log_time_entry", "search_resources", "update_task"])
    expect(await own.getAction(`teamwork.${n}`)).toBeDefined();
});

test("a report export comes back as a file", async () => {
  stub(() => new Response(new Uint8Array([37, 80, 68, 70]), { headers: { "content-type": "application/pdf" } }));
  const pdf = Object.keys(teamwork.actions).find((n) => n.endsWith("_as_pdf"))!;
  const got = (await own.run(`teamwork.${pdf}`, { projectId: 1 }, login, "o")) as { mimetype?: string };
  expect(got.mimetype).toBe("application/pdf");
});

test("the first automation on an event makes its signed webhook, the next reuses it, a paused one is replaced", async () => {
  const none = stub((c) => (c.method === "GET" ? json({ webhooks: [] }) : json({ id: "3" })));
  expect(await own.startPush!("teamwork.task_created", login, {})).toBe("teamwork:c1:TASK.CREATED");
  expect(none[0]!.url).toBe("https://acme.teamwork.com/webhooks.json");
  expect(none[1]!.method).toBe("POST");
  expect(JSON.parse(none[1]!.body)).toEqual({ webhook: { event: "TASK.CREATED", url: target, version: "2", contentType: "application/json", token: token("c1") } });
  const live = { id: "3", url: target, event: "TASK.CREATED", status: "ACTIVE" };
  const same = stub(() => json({ webhooks: [live, { ...live, id: "4", url: "https://other" }] }));
  await own.startPush!("teamwork.task_created", login, {});
  expect(same).toHaveLength(1);
  const off = stub((c) => (c.method === "GET" ? json({ webhooks: [{ ...live, status: "INACTIVE" }] }) : json({})));
  await own.startPush!("teamwork.task_created", login, {});
  expect(off.slice(1).map((c) => `${c.method} ${c.url}`)).toEqual(["DELETE https://acme.teamwork.com/webhooks/3.json", "POST https://acme.teamwork.com/webhooks.json"]);
});

test("a refused webhook says what Teamwork needs", async () => {
  stub((c) => (c.method === "GET" ? json({ webhooks: [] }) : json({ MESSAGE: "You do not have permission" }, 403)));
  await expect(own.startPush!("teamwork.task_created", login, {})).rejects.toThrow(/site administrator/);
});

test("the last automation removes only our webhook for that event", async () => {
  const calls = stub((c) => (c.method === "GET" ? json({ webhooks: [{ id: "4", url: "https://other" }, { id: "3", url: target }] }) : json({})));
  await teamwork.push!.stop!(KEY, "teamwork:c1:TASK.CREATED");
  expect(calls.slice(1).map((c) => `${c.method} ${c.url}`)).toEqual(["DELETE https://acme.teamwork.com/webhooks/3.json"]);
});

test("a wrong or missing signature is refused", async () => {
  expect(await teamwork.push!.receive!(delivery("TASK.CREATED", { task: { id: 1 } }, sign("x")), KEY)).toBeNull();
  expect(await teamwork.push!.receive!(delivery("TASK.CREATED", { task: { id: 1 } }, ""), KEY)).toBeNull();
  expect(await teamwork.push!.receive!(delivery("TASK.CREATED", { task: { id: 1 } }, sign(JSON.stringify({ task: { id: 1 } }), token("c2"))), KEY)).toBeNull();
});

test("each event starts only its trigger, and a retry has the same id", async () => {
  expect(await fire("TASK.CREATED", { task: { id: 1 } })).toEqual(["task_created"]);
  expect(await fire("TASK.COMPLETED", { task: { id: 1 } })).toEqual(["task_completed"]);
  expect(await fire("TASKLIST.CREATEDFROMTEMPLATE", { taskList: { id: 1 } })).toEqual(["task_list_created_from_template"]);
  expect(await fire("MESSAGEREPLY.CREATED", {})).toEqual(["message_reply_created"]);
  expect(await fire("MYSTERY.CREATED", {})).toEqual([]);
  const [a] = await (await teamwork.push!.receive!(delivery("TIME.CREATED", { time: { id: 7 } }), KEY))!.events();
  const [b] = await (await teamwork.push!.receive!(delivery("TIME.CREATED", { time: { id: 7 } }), KEY))!.events();
  expect(a!.id).toBe(b!.id!);
  expect(a!.id).toStartWith("c1:TIME.CREATED:");
  expect(a!.data).toEqual({ event: "TIME.CREATED", time: { id: 7 } });
});

test("filters narrow by project and task list, deletes included", () => {
  const task = { event: "TASK.UPDATED", task: { id: 1, projectId: 2, tasklistId: 3 } };
  expect(wanted({}, task)).toBe(true);
  expect(wanted({ project_id: 2, tasklist_id: 3 }, task)).toBe(true);
  expect(wanted({ project_id: 9 }, task)).toBe(false);
  expect(wanted({ tasklist_id: 9 }, task)).toBe(false);
  expect(wanted({ project_id: 2 }, { event: "TASKLIST.UPDATED", milestone: { projectId: 9 }, taskList: { id: 1, projectId: 2 } })).toBe(true);
  expect(wanted({ project_id: 2 }, { event: "PROJECT.CREATED", project: { id: 2 } })).toBe(true);
  expect(wanted({ project_id: 2 }, { event: "TASK.DELETED", id: 1, projectId: 2 })).toBe(true);
});

test("every Teamwork event has a trigger", () => {
  expect(Object.keys(triggers)).toHaveLength(Object.keys(events).length);
  expect(new Set(Object.values(events)).size).toBe(Object.keys(events).length);
  for (const t of ["task_created", "task_completed", "project_created", "comment_created", "time_created", "milestone_completed", "invoice_created", "form_submitted"]) expect(triggers[t]).toBeDefined();
});

test("the activity poll reports only recent items and passes its filters", async () => {
  let input: any;
  const run = async (_action: string, i: unknown) => ((input = i), { activities: [{ id: 1, dateTime: new Date().toISOString() }, { id: 2, dateTime: "2020-01-01T00:00:00Z" }] });
  const poll = pollTrigger("teamwork.new_activity")!;
  expect((await poll.poll({ project_id: 4, activity_types: ["new", "completed"] }, run)).map((i) => i.id)).toEqual(["1"]);
  expect(input).toEqual({ pageSize: 100, projectIds: [4], activityTypes: ["new,completed"] });
  expect(await poll.poll({}, async () => ({}))).toEqual([]);
});
