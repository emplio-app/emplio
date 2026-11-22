import { afterEach, beforeAll, expect, spyOn, test } from "bun:test";
import { createHmac, randomBytes } from "node:crypto";
import Fastify from "fastify";
import { automationRoutes } from "../../../automations";
import { db } from "../../../db";
import { encrypt } from "../../../secrets";
import { pollTrigger } from "../../polls/index";
import { AppFile, AppsError } from "../../types";
import { own } from "../index";
import { parseKey, wrike } from "./index";
import { triggers, wanted } from "./triggers";

// encrypt() needs a real 32-byte key, which CI doesn't set; set before the webhook secret below is worked out
if (Buffer.from(process.env.ENCRYPTION_KEY ?? "", "base64").length !== 32) process.env.ENCRYPTION_KEY = randomBytes(32).toString("base64");
const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});
beforeAll(() => {
  process.env.WEBHOOK_URL = "https://api.test";
});
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
type Call = { url: string; method: string; body: any; headers: Record<string, string> };
const stub = (answer: (c: Call) => Response) => {
  const calls: Call[] = [];
  globalThis.fetch = (async (url: string, init: RequestInit = {}) => {
    const c = { url: String(url), method: init.method ?? "GET", body: init.body, headers: init.headers as Record<string, string> };
    calls.push(c);
    return answer(c);
  }) as typeof fetch;
  return calls;
};
const login = { externalId: "c1", secret: "tok" };
const BASE = "https://www.wrike.com/api/v4";
const secret = createHmac("sha256", process.env.ENCRYPTION_KEY!).update("wrike-webhook:c1").digest("hex");
const sign = (body: string, key = secret) => createHmac("sha256", key).update(body).digest("hex");
const delivery = (body: unknown, headers: Record<string, string> = {}, rest = "") => {
  const text = JSON.stringify(body);
  return { body: text, headers: { "x-hook-signature": sign(text), ...headers }, connection: "c1", rest };
};

test("the key: a bare token, or with where the account lives, and never a host that isn't Wrike's", () => {
  expect(parseKey(" eyJ0dCI6InAi.abc-_ ")).toEqual({ host: "www.wrike.com", token: "eyJ0dCI6InAi.abc-_", region: false });
  expect(parseKey("eu:tok").host).toBe("app-eu.wrike.com");
  expect(parseKey("us2:tok").host).toBe("app-us2.wrike.com");
  expect(parseKey("app-eu.wrike.com tok")).toEqual({ host: "app-eu.wrike.com", token: "tok", region: true });
  expect(parseKey("https://app-eu.wrike.com/workspace.htm#path=inbox tok").host).toBe("app-eu.wrike.com");
  expect(() => parseKey("evil.com:tok")).toThrow(AppsError);
});

test("a token is checked and labelled, a refused one is dead, and one from another data centre says where it works", async () => {
  const calls = stub(() => json({ data: [{ firstName: "Sarah", lastName: "Lee" }] }));
  expect(await own.connectWithKey!("wrike", " tok ")).toEqual({ secret: "tok", label: "Sarah Lee" });
  expect(calls[0]!.url).toBe(`${BASE}/contacts?me=true`);
  expect(calls[0]!.headers.Authorization).toBe("Bearer tok");
  expect(await own.connectWithKey!("wrike", "eu:tok")).toEqual({ secret: "eu:tok", label: "Sarah Lee (app-eu.wrike.com)" });
  expect(calls[1]!.url).toStartWith("https://app-eu.wrike.com/api/v4/contacts");
  expect(calls[1]!.headers.Authorization).toBe("Bearer tok");
  stub(() => json({ error: "not_authorized", errorDescription: "Authorization error" }, 401));
  const refused = await own.connectWithKey!("wrike", "nope").catch((e) => e);
  expect(refused).toBeInstanceOf(AppsError);
  expect(refused.expired).toBe(true);
  stub((c) => (c.url.startsWith("https://app-eu.") ? json({ data: [{}] }) : json({ error: "not_authorized" }, 401)));
  await expect(wrike.check("tok")).rejects.toThrow(/eu:/);
});

test("writes go as a form with lists and objects as JSON, reads in the query, to the account's own host", async () => {
  const calls = stub(() => json({ data: [] }));
  await own.run("wrike.create_task", { folderId: "F1", title: "Call Northwind", responsibles: ["KU1"], dates: { due: "2026-12-01" }, importance: "High" }, { externalId: "c1", secret: "eu:tok" }, "o");
  expect(calls[0]!.method).toBe("POST");
  expect(calls[0]!.url).toBe("https://app-eu.wrike.com/api/v4/folders/F1/tasks");
  const sent = new URLSearchParams(calls[0]!.body);
  expect(sent.get("title")).toBe("Call Northwind");
  expect(sent.get("importance")).toBe("High");
  expect(JSON.parse(sent.get("responsibles")!)).toEqual(["KU1"]);
  expect(JSON.parse(sent.get("dates")!)).toEqual({ due: "2026-12-01" });
  await own.run("wrike.fetch_all_tasks", { title: "Call", responsibles: ["KU1"] }, login, "o");
  const url = new URL(calls[1]!.url);
  expect(url.pathname).toBe("/api/v4/tasks");
  expect(url.searchParams.get("title")).toBe("Call");
  expect(url.searchParams.get("responsibles")).toBe('["KU1"]');
});

test("every action's input builds, reads run unasked and writes ask", async () => {
  for (const [name, action] of Object.entries(wrike.actions)) expect(action.input, name).toBeDefined();
  expect(Object.keys(wrike.actions).length).toBeGreaterThan(200);
  for (const n of ["fetch_all_tasks", "get_task_by_id", "search_ediscovery", "get_all_webhooks", "list_spaces"]) expect((await own.getAction(`wrike.${n}`))?.readOnly, n).toBe(true);
  for (const n of ["create_task", "modify_task", "delete_task", "create_task_comment", "delete_webhook", "upload_task_attachment"]) expect((await own.getAction(`wrike.${n}`))?.readOnly, n).toBeFalsy();
});

test("a downloaded file comes back as a file with its name, and an upload sends the file with its name", async () => {
  stub((c) => (c.url.endsWith("/download") ? new Response(new Uint8Array([37, 80, 68, 70]), { headers: { "content-type": "application/pdf" } }) : json({ data: [{ id: "A1", name: "quote.pdf" }] })));
  const got = (await own.run("wrike.get_attachments_download", { attachmentId: "A1" }, login, "o")) as AppFile;
  expect(got.name).toBe("quote.pdf");
  expect(got.mimetype).toBe("application/pdf");
  const calls = stub(() => json({ data: [{ id: "A2" }] }));
  await wrike.actions.upload_task_attachment!.run({ taskId: "T1", file: new AppFile("price list é.pdf", "application/pdf", new Uint8Array([1, 2])) }, "tok");
  expect(calls[0]!.url).toBe(`${BASE}/tasks/T1/attachments`);
  expect(calls[0]!.headers["X-File-Name"]).toBe("price list %C3%A9.pdf");
  expect(calls[0]!.body).toEqual(new Uint8Array([1, 2]));
});

test("the first automation makes a signed account webhook, the next reuses it, a suspended one is resumed", async () => {
  const none = stub((c) => (c.method === "GET" ? json({ data: [] }) : json({ data: [{ id: "W1" }] })));
  expect(await own.startPush!("wrike.task_created", login, {})).toBe("wrike:c1");
  expect(none[0]!.url).toBe(`${BASE}/webhooks`);
  expect(none[1]!.method).toBe("POST");
  expect(none[1]!.url).toBe(`${BASE}/webhooks`);
  expect(Object.fromEntries(new URLSearchParams(none[1]!.body))).toEqual({ hookUrl: "https://api.test/webhooks/app/wrike/c1", secret });
  const live = { id: "W1", hookUrl: "https://api.test/webhooks/app/wrike/c1", status: "Active" };
  const same = stub(() => json({ data: [live, { ...live, id: "W2", hookUrl: "https://other" }] }));
  await own.startPush!("wrike.comment_added", login, {});
  expect(same).toHaveLength(1);
  const off = stub((c) => (c.method === "GET" ? json({ data: [{ ...live, status: "Suspended" }] }) : json({ data: [] })));
  await own.startPush!("wrike.comment_added", login, {});
  expect(off[1]!.method).toBe("PUT");
  expect(off[1]!.url).toBe(`${BASE}/webhooks/W1`);
  expect(off[1]!.body).toBe("status=Active");
});

test("an automation on one folder or space gets its own webhook there", async () => {
  const calls = stub((c) => (c.method === "GET" ? json({ data: [] }) : json({ data: [{ id: "W3" }] })));
  expect(await own.startPush!("wrike.task_created", login, { folder_id: "IEAAF1" })).toBe("wrike:c1:f-IEAAF1");
  expect(calls[1]!.url).toBe(`${BASE}/folders/IEAAF1/webhooks`);
  expect(Object.fromEntries(new URLSearchParams(calls[1]!.body))).toEqual({ hookUrl: "https://api.test/webhooks/app/wrike/c1/f-IEAAF1", secret, recursive: "true" });
  expect(await own.startPush!("wrike.task_created", login, { space_id: "IEAAS1" })).toBe("wrike:c1:s-IEAAS1");
  expect(calls[3]!.url).toBe(`${BASE}/spaces/IEAAS1/webhooks`);
  await expect(own.startPush!("wrike.task_created", login, { folder_id: "../x" })).rejects.toThrow(/folder_id/);
});

test("the last automation removes only our webhook", async () => {
  const calls = stub((c) => (c.method === "GET" ? json({ data: [{ id: "W4", hookUrl: "https://other" }, { id: "W3", hookUrl: "https://api.test/webhooks/app/wrike/c1/f-IEAAF1" }] }) : json({ data: [] })));
  await wrike.push!.stop!("tok", "wrike:c1:f-IEAAF1");
  expect(calls.slice(1).map((c) => `${c.method} ${c.url}`)).toEqual([`DELETE ${BASE}/webhooks/W3`]);
});

test("the handshake is answered, and a wrong signature or odd challenge is refused", async () => {
  const hello = { requestType: "WebHook secret verification" };
  const got = await wrike.push!.receive!(delivery(hello, { "x-hook-secret": "abc123" }), "tok");
  expect(got!.headers).toEqual({ "X-Hook-Secret": sign("abc123") });
  expect(await got!.events()).toEqual([]);
  expect(await wrike.push!.receive!(delivery(hello, { "x-hook-secret": '{"a":1}' }), "tok")).toBeNull();
  expect(await wrike.push!.receive!({ ...delivery(hello, { "x-hook-secret": "abc" }), headers: { "x-hook-signature": sign("x", "nope"), "x-hook-secret": "abc" } }, "tok")).toBeNull();
  expect(await wrike.push!.receive!({ ...delivery([]), headers: {} }, "tok")).toBeNull();
});

const event = (eventType: string, more: object = {}) => ({ webhookId: "W1", eventAuthorId: "KU9", eventType, taskId: "T1", lastUpdatedDate: "2026-11-22T10:00:00Z", ...more });
const fire = async (body: unknown, items: unknown[] = []) => {
  const calls = stub(() => json({ data: items }));
  const events = await (await wrike.push!.receive!(delivery(body), "tok"))!.events();
  return { events, calls };
};

test("each event starts only the right triggers, with the task as it is now", async () => {
  const done = await fire([event("TaskStatusChanged", { oldStatus: "Active", status: "Completed" })], [{ id: "T1", title: "Send quote", status: "Completed" }]);
  expect(done.calls[0]!.url).toBe(`${BASE}/tasks/T1`);
  expect(done.events[0]!.triggers).toEqual(["task_status_changed", "task_completed"]);
  expect(done.events[0]!.data).toMatchObject({ eventType: "TaskStatusChanged", item: { title: "Send quote" }, changes: { oldStatus: "Active", status: "Completed" } });
  expect((done.events[0]!.data as { changes: object }).changes).not.toHaveProperty("webhookId");
  expect((await fire([event("TaskStatusChanged", { status: "In Review" })], [{ id: "T1", status: "Active" }])).events[0]!.triggers).toEqual(["task_status_changed"]);
  const gone = await fire([event("TaskDeleted")]);
  expect(gone.calls).toHaveLength(0);
  expect(gone.events[0]!.triggers).toEqual(["task_deleted"]);
  const folder = await fire([{ ...event("ProjectStatusChanged"), taskId: undefined, folderId: "F1" }, event("CommentAdded", { commentId: "C1" })], [{ id: "F1" }]);
  expect(folder.calls.map((c) => c.url).sort()).toEqual([`${BASE}/folders/F1`, `${BASE}/tasks/T1`]);
  expect(folder.events.map((e) => e.triggers)).toEqual([["project_status_changed"], ["comment_added"]]);
  expect((await fire([event("SomethingNew")])).events).toEqual([]);
});

test("a retry has the same id, and the same event on another webhook doesn't", async () => {
  const body = [event("CommentAdded", { commentId: "C1" })];
  stub(() => json({ data: [] }));
  const [a] = await (await wrike.push!.receive!(delivery(body), "tok"))!.events();
  const [b] = await (await wrike.push!.receive!(delivery(body), "tok"))!.events();
  const [c] = await (await wrike.push!.receive!(delivery(body, {}, "f-F1"), "tok"))!.events();
  expect(a!.id).toBe(b!.id!);
  expect(a!.id).toStartWith("c1:");
  expect(c!.id).not.toBe(a!.id!);
});

test("filters: one task, one assignee, one status", () => {
  const data = { eventType: "TaskStatusChanged", taskId: "T1", item: { id: "T1", responsibleIds: ["KU1"], status: "Active" }, changes: { status: "In Review" } };
  expect(wanted({}, data)).toBe(true);
  expect(wanted({ task_id: "T1", assignee_id: "KU1", status: "in review" }, data)).toBe(true);
  expect(wanted({ task_id: "T2" }, data)).toBe(false);
  expect(wanted({ assignee_id: "KU2" }, data)).toBe(false);
  expect(wanted({ status: "Completed" }, data)).toBe(false);
  expect(wanted({ assignee_id: "KU2" }, { ...data, changes: { addedResponsibles: ["KU2"] } })).toBe(true);
});

test("every event Wrike sends has a trigger", () => {
  for (const t of ["task_created", "task_status_changed", "task_completed", "comment_added", "attachment_added", "timelog_changed", "folder_created", "project_status_changed", "task_approval_decision_changed", "folder_comment_added", "import_from_file_completed"]) expect(triggers[t], t).toBeDefined();
  expect(Object.keys(triggers)).toHaveLength(46);
});

test("the shared webhook route: a forged signature gets 401, a real one 200", async () => {
  const find = spyOn(db.query.connections, "findFirst");
  const app = Fastify();
  await automationRoutes(app);
  const body = JSON.stringify([event("TaskDeleted")]);
  const post = (signature: string) => app.inject({ method: "POST", url: "/webhooks/app/wrike/c1", headers: { "content-type": "application/json", "x-hook-signature": signature }, payload: body });
  try {
    find.mockResolvedValue({ id: "row", app: "wrike", secret: encrypt("tok"), refreshToken: null, expiresAt: null } as never);
    expect((await post(sign(body, "forged"))).statusCode).toBe(401);
    spyOn(db, "select").mockReturnValue({ from: () => ({ where: async () => [] }) } as never);
    expect((await post(sign(body))).statusCode).toBe(200);
  } finally {
    find.mockRestore();
    await app.close();
  }
});

test("polls: new people and new spaces", async () => {
  const asked: unknown[] = [];
  const run = async (action: string, input: unknown) => (asked.push([action, input]), { data: [{ id: "KU1" }, { id: "KU2" }] });
  expect((await pollTrigger("wrike.new_user")!.poll({}, run)).map((i) => i.id)).toEqual(["KU1", "KU2"]);
  expect(asked[0]).toEqual(["wrike.get_contacts", { types: ["Person"], deleted: false }]);
  expect((await pollTrigger("wrike.new_space")!.poll({}, async () => ({ data: null }))).length).toBe(0);
});
