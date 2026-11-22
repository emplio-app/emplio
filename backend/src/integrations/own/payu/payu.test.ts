import { afterEach, beforeAll, expect, spyOn, test } from "bun:test";
import { createHash, createHmac, randomBytes } from "node:crypto";
import Fastify from "fastify";
import { automationRoutes } from "../../../automations";
import { db } from "../../../db";
import { encrypt } from "../../../secrets";
import { pollTrigger } from "../../polls";
import type { AppsError } from "../../types";
import type { Delivery } from "../index";
import { own } from "../index";
import { payu } from "./index";
import { hookToken, paymentHashOk, receive, triggersFor, wanted, watchId } from "./triggers";

const KEY = "aBcD12";
const SALT = "s4ltS4lt";
const LIVE = `${KEY}:${SALT}`;
const sha = (s: string) => createHash("sha512").update(s).digest("hex");

beforeAll(() => {
  process.env.ENCRYPTION_KEY = randomBytes(32).toString("base64");
  process.env.WEBHOOK_URL = "https://api.test";
});

type Call = { url: URL; headers: Record<string, string>; form: URLSearchParams };
const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});
function stub(reply: (c: Call) => Response) {
  const calls: Call[] = [];
  globalThis.fetch = (async (url: string, init: RequestInit = {}) => {
    const c = { url: new URL(url), headers: (init.headers ?? {}) as Record<string, string>, form: new URLSearchParams(String(init.body ?? "")) };
    calls.push(c);
    return reply(c);
  }) as typeof fetch;
  return calls;
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const run = (action: string, input: unknown, secret = LIVE, connection = "") => own.run(`payu.${action}`, input, { externalId: connection, secret }, "owner");
const fails = (p: Promise<unknown>) =>
  p.then(
    () => {
      throw new Error("expected it to fail");
    },
    (e: AppsError) => e,
  );

// --- signing in ---

test("a working key and salt are accepted and labelled live or test", async () => {
  const calls = stub(() => json({ status: 0, msg: "0 out of 1 Transactions Fetched Successfully", transaction_details: {} }));
  expect(await payu.check(LIVE)).toBe(`Live · ${KEY}`);
  expect(calls[0]!.url.href).toBe("https://info.payu.in/merchant/postservice.php?form=2");
  expect(await payu.check(`${LIVE}:test`)).toBe(`Test mode · ${KEY}`);
  expect(calls[1]!.url.host).toBe("test.payu.in");
});

test("a wrong salt is refused and asks for reconnecting; a malformed key says how to paste it", async () => {
  stub(() => json({ status: 0, msg: "Invalid Hash." }));
  const e = await fails(payu.check(LIVE));
  expect(e.message).toContain("didn't accept the merchant key and salt");
  expect(e.expired).toBe(true);
  stub(() => new Response("Sorry, Some Problem Occurred.", { headers: { "content-type": "text/html" } }));
  expect((await fails(payu.check(LIVE))).expired).toBe(true);
  expect((await fails(payu.check("justakey"))).message).toContain("merchant key and the salt");
  expect((await fails(payu.check(`${LIVE}:prod`))).message).toContain("merchant key and the salt");
});

// --- actions ---

test("a command is signed sha512(key|command|var1|salt) and sends its vars in order", async () => {
  const calls = stub(() => json({ status: 1 }));
  await run("refund_payment", { payu_id: "4039937", reference: "RF-1", amount: "100.50" });
  const f = calls[0]!.form;
  expect(f.get("key")).toBe(KEY);
  expect(f.get("command")).toBe("cancel_refund_transaction");
  expect([f.get("var1"), f.get("var2"), f.get("var3")]).toEqual(["4039937", "RF-1", "100.50"]);
  expect(f.has("var4")).toBe(false);
  expect(f.get("hash")).toBe(sha(`${KEY}|cancel_refund_transaction|4039937|${SALT}`));
});

test("several order ids go pipe separated; JSON commands send the input as var1", async () => {
  const calls = stub(() => json({ status: 1 }));
  await run("verify_payment", { txnids: ["A1", "A2"] });
  expect(calls[0]!.form.get("var1")).toBe("A1|A2");
  await run("create_payment_link", { txnid: "INV-1", amount: "1500", productinfo: "Fee", firstname: "Asha", email: "a@b.in", phone: "9876543210", send_sms: "1" });
  const v = calls[1]!.form;
  expect(v.get("command")).toBe("create_invoice");
  expect(JSON.parse(v.get("var1")!)).toMatchObject({ txnid: "INV-1", amount: "1500", send_sms: "1" });
  expect(v.get("hash")).toBe(sha(`${KEY}|create_invoice|${v.get("var1")}|${SALT}`));
});

test("a gap in the middle of the vars is sent empty; saved cards carry key:user", async () => {
  const calls = stub(() => json({ status: 1 }));
  await run("refund_payment", { payu_id: "1", reference: "R", amount: "1", callback_url: "https://x.in/cb" });
  expect([calls[0]!.form.get("var4"), calls[0]!.form.get("var5")]).toEqual(["", "https://x.in/cb"]);
  await run("list_saved_cards", { user_id: "cust7" });
  expect(calls[1]!.form.get("var1")).toBe(`${KEY}:cust7`);
});

test("settlement reports are signed GETs with the MID", async () => {
  const calls = stub(() => json({ code: "2000", result: {} }));
  await run("list_settlements", { mid: "875546", from: "2026-11-01", to: "2026-11-03" });
  const c = calls[0]!;
  expect(c.url.href).toBe("https://info.payu.in/settlement/range?dateFrom=2026-11-01&dateTo=2026-11-03");
  expect(c.headers.mid).toBe("875546");
  expect(c.headers.Authorization).toBe(`hmac username="${KEY}", algorithm="sha512", headers="date", signature="${sha(`|${c.headers.Date}|${SALT}`)}"`);
  await run("get_upcoming_settlements", { mid: "1" }, `${LIVE}:test`);
  expect(calls[1]!.url.host).toBe("test.payu.in");
});

test("offers are JSON POSTs signed with HMAC-SHA256 over date and digest", async () => {
  let body = "";
  const calls = stub(() => json({ status: 1, result: {} }));
  const real = globalThis.fetch;
  globalThis.fetch = (async (url: string, init: RequestInit) => ((body = String(init.body)), real(url, init))) as typeof fetch;
  await run("list_offers", { amount: 500, user_id: "u1" });
  const h = calls[0]!.headers;
  expect(calls[0]!.url.href).toBe("https://api.payu.in/offers/transactions");
  expect(JSON.parse(body)).toEqual({ amount: 500, userToken: `${KEY}:u1` });
  expect(h.Digest).toBe(createHash("sha256").update(body).digest("base64"));
  expect(h.Authorization).toBe(`hmac username="${KEY}", algorithm="hmac-sha256", headers="date digest", signature="${createHmac("sha256", SALT).update(`${h.Date}\n${h.Digest}`).digest("base64")}"`);
});

test("money moves and changes ask first; lookups don't", () => {
  for (const name of ["refund_payment", "create_payment_link", "expire_payment_link", "capture_payment", "charge_recurring_payment", "release_settlement", "split_payment", "cancel_mandate", "delete_saved_card", "create_upi_qr"])
    expect(payu.actions[name]?.readOnly).toBe(false);
  for (const name of ["verify_payment", "check_payment", "list_transactions", "get_refund_status", "list_settlements", "get_emi_options", "validate_upi_id", "get_webhook_setup"]) expect(payu.actions[name]?.readOnly).toBe(true);
  for (const [name, a] of Object.entries(payu.actions))
    for (const [field, schema] of Object.entries(a.input.shape)) expect(`${name}.${field}: ${(schema as { description?: string }).description ?? ""}`).not.toEndWith(": ");
});

// --- triggers ---

const payment = (extra: Record<string, string> = {}) => {
  const p: Record<string, string> = { mihpayid: "275533", status: "success", key: KEY, txnid: "T1", amount: "40.00", productinfo: "Static QR", firstname: "", email: "", udf1: "", udf2: "", udf3: "", udf4: "SoftQR", udf5: "B6", mode: "UPI", ...extra };
  p.hash = sha([SALT, p.status, "", "", "", "", "", p.udf5, p.udf4, p.udf3, p.udf2, p.udf1, p.email, p.firstname, p.productinfo, p.amount, p.txnid, KEY].join("|"));
  return p;
};
const delivery = (body: string, type: string, rest = hookToken("c1")): Delivery => ({ body, headers: { "content-type": type }, connection: "c1", rest });
const FORM = "application/x-www-form-urlencoded";

test("a payment's reverse hash is checked with the salt", () => {
  expect(paymentHashOk(payment(), KEY, SALT)).toBe(true);
  expect(paymentHashOk({ ...payment(), amount: "4000.00" }, KEY, SALT)).toBe(false);
  expect(paymentHashOk(payment(), KEY, "other")).toBe(false);
});

test("a payment event starts the right triggers, stripped of clutter", async () => {
  const got = await receive(delivery(new URLSearchParams(payment()).toString(), FORM), LIVE);
  const [e] = await got!.events();
  expect(e!.triggers).toEqual(["payment_successful", "payment_event"]);
  expect(e!.id).toBe("payment:275533:success");
  expect(e!.data).not.toHaveProperty("hash");
  expect(e!.data).not.toHaveProperty("key");
});

test("forged, foreign or tampered deliveries are turned away", async () => {
  const body = new URLSearchParams(payment()).toString();
  expect(await receive(delivery(body, FORM, "wrong-token"), LIVE)).toBeNull();
  expect(await receive(delivery(new URLSearchParams({ ...payment(), amount: "9999" }).toString(), FORM), LIVE)).toBeNull();
  expect(await receive(delivery(body, FORM), `other:${SALT}`)).toBeNull();
  expect(await receive(delivery(JSON.stringify({ action: "refund", key: "someone", status: "success", request_id: "1" }), "application/json"), LIVE)).toBeNull();
});

test("refunds and disputes arrive as JSON and start theirs", async () => {
  const refund = { key: KEY, amt: "72.00", status: "failure", token: "PZ", mihpayid: " 239 ", request_id: "1726", merchantTxnId: "O1", action: "refund", bank_arn: null };
  const [r] = await (await receive(delivery(JSON.stringify(refund), "application/json"), LIVE))!.events();
  expect(r!.triggers).toEqual(["refund_failed"]);
  expect((r!.data as { mihpayid: string }).mihpayid).toBe("239");
  const dispute = { type: "payments", event: "dispute", cb_id: 17, cb_status: "New", txn_id: "999", cb_amount: "1.0", updated_at: "2025-05-27" };
  const [d] = await (await receive(delivery(JSON.stringify(dispute), "application/json"), LIVE))!.events();
  expect(d!.triggers).toEqual(["dispute_update"]);
  expect(triggersFor({ mihpayid: "1", status: "failure" })).toEqual(["payment_failed", "payment_event"]);
});

test("trigger settings filter on the server", () => {
  const d = { amount: "40.00", mode: "UPI", productinfo: "Static QR" };
  expect(wanted({ min_amount: 50 }, d)).toBe(false);
  expect(wanted({ min_amount: 40, mode: "upi", product: "qr" }, d)).toBe(true);
  expect(wanted({ mode: "CC" }, d)).toBe(false);
  expect(wanted({ status: "New" }, { cb_status: "Closed in Merchant Favour" })).toBe(false);
});

test("starting an automation files it under this connection's private address, which get_webhook_setup hands out", async () => {
  expect(await payu.push!.start(LIVE, "c1", "Successful", {})).toBe(watchId("c1"));
  const setup = (await run("get_webhook_setup", {}, LIVE, "c1")) as Record<string, any>;
  expect(setup.webhook_url).toBe(`https://api.test/webhooks/app/payu/c1/${hookToken("c1")}`);
  expect(JSON.stringify(setup)).not.toContain(SALT);
  expect(watchId("c1")).toBe(`payu:c1:${hookToken("c1")}`);
});

test("the webhook route takes only the private address and PayU's hash", async () => {
  const find = spyOn(db.query.connections, "findFirst");
  const app = Fastify();
  await automationRoutes(app);
  // a payment with no status starts no trigger, so a 200 needs no database
  const ok = payment({ status: "" });
  const post = (rest: string, body = new URLSearchParams(ok).toString()) => app.inject({ method: "POST", url: `/webhooks/app/payu/c1/${rest}`, headers: { "content-type": FORM }, payload: body });
  try {
    find.mockResolvedValue({ id: "row", app: "payu", secret: encrypt(LIVE), refreshToken: null, expiresAt: null } as never);
    expect((await post("not-the-token")).statusCode).toBe(401);
    expect((await post(hookToken("c1"), new URLSearchParams({ ...ok, amount: "1" }).toString())).statusCode).toBe(401);
    expect((await post(hookToken("c1"))).statusCode).toBe(200);
  } finally {
    find.mockRestore();
    await app.close();
  }
});

test("new_payment reads yesterday and today and fires per payment and status", async () => {
  const asked: [string, any][] = [];
  const t = pollTrigger("payu.new_payment")!;
  const rows = [
    { id: "1", status: "captured", amount: "500" },
    { id: "2", status: "failed", amount: "900" },
    { id: "3", status: "captured", amount: "50" },
  ];
  const items = await t.poll({ min_amount: 100 }, async (action, input) => (asked.push([action, input]), { status: 1, Transaction_details: rows }));
  expect(asked[0]![0]).toBe("payu.list_transactions");
  expect(asked[0]![1].from).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  expect(items.map((i) => i.id)).toEqual(["1:captured"]);
  expect((await t.poll({ status: "all" }, async () => ({ Transaction_details: rows }))).length).toBe(3);
});
