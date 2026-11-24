import { afterEach, beforeAll, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { AppFile, AppsError } from "../../types";
import { grain } from "./index";
import { triggers } from "./triggers";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});
beforeAll(() => {
  process.env.ENCRYPTION_KEY ??= "test-key";
  process.env.WEBHOOK_URL = "https://api.test";
});
const BASE = "https://api.grain.com/_/public-api/v2";
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
type Call = { url: string; method: string; body: unknown; headers: Record<string, string> };
const stub = (answer: (c: Call) => Response) => {
  const calls: Call[] = [];
  globalThis.fetch = (async (url: string, init: RequestInit = {}) => {
    const raw = init.body;
    const c = { url: String(url), method: init.method ?? "GET", body: typeof raw === "string" ? JSON.parse(raw) : raw, headers: init.headers as Record<string, string> };
    calls.push(c);
    return answer(c);
  }) as typeof fetch;
  return calls;
};
const run = (action: string, input: unknown) => {
  const a = grain.actions[action]!;
  return a.run(a.input.parse(input), "k");
};
const token = (t: string) => createHmac("sha256", process.env.ENCRYPTION_KEY!).update(`grain-webhook:c1:${t}`).digest("hex");
const target = (t: string) => `https://api.test/webhooks/app/grain/c1/${t}/${token(t)}`;
const delivery = (body: unknown, rest: string) => ({ body: JSON.stringify(body), headers: {}, connection: "c1", rest });

test("a token is checked with the API version header and labelled; a bad one is refused as dead", async () => {
  const calls = stub(() => json({ type: "personal_access_token", scope: "personal", name: "Sarah Chen" }));
  expect(await grain.check("k")).toBe("Sarah Chen");
  expect(calls[0]!.url).toBe(`${BASE}/token-info`);
  expect(calls[0]!.headers).toMatchObject({ Authorization: "Bearer k", "Public-Api-Version": "2026-10-01" });
  stub(() => json({ error: "unauthorized" }, 401));
  const e = (await grain.check("nope").catch((x) => x)) as AppsError;
  expect(e).toBeInstanceOf(AppsError);
  expect(e.expired).toBe(true);
});

test("listing recordings is a POST that reads, with filter and include in the body", async () => {
  const calls = stub(() => json({ recordings: [{ id: "r1" }], cursor: null }));
  const out = await run("list_recordings", { filter: { title_search: "Northwind", participant_scope: "external" }, include: { ai_summary: true } });
  expect(calls[0]).toMatchObject({ method: "POST", url: `${BASE}/recordings`, body: { filter: { title_search: "Northwind", participant_scope: "external" }, include: { ai_summary: true } } });
  expect(out).toEqual({ recordings: [{ id: "r1" }], cursor: null });
});

test("reads run unasked and changes ask first", () => {
  const a = grain.actions;
  for (const n of ["list_recordings", "get_recording", "get_recording_transcript", "list_playlists", "list_uploads", "get_upload", "list_hooks", "list_users", "list_teams", "list_meeting_types", "list_stories", "get_connection_info"])
    expect(a[n]!.readOnly).toBe(true);
  for (const n of ["update_recording_title", "add_recording_tag", "create_clip", "delete_playlist", "upload_recording", "create_upload", "promote_upload", "create_hook", "delete_hook", "share_recording_with_user"])
    expect(a[n]!.readOnly).toBeFalsy();
});

test("a transcript comes in the format asked for", async () => {
  const calls = stub(() => new Response("Sarah: Hello there.", { headers: { "content-type": "text/plain" } }));
  expect(await run("get_recording_transcript", { recording_id: "r1" })).toBe("Sarah: Hello there.");
  await run("get_recording_transcript", { recording_id: "r1", format: "json" });
  await run("get_recording_transcript", { recording_id: "r1", format: "srt" });
  expect(calls.map((c) => c.url)).toEqual([`${BASE}/recordings/r1/transcript.txt`, `${BASE}/recordings/r1/transcript`, `${BASE}/recordings/r1/transcript.srt`]);
});

test("a recording downloads as a file", async () => {
  stub(() => new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "video/mp4" } }));
  expect(await run("download_recording", { recording_id: "r1" })).toBeInstanceOf(AppFile);
});

test("tags: added in the body, removed by path, and a bad tag is refused before any call", async () => {
  const calls = stub(() => json({ success: true }));
  await run("add_recording_tag", { recording_id: "r1", tag: "q4-renewal" });
  await run("remove_recording_tag", { recording_id: "r1", tag: "q4-renewal" });
  expect(calls[0]).toMatchObject({ method: "PUT", url: `${BASE}/recordings/r1/tags`, body: { tag: "q4-renewal" } });
  expect(calls[1]).toMatchObject({ method: "DELETE", url: `${BASE}/recordings/r1/tags/q4-renewal` });
  expect(() => grain.actions.add_recording_tag!.input.parse({ recording_id: "r1", tag: "two words" })).toThrow();
});

test("a playlist link with no body sends none", async () => {
  const calls = stub(() => json({ success: true }));
  await run("add_recording_to_playlist", { playlist_id: "p1", recording_id: "r1" });
  expect(calls[0]).toMatchObject({ method: "PUT", url: `${BASE}/playlists/p1/recordings/r1`, body: undefined });
});

test("uploading a file makes the upload, then sends the file where Grain says", async () => {
  const calls = stub((c) =>
    c.url.endsWith("/uploads/create") ? json({ id: "u1", status: "awaiting", media: { upload: { url: "https://store.test/put", headers: { "If-None-Match": "*" } } } }) : new Response(null, { status: 200 }),
  );
  const file = new AppFile("call.mp3", "audio/mpeg", new Uint8Array([1, 2]));
  const out = (await grain.actions.upload_recording!.run({ file, attributes: { title: "Northwind kickoff" } }, "k")) as { id: string };
  expect(calls[0]).toMatchObject({ method: "POST", body: { media_type: "audio", attributes: { title: "Northwind kickoff" } } });
  expect(calls[1]).toMatchObject({ method: "PUT", url: "https://store.test/put" });
  expect(calls[1]!.headers["If-None-Match"]).toBe("*");
  expect(out.id).toBe("u1");
  await expect(grain.actions.upload_recording!.run({ file: new AppFile("a.wav", "audio/wav", new Uint8Array()) }, "k")).rejects.toThrow(/MP4 video or an MP3/);
});

test("the first automation makes the event's hook with details included, the next reuses it, a switched-off one is replaced", async () => {
  const none = stub((c) => (c.url === `${BASE}/hooks` ? json({ hooks: [] }) : json({ id: "h9" })));
  expect(await grain.push!.start("k", "c1", "recording_added", {})).toBe("grain:c1:recording_added");
  expect(none[0]).toMatchObject({ method: "POST", url: `${BASE}/hooks`, body: { filter: { hook_type: "recording_added" } } });
  expect(none[1]).toMatchObject({
    method: "POST",
    url: `${BASE}/hooks/create`,
    body: { hook_url: target("recording_added"), hook_type: "recording_added", include: { participants: true, ai_summary: true, ai_action_items: true } },
  });
  const same = stub(() => json({ hooks: [{ id: "h1", hook_url: target("recording_added"), hook_type: "recording_added", enabled: true }] }));
  await grain.push!.start("k", "c1", "recording_added", {});
  expect(same).toHaveLength(1);
  const off = stub((c) => (c.url === `${BASE}/hooks` ? json({ hooks: [{ id: "h1", hook_url: target("recording_added"), hook_type: "recording_added", enabled: false }] }) : json({})));
  await grain.push!.start("k", "c1", "recording_added", {});
  expect(off.slice(1).map((c) => `${c.method} ${c.url}`)).toEqual([`DELETE ${BASE}/hooks/h1`, `POST ${BASE}/hooks/create`]);
  // deleted events carry no details, so no include
  const gone = stub((c) => (c.url === `${BASE}/hooks` ? json({ hooks: [] }) : json({})));
  await grain.push!.start("k", "c1", "recording_deleted", {});
  expect(gone[1]!.body).toEqual({ hook_url: target("recording_deleted"), hook_type: "recording_deleted" });
});

test("the last automation removes that event's hook, found by its address", async () => {
  const calls = stub((c) => (c.method === "POST" ? json({ hooks: [{ id: "other", hook_url: "https://x" }, { id: "h1", hook_url: target("highlight_added") }] }) : json({ success: true })));
  await grain.push!.stop!("k", "grain:c1:highlight_added");
  expect(calls[1]).toMatchObject({ method: "DELETE", url: `${BASE}/hooks/h1` });
});

test("a bad token in the address is refused; Grain's reachability test starts nothing", async () => {
  expect(await grain.push!.receive!(delivery({}, "recording_added/nope"), "k")).toBeNull();
  expect(await grain.push!.receive!(delivery({}, `recording_updated/${token("recording_added")}`), "k")).toBeNull();
  expect(await grain.push!.receive!(delivery({}, ""), "k")).toBeNull();
  const test = await grain.push!.receive!(delivery({ test: true }, `recording_added/${token("recording_added")}`), "k");
  expect(await test!.events()).toEqual([]);
});

test("each event starts only its own trigger, and a retry has the same id", async () => {
  for (const t of Object.keys(triggers)) {
    const body = { type: t, user_id: "u1", data: { id: "x1" } };
    const [e] = await (await grain.push!.receive!(delivery(body, `${t}/${token(t)}`), "k"))!.events();
    expect(e!.triggers).toEqual([t]);
    const [again] = await (await grain.push!.receive!(delivery(body, `${t}/${token(t)}`), "k"))!.events();
    expect(again!.id).toBe(e!.id);
  }
  const [e] = await (await grain.push!.receive!(delivery({ type: "highlight_added", user_id: "u1", data: { id: "h1", recording_id: "r1" } }, `highlight_added/${token("highlight_added")}`), "k"))!.events();
  expect(e!.data).toEqual({ event: "highlight_added", user_id: "u1", highlight: { id: "h1", recording_id: "r1" } });
});

test("filters: title, participant, team, meeting type, recording and upload status", () => {
  const rec = { event: "recording_added", recording: { title: "Northwind QBR", participants: [{ email: "sarah@northwind.test" }], teams: [{ id: "t1" }], meeting_type: { id: "m1" } } };
  const w = grain.push!.wanted!;
  expect(w({}, rec)).toBe(true);
  expect(w({ title_contains: "qbr", participant_email: "SARAH@northwind.test", team_id: "t1", meeting_type_id: "m1" }, rec)).toBe(true);
  expect(w({ title_contains: "standup" }, rec)).toBe(false);
  expect(w({ participant_email: "tom@acme.test" }, rec)).toBe(false);
  expect(w({ team_id: "t2" }, rec)).toBe(false);
  expect(w({ meeting_type_id: "m2" }, rec)).toBe(false);
  expect(w({ recording_id: "r1" }, { event: "highlight_added", highlight: { recording_id: "r1" } })).toBe(true);
  expect(w({ recording_id: "r2" }, { event: "highlight_added", highlight: { recording_id: "r1" } })).toBe(false);
  expect(w({ status: "failure" }, { event: "upload_updated", upload: { status: "success" } })).toBe(false);
});
