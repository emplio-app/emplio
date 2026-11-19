import { afterEach, beforeAll, expect, spyOn, test } from "bun:test";
import { createHmac, randomBytes } from "node:crypto";
import Fastify from "fastify";
import { automationRoutes } from "../../../automations";
import { db } from "../../../db";
import { encrypt } from "../../../secrets";
import type { AppsError } from "../../types";
import type { Delivery } from "../index";
import { own } from "../index";
import { cashfree, parseKey } from "./index";
import { triggersFor, wanted, watchId } from "./triggers";

beforeAll(() => {
  process.env.ENCRYPTION_KEY = randomBytes(32).toString("base64");
  process.env.WEBHOOK_URL = "https://api.test";
});

type Call = { method: string; url: URL; headers: Record<string, string>; body: any };
const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});
function stub(reply: (c: Call) => Response | undefined) {
  const calls: Call[] = [];
  globalThis.fetch = (async (url: string, init: RequestInit = {}) => {
    const c = { method: init.method ?? "GET", url: new URL(url), headers: init.headers as Record<string, string>, body: init.body ? JSON.parse(String(init.body)) : undefined };
    calls.push(c);
    const r = reply(c);
    if (!r) throw new Error(`unexpected ${c.method} ${c.url}`);
    return r;
  }) as typeof fetch;
  return calls;
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const fails = (p: Promise<unknown>) =>
  p.then(
    () => {
      throw new Error("expected it to fail");
    },
    (e: AppsError) => e,
  );

const PROD = "CF12345abcdef:cfsk_ma_prod_secret";
const TEST = "TEST12345abcdef:cfsk_ma_test_secret";
const run = (action: string, input: unknown, key = PROD) => own.run(`cashfree.${action}`, input, { externalId: "c1", secret: key }, "owner");

test("the key says sandbox or production; a suffix overrides the guess", () => {
  expect(parseKey(PROD).env).toBe("production");
  expect(parseKey(TEST).env).toBe("sandbox");
  expect(parseKey("abc:def:sandbox")).toEqual({ id: "abc", secret: "def", env: "sandbox", explicit: true });
  expect(parseKey("TESTabc:def:production").env).toBe("production");
  expect(() => parseKey("only-an-id")).toThrow("joined by a colon");
  expect(() => parseKey("a:b:staging")).toThrow(":sandbox or :production");
});

test("a working key is accepted and labelled with its mode; a wrong one is refused", async () => {
  const calls = stub(() => json({ message: "order not found" }, 404));
  expect(await cashfree.check(PROD)).toBe("Production · CF12345a…");
  expect(calls[0]!.url.href).toBe("https://api.cashfree.com/pg/orders/emplio-key-check");
  expect(calls[0]!.headers["x-client-secret"]).toBe("cfsk_ma_prod_secret");
  expect(await cashfree.check(TEST)).toBe("Sandbox (test) · TEST1234…");
  expect(calls[1]!.url.host).toBe("sandbox.cashfree.com");

  stub(() => json({ message: "authentication Failed", type: "authentication_error" }, 401));
  expect((await fails(cashfree.check(PROD))).message).toContain("didn't accept");
});

test("sandbox keys that look like production ones are caught, with what to add", async () => {
  stub((c) => (c.url.host === "sandbox.cashfree.com" ? json({}, 404) : json({ message: "authentication Failed" }, 401)));
  expect((await fails(cashfree.check("abc:def"))).message).toContain(":sandbox at the end");
});

test("calls go to the key's environment with the client id, secret and API version", async () => {
  const calls = stub(() => json({ order_id: "o1", order_status: "PAID" }));
  await run("get_order", { order_id: "o1" }, TEST);
  expect(calls[0]!.url.href).toBe("https://sandbox.cashfree.com/pg/orders/o1");
  expect(calls[0]!.headers).toMatchObject({ "x-client-id": "TEST12345abcdef", "x-client-secret": "cfsk_ma_test_secret", "x-api-version": "2026-01-01" });

  await run("create_payment_link", { link_id: "l1", link_amount: 500, link_currency: "INR", link_purpose: "Order 10", customer_details: { customer_phone: "9000000000" }, x_idempotency_key: "k1" });
  expect(calls[1]!.url.href).toBe("https://api.cashfree.com/pg/links");
  expect(calls[1]!.body).toMatchObject({ link_id: "l1", link_amount: 500, customer_details: { customer_phone: "9000000000" } });
  expect(calls[1]!.headers["x-idempotency-key"]).toBe("k1");
});

test("a 401 asks for reconnecting; Cashfree's reason reaches the person otherwise", async () => {
  stub(() => json({ message: "authentication Failed", code: "request_failed", type: "authentication_error" }, 401));
  expect((await fails(run("get_order", { order_id: "o1" }))).message).toContain("rejected the token");
  stub(() => json({ message: "refund_amount : should be less than or equal to the order amount", type: "invalid_request_error" }, 400));
  expect((await fails(run("create_refund", { order_id: "o1", refund_amount: 9999, refund_id: "r-001" }))).message).toContain("should be less than");
});

test("anything that moves money or changes data asks first; lookups don't", () => {
  for (const name of ["create_payment_link", "create_order", "create_refund", "terminate_order", "cancel_payment_link", "accept_dispute", "create_vendor_transfer", "charge_subscription", "get_saved_card_cryptogram"])
    expect(cashfree.actions[name]?.readOnly).toBe(false);
  for (const name of ["get_order", "list_order_payments", "get_payment", "list_transactions", "list_settlements", "get_eligible_payment_methods", "get_webhook_setup"])
    expect(cashfree.actions[name]?.readOnly).toBe(true);
});

// --- triggers ---

const SECRET = "cfsk_ma_prod_secret";
const sign = (body: string, ts: string, secret = SECRET) => createHmac("sha256", secret).update(ts + body).digest("base64");
const delivery = (sent: unknown, o: { secret?: string; ts?: string; idem?: string } = {}): Delivery => {
  const body = JSON.stringify(sent);
  const ts = o.ts ?? "1763540000000";
  return { body, headers: { "x-webhook-signature": sign(body, ts, o.secret), "x-webhook-timestamp": ts, ...(o.idem ? { "x-idempotency-key": o.idem } : {}) }, connection: "c1", rest: "" };
};
const paid = { type: "PAYMENT_SUCCESS_WEBHOOK", event_time: "2026-11-19T10:00:00+05:30", data: { order: { order_id: "o1", order_amount: 500 }, payment: { cf_payment_id: 1, payment_status: "SUCCESS" } } };

test("each Cashfree event starts only the triggers it means", () => {
  expect(triggersFor("PAYMENT_SUCCESS_WEBHOOK", {})).toEqual(["payment_success"]);
  expect(triggersFor("PAYMENT_FAILED_WEBHOOK", {})).toEqual(["payment_failed"]);
  expect(triggersFor("REFUND_STATUS_WEBHOOK", { refund: { refund_status: "SUCCESS" } })).toEqual(["refund_status_changed", "refund_processed"]);
  expect(triggersFor("REFUND_STATUS_WEBHOOK", { refund: { refund_status: "CANCELLED" } })).toEqual(["refund_status_changed", "refund_cancelled"]);
  expect(triggersFor("PAYMENT_LINK_EVENT", { link_status: "PARTIALLY_PAID" })).toEqual(["payment_link_event", "payment_link_partially_paid"]);
  expect(triggersFor("PAYMENT_LINK_EVENT", { link_status: "PAID" })).toEqual(["payment_link_event", "payment_link_paid"]);
  expect(triggersFor("SETTLEMENT_SUCCESS", {})).toEqual(["settlement_success"]);
  expect(triggersFor("HEALTH_ALERT", {})).toEqual(["payment_downtime"]);
  expect(triggersFor("SOMETHING_NEW", {})).toEqual([]);
});

test("an automation's settings narrow what runs it", () => {
  const data = { type: paid.type, ...paid.data };
  expect(wanted({}, data)).toBe(true);
  expect(wanted({ order_id: "o1" }, data)).toBe(true);
  expect(wanted({ order_id: "o2" }, data)).toBe(false);
  expect(wanted({ order_id: "o1" }, { refund: { order_id: "o1" } })).toBe(true);
  expect(wanted({ link_id: "l1" }, { link_id: "l2" })).toBe(false);
  expect(wanted({ subscription_id: "s1" }, { subscription_details: { subscription_id: "s1" } })).toBe(true);
});

test("a signed delivery becomes one event under Cashfree's idempotency key; a forged one is refused", async () => {
  const got = await cashfree.push!.receive!(delivery(paid, { idem: "idem-1" }), PROD);
  expect(await got!.events()).toEqual([{ id: "idem-1", triggers: ["payment_success"], data: { type: paid.type, event_time: paid.event_time, ...paid.data } }]);
  // older webhook versions send no key: the same body gets the same id, so a resend is still caught
  const a = await (await cashfree.push!.receive!(delivery(paid), PROD))!.events();
  const b = await (await cashfree.push!.receive!(delivery(paid), PROD))!.events();
  expect(a[0]!.id).toBe(b[0]!.id!);
  expect(await cashfree.push!.receive!(delivery(paid, { secret: "someone-else" }), PROD)).toBeNull();
  const forged = delivery(paid);
  expect(await cashfree.push!.receive!({ ...forged, headers: { ...forged.headers, "x-webhook-timestamp": "1" } }, PROD)).toBeNull();
  expect(await cashfree.push!.receive!({ ...forged, headers: {} }, PROD)).toBeNull();
});

test("saving an automation only files the events: Cashfree's webhook is set up by hand", async () => {
  expect(await own.startPush!("cashfree.payment_success", { externalId: "c1", secret: PROD }, {})).toBe(watchId("c1"));
  expect(cashfree.push!.stop).toBeUndefined();
  const t = await own.getTrigger!("cashfree.payment_link_paid");
  expect(t?.input.map((i) => i.name)).toEqual(["link_id"]);
  expect(t?.description).toContain("get_webhook_setup");
});

test("get_webhook_setup says what to add, for this connection, and no secret", async () => {
  const setup = (await run("get_webhook_setup", {}, TEST)) as Record<string, string>;
  expect(setup.webhook_url).toBe("https://api.test/webhooks/app/cashfree/c1");
  expect(setup.where).toContain("Test mode");
  expect(JSON.stringify(setup)).not.toContain("cfsk_");
});

test("the webhook route takes only Cashfree's signature", async () => {
  const find = spyOn(db.query.connections, "findFirst");
  const app = Fastify();
  await automationRoutes(app);
  // an event type no trigger uses, so a 200 needs no database
  const body = JSON.stringify({ type: "SOMETHING_NEW", data: {} });
  const ts = "1763540000000";
  const post = (signature: string) =>
    app.inject({ method: "POST", url: "/webhooks/app/cashfree/c1", headers: { "content-type": "application/json", "x-webhook-signature": signature, "x-webhook-timestamp": ts }, payload: body });
  try {
    find.mockResolvedValue(undefined as never);
    expect((await post(sign(body, ts))).statusCode).toBe(401);
    find.mockResolvedValue({ id: "row", app: "cashfree", secret: encrypt(PROD), refreshToken: null, expiresAt: null } as never);
    expect((await post(sign(body, ts, "someone-else"))).statusCode).toBe(401);
    expect((await post("")).statusCode).toBe(401);
    expect((await post(sign(body, ts))).statusCode).toBe(200);
  } finally {
    find.mockRestore();
    await app.close();
  }
});
