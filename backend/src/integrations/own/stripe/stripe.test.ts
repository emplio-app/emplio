import { afterEach, beforeAll, expect, spyOn, test } from "bun:test";
import { randomBytes } from "node:crypto";
import Fastify from "fastify";
import { automationRoutes } from "../../../automations";
import { db } from "../../../db";
import { encrypt } from "../../../secrets";
import { AppFile, AppsError } from "../../types";
import { own } from "../index";
import { events, triggers, wanted } from "./triggers";
import { stripe } from "./index";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});
beforeAll(() => {
  process.env.ENCRYPTION_KEY = randomBytes(32).toString("base64");
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
const login = { externalId: "c1", secret: "sk_test_x" };
const URL_ = "https://api.test/webhooks/app/stripe/c1";

test("a key is checked and labelled, a test key says so, and a bad key is refused", async () => {
  const calls = stub(() => json({ id: "acct_1", settings: { dashboard: { display_name: "Acme" } } }));
  expect(await own.connectWithKey!("stripe", " sk_test_x ")).toEqual({ secret: "sk_test_x", label: "Acme (test mode)" });
  expect(calls[0]!.headers.Authorization).toBe("Bearer sk_test_x");
  stub(() => json({ error: { message: "Invalid API Key" } }, 401));
  await expect(own.connectWithKey!("stripe", "nope")).rejects.toBeInstanceOf(AppsError);
});

test("a restricted key that can't read the account is still a good key", async () => {
  stub(() => json({ error: { message: "needs rak_accounts_read" } }, 403));
  expect(await own.connectWithKey!("stripe", "rk_live_x")).toEqual({ secret: "rk_live_x" });
});

test("reads run unasked, writes ask, secrets ask", async () => {
  expect((await own.getAction("stripe.create_customer"))?.readOnly).toBe(false);
  expect((await own.getAction("stripe.list_customers"))?.readOnly).toBe(true);
  expect((await own.getAction("stripe.find_secret"))?.readOnly).toBe(false);
  expect((await own.getAction("stripe.create_preview_invoice"))?.readOnly).toBe(true);
});

test("a body goes as Stripe's nested form", async () => {
  const calls = stub(() => json({ id: "cus_1" }));
  await own.run("stripe.create_customer", { name: "Asha", metadata: { plan: "pro" }, preferred_locales: ["en", "hi"] }, login, "o");
  expect(calls[0]!.url).toBe("https://api.stripe.com/v1/customers");
  expect(calls[0]!.headers["Content-Type"]).toBe("application/x-www-form-urlencoded");
  expect(Object.fromEntries(new URLSearchParams(calls[0]!.body))).toEqual({ name: "Asha", "metadata[plan]": "pro", "preferred_locales[0]": "en", "preferred_locales[1]": "hi" });
});

test("a file comes back as a file, from Stripe's file host", async () => {
  const calls = stub(() => new Response(new Uint8Array([1, 2]), { headers: { "content-type": "application/pdf" } }));
  const file = await own.run("stripe.download_file_contents", { file: "file_1" }, login, "o");
  expect(file).toBeInstanceOf(AppFile);
  expect((file as AppFile).name).toBe("file_1");
  expect(calls[0]!.url).toBe("https://files.stripe.com/v1/files/file_1/contents");
});

test("the first automation makes one endpoint, the next extends it, the same event needs no call", async () => {
  const none = stub((c) => json(c.method === "GET" ? { data: [] } : { id: "we_1" }));
  expect(await own.startPush!("stripe.invoice_paid", login, {})).toBe("stripe:c1");
  expect(none[1]!.method).toBe("POST");
  expect(Object.fromEntries(new URLSearchParams(none[1]!.body))).toEqual({ url: URL_, "enabled_events[0]": "invoice.paid", description: "Emplio" });
  const ep = { id: "we_1", url: URL_, enabled_events: ["invoice.paid"], status: "enabled" };
  const add = stub((c) => json(c.method === "GET" ? { data: [ep] } : {}));
  await own.startPush!("stripe.charge_refunded", login, {});
  expect(add[1]!.url).toEndWith("/v1/webhook_endpoints/we_1");
  expect(add[1]!.body).toContain("enabled_events%5B1%5D=charge.refunded");
  const same = stub(() => json({ data: [ep] }));
  await own.startPush!("stripe.invoice_paid", login, {});
  expect(same).toHaveLength(1);
});

test("a refusal to set up says what the key needs, and the last automation removes the endpoint", async () => {
  stub(() => json({ error: { message: "no" } }, 403));
  await expect(own.startPush!("stripe.invoice_paid", login, {})).rejects.toThrow(/Webhook Endpoints write/);
  const calls = stub((c) => json(c.method === "GET" ? { data: [{ id: "we_1", url: URL_, enabled_events: [], status: "enabled" }] } : {}));
  await stripe.push!.stop!("k", "stripe:c1");
  expect(calls[1]!.method).toBe("DELETE");
  expect(calls[1]!.url).toEndWith("/v1/webhook_endpoints/we_1");
});

const delivery = (body: unknown) => ({ body: JSON.stringify(body), headers: {}, connection: "c1", rest: "" });

test("an event counts only if Stripe confirms it, and a forged one is refused", async () => {
  const real = { id: "evt_1", type: "invoice.paid", created: Math.floor(Date.now() / 1000), livemode: false, data: { object: { object: "invoice", customer: "cus_1" } } };
  const calls = stub(() => json(real));
  // what's posted is ignored; what Stripe says on the key is what runs
  const got = await stripe.push!.receive!(delivery({ id: "evt_1", type: "payout.paid", data: { object: { forged: true } } }), "k");
  expect(calls[0]!.url).toBe("https://api.stripe.com/v1/events/evt_1");
  const [e] = await got!.events();
  expect(e).toEqual({ id: "evt_1", triggers: ["invoice_paid"], data: { id: "evt_1", type: "invoice.paid", created: real.created, livemode: false, object: real.data.object } });

  stub(() => json({ error: { message: "No such event" } }, 404));
  await expect(stripe.push!.receive!(delivery({ id: "evt_fake" }), "k")).rejects.toBeInstanceOf(AppsError);
  expect(await stripe.push!.receive!(delivery({ id: "../v1/customers" }), "k")).toBeNull();
  stub(() => json({ ...real, created: 1000 }));
  expect(await stripe.push!.receive!(delivery({ id: "evt_1" }), "k")).toBeNull();
});

test("the customer setting narrows what runs", () => {
  const data = { object: { object: "invoice", customer: "cus_1" } };
  expect(wanted({}, data)).toBe(true);
  expect(wanted({ customer: "cus_1" }, data)).toBe(true);
  expect(wanted({ customer: "cus_2" }, data)).toBe(false);
  expect(wanted({ customer: "cus_1" }, { object: { object: "customer", id: "cus_1" } })).toBe(true);
});

test("every event Stripe has is a trigger, under Composio's names", () => {
  for (const name of ["charge_dispute_closed", "checkout_session_completed", "customer_subscription_trial_will_end", "invoiceitem_created", "payment_link_created", "refund_created"]) expect(triggers[name]).toBeDefined();
  expect(events.customer_subscription_trial_will_end).toBe("customer.subscription.trial_will_end");
});

test("the shared webhook route: an unknown connection and a forged event get 401, a real one 200", async () => {
  const find = spyOn(db.query.connections, "findFirst");
  const app = Fastify();
  await automationRoutes(app);
  const post = (url: string) => app.inject({ method: "POST", url, headers: { "content-type": "application/json" }, payload: JSON.stringify({ id: "evt_1" }) });
  try {
    find.mockResolvedValue(undefined as never);
    expect((await post("/webhooks/app/stripe/nobody")).statusCode).toBe(401);
    expect((await post("/webhooks/app/notanapp/c1")).statusCode).toBe(401);

    find.mockResolvedValue({ id: "row", app: "stripe", secret: encrypt("sk_test_x"), refreshToken: null, expiresAt: null } as never);
    stub(() => json({ error: { message: "No such event" } }, 404));
    expect((await post("/webhooks/app/stripe/c1")).statusCode).toBe(401);

    // not a known event type, so it's answered without looking for automations
    stub(() => json({ id: "evt_1", type: "not.an.event", created: Math.floor(Date.now() / 1000), livemode: false, data: { object: {} } }));
    expect((await post("/webhooks/app/stripe/c1")).statusCode).toBe(200);
  } finally {
    find.mockRestore();
    await app.close();
  }
});
