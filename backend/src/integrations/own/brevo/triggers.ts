// Brevo telling us about email events the moment they happen, by webhook. A Brevo webhook has one type, so each
// connection gets one per type: transactional, marketing, and inbound (one per receiving domain), at
// /webhooks/app/brevo/<connection>/<kind>/<token>. A new event is added to the webhook that's there (Brevo can
// update one). Composio has no Brevo triggers, so the names are ours.
import type { ActionDetail } from "@emplio/shared";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { AppsError } from "../../types";
import type { Delivery, WebhookEvent } from "../index";
import { type Api, call, type Send } from "../openapi";

type Kind = "transactional" | "marketing" | "inbound";
// our trigger → [webhook type, the event Brevo registers, the event name its payload carries]
const TABLE: Record<string, [Kind, string, string, string]> = {
  transactional_email_sent: ["transactional", "request", "request", "An email you send through Brevo (transactional, like an order confirmation) is sent."],
  transactional_email_delivered: ["transactional", "delivered", "delivered", "A transactional email reaches the person's inbox."],
  transactional_email_opened: ["transactional", "opened", "opened", "Someone opens a transactional email (every time they open it)."],
  transactional_email_first_opened: ["transactional", "uniqueOpened", "unique_opened", "Someone opens a transactional email for the first time."],
  transactional_email_clicked: ["transactional", "click", "click", "Someone clicks a link in a transactional email."],
  transactional_email_soft_bounced: ["transactional", "softBounce", "soft_bounce", "A transactional email bounced for now (full inbox, server down); Brevo may try again."],
  transactional_email_hard_bounced: ["transactional", "hardBounce", "hard_bounce", "A transactional email bounced for good (the address doesn't exist)."],
  transactional_email_spam: ["transactional", "spam", "spam", "Someone marks a transactional email as spam."],
  transactional_email_invalid: ["transactional", "invalid", "invalid_email", "A transactional email wasn't sent because the address is invalid."],
  transactional_email_deferred: ["transactional", "deferred", "deferred", "A transactional email is delayed by the receiving server."],
  transactional_email_blocked: ["transactional", "blocked", "blocked", "Brevo blocked a transactional email (the address is blocked or unsubscribed)."],
  transactional_email_unsubscribed: ["transactional", "unsubscribed", "unsubscribed", "Someone unsubscribes from a transactional email."],
  campaign_email_delivered: ["marketing", "delivered", "delivered", "A campaign email reaches a contact's inbox."],
  campaign_email_opened: ["marketing", "opened", "opened", "A contact opens a campaign email."],
  campaign_email_clicked: ["marketing", "click", "click", "A contact clicks a link in a campaign email."],
  campaign_email_soft_bounced: ["marketing", "softBounce", "soft_bounce", "A campaign email bounced for now (full inbox, server down)."],
  campaign_email_hard_bounced: ["marketing", "hardBounce", "hard_bounce", "A campaign email bounced for good (the address doesn't exist)."],
  campaign_email_spam: ["marketing", "spam", "spam", "A contact marks a campaign email as spam."],
  campaign_unsubscribed: ["marketing", "unsubscribed", "unsubscribe", "A contact unsubscribes from your campaigns."],
  contact_added_to_list: ["marketing", "listAddition", "list_addition", "A contact is added to one of your Brevo lists. A run that adds the contact to another list starts this again, so say in the prompt when to stop."],
  contact_updated: ["marketing", "contactUpdated", "contact_updated", "A Brevo contact's details change. A run that updates the contact starts this again, so say in the prompt when to stop."],
  contact_deleted: ["marketing", "contactDeleted", "contact_deleted", "A Brevo contact is deleted."],
  inbound_email_received: ["inbound", "inboundEmailProcessed", "", "An email arrives at your Brevo receiving domain (like reply.yourdomain.com), already read and cleaned up by Brevo. The domain must point its MX records to Brevo first."],
};

// our trigger → "<type>:<event>", what start() is handed
export const events: Record<string, string> = Object.fromEntries(Object.entries(TABLE).map(([t, [kind, e]]) => [t, `${kind}:${e}`]));

const EMAIL_OUT: ActionDetail["input"] = [
  { name: "event", type: "string", required: true, description: "What happened, like delivered or click" },
  { name: "email", type: "string", required: false, description: "The person's email address" },
  { name: "subject", type: "string", required: false, description: "The email's subject" },
  { name: "message-id", type: "string", required: false, description: "Brevo's id for the email (transactional)" },
  { name: "camp_id", type: "number", required: false, description: "The campaign's id (campaign events)" },
  { name: "tags", type: "array", required: false, description: "The tags given when sending (transactional)" },
  { name: "link", type: "string", required: false, description: "The link clicked, on click events" },
  { name: "date", type: "string", required: false, description: "When it happened" },
];
const CONTACT_OUT: ActionDetail["input"] = [
  { name: "event", type: "string", required: true, description: "What happened, like list_addition" },
  { name: "email", type: "string", required: false, description: "The contact's email address" },
  { name: "list_id", type: "array", required: false, description: "On list_addition: the lists the contact is now in" },
  { name: "content", type: "array", required: false, description: "On contact_updated: what changed" },
  { name: "date", type: "string", required: false, description: "When it happened" },
];
const INBOUND_OUT: ActionDetail["input"] = [
  { name: "From", type: "object", required: true, description: "Who sent it: {Name, Address}" },
  { name: "To", type: "array", required: true, description: "Who it was sent to" },
  { name: "Subject", type: "string", required: true, description: "The subject" },
  { name: "ExtractedMarkdownMessage", type: "string", required: false, description: "The message itself, as text, without quoted replies or signature" },
  { name: "RawTextBody", type: "string", required: false, description: "The whole email as plain text" },
  { name: "InReplyTo", type: "string", required: false, description: "The Message-ID of the email this replies to" },
  { name: "Attachments", type: "array", required: false, description: "Attachments, each with a DownloadToken for download_inbound_attachment" },
];

const TAG = { name: "tag", type: "string", required: false, description: "Only emails sent with this tag" };
const CAMPAIGN = { name: "campaign_id", type: "number", required: false, description: "Only this campaign (its id, from list_email_campaigns)" };
const LIST = { name: "list_id", type: "number", required: false, description: "Only when the contact is added to this list (its id, from get_contact_lists)" };
const DOMAIN = { name: "domain", type: "string", required: true, description: "The receiving domain set up in Brevo for inbound emails, like reply.yourdomain.com" };
const configFor = (name: string, kind: Kind) =>
  kind === "inbound" ? [DOMAIN] : kind === "transactional" ? [TAG] : name === "contact_added_to_list" ? [LIST] : name.startsWith("contact_") ? [] : [CAMPAIGN];
const outputFor = (name: string, kind: Kind) => (kind === "inbound" ? INBOUND_OUT : name.startsWith("contact_") ? CONTACT_OUT : EMAIL_OUT);

export const triggers: Record<string, { description: string; config: ActionDetail["input"]; output: ActionDetail["input"] }> = Object.fromEntries(
  Object.entries(TABLE).map(([name, [kind, , , description]]) => [name, { description, config: configFor(name, kind), output: outputFor(name, kind) }]),
);

type Payload = { event?: string; tags?: string[]; tag?: string; camp_id?: number; list_id?: number[] };
export const wanted = (config: unknown, data: unknown) => {
  const want = (config ?? {}) as { tag?: string; campaign_id?: number | string; list_id?: number | string };
  const d = (data ?? {}) as Payload;
  const tags = d.tags ?? (d.tag ? [d.tag] : []);
  return (
    (!want.tag || tags.includes(want.tag)) &&
    (want.campaign_id === undefined || String(d.camp_id) === String(want.campaign_id)) &&
    (want.list_id === undefined || (d.list_id ?? []).map(String).includes(String(want.list_id)))
  );
};

// ponytail: Brevo signs nothing, so an unguessable URL (an HMAC of ENCRYPTION_KEY, never stored) proves the sender.
// Ceiling: anyone shown the URL (get_webhooks lists it) can forge events; add a bearer token in `auth` if that matters
const token = (connection: string, segment: string) => createHmac("sha256", process.env.ENCRYPTION_KEY!).update(`brevo-webhook:${connection}:${segment}`).digest("hex");
// the first part after the connection: the webhook's type, plus the domain for inbound ones
const segmentFor = (kind: Kind, config: unknown) => {
  if (kind !== "inbound") return kind;
  const domain = String((config as { domain?: unknown } | null)?.domain ?? "").trim().toLowerCase();
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain)) throw new AppsError("domain: give the receiving domain set up in Brevo, like reply.yourdomain.com");
  return `inbound-${domain}`;
};
const hookUrl = (connection: string, segment: string) => `${process.env.WEBHOOK_URL}/webhooks/app/brevo/${connection}/${segment}/${token(connection, segment)}`;

type Hook = { id: number; url: string; events: string[]; type: string };
const send = (method: string, path: string, query: string[] = [], fields: string[] = []): Send => ({
  method,
  path,
  query,
  headers: [],
  ...(fields.length && { body: { kind: "fields" as const, fields: fields.map((f): [string, string] => [f, f]) } }),
});
const LIST_HOOKS = send("GET", "/webhooks", ["type"]);
const CREATE = send("POST", "/webhooks", [], ["url", "type", "events", "description", "domain"]);
const UPDATE = send("PUT", "/webhooks/{webhookId}", [], ["events"]);
const REMOVE = send("DELETE", "/webhooks/{webhookId}");

const find = async (api: Api, key: string, kind: string, url: string) =>
  ((await call(api, key, LIST_HOOKS, { type: kind })) as { webhooks?: Hook[] }).webhooks?.find((w) => w.url === url);

export async function watch(api: Api, key: string, connection: string, event: string, config: unknown) {
  if (!process.env.WEBHOOK_URL) throw new AppsError("this server can't receive Brevo's events (WEBHOOK_URL isn't set)");
  const [kind, name] = event.split(":") as [Kind, string];
  const segment = segmentFor(kind, config);
  const url = hookUrl(connection, segment);
  const found = await find(api, key, kind, url);
  if (found?.events.includes(name)) return `brevo:${connection}:${segment}`;
  if (found) await call(api, key, UPDATE, { webhookId: found.id, events: [...new Set([...found.events, name])] });
  else
    await call(api, key, CREATE, {
      url,
      type: kind,
      events: [name],
      description: "Emplio automations",
      ...(kind === "inbound" && { domain: segment.slice("inbound-".length) }),
    });
  return `brevo:${connection}:${segment}`;
}

export async function unwatch(api: Api, key: string, id: string) {
  const [, connection = "", segment = ""] = id.split(":");
  const kind = segment.startsWith("inbound-") ? "inbound" : segment;
  const found = await find(api, key, kind, hookUrl(connection, segment));
  if (found) await call(api, key, REMOVE, { webhookId: found.id });
}

export function tokenOk(delivery: Delivery) {
  const [segment = "", got = ""] = delivery.rest.split("/");
  const want = Buffer.from(token(delivery.connection, segment));
  const given = Buffer.from(got);
  return given.length === want.length && timingSafeEqual(given, want);
}

// Brevo's payload event → our triggers, per webhook type
const BY_PAYLOAD: Record<string, string[]> = {};
for (const [name, [kind, , payload]] of Object.entries(TABLE)) (BY_PAYLOAD[`${kind}:${payload}`] ??= []).push(name);

const hash = (v: unknown) => createHash("sha256").update(JSON.stringify(v)).digest("hex");
// payloads carry Brevo's preview link and similar clutter; events are cut at 20,000 characters anyway
const CLUTTER = ["mirror_link", "key", "X-Mailin-custom", "sending_ip", "RawHtmlBody", "Headers"];
const clean = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).filter(([k]) => !CLUTTER.includes(k)));

export async function receive(delivery: Delivery) {
  if (!tokenOk(delivery)) return null;
  const segment = delivery.rest.split("/")[0]!;
  const kind = segment.startsWith("inbound-") ? "inbound" : segment;
  return {
    events: async (): Promise<WebhookEvent[]> => {
      const body = JSON.parse(delivery.body) as Record<string, unknown> | Record<string, unknown>[];
      if (kind === "inbound") {
        const items = (body as { items?: Record<string, unknown>[] }).items ?? [];
        return items.map((item) => ({ id: hash(item.MessageId ?? item), triggers: ["inbound_email_received"], data: clean(item) }));
      }
      // a batched webhook sends a list
      return [body].flat().map((e) => ({ id: hash(e), triggers: BY_PAYLOAD[`${kind}:${e.event}`] ?? [], data: clean(e) }));
    },
  };
}
