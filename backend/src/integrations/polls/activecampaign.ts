// ActiveCampaign things its webhooks don't report: a contact added without joining a list, ecommerce orders, and
// tracked site visits and events. Everything else comes by webhook (own/activecampaign/triggers.ts).
import { z } from "zod";
import { recent, type PollTrigger, type Run } from "./index";

// ponytail: the newest page only (100 rows); a burst bigger than that between polls is missed
const listed = (
  description: string,
  field: string,
  what: string,
  list: (c: any, run: Run) => Promise<any[]>,
  when: (row: any) => unknown,
  config: z.ZodObject = z.object({}),
): PollTrigger => ({
  description,
  config,
  output: [{ name: field, type: "object", required: true, description: what }],
  every: 5,
  min: 1,
  poll: async (c, run) => (await list(c, run)).filter((row) => recent(when(row))).map((row) => ({ id: String(row.id), item: { [field]: row } })),
});
const rows = (out: unknown, key: string) => ((out as Record<string, unknown[] | undefined>)?.[key] ?? []) as any[];

export const activecampaign: Record<string, PollTrigger> = {
  new_contact: listed(
    "A contact is added in ActiveCampaign, whether or not they join a list (checked every 5 minutes). For sign-ups to a list the moment they happen, use contact_subscribed.",
    "contact",
    "The contact: id, email, firstName, lastName, phone, cdate",
    async (_c, run) => rows(await run("activecampaign.list_all_contacts", { "orders[cdate]": "desc", limit: 100 }), "contacts"),
    (row) => row.cdate ?? row.created_timestamp,
  ),
  new_ecommerce_order: listed(
    "An ecommerce order comes into ActiveCampaign from a connected store (checked every 5 minutes).",
    "order",
    "The order: id, externalid, email, totalPrice (in cents), currency, orderUrl, orderDate, customerid, connectionid",
    async (_c, run) => rows(await run("activecampaign.retrieve_all_orders", { "orders[external_created_date]": "DESC" }), "ecomOrders"),
    (row) => row.createdDate ?? row.tstamp,
  ),
  new_tracked_event: listed(
    "A contact visits a tracked page or a tracked event fires in ActiveCampaign (site and event tracking; checked every 5 minutes). Optionally only one kind.",
    "event",
    "The tracked event: id, type (__pagevisit for a page visit, or the event's name), value (the page or event data), subscriberid (the contact), tstamp",
    async ({ type }, run) => rows(await run("activecampaign.list_tracked_events_and_their_contacts", { "orders[tstamp]": "DESC", limit: 100, ...(type && { "filters[type]": type }) }), "trackingLogs"),
    (row) => row.tstamp,
    z.object({ type: z.string().optional().describe("Only this kind: __pagevisit for page visits, or an event's name like Order Shipped") }),
  ),
};
