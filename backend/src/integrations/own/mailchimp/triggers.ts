// Mailchimp telling us about an audience's events the moment they happen. Webhooks are per audience (list): one per
// connection and audience, at /webhooks/app/mailchimp/<connection>/<list>/<token>, carrying the events its automations
// need. Mailchimp signs nothing, so the unguessable token in the address proves the sender; it checks the address with
// a GET first, which the shared route answers. Deliveries are form-encoded (data[merges][FNAME]=...).
// Trigger names are Composio's where it has one.
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { ActionDetail } from "@emplio/shared";
import { AppsError } from "../../types";
import type { Delivery, WebhookEvent } from "../index";
import { type Api, call, type Send } from "../openapi";

// [our name, Mailchimp's event, description]
const ROWS: [string, string, string][] = [
  ["subscribe_trigger", "subscribe", "Someone subscribes to an audience, including contacts Emplio adds itself"],
  ["unsubscribe_trigger", "unsubscribe", "Someone unsubscribes from an audience, or is deleted from it"],
  ["profile_update_trigger", "profile", "A contact's details change (name, fields, groups), including changes Emplio makes itself, so say in the prompt when to stop"],
  ["email_changed_trigger", "upemail", "A contact changes their email address"],
  ["cleaned_trigger", "cleaned", "Mailchimp removes an address that bounces or is marked as spam"],
  ["campaign_trigger", "campaign", "A campaign to an audience is sent or cancelled"],
];
export const events: Record<string, string> = Object.fromEntries(ROWS.map(([name, event]) => [name, event]));

const LIST = { name: "list_id", type: "string", required: true, description: "The audience to watch: its id (get_lists_info lists them)" };
const EMAIL = { name: "email", type: "string", required: false, description: "Only this contact's email address" };
const OUTPUT: ActionDetail["input"] = [
  { name: "event", type: "string", required: true, description: "What happened: subscribe, unsubscribe, profile, upemail, cleaned or campaign" },
  { name: "fired_at", type: "string", required: true, description: "When, in Mailchimp's account time (YYYY-MM-DD HH:MM:SS)" },
  { name: "list_id", type: "string", required: false, description: "The audience" },
  { name: "email", type: "string", required: false, description: "The contact's email address" },
  { name: "merges", type: "object", required: false, description: "The contact's fields (FNAME, LNAME, EMAIL, groups...)" },
  { name: "reason", type: "string", required: false, description: "Why: an unsubscribe's (manual, abuse) or a cleaning's (hard bounce, abuse)" },
  { name: "old_email", type: "string", required: false, description: "On an address change, the address before" },
  { name: "new_email", type: "string", required: false, description: "On an address change, the address after" },
  { name: "subject", type: "string", required: false, description: "On a campaign, its subject line" },
  { name: "status", type: "string", required: false, description: "On a campaign: sent or cancelled" },
];
export const triggers: Record<string, { description: string; config: ActionDetail["input"]; output: ActionDetail["input"] }> = Object.fromEntries(
  ROWS.map(([name, event, description]) => [name, { description: `${description}.`, config: event === "campaign" ? [LIST] : [LIST, EMAIL], output: OUTPUT }]),
);

type Data = Record<string, any>;
export const wanted = (config: unknown, data: unknown) => {
  const email = (config as { email?: string } | null)?.email;
  const d = data as Data;
  return !email || [d.email, d.new_email, d.old_email].some((e) => String(e ?? "").toLowerCase() === email.toLowerCase());
};

// a=1&data[merges][FNAME]=Ann → { a: "1", data: { merges: { FNAME: "Ann" } } }
export function formObject(body: string): Data {
  const out: Data = {};
  for (const [key, value] of new URLSearchParams(body)) {
    const path = key.split(/\[|\]\[|\]/).filter(Boolean);
    if (!path.length || path.some((k) => k === "__proto__" || k === "constructor" || k === "prototype")) continue;
    let at = out;
    for (const k of path.slice(0, -1)) at = at[k] = typeof at[k] === "object" ? at[k] : {};
    at[path.at(-1)!] = value;
  }
  return out;
}

const token = (connection: string, list: string) => {
  const key = process.env.ENCRYPTION_KEY;
  if (!key) throw new Error("ENCRYPTION_KEY isn't set");
  return createHmac("sha256", key).update(`mailchimp-webhook:${connection}:${list}`).digest("hex");
};
export const hookUrl = (connection: string, list: string) => `${process.env.WEBHOOK_URL}/webhooks/app/mailchimp/${connection}/${list}/${token(connection, list)}`;

const HOOKS: Send = { method: "GET", path: "/lists/{list_id}/webhooks", query: [], headers: [] };
const body = (method: string, path: string, fields: string[]): Send => ({ method, path, query: [], headers: [], body: { kind: "fields", fields: fields.map((f) => [f, f]) } });
type Hook = { id: string; url: string; events: Record<string, boolean> };
const findHook = async (api: Api, key: string, list: string, url: string) => ((await call(api, key, HOOKS, { list_id: list })) as { webhooks: Hook[] }).webhooks.find((h) => h.url === url);
const ALL_SOURCES = { user: true, admin: true, api: true };

// Make sure this audience's webhook exists and carries `event`. Answers the id automations are stored under.
export async function watch(api: Api, key: string, connection: string, event: string, config: unknown) {
  if (!process.env.WEBHOOK_URL) throw new AppsError("this server can't receive Mailchimp's events (WEBHOOK_URL isn't set)");
  const list = String((config as { list_id?: unknown } | null)?.list_id ?? "");
  if (!/^\w+$/.test(list)) throw new AppsError("list_id: give the audience's id (get_lists_info lists them)");
  const url = hookUrl(connection, list);
  const found = await findHook(api, key, list, url);
  if (found?.events[event]) return `mailchimp:${connection}:${list}`;
  if (found)
    await call(api, key, body("PATCH", "/lists/{list_id}/webhooks/{webhook_id}", ["events", "sources"]), { list_id: list, webhook_id: found.id, events: { ...found.events, [event]: true }, sources: ALL_SOURCES });
  else await call(api, key, body("POST", "/lists/{list_id}/webhooks", ["url", "events", "sources"]), { list_id: list, url, events: { [event]: true }, sources: ALL_SOURCES });
  return `mailchimp:${connection}:${list}`;
}

// The last automation on this audience is gone: take the webhook off it.
export async function unwatch(api: Api, key: string, id: string) {
  const [, connection = "", list = ""] = id.split(":");
  const found = await findHook(api, key, list, hookUrl(connection, list));
  if (found) await call(api, key, { method: "DELETE", path: "/lists/{list_id}/webhooks/{webhook_id}", query: [], headers: [] }, { list_id: list, webhook_id: found.id });
}

export async function receive(delivery: Delivery) {
  const [list = "", got = ""] = delivery.rest.split("/");
  const want = Buffer.from(token(delivery.connection, list));
  if (Buffer.byteLength(got) !== want.length || !timingSafeEqual(Buffer.from(got), want)) return null;
  const { type = "", fired_at = "", data = {} } = formObject(delivery.body);
  const names = ROWS.filter(([, e]) => e === type).map(([name]) => name);
  // no delivery id: a retry repeats the event, the time and the contact (or campaign)
  const id = createHash("sha256").update(`${delivery.connection}:${list}:${type}:${fired_at}:${data.id ?? data.email ?? data.new_email ?? ""}`).digest("hex");
  const out: WebhookEvent = { id, triggers: names, data: { event: type, fired_at, ...data } };
  return { events: async () => [out] };
}
