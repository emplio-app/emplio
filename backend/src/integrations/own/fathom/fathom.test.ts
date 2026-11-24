import { afterEach, beforeAll, expect, test } from "bun:test";
import { AppsError } from "../../types";
import { fathom } from "./index";
import { store, token, triggers, wanted } from "./triggers";

const realFetch = globalThis.fetch;
const realExisting = store.existing;
afterEach(() => {
  globalThis.fetch = realFetch;
  store.existing = realExisting;
});
beforeAll(() => {
  process.env.ENCRYPTION_KEY ??= "test-key";
  process.env.WEBHOOK_URL = "https://api.test";
});

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
type Call = { url: string; method: string; body: any; headers: Record<string, string> };
const stub = (answer: (c: Call) => Response) => {
  const calls: Call[] = [];
  globalThis.fetch = (async (url: string, init: RequestInit = {}) => {
    const c = { url: String(url), method: init.method ?? "GET", body: init.body ? JSON.parse(String(init.body)) : undefined, headers: init.headers as Record<string, string> };
    calls.push(c);
    return answer(c);
  }) as typeof fetch;
  return calls;
};
const run = (name: string, input: unknown) => {
  const a = fathom.actions[name]!;
  return a.run(a.input.parse(input), "fk");
};
const push = fathom.push!;
const target = () => `https://api.test/webhooks/app/fathom/c1/${token("c1")}`;
const meeting = {
  title: "Intro call",
  recording_id: 42,
  meeting_type: "Discovery",
  recorded_by: { name: "Sarah", email: "sarah@northwind.com", team: "Sales" },
  calendar_invitees_domains_type: "one_or_more_external",
  calendar_invitees: [{ name: "Tom", email: "tom@contoso.com", is_external: true }],
};
const delivery = (rest: string, headers: Record<string, string> = { "webhook-id": "msg_1" }) => ({ body: JSON.stringify(meeting), headers, connection: "c1", rest });

test("a key is checked by listing meetings with X-Api-Key, and a refused one asks to reconnect", async () => {
  const calls = stub(() => json({ items: [], next_cursor: null }));
  await fathom.check("fk");
  expect(calls[0]!.url).toBe("https://api.fathom.ai/external/v1/meetings");
  expect(calls[0]!.headers["X-Api-Key"]).toBe("fk");
  stub(() => json({ message: "Unauthorized" }, 401));
  const e = await fathom.check("bad").catch((x) => x);
  expect(e).toBeInstanceOf(AppsError);
  expect(e.expired).toBe(true);
});

test("every operation is an action; reads run unasked, webhooks ask", () => {
  expect(Object.keys(fathom.actions).sort()).toEqual(
    ["create_webhook", "delete_webhook", "download_recording", "get_recording_download", "get_recording_summary", "get_recording_transcript", "list_meeting_types", "list_meetings", "list_team_members", "list_teams", "list_users"].sort(),
  );
  for (const a of ["list_meetings", "get_recording_summary", "get_recording_transcript", "download_recording", "get_recording_download", "list_users"]) expect(fathom.actions[a]!.readOnly).toBe(true);
  for (const a of ["create_webhook", "delete_webhook"]) expect(fathom.actions[a]!.readOnly).toBe(false);
});

test("list filters repeat their key, and a recording's summary is fetched by its id", async () => {
  const calls = stub(() => json({ items: [] }));
  await run("list_meetings", { "recorded_by[]": ["a@x.com", "b@x.com"], include_summary: true });
  const u = new URL(calls[0]!.url);
  expect(u.pathname).toBe("/external/v1/meetings");
  expect(u.searchParams.getAll("recorded_by[]")).toEqual(["a@x.com", "b@x.com"]);
  expect(u.searchParams.get("include_summary")).toBe("true");
  await run("get_recording_summary", { recording_id: 42 });
  expect(calls[1]!.url).toBe("https://api.fathom.ai/external/v1/recordings/42/summary");
});

test("the first automation makes one webhook with everything but the transcript, at an address carrying our token", async () => {
  store.existing = async () => undefined;
  const calls = stub(() => json({ id: "wh1", secret: "whsec_x" }, 201));
  expect(await push.start("fk", "c1", "newMeeting", {})).toBe("fathom:c1:wh1");
  expect(`${calls[0]!.method} ${calls[0]!.url}`).toBe("POST https://api.fathom.ai/external/v1/webhooks");
  expect(calls[0]!.body).toEqual({
    destination_url: target(),
    triggered_for: ["my_recordings", "shared_external_recordings", "my_shared_with_team_recordings", "shared_team_recordings"],
    include_summary: true,
    include_action_items: true,
    include_crm_matches: true,
    include_transcript: false,
  });
});

test("without a Team Plan it falls back to the person's own and shared-with-them recordings; a dead key doesn't retry", async () => {
  store.existing = async () => undefined;
  const calls = stub((c) => (c.body.triggered_for.length === 4 ? json({ message: "Team Plans only" }, 400) : json({ id: "wh2" }, 201)));
  expect(await push.start("fk", "c1", "newMeeting", {})).toBe("fathom:c1:wh2");
  expect(calls[1]!.body.triggered_for).toEqual(["my_recordings", "shared_external_recordings"]);
  const dead = stub(() => json({ message: "Unauthorized" }, 401));
  await expect(push.start("fk", "c1", "newMeeting", {})).rejects.toBeInstanceOf(AppsError);
  expect(dead).toHaveLength(1);
});

test("the next automation on the connection shares the webhook, with no call", async () => {
  store.existing = async (c) => (c === "c1" ? "fathom:c1:wh1" : undefined);
  const calls = stub(() => json({}));
  expect(await push.start("fk", "c1", "newMeeting", {})).toBe("fathom:c1:wh1");
  expect(calls).toHaveLength(0);
});

test("the last automation deletes its webhook, and one already gone is fine", async () => {
  const calls = stub(() => new Response(null, { status: 204 }));
  await push.stop!("fk", "fathom:c1:wh1");
  expect(`${calls[0]!.method} ${calls[0]!.url}`).toBe("DELETE https://api.fathom.ai/external/v1/webhooks/wh1");
  stub(() => json({ message: "Not found" }, 404));
  await push.stop!("fk", "fathom:c1:wh1");
  stub(() => json({ message: "boom" }, 500));
  await expect(push.stop!("fk", "fathom:c1:wh1")).rejects.toBeInstanceOf(AppsError);
});

test("a delivery without our token is refused", async () => {
  expect(await push.receive!(delivery(""), "fk")).toBeNull();
  expect(await push.receive!(delivery(token("other")), "fk")).toBeNull();
  expect(await push.receive!(delivery(`${token("c1")}x`), "fk")).toBeNull();
});

test("a finished meeting starts the trigger once per Fathom message, under the connection's webhook", async () => {
  store.existing = async () => "fathom:c1:wh1";
  const got = await push.receive!(delivery(token("c1")), "fk");
  const [event] = await got!.events();
  expect(event).toEqual({ id: "c1:msg_1", triggers: ["meeting_content_ready"], data: meeting, watch: "fathom:c1:wh1" });
  store.existing = async () => undefined;
  const [bare] = await (await push.receive!(delivery(token("c1"), {}), "fk"))!.events();
  expect(bare!.id).toBe("c1:42");
  expect(bare!.watch).toBeUndefined();
});

test("settings narrow which meetings run it", () => {
  expect(wanted({}, meeting)).toBe(true);
  expect(wanted({ recorded_by: "SARAH@northwind.com", team: "sales", meeting_type: "discovery", external_only: true, invitee: "contoso.com" }, meeting)).toBe(true);
  expect(wanted({ invitee: "tom@contoso.com" }, meeting)).toBe(true);
  expect(wanted({ recorded_by: "tom@x.com" }, meeting)).toBe(false);
  expect(wanted({ team: "Marketing" }, meeting)).toBe(false);
  expect(wanted({ meeting_type: "QBR" }, meeting)).toBe(false);
  expect(wanted({ external_only: true }, { ...meeting, calendar_invitees_domains_type: "only_internal" })).toBe(false);
  expect(wanted({ invitee: "fabrikam.com" }, meeting)).toBe(false);
});

test("the trigger keeps Composio's name and describes its settings", () => {
  expect(Object.keys(triggers)).toEqual(["meeting_content_ready"]);
  expect(triggers.meeting_content_ready!.config.map((f) => f.name)).toEqual(["recorded_by", "team", "meeting_type", "external_only", "invitee"]);
});
