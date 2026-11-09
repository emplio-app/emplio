// Calendly telling us about events the moment they happen, by webhook (a paid-plan feature). One subscription per
// connection, at /webhooks/app/calendly/<connection>, carrying the events its automations need. Calendly can't change
// a subscription's events, so a new event means deleting it and making it again with the union. Meeting recaps can only be
// subscribed per user and routing forms only per organization, so recaps get their own subscription at <connection>/user.
// Trigger names are Composio's.
import type { ActionDetail } from "@emplio/shared";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { AppsError } from "../../types";
import type { Delivery, WebhookEvent } from "../index";
import { type Api, call } from "../openapi";

// our trigger → Calendly's event; every event its API offers
export const events: Record<string, string> = {
  meeting_scheduled: "invitee.created",
  meeting_canceled: "invitee.canceled",
  invitee_marked_no_show: "invitee_no_show.created",
  invitee_no_show_cleared: "invitee_no_show.deleted",
  routing_form_submitted: "routing_form_submission.created",
  event_type_created: "event_type.created",
  event_type_updated: "event_type.updated",
  event_type_deleted: "event_type.deleted",
  contact_created: "contact.created",
  contact_updated: "contact.updated",
  contact_deleted: "contact.deleted",
  meeting_recap_created: "meeting_recap.created",
  meeting_recap_updated: "meeting_recap.updated",
  meeting_recap_deleted: "meeting_recap.deleted",
};

const OUTPUT: ActionDetail["input"] = [
  { name: "event", type: "string", required: true, description: "What happened, like invitee.created" },
  { name: "created_at", type: "string", required: true, description: "When it happened" },
  { name: "payload", type: "object", required: true, description: "The Calendly object it's about: the booking, the contact..." },
];
const EVENT_TYPE = { name: "event_type", type: "string", required: false, description: "Only meetings booked through this event type (its URI)" };
const FORM = { name: "routing_form", type: "string", required: false, description: "Only submissions of this routing form (its URI)" };
const INVITEE = [EVENT_TYPE];

const trigger = (description: string, config: ActionDetail["input"] = []) => ({ description, config, output: OUTPUT });
export const triggers: Record<string, { description: string; config: ActionDetail["input"]; output: ActionDetail["input"] }> = {
  meeting_scheduled: trigger("Someone books a meeting with you on Calendly.", INVITEE),
  meeting_canceled: trigger("A booked Calendly meeting is cancelled.", INVITEE),
  invitee_marked_no_show: trigger("Someone is marked as a no-show for a Calendly meeting.", INVITEE),
  invitee_no_show_cleared: trigger("A Calendly no-show mark is taken back.", INVITEE),
  routing_form_submitted: trigger("Someone fills in one of your Calendly routing forms.", [FORM]),
  event_type_created: trigger("A new Calendly event type is made."),
  event_type_updated: trigger("A Calendly event type is changed."),
  event_type_deleted: trigger("A Calendly event type is deleted."),
  contact_created: trigger("A contact is added in Calendly."),
  contact_updated: trigger("A Calendly contact is changed."),
  contact_deleted: trigger("A Calendly contact is deleted."),
  meeting_recap_created: trigger("Calendly has a new recap of a meeting."),
  meeting_recap_updated: trigger("A Calendly meeting recap is changed."),
  meeting_recap_deleted: trigger("A Calendly meeting recap is deleted."),
};

type Payload = { scheduled_event?: { event_type?: string }; routing_form?: string };
export const wanted = (config: unknown, data: unknown) => {
  const want = (config ?? {}) as { event_type?: string; routing_form?: string };
  const { payload } = data as { payload: Payload };
  return (!want.event_type || payload.scheduled_event?.event_type === want.event_type) && (!want.routing_form || payload.routing_form === want.routing_form);
};

export const signingKey = (connection: string) => createHmac("sha256", process.env.ENCRYPTION_KEY!).update(`calendly-webhook:${connection}`).digest("hex");
// recap events are only offered per user, and one subscription can't mix scopes
const userOnly = (event: string) => event.startsWith("meeting_recap.");
const hookUrl = (connection: string, rest = "") => `${process.env.WEBHOOK_URL}/webhooks/app/calendly/${connection}${rest ? `/${rest}` : ""}`;

type Me = { uri: string; current_organization: string };
type Scope = { scope: "organization" | "user"; organization: string; user?: string };
type Subscription = { uri: string; callback_url: string; events: string[]; state: string; scope: string };
const send = (method: string, path: string, query: string[] = [], fields: string[] = []) => ({
  method,
  path,
  query,
  headers: [] as [string, string][],
  ...(fields.length && { body: { kind: "fields" as const, fields: fields.map((f): [string, string] => [f, f]) } }),
});
const LIST = send("GET", "/webhook_subscriptions", ["organization", "scope", "user", "count"]);
const CREATE = send("POST", "/webhook_subscriptions", [], ["url", "events", "organization", "scope", "user", "signing_key"]);
const REMOVE = send("DELETE", "/webhook_subscriptions/{uuid}");

const me = async (api: Api, key: string) => ((await call(api, key, send("GET", "/users/me"), {})) as { resource: Me }).resource;
const scopes = (who: Me): Scope[] => [
  { scope: "organization", organization: who.current_organization },
  { scope: "user", organization: who.current_organization, user: who.uri },
];
const uuid = (uri: string) => uri.split("/").pop()!;

// ponytail: first 100 subscriptions of each scope; an account with more needs paging here
async function find(api: Api, key: string, url: string, who: Me) {
  for (const s of scopes(who)) {
    const got = await (call(api, key, LIST, { ...s, count: 100 }) as Promise<{ collection: Subscription[] }>).catch((error) => {
      // only an owner or admin can read the organization's; a member still has their own
      if (error instanceof AppsError && !error.expired && s.scope === "organization") return null;
      throw error;
    });
    const found = got?.collection.find((w) => w.callback_url === url);
    if (found) return found;
  }
}

export async function watch(api: Api, key: string, connection: string, event: string) {
  if (!process.env.WEBHOOK_URL) throw new AppsError("this server can't receive Calendly's events (WEBHOOK_URL isn't set)");
  const rest = userOnly(event) ? "user" : "";
  const url = hookUrl(connection, rest);
  const id = rest ? `calendly:${connection}:${rest}` : `calendly:${connection}`;
  try {
    const who = await me(api, key);
    const found = await find(api, key, url, who);
    if (found?.state === "active" && found.events.includes(event)) return id;
    const wanted = [...new Set([...(found?.events ?? []), event])];
    if (found) await call(api, key, REMOVE, { uuid: uuid(found.uri) });
    const signing_key = signingKey(connection);
    const body = { url, events: wanted, signing_key };
    const [org, user] = scopes(who);
    if (rest || found?.scope === "user") await call(api, key, CREATE, { ...body, ...user });
    else {
      await call(api, key, CREATE, { ...body, ...org }).catch((error) => {
        // a member can't subscribe the whole organization: just their own meetings, then
        if (!(error instanceof AppsError) || error.expired || !error.message.endsWith("(403)") || found) throw error;
        return call(api, key, CREATE, { ...body, ...user });
      });
    }
  } catch (error) {
    if (!(error instanceof AppsError) || error.expired) throw error;
    throw new AppsError(`can't watch this Calendly account: automations need a paid Calendly plan (Standard or above) (${error.message})`);
  }
  return id;
}

export async function unwatch(api: Api, key: string, id: string) {
  const [, connection = "", rest] = id.split(":");
  const found = await find(api, key, hookUrl(connection, rest), await me(api, key));
  if (found) await call(api, key, REMOVE, { uuid: uuid(found.uri) });
}

// Calendly signs `<t>.<body>`; older than this isn't a delivery
const MAX_AGE_S = 5 * 60;

export function signatureOk(delivery: Delivery) {
  const parts = Object.fromEntries(String(delivery.headers["calendly-webhook-signature"] ?? "").split(",").map((p) => p.split("=") as [string, string]));
  const t = Number(parts.t);
  if (!parts.v1 || !Number.isFinite(t) || Math.abs(Date.now() / 1000 - t) > MAX_AGE_S) return false;
  const want = Buffer.from(createHmac("sha256", signingKey(delivery.connection)).update(`${parts.t}.${delivery.body}`).digest("hex"));
  const got = Buffer.from(parts.v1);
  return got.length === want.length && timingSafeEqual(got, want);
}

export async function receive(delivery: Delivery) {
  if (!signatureOk(delivery)) return null;
  const out = async () => {
    const { event, created_at, payload } = JSON.parse(delivery.body) as { event: string; created_at: string; payload: unknown };
    const name = Object.keys(events).filter((k) => events[k] === event);
    const data: WebhookEvent = { id: createHash("sha256").update(delivery.body).digest("hex"), triggers: name, data: { event, created_at, payload } };
    return [data];
  };
  return { events: out };
}
