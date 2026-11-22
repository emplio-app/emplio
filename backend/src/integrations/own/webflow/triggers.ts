// Webflow telling us what happens on a site the moment it happens. Webflow's webhooks are per site and per event type
// (triggerType), so a connection has one webhook for each type its automations use, all at
// /webhooks/app/webflow/<connection>/<token>. Filters (a form, a collection, a page, an order status) are checked here.
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { ActionDetail } from "@emplio/shared";
import { AppsError } from "../../types";
import type { Delivery } from "../index";
import { type Api, call, type Send } from "../openapi";

type Field = ActionDetail["input"][number];
const SITE: Field = { name: "site_id", type: "string", required: false, description: "The site to watch (its id; list_webflow_sites lists them). Leave out: the site the API token is for" };
const FORM_NAME: Field = { name: "form_name", type: "string", required: false, description: "Only submissions of the form with this name, as named in the Webflow Designer (list_forms lists them)" };
const FORM_ID: Field = { name: "form_id", type: "string", required: false, description: "Only submissions of this form (its id; list_forms lists them)" };
const COLLECTION: Field = { name: "collection_id", type: "string", required: false, description: "Only items in this CMS collection, like Blog Posts (its id; list_collections lists them)" };
const PAGE: Field = { name: "page_id", type: "string", required: false, description: "Only this page (its id; list_pages lists them)" };
const STATUS: Field = { name: "status", type: "string", required: false, description: "Only when the order's status is now this: pending, unfulfilled, fulfilled, disputed, dispute-lost or refunded" };

const out = (what: string): ActionDetail["input"] => [
  { name: "event", type: "string", required: true, description: "Webflow's name for what happened, like form_submission or collection_item_changed" },
  { name: "payload", type: "object", required: true, description: what },
];
const ITEM = out("The CMS item: id, collectionId, siteId, fieldData (name, slug and the collection's own fields), isDraft, isArchived, createdOn, lastUpdated, lastPublished");
const PAGE_OUT = out("The page: pageId, pageTitle, siteId, publishedPath, draft, archived, and when it happened");
const ORDER = out("The order: orderId, status, customerInfo (fullName, email), purchasedItems, totals, customerPaid, shippingAddress, billingAddress, comment, acceptedOn, fulfilledOn, refundedOn");
const AGAIN = " A run that changes the same item starts this again, so say in the prompt when to stop.";

// trigger → [Webflow's triggerType, description, config, output]
const T: Record<string, [string, string, Field[], ActionDetail["input"]]> = {
  new_form_submission: ["form_submission", "Someone filled in a form on the Webflow site (contact, quote request, sign-up...). payload.data has their answers by field name.", [SITE, FORM_NAME, FORM_ID], out("The submission: name (the form's), formId, data (the answers by field name), submittedAt, id")],
  site_published: ["site_publish", "The Webflow site was published.", [SITE], out("siteId, publishedOn, domains, publishedBy (displayName), publishScope (site or page) and pageId for a single page")],
  page_created: ["page_created", "A page was added to the Webflow site.", [SITE], PAGE_OUT],
  page_updated: ["page_metadata_updated", "A page's settings on the Webflow site changed: title, slug, SEO or Open Graph details." + AGAIN, [SITE, PAGE], PAGE_OUT],
  page_deleted: ["page_deleted", "A page was deleted from the Webflow site.", [SITE, PAGE], PAGE_OUT],
  new_order: ["ecomm_new_order", "Someone placed an order in the Webflow site's shop.", [SITE], ORDER],
  order_updated: ["ecomm_order_changed", "An order in the Webflow site's shop changed: fulfilled, refunded, disputed or edited. status filters to one state." + AGAIN, [SITE, STATUS], ORDER],
  inventory_changed: ["ecomm_inventory_changed", "The stock count of a product variant (SKU) in the Webflow site's shop changed.", [SITE], out("id (the SKU's), quantity, inventoryType (finite or infinite)")],
  collection_item_created: ["collection_item_created", "An item was added to a CMS collection on the Webflow site (a blog post, a team member, a product...).", [SITE, COLLECTION], ITEM],
  collection_item_updated: ["collection_item_changed", "A CMS item on the Webflow site changed." + AGAIN, [SITE, COLLECTION], ITEM],
  collection_item_deleted: ["collection_item_deleted", "A CMS item was deleted from the Webflow site.", [SITE, COLLECTION], ITEM],
  collection_item_published: ["collection_item_published", "A CMS item on the Webflow site went live.", [SITE, COLLECTION], ITEM],
  collection_item_unpublished: ["collection_item_unpublished", "A CMS item on the Webflow site was taken off the live site.", [SITE, COLLECTION], ITEM],
  new_comment: ["comment_created", "Someone commented on the Webflow site in the Designer, or replied to a comment. A reply Emplio posts (create_comment_reply) starts this again, so say in the prompt when not to reply.", [SITE, PAGE], out("threadId, commentId, content, author (name, email), pageId, url, isResolved, mentionedUsers, createdOn")],
};

export const triggers = Object.fromEntries(Object.entries(T).map(([name, [, description, config, output]]) => [name, { description, config, output }]));
export const events: Record<string, string> = Object.fromEntries(Object.entries(T).map(([name, [type]]) => [name, type]));

export type EventData = { event: string; payload: Record<string, any> };
export const wanted = (config: unknown, data: unknown) => {
  const want = (config ?? {}) as Record<string, string | undefined>;
  const p = (data as EventData).payload ?? {};
  // a publish can carry several items at once
  const item = Array.isArray(p.items) ? (p.items[0] ?? {}) : p;
  const same = (w: string | undefined, got: unknown) => !w || w === String(got ?? "");
  return same(want.form_name, p.name) && same(want.form_id, p.formId) && same(want.collection_id, item.collectionId) && same(want.page_id, p.pageId) && same(want.status, p.status);
};

// ponytail: Webflow signs with a key it makes per webhook (we'd have to store it), so an unguessable URL proves the
// sender. Ceiling: a leaked URL can forge events; store each webhook's secretKey and check x-webflow-signature if that matters
const hookToken = (connection: string) => createHmac("sha256", process.env.ENCRYPTION_KEY!).update(`webflow-webhook:${connection}`).digest("hex");
const hookUrl = (connection: string) => `${process.env.WEBHOOK_URL}/webhooks/app/webflow/${connection}/${hookToken(connection)}`;

const send = (method: string, path: string, fields: string[] = []): Send => ({ method, path, query: [], headers: [], ...(fields.length && { body: { kind: "fields" as const, fields: fields.map((f): [string, string] => [f, f]) } }) });
type Hook = { id: string; triggerType: string; url: string };
const ours = async (api: Api, key: string, site: string, connection: string, type: string) => {
  const { webhooks } = (await call(api, key, send("GET", "/sites/{site_id}/webhooks"), { site_id: site })) as { webhooks?: Hook[] };
  return (webhooks ?? []).filter((h) => h.url === hookUrl(connection) && h.triggerType === type);
};

// the site in the trigger's settings, or the one the site token is for
async function siteOf(api: Api, key: string, config: unknown) {
  const given = (config as { site_id?: string } | null)?.site_id;
  if (given) return given;
  const { sites } = (await call(api, key, send("GET", "/sites"), {})) as { sites?: { id: string }[] };
  if (sites?.length !== 1) throw new AppsError("site_id: this Webflow token covers several sites; say which one (list_webflow_sites lists them)");
  return sites[0]!.id;
}

export async function watch(api: Api, key: string, connection: string, type: string, config: unknown) {
  if (!process.env.WEBHOOK_URL) throw new AppsError("this server can't receive Webflow's events (WEBHOOK_URL isn't set)");
  const site = await siteOf(api, key, config);
  if (!(await ours(api, key, site, connection, type)).length) await call(api, key, send("POST", "/sites/{site_id}/webhooks", ["triggerType", "url"]), { site_id: site, triggerType: type, url: hookUrl(connection) });
  return `webflow:${connection}:${site}:${type}`;
}

export async function unwatch(api: Api, key: string, id: string) {
  const [, connection = "", site = "", type = ""] = id.split(":");
  for (const h of await ours(api, key, site, connection, type)) await call(api, key, send("DELETE", "/webhooks/{webhook_id}"), { webhook_id: h.id });
}

export async function receive(delivery: Delivery) {
  const want = Buffer.from(hookToken(delivery.connection));
  const got = Buffer.from(delivery.rest.split("/")[0] ?? "");
  if (got.length !== want.length || !timingSafeEqual(got, want)) return null;
  const body = JSON.parse(delivery.body || "{}") as { triggerType?: string; payload?: Record<string, any> };
  const names = Object.entries(T).filter(([, [type]]) => type === body.triggerType).map(([n]) => n);
  // Webflow sends no delivery id; a retry is the same body
  const id = `${delivery.connection}:${createHash("sha256").update(delivery.body).digest("hex").slice(0, 32)}`;
  const data: EventData = { event: body.triggerType ?? "", payload: body.payload ?? {} };
  return { events: async () => (names.length ? [{ id, triggers: names, data }] : []) };
}
