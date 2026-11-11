import { afterEach, beforeAll, expect, spyOn, test } from "bun:test";
import { createHmac, randomBytes } from "node:crypto";
import Fastify from "fastify";
import { automationRoutes } from "../../../automations";
import { db } from "../../../db";
import { encrypt } from "../../../secrets";
import { pollOnce } from "../../polls";
import { AppFile, AppsError } from "../../types";
import type { Delivery } from "../index";
import { own } from "../index";
import { swipe } from "./index";
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

// records every request and answers with reply(call); anything unanswered is a test bug, not a trip to Swipe
function stub(reply: (c: Call) => Response | undefined) {
  const calls: Call[] = [];
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    const raw = init.body;
    const c = { method: init.method!, url: new URL(url), headers: init.headers as Record<string, string>, body: raw instanceof FormData ? raw : raw ? JSON.parse(String(raw)) : undefined };
    calls.push(c);
    const r = reply(c);
    if (!r) throw new Error(`unexpected ${c.method} ${c.url}`);
    return r;
  }) as typeof fetch;
  return calls;
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const run = (action: string, input: unknown) => own.run(`swipe.${action}`, input, { externalId: "", secret: "key" }, "owner");
const fails = (p: Promise<unknown>) =>
  p.then(
    () => {
      throw new Error("expected it to fail");
    },
    (e: AppsError) => e,
  );

test("a lookup goes to the v2 path with the key as a bearer", async () => {
  const calls = stub(() => json({ success: true, data: { legal_name: "Acme" } }));
  await run("lookup_gstin", { gstin: "29ABCDE1234F1Z5" });
  expect(calls[0]!.method).toBe("GET");
  expect(calls[0]!.url.href).toBe("https://app.getswipe.in/api/partner/v2/utils/gstin/29ABCDE1234F1Z5");
  expect(calls[0]!.headers.Authorization).toBe("Bearer key");
});

test("products are created through the v1 JSON call", async () => {
  const calls = stub(() => json({ success: true, data: {} }));
  await run("create_product", { id: "P1", name: "Tea", price_with_tax: 100, unit_price: 100, tax_rate: 5, product_type: "Product", unit: "KG", hsn_code: "0902", quantity: 0, item_type: "Product" });
  expect(calls[0]!.method).toBe("POST");
  expect(calls[0]!.url.pathname).toBe("/api/partner/v1/product");
  expect(calls[0]!.body.name).toBe("Tea");
});

test("a 200 with success false is a failure, with Swipe's code", async () => {
  stub(() => json({ success: false, error_code: "INVALID_HASH_ID", message: "Invalid hash id" }));
  const e = await fails(run("get_document", { doc_hash_id: "x" }));
  expect(e.message).toBe("Swipe: INVALID_HASH_ID: Invalid hash id");
});

test("a 401 FORBIDDEN is a plan limit, not a dead key; a plain 401 is", async () => {
  stub(() => json({ success: false, error_code: "FORBIDDEN", message: "Not allowed on your plan" }, 401));
  const plan = await fails(run("list_warehouses", {}));
  expect(plan.message).toContain("Not allowed on your plan");
  stub(() => json({ success: false, error_code: "UNAUTHORIZED", message: "bad key" }, 401));
  const dead = await fails(run("list_warehouses", {}));
  expect(dead.message).toContain("rejected the token");
});

test("an expense update puts the expense in the query (objects as JSON) and the receipts in the body", async () => {
  const calls = stub(() => json({ success: true, data: {} }));
  const receipt = new AppFile("r.pdf", "application/pdf", new Uint8Array([1, 2, 3]));
  const items = [{ category: "Rent", net_amount: 100 }];
  await run("update_expense", { hash_id: "h1", amount: 100, document_date: "01-10-2026", items, party: { name: "Landlord" }, payment_details: { amount: 100 }, attachments: [receipt] });
  const q = calls[0]!.url.searchParams;
  expect(calls[0]!.url.pathname).toBe("/api/partner/v2/expense/h1");
  expect(q.get("items")).toBe(JSON.stringify(items));
  expect(q.get("party")).toBe('{"name":"Landlord"}');
  expect(q.get("amount")).toBe("100");
  expect(q.has("attachments")).toBe(false);
  expect((calls[0]!.body as FormData).getAll("attachments")).toHaveLength(1);
});

test("an expense update without receipts sends no body", async () => {
  const calls = stub(() => json({ success: true, data: {} }));
  await run("update_expense", { hash_id: "h1", amount: 1, document_date: "01-10-2026", items: [{}], party: {}, payment_details: {} });
  expect(calls[0]!.body).toBeUndefined();
});

// --- triggers ---

const KEY = "swipe-key";
const document = (message: string, document_type = "invoice") => ({
  event_id: `e-${message}-${document_type}`,
  event_type: "document",
  data: { document_type, serial_number: "INV-12", hash_id: "PUlgCNPb", message, timestamp: "2026-11-11 09:19:44.000000" },
});
const inventory = (movement: string) => ({
  event_id: `e-stock-${movement}`,
  event_type: "inventory",
  data: { swipe_product_id: 39346, partner_product_id: "TEA-1", product_name: "Tea", qty: 2, movement, timestamp: "2026-11-11 09:19:45.000000" },
});
const sign = (body: string, key = KEY) => createHmac("sha256", key).update(body).digest("hex");
const delivery = (sent: unknown, key = KEY): Delivery => {
  const body = JSON.stringify(sent);
  return { body, headers: { "x-signature": sign(body, key) }, connection: "c1", rest: "" };
};

test("each Swipe event starts only the triggers it means", () => {
  expect(triggersFor("document", document("Document Created").data)).toEqual(["new_document", "document_event"]);
  expect(triggersFor("document", document("Document Updated").data)).toEqual(["document_updated", "document_event"]);
  expect(triggersFor("document", document("Document Cancelled").data)).toEqual(["document_cancelled", "document_event"]);
  expect(triggersFor("inventory", inventory("in").data)).toEqual(["stock_in", "stock_moved"]);
  expect(triggersFor("inventory", inventory("out").data)).toEqual(["stock_out", "stock_moved"]);
  expect(triggersFor("inventory", { movement: "" })).toEqual(["stock_moved"]);
  expect(triggersFor("ping", {})).toEqual([]);
});

test("an automation's settings narrow what runs it", () => {
  const doc = { event_type: "document", ...document("Document Created", "purchase").data };
  expect(wanted({}, doc)).toBe(true);
  expect(wanted({ document_type: "purchase" }, doc)).toBe(true);
  expect(wanted({ document_type: "invoice" }, doc)).toBe(false);
  const stock = { event_type: "inventory", ...inventory("out").data };
  expect(wanted({ movement: "out" }, stock)).toBe(true);
  expect(wanted({ movement: "in" }, stock)).toBe(false);
  expect(wanted({ product_id: "TEA-1" }, stock)).toBe(true);
  expect(wanted({ product_id: 39346 }, stock)).toBe(true);
  expect(wanted({ product_id: "COFFEE-1" }, stock)).toBe(false);
});

test("a signed delivery becomes one event, under Swipe's own event id; a forged one is refused", async () => {
  const got = await swipe.push!.receive!(delivery(document("Document Created")), KEY);
  expect(await got!.events()).toEqual([
    {
      id: "e-Document Created-invoice",
      triggers: ["new_document", "document_event"],
      data: { event_type: "document", document_type: "invoice", serial_number: "INV-12", hash_id: "PUlgCNPb", message: "Document Created", timestamp: "2026-11-11 09:19:44.000000" },
    },
  ]);
  expect(await swipe.push!.receive!(delivery(document("Document Created"), "someone-else"), KEY)).toBeNull();
  expect(await swipe.push!.receive!({ ...delivery(document("Document Created")), headers: {} }, KEY)).toBeNull();
});

test("saving an automation only files the events: Swipe's webhook is set up by hand", async () => {
  expect(await own.startPush!("swipe.new_document", { externalId: "c1", secret: KEY }, {})).toBe(watchId("c1"));
  expect(swipe.push!.stop).toBeUndefined();
  const t = await own.getTrigger!("swipe.stock_moved");
  expect(t?.input.map((i) => i.name)).toEqual(["product_id", "movement"]);
  expect(t?.description).toContain("get_webhook_setup");
});

test("get_webhook_setup says what to paste, for this connection, and no secret of ours", async () => {
  const setup = (await own.run("swipe.get_webhook_setup", {}, { externalId: "c1", secret: KEY }, "owner")) as Record<string, any>;
  expect(setup.webhook_url).toBe("https://api.test/webhooks/app/swipe/c1");
  expect(setup.events_to_tick).toEqual(["document", "inventory"]);
  expect(setup.secret).toContain("Swipe API key");
  expect(JSON.stringify(setup)).not.toContain(KEY);
});

test("the webhook route takes only Swipe's signature", async () => {
  const find = spyOn(db.query.connections, "findFirst");
  const app = Fastify();
  await automationRoutes(app);
  // an event type Swipe doesn't have starts no trigger, so a 200 needs no database
  const body = JSON.stringify({ event_id: "e1", event_type: "ping", data: {} });
  const post = (signature: string, url = "/webhooks/app/swipe/c1") =>
    app.inject({ method: "POST", url, headers: { "content-type": "application/json", "x-signature": signature }, payload: body });
  try {
    find.mockResolvedValue(undefined as never);
    expect((await post(sign(body))).statusCode).toBe(401);

    find.mockResolvedValue({ id: "row", app: "swipe", secret: encrypt(KEY), refreshToken: null, expiresAt: null } as never);
    expect((await post(sign(body, "someone-else"))).statusCode).toBe(401);
    expect((await post("")).statusCode).toBe(401);
    expect((await post(sign(body))).statusCode).toBe(200);
  } finally {
    find.mockRestore();
    await app.close();
  }
});

// --- what Swipe can't push is checked instead ---

const list = (key: string, rows: unknown[], total_records = rows.length) => async () => ({ success: true, data: { [key]: rows, total_records } });
const invoice = (hash_id: string, extra: Record<string, unknown> = {}) => ({ hash_id, serial_number: `INV-${hash_id}`, payment_status: "pending", total_amount: 118, ...extra });
const dmy = (daysFromNow: number) => {
  const d = new Date(Date.now() + daysFromNow * 86_400_000);
  return `${String(d.getUTCDate()).padStart(2, "0")}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${d.getUTCFullYear()}`;
};

test("a new invoice is noticed once, by its hash id, and the date range is day-first", async () => {
  const asked: Record<string, any>[] = [];
  const run = (_action: string, input: unknown) => {
    asked.push(input as Record<string, any>);
    return list("transactions", [invoice("a")])();
  };
  const first = await pollOnce("swipe.new_invoice", {}, null, run);
  expect(first.fresh).toEqual([]);
  expect(asked[0]!.document_type).toBe("invoice");
  expect(asked[0]!.start_date).toMatch(/^\d{2}-\d{2}-\d{4}$/);
  expect(asked[0]!.end_date).toBe(dmy(1));
  const next = await pollOnce("swipe.new_invoice", {}, first.seen, () => list("transactions", [invoice("b"), invoice("a")])());
  expect(next.fresh).toEqual([{ document: invoice("b") }]);
  const again = await pollOnce("swipe.new_invoice", {}, next.seen, () => list("transactions", [invoice("b"), invoice("a")])());
  expect(again.fresh).toEqual([]);
});

test("only an invoice past its due date counts as overdue", async () => {
  const rows = [invoice("late", { due_date: dmy(-3) }), invoice("soon", { due_date: dmy(3) }), invoice("nodate")];
  const first = await pollOnce("swipe.invoice_overdue", {}, null, list("transactions", rows));
  expect(first.seen).toEqual(["late:overdue"]);
  const next = await pollOnce("swipe.invoice_overdue", {}, [], list("transactions", rows));
  expect(next.fresh).toEqual([{ document: rows[0] }]);
});

test("a payment with no id of its own is remembered by what it is", async () => {
  const payment = (total_amount: number, amount_remaining: number) => ({ customer: { customer_id: "CUST-1" }, payment_date: "11-11-2026", payment_mode: "UPI", total_amount, amount_remaining });
  const first = await pollOnce("swipe.payment_received", {}, null, list("transactions", [payment(100, 900)]));
  expect(first.seen).toEqual(["CUST-1|11-11-2026|100|UPI|900"]);
  const next = await pollOnce("swipe.payment_received", {}, first.seen, list("transactions", [payment(100, 800), payment(100, 900)]));
  expect(next.fresh).toEqual([{ payment: payment(100, 800) }]);
});

test("low stock waits for the level you set, and a further drop is a new event", async () => {
  const item = (quantity: number) => ({ id: "TEA-1", name: "Tea", quantity });
  const asked: Record<string, any>[] = [];
  const run = (_a: string, input: unknown) => (asked.push(input as Record<string, any>), list("items", [item(4), item(40)])());
  const first = await pollOnce("swipe.low_stock", {}, null, run);
  expect(asked[0]!.sort_by).toBe("quantity");
  expect(first.seen).toEqual(["TEA-1:4"]);
  const same = await pollOnce("swipe.low_stock", {}, first.seen, () => list("items", [item(4)])());
  expect(same.fresh).toEqual([]);
  const lower = await pollOnce("swipe.low_stock", {}, first.seen, () => list("items", [item(2)])());
  expect(lower.fresh).toEqual([{ item: item(2) }]);
  const higher = await pollOnce("swipe.low_stock", { threshold: 50 }, [], () => list("items", [item(40)])());
  expect(higher.fresh).toEqual([{ item: item(40) }]);
});

test("new customers are looked for at both ends of Swipe's list", async () => {
  const pages: number[] = [];
  const one = (n: number) => ({ customer_id: `CUST-${n}`, swipe_id: String(n), name: `Customer ${n}` });
  const run = (_a: string, input: any) => (pages.push(input.page), list("customers", [one(input.page)], 250)());
  const first = await pollOnce("swipe.new_customer", {}, null, run);
  expect(pages).toEqual([1, 3]);
  expect(first.seen.sort()).toEqual(["1", "3"]);
  pages.length = 0;
  await pollOnce("swipe.new_customer", {}, first.seen, (_a, input: any) => (pages.push((input as any).page), list("customers", [one(1)], 10)()));
  expect(pages).toEqual([1]);
});
