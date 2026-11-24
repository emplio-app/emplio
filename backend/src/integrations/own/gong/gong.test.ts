import { afterEach, expect, test } from "bun:test";
import { gong as polls } from "../../polls/gong";
import { AppFile, AppsError } from "../../types";
import { gong, parseKey } from "./index";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
type Call = { url: string; method: string; body: unknown; headers: Record<string, string> };
const stub = (answer: (c: Call) => Response) => {
  const calls: Call[] = [];
  globalThis.fetch = (async (url: string, init: RequestInit = {}) => {
    const c = { url: String(url), method: init.method ?? "GET", body: init.body, headers: (init.headers ?? {}) as Record<string, string> };
    calls.push(c);
    return answer(c);
  }) as typeof fetch;
  return calls;
};
const KEY = "ACCESS:SECRET";
const run = (name: string, input: Record<string, unknown>, key = KEY) => gong.actions[name]!.run(gong.actions[name]!.input.parse(input), key);

test("the key may carry the company's own base URL", () => {
  expect(parseKey("A:B")).toEqual({ base: "https://api.gong.io", access: "A", secret: "B" });
  expect(parseKey(" https://us-123.api.gong.io/  A:B:C ")).toEqual({ base: "https://us-123.api.gong.io", access: "A", secret: "B:C" });
});

test("a key is checked with basic auth and labelled with the workspace; a wrong one is refused as dead", async () => {
  const calls = stub(() => json({ workspaces: [{ id: "1", name: "Northwind Sales" }] }));
  expect(await gong.check("https://us-123.api.gong.io ACCESS:SECRET")).toBe("Northwind Sales");
  expect(calls[0]!.url).toBe("https://us-123.api.gong.io/v2/workspaces");
  expect(calls[0]!.headers.Authorization).toBe(`Basic ${Buffer.from("ACCESS:SECRET").toString("base64")}`);
  stub(() => json({ requestId: "r", errors: ["Unauthorized"] }, 401));
  const refused = await gong.check(KEY).catch((e) => e);
  expect(refused).toBeInstanceOf(AppsError);
  expect(refused.expired).toBe(true);
  expect(await gong.check("nocolon").catch((e) => e.message)).toContain("joined by a colon");
});

test("the key never goes to a host that isn't Gong's", async () => {
  const calls = stub(() => json({}));
  expect(await gong.check("https://evil.example ACCESS:SECRET").catch((e) => e.message)).toContain("base URL");
  expect(await run("list_users", {}, "https://gong.io.evil.example A:B").catch((e) => e.message)).toContain("base URL");
  expect(calls).toHaveLength(0);
});

test("lookups that are POSTs send the filter as the body and run unasked; writes ask", async () => {
  const calls = stub(() => json({ callTranscripts: [] }));
  await run("get_call_transcripts", { filter: { callIds: ["7"] } });
  expect(calls[0]).toMatchObject({ method: "POST", url: "https://api.gong.io/v2/calls/transcript" });
  expect(JSON.parse(String(calls[0]!.body))).toEqual({ filter: { callIds: ["7"] } });
  for (const a of ["list_calls", "get_call", "list_calls_extensive", "get_call_transcripts", "list_users", "list_users_by_filter", "list_tasks", "list_answered_scorecards", "get_interaction_stats", "list_library_folders", "ask_about_entity"])
    expect(gong.actions[a]!.readOnly).toBe(true);
  for (const a of ["add_call", "add_call_media", "update_meeting", "delete_meeting", "upload_crm_objects", "erase_data_for_email_address", "assign_prospects_to_flow", "update_task", "give_users_call_access", "update_permission_profile"])
    expect(gong.actions[a]!.readOnly).toBe(false);
  expect(gong.actions.assign_prospects_cool_off_overrides).toBeUndefined();
});

test("a recording goes up as a file", async () => {
  const calls = stub(() => json({ callId: "7", url: "https://app.gong.io/call?id=7" }));
  await run("add_call_media", { id: "7", mediaFile: new AppFile("call.mp3", "audio/mpeg", new Uint8Array([1])) });
  expect(calls[0]).toMatchObject({ method: "PUT", url: "https://api.gong.io/v2/calls/7/media" });
  expect((calls[0]!.body as FormData).get("mediaFile")).toBeInstanceOf(Blob);
});

test("new_call reads the last day's calls, filtered by host, and Gong's 404 for none is no calls", async () => {
  let input: any;
  const items = await polls.new_call!.poll({ user_id: "u1" }, async (_a, i) => {
    input = i;
    return { calls: [{ id: "7", primaryUserId: "u1" }, { id: "8", primaryUserId: "u2" }] };
  });
  expect(items.map((x) => x.id)).toEqual(["7"]);
  expect(Date.now() - Date.parse(input.fromDateTime)).toBeGreaterThan(86_000_000);
  const none = await polls.new_call!.poll({}, async () => {
    throw new AppsError('Gong: {"errors":["No calls found corresponding to the provided filters"]} (404)');
  });
  expect(none).toEqual([]);
  await expect(polls.new_call!.poll({}, async () => {
    throw new AppsError("Gong: Too many requests (429)");
  })).rejects.toThrow("429");
});

test("new_answered_scorecard and new_task send Gong's filters", async () => {
  const asked: [string, any][] = [];
  const run = async (a: string, i: unknown) => {
    asked.push([a, i]);
    return a.endsWith("scorecards") ? { answeredScorecards: [{ answeredScorecardId: "s1" }] } : { tasks: [{ id: "t1", created: new Date().toISOString() }, { id: "t0", created: "2020-01-01T00:00:00Z" }] };
  };
  expect((await polls.new_answered_scorecard!.poll({ scorecard_id: "9" }, run)).map((x) => x.id)).toEqual(["s1"]);
  expect(asked[0]![1].filter).toMatchObject({ scorecardIds: ["9"], reviewFromDate: expect.stringMatching(/^\d{4}-\d\d-\d\d$/) });
  expect((await polls.new_task!.poll({ user_id: "u1" }, run)).map((x) => x.id)).toEqual(["t1"]);
  expect(asked[1]).toEqual(["gong.list_tasks", { filter: { userId: "u1", status: ["OPEN"], types: ["FLOW", "MANUAL"], taskAction: ["CALL"] } }]);
});
