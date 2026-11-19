// Cashfree telling us about payments, refunds, settlements, disputes, payment links, subscriptions and more the moment
// they happen, at /webhooks/app/cashfree/<connection>. Cashfree has no API for webhooks: the business adds that address
// once in its own dashboard (Payment Gateway → Developers → Webhooks) and ticks the events, which is what
// get_webhook_setup hands them. So nothing is registered or removed from here. Cashfree signs every webhook with the
// account's own client secret, which is the key Emplio already holds: nothing extra to store or show anyone.
// Cashfree has no list of payments to poll (its reconciliation report is by date and lags), so there are no polled
// triggers: own/cashfree/COVERAGE.md.
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { ActionDetail } from "@emplio/shared";
import { AppsError } from "../../types";
import type { Delivery, WebhookEvent } from "../index";

type Data = Record<string, any>;
type Field = ActionDetail["input"][number];

const RUPEES = "Amounts are in rupees, not paise: 500.5 is ₹500.50.";
const obj = (name: string, what: string): Field => ({ name, type: "object", required: false, description: `${what}. ${RUPEES}` });
const ORDER = obj("order", "The Cashfree order: order_id, order_amount, order_currency, order_tags");
const PAYMENT = obj("payment", "The payment attempt: cf_payment_id, payment_status, payment_amount, payment_time, payment_method, payment_message, bank_reference");
const CUSTOMER = obj("customer_details", "Who paid: customer_name, customer_email, customer_phone, customer_id");
const PAYMENT_OUT = [ORDER, PAYMENT, CUSTOMER, obj("error_details", "Why it failed, when it did: error_code, error_description, error_reason")];
const REFUND_OUT = [obj("refund", "The refund: cf_refund_id, refund_id, order_id, cf_payment_id, refund_amount, refund_status, status_description, refund_arn, processed_at")];
const SETTLEMENT_OUT = [obj("settlement", "The settlement to the bank: settlement_id, settlement_amount, amount_settled, payment_amount, service_charge, service_tax, status, utr, settled_on, reason")];
const DISPUTE_OUT = [
  obj("dispute", "The dispute: dispute_id, dispute_type, reason_code, reason_description, dispute_amount, dispute_status, respond_by, cf_dispute_remarks"),
  obj("order_details", "The order disputed: order_id, order_amount, cf_payment_id, payment_amount"),
  CUSTOMER,
];
const LINK_OUT: Field[] = [
  { name: "link_id", type: "string", required: true, description: "The payment link's id (the one Emplio or the business gave it)" },
  { name: "link_status", type: "string", required: true, description: "PAID, PARTIALLY_PAID, EXPIRED or CANCELLED" },
  { name: "link_amount", type: "string", required: false, description: `What the link asks for. ${RUPEES}` },
  { name: "link_amount_paid", type: "string", required: false, description: `What's been paid so far. ${RUPEES}` },
  { name: "link_purpose", type: "string", required: false, description: "What the payment is for, as the customer saw it" },
  obj("customer_details", "Who the link was for: customer_name, customer_email, customer_phone"),
  obj("order", "The payment that changed it, when there was one: order_id, order_amount, transaction_id, transaction_status"),
];
const SUBSCRIPTION_OUT = [
  obj("subscription_details", "The subscription: subscription_id, subscription_status, next_schedule_date, subscription_tags"),
  obj("customer_details", "The subscriber: customer_name, customer_email, customer_phone"),
  obj("plan_details", "The plan: plan_id, plan_name, plan_amount, plan_type, plan_interval_type"),
  obj("authorization_details", "The mandate: authorization_status, authorization_amount, payment_method"),
];
const SUB_PAYMENT_OUT = [
  { name: "payment_id", type: "string", required: false, description: "The charge's id (Emplio's or the business's)" },
  { name: "cf_payment_id", type: "string", required: false, description: "Cashfree's id for the charge" },
  { name: "subscription_id", type: "string", required: false, description: "The subscription it belongs to" },
  { name: "payment_status", type: "string", required: false, description: "SUCCESS, FAILED, PENDING, CANCELLED, INITIALIZED…" },
  { name: "payment_amount", type: "number", required: false, description: `The charge. ${RUPEES}` },
  obj("failure_details", "Why it failed, when it did: failure_reason"),
] satisfies Field[];
const VENDOR_SETTLEMENT_OUT = [obj("settlement", "The settlement to an Easy Split vendor: settlement_id, merchant_vendor_id, settlement_amount, status, utr, settled_on, reason")];
const INSTRUMENT_OUT = [obj("instrument", "The saved card: instrument_id, customer_id, instrument_status, instrument_display, instrument_meta")];

// [our name, Cashfree's event type, what it means, what it carries, and which of that type it is when one type covers several]
type Row = [name: string, type: string, description: string, output: Field[], when?: (d: Data) => boolean];
const status = (path: (d: Data) => unknown, want: string) => (d: Data) => String(path(d) ?? "").toUpperCase() === want;
const refundIs = (s: string) => status((d) => d.refund?.refund_status, s);
const linkIs = (s: string) => status((d) => d.link_status, s);

const ROWS: Row[] = [
  ["payment_success", "PAYMENT_SUCCESS_WEBHOOK", "A customer's payment succeeds and the money is collected", PAYMENT_OUT],
  ["payment_failed", "PAYMENT_FAILED_WEBHOOK", "A customer's payment attempt fails. The customer may try again on the same order, so a later payment_success can follow", PAYMENT_OUT],
  ["payment_user_dropped", "PAYMENT_USER_DROPPED_WEBHOOK", "A customer leaves the payment page without finishing paying", PAYMENT_OUT],
  ["payment_charges", "PAYMENT_CHARGES_WEBHOOK", "Cashfree works out its fee and tax on a successful payment", [...PAYMENT_OUT, obj("charges_details", "Cashfree's fee: service_charge, service_tax, settlement_amount")]],
  ["refund_status_changed", "REFUND_STATUS_WEBHOOK", "A refund finishes, either reaching the customer or being cancelled by Cashfree", REFUND_OUT],
  ["refund_processed", "REFUND_STATUS_WEBHOOK", "A refund reaches the customer", REFUND_OUT, refundIs("SUCCESS")],
  ["refund_cancelled", "REFUND_STATUS_WEBHOOK", "A refund is cancelled: Cashfree couldn't pay the customer back after several tries", REFUND_OUT, refundIs("CANCELLED")],
  ["auto_refund_processed", "AUTO_REFUND_STATUS_WEBHOOK", "Cashfree refunds a payment by itself (money taken from a customer for an order that failed or was already paid)", REFUND_OUT],
  ["settlement_initiated", "SETTLEMENT_INITIATED", "Cashfree starts sending collected money to the business's bank account", SETTLEMENT_OUT],
  ["settlement_success", "SETTLEMENT_SUCCESS", "Collected money reaches the business's bank account", SETTLEMENT_OUT],
  ["settlement_failed", "SETTLEMENT_FAILED", "A settlement to the business's bank account fails", SETTLEMENT_OUT],
  ["settlement_reversed", "SETTLEMENT_REVERSED", "A settlement is sent back by the bank", SETTLEMENT_OUT],
  ["dispute_created", "DISPUTE_CREATED", "A customer opens a dispute or chargeback on a payment", DISPUTE_OUT],
  ["dispute_updated", "DISPUTE_UPDATED", "A dispute changes: more documents asked for, or it moves stage", DISPUTE_OUT],
  ["dispute_closed", "DISPUTE_CLOSED", "A dispute is decided, won or lost", DISPUTE_OUT],
  ["payment_link_event", "PAYMENT_LINK_EVENT", "Anything happens to a payment link: paid, part paid, expired or cancelled", LINK_OUT],
  ["payment_link_paid", "PAYMENT_LINK_EVENT", "A payment link is paid in full", LINK_OUT, linkIs("PAID")],
  ["payment_link_partially_paid", "PAYMENT_LINK_EVENT", "Part of a payment link is paid", LINK_OUT, linkIs("PARTIALLY_PAID")],
  ["payment_link_expired", "PAYMENT_LINK_EVENT", "A payment link expires without being paid in full", LINK_OUT, linkIs("EXPIRED")],
  ["payment_link_cancelled", "PAYMENT_LINK_EVENT", "A payment link is cancelled", LINK_OUT, linkIs("CANCELLED")],
  ["payment_form_paid", "PAYMENT_FORM_ORDER_WEBHOOK", "Someone fills in and pays a Cashfree payment form", [obj("form", "The form: form_id, cf_form_id, form_url, form_currency"), obj("order", "The payment: order_id, order_amount, order_status, transaction_id, customer_details, amount_details")]],
  ["saved_card_active", "INSTRUMENT_ACTIVE_WEBHOOK", "A customer's card is saved (tokenised) and can be used again", INSTRUMENT_OUT],
  ["saved_card_failed", "INSTRUMENT_FAILED_WEBHOOK", "Saving a customer's card fails", INSTRUMENT_OUT],
  ["subscription_status_changed", "SUBSCRIPTION_STATUS_CHANGED", "A subscription changes state: active, paused, cancelled, completed, on hold…", SUBSCRIPTION_OUT],
  ["subscription_auth_status", "SUBSCRIPTION_AUTH_STATUS", "A customer approves, or fails to approve, a subscription's autopay mandate", [...SUBSCRIPTION_OUT, ...SUB_PAYMENT_OUT]],
  ["subscription_payment_notification", "SUBSCRIPTION_PAYMENT_NOTIFICATION_INITIATED", "Cashfree tells a subscriber a charge is coming (the pre-debit notice)", SUB_PAYMENT_OUT],
  ["subscription_payment_success", "SUBSCRIPTION_PAYMENT_SUCCESS", "A subscription charge is paid", SUB_PAYMENT_OUT],
  ["subscription_payment_failed", "SUBSCRIPTION_PAYMENT_FAILED", "A subscription charge fails", SUB_PAYMENT_OUT],
  ["subscription_payment_cancelled", "SUBSCRIPTION_PAYMENT_CANCELLED", "A planned subscription charge is cancelled", SUB_PAYMENT_OUT],
  ["subscription_refund_status", "SUBSCRIPTION_REFUND_STATUS", "A refund of a subscription charge finishes or fails", [obj("refund_details", "The refund: refund_id, cf_refund_id, refund_amount, refund_status, subscription_id, payment_id")]],
  ["subscription_card_expiry_reminder", "SUBSCRIPTION_CARD_EXPIRY_REMINDER", "A subscriber's card is about to expire, so future charges will fail", SUBSCRIPTION_OUT],
  ["subscription_debit_notice_status", "SUBSCRIPTION_CONTROLLED_NOTIFICATION_STATUS", "A pre-debit notice the business sent (send_subscription_debit_notice) is delivered or fails", SUB_PAYMENT_OUT],
  ["subscription_debit_status", "SUBSCRIPTION_CONTROLLED_EXECUTION_STATUS", "A debit the business started (execute_subscription_debit) succeeds or fails", SUB_PAYMENT_OUT],
  ["vendor_settlement_initiated", "VENDOR_SETTLEMENT_INITIATED", "Cashfree starts paying an Easy Split vendor", VENDOR_SETTLEMENT_OUT],
  ["vendor_settlement_success", "VENDOR_SETTLEMENT_SUCCESS", "An Easy Split vendor is paid", VENDOR_SETTLEMENT_OUT],
  ["vendor_settlement_failed", "VENDOR_SETTLEMENT_FAILED", "Paying an Easy Split vendor fails", VENDOR_SETTLEMENT_OUT],
  ["vendor_settlement_reversed", "VENDOR_SETTLEMENT_REVERSED", "A payment to an Easy Split vendor is sent back by the bank", VENDOR_SETTLEMENT_OUT],
  ["vendor_status_changed", "VENDOR_STATUS_UPDATE", "An Easy Split vendor's status changes (approved, blocked, needs documents…)", [obj("vendor", "The vendor: merchant_vendor_id, vendor_status, name, email, updated_on")]],
  ["payment_downtime", "HEALTH_ALERT", "A bank, card network, wallet or UPI app starts or stops having trouble taking payments", [obj("incident", "The outage: id, status, impact, type, message, start_time, end_time"), obj("instruments", "What's affected: upi, card, netbanking… with the issuers")]],
  ["terminal_status_changed", "TERMINAL_STATUS_UPDATE", "A SoftPOS terminal's status changes", [obj("terminal", "The terminal: cf_terminal_id, terminal_id, terminal_status, terminal_phone_no")]],
];

// Where an automation can narrow what it wants, so it isn't woken for every payment in the account.
const ORDER_ID: Field = { name: "order_id", type: "string", required: false, description: "Only for this order id" };
const LINK_ID: Field = { name: "link_id", type: "string", required: false, description: "Only for this payment link id" };
const SUBSCRIPTION_ID: Field = { name: "subscription_id", type: "string", required: false, description: "Only for this subscription id" };
const configFor = (name: string): Field[] =>
  name.startsWith("payment_link") ? [LINK_ID] : name.startsWith("subscription_") ? [SUBSCRIPTION_ID] : /^(payment_|refund_|auto_refund|dispute_)/.test(name) && name !== "payment_downtime" ? [ORDER_ID] : [];

const SETUP =
  "Needs Cashfree's webhook pointed at Emplio once, by hand in the Cashfree dashboard: run cashfree.get_webhook_setup for the address and the event to tick. Until that's done this never fires";

// our trigger → the Cashfree event type it rides in on
export const events: Record<string, string> = Object.fromEntries(ROWS.map(([name, type]) => [name, type]));

export const triggers: Record<string, { description: string; config: ActionDetail["input"]; output: ActionDetail["input"] }> = Object.fromEntries(
  ROWS.map(([name, , description, output]) => [name, { description: `${description}. ${SETUP}.`, config: configFor(name), output }]),
);

// the triggers (short names) one of Cashfree's events starts
export const triggersFor = (type: string, data: Data) => ROWS.filter(([, t, , , when]) => t === type && (!when || when(data))).map(([name]) => name);

// whether this automation's settings want the event
export function wanted(config: unknown, data: unknown) {
  const c = (config ?? {}) as Data;
  const d = (data ?? {}) as Data;
  const orderId = d.order?.order_id ?? d.refund?.order_id ?? d.order_details?.order_id;
  const subscriptionId = d.subscription_id ?? d.subscription_details?.subscription_id ?? d.refund_details?.subscription_id;
  if (c.order_id !== undefined && String(c.order_id) !== String(orderId)) return false;
  if (c.link_id !== undefined && String(c.link_id) !== String(d.link_id)) return false;
  if (c.subscription_id !== undefined && String(c.subscription_id) !== String(subscriptionId)) return false;
  return true;
}

export const watchId = (connection: string) => `cashfree:${connection}`;
const hookUrl = (connection: string) => `${process.env.WEBHOOK_URL}/webhooks/app/cashfree/${connection}`;
const noUrl = () => new AppsError("this server can't receive Cashfree's events (WEBHOOK_URL isn't set)");

// What the business sets up in Cashfree, in words it can follow. Nothing secret: Cashfree signs with the business's own
// client secret, which it already has.
export function webhookSetup(connection?: string, sandbox?: boolean) {
  if (!process.env.WEBHOOK_URL) throw noUrl();
  if (!connection) throw new AppsError("connect Cashfree first: emplio apps connect cashfree");
  return {
    where: `Cashfree Merchant Dashboard (merchant.cashfree.com), ${sandbox ? "switched to Test mode, " : ""}Payment Gateway → Developers → Webhooks → Add Webhook Endpoint`,
    webhook_url: hookUrl(connection),
    version: "the newest webhook version offered (2025-01-01 or later)",
    events_to_tick: "Every event the business wants Emplio to act on: Success Payment, Failed Payment, User Dropped Payment, Refund, Settlement…, Dispute…; ticking all of them is fine, Emplio ignores the ones no automation uses",
    also: "Payment Links and Subscriptions have their own Webhooks settings in the dashboard: add the same address there for link and subscription triggers",
    secret: "nothing to paste: Cashfree signs webhooks with this account's client secret, which Emplio already checks against",
    note: "Cashfree has no API for webhooks, so this is done once by hand. Emplio's Cashfree triggers stay quiet until it's saved.",
  };
}

// Nothing to register: Cashfree's webhook is a dashboard setting. This only says where its events will be filed.
export async function watch(connection: string) {
  if (!process.env.WEBHOOK_URL) throw noUrl();
  return watchId(connection);
}

// Really from Cashfree: base64(HMAC-SHA256(timestamp + raw body)) with the client secret.
export function signatureOk(body: string, signature: string, timestamp: string, secret: string) {
  if (!signature || !timestamp || !secret) return false;
  const got = Buffer.from(signature, "base64");
  const want = createHmac("sha256", secret).update(timestamp + body).digest();
  return got.length === want.length && timingSafeEqual(got, want);
}

export async function receive(delivery: Delivery, secret: string) {
  const h = (name: string) => String(delivery.headers[name] ?? "");
  if (!signatureOk(delivery.body, h("x-webhook-signature"), h("x-webhook-timestamp"), secret)) return null;
  const sent = JSON.parse(delivery.body) as { type?: string; event_time?: string; data?: Data };
  const data = { type: sent.type, event_time: sent.event_time, ...sent.data };
  // Cashfree's delivery id (webhook version 2025-01-01 on); older versions resend the same body, so its hash does too
  const id = h("x-idempotency-key") || createHash("sha256").update(delivery.body).digest("hex");
  const out: WebhookEvent[] = [{ id, triggers: triggersFor(String(sent.type ?? ""), data), data }];
  return { events: async () => out };
}
