// Klaviyo starts automations by polling: its webhooks need a paid add-on most accounts don't have, while the events,
// profiles, lists, campaigns and reviews lists below work on every plan. Every activity in Klaviyo (an order, a
// sign-up, an email opened...) is an event under a metric; new_event takes any of them by name.
import { z } from "zod";
import type { PollTrigger, Run } from "./index";

const DAY = 86_400_000;
// Klaviyo's filter syntax: greater-than(created,2026-11-21T10:00:00Z)
const since = (field: string, op = "greater-than") => `${op}(${field},${new Date(Date.now() - DAY).toISOString().replace(/\.\d+Z$/, "Z")})`;
type Resource = { id: string; type: string; attributes?: Record<string, any>; relationships?: Record<string, { data?: { id: string; type: string } | null }> };
type Page = { data?: Resource[]; included?: Resource[]; links?: { next?: string | null } };
const rows = (out: unknown) => ((out as Page)?.data ?? []) as Resource[];
const flat = (r: Resource) => ({ id: r.id, ...r.attributes });

// metric names → their ids; one name can have several (one per integration, e.g. Shopify's and the API's "Placed Order")
export async function metricIds(names: string[], run: Run) {
  const want = new Set(names.map((n) => n.trim().toLowerCase()));
  const ids: string[] = [];
  let cursor: string | undefined;
  // ponytail: five pages of metrics (hundreds); accounts with more get the first five pages' matches
  for (let i = 0; i < 5; i++) {
    const page = (await run("klaviyo.get_metrics", cursor ? { "page[cursor]": cursor } : {})) as Page;
    for (const m of page.data ?? []) if (want.has(String(m.attributes?.name ?? "").toLowerCase())) ids.push(m.id);
    const next = page.links?.next;
    cursor = next ? (new URL(next).searchParams.get("page[cursor]") ?? undefined) : undefined;
    if (!cursor) break;
  }
  return ids;
}

const EVENT_OUT = [
  { name: "event", type: "object", required: true, description: "The event: id, metric (what happened, like Placed Order), datetime, properties (order items, value, the email's subject...), profile (the person: id, email, phone_number, first_name, last_name)" },
];
// the newest events of these metrics in the last day, with the metric's name and the person on each
// ponytail: the newest 1000 per metric per check; a busier metric (opens on a big send) loses the rest
async function events(names: string[], run: Run) {
  const out: { id: string; item: unknown }[] = [];
  for (const metric of await metricIds(names, run)) {
    const page = (await run("klaviyo.get_events", { filter: `equals(metric_id,"${metric}"),${since("datetime")}`, sort: "-datetime", include: ["metric", "profile"], "page[size]": 1000 })) as Page;
    const inc = new Map((page.included ?? []).map((r) => [`${r.type}:${r.id}`, r]));
    for (const e of page.data ?? []) {
      const m = e.relationships?.metric?.data;
      const p = e.relationships?.profile?.data;
      const person = p ? inc.get(`profile:${p.id}`) : undefined;
      const a = e.attributes ?? {};
      out.push({
        id: e.id,
        item: {
          event: {
            id: e.id,
            metric: (m && inc.get(`metric:${m.id}`)?.attributes?.name) ?? metric,
            datetime: a.datetime,
            properties: a.event_properties,
            ...(person && { profile: { id: person.id, ...pick(person.attributes, ["email", "phone_number", "first_name", "last_name", "organization", "external_id"]) } }),
          },
        },
      });
    }
  }
  return out;
}
const pick = (o: Record<string, any> | undefined, keys: string[]) => Object.fromEntries(keys.filter((k) => o?.[k] != null).map((k) => [k, o![k]]));

const metric = (description: string, names: string[]): PollTrigger => ({
  description: `${description} (checked every 5 minutes; Klaviyo calls it ${names.map((n) => `"${n}"`).join(" or ")}).`,
  config: z.object({}),
  output: EVENT_OUT,
  every: 5,
  min: 1,
  poll: (_c, run) => events(names, run),
});

const listed = (description: string, field: string, what: string, list: (c: any, run: Run) => Promise<{ id: string; item: unknown }[]>, config: z.ZodObject = z.object({})): PollTrigger => ({
  description,
  config,
  output: [{ name: field, type: "object", required: true, description: what }],
  every: 5,
  min: 1,
  poll: list,
});
const each = (field: string, id: (r: Resource) => string = (r) => r.id) => (out: unknown) => rows(out).map((r) => ({ id: id(r), item: { [field]: flat(r) } }));

export const klaviyo: Record<string, PollTrigger> = {
  new_event: {
    description: "Something happens in Klaviyo that it records as an event: an order, a sign-up, an email opened or clicked, a form sent, a text received... Name which in metric, as Klaviyo shows it under Analytics → Metrics (checked every 5 minutes).",
    config: z.object({
      metric: z.string().min(1).describe('The metric\'s name as Klaviyo shows it, like "Placed Order", "Opened Email" or "Active on Site"; several separated by commas. get_metrics lists them'),
    }),
    output: EVENT_OUT,
    every: 5,
    min: 1,
    poll: ({ metric }, run) => events(String(metric).split(","), run),
  },
  new_order: metric("A customer places an order, from the shop connected to Klaviyo (Shopify, WooCommerce...) or sent by API", ["Placed Order"]),
  checkout_started: metric("A customer starts checkout and gets as far as entering their email", ["Started Checkout"]),
  order_fulfilled: metric("An order is fulfilled (shipped)", ["Fulfilled Order"]),
  order_cancelled: metric("An order is cancelled", ["Cancelled Order"]),
  order_refunded: metric("An order is refunded", ["Refunded Order"]),
  subscribed: metric("Someone subscribes: to a list, or to email or text marketing", ["Subscribed to List", "Subscribed to Email Marketing", "Subscribed to SMS Marketing"]),
  unsubscribed: metric("Someone unsubscribes from emails, texts or a list", ["Unsubscribed", "Unsubscribed from Email Marketing", "Unsubscribed from SMS Marketing", "Unsubscribed from List"]),
  form_submitted: metric("Someone fills in a Klaviyo sign-up form", ["Form submitted by profile", "Submitted Form"]),
  email_bounced: metric("An email to someone bounces", ["Bounced Email"]),
  email_marked_spam: metric("Someone marks an email as spam", ["Marked Email as Spam"]),
  new_profile: listed(
    "A new profile (contact) is added in Klaviyo (checked every 5 minutes).",
    "profile",
    "The profile: id, email, phone_number, first_name, last_name, organization, location, properties, created",
    async (_c, run) => each("profile")(await run("klaviyo.get_profiles", { filter: since("created"), sort: "-created", "page[size]": 100 })),
  ),
  profile_updated: listed(
    "A profile (contact) changes in Klaviyo: their details or custom properties (checked every 5 minutes). A run that changes the same profile starts this again, so say in the prompt when to stop.",
    "profile",
    "The profile as it is now: id, email, phone_number, first_name, last_name, organization, location, properties, updated",
    async (_c, run) => each("profile", (r) => `${r.id}:${r.attributes?.updated}`)(await run("klaviyo.get_profiles", { filter: since("updated"), sort: "-updated", "page[size]": 100 })),
  ),
  new_list_member: listed(
    "Someone joins a Klaviyo list (checked every 5 minutes).",
    "profile",
    "The person who joined: id, email, phone_number, first_name, last_name, joined_group_at",
    async ({ list_id }, run) => each("profile")(await run("klaviyo.get_list_profiles", { id: list_id, filter: since("joined_group_at"), sort: "-joined_group_at", "page[size]": 100 })),
    z.object({ list_id: z.string().min(1).describe("The list's id (get_lists lists them; it's also in the list's address in Klaviyo)") }),
  ),
  new_segment_member: listed(
    "Someone enters a Klaviyo segment (checked every 5 minutes).",
    "profile",
    "The person who entered: id, email, phone_number, first_name, last_name, joined_group_at",
    async ({ segment_id }, run) => each("profile")(await run("klaviyo.get_segment_profiles", { id: segment_id, filter: since("joined_group_at"), sort: "-joined_group_at", "page[size]": 100 })),
    z.object({ segment_id: z.string().min(1).describe("The segment's id (get_segments lists them)") }),
  ),
  new_list: listed(
    "A list is created in Klaviyo (checked every 5 minutes).",
    "list",
    "The list: id, name, opt_in_process, created",
    async (_c, run) => each("list")(await run("klaviyo.get_lists", { filter: since("created"), sort: "-created" })),
  ),
  new_segment: listed(
    "A segment is created in Klaviyo (checked every 5 minutes).",
    "segment",
    "The segment: id, name, definition, is_active, created",
    async (_c, run) => each("segment")(await run("klaviyo.get_segments", { filter: since("created"), sort: "-created" })),
  ),
  campaign_sent: listed(
    "A Klaviyo campaign (email, text or push) finishes going out (checked every 5 minutes). query_campaign_values gives its opens, clicks and revenue.",
    "campaign",
    "The campaign: id, name, status, send_time, audiences, send_options",
    async (_c, run) =>
      rows(await run("klaviyo.get_campaigns", { filter: since("updated_at"), sort: "-updated_at", "page[size]": 100 }))
        .filter((r) => r.attributes?.status === "Sent")
        .map((r) => ({ id: r.id, item: { campaign: flat(r) } })),
  ),
  new_review: listed(
    "A product or store review, rating or question comes in through Klaviyo Reviews (checked every 5 minutes). Optionally only low ratings.",
    "review",
    "The review: id, rating, title, content, author, email, status, review_type, verified, product, created",
    async ({ max_rating }, run) =>
      each("review")(await run("klaviyo.get_reviews", { filter: [since("created", "greater-or-equal"), ...(max_rating ? [`less-or-equal(rating,${max_rating})`] : [])].join(","), sort: "-created", "page[size]": 100 })),
    z.object({ max_rating: z.number().int().min(1).max(5).optional().describe("Only reviews with this many stars or fewer, like 2 to catch unhappy customers") }),
  ),
};
