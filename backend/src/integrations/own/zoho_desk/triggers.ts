// Zoho Desk telling us about events the moment they happen. Desk's webhooks belong to one organisation: one per
// connection and organisation, at /webhooks/app/zoho_desk/<connection>/<token>, carrying the events its automations
// need. Desk signs nothing it sends through webhooks made by API, so the token (worked out from the connection and
// organisation, never stored) is the proof. Desk caps a webhook's address at 100 characters, so the token is short.
// Things Desk has no event for are in polls/zoho_desk.ts. Composio has no Zoho Desk triggers, so the names are Desk's own.
import { createHmac, timingSafeEqual } from "node:crypto";
import type { ActionDetail } from "@emplio/shared";
import { AppsError } from "../../types";
import type { Delivery, WebhookEvent } from "../index";
import { type Api, call, type Send } from "../openapi";
import { pickOne } from "../zoho-login";

type Payload = Record<string, any>;

export const organizations = async (api: Api, key: string) => {
  const out = (await call(api, key, { method: "GET", path: "/api/v1/organizations", query: [], headers: [] }, {})) as { data?: { id: string | number; companyName?: string; portalName?: string }[] };
  return (out.data ?? []).map((o) => ({ id: String(o.id), label: o.companyName || o.portalName || String(o.id) }));
};

// Desk's event → what it's about, in words. Its events end in _Add, _Update, _Delete or say what happened.
const ABOUT: Record<string, string> = {
  Ticket: "A ticket",
  Ticket_Thread: "A reply, email or message on a ticket (a thread), from the customer or an agent",
  Ticket_Comment: "A private comment on a ticket",
  Ticket_Comment_Attachment: "A file on a ticket comment",
  Ticket_Attachment: "A file on a ticket",
  Ticket_Approval: "An approval request on a ticket",
  Contact: "A contact (a customer)",
  Account: "An account (a customer company)",
  Agent: "An agent (a support team member)",
  Agent_Presence: "An agent's availability (online, away, offline)",
  Agent_Channel_Preference: "An agent's channel preferences (which channels they take work from)",
  Department: "A department",
  Task: "A task",
  Call: "A call activity",
  Event: "An event activity (a meeting or appointment)",
  TimeEntry: "A time entry (time logged on a ticket or task)",
  Article: "A help centre article",
  Article_Translation: "A translation of a help centre article",
  Article_Feedback: "Feedback on a help centre article",
  KBRootCategory: "A help centre category",
  KBSection: "A help centre section",
  IM_Message: "An instant message (WhatsApp, Telegram, Facebook and other messaging channels)",
};
const DID: Record<string, [string, string]> = {
  Add: ["added", "was added"],
  Update: ["updated", "changed"],
  Delete: ["deleted", "was deleted"],
  Restored: ["restored", "was restored from the recycle bin"],
  Trashed: ["trashed", "was moved to the recycle bin"],
};
const EVENTS = [
  "Account_Add", "Account_Delete", "Account_Update", "Agent_Add", "Agent_Channel_Preference_Update", "Agent_Delete", "Agent_Presence_Update",
  "Agent_Update", "Article_Add", "Article_Delete", "Article_Feedback_Add", "Article_Translation_Add", "Article_Translation_Delete",
  "Article_Translation_Update", "Article_Update", "Call_Add", "Call_Delete", "Call_Update", "Contact_Add", "Contact_Delete", "Contact_Update",
  "Department_Add", "Department_Update", "Event_Add", "Event_Delete", "Event_Update", "IM_Message_Add", "IM_Message_Status", "IM_Session_Status",
  "KBRootCategory_Add", "KBRootCategory_Delete", "KBRootCategory_Update", "KBSection_Add", "KBSection_Delete", "KBSection_Update", "Task_Add",
  "Task_Delete", "Task_Update", "Ticket_Add", "Ticket_Approval_Add", "Ticket_Approval_Update", "Ticket_Attachment_Add", "Ticket_Attachment_Delete",
  "Ticket_Attachment_Restored", "Ticket_Attachment_Trashed", "Ticket_Attachment_Update", "Ticket_Comment_Add", "Ticket_Comment_Attachment_Add",
  "Ticket_Comment_Attachment_Delete", "Ticket_Comment_Update", "Ticket_Delete", "Ticket_Thread_Add", "Ticket_Update", "TimeEntry_Add",
  "TimeEntry_Delete", "TimeEntry_Update",
];
// the ones Desk can send with the record as it was before (prevState), which the `field` setting needs
const PREV = new Set(["Account_Update", "Agent_Update", "Article_Translation_Update", "Article_Update", "Call_Update", "Contact_Update", "Department_Update", "Event_Update", "KBRootCategory_Update", "KBSection_Update", "Task_Update", "Ticket_Approval_Update", "Ticket_Update", "TimeEntry_Update"]);
const SPECIAL: Record<string, [string, string]> = {
  IM_Message_Status: ["im_message_status_changed", "An instant message's status changed (sent, delivered, read or failed)."],
  IM_Session_Status: ["im_session_status_changed", "An instant messaging conversation's status changed (opened, assigned, ended)."],
};
// a run that replies or comments on the ticket starts these again
const LOOPS: Record<string, string> = {
  Ticket_Thread_Add: " Emplio's own replies count too, so set direction to in for customers' messages only.",
  Ticket_Comment_Add: " A comment Emplio adds counts too, so say in the prompt when not to comment.",
  Ticket_Update: " A change Emplio makes counts too, so say in the prompt when to stop.",
};

const nameOf = (event: string): [string, string] => {
  if (SPECIAL[event]) return SPECIAL[event]!;
  const verb = event.split("_").at(-1)!;
  const thing = event.slice(0, -verb.length - 1);
  const [past, says] = DID[verb]!;
  const snake = thing.replace(/([a-z])([A-Z])/g, "$1_$2").toLowerCase();
  return [`${snake}_${past}`, `${ABOUT[thing]} ${says}.${LOOPS[event] ?? ""}`];
};

const ticketish = (event: string) => event.startsWith("Ticket_") || event.startsWith("TimeEntry_");
const ORG = { name: "org_id", type: "string", required: false, description: "Which Zoho Desk organisation to watch (its orgId). Leave out when the login has just one" };
const DEPARTMENT = { name: "department_id", type: "string", required: false, description: "Only this department (its id; list_departments lists them)" };
const TICKET = { name: "ticket_id", type: "string", required: false, description: "Only this ticket (its id, not the number people see)" };
const FIELD = { name: "field", type: "string", required: false, description: "Only when this field changes, like status, assigneeId, priority or dueDate" };
const DIRECTION = { name: "direction", type: "string", required: false, description: "in: only messages from the customer; out: only replies sent from Zoho Desk" };
const OUTPUT: ActionDetail["input"] = [
  { name: "event_type", type: "string", required: true, description: "Desk's name for the event, like Ticket_Add" },
  { name: "org_id", type: "string", required: true, description: "The organisation it happened in" },
  { name: "event_time", type: "string", required: false, description: "When it happened (milliseconds since 1970)" },
  { name: "payload", type: "object", required: true, description: "The record as it is now: the ticket, thread, contact… (on a delete, just its id)" },
  { name: "prev_state", type: "object", required: false, description: "On a change: the record as it was before" },
];

const ROWS = EVENTS.map((event) => {
  const [name, description] = nameOf(event);
  const config = [ORG, DEPARTMENT, ...(ticketish(event) ? [TICKET] : []), ...(PREV.has(event) ? [FIELD] : []), ...(event === "Ticket_Thread_Add" ? [DIRECTION] : [])];
  return { name, event, description, config };
});
export const events: Record<string, string> = Object.fromEntries(ROWS.map((r) => [r.name, r.event]));
export const triggers: Record<string, { description: string; config: ActionDetail["input"]; output: ActionDetail["input"] }> = Object.fromEntries(
  ROWS.map((r) => [r.name, { description: r.description, config: r.config, output: OUTPUT }]),
);
const NAME_OF = Object.fromEntries(ROWS.map((r) => [r.event, r.name]));

export type EventData = { event_type: string; org_id: string; event_time?: string; payload: Payload; prev_state?: Payload };
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

export function wanted(config: unknown, data: unknown) {
  const c = (config ?? {}) as Payload;
  const d = data as EventData;
  const p = d.payload ?? {};
  if (c.org_id && String(c.org_id) !== String(d.org_id)) return false;
  if (c.department_id && String(p.departmentId) !== String(c.department_id)) return false;
  // a ticket's own events carry it as id, the rest as ticketId
  const ticket = p.ticketId ?? (["Ticket_Add", "Ticket_Update", "Ticket_Delete"].includes(d.event_type) ? p.id : undefined);
  if (c.ticket_id && String(ticket) !== String(c.ticket_id)) return false;
  if (c.direction && String(p.direction ?? "").toLowerCase() !== String(c.direction).toLowerCase()) return false;
  if (c.field && (!d.prev_state || same(d.prev_state[c.field], p[c.field]))) return false;
  return true;
}

// ponytail: Desk lets an API-made webhook carry no signing secret, so an unguessable address proves the sender. Ceiling: a leaked address can forge events for that organisation
const hookToken = (connection: string, org: string) => {
  const key = process.env.ENCRYPTION_KEY;
  if (!key) throw new Error("ENCRYPTION_KEY isn't set");
  return createHmac("sha256", key).update(`zoho_desk-webhook:${connection}:${org}`).digest("base64url").slice(0, 16);
};
const hookUrl = (connection: string, org: string) => `${process.env.WEBHOOK_URL}/webhooks/app/zoho_desk/${connection}/${hookToken(connection, org)}`;
const watchId = (connection: string, org: string) => `zoho_desk:${connection}:${hookToken(connection, org)}`;

const send = (method: string, path = "/api/v1/webhooks", fields: [string, string][] = []): Send => ({
  method,
  path,
  query: [],
  headers: [["org_id", "orgId"]],
  ...(fields.length && { body: { kind: "fields" as const, fields } }),
});
type Hook = { id: string; url: string; isEnabled?: boolean; subscriptions?: Record<string, unknown> };
const findHook = async (api: Api, key: string, org: string, url: string) => {
  const out = (await call(api, key, send("GET"), { org_id: org })) as { data?: Hook[] } | string;
  return (typeof out === "object" ? (out.data ?? []) : []).find((h) => h.url === url);
};

// Make sure this organisation's webhook exists and carries `event`. Answers the id automations are stored under.
export async function watch(api: Api, key: string, connection: string, event: string, config: unknown) {
  if (!process.env.WEBHOOK_URL) throw new AppsError("this server can't receive Zoho Desk's events (WEBHOOK_URL isn't set)");
  const org = await pickOne((config as Payload | null)?.org_id as string | undefined, key, "organisation", "org_id", (k) => organizations(api, k));
  const url = hookUrl(connection, org);
  if (url.length > 100) throw new AppsError(`Zoho Desk takes webhook addresses of up to 100 characters, and this server's is ${url.length}; set a shorter WEBHOOK_URL`);
  const want = PREV.has(event) ? { includePrevState: true } : null;
  try {
    const found = await findHook(api, key, org, url);
    if (found?.isEnabled !== false && found?.subscriptions && event in found.subscriptions) return watchId(connection, org);
    if (found)
      await call(api, key, send("PATCH", "/api/v1/webhooks/{id}", [["subscriptions", "subscriptions"], ["isEnabled", "isEnabled"]]), {
        org_id: org,
        id: found.id,
        subscriptions: { ...found.subscriptions, [event]: want },
        isEnabled: true,
      });
    else
      await call(api, key, send("POST", undefined, [["name", "name"], ["description", "description"], ["url", "url"], ["subscriptions", "subscriptions"], ["isEnabled", "isEnabled"]]), {
        org_id: org,
        name: "Emplio",
        description: "Tells Emplio about changes so its automations can run.",
        url,
        subscriptions: { [event]: want },
        isEnabled: true,
      });
  } catch (error) {
    if (!(error instanceof AppsError)) throw error;
    throw new AppsError(`can't watch Zoho Desk: the connected person must be a Zoho Desk administrator to add webhooks (${error.message})`);
  }
  return watchId(connection, org);
}

// The last automation on this organisation is gone: take the webhook off it.
export async function unwatch(api: Api, key: string, id: string) {
  const [, connection = "", token = ""] = id.split(":");
  for (const { id: org } of await organizations(api, key)) {
    if (hookToken(connection, org) !== token) continue;
    const found = await findHook(api, key, org, hookUrl(connection, org));
    if (found) await call(api, key, send("DELETE", "/api/v1/webhooks/{id}"), { org_id: org, id: found.id });
  }
}

type Raw = { eventType?: string; orgId?: string | number; eventTime?: string | number; payload?: Payload; prevState?: Payload };

// Desk posts a list of events. A post with none in it is Desk checking the address while the webhook is made.
export async function receive(delivery: Delivery) {
  let body: unknown;
  try {
    body = JSON.parse(delivery.body || "null");
  } catch {
    body = null;
  }
  const raw = ([body].flat().filter((e) => e && typeof e === "object" && (e as Raw).eventType) as Raw[]);
  if (!raw.length) return { events: async () => [] };
  const token = Buffer.from(delivery.rest.split("/")[0] ?? "");
  const mine = raw.filter((e) => {
    const want = Buffer.from(hookToken(delivery.connection, String(e.orgId ?? "")));
    return want.length === token.length && timingSafeEqual(want, token);
  });
  if (!mine.length) return null;
  return {
    events: async (): Promise<WebhookEvent[]> =>
      mine.map((e) => {
        const p = e.payload ?? {};
        // Desk sends no delivery id; the change's time tells a retry from a new change
        const id = [delivery.connection, e.orgId, e.eventType, p.id, e.eventTime, p.modifiedTime].join(":");
        const data: EventData = { event_type: e.eventType!, org_id: String(e.orgId), event_time: e.eventTime === undefined ? undefined : String(e.eventTime), payload: p, ...(e.prevState && { prev_state: e.prevState }) };
        return { id, triggers: NAME_OF[e.eventType!] ? [NAME_OF[e.eventType!]!] : [], data };
      }),
  };
}
