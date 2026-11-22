import { afterEach, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { z } from "zod";
import { pollDetail, pollOnce, listPolls } from "../../polls";
import { razorpay as triggers } from "../../polls/razorpay";
import { AppFile, AppsError } from "../../types";
import { own } from "../index";
import { razorpay } from "./index";
import { eventData, events, razorpaySignatureOk, triggersFor, webhookSecret } from "./webhooks";

type Call = { method: string; url: URL; headers: Record<string, string>; body: any };
const realFetch = globalThis.fetch;
const realEnv = { WEBHOOK_URL: process.env.WEBHOOK_URL, ENCRYPTION_KEY: process.env.ENCRYPTION_KEY };
afterEach(() => {
  globalThis.fetch = realFetch;
  Object.assign(process.env, realEnv);
});

// records every request and answers with reply(call); anything unanswered is a test bug, not a trip to Razorpay
function stub(reply: (c: Call) => { status?: number; body?: unknown } | undefined = () => ({ body: {} })) {
  const calls: Call[] = [];
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    const raw = init.body;
    const c = { method: init.method!, url: new URL(url), headers: init.headers as Record<string, string>, body: typeof raw === "string" ? JSON.parse(raw) : raw };
    calls.push(c);
    const r = reply(c);
    if (!r) throw new Error(`unexpected ${c.method} ${c.url}`);
    return new Response(r.body === undefined ? "" : JSON.stringify(r.body), { status: r.status ?? 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return calls;
}

const KEY = "rzp_test_abc:s3cret";
const run = (action: string, input: unknown, key = KEY) => {
  const a = razorpay.actions[action];
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

test("every action is well named and its input turns back into a JSON schema with a description per field", () => {
  expect(Object.keys(razorpay.actions).length).toBe(143);
  for (const [name, a] of Object.entries(razorpay.actions)) {
    expect(name).toMatch(/^[a-z0-9_]+$/);
    const schema = z.toJSONSchema(a.input, { io: "input" }) as { properties?: Record<string, any> };
    for (const [field, p] of Object.entries(schema.properties ?? {})) expect(`${name}.${field}: ${p.description ? "ok" : "no description"}`).toBe(`${name}.${field}: ok`);
  }
});

test("descriptions name real actions, and nothing from the old engine's vocabulary", async () => {
  const { actions } = await Bun.file(new URL("./actions.json", import.meta.url)).json();
  const text = JSON.stringify(actions);
  for (const [, name] of text.matchAll(/razorpay\.([a-z0-9_]+)/g)) expect(razorpay.actions[name!]).toBeDefined();
  expect(text).not.toMatch(/\b(createOrder|getPayments|base64|manifest)\b/);
});

test("no action takes a raw card number: it would be kept in the run history", () => {
  const input = (name: string) => Object.keys(z.toJSONSchema(razorpay.actions[name]!.input, { io: "input" }).properties ?? {});
  expect(razorpay.actions.create_token).toBeUndefined();
  expect(input("create_payment_s2s")).not.toContain("card");
  expect(input("get_card_fingerprint")).not.toContain("number");
});

test("anything that moves money or changes data asks first; lookups don't", () => {
  for (const name of ["create_refund", "capture_payment", "create_payment_link", "cancel_subscription", "create_direct_transfer", "accept_dispute"]) expect(razorpay.actions[name]?.readOnly).toBe(false);
  for (const name of ["list_payments", "get_order", "list_settlements", "validate_upi_id"]) expect(razorpay.actions[name]?.readOnly).toBe(true);
});

test("a write goes out with Basic auth and exactly the fields given, secret nowhere else", async () => {
  const calls = stub(() => ({ body: { id: "order_1" } }));
  await run("create_order", { amount: 50000, currency: "INR", receipt: "r1" });
  const c = calls[0]!;
  expect(c.method).toBe("POST");
  expect(c.url.href).toBe("https://api.razorpay.com/v1/orders");
  expect(c.headers.Authorization).toBe(`Basic ${btoa("rzp_test_abc:s3cret")}`);
  expect(c.body).toEqual({ amount: 50000, currency: "INR", receipt: "r1" });
  expect(c.url.href + JSON.stringify(c.body)).not.toContain("s3cret");
});

test("the id fills the path, an omitted refund amount isn't sent, and updating a customer is a PUT", async () => {
  const calls = stub();
  await run("create_refund", { payment_id: "pay_1" });
  await run("update_customer", { customer_id: "cust_1", name: "A" });
  expect(calls[0]!.url.pathname).toBe("/v1/payments/pay_1/refund");
  expect(calls[0]!.body).toEqual({});
  expect(calls[1]!.method).toBe("PUT");
});

test("expand goes out under the only name Razorpay reads, and a list's paging stays in the query", async () => {
  const calls = stub(() => ({ body: { items: [] } }));
  await run("list_payments", { expand: ["card", "emi"], count: 5 });
  expect(calls[0]!.url.searchParams.getAll("expand[]")).toEqual(["card", "emi"]);
  expect(calls[0]!.url.searchParams.get("count")).toBe("5");
  expect(calls[0]!.url.searchParams.has("expand")).toBe(false);
  await run("get_order_with_transfers", { order_id: "order_1" });
  expect(calls[1]!.url.href).toBe("https://api.razorpay.com/v1/orders/order_1?expand[]=transfers");
});

test("a document upload is multipart, with the file as a file", async () => {
  const calls = stub(() => ({ body: { id: "doc_1" } }));
  await run("upload_document", { purpose: "dispute_evidence", file: new AppFile("bill.pdf", "application/pdf", new Uint8Array([1, 2])) });
  const form = calls[0]!.body as FormData;
  expect(form.get("purpose")).toBe("dispute_evidence");
  expect((form.get("file") as File).name).toBe("bill.pdf");
  expect(form.has("content_base64")).toBe(false);
});

test("Razorpay's reason reaches the person; a 401 asks for reconnecting", async () => {
  stub(() => ({ status: 400, body: { error: { code: "BAD_REQUEST_ERROR", description: "The id provided does not exist" } } }));
  const bad = await fails(run("get_payment", { payment_id: "pay_x" }));
  expect(bad.message).toBe("Razorpay: The id provided does not exist (400)");
  expect(bad.expired).toBeFalsy();
  stub(() => ({ status: 401, body: { error: { code: "BAD_REQUEST_ERROR", description: "Authentication failed" } } }));
  expect((await fails(run("list_payments", {}))).expired).toBe(true);
});

test("connecting needs both halves, and checks them with Razorpay", async () => {
  const calls = stub(() => ({ body: { items: [] } }));
  expect((await fails(razorpay.check("rzp_test_abc"))).message).toContain("Key ID and the Key Secret");
  expect(calls).toHaveLength(0);
  await razorpay.check(KEY);
  expect(calls[0]!.url.href).toBe("https://api.razorpay.com/v1/payments?count=1");
});

test("every trigger polls a real read-only list, and is offered", () => {
  expect(listPolls("razorpay")).toHaveLength(Object.keys(triggers).length);
  expect(pollDetail("razorpay.payment_captured")?.input[0]?.name).toBe("every");
});

test("a list trigger asks for a bounded window and fires for new rows only", async () => {
  const asked: any[] = [];
  const list = (ids: string[]) => async (action: string, input: any) => {
    asked.push([action, input]);
    return { items: ids.map((id) => ({ id, status: "created" })) };
  };
  const first = await pollOnce("razorpay.new_order", {}, null, list(["a"]));
  expect(first.fresh).toEqual([]);
  const second = await pollOnce("razorpay.new_order", {}, first.seen, list(["b", "a"]));
  expect(second.fresh).toEqual([{ order: { id: "b", status: "created" } }]);
  expect(asked[0][0]).toBe("razorpay.list_orders");
  expect(asked[0][1].count).toBe(100);
  expect(Math.abs(asked[0][1].from - (Date.now() / 1000 - 86_400))).toBeLessThan(60);
  expect(razorpay.actions.list_orders?.readOnly).toBe(true);
});

test("a status trigger fires once, when an old row reaches that status", async () => {
  const rows = (status: string) => async () => ({ items: [{ id: "inv_1", status }] });
  const first = await pollOnce("razorpay.invoice_paid", {}, null, rows("issued"));
  const second = await pollOnce("razorpay.invoice_paid", {}, first.seen, rows("paid"));
  expect(second.fresh).toEqual([{ invoice: { id: "inv_1", status: "paid" } }]);
  const third = await pollOnce("razorpay.invoice_paid", {}, second.seen, rows("paid"));
  expect(third.fresh).toEqual([]);
});

test("every trigger's list action exists", async () => {
  for (const name of Object.keys(triggers)) {
    const asked: string[] = [];
    await pollOnce(`razorpay.${name}`, {}, null, async (action) => {
      asked.push(action);
      return { items: [] };
    });
    expect(razorpay.actions[asked[0]!.replace("razorpay.", "")]?.readOnly).toBe(true);
  }
});

// --- webhooks ---

const WH = (c: Call) => (c.method === "GET" ? { body: { items: [] } } : { body: { id: "wh_1" } });

test("saving an automation registers one signed webhook for the connection, with only the event it needs", async () => {
  process.env.WEBHOOK_URL = "https://api.test";
  process.env.ENCRYPTION_KEY = "k";
  const calls = stub(WH);
  const id = await own.startPush!("razorpay.payment_captured", { externalId: "conn1", secret: KEY });
  expect(id).toBe("razorpay:conn1");
  const post = calls[1]!;
  expect(post.method).toBe("POST");
  expect(post.url.href).toBe("https://api.razorpay.com/v1/webhooks");
  expect(post.body).toEqual({ url: "https://api.test/webhooks/razorpay/conn1", secret: webhookSecret("conn1"), events: { "payment.captured": true }, active: true });
});

test("the next trigger adds to that webhook, keeping its events, and an event it has already needs no call", async () => {
  process.env.WEBHOOK_URL = "https://api.test";
  process.env.ENCRYPTION_KEY = "k";
  const hook = { id: "wh_1", url: "https://api.test/webhooks/razorpay/conn1", active: true, events: { "payment.captured": true, "order.paid": false } };
  const calls = stub((c) => (c.method === "GET" ? { body: { items: [{ id: "wh_0", url: "https://other", active: true }, hook] } } : { body: { id: "wh_1" } }));
  await own.startPush!("razorpay.invoice_paid", { externalId: "conn1", secret: KEY });
  expect(calls[1]!.method).toBe("PUT");
  expect(calls[1]!.url.pathname).toBe("/v1/webhooks/wh_1");
  expect(calls[1]!.body.events).toEqual({ "payment.captured": true, "invoice.paid": true });
  await own.startPush!("razorpay.payment_captured", { externalId: "conn1", secret: KEY });
  expect(calls.filter((c) => c.method !== "GET")).toHaveLength(1);
});

test("a trigger Razorpay can't push, or a server that can't receive it, doesn't set up a webhook", async () => {
  process.env.ENCRYPTION_KEY = "k";
  const calls = stub(WH);
  expect(await own.startPush!("razorpay.new_order", { externalId: "conn1", secret: KEY })).toBeNull();
  delete process.env.WEBHOOK_URL;
  expect((await fails(own.startPush!("razorpay.invoice_paid", { externalId: "conn1", secret: KEY }) as Promise<unknown>)).message).toContain("WEBHOOK_URL");
  expect(calls).toHaveLength(0);
});

test("each connection has its own secret, and a signature from another connection's fails", () => {
  process.env.ENCRYPTION_KEY = "k";
  const body = '{"event":"payment.captured"}';
  const sign = (secret: string) => createHmac("sha256", secret).update(body).digest("hex");
  expect(webhookSecret("a")).not.toBe(webhookSecret("b"));
  expect(razorpaySignatureOk(body, sign(webhookSecret("a")), webhookSecret("a"))).toBe(true);
  expect(razorpaySignatureOk(body, sign(webhookSecret("b")), webhookSecret("a"))).toBe(false);
  expect(razorpaySignatureOk(body, "", webhookSecret("a"))).toBe(false);
});

test("an event finds its triggers, and reads the same as a polled one", () => {
  expect(triggersFor("payment.captured")).toEqual(["razorpay.payment_captured"]);
  expect(triggersFor("payment.dispute.won")).toEqual(["razorpay.dispute_won"]);
  expect(triggersFor("nothing.we.know")).toEqual([]);
  expect(eventData({ payment: { entity: { id: "pay_1" } }, order: { entity: { id: "order_1" } } })).toEqual({ payment: { id: "pay_1" }, order: { id: "order_1" } });
});

test("every pushed name is a real trigger: polled, or described with what it carries", async () => {
  for (const name of Object.keys(events)) {
    const detail = pollDetail(`razorpay.${name}`) ?? (await own.getTrigger!(`razorpay.${name}`));
    expect(`${name}: ${detail?.output.length ? "ok" : "missing"}`).toBe(`${name}: ok`);
  }
  expect(listPolls("razorpay").length + (await own.listTriggers!("razorpay")).length).toBe(53);
  expect((await own.listTriggers!("razorpay", "dispute won")).map((t) => t.action)).toEqual(["razorpay.dispute_won"]);
});

test("a webhook can be switched off, since Razorpay can't delete one", async () => {
  const calls = stub(() => ({ body: { id: "wh_1", active: false } }));
  await run("update_webhook", { webhook_id: "wh_1", url: "https://x", events: { "order.paid": true }, active: false });
  expect(calls[0]!.method).toBe("PUT");
  expect(calls[0]!.body).toEqual({ url: "https://x", events: { "order.paid": true }, active: false });
});
