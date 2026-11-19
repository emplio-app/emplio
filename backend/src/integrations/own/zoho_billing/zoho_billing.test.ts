import { afterEach, beforeEach, expect, test } from "bun:test";
import { pollOnce } from "../../polls";
import { own } from "../index";
import { BACK, clearZohoEnv, fakeZoho, zohoEnv } from "../zoho-fake";
import { SCOPES } from "./index";

const exec = (action: string, input: unknown, secret: string) => own.run(action, input, { externalId: "c", secret }, "o") as Promise<any>;
beforeEach(zohoEnv);
afterEach(clearZohoEnv);
const orgs = (...list: [string, string][]) => ({ organizations: list.map(([organization_id, name]) => ({ organization_id, name })) });
let n = 0;
const fresh = (dc = "in") => `${dc}:b${n++}`;
const route = (url: URL, more: unknown) => (url.pathname.endsWith("/organizations") ? orgs(["111", "Acme"]) : more);
const ORG = "X-com-zoho-subscriptions-organizationid";

test("not offered without the client id and secret", async () => {
  clearZohoEnv();
  expect((await own.readyApps()).has("zoho_billing")).toBe(false);
  zohoEnv();
  expect((await own.getApp("zoho_billing"))?.signIn).toBe(true);
});

test("a sign-in round trip asks for the Billing scope and can't be forged; the login stays in its data centre", async () => {
  const { url } = await own.startSignIn("zoho_billing", "o", BACK);
  const page = new URL(url);
  expect(page.searchParams.get("scope")).toBe(SCOPES);
  expect(page.searchParams.get("redirect_uri")).toBe("https://api.test/oauth/zoho_billing/callback");
  expect(own.readSignIn!("zoho_billing", `${page.searchParams.get("state")!.split(".")[0]}.forged`)).toBeNull();
  const sent = fakeZoho((u) => (u.pathname.endsWith("/token") ? { access_token: "a1", refresh_token: "r1", expires_in: 3600 } : orgs(["111", "Acme"])));
  expect(await own.finishSignIn!("zoho_billing", "c", BACK, { location: "eu" })).toMatchObject({ secret: "eu:a1", label: "Acme", refreshToken: "eu:r1" });
  expect(sent[0]!.url).toBe("https://accounts.zoho.eu/oauth/v2/token");
  expect(sent[1]!.url).toBe("https://www.zohoapis.eu/billing/v1/organizations");
});

test("reads run unasked and writes ask", async () => {
  expect((await own.getAction("zoho_billing.list_subscriptions"))?.readOnly).toBe(true);
  expect((await own.getAction("zoho_billing.cancel_subscription"))?.readOnly).toBe(false);
  expect((await own.getAction("zoho_billing.create_subscription"))?.readOnly).toBe(false);
  expect((await own.getAction("zoho_billing.get_options"))?.readOnly).toBe(true);
});

test("the organisation goes in its header, filled in when there's just one; the body is sent as JSON", async () => {
  let sent = fakeZoho((u) => route(u, { subscription: { subscription_id: "9" } }));
  await exec("zoho_billing.create_subscription", { customer_id: "5", plan: { plan_code: "gold" } }, fresh("in"));
  const call = sent.find((s) => s.method === "POST")!;
  expect(call.url).toBe("https://www.zohoapis.in/billing/v1/subscriptions");
  expect(call.headers[ORG]).toBe("111");
  expect(call.query.get("organization_id")).toBeNull();
  expect(call.body).toEqual({ customer_id: "5", plan: { plan_code: "gold" } });
  sent = fakeZoho((u) => route(u, { subscriptions: [] }));
  await exec("zoho_billing.list_subscriptions", {}, fresh("eu"));
  expect(sent.at(-1)!.url).toBe("https://www.zohoapis.eu/billing/v1/subscriptions");
});

test("several organisations ask which, and a given one is used", async () => {
  const sent = fakeZoho((u) => (u.pathname.endsWith("/organizations") ? orgs(["1", "A Co"], ["2", "B Co"]) : { subscriptions: [] }));
  await expect(exec("zoho_billing.list_subscriptions", {}, fresh())).rejects.toThrow(/1 \(A Co\), 2 \(B Co\)/);
  await exec("zoho_billing.list_subscriptions", { organization_id: "2" }, fresh());
  expect(sent.at(-1)!.headers[ORG]).toBe("2");
});

test("a reporting tag option, written by hand, reaches the right address", async () => {
  const sent = fakeZoho((u) => route(u, { code: 0 }));
  await exec("zoho_billing.mark_option_as_active", { tag_id: "7", option_id: "8" }, fresh());
  expect(sent.at(-1)!.url).toBe("https://www.zohoapis.in/billing/v1/reportingtags/7/option/8/active");
  expect(sent.at(-1)!.headers[ORG]).toBe("111");
});

test("a failure with a 200, and a dead token", async () => {
  fakeZoho((u) => route(u, { code: 4, message: "Invalid value" }));
  await expect(exec("zoho_billing.list_subscriptions", {}, fresh())).rejects.toThrow("Invalid value");
  fakeZoho((u) => route(u, { $status: 401, body: { code: 57, message: "not authorized" } }));
  expect((await exec("zoho_billing.list_subscriptions", {}, fresh()).catch((e) => e)).expired).toBe(true);
});

test("event triggers start only on their own kind, with the customer filter", async () => {
  const key = fresh();
  let events: object[] = [{ event_id: "e1", event_type: "subscription_created", payload: { subscription: { customer_id: "1" } } }];
  const sent = fakeZoho((u) => route(u, { events }));
  const run = (a: string, i: unknown) => exec(a, i, key);
  const first = await pollOnce("zoho_billing.payment_failed", {}, null, run);
  expect(first.fresh).toHaveLength(0);
  expect(sent.at(-1)!.path).toBe("/billing/v1/events");
  const subs = await pollOnce("zoho_billing.new_subscription", { customer_id: "1" }, null, run);
  events = [
    ...events,
    { event_id: "e2", event_type: "payment_declined", payload: JSON.stringify({ payment: { customer_id: "2" } }) },
    { event_id: "e3", event_type: "subscription_created", payload: { subscription: { customer_id: "2" } } },
    { event_id: "e4", event_type: "subscription_created", payload: { subscription: { customer_id: "1" } } },
  ];
  const failed = await pollOnce("zoho_billing.payment_failed", {}, first.seen, run);
  expect(failed.fresh).toEqual([{ event: { event_id: "e2", event_type: "payment_declined", payload: { payment: { customer_id: "2" } } } }]);
  const next = await pollOnce("zoho_billing.new_subscription", { customer_id: "1" }, subs.seen, run);
  expect(next.fresh.map((f: any) => f.event.event_id)).toEqual(["e4"]);
  const any = await pollOnce("zoho_billing.new_event", { event_type: "payment_declined" }, [], run);
  expect(any.fresh).toHaveLength(1);
});

test("new invoices come newest first from the invoice list", async () => {
  const key = fresh();
  let invoices = [{ invoice_id: "a" }];
  const sent = fakeZoho((u) => route(u, { invoices }));
  const run = (a: string, i: unknown) => exec(a, i, key);
  const first = await pollOnce("zoho_billing.new_invoice", {}, null, run);
  expect(sent.at(-1)!.query.get("sort_column")).toBe("created_time");
  invoices = [{ invoice_id: "b" }, ...invoices];
  expect((await pollOnce("zoho_billing.new_invoice", {}, first.seen, run)).fresh).toEqual([{ invoice: { invoice_id: "b" } }]);
});
