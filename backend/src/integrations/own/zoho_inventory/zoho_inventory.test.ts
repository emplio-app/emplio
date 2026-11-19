import { afterEach, beforeEach, expect, test } from "bun:test";
import { pollOnce } from "../../polls";
import { AppsError } from "../../types";
import { own } from "../index";
import { BACK, clearZohoEnv, fakeZoho, zohoEnv } from "../zoho-fake";
import { SCOPES, zoho_inventory } from "./index";

const exec = (action: string, input: unknown, secret: string) => own.run(action, input, { externalId: "c", secret }, "o") as Promise<any>;
beforeEach(zohoEnv);
afterEach(clearZohoEnv);
const orgs = (...list: [string, string][]) => ({ organizations: list.map(([organization_id, name]) => ({ organization_id, name })) });
let n = 0;
// a prefix of its own: the organisation list is cached per login across test files
const fresh = (dc = "in") => `${dc}:inv${n++}`;
const route = (url: URL, more: unknown) => (url.pathname.endsWith("/organizations") ? orgs(["111", "Acme"]) : more);

test("not offered without the client id and secret", async () => {
  clearZohoEnv();
  expect((await own.readyApps()).has("zoho_inventory")).toBe(false);
  expect((await own.getApp("zoho_inventory"))?.signIn).toBeUndefined();
  zohoEnv();
  expect((await own.getApp("zoho_inventory"))?.signIn).toBe(true);
});

test("a sign-in round trip asks for the Inventory scope and can't be forged; the login stays in its data centre", async () => {
  const { url } = await own.startSignIn("zoho_inventory", "o", BACK);
  const page = new URL(url);
  expect(page.origin).toBe("https://accounts.zoho.com");
  expect(page.searchParams.get("scope")).toBe(SCOPES);
  expect(SCOPES).toBe("ZohoInventory.FullAccess.all");
  expect(page.searchParams.get("redirect_uri")).toBe("https://api.test/oauth/zoho_inventory/callback");
  const state = page.searchParams.get("state")!;
  expect(own.readSignIn!("zoho_inventory", state)).not.toBeNull();
  expect(own.readSignIn!("zoho_inventory", `${state.split(".")[0]}.forged`)).toBeNull();
  const sent = fakeZoho((u) => (u.pathname.endsWith("/token") ? { access_token: "a1", refresh_token: "r1", expires_in: 3600 } : orgs(["111", "Acme Traders"])));
  const out = await own.finishSignIn!("zoho_inventory", "code1", BACK, { location: "eu", "accounts-server": "https://accounts.zoho.eu" });
  expect(sent[0]!.url).toBe("https://accounts.zoho.eu/oauth/v2/token");
  expect(out).toMatchObject({ secret: "eu:a1", label: "Acme Traders", refreshToken: "eu:r1" });
  expect(sent[1]!.url).toBe("https://www.zohoapis.eu/inventory/v1/organizations");
});

test("reads run unasked and writes ask; Composio's names are kept", async () => {
  expect((await own.getAction("zoho_inventory.list_items"))?.readOnly).toBe(true);
  expect((await own.getAction("zoho_inventory.get_sales_order"))?.readOnly).toBe(true);
  for (const w of ["create_item", "update_item", "create_sales_order", "create_purchase_order", "confirm_sales_order", "deactivate_item"]) expect(zoho_inventory.actions[w]?.readOnly).toBe(false);
  expect(zoho_inventory.actions.get_options?.readOnly).toBe(true);
});

test("the wire format: address, organisation, auth header and JSON body; an India login reaches its own host", async () => {
  let sent = fakeZoho((u) => route(u, { salesorder: { salesorder_id: "9" } }));
  await exec("zoho_inventory.create_sales_order", { customer_id: "5", line_items: [{ item_id: "1", quantity: 2 }] }, fresh("in"));
  const call = sent.find((s) => s.method === "POST")!;
  expect(call.url).toBe("https://www.zohoapis.in/inventory/v1/salesorders");
  expect(call.query.get("organization_id")).toBe("111");
  expect(call.headers.Authorization).toMatch(/^Zoho-oauthtoken inv\d+$/);
  expect(call.body).toMatchObject({ customer_id: "5", line_items: [{ item_id: "1", quantity: 2 }] });
  sent = fakeZoho((u) => route(u, { code: 0 }));
  await exec("zoho_inventory.mark_tag_option_active", { tag_id: "7", option_id: "8" }, fresh("eu"));
  expect(sent.at(-1)!.url).toBe("https://www.zohoapis.eu/inventory/v1/reportingtags/7/option/8/active");
});

test("several organisations ask which; a given one is used as is", async () => {
  const sent = fakeZoho((u) => (u.pathname.endsWith("/organizations") ? orgs(["1", "A Co"], ["2", "B Co"]) : { items: [] }));
  await expect(exec("zoho_inventory.list_items", {}, fresh())).rejects.toThrow(/1 \(A Co\), 2 \(B Co\)/);
  await exec("zoho_inventory.list_items", { organization_id: "2" }, fresh());
  expect(sent.at(-1)!.query.get("organization_id")).toBe("2");
});

test("a failure sent with a 200 is reported; a dead token marks the connection expired", async () => {
  fakeZoho((u) => route(u, { code: 1001, message: "Item name exists" }));
  await expect(exec("zoho_inventory.create_item", { name: "Bolt" }, fresh())).rejects.toThrow("Item name exists");
  fakeZoho((u) => route(u, { $status: 401, body: { code: 57, message: "You are not authorized to perform this operation" } }));
  const err = await exec("zoho_inventory.list_items", {}, fresh()).catch((e) => e);
  expect(err).toBeInstanceOf(AppsError);
  expect(err.expired).toBe(true);
});

test("low stock: asks Zoho for low items, fires on first going low and on each further change", async () => {
  const key = fresh();
  let items = [{ item_id: "a", stock_on_hand: 3 }];
  const sent = fakeZoho((u) => route(u, { items }));
  const run = (a: string, i: unknown) => exec(a, i, key);
  const first = await pollOnce("zoho_inventory.item_low_stock", { warehouse_id: "w1" }, null, run);
  expect(first.fresh).toHaveLength(0);
  expect(sent.at(-1)!.query.get("filter_by")).toBe("Status.Lowstock");
  expect(sent.at(-1)!.query.get("warehouse_id")).toBe("w1");
  items = [{ item_id: "a", stock_on_hand: 3 }, { item_id: "b", stock_on_hand: 1 }];
  const second = await pollOnce("zoho_inventory.item_low_stock", {}, first.seen, run);
  expect(second.fresh).toEqual([{ item: { item_id: "b", stock_on_hand: 1 } }]);
  items = [{ item_id: "a", stock_on_hand: 2 }, { item_id: "b", stock_on_hand: 1 }];
  expect((await pollOnce("zoho_inventory.item_low_stock", {}, second.seen, run)).fresh).toHaveLength(1);
});

test("orders: new ones and changes, with filters; each trigger reads only its own list", async () => {
  const key = fresh();
  let salesorders = [{ salesorder_id: "1", customer_id: "c1", status: "draft", last_modified_time: "t1" }];
  const sent = fakeZoho((u) => route(u, u.pathname.endsWith("/salesorders") ? { salesorders } : { purchaseorders: [{ purchaseorder_id: "p1", vendor_id: "v1" }] }));
  const run = (a: string, i: unknown) => exec(a, i, key);
  const first = await pollOnce("zoho_inventory.new_sales_order", {}, null, run);
  const changed = await pollOnce("zoho_inventory.sales_order_changed", {}, null, run);
  expect(changed.seen).toEqual(["1:t1"]);
  salesorders = [{ ...salesorders[0]!, status: "confirmed", last_modified_time: "t2" }, { salesorder_id: "2", customer_id: "c2", status: "draft", last_modified_time: "t2" }];
  expect((await pollOnce("zoho_inventory.new_sales_order", { customer_id: "c1" }, first.seen, run)).fresh).toHaveLength(0);
  expect((await pollOnce("zoho_inventory.new_sales_order", { customer_id: "c2" }, first.seen, run)).fresh).toHaveLength(1);
  expect((await pollOnce("zoho_inventory.sales_order_changed", { status: "confirmed" }, changed.seen, run)).fresh).toEqual([{ sales_order: salesorders[0] }]);
  const po = await pollOnce("zoho_inventory.new_purchase_order", {}, null, run);
  expect(po.seen).toEqual(["p1"]);
  expect(sent.at(-1)!.path).toEndWith("/purchaseorders");
});

test("the accounting triggers carried over from Books read Inventory's own lists", async () => {
  const key = fresh();
  const sent = fakeZoho((u) => route(u, { invoices: [{ invoice_id: "i1" }], customerpayments: [{ payment_id: "p1" }] }));
  const run = (a: string, i: unknown) => exec(a, i, key);
  expect((await pollOnce("zoho_inventory.new_invoice", {}, null, run)).seen).toEqual(["i1"]);
  expect(sent.at(-1)!.url).toBe("https://www.zohoapis.in/inventory/v1/invoices");
  expect((await pollOnce("zoho_inventory.payment_received", {}, null, run)).seen).toEqual(["p1"]);
});
