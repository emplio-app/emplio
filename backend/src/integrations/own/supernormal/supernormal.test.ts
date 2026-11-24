import { afterEach, expect, test } from "bun:test";
import { AppsError } from "../../types";
import { supernormal as polls } from "../../polls/supernormal";
import { supernormal } from "./index";

type Call = { url: string; method: string; headers: Record<string, string> };
const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function stub(body: unknown, status = 200) {
  const calls: Call[] = [];
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    calls.push({ url: String(url), method: init.method ?? "GET", headers: init.headers as Record<string, string> });
    return new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return calls;
}
const run = (action: string, input: unknown) => {
  const a = supernormal.actions[action]!;
  return a.run(a.input.parse(input), "key");
};

test("a working key is accepted and names the connection, sent as X-API-TOKEN", async () => {
  const calls = stub({ id: "u1", first_name: "Sarah", last_name: "Lee", email: "sarah@northwind.com" });
  expect(await supernormal.check("key")).toBe("Sarah Lee");
  expect(calls[0]!.url).toBe("https://api.supernormal.com/api/v1/user");
  expect(calls[0]!.headers["X-API-TOKEN"]).toBe("key");
});

test("a refused key asks for reconnecting", async () => {
  stub({ error: 401, message: "Unauthorized" }, 401);
  const e = (await supernormal.check("bad").catch((x) => x)) as AppsError;
  expect(e).toBeInstanceOf(AppsError);
  expect(e.expired).toBe(true);
});

test("ids go in the path, filters in the query", async () => {
  const calls = stub({ recordings: [], meta: { next_page: null } });
  await run("list_recordings", { visibility: "organization", page: 2 });
  await run("get_transcript", { id: "r 1" });
  expect(calls[0]!.url).toBe("https://api.supernormal.com/api/v1/recordings?visibility=organization&page=2");
  expect(calls[1]!.url).toBe("https://api.supernormal.com/api/v1/recordings/r%201/transcript");
});

test("turning recording on posts record in the query and asks first; reads don't", async () => {
  const calls = stub(undefined);
  await run("set_meeting_capture", { id: "ev1", record: false });
  expect(calls[0]!.method).toBe("POST");
  expect(calls[0]!.url).toBe("https://api.supernormal.com/api/v1/calendar_events/ev1/record?record=false");
  const a = supernormal.actions;
  expect(a.set_meeting_capture!.readOnly).toBeFalsy();
  expect(["get_user", "list_recordings", "get_recording", "get_transcript", "list_upcoming_meetings"].every((n) => a[n]!.readOnly)).toBe(true);
});

test("new_recording reports only finished, recent recordings", async () => {
  const now = new Date().toISOString();
  const items = await polls.new_recording!.poll({}, async (action) => {
    expect(action).toBe("supernormal.list_recordings");
    return { recordings: [{ id: "a", completed_at: now }, { id: "b", completed_at: null }, { id: "c", completed_at: "2020-01-01T00:00:00Z" }] };
  });
  expect(items.map((i) => i.id)).toEqual(["a"]);
});

test("meeting_starting_soon keeps meetings inside the window, and the start in the id", async () => {
  const at = (min: number) => new Date(Date.now() + min * 60_000).toISOString();
  const meetings = [
    { id: "m1", start: at(30), scheduled_to_record: true },
    { id: "m2", start: at(90), scheduled_to_record: true },
    { id: "m3", start: at(10), scheduled_to_record: false },
  ];
  const all = await polls.meeting_starting_soon!.poll({}, async () => meetings);
  expect(all.map((i) => i.id)).toEqual([`m1:${meetings[0]!.start}`, `m3:${meetings[2]!.start}`]);
  const recorded = await polls.meeting_starting_soon!.poll({ only_recorded: true }, async () => meetings);
  expect(recorded.map((i) => (i.item as any).meeting.id)).toEqual(["m1"]);
});
