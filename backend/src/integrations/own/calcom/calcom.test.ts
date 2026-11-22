import { afterEach, beforeAll, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { AppsError } from "../../types";
import { pollTrigger } from "../../polls/index";
import { own } from "../index";
import { calcom, parseKey } from "./index";
import { triggers, wanted } from "./triggers";

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
const login = { externalId: "c1", secret: "cal_live_tok" };
const target = "https://api.test/webhooks/app/calcom/c1";
const secret = () => createHmac("sha256", process.env.ENCRYPTION_KEY!).update("calcom-webhook:c1").digest("hex");
const sign = (body: string, key = secret()) => createHmac("sha256", key).update(body).digest("hex");
const delivery = (body: unknown, signature?: string) => {
  const raw = JSON.stringify(body);
  return { body: raw, headers: { "x-cal-signature-256": signature ?? sign(raw) }, connection: "c1", rest: "" };
};
const booking = { uid: "b1", bookingId: 7, eventTypeId: 3, title: "Intro call", attendees: [{ name: "Sarah", email: "sarah@northwind.com" }] };
const fire = async (body: unknown) => (await (await calcom.push!.receive!(delivery(body), "k"))!.events())[0]?.triggers ?? [];

test("a key is checked on /v2/me with a bearer token and labelled, and a bad one is refused as dead", async () => {
  const calls = stub(() => json({ status: "success", data: { id: 1, name: "Sarah", email: "s@x.com", organization: { name: "Northwind" } } }));
  expect(await own.connectWithKey!("calcom", " cal_live_tok ")).toEqual({ secret: "cal_live_tok", label: "Sarah (Northwind)" });
  expect(calls[0]!.url).toBe("https://api.cal.com/v2/me");
  expect(calls[0]!.headers.Authorization).toBe("Bearer cal_live_tok");
  stub(() => json({ status: "error", error: { message: "Invalid API key" } }, 401));
  const refused = await own.connectWithKey!("calcom", "nope").catch((e) => e);
  expect(refused).toBeInstanceOf(AppsError);
  expect(refused.expired).toBe(true);
});

test("a self-hosted address before the key is used, and an inside address is refused", async () => {
  expect(parseKey("https://cal.example.com/api/v2/ cal_x")).toEqual({ base: "https://cal.example.com/api", token: "cal_x" });
  const calls = stub(() => json({ status: "success", data: { name: "Sarah" } }));
  await calcom.check("https://cal.example.com/api cal_x");
  expect(calls[0]!.url).toBe("https://cal.example.com/api/v2/me");
  expect(calls[0]!.headers.Authorization).toBe("Bearer cal_x");
  for (const bad of ["http://cal.example.com cal_x", "https://localhost cal_x", "https://169.254.169.254 cal_x", "https://10.0.0.2 cal_x", "a b c"]) expect(() => parseKey(bad)).toThrow(AppsError);
});

test("each call sends the cal-api-version it needs, and an error in the body fails", async () => {
  const calls = stub(() => json({ status: "success", data: [] }));
  await own.run("calcom.fetch_all_bookings", { status: "upcoming" }, login, "o");
  expect(calls[0]!.url).toStartWith("https://api.cal.com/v2/bookings?status=upcoming");
  expect(calls[0]!.headers["cal-api-version"]).toBe("2026-05-01");
  await own.run("calcom.get_available_time_slots_for_event_type", { eventTypeId: 3, start: "2026-11-23", end: "2026-11-24" }, login, "o");
  expect(calls[1]!.headers["cal-api-version"]).toBe("2024-09-04");
  await own.run("calcom.get_my_profile", {}, login, "o");
  expect(calls[2]!.headers["cal-api-version"]).toBeUndefined();
  stub(() => json({ status: "error", error: { message: "Booking not found" } }));
  await expect(own.run("calcom.get_my_profile", {}, login, "o")).rejects.toThrow(/Booking not found/);
});

test("reads run unasked, writes ask, and webhook secrets ask first", async () => {
  const ro = async (a: string) => (await own.getAction(`calcom.${a}`))?.readOnly;
  expect(await ro("fetch_all_bookings")).toBe(true);
  expect(await ro("get_booking_kpi_stats")).toBe(true);
  expect(await ro("create_booking")).toBe(false);
  expect(await ro("cancel_booking")).toBe(false);
  expect(await ro("get_my_webhooks")).toBe(false);
  expect((await own.listActions("calcom")).some((a) => a.action === "calcom.refresh_api_key")).toBe(false);
});

test("the first automation makes the webhook with our secret, the next adds its event, a covered one changes nothing", async () => {
  const none = stub((c) => (c.method === "GET" ? json({ status: "success", data: [] }) : json({ status: "success", data: { id: 9 } })));
  expect(await own.startPush!("calcom.booking_created", login, {})).toBe("calcom:c1");
  expect(none[0]!.url).toBe("https://api.cal.com/v2/webhooks?take=250");
  expect(none[1]!.method).toBe("POST");
  expect(JSON.parse(none[1]!.body)).toEqual({ active: true, subscriberUrl: target, triggers: ["BOOKING_CREATED"], secret: secret() });
  const hook = { id: 9, subscriberUrl: target, triggers: ["BOOKING_CREATED"], active: true };
  const add = stub((c) => (c.method === "GET" ? json({ status: "success", data: [hook, { ...hook, id: 4, subscriberUrl: "https://other" }] }) : json({ status: "success", data: {} })));
  await own.startPush!("calcom.after_guests_cal_video_no_show", login, {});
  expect(`${add[1]!.method} ${add[1]!.url}`).toBe("PATCH https://api.cal.com/v2/webhooks/9");
  expect(JSON.parse(add[1]!.body)).toMatchObject({ triggers: ["BOOKING_CREATED", "AFTER_GUESTS_CAL_VIDEO_NO_SHOW"], time: 15, timeUnit: "MINUTE" });
  const same = stub(() => json({ status: "success", data: [hook] }));
  await own.startPush!("calcom.booking_created", login, {});
  expect(same).toHaveLength(1);
});

test("the last automation removes only our webhook", async () => {
  const calls = stub((c) => (c.method === "GET" ? json({ status: "success", data: [{ id: 4, subscriberUrl: "https://other" }, { id: 9, subscriberUrl: target }] }) : json({ status: "success" })));
  await calcom.push!.stop!("k", "calcom:c1");
  expect(calls.slice(1).map((c) => `${c.method} ${c.url}`)).toEqual(["DELETE https://api.cal.com/v2/webhooks/9"]);
});

test("a wrong or missing signature is refused", async () => {
  const body = { triggerEvent: "BOOKING_CREATED", createdAt: "2026-11-22T10:00:00Z", payload: booking };
  expect(await calcom.push!.receive!(delivery(body, sign(JSON.stringify(body), "other")), "k")).toBeNull();
  expect(await calcom.push!.receive!(delivery(body, "no-secret-provided"), "k")).toBeNull();
});

test("each event starts only its trigger, and meetings come flat", async () => {
  const at = "2026-11-22T10:00:00Z";
  expect(await fire({ triggerEvent: "BOOKING_CREATED", createdAt: at, payload: booking })).toEqual(["booking_created"]);
  expect(await fire({ triggerEvent: "BOOKING_CANCELLED", createdAt: at, payload: booking })).toEqual(["booking_cancelled"]);
  expect(await fire({ triggerEvent: "FORM_SUBMITTED", createdAt: at, payload: { formId: "f1" } })).toEqual(["form_submitted"]);
  expect(await fire({ triggerEvent: "SOMETHING_NEW", createdAt: at, payload: {} })).toEqual([]);
  const [meeting] = await (await calcom.push!.receive!(delivery({ triggerEvent: "MEETING_ENDED", createdAt: at, ...booking }), "k"))!.events();
  expect(meeting!.triggers).toEqual(["meeting_ended"]);
  expect(meeting!.data).toEqual({ event: "MEETING_ENDED", created_at: at, payload: booking });
  expect(meeting!.id).toBe(`c1:MEETING_ENDED:b1:${at}`);
});

test("filters narrow what runs", () => {
  const data = { event: "BOOKING_CREATED", created_at: "", payload: booking };
  expect(wanted({}, data)).toBe(true);
  expect(wanted({ event_type_id: 3, attendee_email: "SARAH@northwind.com" }, data)).toBe(true);
  expect(wanted({ event_type_id: 4 }, data)).toBe(false);
  expect(wanted({ attendee_email: "tom@x.com" }, data)).toBe(false);
  expect(wanted({ form_id: "f1" }, { event: "FORM_SUBMITTED", created_at: "", payload: { formId: "f1" } })).toBe(true);
  expect(wanted({ form_id: "f2" }, { event: "FORM_SUBMITTED", created_at: "", payload: { formId: "f1" } })).toBe(false);
});

test("every Cal.com webhook event has a trigger", () => {
  expect(Object.keys(triggers)).toHaveLength(37);
  expect(triggers.booking_created!.config.map((f) => f.name)).toEqual(["event_type_id", "attendee_email"]);
});

test("a booking starting soon is reported once per start time", async () => {
  const soon = new Date(Date.now() + 30 * 60_000).toISOString();
  const later = new Date(Date.now() + 5 * 3600_000).toISOString();
  let asked: unknown;
  const run = async (_a: string, input: unknown) => ((asked = input), { data: [{ uid: "b1", start: soon }, { uid: "b2", start: later }] });
  const poll = pollTrigger("calcom.booking_starting_soon")!;
  expect((await poll.poll({}, run)).map((i) => i.id)).toEqual([`b1:${soon}`]);
  expect(asked).toMatchObject({ status: "upcoming", sortStart: "asc" });
  expect((await poll.poll({ minutes: 600 }, run)).length).toBe(2);
});
