// Karbon telling us about changes the moment they happen. One multi-type webhook subscription per connection
// (Karbon allows one per API application and firm), at /webhooks/app/karbon/<connection>, holding the types the
// connection's automations need. Karbon signs each delivery with HMAC-SHA256 of a signing key we send when subscribing:
// worked out from ENCRYPTION_KEY and the connection, never stored. Deliveries carry only keys, so the item is fetched.
import { createHmac, timingSafeEqual } from "node:crypto";
import type { ActionDetail } from "@emplio/shared";
import { AppsError } from "../../types";
import type { Delivery } from "../index";
import { type Api, call, type Send } from "../openapi";

type Field = ActionDetail["input"][number];
type Trigger = { description: string; config: ActionDetail["input"]; output: ActionDetail["input"] };
const field = (name: string, description: string): Field => ({ name, type: "string", required: false, description });
const KEY = (what: string) => field("key", `Only this one ${what} (its key in Karbon)`);
const WORK: Field[] = [
  field("assignee_email", "Only work items assigned to this person (their email address in Karbon)"),
  field("client_key", "Only work for this client (the contact's, organization's or client group's key)"),
  field("work_type", "Only this type of work, like Tax Return or Payroll (get_tenant_settings lists them)"),
  field("primary_status", "Only work items now in this status: Planned, Ready To Start, In Progress, Waiting or Completed"),
];
const OUTPUT: ActionDetail["input"] = [
  { name: "action", type: "string", required: true, description: "What happened: Inserted, Updated or Deleted; InviteAccepted for a user; for an invoice its new status (Approved, Submitted, Exported, AwaitingPayment, Paid, Voided)" },
  { name: "type", type: "string", required: true, description: "What kind of thing: Contact, Organization, ClientGroup, WorkItem, Note, NoteComment, User, Invoice, Estimate or CustomFieldValue" },
  { name: "key", type: "string", required: true, description: "Its key in Karbon (for Estimate, the work item's; for CustomFieldValue, the custom field's)" },
  { name: "data", type: "object", required: false, description: "The item as it is now, fetched from Karbon (missing when deleted)" },
  { name: "event", type: "object", required: true, description: "Karbon's notification as sent: ResourcePermaKey, ResourceType, ActionType, Timestamp, and ClientKey, ClientType or ParentEntityKey where Karbon adds them" },
];
const AGAIN = " A run that changes the same item starts this again, so say in the prompt when to stop.";

// trigger → [webhook type to subscribe to, resource type in the payload, actions it fires on (none: any)]
const RULES: Record<string, [string, string, string[]?]> = {};
export const triggers: Record<string, Trigger> = {};
const OBJECTS: [name: string, type: string, resource: string, label: string, extra: Field[]][] = [
  ["contact", "Contact", "Contact", "contact (a person)", []],
  ["organization", "Contact", "Organization", "organization (a business client)", []],
  ["client_group", "Contact", "ClientGroup", "client group", []],
  ["work_item", "Work", "WorkItem", "work item (a job)", WORK],
  ["note", "Note", "Note", "note", []],
  ["note_comment", "Note", "NoteComment", "comment on a note", [field("note_key", "Only comments on this note (its key)")]],
];
for (const [name, type, resource, label, extra] of OBJECTS) {
  const a = /^[aeiou]/.test(label) ? "An" : "A";
  triggers[`new_${name}`] = { description: `${a} ${label} was added in Karbon.`, config: extra, output: OUTPUT };
  triggers[`${name}_updated`] = { description: `${a} ${label} changed in Karbon.${AGAIN}`, config: [KEY(name.replace("_", " ")), ...extra], output: OUTPUT };
  triggers[`${name}_deleted`] = { description: `${a} ${label} was deleted in Karbon.`, config: [KEY(name.replace("_", " ")), ...extra], output: OUTPUT };
  RULES[`new_${name}`] = [type, resource, ["Inserted"]];
  RULES[`${name}_updated`] = [type, resource, ["Updated"]];
  RULES[`${name}_deleted`] = [type, resource, ["Deleted"]];
}
Object.assign(triggers, {
  user_joined: { description: "A colleague accepted their invite and joined the firm's Karbon.", config: [], output: OUTPUT },
  invoice_status_changed: {
    description: "An invoice moved to a new status in Karbon (Approved, Submitted, Exported, AwaitingPayment, Paid or Voided), or a payment was recorded or removed. Drafts don't count.",
    config: [KEY("invoice"), field("status", "Only when it moves to this status: Approved, Submitted, Exported, AwaitingPayment, Paid or Voided")],
    output: OUTPUT,
  },
  invoice_paid: { description: "An invoice was paid in full in Karbon.", config: [KEY("invoice")], output: OUTPUT },
  work_item_budget_changed: { description: "A work item's time budget (estimate) was set or changed in Karbon." + AGAIN, config: [field("key", "Only this one work item (its key)")], output: OUTPUT },
  custom_field_value_changed: {
    description: "A custom field's value was set or changed on a contact or organization in Karbon." + AGAIN,
    config: [field("field_key", "Only this custom field (its Key; list_custom_fields lists them)"), field("client_key", "Only this contact or organization (its key)")],
    output: OUTPUT,
  },
});
RULES.user_joined = ["User", "User", ["InviteAccepted"]];
RULES.invoice_status_changed = ["Invoice", "Invoice"];
RULES.invoice_paid = ["Invoice", "Invoice", ["Paid"]];
RULES.work_item_budget_changed = ["EstimateSummary", "Estimate"];
RULES.custom_field_value_changed = ["CustomField", "CustomFieldValue"];
export const events: Record<string, string> = Object.fromEntries(Object.entries(RULES).map(([t, [type]]) => [t, type]));

type Notice = { ResourcePermaKey?: string; ResourceType?: string; ActionType?: string; Timestamp?: string; ClientKey?: string; ParentEntityKey?: string };
export type EventData = { action: string; type: string; key: string; data?: any; event: Notice };

// "In Progress" and "InProgress" are the same status to Karbon
const norm = (v: unknown) => String(v ?? "").replace(/\s+/g, "").toLowerCase();
export const wanted = (config: unknown, data: unknown) => {
  const w = (config ?? {}) as Record<string, string | undefined>;
  const d = data as EventData;
  const item = d.data ?? {};
  const same = (want: unknown, got: unknown) => want === undefined || want === "" || norm(want) === norm(got);
  return (
    same(w.key, d.key) &&
    same(w.field_key, d.key) &&
    same(w.status, d.action) &&
    same(w.note_key, d.event.ParentEntityKey) &&
    same(w.client_key, d.event.ClientKey ?? item.ClientKey) &&
    same(w.assignee_email, item.AssigneeEmailAddress) &&
    same(w.work_type, item.WorkType) &&
    same(w.primary_status, item.PrimaryStatus)
  );
};

const signingKey = (connection: string) => createHmac("sha256", process.env.ENCRYPTION_KEY!).update(`karbon-webhook:${connection}`).digest("hex").slice(0, 40);
const hookUrl = (connection: string) => `${process.env.WEBHOOK_URL}/webhooks/app/karbon/${connection}`;
const send = (method: string, path: string, fields: string[] = []): Send => ({ method, path, query: [], headers: [], ...(fields.length && { body: { kind: "fields" as const, fields: fields.map((f): [string, string] => [f, f]) } }) });
const MULTI = "/v3/WebhookSubscriptions/Multi";
type Sub = { TargetUrl?: string; WebhookTypes?: string[] | null };
const current = (api: Api, key: string) =>
  (call(api, key, send("GET", MULTI), {}) as Promise<Sub>).catch((e) => {
    if (e instanceof AppsError && /\(404\)$/.test(e.message)) return null;
    throw e;
  });

export async function watch(api: Api, key: string, connection: string, type: string) {
  if (!process.env.WEBHOOK_URL) throw new AppsError("this server can't receive Karbon's events (WEBHOOK_URL isn't set)");
  const id = `karbon:${connection}`;
  const url = hookUrl(connection);
  const sub = await current(api, key);
  const types = sub?.WebhookTypes ?? [];
  if (sub?.TargetUrl === url) {
    if (!types.includes(type)) await call(api, key, send("PATCH", MULTI, ["WebhookTypes"]), { WebhookTypes: [...types, type] });
    return id;
  }
  // ponytail: Karbon allows one multi-type subscription per firm for our app, so one pointing elsewhere (an old
  // connection to the same firm) is replaced; two live Emplio connections to one firm would take it from each other
  if (sub) await call(api, key, send("DELETE", MULTI), {});
  await call(api, key, send("POST", "/v3/WebhookSubscriptions", ["TargetUrl", "WebhookTypes", "SigningKey"]), { TargetUrl: url, WebhookTypes: [type], SigningKey: signingKey(connection) });
  return id;
}

export async function unwatch(api: Api, key: string, id: string) {
  const [, connection = ""] = id.split(":");
  const sub = await current(api, key);
  if (sub?.TargetUrl === hookUrl(connection)) await call(api, key, send("DELETE", MULTI), {});
}

const signed = (body: string, header: unknown, connection: string) => {
  const got = typeof header === "string" ? header.trim() : "";
  const mac = createHmac("sha256", signingKey(connection)).update(body).digest();
  // the docs show hex; base64 is accepted too, in case
  return [[got.toLowerCase(), mac.toString("hex")], [got, mac.toString("base64")]].some(([g, want]) => g!.length === want!.length && timingSafeEqual(Buffer.from(g!), Buffer.from(want!)));
};

// where each kind of item is read, to send the item itself rather than just its key
const READ: Record<string, [path: string, key?: "ClientKey"]> = {
  Contact: ["/v3/Contacts/{k}"],
  Organization: ["/v3/Organizations/{k}"],
  ClientGroup: ["/v3/ClientGroups/{k}"],
  WorkItem: ["/v3/WorkItems/{k}"],
  Note: ["/v3/Notes/{k}"],
  NoteComment: ["/v3/Comments('{k}')"],
  User: ["/v3/Users/{k}"],
  Invoice: ["/v3/Invoices/{k}"],
  Estimate: ["/v3/EstimateSummaries/{k}"],
  CustomFieldValue: ["/v3/CustomFieldValues/{k}", "ClientKey"],
};
const fetchItem = async (api: Api, key: string, n: Notice) => {
  const [path, by] = READ[n.ResourceType ?? ""] ?? [];
  const k = by ? n[by] : n.ResourcePermaKey;
  if (!path || !k || n.ActionType === "Deleted") return undefined;
  const got = (await call(api, key, { method: "GET", path, query: [], headers: [] }, { k }).catch(() => undefined)) as Record<string, unknown> | undefined;
  if (!got || typeof got !== "object") return undefined;
  const { "@odata.context": _, ...item } = got;
  return item;
};

export async function receive(api: Api, delivery: Delivery, key: string) {
  if (!signed(delivery.body, delivery.headers.signature, delivery.connection)) return null;
  const body = JSON.parse(delivery.body || "{}") as Notice & { Events?: Notice[] };
  // a batched subscription wraps them in {BatchId, Events}; ours isn't batched, but both shapes are read
  const notices = (body.Events ?? [body]).map((n) => ({ ...n, ResourceType: n.ResourceType === "Work" ? "WorkItem" : n.ResourceType }));
  return {
    events: async () =>
      (
        await Promise.all(
          notices.map(async (n) => {
            const names = Object.entries(RULES)
              .filter(([, [, resource, actions]]) => resource === n.ResourceType && (!actions || actions.includes(n.ActionType ?? "")))
              .map(([t]) => t);
            if (!names.length) return [];
            const item = await fetchItem(api, key, n);
            // `seen` is shared across apps, so the connection is in the id; Karbon sends no delivery id of its own
            const id = [delivery.connection, n.ResourceType, n.ResourcePermaKey, n.ActionType, n.Timestamp].join(":");
            const data: EventData = { action: n.ActionType ?? "", type: n.ResourceType ?? "", key: n.ResourcePermaKey ?? "", ...(item && { data: item }), event: n };
            return [{ id, triggers: names, data }];
          }),
        )
      ).flat(),
  };
}
