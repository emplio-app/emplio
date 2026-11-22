// Chargebee telling us about changes the moment they happen: every one of its events (events.json, written from the
// spec by scripts/openapi/chargebee.ts) is a trigger of the same name. One webhook endpoint per connection, for all
// events, at /webhooks/app/chargebee/<connection>, made through Chargebee's Webhook endpoints API. It proves itself
// with HTTP basic auth whose password is worked out from ENCRYPTION_KEY and the connection, never stored.
import { createHmac, timingSafeEqual } from "node:crypto";
import type { ActionDetail } from "@emplio/shared";
import { AppsError } from "../../types";
import type { Delivery } from "../index";
import { type Api, call, type Send } from "../openapi";
import EVENTS from "./events.json";

type Field = ActionDetail["input"][number];
const CUSTOMER: Field = { name: "customer_id", type: "string", required: false, description: "Only events about this Chargebee customer (their id; list_customers lists them)" };
const OUTPUT: ActionDetail["input"] = [
  { name: "id", type: "string", required: true, description: "The event's id in Chargebee" },
  { name: "event_type", type: "string", required: true, description: "What happened, like subscription_created or payment_failed" },
  { name: "occurred_at", type: "number", required: true, description: "When, in seconds since 1970 (Unix time)" },
  { name: "source", type: "string", required: false, description: "Where it came from: admin_console, api, scheduled_job, hosted_page, portal, system..." },
  { name: "user", type: "string", required: false, description: "Who did it, when a person did" },
  { name: "content", type: "object", required: true, description: "The things it's about as they are now, by kind: customer, subscription, invoice, credit_note, transaction, card..." },
];
const AGAIN = " A run that changes the same thing starts this again, so say in the prompt when to stop.";

type Trigger = { description: string; config: ActionDetail["input"]; output: ActionDetail["input"] };
export const triggers: Record<string, Trigger> = Object.fromEntries(
  Object.entries(EVENTS as Record<string, string>).map(([event, said]) => [
    event,
    { description: `Chargebee: ${said.replace(/^(Sent|Triggered|Triggers|Generated) (when|if|after)\s*/i, "").replace(/^./, (c) => c.toUpperCase())}${/_(updated|changed)$/.test(event) ? AGAIN : ""}`, config: [CUSTOMER], output: OUTPUT },
  ]),
);
export const events: Record<string, string> = Object.fromEntries(Object.keys(triggers).map((t) => [t, t]));

export type EventData = { id: string; event_type: string; occurred_at: number; source?: string; user?: string; content: Record<string, any> };

// the customer an event is about: the customer itself, or the customer_id on the subscription, invoice... it carries
const customerOf = (content: Record<string, any>) =>
  content.customer?.id ?? Object.values(content).find((x: any) => x && typeof x === "object" && x.customer_id)?.customer_id;

export const wanted = (config: unknown, data: unknown) => {
  const want = (config ?? {}) as { customer_id?: string };
  return !want.customer_id || String(want.customer_id) === String(customerOf((data as EventData).content ?? {}));
};

const password = (connection: string) => createHmac("sha256", process.env.ENCRYPTION_KEY!).update(`chargebee-webhook:${connection}`).digest("hex").slice(0, 32);
const USER = "emplio";
const hookUrl = (connection: string) => `${process.env.WEBHOOK_URL}/webhooks/app/chargebee/${connection}`;

const send = (method: string, path: string, fields: string[] = []): Send => ({
  method,
  path,
  query: method === "GET" ? ["limit"] : [],
  headers: [],
  ...(fields.length && { body: { kind: "urlencoded" as const, fields: fields.map((f): [string, string] => [f, f]) } }),
});
type Endpoint = { id: string; url: string; disabled?: boolean };
// ponytail: the first 100 endpoints; Chargebee allows a handful per site, so that's all of them
const ours = async (api: Api, key: string, connection: string) => {
  const { list } = (await call(api, key, send("GET", "/webhook_endpoints"), { limit: 100 })) as { list?: { webhook_endpoint: Endpoint }[] };
  return (list ?? []).map((x) => x.webhook_endpoint).filter((w) => w.url === hookUrl(connection));
};
const remove = (api: Api, key: string, id: string) => call(api, key, send("POST", "/webhook_endpoints/{id}/delete"), { id });

// ponytail: one endpoint for every event, matched here; enabled_events per automation if that traffic ever matters
export async function watch(api: Api, key: string, connection: string) {
  if (!process.env.WEBHOOK_URL) throw new AppsError("this server can't receive Chargebee's events (WEBHOOK_URL isn't set)");
  const id = `chargebee:${connection}`;
  const found = await ours(api, key, connection);
  if (found.some((w) => !w.disabled)) return id;
  // one switched off (by hand, or by Chargebee after failing deliveries) is replaced with a fresh one
  for (const w of found) await remove(api, key, w.id);
  await call(api, key, send("POST", "/webhook_endpoints", ["name", "url", "api_version", "basic_auth_username", "basic_auth_password"]), {
    name: "Emplio",
    url: hookUrl(connection),
    api_version: "v2",
    basic_auth_username: USER,
    basic_auth_password: password(connection),
  });
  return id;
}

export async function unwatch(api: Api, key: string, id: string) {
  const [, connection = ""] = id.split(":");
  for (const w of await ours(api, key, connection)) await remove(api, key, w.id);
}

const authorized = (header: unknown, connection: string) => {
  const m = /^Basic (.+)$/i.exec(typeof header === "string" ? header : "");
  const got = Buffer.from(m ? Buffer.from(m[1]!, "base64").toString() : "");
  const want = Buffer.from(`${USER}:${password(connection)}`);
  return got.length === want.length && timingSafeEqual(got, want);
};

export async function receive(delivery: Delivery) {
  if (!authorized(delivery.headers.authorization, delivery.connection)) return null;
  const e = JSON.parse(delivery.body || "{}") as EventData & { webhook_status?: unknown; webhooks?: unknown; object?: unknown };
  const { webhook_status: _s, webhooks: _w, object: _o, ...data } = e;
  const names = triggers[e.event_type] ? [e.event_type] : [];
  // `seen` is shared across apps, so the connection is in the id; a retry keeps Chargebee's event id
  return { events: async () => (names.length ? [{ id: `${delivery.connection}:${e.id}`, triggers: names, data }] : []) };
}
