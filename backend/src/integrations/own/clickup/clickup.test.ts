import { afterEach, beforeAll, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { AppsError } from "../../types";
import { own } from "../index";
import { events, triggers, wanted } from "./triggers";
import { clickup } from "./index";

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
const login = { externalId: "c1", secret: "pk_x" };
const token = () => createHmac("sha256", process.env.ENCRYPTION_KEY!).update("clickup-webhook:c1:42").digest("hex");
const endpoint = () => `https://api.test/webhooks/app/clickup/c1/42/${token()}`;
const delivery = (body: unknown, rest = `42/${token()}`) => ({ body: JSON.stringify(body), headers: {}, connection: "c1", rest });
const receive = async (body: unknown) => (await (await clickup.push!.receive!(delivery(body), "k"))!.events())[0]!;

test("a token is checked and labelled with no Bearer, and a bad one is refused as dead", async () => {
  const calls = stub(() => json({ user: { id: 1, username: "Asha" } }));
  expect(await own.connectWithKey!("clickup", " pk_x ")).toEqual({ secret: "pk_x", label: "Asha" });
  expect(calls[0]!.url).toBe("https://api.clickup.com/api/v2/user");
  expect(calls[0]!.headers.Authorization).toBe("pk_x");
  stub(() => json({ err: "Token invalid", ECODE: "OAUTH_025" }, 401));
  const refused = await own.connectWithKey!("clickup", "nope").catch((e) => e);
  expect(refused).toBeInstanceOf(AppsError);
  expect(refused.expired).toBe(true);
});

test("a Workspace this token can't see isn't a dead login", async () => {
  stub(() => json({ err: "Team not authorized", ECODE: "OAUTH_027" }, 401));
  const refused = (await own.run("clickup.get_spaces", { team_id: "1" }, login, "o").catch((e) => e)) as AppsError;
  expect(refused).toBeInstanceOf(AppsError);
  expect(refused.expired).toBeFalsy();
});

test("reads run unasked, writes ask, the webhook list with its secrets asks", async () => {
  expect((await own.getAction("clickup.get_task"))?.readOnly).toBe(true);
  expect((await own.getAction("clickup.create_task"))?.readOnly).toBe(false);
  expect((await own.getAction("clickup.delete_task"))?.readOnly).toBe(false);
  expect((await own.getAction("clickup.get_webhooks"))?.readOnly).toBe(false);
});

test("a call goes under /api/v2 with the bare token and a plain body", async () => {
  const calls = stub(() => json({ id: "t1" }));
  await own.run("clickup.create_task", { list_id: 7, name: "Call Ravi" }, login, "o");
  expect(calls[0]!.url).toBe("https://api.clickup.com/api/v2/list/7/task");
  expect(calls[0]!.headers.Authorization).toBe("pk_x");
  expect(JSON.parse(calls[0]!.body)).toEqual({ name: "Call Ravi" });
});

test("v3 calls go to /api/v3 with the same token", async () => {
  const calls = stub(() => json({ id: "d1" }));
  await own.run("clickup.create_doc", { workspace_id: 42, name: "Plan" }, login, "o");
  expect(calls[0]!.url).toBe("https://api.clickup.com/api/v3/workspaces/42/docs");
  expect(calls[0]!.headers.Authorization).toBe("pk_x");
  expect((await own.getAction("clickup.create_workspace_level_audit_logs"))?.readOnly).toBe(true);
});

test("the first automation makes the Workspace's webhook, the next extends it, the same event needs no call", async () => {
  const none = stub((c) => json(c.method === "GET" ? { webhooks: [] } : { id: "w1" }));
  expect(await own.startPush!("clickup.task_created", login, { team_id: "42" })).toBe("clickup:c1:42");
  expect(none[1]!.method).toBe("POST");
  expect(none[1]!.url).toBe("https://api.clickup.com/api/v2/team/42/webhook");
  expect(JSON.parse(none[1]!.body)).toEqual({ endpoint: endpoint(), events: ["taskCreated"] });
  const hook = { id: "w1", endpoint: endpoint(), events: ["taskCreated"], health: { status: "active" } };
  const add = stub((c) => json(c.method === "GET" ? { webhooks: [hook] } : {}));
  await own.startPush!("clickup.task_deleted", login, { team_id: "42" });
  expect(add[1]!.method).toBe("PUT");
  expect(add[1]!.url).toEndWith("/v2/webhook/w1");
  expect(JSON.parse(add[1]!.body)).toEqual({ endpoint: endpoint(), events: ["taskCreated", "taskDeleted"], status: "active" });
  const same = stub(() => json({ webhooks: [hook] }));
  await own.startPush!("clickup.task_created", login, { team_id: "42" });
  expect(same).toHaveLength(1);
  const failing = stub((c) => json(c.method === "GET" ? { webhooks: [{ ...hook, health: { status: "suspended" } }] } : {}));
  await own.startPush!("clickup.task_created", login, { team_id: "42" });
  expect(JSON.parse(failing[1]!.body).status).toBe("active");
});

test("a Workspace is required and must look like one", async () => {
  await expect(own.startPush!("clickup.task_created", login, {})).rejects.toThrow(/team_id/);
  await expect(own.startPush!("clickup.task_created", login, { team_id: "4:2" })).rejects.toThrow(/team_id/);
  stub((c) => json(c.method === "GET" ? { webhooks: [] } : { id: "w1" }));
  expect(await own.startPush!("clickup.task_created", login, { team_id: 42 })).toBe("clickup:c1:42");
});

test("the last automation removes the webhook, found by its URL", async () => {
  const calls = stub((c) => json(c.method === "GET" ? { webhooks: [{ id: "other", endpoint: "https://x", events: [] }, { id: "w1", endpoint: endpoint(), events: [] }] } : {}));
  await clickup.push!.stop!("k", "clickup:c1:42");
  expect(calls[1]!.method).toBe("DELETE");
  expect(calls[1]!.url).toEndWith("/v2/webhook/w1");
});

test("a bad token in the URL is refused", async () => {
  expect(await clickup.push!.receive!(delivery({ event: "taskCreated" }, "42/nope"), "k")).toBeNull();
  expect(await clickup.push!.receive!(delivery({ event: "taskCreated" }, `43/${token()}`), "k")).toBeNull();
  expect(await clickup.push!.receive!(delivery({ event: "taskCreated" }, ""), "k")).toBeNull();
});

test("each event starts only its own trigger, and one nobody knows starts none", async () => {
  for (const [name, event] of Object.entries(events)) expect((await receive({ event, task_id: "t" })).triggers).toEqual([name]);
  expect((await receive({ event: "somethingNew" })).triggers).toEqual([]);
});

test("a retry has the same id; one change's several events don't; updates with no history have none", async () => {
  const body = { event: "taskUpdated", task_id: "t", history_items: [{ id: "h1" }] };
  expect((await receive(body)).id).toBe((await receive(body)).id!);
  expect((await receive({ ...body, event: "taskStatusUpdated" })).id).not.toBe((await receive(body)).id!);
  expect((await receive({ event: "folderCreated", folder_id: "9" })).id).toBeDefined();
  expect((await receive({ event: "folderUpdated", folder_id: "9" })).id).toBeUndefined();
});

test("filters narrow what runs", () => {
  const data = { event: "taskCreated", task_id: "t1", history_items: [{ id: "h", parent_id: "7" }] };
  expect(wanted({ team_id: "42" }, data)).toBe(true);
  expect(wanted({ list_id: "7" }, data)).toBe(true);
  expect(wanted({ list_id: 7 }, data)).toBe(true);
  expect(wanted({ list_id: "8" }, data)).toBe(false);
  expect(wanted({ task_id: "t2" }, data)).toBe(false);
  expect(wanted({ folder_id: "9" }, { event: "folderUpdated", folder_id: "9" })).toBe(true);
  expect(wanted({ folder_id: "9" }, { event: "folderUpdated", folder_id: "1" })).toBe(false);
});

test("every Composio trigger is here under its name, and all need a Workspace", () => {
  for (const name of "folder_created folder_deleted folder_updated list_created list_deleted list_updated space_created space_deleted space_updated task_assignee_updated task_comment_posted task_comment_updated task_created task_deleted task_due_date_updated task_priority_updated task_status_updated task_tag_updated task_time_estimate_updated task_time_tracked_updated task_updated".split(" ")) expect(triggers[name]).toBeDefined();
  for (const t of Object.values(triggers)) expect(t.config[0]).toMatchObject({ name: "team_id", required: true });
  expect(triggers.task_deleted!.config.map((c) => c.name)).toEqual(["team_id", "task_id"]);
});
