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
const fresh = (dc = "in") => `${dc}:i${n++}`;
const route = (url: URL, more: unknown) => (url.pathname.endsWith("/organizations") ? orgs(["111", "Acme"]) : more);

test("not offered without the client id and secret", async () => {
  clearZohoEnv();
  expect((await own.readyApps()).has("zoho_invoice")).toBe(false);
});

test("a sign-in round trip asks for the Invoice scope and can't be forged", async () => {
  const { url } = await own.startSignIn("zoho_invoice", "o", BACK);
  const page = new URL(url);
  expect(page.searchParams.get("scope")).toBe(SCOPES);
  expect(page.searchParams.get("redirect_uri")).toBe("https://api.test/oauth/zoho_invoice/callback");
  expect(own.readSignIn!("zoho_invoice", `${page.searchParams.get("state")!.split(".")[0]}.forged`)).toBeNull();
  const sent = fakeZoho((u) => (u.pathname.endsWith("/token") ? { access_token: "a1", refresh_token: "r1", expires_in: 3600 } : orgs(["111", "Acme"])));
  expect(await own.finishSignIn!("zoho_invoice", "c", BACK, { location: "in" })).toMatchObject({ secret: "in:a1", label: "Acme", refreshToken: "in:r1" });
  expect(sent[0]!.url).toBe("https://accounts.zoho.in/oauth/v2/token");
});

test("reads run unasked and writes ask", async () => {
  expect((await own.getAction("zoho_invoice.list_invoices"))?.readOnly).toBe(true);
  expect((await own.getAction("zoho_invoice.create_invoice"))?.readOnly).toBe(false);
});

test("the organisation goes in its header, filled in when there's just one, and an EU or India login reaches its own host", async () => {
  let sent = fakeZoho((u) => route(u, { invoices: [] }));
  await exec("zoho_invoice.list_invoices", {}, fresh("in"));
  const call = sent.at(-1)!;
  expect(call.url).toBe("https://www.zohoapis.in/invoice/v3/invoices");
  expect(call.headers["X-com-zoho-invoice-organizationid"]).toBe("111");
  expect(call.query.get("organization_id")).toBeNull();
  sent = fakeZoho((u) => route(u, { invoices: [] }));
  await exec("zoho_invoice.list_invoices", {}, fresh("eu"));
  expect(sent.at(-1)!.url).toBe("https://www.zohoapis.eu/invoice/v3/invoices");
});

test("several organisations ask which, and a given one is used", async () => {
  const sent = fakeZoho((u) => (u.pathname.endsWith("/organizations") ? orgs(["1", "A Co"], ["2", "B Co"]) : { invoices: [] }));
  await expect(exec("zoho_invoice.list_invoices", {}, fresh())).rejects.toThrow(/1 \(A Co\), 2 \(B Co\)/);
  await exec("zoho_invoice.list_invoices", { organization_id: "2" }, fresh());
  expect(sent.at(-1)!.headers["X-com-zoho-invoice-organizationid"]).toBe("2");
});

test("a failure with a 200, and a dead token", async () => {
  fakeZoho((u) => route(u, { code: 4, message: "Invalid value" }));
  await expect(exec("zoho_invoice.list_invoices", {}, fresh())).rejects.toThrow("Invalid value");
  fakeZoho((u) => route(u, { $status: 401, body: { code: 57, message: "not authorized" } }));
  expect((await exec("zoho_invoice.list_invoices", {}, fresh()).catch((e) => e)).expired).toBe(true);
});

test("polled triggers: first check notes, later checks report", async () => {
  const key = fresh();
  let invoices = [{ invoice_id: "a", customer_id: "1" }];
  fakeZoho((u) => route(u, { invoices, contacts: [], customerpayments: [] }));
  const run = (a: string, i: unknown) => exec(a, i, key);
  const first = await pollOnce("zoho_invoice.new_invoice", {}, null, run);
  expect(first.fresh).toHaveLength(0);
  invoices = [...invoices, { invoice_id: "b", customer_id: "2" }];
  const next = await pollOnce("zoho_invoice.new_invoice", {}, first.seen, run);
  expect((next.fresh[0] as any).invoice.invoice_id).toBe("b");
  expect(next.fresh).toHaveLength(1);
});
