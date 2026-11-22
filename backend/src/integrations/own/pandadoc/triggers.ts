// PandaDoc telling us about events the moment they happen. Webhooks are per workspace, and an API key belongs to one
// workspace, so there is one webhook per connection, at /webhooks/app/pandadoc/<connection>/events/<token>, carrying
// the events its automations need. Trigger names are PandaDoc's own event names (Composio has no PandaDoc triggers).
import { createHmac, timingSafeEqual } from "node:crypto";
import type { ActionDetail } from "@emplio/shared";
import { AppsError } from "../../types";
import type { Delivery, WebhookEvent } from "../index";
import { type Api, call, type Send } from "../openapi";

const DOCUMENT_ID = { name: "document_id", type: "string", required: false, description: "Only this document (its id, the long code in its link)" };
const TEMPLATE_ID = { name: "template_id", type: "string", required: false, description: "Only documents made from this template (its id; list_templates lists them)" };
const STATUS = {
  name: "status",
  type: "string",
  required: false,
  description:
    "Only when the document reaches this status: document.sent, document.viewed, document.completed (everyone signed), document.paid, document.declined, document.voided (expired), document.waiting_approval, document.approved, document.rejected or document.draft",
};
const RECIPIENT = { name: "recipient_email", type: "string", required: false, description: "Only when this person finishes (their email)" };
const TEMPLATE_ONLY = { name: "template_id", type: "string", required: false, description: "Only this template (its id)" };

const DOCUMENT_OUTPUT: ActionDetail["input"] = [
  { name: "event", type: "string", required: true, description: "PandaDoc's name for what happened" },
  { name: "id", type: "string", required: true, description: "The document's id" },
  { name: "name", type: "string", required: false, description: "The document's name" },
  { name: "status", type: "string", required: false, description: "Its status now, like document.completed" },
  { name: "recipients", type: "array", required: false, description: "Who it's for, with each one's email and whether they've finished" },
  { name: "grand_total", type: "object", required: false, description: "Its total amount and currency" },
  { name: "template", type: "object", required: false, description: "The template it was made from" },
  { name: "fields", type: "array", required: false, description: "Its form fields and what was filled in" },
  { name: "action_by", type: "object", required: false, description: "On recipient_completed: who finished" },
  { name: "error", type: "object", required: false, description: "On a failed creation: what went wrong" },
];
const OTHER_OUTPUT: ActionDetail["input"] = [
  { name: "event", type: "string", required: true, description: "PandaDoc's name for what happened" },
  { name: "id", type: "string", required: true, description: "The id of the template, item or section" },
  { name: "name", type: "string", required: false, description: "Its name" },
];

const AGAIN = " A run that changes the same document starts this again, so say in the prompt when to stop.";
// [event, description, its settings]
const ROWS: [string, string, ActionDetail["input"]][] = [
  ["document_state_changed", `A PandaDoc document's status changed: sent, viewed, signed by everyone (completed), paid, declined, expired and so on. Set status to react to one of them.${AGAIN}`, [STATUS, TEMPLATE_ID, DOCUMENT_ID]],
  ["recipient_completed", "Someone finished their part of a PandaDoc document: signed, approved or filled it in. The document may still be waiting for others.", [RECIPIENT, TEMPLATE_ID, DOCUMENT_ID]],
  ["document_completed_pdf_ready", "A PandaDoc document was signed by everyone and its final PDF is ready to download (download_completed_document).", [TEMPLATE_ID, DOCUMENT_ID]],
  ["document_updated", `A sent PandaDoc document went back to draft to be edited.${AGAIN}`, [TEMPLATE_ID, DOCUMENT_ID]],
  ["document_deleted", "A PandaDoc document was deleted.", [TEMPLATE_ID, DOCUMENT_ID]],
  ["document_creation_failed", "PandaDoc couldn't finish making a document that was asked for (through Emplio or another app).", [DOCUMENT_ID]],
  ["document_section_added", "A section finished being added to a PandaDoc document.", [DOCUMENT_ID]],
  ["quote_updated", `Someone saved changes to a quote in a PandaDoc document.${AGAIN}`, [TEMPLATE_ID, DOCUMENT_ID]],
  ["recipient_qes_verified", "A recipient's qualified electronic signature (QES) identity check passed on a PandaDoc document.", [TEMPLATE_ID, DOCUMENT_ID]],
  ["template_created", "A PandaDoc template was created.", []],
  ["template_updated", "A PandaDoc template was changed: its name, roles or sections.", [TEMPLATE_ONLY]],
  ["template_deleted", "A PandaDoc template was deleted.", [TEMPLATE_ONLY]],
  ["content_library_item_created", "A content library item (a reusable block for documents) finished being created in PandaDoc.", []],
  ["content_library_item_creation_failed", "PandaDoc couldn't finish creating a content library item that was asked for.", []],
];
export const triggers: Record<string, { description: string; config: ActionDetail["input"]; output: ActionDetail["input"] }> = Object.fromEntries(
  ROWS.map(([e, description, config]) => [e, { description, config, output: e.startsWith("template") || e.startsWith("content") ? OTHER_OUTPUT : DOCUMENT_OUTPUT }]),
);
export const events: Record<string, string> = Object.fromEntries(ROWS.map(([e]) => [e, e]));
// everything a subscription can add to a document's event
const PAYLOAD = ["metadata", "fields", "products", "tokens", "pricing"];

type Data = { event?: string; id?: string; status?: string; template?: { id?: string } | null; action_by?: { email?: string } | null } & Record<string, unknown>;

export const wanted = (config: unknown, data: unknown) => {
  const want = (config ?? {}) as Record<string, string | undefined>;
  const d = data as Data;
  const isTemplate = d.event?.startsWith("template");
  const lower = (s: unknown) => String(s ?? "").toLowerCase();
  return (
    (!want.document_id || d.id === want.document_id) &&
    (!want.template_id || (isTemplate ? d.id : d.template?.id) === want.template_id) &&
    (!want.status || d.status === want.status || d.status === `document.${want.status}`) &&
    (!want.recipient_email || lower(d.action_by?.email) === lower(want.recipient_email))
  );
};

// ponytail: PandaDoc signs with a shared key it picks, and sends the signature in the URL's query, which a Delivery
// doesn't carry; so an unguessable URL proves the sender. Ceiling: a leaked URL can forge events; check ?signature against
// the subscription's shared_key once Delivery has the query string
const hookToken = (connection: string) => createHmac("sha256", process.env.ENCRYPTION_KEY!).update(`pandadoc-webhook:${connection}`).digest("hex");
const hookUrl = (connection: string) => `${process.env.WEBHOOK_URL}/webhooks/app/pandadoc/${connection}/events/${hookToken(connection)}`;

const send = (method: string, path: string, fields: string[] = []): Send => ({ method, path, query: [], headers: [], ...(fields.length && { body: { kind: "fields" as const, fields: fields.map((f): [string, string] => [f, f]) } }) });
type Hook = { uuid: string; url: string; active: boolean; triggers?: string[] | null };
const findHook = async (api: Api, key: string, url: string) => {
  const { items } = (await call(api, key, send("GET", "/public/v1/webhook-subscriptions"), {})) as { items?: Hook[] };
  return (items ?? []).find((h) => h.url === url);
};

// Make sure this workspace's webhook exists, is on, and carries this event.
export async function watch(api: Api, key: string, connection: string, event: string) {
  if (!process.env.WEBHOOK_URL) throw new AppsError("this server can't receive PandaDoc's events (WEBHOOK_URL isn't set)");
  const url = hookUrl(connection);
  const id = `pandadoc:${connection}:events`;
  const found = await findHook(api, key, url);
  if (!found) {
    await call(api, key, send("POST", "/public/v1/webhook-subscriptions", ["name", "url", "active", "payload", "triggers"]), { name: "Emplio", url, active: true, payload: PAYLOAD, triggers: [event] });
    return id;
  }
  const has = found.triggers ?? [];
  // PandaDoc switches a webhook off after a week of failed deliveries; switching it back on is enough
  if (!found.active || !has.includes(event))
    await call(api, key, send("PATCH", "/public/v1/webhook-subscriptions/{uuid}", ["active", "triggers"]), { uuid: found.uuid, active: true, triggers: [...new Set([...has, event])] });
  return id;
}

export async function unwatch(api: Api, key: string, id: string) {
  const [, connection = ""] = id.split(":");
  const found = await findHook(api, key, hookUrl(connection));
  if (found) await call(api, key, send("DELETE", "/public/v1/webhook-subscriptions/{uuid}"), { uuid: found.uuid });
}

export async function receive(delivery: Delivery) {
  const [, token = ""] = delivery.rest.split("/");
  const want = Buffer.from(hookToken(delivery.connection));
  const got = Buffer.from(token);
  if (got.length !== want.length || !timingSafeEqual(got, want)) return null;
  const raw = JSON.parse(delivery.body || "[]") as { event?: string; data?: Record<string, unknown> }[];
  const delivered = delivery.headers["x-pandadoc-webhook-event-id"];
  const out: WebhookEvent[] = (Array.isArray(raw) ? raw : [raw]).flatMap((e, i) => {
    if (!e?.event || !(e.event in events)) return [];
    const d = e.data ?? {};
    // the delivery id is the same on a retry from PandaDoc's dashboard; without it, what the event says
    const id = typeof delivered === "string" && delivered ? `${delivered}:${i}` : [e.event, d.id, d.status, d.date_modified, (d.action_by as { email?: string } | undefined)?.email].join(":");
    return [{ id: `pandadoc:${delivery.connection}:${id}`, triggers: [e.event], data: { event: e.event, ...d } }];
  });
  return { events: async () => out };
}
