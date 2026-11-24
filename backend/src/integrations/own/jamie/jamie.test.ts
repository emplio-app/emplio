import { afterEach, expect, test } from "bun:test";
import { AppsError } from "../../types";
import { jamie as polls } from "../../polls/jamie";
import { jamie } from "./index";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
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

const ok = (data: unknown) => json({ result: { data: { json: data } } });
const run = (action: string, input: unknown, key = "jk_personal") => {
  const a = jamie.actions[action]!;
  return a.run(a.input.parse(input), key);
};
const sent = (c: Call) => JSON.parse(new URL(c.url).searchParams.get("input") ?? "null");

test("a personal key is checked on the personal routes, with the key in x-api-key and the input as ?input={json}", async () => {
  const calls = stub(() => ok({ meetings: [], nextCursor: null }));
  expect(await jamie.check("jk_personal")).toBe("Jamie");
  expect(calls[0]!.url).toStartWith("https://beta-api.meetjamie.ai/v1/me/meetings.list?");
  expect(sent(calls[0]!)).toEqual({ json: { limit: 1 } });
  expect(calls[0]!.headers["x-api-key"]).toBe("jk_personal");
});

test("a workspace key is found by the personal routes refusing it, then goes straight to the workspace routes", async () => {
  const calls = stub((c) => (c.url.includes("/v1/me/") ? json({ error: "This endpoint requires a workspace-scoped API key." }, 403) : ok({ meetings: [] })));
  expect(await jamie.check("jk_workspace")).toBe("Jamie workspace");
  expect(calls.map((c) => new URL(c.url).pathname)).toEqual(["/v1/me/meetings.list", "/v1/workspace/meetings.list"]);
  await run("list_tasks", { completed: false, userEmail: "sarah@northwind.com" }, "jk_workspace");
  expect(new URL(calls[2]!.url).pathname).toBe("/v1/workspace/tasks.list");
  expect(sent(calls[2]!)).toEqual({ json: { completed: false, userEmail: "sarah@northwind.com" } });
});

test("a bad key is refused as dead; other errors carry Jamie's words", async () => {
  stub(() => json({ error: "Missing API key. Use header: x-api-key: <your_api_key>" }, 401));
  const dead = await jamie.check("nope").catch((e) => e);
  expect(dead).toBeInstanceOf(AppsError);
  expect(dead.expired).toBe(true);
  stub(() => json({ error: "Meeting not found" }, 404));
  const e: any = await run("get_meeting", { meetingId: "m9" }).catch((x: any) => x);
  expect(e.message).toBe("Jamie: Meeting not found (404)");
  expect(e.expired).toBe(false);
});

test("changes are POSTs with a {json} body, and the answer comes out of Jamie's envelope", async () => {
  const calls = stub(() => ok({ success: true, deletedMeetingId: "m1" }));
  expect(await run("delete_meeting", { meetingId: "m1" })).toEqual({ success: true, deletedMeetingId: "m1" });
  expect(calls[0]!.method).toBe("POST");
  expect(calls[0]!.url).toBe("https://beta-api.meetjamie.ai/v1/me/meetings.delete");
  expect(JSON.parse(calls[0]!.body)).toEqual({ json: { meetingId: "m1" } });
  await run("update_task", { taskId: "t1", completed: true });
  expect(JSON.parse(calls[1]!.body)).toEqual({ json: { taskId: "t1", completed: true } });
});

test("reads run unasked and changes ask first", () => {
  expect(Object.keys(jamie.actions).sort()).toEqual(["delete_meeting", "get_meeting", "list_meetings", "list_tags", "list_tasks", "search_meetings", "update_task"]);
  for (const a of ["list_meetings", "get_meeting", "search_meetings", "list_tasks", "list_tags"]) expect(jamie.actions[a]!.readOnly).toBe(true);
  for (const a of ["delete_meeting", "update_task"]) expect(jamie.actions[a]!.readOnly).toBe(false);
});

test("polls: only ended, summarised meetings; tasks filtered by assignee; done tasks under their own id", async () => {
  const asked: string[] = [];
  const fake = async (action: string, input: any) => {
    asked.push(action === "jamie.get_meeting" ? `get ${input.meetingId}` : action);
    if (action === "jamie.list_meetings") return { meetings: [{ id: "m1", endTime: "x" }, { id: "m2", endTime: "x" }, { id: "m3", endTime: null }] };
    if (action === "jamie.get_meeting") return { id: input.meetingId, summary: input.meetingId === "m1" ? { markdown: "# Summary" } : null };
    return { tasks: [{ id: "t1", assignee: { email: "Sarah@Northwind.com" } }, { id: "t2", assignee: null }] };
  };
  expect((await polls.meeting_completed!.poll({}, fake)).map((i) => i.id)).toEqual(["m1"]);
  expect(asked).toEqual(["jamie.list_meetings", "get m1", "get m2"]);
  expect((await polls.new_task!.poll({ assignee_email: "sarah@northwind.com" }, fake)).map((i) => i.id)).toEqual(["t1"]);
  expect((await polls.task_completed!.poll({}, fake)).map((i) => i.id)).toEqual(["t1:done", "t2:done"]);
});
