// Swipe telling us about a document or a stock movement the moment it happens, at
// /webhooks/app/swipe/<connection>. Swipe has no API for its webhook: the business pastes that address into its
// own Swipe dashboard once (Settings → API Integration), which is what get_webhook_setup hands them. So nothing is
// registered or removed from here, and the signature's secret is the business's own Swipe API key, which it already
// has in front of it on that page: nothing to store, and no secret of ours to show anyone.
// Everything Swipe can't push is polled instead, in polls/swipe.ts.
import { createHmac, timingSafeEqual } from "node:crypto";
import type { ActionDetail } from "@emplio/shared";
import { AppsError } from "../../types";
import type { Delivery, WebhookEvent } from "../index";

type Data = Record<string, any>;

// our trigger → the Swipe event type it rides in on (Swipe has two: document and inventory)
export const events: Record<string, string> = {
  new_document: "document",
  document_updated: "document",
  document_cancelled: "document",
  document_event: "document",
  stock_moved: "inventory",
  stock_in: "inventory",
  stock_out: "inventory",
};

const SETUP =
  "Needs Swipe's webhook pointed at Emplio once, by hand in Swipe (Settings → API Integration): run swipe.get_webhook_setup for the address to paste. Until that's done this never fires";

const DOCUMENT_OUTPUT: ActionDetail["input"] = [
  { name: "event_type", type: "string", required: true, description: 'Always "document"' },
  { name: "document_type", type: "string", required: true, description: 'Which kind: invoice, purchase, estimate, sales_return, delivery_challan, purchase_order…' },
  { name: "serial_number", type: "string", required: true, description: "The document's number, as it reads on the invoice (INV-12)" },
  { name: "hash_id", type: "string", required: true, description: "Swipe's id for the document. The event carries no amounts or customer: read those with swipe.get_document" },
  { name: "message", type: "string", required: true, description: 'What happened, in Swipe\'s words ("Document Created")' },
  { name: "timestamp", type: "string", required: true, description: "When it happened, as Swipe sends it" },
];
const INVENTORY_OUTPUT: ActionDetail["input"] = [
  { name: "event_type", type: "string", required: true, description: 'Always "inventory"' },
  { name: "swipe_product_id", type: "number", required: true, description: "Swipe's own id for the item" },
  { name: "partner_product_id", type: "string", required: true, description: "The business's own item id, or -1 when the item was never given one" },
  { name: "product_name", type: "string", required: true, description: "The item's name" },
  { name: "qty", type: "number", required: true, description: "How much moved (always positive; `movement` says which way)" },
  { name: "movement", type: "string", required: true, description: '"in" for stock coming in, "out" for stock going out' },
  { name: "timestamp", type: "string", required: true, description: "When the stock moved, as Swipe sends it" },
];

const DOCUMENT_TYPE = { name: "document_type", type: "string", required: false, description: "Only this kind of document: invoice, purchase, estimate, sales_return, delivery_challan, purchase_order…" };
const PRODUCT_ID = { name: "product_id", type: "string", required: false, description: "Only this item: either the business's own item id or Swipe's" };
const MOVEMENT = { name: "movement", type: "string", required: false, description: '"in" for stock coming in only, "out" for stock going out only' };

const trigger = (description: string, output: ActionDetail["input"], config: ActionDetail["input"] = []) => ({ description: `${description}. ${SETUP}.`, config, output });

export const triggers: Record<string, { description: string; config: ActionDetail["input"]; output: ActionDetail["input"] }> = {
  new_document: trigger("An invoice, purchase, quote or any other document is created in Swipe", DOCUMENT_OUTPUT, [DOCUMENT_TYPE]),
  document_updated: trigger("A document in Swipe is changed", DOCUMENT_OUTPUT, [DOCUMENT_TYPE]),
  document_cancelled: trigger("A document in Swipe is cancelled", DOCUMENT_OUTPUT, [DOCUMENT_TYPE]),
  document_event: trigger("Anything happens to a document in Swipe: created, changed or cancelled", DOCUMENT_OUTPUT, [DOCUMENT_TYPE]),
  stock_moved: trigger("Stock of an item moves in or out in Swipe", INVENTORY_OUTPUT, [PRODUCT_ID, MOVEMENT]),
  stock_in: trigger("Stock of an item comes in in Swipe", INVENTORY_OUTPUT, [PRODUCT_ID]),
  stock_out: trigger("Stock of an item goes out in Swipe", INVENTORY_OUTPUT, [PRODUCT_ID]),
};

// Swipe says what happened only in words, and its codes aren't published, so the word is what we have.
const kind = (message: string) => (/cancel|delet|void/i.test(message) ? "document_cancelled" : /creat/i.test(message) ? "new_document" : "document_updated");

// the triggers (swipe.new_document) one of Swipe's events starts
export function triggersFor(eventType: string, data: Data): string[] {
  if (eventType === "document") return [kind(String(data.message ?? "")), "document_event"];
  if (eventType === "inventory") {
    const way = String(data.movement ?? "").toLowerCase();
    return [...(way === "in" ? ["stock_in"] : way === "out" ? ["stock_out"] : []), "stock_moved"];
  }
  return [];
}

// whether this automation's settings want the event
export function wanted(config: unknown, data: unknown) {
  const c = (config ?? {}) as Data;
  const d = (data ?? {}) as Data;
  const same = (a: unknown, b: unknown) => String(a).toLowerCase() === String(b).toLowerCase();
  if (c.document_type !== undefined && !same(c.document_type, d.document_type)) return false;
  if (c.movement !== undefined && !same(c.movement, d.movement)) return false;
  if (c.product_id !== undefined && !same(c.product_id, d.partner_product_id) && !same(c.product_id, d.swipe_product_id)) return false;
  return true;
}

export const watchId = (connection: string) => `swipe:${connection}`;
const hookUrl = (connection: string) => `${process.env.WEBHOOK_URL}/webhooks/app/swipe/${connection}`;

// What the business pastes into Swipe, in the words it can follow. The secret is its own Swipe API key, so this
// hands out nothing that isn't already on that page.
export function webhookSetup(connection?: string) {
  if (!process.env.WEBHOOK_URL) throw new AppsError("this server can't receive Swipe's events (WEBHOOK_URL isn't set)");
  if (!connection) throw new AppsError("connect Swipe first: emplio apps connect swipe");
  return {
    where: "Swipe → Settings → API Integration (app.getswipe.in/user?tab=api_integration), the Webhooks part",
    webhook_url: hookUrl(connection),
    events_to_tick: ["document", "inventory"],
    secret: "the same Swipe API key this business is connected with (Swipe takes any secret; Emplio checks the signature with that key)",
    note: "Swipe keeps one webhook address per company and has no API for it, so this is done by hand once. Emplio's instant Swipe triggers stay quiet until it's saved; the polled ones (new_invoice, invoice_paid, payment_received…) work without it.",
  };
}

// Nothing to register: Swipe's webhook is a dashboard setting. This only says where its events will be filed.
export async function watch(connection: string) {
  if (!process.env.WEBHOOK_URL) throw new AppsError("this server can't receive Swipe's events (WEBHOOK_URL isn't set)");
  return watchId(connection);
}

// Really from Swipe: its X-Signature over the raw body, with the business's own API key as the secret.
export function signatureOk(body: string, signature: string, key: string) {
  const got = Buffer.from(signature, "hex");
  const want = createHmac("sha256", key).update(body).digest();
  return got.length === want.length && timingSafeEqual(got, want);
}

export async function receive(delivery: Delivery, key: string) {
  if (!signatureOk(delivery.body, String(delivery.headers["x-signature"] ?? ""), key)) return null;
  // Swipe's payload is already small: the event type and its handful of fields, nothing to strip
  const sent = JSON.parse(delivery.body) as { event_id?: string; event_type?: string; data?: Data };
  const data = { event_type: sent.event_type, ...sent.data };
  const out: WebhookEvent[] = [{ id: sent.event_id, triggers: triggersFor(String(sent.event_type ?? ""), data), data }];
  return { events: async () => out };
}
