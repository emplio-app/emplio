import { afterEach, expect, test } from "bun:test";
import { leexi as polls } from "../../polls/leexi";
import { AppFile, AppsError } from "../../types";
import { leexi } from "./index";

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
const KEY = "kid:secret";
const run = (name: string, input: Record<string, unknown>) => leexi.actions[name]!.run(leexi.actions[name]!.input.parse(input), KEY);

test("a key is checked with basic auth (key ID and secret), and a wrong one is refused as dead", async () => {
  const calls = stub(() => json({ success: true, data: [] }));
  expect(await leexi.check(KEY)).toBe("Leexi");
  expect(calls[0]!.url).toBe("https://public-api.leexi.ai/v1/calls?items=1");
  expect(calls[0]!.headers.Authorization).toBe(`Basic ${Buffer.from(KEY).toString("base64")}`);
  stub(() => json({ success: false, message: "Unauthorized" }, 401));
  const refused = await leexi.check("kid:wrong").catch((e) => e);
  expect(refused).toBeInstanceOf(AppsError);
  expect(refused.expired).toBe(true);
  expect(await leexi.check("no-colon").catch((e) => e.message)).toContain("joined by a colon");
});

test("a missing scope says so in Leexi's words", async () => {
  stub(() => json({ success: false, message: "The API key has no write_calls access" }, 403));
  expect(await run("delete_call_note", { uuid: "n1" }).catch((e) => e.message)).toBe("Leexi: The API key has no write_calls access (403)");
});

test("lists in the query go as name[]=, the way Leexi reads them", async () => {
  const calls = stub(() => json({ success: true, data: [] }));
  await run("list_calls", { owner_uuid: ["u1", "u2"], items: 5 });
  const url = new URL(calls[0]!.url);
  expect(url.pathname).toBe("/v1/calls");
  expect(url.searchParams.getAll("owner_uuid[]")).toEqual(["u1", "u2"]);
  expect(url.searchParams.get("owner_uuid")).toBeNull();
  expect(url.searchParams.get("items")).toBe("5");
});

test("paths and bodies go where Leexi expects", async () => {
  const calls = stub(() => json({ success: true, data: {} }));
  await run("get_call", { uuid: "c1" });
  await run("launch_meeting_assistant", { uuid: "m1" });
  expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual(["GET https://public-api.leexi.ai/v1/calls/c1", "POST https://public-api.leexi.ai/v1/meeting_events/m1/launch_bot"]);
});

test("reads run unasked, writes ask", () => {
  for (const a of ["list_calls", "get_call", "list_call_notes", "list_meeting_events", "list_users", "list_teams", "request_presigned_url"]) expect(leexi.actions[a]!.readOnly).toBe(true);
  for (const a of ["create_call", "update_call_note", "delete_call_note", "create_meeting_event", "launch_meeting_assistant", "create_user", "deactivate_user", "delete_team", "start_client_subscription", "upload_recording"])
    expect(leexi.actions[a]!.readOnly).toBe(false);
});

test("a recording is uploaded in Leexi's two steps and answers the key create_call needs", async () => {
  const calls = stub((c) =>
    c.url.includes("presign") ? json({ success: true, data: { url: "https://s3.test/up?sig=1", recording_s3_key: "acme/rec.mp3", headers: { "x-amz-tagging": "temporary=true" } } }) : new Response("", { status: 200 }),
  );
  const out = await leexi.actions.upload_recording!.run({ file: new AppFile("call.MP3", "audio/mpeg", new Uint8Array([1, 2])) }, KEY);
  expect(out).toEqual({ recording_s3_key: "acme/rec.mp3" });
  expect(JSON.parse(String(calls[0]!.body))).toEqual({ extension: ".mp3" });
  expect(calls[1]).toMatchObject({ url: "https://s3.test/up?sig=1", method: "PUT", headers: { "x-amz-tagging": "temporary=true" } });
  expect(await leexi.actions.upload_recording!.run({ file: "nope" }, KEY).catch((e) => e.message)).toContain('{"file"');
});

const now = new Date().toISOString();
test("new_call fires only for recent calls whose AI notes are ready, filtered by owner", async () => {
  const seen: [string, unknown][] = [];
  const items = await polls.new_call!.poll({ owner_uuid: "u1" }, async (a, i) => {
    seen.push([a, i]);
    return {
      data: [
        { uuid: "ready", updated_at: now, prompts: [{ completions: ["Agreed on price"] }] },
        { uuid: "processing", updated_at: now, prompts: [], chapters: [] },
        { uuid: "old", updated_at: "2020-01-01T00:00:00Z", chapters: [{ title: "Intro" }] },
      ],
    };
  });
  expect(items.map((x) => x.id)).toEqual(["ready"]);
  expect(seen[0]).toEqual(["leexi.list_calls", { order: "updated_at desc", items: 100, owner_uuid: ["u1"] }]);
});

test("meeting_starting_soon asks for meetings in the window, and a moved meeting is news again", async () => {
  let input: any;
  const items = await polls.meeting_starting_soon!.poll({ minutes: 30 }, async (_a, i) => {
    input = i;
    return { data: [{ uuid: "m1", start_time: "2026-11-24T10:00:00Z" }] };
  });
  expect(input.date_filter).toBe("start_time");
  expect(Date.parse(input.to) - Date.parse(input.from)).toBe(30 * 60_000);
  expect(items[0]!.id).toBe("m1:2026-11-24T10:00:00Z");
});
