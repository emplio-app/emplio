import { afterEach, beforeEach, expect, test } from "bun:test";
import { pollOnce } from "../../polls";
import { AppsError } from "../../types";
import { own } from "../index";
import { BACK, clearZohoEnv, fakeZoho, zohoEnv } from "../zoho-fake";
import { SCOPES, zoho_books } from "./index";

const exec = (action: string, input: unknown, secret: string) => own.run(action, input, { externalId: "c", secret }, "o") as Promise<any>;
beforeEach(zohoEnv);
afterEach(clearZohoEnv);
const orgs = (...list: [string, string][]) => ({ organizations: list.map(([organization_id, name]) => ({ organization_id, name })) });
let n = 0;
const fresh = (dc = "in") => `${dc}:t${n++}`;
const route = (url: URL, more: unknown) => (url.pathname.endsWith("/organizations") ? orgs(["111", "Acme"]) : more);

test("not offered without the client id and secret", async () => {
  clearZohoEnv();
  expect((await own.readyApps()).has("zoho_books")).toBe(false);
  expect((await own.getApp("zoho_books"))?.signIn).toBeUndefined();
  zohoEnv();
  expect((await own.getApp("zoho_books"))?.signIn).toBe(true);
});

test("a sign-in round trip asks for the Books scope and can't be forged; the login stays in its data centre", async () => {
  const { url } = await own.startSignIn("zoho_books", "o", BACK);
  const page = new URL(url);
  expect(page.origin).toBe("https://accounts.zoho.com");
  expect(page.searchParams.get("scope")).toBe(SCOPES);
  expect(page.searchParams.get("redirect_uri")).toBe("https://api.test/oauth/zoho_books/callback");
  const state = page.searchParams.get("state")!;
  expect(own.readSignIn!("zoho_books", state)).not.toBeNull();
  expect(own.readSignIn!("zoho_books", `${state.split(".")[0]}.forged`)).toBeNull();
  const sent = fakeZoho((u) => (u.pathname.endsWith("/token") ? { access_token: "a1", refresh_token: "r1", expires_in: 3600 } : orgs(["111", "Acme Traders"])));
  const out = await own.finishSignIn!("zoho_books", "code1", BACK, { location: "eu", "accounts-server": "https://accounts.zoho.eu" });
  expect(sent[0]!.url).toBe("https://accounts.zoho.eu/oauth/v2/token");
  expect(out).toMatchObject({ secret: "eu:a1", label: "Acme Traders", refreshToken: "eu:r1" });
  expect(sent[1]!.url).toBe("https://www.zohoapis.eu/books/v3/organizations");
  expect(sent[1]!.headers.Authorization).toBe("Zoho-oauthtoken a1");
});

test("reads run unasked and writes ask", async () => {
  expect((await own.getAction("zoho_books.list_invoices"))?.readOnly).toBe(true);
  expect((await own.getAction("zoho_books.create_invoice"))?.readOnly).toBe(false);
  expect(zoho_books.actions.accept_estimate?.readOnly).toBe(false);
});

test("the wire format: one call's address, auth header and JSON body, and an EU or India login reaches its own host", async () => {
  let sent = fakeZoho((u) => route(u, { contact: { contact_id: "9" } }));
  await exec("zoho_books.create_contact", { contact_name: "Rao Traders" }, fresh("in"));
  const call = sent.find((s) => s.method === "POST")!;
  expect(call.url).toBe("https://www.zohoapis.in/books/v3/contacts");
  expect(call.query.get("organization_id")).toBe("111");
  expect(call.headers.Authorization).toMatch(/^Zoho-oauthtoken t\d+$/);
  expect(call.body).toEqual({ contact_name: "Rao Traders" });
  sent = fakeZoho((u) => route(u, { invoices: [] }));
  await exec("zoho_books.list_invoices", {}, fresh("eu"));
  expect(sent.at(-1)!.url).toBe("https://www.zohoapis.eu/books/v3/invoices");
});

test("the only organisation fills itself in; several ask which; a given one is used as is", async () => {
  let sent = fakeZoho((u) => route(u, { invoices: [] }));
  const key = fresh();
  await exec("zoho_books.list_invoices", {}, key);
  expect(sent.at(-1)!.query.get("organization_id")).toBe("111");
  await exec("zoho_books.list_invoices", {}, key);
  // the second call used the cached list
  expect(sent.filter((s) => s.path.endsWith("/organizations"))).toHaveLength(1);
  sent = fakeZoho((u) => (u.pathname.endsWith("/organizations") ? orgs(["1", "A Co"], ["2", "B Co"]) : { invoices: [] }));
  await expect(exec("zoho_books.list_invoices", {}, fresh())).rejects.toThrow(/1 \(A Co\), 2 \(B Co\)/);
  await exec("zoho_books.list_invoices", { organization_id: "2" }, fresh());
  expect(sent.at(-1)!.query.get("organization_id")).toBe("2");
});

test("a failure sent with a 200 is reported", async () => {
  fakeZoho((u) => route(u, { code: 1001, message: "Invoice number exists" }));
  await expect(exec("zoho_books.create_invoice", { customer_id: "1", line_items: [] }, fresh())).rejects.toThrow("Invoice number exists");
});

test("a dead token marks the connection expired; a missing permission doesn't", async () => {
  fakeZoho((u) => route(u, { $status: 401, body: { code: 57, message: "You are not authorized to perform this operation" } }));
  const err = await exec("zoho_books.list_invoices", {}, fresh()).catch((e) => e);
  expect(err).toBeInstanceOf(AppsError);
  expect(err.expired).toBe(true);
  fakeZoho((u) => route(u, { $status: 401, body: { code: "OAUTH_SCOPE_MISMATCH", message: "no scope" } }));
  expect((await exec("zoho_books.list_invoices", {}, fresh()).catch((e) => e)).expired).toBe(false);
  fakeZoho((u) => route(u, { code: "INVALID_TOKEN", message: "invalid oauth token" }));
  expect((await exec("zoho_books.list_invoices", {}, fresh()).catch((e) => e)).expired).toBe(true);
});

test("polled triggers: the first check only notes, later ones report new items and the filter applies", async () => {
  const key = fresh();
  let invoices = [{ invoice_id: "a", customer_id: "1", status: "sent" }];
  const sent = fakeZoho((u) => route(u, { invoices }));
  const run = (a: string, i: unknown) => exec(a, i, key);
  const first = await pollOnce("zoho_books.new_invoice", {}, null, run);
  expect(first.fresh).toHaveLength(0);
  expect(sent.at(-1)!.query.get("sort_column")).toBe("created_time");
  expect(sent.at(-1)!.query.get("sort_order")).toBe("D");
  invoices = [...invoices, { invoice_id: "b", customer_id: "2", status: "sent" }, { invoice_id: "c", customer_id: "1", status: "draft" }];
  const second = await pollOnce("zoho_books.new_invoice", { customer_id: "1" }, first.seen, run);
  expect(second.fresh).toEqual([{ invoice: { invoice_id: "c", customer_id: "1", status: "draft" } }]);
});

test("customer_changed carries the change in its id; payments and new customers come through", async () => {
  const key = fresh();
  let contacts = [{ contact_id: "1", contact_type: "customer", last_modified_time: "t1" }, { contact_id: "2", contact_type: "vendor", last_modified_time: "t1" }];
  fakeZoho((u) => route(u, u.pathname.endsWith("/contacts") ? { contacts } : { customerpayments: [{ payment_id: "p1", customer_id: "1" }] }));
  const run = (a: string, i: unknown) => exec(a, i, key);
  const first = await pollOnce("zoho_books.customer_changed", {}, null, run);
  contacts = [{ ...contacts[0]!, last_modified_time: "t2" }, contacts[1]!];
  const next = await pollOnce("zoho_books.customer_changed", {}, first.seen, run);
  expect((next.fresh[0] as any).customer.contact_id).toBe("1");
  expect(next.fresh).toHaveLength(1);
  const pay = await pollOnce("zoho_books.payment_received", {}, null, run);
  expect(pay.seen).toEqual(["p1"]);
});
