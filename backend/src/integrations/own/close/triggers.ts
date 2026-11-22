// Close telling us about changes the moment they happen. One webhook subscription per connection, at
// /webhooks/app/close/<connection>/<token>, subscribed to the events its automations want; each automation's settings
// pick what it wants. Each request is checked twice: the URL's token (worked out from ENCRYPTION_KEY, never stored), and
// Close's close-sig-hash with the subscription's signature_key (fetched with the connection's key, kept in memory).
import { createHmac, timingSafeEqual } from "node:crypto";
import type { ActionDetail } from "@emplio/shared";
import { AppsError } from "../../types";
import type { Delivery, WebhookEvent } from "../index";
import { type Api, call, type Send } from "../openapi";

type Field = ActionDetail["input"][number];
const LEAD: Field = { name: "lead_id", type: "string", required: false, description: "Only things on this lead (its id, lead_...; list_leads or search_data finds it)" };
const USER: Field = { name: "user_id", type: "string", required: false, description: "Only when this Close user did it, owns it or is assigned it (their id, user_...; list_users lists them)" };
const FIELD: Field = { name: "field", type: "string", required: false, description: "Only when this field changed, like status_id, value, name or custom.cf_... for a custom field" };
const STATUS: Field = { name: "status_id", type: "string", required: false, description: "Only when the status is now this one (its id, stat_...; list_lead_statuses or list_opportunity_statuses lists them)" };
const PIPELINE: Field = { name: "pipeline_id", type: "string", required: false, description: "Only opportunities in this pipeline (its id, pipe_...; list_pipelines lists them)" };
const OUTPUT: ActionDetail["input"] = [
  { name: "object_type", type: "string", required: true, description: "What kind of thing, like lead, contact, opportunity, task.lead or activity.call" },
  { name: "action", type: "string", required: true, description: "What happened, like created, updated, deleted, completed or sent" },
  { name: "object_id", type: "string", required: true, description: "Its id in Close" },
  { name: "lead_id", type: "string", required: false, description: "The lead it belongs to" },
  { name: "user_id", type: "string", required: false, description: "The Close user who did it" },
  { name: "data", type: "object", required: false, description: "The thing as it is now (missing when deleted)" },
  { name: "previous_data", type: "object", required: false, description: "On an update: the old values of the fields that changed" },
  { name: "changed_fields", type: "array", required: false, description: "On an update: which fields changed" },
  { name: "date_created", type: "string", required: true, description: "When it happened" },
];

// Every task kind Close has; its events come per kind (task.lead, task.outbound_call...)
const TASKS = ["lead", "incoming_email", "email_followup", "missed_call", "answered_detached_call", "voicemail", "opportunity_due", "incoming_sms", "outbound_call"].map((t) => `task.${t}`);
const CUD = ["created", "updated", "deleted"];
// Close's object types → our name, what it is, its actions, and the settings that make sense on it
const OBJECTS: [types: string[], name: string, label: string, actions: string[], config: Field[]][] = [
  [["lead"], "lead", "lead (a company or person you sell to)", [...CUD, "merged"], [LEAD, USER, STATUS]],
  [["contact"], "contact", "contact on a lead", CUD, [LEAD, USER]],
  [["opportunity"], "opportunity", "opportunity (a deal)", CUD, [LEAD, USER, PIPELINE, STATUS]],
  [TASKS, "task", "task", [...CUD, "completed"], [LEAD, USER]],
  [["activity.email"], "email", "email", [...CUD, "sent"], [LEAD, USER]],
  [["activity.email_thread"], "email_thread", "email thread", CUD, [LEAD, USER]],
  [["activity.call"], "call", "call", [...CUD, "answered", "completed"], [LEAD, USER]],
  [["activity.sms"], "sms", "text message (SMS)", [...CUD, "sent"], [LEAD, USER]],
  [["activity.whatsapp_message"], "whatsapp_message", "WhatsApp message", CUD, [LEAD, USER]],
  [["activity.note"], "note", "note", CUD, [LEAD, USER]],
  [["activity.meeting"], "meeting", "meeting", [...CUD, "scheduled", "started", "completed", "canceled"], [LEAD, USER]],
  [["activity.form_submission"], "form_submission", "form submission", CUD, [LEAD]],
  [["activity.lead_status_change"], "lead_status_change", "lead status change", CUD, [LEAD, USER, STATUS]],
  [["activity.opportunity_status_change"], "opportunity_status_change", "opportunity status change", CUD, [LEAD, USER, STATUS, PIPELINE]],
  [["activity.task_completed"], "task_completion", "task completion", ["created", "deleted"], [LEAD, USER]],
  [["activity.lead_merge"], "lead_merge", "lead merge", CUD, [LEAD, USER]],
  [["activity.created"], "lead_creation_activity", "lead creation entry", CUD, [LEAD, USER]],
  [["activity.custom_activity"], "custom_activity", "custom activity", CUD, [LEAD, USER]],
  [["unsubscribed_email"], "unsubscribed_email", "unsubscribed email address", ["created", "deleted"], []],
  [["import"], "import", "CSV import", ["created", "updated", "completed", "reverting", "reverted"], [USER]],
  [["export.lead", "export.opportunity"], "export", "export", ["created", "updated", "completed"], [USER]],
  [["bulk_action.delete"], "bulk_delete", "bulk delete", ["created", "updated", "completed", "paused"], [USER]],
  [["bulk_action.edit"], "bulk_edit", "bulk edit", ["created", "updated", "completed", "paused"], [USER]],
  [["bulk_action.email"], "bulk_email", "bulk email", ["created", "updated", "completed", "paused"], [USER]],
  [["bulk_action.sequence_subscription"], "bulk_sequence_subscription", "bulk sequence subscription", ["created", "updated", "completed", "paused"], [USER]],
  [["custom_fields.lead"], "lead_custom_field", "lead custom field", CUD, []],
  [["custom_fields.contact"], "contact_custom_field", "contact custom field", CUD, []],
  [["custom_fields.opportunity"], "opportunity_custom_field", "opportunity custom field", CUD, []],
  [["custom_fields.activity"], "activity_custom_field", "activity custom field", CUD, []],
  [["custom_fields.custom_object"], "custom_object_custom_field", "custom object custom field", CUD, []],
  [["custom_fields.shared"], "shared_custom_field", "shared custom field", CUD, []],
  [["custom_activity_type"], "custom_activity_type", "custom activity type", CUD, []],
  [["custom_object_type"], "custom_object_type", "custom object type", CUD, []],
  [["custom_object"], "custom_object", "custom object", CUD, [LEAD, USER]],
  [["status.lead"], "lead_status", "lead status (a stage leads move through)", CUD, []],
  [["status.opportunity"], "opportunity_status", "opportunity status (a pipeline stage)", CUD, [PIPELINE]],
  [["membership"], "membership", "team member", ["activated", "deactivated"], []],
  [["group"], "group", "group of users", CUD, []],
  [["saved_search"], "smart_view", "Smart View (saved search)", ["created", "updated"], [USER]],
  [["phone_number"], "phone_number", "Close phone number", CUD, []],
  [["email_template"], "email_template", "email template", CUD, []],
  [["sms_template"], "sms_template", "SMS template", CUD, []],
  [["sequence"], "sequence", "sequence (workflow)", CUD, []],
  [["sequence_subscription"], "sequence_subscription", "sequence enrollment", CUD, [USER]],
  [["comment"], "comment", "comment", CUD, [USER]],
  [["comment_thread"], "comment_thread", "comment thread", CUD, []],
];
// Composio's names for the same events, so automations written for it carry over
const COMPOSIO: Record<string, string> = {
  call_created: "call_logged",
  comment_created: "comment_added",
  custom_activity_created: "custom_activity_logged",
  email_created: "email_logged",
  email_thread_created: "email_thread_started",
  lead_creation_activity_created: "lead_creation_activity_added",
  lead_status_change_created: "lead_status_changed",
  lead_status_change_updated: "lead_status_change_entry_updated",
  lead_status_change_deleted: "lead_status_change_entry_deleted",
  opportunity_status_change_created: "opportunity_status_changed",
  opportunity_status_change_updated: "opportunity_status_change_entry_updated",
  opportunity_status_change_deleted: "opportunity_status_change_entry_deleted",
  note_created: "note_added",
  sms_created: "sms_logged",
  task_completion_created: "task_completion_logged",
  task_completion_deleted: "task_completion_entry_deleted",
  whatsapp_message_created: "whatsapp_message_logged",
};
const SAID: Record<string, string> = { created: "was added", updated: "changed", deleted: "was deleted", merged: "was merged into another", completed: "was completed", sent: "was sent", answered: "was answered", scheduled: "was scheduled or moved", started: "started", canceled: "was canceled", reverting: "started being undone", reverted: "was undone", paused: "was paused and needs attention", activated: "joined the organization", deactivated: "was removed from the organization" };
const AGAIN = " A run that changes the same thing starts this again, so say in the prompt when to stop.";

type Trigger = { description: string; config: ActionDetail["input"]; output: ActionDetail["input"] };
export const triggers: Record<string, Trigger> = {};
// trigger → [Close object types, action, extra test on the event]
type Event = { id?: string; object_type?: string; action?: string; object_id?: string; lead_id?: string; user_id?: string; data?: any; previous_data?: any; changed_fields?: string[]; [k: string]: unknown };
const RULES: Record<string, [string[], string, ((e: Event) => boolean)?]> = {};
for (const [types, name, label, actions, config] of OBJECTS)
  for (const action of actions) {
    const trigger = COMPOSIO[`${name}_${action}`] ?? `${name}_${action}`;
    const a = /^[aeiou]/i.test(label) ? "An" : "A";
    triggers[trigger] = { description: `${a} ${label} ${SAID[action]} in Close.${action === "updated" ? AGAIN : ""}`, config: action === "updated" ? [...config, FIELD] : config, output: OUTPUT };
    RULES[trigger] = [types, action];
  }
const statusNow = (type: string) => (e: Event) => Boolean(e.changed_fields?.includes("status_type")) && e.data?.status_type === type;
triggers.opportunity_won = { description: "An opportunity (a deal) was marked won in Close.", config: [LEAD, USER, PIPELINE], output: OUTPUT };
triggers.opportunity_lost = { description: "An opportunity (a deal) was marked lost in Close.", config: [LEAD, USER, PIPELINE], output: OUTPUT };
RULES.opportunity_won = [["opportunity"], "updated", statusNow("won")];
RULES.opportunity_lost = [["opportunity"], "updated", statusNow("lost")];
// trigger → what start() subscribes to: "<object type>[,<object type>...]:<action>"
export const events: Record<string, string> = Object.fromEntries(Object.entries(RULES).map(([t, [types, action]]) => [t, `${types.join(",")}:${action}`]));

const pick = (v: unknown) => (v && typeof v === "object" ? (v as { id?: unknown }).id : v);
export const wanted = (config: unknown, data: unknown) => {
  const want = (config ?? {}) as { lead_id?: string; user_id?: string; field?: string; status_id?: string; pipeline_id?: string };
  const e = (data ?? {}) as Event;
  const item = e.data ?? e.previous_data ?? {};
  const is = (want: unknown, ...got: unknown[]) => !want || got.some((g) => g != null && String(pick(g)) === String(want));
  return (
    is(want.lead_id, e.lead_id, item.lead_id, e.object_type === "lead" ? e.object_id : undefined) &&
    is(want.user_id, e.user_id, item.user_id, item.assigned_to, item.created_by) &&
    is(want.status_id, item.status_id, item.new_status_id) &&
    is(want.pipeline_id, item.pipeline_id) &&
    (!want.field || Boolean(e.changed_fields?.includes(want.field)))
  );
};

const hookToken = (connection: string) => createHmac("sha256", process.env.ENCRYPTION_KEY!).update(`close-webhook:${connection}`).digest("hex");
export const hookUrl = (connection: string) => `${process.env.WEBHOOK_URL}/webhooks/app/close/${connection}/${hookToken(connection)}`;

const send = (method: string, path: string): Send => ({ method, path, query: [], headers: [], ...((method === "POST" || method === "PUT") && { body: { kind: "whole", field: "body" } }) });
type Sub = { object_type: string; action: string; extra_filter?: unknown };
type Hook = { id: string; url: string; events?: Sub[]; status?: string; signature_key?: string };
const findHook = async (api: Api, key: string, url: string) => ((await call(api, key, send("GET", "/webhook/"), {})) as { data?: Hook[] }).data?.find((h) => h.url === url);
const subs = (event: string): Sub[] => {
  const [types = "", action = ""] = event.split(":");
  return types.split(",").map((object_type) => ({ object_type, action }));
};
const has = (list: Sub[], s: Sub) => list.some((x) => x.object_type === s.object_type && x.action === s.action && !x.extra_filter);

// Make sure the connection's subscription is there, active, and receives this event
export async function watch(api: Api, key: string, connection: string, event: string) {
  if (!process.env.WEBHOOK_URL) throw new AppsError("this server can't receive Close's events (WEBHOOK_URL isn't set)");
  const url = hookUrl(connection);
  const id = `close:${connection}`;
  const want = subs(event);
  const found = await findHook(api, key, url);
  const have = found?.events ?? [];
  const missing = want.filter((s) => !has(have, s));
  // ponytail: events are only ever added; the whole subscription goes when the connection's last automation does
  if (found && !missing.length && found.status === "active") return id;
  // Close pauses a subscription after 3 days of failed deliveries; this turns it back on
  if (found) await call(api, key, send("PUT", "/webhook/{id}/"), { id: found.id, body: { events: [...have, ...missing], status: "active" } });
  else await call(api, key, send("POST", "/webhook/"), { body: { url, events: want, verify_ssl: true } });
  return id;
}

export async function unwatch(api: Api, key: string, id: string) {
  const found = await findHook(api, key, hookUrl(id.split(":")[1] ?? ""));
  if (found) await call(api, key, send("DELETE", "/webhook/{id}/"), { id: found.id });
}

// subscription id → its signature_key
const keys = new Map<string, string>();
const keyOf = async (api: Api, key: string, sub: string, connection: string, fresh: boolean) => {
  if (!fresh && keys.has(sub)) return keys.get(sub)!;
  const got = (await call(api, key, send("GET", "/webhook/{id}/"), { id: sub })) as Hook;
  // only our own subscription's key counts
  const signing = got.url === hookUrl(connection) ? (got.signature_key ?? "") : "";
  keys.set(sub, signing);
  return signing;
};
const header = (d: Delivery, name: string) => {
  const v = d.headers[name];
  return typeof v === "string" ? v : undefined;
};
const same = (a: string, b: string) => Buffer.from(a).length === Buffer.from(b).length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

export async function receive(api: Api, delivery: Delivery, key: string) {
  if (!same(delivery.rest.split("/")[0] ?? "", hookToken(delivery.connection))) return null;
  const signature = header(delivery, "close-sig-hash");
  const timestamp = header(delivery, "close-sig-timestamp");
  if (!signature || !timestamp) return null;
  const body = JSON.parse(delivery.body || "{}") as { subscription_id?: string; event?: Event };
  if (!body.subscription_id) return null;
  const sign = (hex: string) => createHmac("sha256", Buffer.from(hex, "hex")).update(timestamp + delivery.body).digest("hex");
  const ok = async (fresh: boolean) => {
    const secret = await keyOf(api, key, body.subscription_id!, delivery.connection, fresh).catch(() => "");
    return Boolean(secret) && same(signature, sign(secret));
  };
  // the subscription may have been made again since we kept its key
  if (!(await ok(false)) && !(await ok(true))) return null;
  const { organization_id: _, request_id: __, ...e } = body.event ?? {};
  const names = Object.entries(RULES)
    .filter(([, [types, action, test]]) => types.includes(e.object_type ?? "") && action === e.action && (!test || test(e)))
    .map(([t]) => t);
  return {
    // events arrive at .../<connection>/<token>, but automations are kept under close:<connection>
    events: async (): Promise<WebhookEvent[]> => (names.length ? [{ id: e.id ? `${delivery.connection}:${e.id}` : undefined, triggers: names, data: e, watch: `close:${delivery.connection}` }] : []),
  };
}
