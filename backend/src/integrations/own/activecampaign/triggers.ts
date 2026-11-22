// ActiveCampaign telling us about events the moment they happen. One webhook per connection, at
// /webhooks/app/activecampaign/<connection>/<token>, subscribed to the events its automations want, from every source
// (each automation's settings pick the sources it wants). ActiveCampaign doesn't sign its webhooks, so the URL's token,
// worked out from ENCRYPTION_KEY and the connection and never stored, is what proves a delivery is real.
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { ActionDetail } from "@emplio/shared";
import { AppsError } from "../../types";
import type { Delivery, WebhookEvent } from "../index";
import { type Api, call, type Send } from "../openapi";

type Field = ActionDetail["input"][number];
const AGAIN = " A run that changes the same contact or deal starts this again, so set source to admin or public to skip changes Emplio makes.";

// trigger → [ActiveCampaign's event, what it means]
const EVENTS: Record<string, [string, string]> = {
  contact_subscribed: ["subscribe", "A contact subscribes to a list in ActiveCampaign: signs up on a form, is added by someone, or comes in by import or API."],
  contact_unsubscribed: ["unsubscribe", "A contact unsubscribes from a list in ActiveCampaign."],
  contact_updated: ["update", "A contact's details change in ActiveCampaign." + AGAIN],
  contact_note_added: ["subscriber_note", "A note is added to a contact in ActiveCampaign."],
  contact_tag_added: ["contact_tag_added", "A tag is added to a contact in ActiveCampaign." + AGAIN],
  contact_tag_removed: ["contact_tag_removed", "A tag is taken off a contact in ActiveCampaign."],
  contact_task_added: ["contact_task_add", "A task is added to a contact in ActiveCampaign."],
  list_created: ["list_add", "A new list is created in ActiveCampaign."],
  campaign_sent: ["sent", "A campaign starts sending in ActiveCampaign."],
  campaign_opened: ["open", "A contact opens a campaign email from ActiveCampaign."],
  link_clicked: ["click", "A contact clicks a link in a campaign email from ActiveCampaign."],
  campaign_replied: ["reply", "A contact replies to a campaign email from ActiveCampaign."],
  campaign_forwarded: ["forward", "A contact forwards a campaign email from ActiveCampaign."],
  campaign_shared: ["share", "A contact shares a campaign from ActiveCampaign on social media."],
  email_bounced: ["bounce", "A campaign email from ActiveCampaign bounces."],
  sms_sent: ["sms_sent", "An SMS is sent to a contact from ActiveCampaign."],
  sms_replied: ["sms_reply", "A contact replies to an SMS from ActiveCampaign."],
  sms_unsubscribed: ["sms_unsub", "A contact opts out of SMS from ActiveCampaign."],
  new_deal: ["deal_add", "A deal is added in ActiveCampaign."],
  deal_updated: ["deal_update", "A deal changes in ActiveCampaign: its stage, owner, value, status or any field." + AGAIN],
  deal_stage_changed: ["deal_update", "A deal moves to another stage in ActiveCampaign." + AGAIN],
  deal_won: ["deal_update", "A deal is marked won in ActiveCampaign."],
  deal_lost: ["deal_update", "A deal is marked lost in ActiveCampaign."],
  deal_note_added: ["deal_note_add", "A note is added to a deal in ActiveCampaign."],
  deal_task_added: ["deal_task_add", "A task is added to a deal in ActiveCampaign."],
  deal_task_completed: ["deal_task_complete", "A deal's task is marked done in ActiveCampaign."],
  deal_task_type_created: ["deal_tasktype_add", "A new task type is created in ActiveCampaign."],
  pipeline_created: ["deal_pipeline_add", "A new deal pipeline is created in ActiveCampaign."],
  deal_stage_created: ["deal_stage_add", "A new stage is added to a deal pipeline in ActiveCampaign."],
  new_account: ["account_add", "A new account (a customer company) is added in ActiveCampaign."],
  account_updated: ["account_update", "An account (a customer company) changes in ActiveCampaign."],
  account_contact_added: ["account_contact_add", "A contact is linked to an account (company) in ActiveCampaign."],
  account_contact_updated: ["account_contact_update", "A contact's link to an account (company), like their job title there, changes in ActiveCampaign."],
};

const SOURCE: Field = {
  name: "source",
  type: "string",
  required: false,
  description: "Only events caused this way: public (the contact did it, on a form or email), admin (someone on the team, in ActiveCampaign), api (an integration, Emplio included) or system (ActiveCampaign's own automations)",
};
const LIST: Field = { name: "list_id", type: "string", required: false, description: "Only events on this list (its id; get_lists lists them)" };
const TAG: Field = { name: "tag", type: "string", required: false, description: "Only when this tag is added or removed (its name)" };
const CAMPAIGN: Field = { name: "campaign_id", type: "string", required: false, description: "Only for this campaign (its id; list_campaigns lists them)" };
const PIPELINE: Field = { name: "pipeline_id", type: "string", required: false, description: "Only deals in this pipeline (its id; list_dealgroups lists them)" };
const STAGE: Field = { name: "stage_id", type: "string", required: false, description: "Only deals in this stage now (its id; list_deal_stages lists them)" };
const OWNER: Field = { name: "owner_id", type: "string", required: false, description: "Only deals owned by this ActiveCampaign user (their id; list_users lists them)" };
const FIELD: Field = { name: "field", type: "string", required: false, description: "Only when this field changed, like title, value, stage, status or owner" };
const config = (event: string, trigger: string): Field[] => {
  if (event.startsWith("deal_update")) return [SOURCE, PIPELINE, STAGE, OWNER, ...(trigger === "deal_updated" ? [FIELD] : [])];
  if (event.startsWith("deal_")) return [SOURCE, PIPELINE, STAGE, OWNER];
  if (event.startsWith("contact_tag")) return [SOURCE, TAG];
  if (["sent", "open", "click", "reply", "forward", "share", "bounce"].includes(event)) return [SOURCE, LIST, CAMPAIGN];
  if (["subscribe", "unsubscribe", "update"].includes(event)) return [SOURCE, LIST];
  return [SOURCE];
};
const OUTPUT: ActionDetail["input"] = [
  { name: "type", type: "string", required: true, description: "ActiveCampaign's name for what happened, like subscribe, deal_update or contact_tag_added" },
  { name: "date_time", type: "string", required: true, description: "When it happened" },
  { name: "initiated_by", type: "string", required: false, description: "What caused it: public, admin, api or system" },
  { name: "contact", type: "object", required: false, description: "The contact: id, email, first_name, last_name, phone, tags, fields (custom fields by id)" },
  { name: "deal", type: "object", required: false, description: "On deal events, the deal: id, title, value, currency, pipelineid, stageid, stage_title, status (0 open, 1 won, 2 lost), owner" },
  { name: "updated_fields", type: "object", required: false, description: "On deal_update: the fields that changed" },
  { name: "list", type: "string", required: false, description: "The list's id, on list events" },
  { name: "tag", type: "string", required: false, description: "The tag, on tag events" },
  { name: "campaign", type: "object", required: false, description: "On campaign events, the campaign: id, name; link for clicks" },
];

export const triggers: Record<string, { description: string; config: ActionDetail["input"]; output: ActionDetail["input"] }> = Object.fromEntries(
  Object.entries(EVENTS).map(([t, [event, description]]) => [t, { description, config: config(event, t), output: OUTPUT }]),
);
// our trigger → ActiveCampaign's event
export const events: Record<string, string> = Object.fromEntries(Object.entries(EVENTS).map(([t, [e]]) => [t, e]));

// the body as a nested object: contact[fields][3]=x → { contact: { fields: { "3": "x" } } }
export function parseBody(body: string): Record<string, any> {
  if (body.trimStart().startsWith("{")) return JSON.parse(body);
  const out: Record<string, any> = {};
  for (const [k, v] of new URLSearchParams(body)) {
    const path = k.replace(/\]/g, "").split("[");
    if (path.some((p) => p === "__proto__" || p === "constructor" || p === "prototype")) continue;
    let at = out;
    for (const p of path.slice(0, -1)) at = at[p] = typeof at[p] === "object" && at[p] ? at[p] : {};
    at[path.at(-1)!] = v;
  }
  return out;
}

type Data = Record<string, any>;
const changed = (d: Data) => Object.values((d.updated_fields ?? {}) as Record<string, string>).map(String);
const deal = (d: Data) => (d.deal ?? {}) as Record<string, unknown>;
// the extra test some triggers put on their event
const TESTS: Record<string, (d: Data) => boolean> = {
  deal_stage_changed: (d) => changed(d).some((f) => /stage/i.test(f)),
  deal_won: (d) => String(deal(d).status) === "1" && changed(d).some((f) => /status/i.test(f)),
  deal_lost: (d) => String(deal(d).status) === "2" && changed(d).some((f) => /status/i.test(f)),
};

export const wanted = (config: unknown, data: unknown) => {
  const want = (config ?? {}) as Record<string, string | undefined>;
  const d = (data ?? {}) as Data;
  const same = (want: unknown, ...got: unknown[]) => want === undefined || want === "" || got.some((g) => g != null && String(g).toLowerCase() === String(want).toLowerCase());
  const dl = deal(d);
  return (
    same(want.source, d.initiated_by) &&
    same(want.list_id, d.list, d.list_id, d.campaign?.list) &&
    same(want.tag, d.tag) &&
    same(want.campaign_id, d.campaign?.id) &&
    same(want.pipeline_id, dl.pipelineid, dl.pipeline_id, dl.group) &&
    same(want.stage_id, dl.stageid, dl.stage_id, dl.stage) &&
    same(want.owner_id, dl.owner, dl.owner_id, dl.userid) &&
    (!want.field || changed(d).some((f) => f.toLowerCase() === want.field!.toLowerCase()))
  );
};

const hookToken = (connection: string) => createHmac("sha256", process.env.ENCRYPTION_KEY!).update(`activecampaign-webhook:${connection}`).digest("hex");
export const hookUrl = (connection: string) => `${process.env.WEBHOOK_URL}/webhooks/app/activecampaign/${connection}/${hookToken(connection)}`;
const SOURCES = ["public", "admin", "api", "system"];

const send = (method: string, path: string, query: string[] = []): Send => ({ method, path, query, headers: [], ...((method === "POST" || method === "PUT") && { body: { kind: "whole", field: "body" } }) });
type Hook = { id: string; url: string; events?: string[] };
const ours = async (api: Api, key: string, connection: string) =>
  ((await call(api, key, send("GET", "/webhooks", ["filters[url]"]), { "filters[url]": hookUrl(connection) })) as { webhooks?: Hook[] }).webhooks?.filter((h) => h.url === hookUrl(connection)) ?? [];

export async function watch(api: Api, key: string, connection: string, event: string) {
  if (!process.env.WEBHOOK_URL) throw new AppsError("this server can't receive ActiveCampaign's events (WEBHOOK_URL isn't set)");
  const id = `activecampaign:${connection}`;
  const [found] = await ours(api, key, connection);
  if (found?.events?.includes(event)) return id;
  const webhook = { name: "Emplio", url: hookUrl(connection), events: [...new Set([...(found?.events ?? []), event])], sources: SOURCES };
  if (found) await call(api, key, send("PUT", "/webhooks/{id}"), { id: found.id, body: { webhook } });
  else await call(api, key, send("POST", "/webhooks"), { body: { webhook } });
  return id;
}

// ponytail: the last automation removes the whole webhook; events no automation wants any more stay subscribed until then
export async function unwatch(api: Api, key: string, id: string) {
  const [, connection = ""] = id.split(":");
  for (const h of await ours(api, key, connection)) await call(api, key, send("DELETE", "/webhooks/{id}"), { id: h.id });
}

const same = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

export async function receive(delivery: Delivery) {
  if (!same(delivery.rest.split("/")[0] ?? "", hookToken(delivery.connection))) return null;
  const data = parseBody(delivery.body || "");
  const type = String(data.type ?? "");
  const names = Object.entries(EVENTS)
    .filter(([t, [e]]) => e === type && (TESTS[t]?.(data) ?? true))
    .map(([t]) => t);
  // no delivery id: a retry is the same body, so the body's hash stands in for one
  const id = `${delivery.connection}:${createHash("sha256").update(delivery.body).digest("hex").slice(0, 32)}`;
  const events = async (): Promise<WebhookEvent[]> => (names.length ? [{ id, triggers: names, data, watch: `activecampaign:${delivery.connection}` }] : []);
  return { events };
}
