import { afterEach, expect, test } from "bun:test";
import { AppsError } from "../../types";
import { circleback as polls } from "../../polls/circleback";
import { circleback } from "./index";

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

const run = (action: string, input: unknown) => {
  const a = circleback.actions[action]!;
  return a.run(a.input.parse(input), "cb_key");
};

test("a key is checked against the current account and labelled with its email; a bad one is refused as dead", async () => {
  const calls = stub(() => json({ email: "sarah@northwind.com", apiKeyName: "Emplio" }));
  expect(await circleback.check("cb_key")).toBe("sarah@northwind.com");
  expect(calls[0]!.url).toBe("https://circleback.ai/api/oauth/test");
  expect(calls[0]!.headers.Authorization).toBe("Bearer cb_key");
  stub(() => json({ error: "Invalid API key.", code: "UNAUTHORIZED" }, 401));
  const refused = await circleback.check("nope").catch((e) => e);
  expect(refused).toBeInstanceOf(AppsError);
  expect(refused.expired).toBe(true);
});

test("every operation is an action; reads run unasked and changes ask first", () => {
  expect(Object.keys(circleback.actions)).toHaveLength(29);
  for (const a of ["list_meetings", "get_meeting", "search_meetings", "get_meeting_transcript", "list_action_items", "list_calendar_events", "list_people", "get_company", "list_tags", "get_folder"])
    expect(circleback.actions[a]!.readOnly).toBe(true);
  for (const a of ["update_meeting", "share_meeting", "import_meeting", "delete_meeting", "create_action_item", "update_action_item", "delete_action_item", "create_folder", "share_folder", "delete_tag", "update_meeting_for_calendar_event"])
    expect(circleback.actions[a]!.readOnly).toBe(false);
});

test("lists repeat array filters in the query and hand back the next page's cursor from the Link header", async () => {
  const calls = stub(() => json([{ id: "m1" }], 200, { link: '</api/meetings?cursor=eyJwIjoxfQ&ownership=All>; rel="next"' }));
  const out = await run("list_meetings", { ownership: "All", tagIds: [1, 2] });
  const url = new URL(calls[0]!.url);
  expect(url.pathname).toBe("/api/meetings");
  expect(url.searchParams.getAll("tagIds")).toEqual(["1", "2"]);
  expect(url.searchParams.get("ownership")).toBe("All");
  expect(out).toEqual({ items: [{ id: "m1" }], next_cursor: "eyJwIjoxfQ" });
  stub(() => json([]));
  expect(await run("list_action_items", { cursor: "eyJwIjoxfQ" })).toEqual({ items: [], next_cursor: undefined });
});

test("a list's failure carries Circleback's words", async () => {
  stub(() => json({ error: "Ratelimit exceeded for the Free plan.", code: "RATE_LIMITED" }, 429));
  const e: any = await run("list_people", {}).catch((x: any) => x);
  expect(e.message).toBe("Circleback: Ratelimit exceeded for the Free plan. (429)");
  expect(e.expired).toBe(false);
});

test("changes send the path and JSON body Circleback expects", async () => {
  const calls = stub(() => json({ id: "m1" }));
  await run("update_meeting", { meetingId: "m1", name: "Northwind kickoff" });
  expect(calls[0]!.method).toBe("PUT");
  expect(calls[0]!.url).toBe("https://circleback.ai/api/meeting/m1");
  expect(JSON.parse(calls[0]!.body)).toMatchObject({ name: "Northwind kickoff" });
  await run("delete_action_item", { actionItemId: 252 });
  expect(`${calls[1]!.method} ${calls[1]!.url}`).toBe("DELETE https://circleback.ai/api/action-item/252");
});

test("polls: meetings only once their notes are ready, done action items, meetings about to start", async () => {
  const soon = new Date(Date.now() + 20 * 60_000).toISOString();
  const later = new Date(Date.now() + 3 * 3_600_000).toISOString();
  const seen: [string, any][] = [];
  const fake = async (action: string, input: any) => {
    seen.push([action, input]);
    if (action === "circleback.list_meetings") return { items: [{ id: "m1", notes: "#### Overview" }, { id: "m2", notes: "" }] };
    if (action === "circleback.list_action_items") return { items: [{ id: 7, status: "DONE", completedAt: new Date().toISOString() }, { id: 8, completedAt: "2020-01-01T00:00:00Z" }] };
    return { items: [{ id: "e1", startTime: soon }, { id: "e2", startTime: later }] };
  };
  expect((await polls.new_meeting!.poll({ tag_id: 3 }, fake)).map((i) => i.id)).toEqual(["m1"]);
  expect(seen[0]![1]).toMatchObject({ tagIds: [3] });
  expect((await polls.action_item_completed!.poll({ assignee: "Anyone" }, fake)).map((i) => i.id)).toEqual(["7:done"]);
  expect(seen[1]![1]).toEqual({ status: "DONE", assigneeType: "Anyone" });
  expect((await polls.meeting_starting_soon!.poll({}, fake)).map((i) => i.id)).toEqual([`e1:${soon}`]);
});
