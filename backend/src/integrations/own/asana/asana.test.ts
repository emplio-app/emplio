import { afterEach, beforeAll, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { AppsError } from "../../types";
import { own } from "../index";
import { triggers, wanted } from "./triggers";
import { asana } from "./index";

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
const token = () => createHmac("sha256", process.env.ENCRYPTION_KEY!).update("asana-webhook:c1:42").digest("hex");
const target = () => `https://api.test/webhooks/app/asana/c1/42/${token()}`;
// the calls every start and stop make first
const lookup = (hooks: unknown[], other: (c: Call) => Response = () => json({ data: {} })) => (c: Call) =>
  c.url.includes("/projects/42") ? json({ data: { workspace: { gid: "9" } } }) : c.method === "GET" && c.url.includes("/webhooks") ? json({ data: hooks }) : other(c);
const delivery = (body: unknown, rest = `42/${token()}`, headers = {}) => ({ body: JSON.stringify(body), headers, connection: "c1", rest });
const task = (action: string, parent?: object, extra = {}) => ({ action, created_at: "2026-11-09T10:00:00.000Z", resource: { gid: "7", resource_type: "task" }, parent: parent ?? null, ...extra });
const story = (subtype: string) => ({ action: "added", created_at: "2026-11-09T10:00:00.000Z", resource: { gid: "5", resource_type: "story", resource_subtype: subtype }, parent: { gid: "7", resource_type: "task" } });

test("a token is checked and labelled, and a bad one is refused as dead", async () => {
  const calls = stub(() => json({ data: { gid: "1", name: "Asha" } }));
  expect(await own.connectWithKey!("asana", " tok ")).toEqual({ secret: "tok", label: "Asha" });
  expect(calls[0]!.url).toBe("https://app.asana.com/api/1.0/users/me");
  expect(calls[0]!.headers.Authorization).toBe("Bearer tok");
  stub(() => json({ errors: [{ message: "Not Authorized" }] }, 401));
  const refused = await own.connectWithKey!("asana", "nope").catch((e) => e);
  expect(refused).toBeInstanceOf(AppsError);
  expect(refused.expired).toBe(true);
});

test("reads run unasked, writes ask", async () => {
  expect((await own.getAction("asana.get_a_task"))?.readOnly).toBe(true);
  expect((await own.getAction("asana.create_a_task"))?.readOnly).toBe(false);
  expect((await own.getAction("asana.delete_task"))?.readOnly).toBe(false);
});

test("an agent sees the body's fields, and they go inside Asana's data wrapper", async () => {
  const fields = (await own.getAction("asana.create_a_task"))!.input.map((f) => f.name);
  expect(fields).toContain("name");
  expect(fields).toContain("projects");
  expect(fields).not.toContain("data");
  expect(fields).not.toContain("gid");
  const calls = stub(() => json({ data: { gid: "7" } }));
  await own.run("asana.create_a_task", { name: "Call Ravi", projects: ["42"], opt_fields: ["name", "assignee.name"] }, login, "o");
  expect(calls[0]!.url).toBe("https://app.asana.com/api/1.0/tasks?opt_fields=name%2Cassignee.name");
  expect(JSON.parse(calls[0]!.body)).toEqual({ data: { name: "Call Ravi", projects: ["42"] } });
});

test("a call with path params keeps them out of the body", async () => {
  const calls = stub(() => json({ data: {} }));
  await own.run("asana.update_a_task", { task_gid: "7", completed: true }, login, "o");
  expect(calls[0]!.url).toBe("https://app.asana.com/api/1.0/tasks/7");
  expect(JSON.parse(calls[0]!.body)).toEqual({ data: { completed: true } });
});

test("the first automation makes the project's webhook, the next reuses it, and a switched-off one is replaced", async () => {
  const none = stub(lookup([]));
  expect(await own.startPush!("asana.task_created", login, { project_gid: "42" })).toBe("asana:c1:42");
  expect(none[1]!.url).toContain("workspace=9");
  expect(none[1]!.url).toContain("resource=42");
  expect(none[2]!.method).toBe("POST");
  expect(JSON.parse(none[2]!.body)).toEqual({ data: { resource: "42", target: target() } });
  const same = stub(lookup([{ gid: "w1", target: target(), active: true }]));
  await own.startPush!("asana.task_updated", login, { project_gid: "42" });
  expect(same).toHaveLength(2);
  const off = stub(lookup([{ gid: "w1", target: target(), active: false }]));
  await own.startPush!("asana.task_updated", login, { project_gid: "42" });
  expect(off.slice(2).map((c) => c.method)).toEqual(["DELETE", "POST"]);
});

test("a project is required and must look like one", async () => {
  await expect(own.startPush!("asana.task_created", login, {})).rejects.toThrow(/project_gid/);
  await expect(own.startPush!("asana.task_created", login, { project_gid: "4/../2" })).rejects.toThrow(/project_gid/);
});

test("the last automation removes the webhook, found by its URL", async () => {
  const calls = stub(lookup([{ gid: "other", target: "https://x", active: true }, { gid: "w1", target: target(), active: true }]));
  await asana.push!.stop!("k", "asana:c1:42");
  expect(calls[2]!.method).toBe("DELETE");
  expect(calls[2]!.url).toEndWith("/webhooks/w1");
});

test("the handshake echoes X-Hook-Secret and starts nothing", async () => {
  const got = await asana.push!.receive!({ body: "", headers: { "x-hook-secret": "abc" }, connection: "c1", rest: `42/${token()}` }, "k");
  expect(got!.headers).toEqual({ "X-Hook-Secret": "abc" });
  expect(await got!.events()).toEqual([]);
});

test("a bad token in the URL is refused, handshake included", async () => {
  expect(await asana.push!.receive!(delivery({ events: [] }, "42/nope"), "k")).toBeNull();
  expect(await asana.push!.receive!(delivery({ events: [] }, `43/${token()}`), "k")).toBeNull();
  expect(await asana.push!.receive!(delivery({ events: [] }, ""), "k")).toBeNull();
  expect(await asana.push!.receive!({ body: "", headers: { "x-hook-secret": "abc" }, connection: "c1", rest: "42/nope" }, "k")).toBeNull();
});

test("each event starts only the right trigger", async () => {
  stub(() => json({ data: { gid: "x" } }));
  const cases: [object, string[]][] = [
    [task("added", { gid: "42", resource_type: "project" }), ["task_created"]],
    [task("added", { gid: "8", resource_type: "section" }), ["task_moved_to_section"]],
    [task("changed", undefined, { change: { field: "due_on" } }), ["task_updated"]],
    [story("comment_added"), ["task_comment_added"]],
    [story("attachment_added"), ["task_attachment_added"]],
    [story("added_to_tag"), ["task_tag_added"]],
  ];
  for (const [e, want] of cases) {
    const [out] = await (await asana.push!.receive!(delivery({ events: [e] }), "k"))!.events();
    expect(out!.triggers).toEqual(want);
  }
  // nothing we have a trigger for: a removal, a subtask, a story no one asked about
  for (const e of [task("removed", { gid: "42", resource_type: "project" }), task("added", { gid: "1", resource_type: "task" }), story("due_date_changed")])
    expect(await (await asana.push!.receive!(delivery({ events: [e] }), "k"))!.events()).toEqual([]);
});

test("a delivery of many events fetches each task once, and a story's comment comes with it", async () => {
  const calls = stub((c) => json({ data: { gid: c.url.split("/").pop(), text: "hello" } }));
  const got = await asana.push!.receive!(delivery({ events: [task("changed", undefined, { change: { field: "name" } }), task("changed", undefined, { change: { field: "notes" } }), story("comment_added")] }), "k");
  expect(calls).toHaveLength(0);
  const out = await got!.events();
  expect(calls.map((c) => c.url)).toEqual(["https://app.asana.com/api/1.0/tasks/7", "https://app.asana.com/api/1.0/stories/5"]);
  expect((out[0]!.data as { task: { gid: string } }).task.gid).toBe("7");
  expect((out[2]!.data as { story: { text: string } }).story.text).toBe("hello");
});

test("a task that's gone still reports, and a project and section add are two deliveries", async () => {
  stub(() => json({ errors: [{ message: "gone" }] }, 404));
  const at = { gid: "42", resource_type: "project" };
  const out = await (await asana.push!.receive!(delivery({ events: [task("added", at), task("added", { gid: "8", resource_type: "section" })] }), "k"))!.events();
  expect((out[0]!.data as { task?: unknown }).task).toBeUndefined();
  expect(new Set(out.map((e) => e.id)).size).toBe(2);
  // a retry of the same event has the same id
  const again = await (await asana.push!.receive!(delivery({ events: [task("added", at)] }), "k"))!.events();
  expect(again[0]!.id).toBe(out[0]!.id!);
});

test("filters narrow what runs", () => {
  const data = { ...task("changed", { gid: "8", resource_type: "section" }, { change: { field: "due_on" } }), task: { assignee: { gid: "u1" } } };
  expect(wanted({}, data)).toBe(true);
  expect(wanted({ project_gid: "42" }, data)).toBe(true);
  expect(wanted({ field: "due_on" }, data)).toBe(true);
  expect(wanted({ field: "name" }, data)).toBe(false);
  expect(wanted({ section_gid: "9" }, data)).toBe(false);
  expect(wanted({ assignee_gid: "u1" }, data)).toBe(true);
  expect(wanted({ assignee_gid: "u2" }, data)).toBe(false);
});

test("every trigger has Composio's name and needs a project", () => {
  expect(Object.keys(triggers).sort()).toEqual(["task_attachment_added", "task_comment_added", "task_created", "task_moved_to_section", "task_tag_added", "task_updated"]);
  for (const t of Object.values(triggers)) expect(t.config[0]).toMatchObject({ name: "project_gid", required: true });
});
