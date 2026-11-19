// Shopify telling us about events the moment they happen. Shopify's subscriptions are one topic each, so a connection
// gets one per topic its automations use, all to /webhooks/app/shopify/<connection>/<token>. The token is worked out
// from ENCRYPTION_KEY, never stored, and proves the sender: a store's own app made in the admin before 2026 signs with
// a secret we're never given. For Dev Dashboard apps, whose secret we do have, Shopify's signature is checked as well.
// Trigger names are Shopify's topics (orders_create), plus Composio's names for the ones it has, so saved automations carry over.
import type { ActionDetail } from "@emplio/shared";
import { createHmac, timingSafeEqual } from "node:crypto";
import { AppsError } from "../../types";
import type { Delivery, WebhookEvent } from "../index";
import topics from "./topics.json";
import { graphql, parseKey, userErrors } from "./client";

// Plain words for the topics people use most; the rest are described from their name.
const SAID: Record<string, string> = {
  ORDERS_CREATE: "A new order comes in",
  ORDERS_PAID: "An order is paid in full",
  ORDERS_CANCELLED: "An order is cancelled",
  ORDERS_FULFILLED: "Every item in an order is shipped or handed over",
  ORDERS_PARTIALLY_FULFILLED: "Some items in an order are shipped",
  ORDERS_UPDATED: "Anything about an order changes",
  ORDERS_EDITED: "Items in an order are changed after it was placed",
  ORDERS_DELETE: "An order is deleted",
  ORDER_TRANSACTIONS_CREATE: "Money moves on an order: a payment, capture or refund",
  REFUNDS_CREATE: "A refund is made",
  DRAFT_ORDERS_CREATE: "A draft order is made",
  DRAFT_ORDERS_UPDATE: "A draft order changes",
  CHECKOUTS_CREATE: "A shopper starts checkout (an abandoned cart, if they don't finish)",
  CHECKOUTS_UPDATE: "A checkout changes",
  CUSTOMERS_CREATE: "A new customer signs up or is added",
  CUSTOMERS_UPDATE: "A customer's details change",
  PRODUCTS_CREATE: "A product is added",
  PRODUCTS_UPDATE: "A product changes, including its price or stock",
  PRODUCTS_DELETE: "A product is deleted",
  VARIANTS_OUT_OF_STOCK: "A product variant sells out",
  VARIANTS_IN_STOCK: "A sold-out product variant is back in stock",
  INVENTORY_LEVELS_UPDATE: "The stock of an item at a location changes",
  FULFILLMENTS_CREATE: "A shipment is made for an order",
  FULFILLMENTS_UPDATE: "A shipment changes, like its tracking number",
  FULFILLMENT_EVENTS_CREATE: "A shipment's delivery status changes (out for delivery, delivered…)",
  DISPUTES_CREATE: "A customer disputes a payment (a chargeback)",
  RETURNS_REQUEST: "A customer asks to return items",
  APP_UNINSTALLED: "Emplio's app is removed from the store",
  BULK_OPERATIONS_FINISH: "A bulk export or import finishes",
};
const describe = (topic: string) => SAID[topic] ?? `Shopify reports ${topic.toLowerCase().replace(/_/g, " ")}`;

// Composio's names → Shopify's topic
const COMPOSIO: Record<string, string> = {
  bulk_operation_finished: "BULK_OPERATIONS_FINISH",
  collection_created: "COLLECTIONS_CREATE",
  collection_deleted: "COLLECTIONS_DELETE",
  collection_updated: "COLLECTIONS_UPDATE",
  customer_segment_created: "SEGMENTS_CREATE",
  customer_segment_deleted: "SEGMENTS_DELETE",
  customer_segment_updated: "SEGMENTS_UPDATE",
  discount_code_added: "DISCOUNTS_REDEEMCODE_ADDED",
  discount_code_removed: "DISCOUNTS_REDEEMCODE_REMOVED",
  discount_created: "DISCOUNTS_CREATE",
  discount_deleted: "DISCOUNTS_DELETE",
  discount_updated: "DISCOUNTS_UPDATE",
  inventory_item_created: "INVENTORY_ITEMS_CREATE",
  inventory_item_deleted: "INVENTORY_ITEMS_DELETE",
  inventory_item_updated: "INVENTORY_ITEMS_UPDATE",
  inventory_level_updated: "INVENTORY_LEVELS_UPDATE",
  inventory_shipment_created: "INVENTORY_SHIPMENTS_CREATE",
  inventory_shipment_in_transit: "INVENTORY_SHIPMENTS_MARK_IN_TRANSIT",
  inventory_shipment_items_received: "INVENTORY_SHIPMENTS_RECEIVE_ITEMS",
  inventory_shipment_tracking_updated: "INVENTORY_SHIPMENTS_UPDATE_TRACKING",
  inventory_stocked_at_location: "INVENTORY_LEVELS_CONNECT",
  inventory_transfer_ready_to_ship: "INVENTORY_TRANSFERS_READY_TO_SHIP",
  inventory_unstocked_at_location: "INVENTORY_LEVELS_DISCONNECT",
  location_activated: "LOCATIONS_ACTIVATE",
  location_created: "LOCATIONS_CREATE",
  location_deactivated: "LOCATIONS_DEACTIVATE",
  location_deleted: "LOCATIONS_DELETE",
  location_updated: "LOCATIONS_UPDATE",
  market_created: "MARKETS_CREATE",
  market_updated: "MARKETS_UPDATE",
  metafield_definition_created: "METAFIELD_DEFINITIONS_CREATE",
  metafield_definition_deleted: "METAFIELD_DEFINITIONS_DELETE",
  metafield_definition_updated: "METAFIELD_DEFINITIONS_UPDATE",
  product_created: "PRODUCTS_CREATE",
  product_deleted: "PRODUCTS_DELETE",
  product_updated: "PRODUCTS_UPDATE",
  product_variant_back_in_stock: "VARIANTS_IN_STOCK",
  product_variant_out_of_stock: "VARIANTS_OUT_OF_STOCK",
  shipping_profile_created: "PROFILES_CREATE",
  shipping_profile_deleted: "PROFILES_DELETE",
  shipping_profile_updated: "PROFILES_UPDATE",
  shop_settings_updated: "SHOP_UPDATE",
  store_language_added: "LOCALES_CREATE",
  store_language_removed: "LOCALES_DESTROY",
  store_language_updated: "LOCALES_UPDATE",
};

// our trigger name → Shopify's topic
export const events: Record<string, string> = {
  ...Object.fromEntries(topics.map((t) => [t.toLowerCase(), t])),
  ...COMPOSIO,
  inventory_low: "INVENTORY_LEVELS_UPDATE",
};

const OUTPUT: ActionDetail["input"] = [
  { name: "topic", type: "string", required: true, description: "What happened, as Shopify names it, like orders/create" },
  { name: "id", type: "number", required: false, description: "The order's, product's (…) number in Shopify" },
  { name: "admin_graphql_api_id", type: "string", required: false, description: "Its Shopify id (gid://shopify/Order/123), to look it up with get_order and the like" },
  { name: "…", type: "object", required: false, description: "Every other field of the thing it's about, as Shopify sends it: an order has name, email, total_price, line_items, customer…" },
];
const LOW: ActionDetail["input"] = [
  { name: "below", type: "number", required: true, description: "Start only when the stock left is less than this many" },
  { name: "location_id", type: "number", required: false, description: "Only this location (its number, from list_locations' legacyResourceId)" },
];
const LOCATION: ActionDetail["input"] = [LOW[1]!];

export const triggers: Record<string, { description: string; config?: ActionDetail["input"]; output: ActionDetail["input"] }> = Object.fromEntries(
  Object.entries(events).map(([name, topic]) => [
    name,
    name === "inventory_low"
      ? {
          description: "An item's stock at a location drops below a level you choose. It starts on every stock change while it stays below, so say in the prompt to check whether you already acted.",
          config: LOW,
          output: [{ name: "inventory_item_id", type: "number", required: true, description: "The item (a variant's stock record)" }, { name: "location_id", type: "number", required: true, description: "Where" }, { name: "available", type: "number", required: true, description: "How many are left" }],
        }
      : { description: `${describe(topic)} in your Shopify store.`, ...(topic.startsWith("INVENTORY_LEVELS") && { config: LOCATION }), output: OUTPUT },
  ]),
);

// filters the server applies: stock level and location
export const wanted = (config: unknown, data: unknown) => {
  const c = (config ?? {}) as { below?: number; location_id?: number | string };
  const d = (data ?? {}) as { available?: number | null; location_id?: number };
  if (c.location_id !== undefined && c.location_id !== "" && String(c.location_id) !== String(d.location_id)) return false;
  if (c.below !== undefined && !(typeof d.available === "number" && d.available < Number(c.below))) return false;
  return true;
};

const hookToken = (connection: string) => createHmac("sha256", process.env.ENCRYPTION_KEY!).update(`shopify-webhook:${connection}`).digest("hex");
const hookUrl = (connection: string) => `${process.env.WEBHOOK_URL}/webhooks/app/shopify/${connection}/${hookToken(connection)}`;
export const watchId = (connection: string, topic: string) => `shopify:${connection}:${topic}`;

type Sub = { id: string; topic: string; uri: string };
const ours = async (key: string, uri: string) =>
  // ponytail: first 100 of ours; a connection can't have more than the ~240 topics, and only ones automations use
  ((await graphql(key, "query($uri: String) { webhookSubscriptions(first: 100, uri: $uri) { nodes { id topic uri } } }", { uri })).webhookSubscriptions.nodes as Sub[]).filter((s) => s.uri === uri);

// Make sure this connection has a subscription for `topic`.
export async function watch(key: string, connection: string, topic: string) {
  if (!process.env.WEBHOOK_URL) throw new AppsError("this server can't receive Shopify's events (WEBHOOK_URL isn't set)");
  const uri = hookUrl(connection);
  if (!(await ours(key, uri)).some((s) => s.topic === topic)) {
    const out = await graphql(
      key,
      "mutation($topic: WebhookSubscriptionTopic!, $sub: WebhookSubscriptionInput!) { webhookSubscriptionCreate(topic: $topic, webhookSubscription: $sub) { webhookSubscription { id } userErrors { field message } } }",
      { topic, sub: { uri, format: "JSON" } },
    );
    const why = userErrors(out.webhookSubscriptionCreate);
    if (why) throw new AppsError(`Shopify won't send ${topic.toLowerCase().replace("_", "/")} events: ${why}. The app may need the matching read permission (scope)`);
  }
  return watchId(connection, topic);
}

export async function unwatch(key: string, id: string) {
  const [, connection = "", topic = ""] = id.split(":");
  for (const s of await ours(key, hookUrl(connection)))
    if (s.topic === topic) await graphql(key, "mutation($id: ID!) { webhookSubscriptionDelete(id: $id) { deletedWebhookSubscriptionId userErrors { field message } } }", { id: s.id });
}

const header = (d: Delivery, name: string) => {
  const v = d.headers[name];
  return String(Array.isArray(v) ? v[0] : (v ?? ""));
};
const same = (a: Buffer, b: Buffer) => a.length === b.length && timingSafeEqual(a, b);

// orders/create → ORDERS_CREATE
export const topicOf = (header: string) => header.toUpperCase().replace(/\//g, "_");

export async function receive(delivery: Delivery, key: string) {
  if (!same(Buffer.from(delivery.rest.split("/")[0] ?? ""), Buffer.from(hookToken(delivery.connection)))) return null;
  const { clientSecret } = parseKey(key);
  if (clientSecret) {
    const want = createHmac("sha256", clientSecret).update(delivery.body).digest();
    if (!same(Buffer.from(header(delivery, "x-shopify-hmac-sha256"), "base64"), want)) return null;
  }
  const topic = topicOf(header(delivery, "x-shopify-topic"));
  const delivered = header(delivery, "x-shopify-webhook-id");
  const out: WebhookEvent = {
    ...(delivered && { id: `${delivery.connection}:${delivered}` }),
    triggers: Object.keys(events).filter((name) => events[name] === topic),
    data: { topic: header(delivery, "x-shopify-topic"), ...(JSON.parse(delivery.body) as object) },
    watch: watchId(delivery.connection, topic),
  };
  return { events: async () => [out] };
}
