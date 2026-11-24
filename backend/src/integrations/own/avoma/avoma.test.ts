import { afterEach, beforeAll, expect, test } from "bun:test";
import { createHmac, randomBytes } from "node:crypto";
import { AppsError } from "../../types";
import type { Delivery } from "../index";
import { avoma } from "./index";
import { ourSecret } from "./triggers";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});
beforeAll(() => {
  process.env.ENCRYPTION_KEY ??= randomBytes(32).toString("base64");
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
const KEY = "ck:cs";
const run = (name: string, input: unknown) => {
  const a = avoma.actions[name]!;
  return a.run(a.input.parse(input), KEY, "c1");
};
const push = avoma.push!;
const url = (event: string) => `https://api.test/webhooks/app/avoma/c1/${event}`;

test("a key is checked with Bearer on /v1/users/; a refused one asks for reconnecting", async () => {
  const calls = stub(() => json([]));
  await avoma.check(KEY);
  expect(calls[0]!.url).toBe("https://api.avoma.com/v1/users/");
  expect(calls[0]!.headers.Authorization).toBe("Bearer ck:cs");
  stub(() => json({ detail: "Invalid token." }, 401));
  const e = (await avoma.check("nope").catch((x) => x)) as AppsError;
  expect(e).toBeInstanceOf(AppsError);
  expect(e.expired).toBe(true);
});

test("calls follow the spec, Avoma's errors come through, and next pages stay on Avoma", async () => {
  const calls = stub(() => json({ results: [], next: null }));
  await run("list_meetings", { from_date: "2026-11-01T00:00:00Z", to_date: "2026-11-07T00:00:00Z", page_size: 10 });
  expect(calls[0]!.url).toBe("https://api.avoma.com/v1/meetings/?page_size=10&from_date=2026-11-01T00%3A00%3A00Z&to_date=2026-11-07T00%3A00%3A00Z&include_crm_associations=false&o=-start_at");
  await run("next_page", { next: "https://api.avoma.com/v1/meetings/?page=2&page_size=10" });
  expect(calls[1]!.url).toBe("https://api.avoma.com/v1/meetings/?page=2&page_size=10");
  await expect(run("next_page", { next: "https://evil.test/v1/meetings/" })).rejects.toThrow(/api.avoma.com/);
  await run("create_meeting_type", { label: "Discovery", description: "First call" });
  expect(calls[2]!.method).toBe("POST");
  expect(calls[2]!.body).toEqual({ label: "Discovery", description: "First call" });
  stub(() => json({ detail: "Not found." }, 404));
  await expect(run("get_meeting", { uuid: "m1" })).rejects.toThrow("Avoma: Not found. (404)");
});

test("reads run unasked; changes, and reading the signing secret, ask first", () => {
  const a = avoma.actions;
  for (const n of ["list_meetings", "get_meeting", "list_notes", "get_transcription", "list_users", "next_page", "list_webhooks"]) expect(a[n]!.readOnly).toBe(true);
  for (const n of ["create_call", "drop_meeting", "delete_meeting_type", "create_webhook", "get_webhook_signing_secret", "set_webhook_signing_secret"]) expect(a[n]!.readOnly).toBeFalsy();
});

test("an automation sets our signing secret if the organization has none, then subscribes its event once; the last removes it", async () => {
  const first = stub((c) => (c.url.endsWith("/signing-secret/") && c.method === "GET" ? json({ signing_secret: "" }) : c.method === "GET" ? json({ count: 0, results: [] }) : json({}, 201)));
  expect(await push.start(KEY, "c1", "AINOTE", {})).toBe("avoma:c1:AINOTE");
  expect(first.map((c) => `${c.method} ${c.url}`)).toEqual([
    "GET https://api.avoma.com/v1/webhooks/signing-secret/",
    "PATCH https://api.avoma.com/v1/webhooks/signing-secret/",
    "GET https://api.avoma.com/v1/webhooks/",
    "POST https://api.avoma.com/v1/webhooks/",
  ]);
  expect(first[1]!.body).toEqual({ signing_secret: ourSecret("c1") });
  expect(first[3]!.body).toEqual({ event_type: "AINOTE", target_type: 2, target_url: url("AINOTE") });

  const sub = { uuid: "s1", event_type: "AINOTE", target_url: url("AINOTE"), is_active: true };
  const again = stub((c) => (c.url.endsWith("/signing-secret/") ? json({ signing_secret: "theirs" }) : json({ count: 1, results: [sub] })));
  await push.start(KEY, "c1", "AINOTE", {});
  expect(again.map((c) => c.method)).toEqual(["GET", "GET"]);

  const gone = stub((c) => (c.method === "GET" ? json({ count: 1, results: [sub] }) : new Response(null, { status: 204 })));
  await push.stop!(KEY, "avoma:c1:AINOTE");
  expect(gone.map((c) => `${c.method} ${c.url}`)).toEqual(["GET https://api.avoma.com/v1/webhooks/", "DELETE https://api.avoma.com/v1/webhooks/s1/"]);

  stub(() => json({ detail: "Webhooks feature not enabled" }, 400));
  await expect(push.start(KEY, "c1", "AINOTE", {})).rejects.toThrow(/plan with webhooks/);
});

const deliver = (event: string, body: unknown, secret: string): Delivery => {
  const raw = JSON.stringify(body);
  return { body: raw, headers: { "x-avoma-signature": createHmac("sha256", secret).update(raw).digest("hex") }, connection: "c1", rest: event };
};
const note = { event_type: "AINOTE", uuid: "m1", subject: "Northwind renewal", organizer_email: "Sarah@northwind.com", ai_notes: "<h2>x</h2>", ai_notes_txt: "Renewal agreed" };

test("signatures: ours accepted without a call, the organization's own read through the key, anything else refused", async () => {
  const none = stub(() => json({ signing_secret: "" }));
  expect(await push.receive!(deliver("AINOTE", note, ourSecret("c1")), KEY)).not.toBeNull();
  expect(none).toHaveLength(0);
  stub(() => json({ signing_secret: "theirs" }));
  expect(await push.receive!(deliver("AINOTE", note, "theirs"), KEY)).not.toBeNull();
  expect(await push.receive!(deliver("AINOTE", note, "wrong"), KEY)).toBeNull();
  expect(await push.receive!({ ...deliver("AINOTE", note, "theirs"), headers: {} }, KEY)).toBeNull();
  // no secret at all on Avoma's side: nothing can be checked, so nothing passes
  stub(() => json({ signing_secret: "" }));
  expect(await push.receive!(deliver("AINOTE", note, ""), KEY)).toBeNull();
});

test("each event starts only its trigger, without the HTML copy; a retry has the same id; the organizer filter applies", async () => {
  const fire = async (event: string, body: unknown) => (await (await push.receive!(deliver(event, body, ourSecret("c1")), KEY))!.events())[0];
  const ready = await fire("AINOTE", note);
  expect(ready!.triggers).toEqual(["notes_ready"]);
  expect(ready!.data).toEqual({ event_type: "AINOTE", uuid: "m1", subject: "Northwind renewal", organizer_email: "Sarah@northwind.com", ai_notes_txt: "Renewal agreed" });
  expect((await fire("AINOTE", note))!.id).toBe(ready!.id);
  const booking = { meeting_uuid: "m2", subject: "Intro", invitee_details: { name: "Sarah" } };
  expect((await fire("MEETING_BOOKED_VIA_SCHEDULER", { ...booking, event_type: "MEETING_BOOKED_VIA_SCHEDULER" }))!.triggers).toEqual(["meeting_booked"]);
  expect((await fire("MEETING_BOOKED_VIA_SCHEDULER_CANCELED", { ...booking, event_type: "MEETING_BOOKED_VIA_SCHEDULER_CANCELED" }))!.triggers).toEqual(["booking_canceled"]);
  expect((await fire("MEETING_BOOKED_VIA_SCHEDULER_RESCHEDULED", booking))!.triggers).toEqual(["booking_rescheduled"]);
  expect(await fire("SOMETHING_NEW", { event_type: "SOMETHING_NEW" })).toBeUndefined();
  expect(push.wanted!({ organizer_email: "sarah@northwind.com" }, ready!.data)).toBe(true);
  expect(push.wanted!({ organizer_email: "tom@northwind.com" }, ready!.data)).toBe(false);
});
