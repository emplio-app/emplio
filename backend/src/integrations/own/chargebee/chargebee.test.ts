import { afterEach, beforeAll, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { AppsError } from "../../types";
import { own } from "../index";
import { parseKey } from "./api";
import { triggers, wanted } from "./triggers";
import { chargebee } from "./index";

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
    const c = { url: decodeURIComponent(String(url)), method: init.method ?? "GET", body: decodeURIComponent(String(init.body ?? "")), headers: init.headers as Record<string, string> };
    calls.push(c);
    return answer(c);
  }) as typeof fetch;
  return calls;
};
const login = { externalId: "c1", secret: "acme-test:test_abc" };
const target = "https://api.test/webhooks/app/chargebee/c1";
const password = () => createHmac("sha256", process.env.ENCRYPTION_KEY!).update("chargebee-webhook:c1").digest("hex").slice(0, 32);
const basic = (pass = password()) => `Basic ${Buffer.from(`emplio:${pass}`).toString("base64")}`;
const delivery = (body: unknown, authorization = basic()) => ({ body: JSON.stringify(body), headers: { authorization }, connection: "c1", rest: "" });
const event = (event_type: string, content: unknown = { customer: { id: "cus_1" } }) => ({ id: "ev_1", occurred_at: 1763800000, source: "admin_console", object: "event", event_type, webhook_status: "scheduled", content });
const fire = async (body: unknown) => (await (await chargebee.push!.receive!(delivery(body), "k"))!.events())[0]?.triggers ?? [];

test("the site and key are read in every usual shape, and only Chargebee hosts are allowed", () => {
  expect(parseKey("acme:live_abc")).toEqual({ host: "acme.chargebee.com", key: "live_abc" });
  expect(parseKey(" https://Acme-Test.chargebee.com/ test_abc ")).toEqual({ host: "acme-test.chargebee.com", key: "test_abc" });
  expect(parseKey("acme.chargebee.com:live_abc")).toEqual({ host: "acme.chargebee.com", key: "live_abc" });
  expect(() => parseKey("live_abc")).toThrow(AppsError);
  expect(() => parseKey("evil.com:live_abc")).toThrow(/isn't a Chargebee site/);
});

test("a key is checked on the person's own site with basic auth, and a bad one is refused as dead", async () => {
  const calls = stub(() => json({ list: [] }));
  expect(await own.connectWithKey!("chargebee", "acme:live_abc")).toEqual({ secret: "acme:live_abc", label: "acme" });
  expect(calls[0]!.url).toBe("https://acme.chargebee.com/api/v2/customers?limit=1");
  expect(calls[0]!.headers.Authorization).toBe(`Basic ${Buffer.from("live_abc:").toString("base64")}`);
  stub(() => json({ message: "Sorry, authentication failed. Invalid api key", api_error_code: "api_authentication_failed" }, 401));
  const refused = await own.connectWithKey!("chargebee", "acme:nope").catch((e) => e);
  expect(refused).toBeInstanceOf(AppsError);
  expect(refused.expired).toBe(true);
});

test("filters go up as deepObject keys, nested fields as brackets, JSON fields as JSON", async () => {
  const calls = stub(() => json({ list: [] }));
  await own.run("chargebee.list_subscriptions", { limit: 5, status: { in: ["active", "in_trial"] }, created_at: { after: "1763800000" } }, login, "o");
  const url = new URL(calls[0]!.url);
  expect(url.host).toBe("acme-test.chargebee.com");
  expect(url.pathname).toBe("/api/v2/subscriptions");
  expect(url.searchParams.get("status[in]")).toBe('["active","in_trial"]');
  expect(url.searchParams.get("created_at[after]")).toBe("1763800000");
  expect(url.searchParams.get("limit")).toBe("5");
  await own.run("chargebee.create_subscription_for_items", { customer_id: "cus_1", subscription_items: { item_price_id: ["pro-USD-monthly"], quantity: [2] }, meta_data: { plan: "gold" } }, login, "o");
  expect(calls[1]!.url).toBe("https://acme-test.chargebee.com/api/v2/customers/cus_1/subscription_for_items");
  const sent = new URLSearchParams(calls[1]!.body);
  expect(sent.get("subscription_items[item_price_id][0]")).toBe("pro-USD-monthly");
  expect(sent.get("subscription_items[quantity][0]")).toBe("2");
  expect(sent.get("meta_data")).toBe('{"plan":"gold"}');
  stub(() => json({ message: "customer_id : cannot be blank", api_error_code: "invalid_request" }, 400));
  await expect(own.run("chargebee.create_a_customer", { first_name: "Sarah" }, login, "o")).rejects.toThrow(/cannot be blank/);
});

test("reads run unasked, writes and secrets ask, and Product Catalog 1.0 calls say so", async () => {
  expect((await own.getAction("chargebee.retrieve_a_customer"))?.readOnly).toBe(true);
  expect((await own.getAction("chargebee.estimate_for_creating_a_subscription"))?.readOnly).toBe(true);
  expect((await own.getAction("chargebee.retrieve_invoice_as_pdf"))?.readOnly).toBe(true);
  expect((await own.getAction("chargebee.create_a_customer"))?.readOnly).toBe(false);
  expect((await own.getAction("chargebee.cancel_subscription_for_items"))?.readOnly).toBe(false);
  expect((await own.getAction("chargebee.retrieve_a_portal_session"))?.readOnly).toBe(false);
  expect((await own.getAction("chargebee.list_plans"))?.description).toStartWith("Only for sites still on Product Catalog 1.0");
});

test("the first automation makes the webhook endpoint with our basic auth, the next reuses it, a disabled one is replaced", async () => {
  const none = stub((c) => (c.method === "GET" ? json({ list: [] }) : json({ webhook_endpoint: { id: "we_1" } })));
  expect(await own.startPush!("chargebee.subscription_created", login, {})).toBe("chargebee:c1");
  expect(none[0]!.url).toBe("https://acme-test.chargebee.com/api/v2/webhook_endpoints?limit=100");
  expect(none[1]!.method).toBe("POST");
  expect(Object.fromEntries(new URLSearchParams(none[1]!.body))).toEqual({ name: "Emplio", url: target, api_version: "v2", basic_auth_username: "emplio", basic_auth_password: password() });
  const live = { id: "we_1", url: target, disabled: false };
  const same = stub(() => json({ list: [{ webhook_endpoint: live }, { webhook_endpoint: { ...live, id: "we_2", url: "https://other" } }] }));
  await own.startPush!("chargebee.payment_failed", login, {});
  expect(same).toHaveLength(1);
  const off = stub((c) => (c.method === "GET" ? json({ list: [{ webhook_endpoint: { ...live, disabled: true } }] }) : json({})));
  await own.startPush!("chargebee.payment_failed", login, {});
  expect(off.slice(1).map((c) => `${c.method} ${c.url}`)).toEqual(["POST https://acme-test.chargebee.com/api/v2/webhook_endpoints/we_1/delete", "POST https://acme-test.chargebee.com/api/v2/webhook_endpoints"]);
});

test("the last automation removes only our endpoint", async () => {
  const calls = stub((c) => (c.method === "GET" ? json({ list: [{ webhook_endpoint: { id: "we_2", url: "https://other" } }, { webhook_endpoint: { id: "we_1", url: target } }] }) : json({})));
  await chargebee.push!.stop!(login.secret, "chargebee:c1");
  expect(calls.slice(1).map((c) => `${c.method} ${c.url}`)).toEqual(["POST https://acme-test.chargebee.com/api/v2/webhook_endpoints/we_1/delete"]);
});

test("a wrong or missing password is refused", async () => {
  expect(await chargebee.push!.receive!(delivery(event("customer_created"), basic("nope")), "k")).toBeNull();
  expect(await chargebee.push!.receive!(delivery(event("customer_created"), ""), "k")).toBeNull();
});

test("each event starts only its own trigger, without the delivery clutter, and a retry has the same id", async () => {
  expect(await fire(event("subscription_cancelled"))).toEqual(["subscription_cancelled"]);
  expect(await fire(event("payment_succeeded"))).toEqual(["payment_succeeded"]);
  expect(await fire(event("mystery_happened"))).toEqual([]);
  const [a] = await (await chargebee.push!.receive!(delivery(event("invoice_generated")), "k"))!.events();
  expect(a!.id).toBe("c1:ev_1");
  expect(a!.data).toEqual({ id: "ev_1", occurred_at: 1763800000, source: "admin_console", event_type: "invoice_generated", content: { customer: { id: "cus_1" } } });
});

test("the customer filter matches the customer or what belongs to them", () => {
  expect(wanted({}, event("customer_changed"))).toBe(true);
  expect(wanted({ customer_id: "cus_1" }, event("customer_changed"))).toBe(true);
  expect(wanted({ customer_id: "cus_1" }, event("invoice_generated", { invoice: { id: "inv_1", customer_id: "cus_1" } }))).toBe(true);
  expect(wanted({ customer_id: "cus_2" }, event("customer_changed"))).toBe(false);
});

test("every event Chargebee can send is a trigger", () => {
  for (const t of ["customer_created", "subscription_created", "subscription_cancelled", "subscription_renewed", "invoice_generated", "payment_succeeded", "payment_failed", "payment_refunded", "credit_note_created", "item_price_created", "quote_created"])
    expect(triggers[t]).toBeDefined();
  expect(Object.keys(triggers).length).toBeGreaterThan(250);
  expect(triggers.product_created).toBeUndefined(); // deprecated
});
