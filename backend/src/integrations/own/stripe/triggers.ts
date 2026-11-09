// Stripe telling us about events the moment they happen. One webhook endpoint per connection, at
// /webhooks/app/stripe/<connection>, carrying the events its automations need. Stripe chooses an endpoint's signing
// secret and shows it only once, so nothing is stored: an event counts only if Stripe, asked on this connection's key,
// says it exists. Trigger names are the event's with dots as underscores, which is what Composio called them.
import type { ActionDetail } from "@emplio/shared";
import { AppsError } from "../../types";
import type { Delivery, WebhookEvent } from "../index";
import { type Api, call, type Send } from "../openapi";
import list from "./events.json";

export const stripeVersion = list.version;
const trigger = (event: string) => event.replace(/\./g, "_");
export const events: Record<string, string> = Object.fromEntries(list.events.map((e) => [trigger(e), e]));

const OUTPUT: ActionDetail["input"] = [
  { name: "id", type: "string", required: true, description: "The event's id (evt_...)" },
  { name: "type", type: "string", required: true, description: "The event's type, like invoice.paid" },
  { name: "created", type: "number", required: true, description: "When it happened, in seconds since 1970" },
  { name: "livemode", type: "boolean", required: true, description: "False for a test-mode event" },
  { name: "object", type: "object", required: true, description: "The Stripe object it's about: the invoice, the charge..." },
  { name: "previous_attributes", type: "object", required: false, description: "On updates: the fields that changed, with their old values" },
];
const CUSTOMER = { name: "customer", type: "string", required: false, description: "Only events about this customer (cus_...)" };

export const triggers: Record<string, { description: string; config: ActionDetail["input"]; output: ActionDetail["input"] }> = Object.fromEntries(
  list.events.map((e) => [trigger(e), { description: `Stripe reports ${e} on your account.`, config: [CUSTOMER], output: OUTPUT }]),
);

type Event = { id: string; type: string; created: number; livemode: boolean; data: { object: Record<string, any>; previous_attributes?: unknown } };
export type EventData = Omit<Event, "data"> & Event["data"];

export const wanted = (config: unknown, data: unknown) => {
  const want = (config as { customer?: string } | null)?.customer;
  if (!want) return true;
  const { object } = data as EventData;
  return (object.object === "customer" ? object.id : typeof object.customer === "string" ? object.customer : object.customer?.id) === want;
};

const hookUrl = (connection: string) => `${process.env.WEBHOOK_URL}/webhooks/app/stripe/${connection}`;
const send = (method: string, path = "/v1/webhook_endpoints", fields: [string, string][] = []): Send => ({
  method,
  path,
  query: method === "GET" ? ["limit"] : [],
  headers: [],
  ...(fields.length && { body: { kind: "urlencoded" as const, fields } }),
});
type Endpoint = { id: string; url: string; enabled_events: string[]; status: string };
const findEndpoint = async (api: Api, key: string, url: string) =>
  // ponytail: first 100 endpoints; an account with more needs paging here
  ((await call(api, key, send("GET"), { limit: 100 })) as { data: Endpoint[] }).data.find((e) => e.url === url);

// Make sure this connection's endpoint exists and carries `event`.
export async function watch(api: Api, key: string, connection: string, event: string) {
  if (!process.env.WEBHOOK_URL) throw new AppsError("this server can't receive Stripe's events (WEBHOOK_URL isn't set)");
  const url = hookUrl(connection);
  const id = `stripe:${connection}`;
  try {
    const found = await findEndpoint(api, key, url);
    if (found?.status === "enabled" && found.enabled_events.includes(event)) return id;
    if (found) await call(api, key, send("POST", "/v1/webhook_endpoints/{id}", [["enabled_events", "enabled_events"], ["disabled", "disabled"]]), { id: found.id, enabled_events: [...new Set([...found.enabled_events, event])], disabled: false });
    else await call(api, key, send("POST", undefined, [["url", "url"], ["enabled_events", "enabled_events"], ["description", "description"]]), { url, enabled_events: [event], description: "Emplio" });
  } catch (error) {
    if (!(error instanceof AppsError)) throw error;
    throw new AppsError(`can't watch this Stripe account: a restricted key needs Webhook Endpoints write and Events read (${error.message})`);
  }
  return id;
}

export async function unwatch(api: Api, key: string, id: string) {
  const [, connection = ""] = id.split(":");
  const found = await findEndpoint(api, key, hookUrl(connection));
  if (found) await call(api, key, send("DELETE", "/v1/webhook_endpoints/{id}"), { id: found.id });
}

// Stripe retries for three days; anything older isn't a delivery
const MAX_AGE_S = 4 * 86_400;

export async function receive(api: Api, delivery: Delivery, key: string) {
  const id = (JSON.parse(delivery.body) as { id?: unknown }).id;
  if (typeof id !== "string" || !/^evt_\w+$/.test(id)) return null;
  const event = (await call(api, key, send("GET", "/v1/events/{id}"), { id })) as Event;
  if (Date.now() / 1000 - event.created > MAX_AGE_S) return null;
  const { data, ...rest } = event;
  const out: WebhookEvent = { id, triggers: events[trigger(event.type)] ? [trigger(event.type)] : [], data: { ...rest, ...data } };
  return { events: async () => [out] };
}
