import { afterEach, beforeAll, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { AppsError } from "../../types";
import { own } from "../index";
import { signingKey, wanted } from "./triggers";
import { calendly } from "./index";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});
beforeAll(() => {
  process.env.ENCRYPTION_KEY ??= "test-key";
  process.env.WEBHOOK_URL = "https://api.test";
});
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
type Call = { url: string; method: string; body: string };
const stub = (answer: (c: Call) => Response) => {
  const calls: Call[] = [];
  globalThis.fetch = (async (url: string, init: RequestInit = {}) => {
    const c = { url: String(url), method: init.method ?? "GET", body: String(init.body ?? "") };
    calls.push(c);
    return answer(c);
  }) as typeof fetch;
  return calls;
};
const login = { externalId: "c1", secret: "tok" };
const ORG = "https://api.calendly.com/organizations/O";
const ME = "https://api.calendly.com/users/U";
const HOOK = "https://api.test/webhooks/app/calendly/c1";
const me = json({ resource: { uri: ME, current_organization: ORG, name: "Asha" } });
const account = (subs: object[], onWrite: (c: Call) => Response = () => json({}, 201)) =>
  stub((c) => {
    if (c.url.endsWith("/users/me")) return me.clone();
    if (c.method === "GET") return json({ collection: subs });
    return onWrite(c);
  });
const sub = (events: string[], state = "active", scope = "organization", callback_url = HOOK) => ({ uri: "https://api.calendly.com/webhook_subscriptions/W1", callback_url, events, state, scope });

test("a token is checked and labelled, and a bad one is refused", async () => {
  const calls = stub(() => me.clone());
  expect(await own.connectWithKey!("calendly", " tok ")).toEqual({ secret: "tok", label: "Asha" });
  expect(calls[0]!.url).toBe("https://api.calendly.com/users/me");
  stub(() => json({ message: "unauthenticated" }, 401));
  await expect(own.connectWithKey!("calendly", "nope")).rejects.toBeInstanceOf(AppsError);
});

test("reads run unasked and writes ask", async () => {
  expect((await own.getAction("calendly.list_scheduled_events"))?.readOnly).toBe(true);
  expect((await own.getAction("calendly.get_current_user"))?.readOnly).toBe(true);
  expect((await own.getAction("calendly.cancel_scheduled_event"))?.readOnly).toBe(false);
  expect((await own.getAction("calendly.create_scheduling_link"))?.readOnly).toBe(false);
});

test("the first automation makes one organization subscription, signed with a key we work out", async () => {
  const calls = account([]);
  expect(await own.startPush!("calendly.meeting_scheduled", login, {})).toBe("calendly:c1");
  const made = calls.find((c) => c.method === "POST")!;
  expect(JSON.parse(made.body)).toEqual({ url: HOOK, events: ["invitee.created"], organization: ORG, scope: "organization", signing_key: signingKey("c1") });
  expect(calls[1]!.url).toContain("scope=organization");
});

test("another event deletes and remakes it with the union; the same event needs no change", async () => {
  const calls = account([sub(["invitee.created"])]);
  await own.startPush!("calendly.meeting_canceled", login, {});
  expect(calls.map((c) => c.method)).toEqual(["GET", "GET", "DELETE", "POST"]);
  expect(calls[2]!.url).toEndWith("/webhook_subscriptions/W1");
  expect(JSON.parse(calls[3]!.body).events).toEqual(["invitee.created", "invitee.canceled"]);
  const same = account([sub(["invitee.created"])]);
  await own.startPush!("calendly.meeting_scheduled", login, {});
  expect(same.some((c) => c.method !== "GET")).toBe(false);
  const off = account([sub(["invitee.created"], "disabled")]);
  await own.startPush!("calendly.meeting_scheduled", login, {});
  expect(off.map((c) => c.method)).toEqual(["GET", "GET", "DELETE", "POST"]);
});

test("recaps, which Calendly only offers per user, get their own subscription", async () => {
  const calls = account([]);
  expect(await own.startPush!("calendly.meeting_recap_created", login, {})).toBe("calendly:c1:user");
  const made = JSON.parse(calls.find((c) => c.method === "POST")!.body);
  expect(made).toMatchObject({ url: `${HOOK}/user`, scope: "user", user: ME, events: ["meeting_recap.created"] });
});

test("a member who can't subscribe the organization falls back to their own meetings", async () => {
  const calls = account([], (c) => (JSON.parse(c.body).scope === "organization" ? json({ message: "forbidden" }, 403) : json({}, 201)));
  await own.startPush!("calendly.meeting_scheduled", login, {});
  const posts = calls.filter((c) => c.method === "POST").map((c) => JSON.parse(c.body).scope);
  expect(posts).toEqual(["organization", "user"]);
});

test("the last automation removes it; a plan without webhooks says so", async () => {
  const calls = account([sub(["invitee.created"])]);
  await calendly.push!.stop!("tok", "calendly:c1");
  expect(calls.at(-1)!.method).toBe("DELETE");
  expect(calls.at(-1)!.url).toEndWith("/webhook_subscriptions/W1");
  account([], () => json({ message: "Please upgrade your Calendly account" }, 403));
  await expect(own.startPush!("calendly.meeting_scheduled", login, {})).rejects.toThrow(/paid Calendly plan/);
});

const event = (name: string, payload: object = {}) => JSON.stringify({ event: name, created_at: "2026-11-09T00:00:00Z", payload });
const signed = (body: string, t = Math.floor(Date.now() / 1000), key = signingKey("c1")) => ({
  body,
  headers: { "calendly-webhook-signature": `t=${t},v1=${createHmac("sha256", key).update(`${t}.${body}`).digest("hex")}` },
  connection: "c1",
  rest: "",
});

test("a good signature passes, and a bad or old one is refused", async () => {
  const body = event("invitee.created");
  expect(await calendly.push!.receive!(signed(body), "tok")).not.toBeNull();
  expect(await calendly.push!.receive!(signed(body, undefined, "wrong"), "tok")).toBeNull();
  expect(await calendly.push!.receive!(signed(body, Math.floor(Date.now() / 1000) - 6 * 60), "tok")).toBeNull();
  expect(await calendly.push!.receive!({ body, headers: {}, connection: "c1", rest: "" }, "tok")).toBeNull();
  expect(await calendly.push!.receive!({ ...signed(body), body: event("invitee.canceled") }, "tok")).toBeNull();
});

test("each event starts only its own trigger", async () => {
  for (const [name, trigger] of [
    ["invitee.created", "meeting_scheduled"],
    ["invitee.canceled", "meeting_canceled"],
    ["invitee_no_show.created", "invitee_marked_no_show"],
    ["invitee_no_show.deleted", "invitee_no_show_cleared"],
    ["routing_form_submission.created", "routing_form_submitted"],
    ["contact.deleted", "contact_deleted"],
    ["event_type.updated", "event_type_updated"],
  ] as const) {
    const got = await calendly.push!.receive!(signed(event(name, { a: 1 })), "tok");
    const [e] = await got!.events();
    expect(e!.triggers).toEqual([trigger]);
    expect(e!.data).toMatchObject({ event: name, payload: { a: 1 } });
    expect(e!.id).toBeTruthy();
  }
  const unknown = await (await calendly.push!.receive!(signed(event("something.else")), "tok"))!.events();
  expect(unknown[0]!.triggers).toEqual([]);
});

test("the event type and routing form settings narrow what runs", () => {
  const booked = { payload: { scheduled_event: { event_type: "E1" } } };
  expect(wanted({}, booked)).toBe(true);
  expect(wanted({ event_type: "E1" }, booked)).toBe(true);
  expect(wanted({ event_type: "E2" }, booked)).toBe(false);
  expect(wanted({ routing_form: "F" }, { payload: { routing_form: "F" } })).toBe(true);
  expect(wanted({ routing_form: "G" }, { payload: { routing_form: "F" } })).toBe(false);
});
