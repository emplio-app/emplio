import { z } from "zod";
import { type PollTrigger, type Run, recent } from "./index";

// Wix sends webhooks only to a Wix app registered in its dev center, never to an API key, so every event is found by
// listing the newest rows. "Changed" events put the change in the id (<id>:<updatedDate>), so each change counts once.
// ponytail: the 100 newest rows of the last day; a site changing more than that between checks misses the older ones
type Row = Record<string, any>;
const DESC = (field: string) => [{ fieldName: field, order: "DESC" }];
const since = () => new Date(Date.now() - 86_400_000).toISOString();

const rows = async (run: Run, action: string, input: unknown, key: string): Promise<Row[]> => ((await run(`wix.${action}`, input)) as Row)?.[key] ?? [];

const trigger = (
  description: string,
  name: string,
  list: (config: any, run: Run) => Promise<Row[]>,
  id: (row: Row) => string = (row) => String(row.id),
  config: z.ZodObject = z.object({}),
): PollTrigger => ({
  description,
  config,
  output: [{ name, type: "object", required: true, description: `The Wix ${name}, as Wix's API returns it` }],
  every: 5,
  min: 5,
  async poll(c, run) {
    return (await list(c, run)).map((row) => ({ id: id(row), item: { [name]: row } }));
  },
});

// eCommerce orders (Stores, Bookings and every app that sells through Wix checkout), filtered by Wix
const orders = (filter: Row, by = "updatedDate") => (_c: unknown, run: Run) =>
  rows(run, "query_e_commerce_orders", { search: { filter: { ...filter, [by]: { $gte: since() } }, sort: DESC(by), cursorPaging: { limit: 100 } } }, "orders");

const contacts = (by: string) => (_c: unknown, run: Run) =>
  rows(run, "query_contacts", { query: { filter: { [by]: { $gte: since() } }, sort: DESC("createdDate"), paging: { limit: 100 } } }, "contacts");

// a query sorted newest first, kept to the last day here (not every API filters on its dates)
const newest = (action: string, key: string, by = "createdDate", extra: Row = {}) => async (_c: unknown, run: Run) =>
  (await rows(run, action, { ...extra, query: { ...extra.query, sort: DESC(by), cursorPaging: { limit: 100 } } }, key)).filter((r) => recent(r[by]));

const bookings = (by: string) => async (_c: unknown, run: Run) =>
  (await rows(run, "query_extended_bookings", { query: { sort: DESC(by), cursorPaging: { limit: 100 } } }, "extendedBookings")).map((e) => e.booking ?? e).filter((b) => recent(b[by]));

// Stores has two catalogs: v3 on newer sites, v1 on older ones (v3's calls fail there)
async function stores<T>(v3: () => Promise<T>, v1: () => Promise<T>) {
  try {
    return await v3();
  } catch {
    return v1();
  }
}

const LOW = z.object({ threshold: z.number().default(5).describe("Stock at or below this counts as low (default 5)") });

export const wix: Record<string, PollTrigger> = {
  order_created: trigger("A new order is placed on the Wix site (store, bookings or any Wix checkout).", "order", orders({}, "createdDate")),
  order_updated: trigger("A Wix order is placed or changed.", "order", orders({}), (o) => `${o.id}:${o.updatedDate}`),
  order_paid: trigger("A Wix order is paid in full.", "order", orders({ paymentStatus: "PAID" }), (o) => `${o.id}:paid`),
  order_fulfilled: trigger("A Wix order is fully fulfilled (shipped or delivered).", "order", orders({ fulfillmentStatus: "FULFILLED" }), (o) => `${o.id}:fulfilled`),
  order_canceled: trigger("A Wix order is canceled.", "order", orders({ status: "CANCELED" }), (o) => `${o.id}:canceled`),

  contact_created: trigger("A new contact is added to the Wix site's contact list.", "contact", contacts("createdDate")),
  contact_updated: trigger("A Wix contact is added or changed.", "contact", contacts("updatedDate"), (c) => `${c.id}:${c.revision ?? c.updatedDate}`),
  member_created: trigger("Someone new signs up as a member of the Wix site.", "member", async (_c, run) =>
    (await rows(run, "query_members", { query: { sorting: DESC("createdDate"), paging: { limit: 100 } } }, "members")).filter((m) => recent(m.createdDate)),
  ),

  form_submission_created: trigger(
    "Someone submits a form on the Wix site.",
    "submission",
    async (c: { namespace: string; formId?: string }, run) =>
      (await rows(run, "query_submissions_by_namespace", { query: { filter: { namespace: c.namespace, ...(c.formId && { formId: c.formId }) }, sort: DESC("createdDate"), cursorPaging: { limit: 100 } } }, "submissions")).filter((s) =>
        recent(s.createdDate),
      ),
    undefined,
    z.object({
      namespace: z.string().default("wix.form_app.form").describe("Which kind of form: wix.form_app.form for Wix Forms (default)"),
      formId: z.string().optional().describe("Only this form (its id); every form if left out"),
    }),
  ),

  booking_created: trigger("A new booking is made on the Wix site.", "booking", bookings("createdDate")),
  booking_updated: trigger("A Wix booking is made or changed (confirmed, rescheduled, canceled…).", "booking", bookings("updatedDate"), (b) => `${b.id}:${b.updatedDate}`),
  booking_canceled: trigger("A Wix booking is canceled.", "booking", async (c, run) => (await bookings("updatedDate")(c, run)).filter((b) => b.status === "CANCELED"), (b) => `${b.id}:canceled`),

  blog_post_published: trigger("A new blog post is published on the Wix site.", "post", async (_c, run) =>
    (await rows(run, "list_posts", { sort: "PUBLISHED_DATE_DESC", "paging.limit": 100 }, "posts")).filter((p) => recent(p.firstPublishedDate)),
  ),

  product_created: trigger("A new product is added to the Wix store.", "product", (c, run) =>
    stores(
      () => newest("query_products", "products")(c, run),
      async () => (await rows(run, "catalog_query_products", { query: { paging: { limit: 100 } }, includeHiddenProducts: true }, "products")).filter((p) => recent(p.createdDate)),
    ),
  ),
  low_stock: trigger(
    "A Wix store item's stock falls to the low-stock level or below (again each time it changes while low).",
    "item",
    (c: { threshold: number }, run) =>
      stores(
        async () => (await newest("query_inventory_items", "inventoryItems", "updatedDate")(c, run)).filter((i) => i.trackQuantity !== false && typeof i.quantity === "number" && i.quantity <= c.threshold),
        async () =>
          (await rows(run, "query_inventory", { query: { paging: { limit: 100 } } }, "inventoryItems")).flatMap((i) =>
            i.trackQuantity ? (i.variants ?? []).filter((v: Row) => typeof v.quantity === "number" && v.quantity <= c.threshold).map((v: Row) => ({ ...i, variants: undefined, variantId: v.variantId, quantity: v.quantity, id: `${i.id}:${v.variantId}` })) : [],
          ),
      ),
    (i) => `${i.id}:${i.quantity}`,
    LOW,
  ),

  cms_item_created: trigger(
    "A new item is added to a Wix CMS collection.",
    "item",
    async (c: { collection: string }, run) =>
      (await rows(run, "query_data_items", { dataCollectionId: c.collection, query: { sort: DESC("_createdDate"), paging: { limit: 100 } } }, "dataItems")).filter((i) => recent(i.data?._createdDate?.$date ?? i.data?._createdDate)),
    undefined,
    z.object({ collection: z.string().describe("The CMS collection's id, as list_data_collections shows it") }),
  ),
  cms_item_updated: trigger(
    "An item in a Wix CMS collection is added or changed.",
    "item",
    async (c: { collection: string }, run) =>
      (await rows(run, "query_data_items", { dataCollectionId: c.collection, query: { sort: DESC("_updatedDate"), paging: { limit: 100 } } }, "dataItems")).filter((i) => recent(i.data?._updatedDate?.$date ?? i.data?._updatedDate)),
    (i) => `${i.id}:${JSON.stringify(i.data?._updatedDate)}`,
    z.object({ collection: z.string().describe("The CMS collection's id, as list_data_collections shows it") }),
  ),

  event_rsvp_created: trigger("Someone RSVPs to an event on the Wix site.", "rsvp", newest("query_rsvps", "rsvps")),
  event_order_created: trigger("Someone buys tickets to an event on the Wix site.", "order", async (_c, run) =>
    (await rows(run, "list_orders", { limit: 100, sort: "created:desc" }, "orders")).filter((o) => recent(o.created)), (o) => String(o.orderNumber ?? o.id),
  ),
  pricing_plan_order_created: trigger("Someone buys or is given a pricing plan (membership, subscription) on the Wix site.", "order", async (_c, run) =>
    (await rows(run, "list_pricing_plan_orders", { limit: 50, "sorting.fieldName": "createdDate", "sorting.order": "DESC" }, "orders")).filter((o) => recent(o.createdDate)),
  ),

  invoice_created: trigger("A new invoice is created on the Wix site.", "invoice", newest("query_invoices", "invoices")),
  invoice_paid: trigger("A Wix invoice is paid in full.", "invoice", async (c, run) => (await newest("query_invoices", "invoices", "updatedDate")(c, run)).filter((i) => i.status === "PAID"), (i) => `${i.id}:paid`),
};
