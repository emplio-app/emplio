// PayU telling us about payments, refunds and disputes the moment they happen, at
// /webhooks/app/payu/<connection>/<token>. PayU has no API for webhooks: the owner pastes that address into the
// PayU Dashboard (Developers → Webhooks) once per event type, which is what get_webhook_setup hands them.
// Checks: the <token> in the address is an HMAC of ENCRYPTION_KEY and the connection (worked out, never stored, and
// only ever shown to the owner), so nobody else can post to it. Payment events also carry PayU's reverse hash,
// sha512(salt|status|udf10…udf1|email|firstname|productinfo|amount|txnid|key), checked with the business's salt.
// Refund and dispute events are JSON with no hash, so the token is their check.
import { createHmac, timingSafeEqual } from "node:crypto";
import type { ActionDetail } from "@emplio/shared";
import { AppsError } from "../../types";
import type { Delivery, WebhookEvent } from "../index";
import { creds, sha512 } from "./client";

type Data = Record<string, any>;

// our trigger → the PayU webhook event type it comes in on (the dashboard's Event list)
export const events: Record<string, string> = {
  payment_successful: "Successful",
  payment_failed: "Failed",
  payment_event: "Successful",
  refund_successful: "Refund",
  refund_failed: "Refund",
  dispute_update: "Dispute",
};

const SETUP = "Needs the webhook address pasted into the PayU Dashboard once (Developers → Webhooks): run payu.get_webhook_setup for it. Until then this never fires";

const PAYMENT_OUT: ActionDetail["input"] = [
  { name: "status", type: "string", required: true, description: "success, failure or pending" },
  { name: "unmappedstatus", type: "string", required: false, description: "PayU's finer status: captured, auth, failed, userCancelled, bounced, dropped…" },
  { name: "txnid", type: "string", required: true, description: "The business's own order id" },
  { name: "mihpayid", type: "string", required: true, description: "PayU's payment id, for refunds and lookups" },
  { name: "amount", type: "string", required: true, description: "Amount in rupees, as the order asked" },
  { name: "net_amount_debit", type: "string", required: false, description: "What the customer actually paid, in rupees, fees included" },
  { name: "mode", type: "string", required: false, description: "How they paid: UPI, CC, DC, NB, CASH (wallet), EMI…" },
  { name: "productinfo", type: "string", required: false, description: "What the payment was for" },
  { name: "firstname", type: "string", required: false, description: "Customer's name" },
  { name: "email", type: "string", required: false, description: "Customer's email" },
  { name: "phone", type: "string", required: false, description: "Customer's phone (PayU may mask it)" },
  { name: "error_Message", type: "string", required: false, description: "Why it failed, in PayU's words" },
  { name: "bank_ref_num", type: "string", required: false, description: "The bank's reference for the payment" },
  { name: "addedon", type: "string", required: false, description: "When it happened, Indian time" },
];
const REFUND_OUT: ActionDetail["input"] = [
  { name: "status", type: "string", required: true, description: "success or failure" },
  { name: "amt", type: "string", required: true, description: "Refunded amount in rupees" },
  { name: "mihpayid", type: "string", required: true, description: "PayU's id of the refunded payment" },
  { name: "merchantTxnId", type: "string", required: false, description: "The business's order id of the refunded payment" },
  { name: "request_id", type: "string", required: true, description: "PayU's refund id" },
  { name: "token", type: "string", required: false, description: "The business's own refund reference" },
  { name: "bank_arn", type: "string", required: false, description: "The bank's refund reference (ARN) the customer can quote; can arrive in a later event" },
  { name: "refund_mode", type: "string", required: false, description: "How the money goes back, e.g. Instant Credit through UPI" },
  { name: "remark", type: "string", required: false, description: "Why it failed, when it did" },
];
const DISPUTE_OUT: ActionDetail["input"] = [
  { name: "cb_status", type: "string", required: true, description: "New, Pending Response, Pending Doc Review, Submitted to Bank, Insufficient Document, Closed Customer Favour, Closed in Merchant Favour…" },
  { name: "cb_amount", type: "string", required: true, description: "Disputed amount in rupees" },
  { name: "txn_id", type: "string", required: true, description: "PayU's id of the disputed payment" },
  { name: "reason_code", type: "string", required: false, description: "Why the customer disputed it" },
  { name: "due_date", type: "string", required: false, description: "Last day to answer, YYYY-MM-DD" },
  { name: "cb_id", type: "number", required: true, description: "PayU's dispute (chargeback) id" },
  { name: "cb_type", type: "string", required: false, description: "Kind of chargeback" },
];

const MIN_AMOUNT = { name: "min_amount", type: "number", required: false, description: "Only payments of at least this many rupees" };
const MODE = { name: "mode", type: "string", required: false, description: "Only this way of paying: UPI, CC, DC, NB, CASH, EMI…" };
const PRODUCT = { name: "product", type: "string", required: false, description: "Only payments whose description (productinfo) contains these words" };
const CB_STATUS = { name: "status", type: "string", required: false, description: 'Only disputes moving to this status, e.g. "New" for newly raised ones' };

const trigger = (description: string, output: ActionDetail["input"], config: ActionDetail["input"] = []) => ({ description: `${description}. ${SETUP}.`, config, output });

export const triggers: Record<string, { description: string; config: ActionDetail["input"]; output: ActionDetail["input"] }> = {
  payment_successful: trigger("A customer's payment succeeds on PayU (tick the Successful event)", PAYMENT_OUT, [MIN_AMOUNT, MODE, PRODUCT]),
  payment_failed: trigger("A customer's payment fails on PayU (tick the Failed event)", PAYMENT_OUT, [MIN_AMOUNT, MODE, PRODUCT]),
  payment_event: trigger("Any payment PayU reports, successful, failed or pending (tick both Successful and Failed)", PAYMENT_OUT, [MIN_AMOUNT, MODE, PRODUCT]),
  refund_successful: trigger("A refund goes through, or its bank reference (ARN) arrives (tick the Refund event)", REFUND_OUT),
  refund_failed: trigger("A refund fails (tick the Refund event)", REFUND_OUT),
  dispute_update: trigger("A customer disputes a payment (chargeback), or a dispute changes status (tick the Dispute event)", DISPUTE_OUT, [CB_STATUS]),
};

export function triggersFor(data: Data): string[] {
  if (data.event === "dispute" || data.cb_id !== undefined) return ["dispute_update"];
  if (data.action === "refund" || data.request_id !== undefined) return [data.status === "success" ? "refund_successful" : "refund_failed"];
  if (data.mihpayid === undefined) return [];
  const s = String(data.status ?? "").toLowerCase();
  return [...(s === "success" ? ["payment_successful"] : s === "failure" ? ["payment_failed"] : []), "payment_event"];
}

// whether this automation's settings want the event
export function wanted(config: unknown, data: unknown) {
  const c = (config ?? {}) as Data;
  const d = (data ?? {}) as Data;
  if (c.min_amount !== undefined && !(Number(d.amount) >= Number(c.min_amount))) return false;
  if (c.mode !== undefined && String(d.mode ?? "").toUpperCase() !== String(c.mode).toUpperCase()) return false;
  if (c.product !== undefined && !String(d.productinfo ?? "").toLowerCase().includes(String(c.product).toLowerCase())) return false;
  if (c.status !== undefined && d.cb_status !== undefined && String(d.cb_status).toLowerCase() !== String(c.status).toLowerCase()) return false;
  return true;
}

// The secret part of this connection's address, worked out rather than stored.
export function hookToken(connection: string) {
  const key = process.env.ENCRYPTION_KEY;
  if (!key) throw new Error("ENCRYPTION_KEY isn't set");
  return createHmac("sha256", key).update(`payu-webhook:${connection}`).digest("hex").slice(0, 32);
}
// automations wait under payu:<connection>:<token>, the id the shared route files this address's events under
export const watchId = (connection: string) => `payu:${connection}:${hookToken(connection)}`;
const hookUrl = (connection: string) => `${process.env.WEBHOOK_URL}/webhooks/app/payu/${connection}/${hookToken(connection)}`;

export function webhookSetup(connection?: string) {
  if (!process.env.WEBHOOK_URL) throw new AppsError("this server can't receive PayU's events (WEBHOOK_URL isn't set)");
  if (!connection) throw new AppsError("connect PayU first: emplio apps connect payu");
  return {
    where: "PayU Dashboard → Developers → Webhooks → Create Webhook (Type: Payments). Use the dashboard of the same mode as the connection: test or live",
    webhook_url: hookUrl(connection),
    events_to_create: ["Successful", "Failed", "Refund", "Dispute"],
    how: "Create one webhook per event, each with this same address. PayU allows several addresses per event, comma separated, so an existing one can stay.",
    note: "Keep this address private: it is the business's own and works like a password. Emplio's PayU triggers stay quiet until it's saved; the polled new_payment trigger works without it.",
  };
}

export async function watch(connection: string) {
  if (!process.env.WEBHOOK_URL) throw new AppsError("this server can't receive PayU's events (WEBHOOK_URL isn't set)");
  return watchId(connection);
}

const same = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

// PayU's reverse hash on a payment. The five slots after status are udf10…udf6, empty for most merchants; a
// convenience fee (additionalCharges) goes in front.
export function paymentHashOk(d: Data, key: string, salt: string) {
  const v = (k: string) => String(d[k] ?? "");
  const tail = [v("udf5"), v("udf4"), v("udf3"), v("udf2"), v("udf1"), v("email"), v("firstname"), v("productinfo"), v("amount"), v("txnid"), key];
  const lead = d.additionalCharges ? [v("additionalCharges")] : [];
  const got = v("hash").toLowerCase();
  const tries = [
    [...lead, salt, v("status"), "", "", "", "", "", ...tail],
    [...lead, salt, v("status"), v("udf10"), v("udf9"), v("udf8"), v("udf7"), v("udf6"), ...tail],
  ];
  return !!got && tries.some((t) => same(sha512(t.join("|")), got));
}

const parse = (body: string, type: string): Data => {
  if (type.includes("json") || body.trimStart().startsWith("{")) return JSON.parse(body);
  return Object.fromEntries(new URLSearchParams(body));
};

// the address or link clutter PayU sends back on every payment
const NOISE = ["hash", "key", "surl", "furl", "curl", "card_token", "cardToken", "field0", "field1", "field2", "field3", "field4", "field5", "field6", "field7", "field8", "field9"];

export async function receive(delivery: Delivery, secret: string) {
  if (!same(delivery.rest.split("/")[0] ?? "", hookToken(delivery.connection))) return null;
  const c = creds(secret);
  let d: Data;
  try {
    d = parse(delivery.body, String(delivery.headers["content-type"] ?? ""));
  } catch {
    return null;
  }
  for (const k of ["mihpayid", "request_id", "merchantTxnId"]) if (typeof d[k] === "string") d[k] = d[k].trim();
  // a payment or refund names its merchant key; one for another account isn't ours
  if (d.key !== undefined && d.key !== c.key) return null;
  if (d.mihpayid !== undefined && d.action === undefined && !paymentHashOk(d, c.key, c.salt)) return null;
  const data = Object.fromEntries(Object.entries(d).filter(([k, v]) => !NOISE.includes(k) && v !== "" && v !== null));
  const id =
    d.cb_id !== undefined ? `dispute:${d.cb_id}:${d.cb_status}:${d.updated_at}` : d.request_id !== undefined ? `refund:${d.request_id}:${d.status}:${d.bank_arn ?? ""}` : `payment:${d.mihpayid}:${d.status}`;
  const out: WebhookEvent[] = [{ id, triggers: triggersFor(d), data }];
  return { events: async () => out };
}
