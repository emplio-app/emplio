import { afterEach, beforeEach, expect, setSystemTime, test } from "bun:test";
import { z } from "zod";
import { shiprocket as polls } from "../../polls/shiprocket";
import { AppFile, AppsError } from "../../types";
import { catalogActions } from "./catalog";
import { forgetTokens } from "./client";
import { shiprocket } from "./index";
import { orderActions } from "./orders";
import { shippingActions } from "./shipping";

type Call = { method: string; url: URL; headers: Record<string, string>; body: any };
const realFetch = globalThis.fetch;
beforeEach(() => forgetTokens());
afterEach(() => {
  globalThis.fetch = realFetch;
  setSystemTime();
});

const BASE = "https://apiv2.shiprocket.in/v1/external";
const KEY = "api@shop.com:pa:ss";
let logins = 0;
// answers logins with a new token each time, and everything else with reply(call)
function stub(reply: (c: Call) => { status?: number; body?: unknown } | undefined = () => ({ body: {} })) {
  const calls: Call[] = [];
  logins = 0;
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    const raw = init.body;
    const c = { method: init.method!, url: new URL(url), headers: init.headers as Record<string, string>, body: typeof raw === "string" ? JSON.parse(raw) : raw };
    calls.push(c);
    const r = c.url.pathname.endsWith("/auth/login") ? { body: { token: `t${++logins}`, first_name: "Asha", last_name: "Rao", email: "api@shop.com" } } : reply(c);
    if (!r) throw new Error(`unexpected ${c.method} ${c.url}`);
    return new Response(r.body === undefined ? "" : JSON.stringify(r.body), { status: r.status ?? 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return calls;
}
const run = (action: string, input: unknown, key = KEY) => {
  const a = shiprocket.actions[action];
  if (!a) throw new Error(`no action ${action}`);
  return a.run(a.input.parse(input), key);
};
const fails = (p: Promise<unknown>) =>
  p.then(
    () => {
      throw new Error("expected it to fail");
    },
    (e: AppsError) => e,
  );
const apiCalls = (calls: Call[]) => calls.filter((c) => !c.url.pathname.endsWith("/auth/login"));

test("no two groups name an action the same, and every input turns into a JSON schema", () => {
  const total = [orderActions, shippingActions, catalogActions].reduce((n, g) => n + Object.keys(g).length, 0);
  expect(Object.keys(shiprocket.actions)).toHaveLength(total);
  expect(total).toBeGreaterThanOrEqual(65);
  for (const [name, a] of Object.entries(shiprocket.actions)) {
    expect(name).toMatch(/^[a-z0-9_]+$/);
    expect(a.description.length).toBeGreaterThan(10);
    expect(() => z.toJSONSchema(a.input, { io: "input" })).not.toThrow();
  }
});

test("check logs in with the email and password (password may hold a colon) and names the account", async () => {
  const calls = stub();
  expect(await shiprocket.check(KEY)).toBe("Asha Rao");
  expect(calls[0]!.method).toBe("POST");
  expect(calls[0]!.url.href).toBe(`${BASE}/auth/login`);
  expect(calls[0]!.body).toEqual({ email: "api@shop.com", password: "pa:ss" });
});

test("a wrong password is refused as needing reconnecting; a key without a colon never reaches Shiprocket", async () => {
  const calls: Call[] = [];
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    calls.push({ method: init.method!, url: new URL(url), headers: {}, body: init.body });
    return new Response(JSON.stringify({ message: "Invalid email and password combination", status_code: 400 }), { status: 400 });
  }) as typeof fetch;
  const e = await fails(shiprocket.check(KEY));
  expect(e).toBeInstanceOf(AppsError);
  expect(e.expired).toBe(true);
  expect(e.message).not.toContain("pa:ss");
  const bad = await fails(shiprocket.check("no-colon"));
  expect(bad.expired).toBe(false);
  expect(calls).toHaveLength(1);
});

test("calls carry the Bearer token; the token is reused until 9 days pass", async () => {
  const calls = stub(() => ({ body: { data: [] } }));
  await run("list_orders", { per_page: 5, filter_by: "status", filter: "NEW" });
  await run("get_wallet_balance", {});
  expect(logins).toBe(1);
  const [list, wallet] = apiCalls(calls);
  expect(list!.url.href).toBe(`${BASE}/orders?per_page=5&filter_by=status&filter=NEW`);
  expect(list!.headers.Authorization).toBe("Bearer t1");
  expect(wallet!.url.href).toBe(`${BASE}/account/details/wallet-balance`);
  setSystemTime(new Date(Date.now() + 9 * 86_400_000 + 1000));
  await run("get_wallet_balance", {});
  expect(logins).toBe(2);
  expect(apiCalls(calls)[2]!.headers.Authorization).toBe("Bearer t2");
});

test("a token Shiprocket turns down is replaced by a new login and the call runs again once", async () => {
  const calls = stub((c) => (c.headers.Authorization === "Bearer t1" ? { status: 401, body: { message: "Token has expired" } } : { body: { ok: 1 } }));
  expect(await run("list_channels", {})).toEqual({ ok: 1 });
  expect(logins).toBe(2);
  expect(apiCalls(calls).map((c) => c.headers.Authorization)).toEqual(["Bearer t1", "Bearer t2"]);
  // still turned down after a fresh login: reconnect
  stub(() => ({ status: 401, body: { message: "Unauthenticated." } }));
  expect((await fails(run("list_channels", {}))).expired).toBe(true);
});

test("an order is created with exactly the fields given, rarer fields too", async () => {
  const calls = stub(() => ({ body: { order_id: 1, shipment_id: 2 } }));
  const order = {
    order_id: "1001",
    order_date: "2026-11-22",
    pickup_location: "Home",
    billing_customer_name: "Sarah",
    billing_address: "1 Main St",
    billing_city: "Pune",
    billing_pincode: "411001",
    billing_state: "Maharashtra",
    billing_country: "India",
    billing_phone: "9876543210",
    shipping_is_billing: true,
    order_items: [{ name: "Mug", sku: "MUG1", units: 2, selling_price: 250 }],
    payment_method: "Prepaid",
    sub_total: 500,
    length: 10,
    breadth: 10,
    height: 10,
    weight: 0.5,
    what3words_address: "a.b.c",
  };
  await run("create_order", order);
  const [c] = apiCalls(calls);
  expect(c!.method).toBe("POST");
  expect(c!.url.href).toBe(`${BASE}/orders/create/adhoc`);
  expect(c!.body).toEqual(order);
  expect(shiprocket.actions.create_order!.readOnly).toBe(false);
});

test("path parts fill in and reads run unasked; writes and money ask first", async () => {
  const calls = stub();
  await run("get_order", { order_id: 16167171 });
  await run("track_awb", { awb_code: "788830567028" });
  await run("act_on_ndr", { awb: "94711332", action: "re-attempt", comments: "customer home tomorrow" });
  await run("update_inventory", { product_id: 7, quantity: 3, action: "add" });
  const [order, track, ndr, inv] = apiCalls(calls);
  expect(order!.url.href).toBe(`${BASE}/orders/show/16167171`);
  expect(track!.url.href).toBe(`${BASE}/courier/track/awb/788830567028`);
  expect(ndr!.url.href).toBe(`${BASE}/ndr/94711332/action`);
  expect(ndr!.body).toEqual({ action: "re-attempt", comments: "customer home tomorrow" });
  expect(inv!.method).toBe("PUT");
  expect(inv!.body).toEqual({ quantity: 3, action: "add" });
  const reads = ["list_orders", "get_order", "track_awb", "track_awbs", "check_serviceability", "list_ndr", "print_invoice", "get_wallet_balance"];
  const writes = ["create_order", "assign_awb", "request_pickup", "cancel_orders", "cancel_shipments", "act_on_ndr", "ship_order", "update_inventory", "add_bank_details", "export_orders"];
  for (const a of reads) expect(shiprocket.actions[a]!.readOnly).toBe(true);
  for (const a of writes) expect(shiprocket.actions[a]!.readOnly).toBe(false);
});

test("blocked pincodes go to the serviceability host with the same token", async () => {
  const calls = stub();
  await run("update_blocked_pincodes", { action: "block", postcode: { delivery_blocked: ["110001"] } });
  const [c] = apiCalls(calls);
  expect(c!.url.href).toBe("https://serviceability.shiprocket.in/v1/external/blocked-pincodes/upload");
  expect(c!.headers.Authorization).toBe("Bearer t1");
  expect(c!.body).toEqual({ action: "block", postcode: { delivery_blocked: ["110001"] } });
});

test("a CSV import goes as a multipart file", async () => {
  const calls = stub(() => ({ body: { id: 99 } }));
  await run("import_orders", { file: new AppFile("orders.csv", "text/csv", new TextEncoder().encode("a,b")) });
  const [c] = apiCalls(calls);
  expect(c!.url.href).toBe(`${BASE}/orders/import`);
  expect(((c!.body as FormData).get("file") as File).name).toBe("orders.csv");
  expect((await fails(run("import_orders", { file: "/work/x.csv" }))).message).toContain("file");
});

test("failures Shiprocket answers with a 200 come back as errors, field errors with their fields", async () => {
  stub(() => ({ body: { awb_assign_status: 0, response: { data: { awb_assign_error: "Wallet balance too low" } } } }));
  expect((await fails(run("assign_awb", { shipment_id: 1 }))).message).toContain("Wallet balance too low");
  stub(() => ({ status: 422, body: { message: "Oops! Invalid Data.", errors: { shipment_id: ["The shipment id field is required."] }, status_code: 422 } }));
  const e = await fails(run("generate_label", { shipment_id: [1] }));
  expect(e.expired).toBe(false);
  expect(e.message).toContain("shipment_id: The shipment id field is required.");
});

test("polled triggers: new orders by id, status changes by id and status, filters applied", async () => {
  const orders = [
    { id: 1, status: "DELIVERED", payment_method: "cod", pickup_location: "Home" },
    { id: 2, status: "RTO INITIATED", payment_method: "prepaid", pickup_location: "Shop" },
    { id: 3, status: "CANCELED", payment_method: "prepaid", pickup_location: "Home" },
  ];
  const asked: [string, any][] = [];
  const runAction = async (action: string, input: any) => {
    asked.push([action, input]);
    if (action === "shiprocket.list_ndr") return { data: [{ awb_code: "A1", attempts: 2 }] };
    return { data: orders };
  };
  expect((await polls.new_order!.poll({ payment_method: "cod" }, runAction)).map((e) => e.id)).toEqual(["1"]);
  expect((await polls.order_status_changed!.poll({ statuses: ["delivered", "canceled"] }, runAction)).map((e) => e.id)).toEqual(["1:DELIVERED", "3:CANCELED"]);
  expect((await polls.shipment_delivered!.poll({}, runAction)).map((e) => e.id)).toEqual(["1:DELIVERED"]);
  expect((await polls.shipment_rto!.poll({}, runAction)).map((e) => e.id)).toEqual(["2:RTO INITIATED"]);
  expect((await polls.order_cancelled!.poll({ pickup_location: "Shop" }, runAction)).map((e) => e.id)).toEqual([]);
  expect((await polls.new_ndr!.poll({}, runAction)).map((e) => e.id)).toEqual(["A1:2"]);
  const changed = asked.find(([a, i]) => a === "shiprocket.list_orders" && i.updated_from)![1];
  expect(changed.updated_from).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  // every action a poll calls exists
  for (const [a] of asked) expect(shiprocket.actions[a.split(".")[1]!]).toBeDefined();
});
