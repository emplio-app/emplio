// Dropbox Sign telling us about events the moment they happen. It has one callback address per account (PUT /account
// callback_url), so one per connection: /webhooks/app/dropbox_sign/<connection>/<token>, and every event comes down it.
// Each is signed: event_hash = HMAC-SHA256(API key, event_time + event_type), and it wants "Hello API Event Received" back.
// Composio has no Dropbox Sign triggers, so the names are Dropbox Sign's own event types.
import { createHmac, timingSafeEqual } from "node:crypto";
import type { ActionDetail } from "@emplio/shared";
import { AppsError } from "../../types";
import type { Delivery, WebhookEvent } from "../index";
import { type Api, call, type Send } from "../openapi";

const REQUEST = { name: "signature_request_id", type: "string", required: false, description: "Only this signature request (its id, from list_signature_requests)" };
const TEMPLATE = { name: "template_id", type: "string", required: false, description: "Only requests sent from this template, or this template itself (its id, from list_templates)" };
const SIGNER = { name: "signer_email", type: "string", required: false, description: "Only when this signer's email is the one the event is about (signed, viewed)" };
const OUTPUT: ActionDetail["input"] = [
  { name: "event_type", type: "string", required: true, description: "What happened, like signature_request_signed" },
  { name: "event_time", type: "string", required: true, description: "When, in Unix time" },
  { name: "event_message", type: "string", required: false, description: "Why a request was declined or failed, when it was" },
  { name: "signer", type: "object", required: false, description: "The signer the event is about (name, email, status), on signed and viewed" },
  { name: "signature_request", type: "object", required: false, description: "The whole signature request as it is now: title, signers and their status, files link" },
  { name: "template", type: "object", required: false, description: "The template, on template events" },
];

const request = (description: string) => ({ description, config: [REQUEST, TEMPLATE, SIGNER], output: OUTPUT });
const other = (description: string) => ({ description, config: [] as ActionDetail["input"], output: OUTPUT });
export const triggers: Record<string, { description: string; config: ActionDetail["input"]; output: ActionDetail["input"] }> = {
  signature_request_sent: request("A signature request was sent out from the Dropbox Sign account."),
  signature_request_viewed: request("A signer opened a Dropbox Sign signature request."),
  signature_request_signed: request("A signer signed a Dropbox Sign signature request (others may still have to)."),
  signature_request_all_signed: request("Everyone has signed a Dropbox Sign signature request. The signed copy may take a moment more: signature_request_downloadable says when it's ready."),
  signature_request_downloadable: request("The signed copy of a Dropbox Sign signature request is ready to download."),
  signature_request_declined: request("A signer declined to sign a Dropbox Sign signature request; event_message says why."),
  signature_request_reassigned: request("A signer passed a Dropbox Sign signature request on to someone else."),
  signature_request_remind: request("A reminder went out for a Dropbox Sign signature request. A run that sends a reminder starts this again."),
  signature_request_email_bounce: request("An email for a Dropbox Sign signature request bounced: a signer's address is probably wrong."),
  signature_request_invalid: request("A Dropbox Sign signature request couldn't be processed (a problem with its file or fields)."),
  signature_request_canceled: request("A Dropbox Sign signature request was cancelled before everyone signed. A run that cancels one starts this again."),
  signature_request_expired: request("A Dropbox Sign signature request expired before everyone signed."),
  signature_request_prepared: request("A Dropbox Sign signature request was prepared and is waiting to be sent."),
  signature_request_signer_removed: request("A signer was taken off a Dropbox Sign signature request."),
  signature_request_destroyed: request("A Dropbox Sign signature request's documents were deleted for good."),
  signature_request_incomplete_qes: request("A Dropbox Sign signature request needing a qualified electronic signature (QES) was left incomplete."),
  file_error: request("Dropbox Sign couldn't process a file for a signature request."),
  unknown_error: request("Something went wrong in Dropbox Sign with a signature request."),
  sign_url_invalid: request("An embedded signing link for a Dropbox Sign request stopped working."),
  template_created: { ...other("A Dropbox Sign template finished being created and is ready to use."), config: [TEMPLATE] },
  template_error: { ...other("A Dropbox Sign template couldn't be created."), config: [TEMPLATE] },
  account_confirmed: other("A Dropbox Sign account made through the API was confirmed by its owner."),
  fax_received: other("A fax came in on one of the Dropbox Sign account's fax lines."),
  fax_sent: other("A fax sent from the Dropbox Sign account went through."),
  fax_on_hold: other("A fax from the Dropbox Sign account is on hold."),
  fax_busy: other("A fax from the Dropbox Sign account couldn't go through: the line was busy."),
  fax_no_answer: other("A fax from the Dropbox Sign account couldn't go through: no answer."),
  fax_disconnected: other("A fax from the Dropbox Sign account was cut off."),
  fax_blacklisted: other("A fax from the Dropbox Sign account was refused: the number is blocked."),
};
export const events: Record<string, string> = Object.fromEntries(Object.keys(triggers).map((t) => [t, t]));

type Signature = { signature_id?: string; signer_email_address?: string };
type Payload = {
  event: { event_time: string; event_type: string; event_hash: string; event_metadata?: { related_signature_id?: string | null; event_message?: string | null } };
  signature_request?: { signature_request_id?: string; template_ids?: string[] | null; signatures?: Signature[] };
  template?: { template_id?: string };
  [k: string]: unknown;
};
export type EventData = { event_type: string; event_time: string; event_message?: string; signer?: Signature; signature_request?: Payload["signature_request"]; template?: Payload["template"]; [k: string]: unknown };

export const wanted = (config: unknown, data: unknown) => {
  const want = (config ?? {}) as { signature_request_id?: string; template_id?: string; signer_email?: string };
  const d = data as EventData;
  const templates = [...(d.signature_request?.template_ids ?? []), d.template?.template_id];
  return (
    (!want.signature_request_id || d.signature_request?.signature_request_id === want.signature_request_id) &&
    (!want.template_id || templates.includes(want.template_id)) &&
    (!want.signer_email || d.signer?.signer_email_address?.toLowerCase() === want.signer_email.toLowerCase())
  );
};

// Dropbox Sign's hash covers only the time and the type, so an unguessable address is what keeps a replayed hash from carrying a forged body
const hookToken = (connection: string) => createHmac("sha256", process.env.ENCRYPTION_KEY!).update(`dropbox_sign-webhook:${connection}`).digest("hex");
const PREFIX = () => `${process.env.WEBHOOK_URL}/webhooks/app/dropbox_sign/`;
const hookUrl = (connection: string) => `${PREFIX()}${connection}/${hookToken(connection)}`;

const ACCOUNT: Send = { method: "GET", path: "/account", query: [], headers: [] };
const SET: Send = { method: "PUT", path: "/account", query: [], headers: [], body: { kind: "fields", fields: [["callback_url", "callback_url"]] } };
const current = async (api: Api, key: string) => ((await call(api, key, ACCOUNT, {})) as { account?: { callback_url?: string | null } }).account?.callback_url ?? "";

// Point the account's callback at us. One someone else set (their own system) is left alone rather than broken.
export async function watch(api: Api, key: string, connection: string) {
  if (!process.env.WEBHOOK_URL) throw new AppsError("this server can't receive Dropbox Sign's events (WEBHOOK_URL isn't set)");
  const url = hookUrl(connection);
  const id = `dropbox_sign:${connection}`;
  const now = await current(api, key);
  if (now === url) return id;
  if (now && !now.startsWith(PREFIX()))
    throw new AppsError(`your Dropbox Sign account already sends its events to ${now}. Clear the account callback in Dropbox Sign (Settings → API) if Emplio should take them over.`);
  // Dropbox Sign sends a callback_test to the address before it answers; receive() replies to it
  await call(api, key, SET, { callback_url: url });
  return id;
}

export async function unwatch(api: Api, key: string, id: string) {
  const [, connection = ""] = id.split(":");
  if ((await current(api, key)) === hookUrl(connection)) await call(api, key, SET, { callback_url: "" });
}

const sameText = (a: string, b: string) => Buffer.from(a).length === Buffer.from(b).length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

// the event comes as a form with a "json" field (multipart or urlencoded), or as plain JSON
async function parse(delivery: Delivery): Promise<Payload | null> {
  const body = delivery.body ?? "";
  if (body.trimStart().startsWith("{")) return JSON.parse(body);
  const type = String(delivery.headers["content-type"] ?? "application/x-www-form-urlencoded");
  const form = await new Response(body, { headers: { "content-type": type } }).formData();
  const json = form.get("json");
  return typeof json === "string" ? JSON.parse(json) : null;
}

export async function receive(delivery: Delivery, key: string) {
  const connection = delivery.connection;
  if (!sameText(delivery.rest.split("/")[0] ?? "", hookToken(connection))) return null;
  const payload = await parse(delivery).catch(() => null);
  const e = payload?.event;
  if (!e?.event_hash || !e.event_time || !e.event_type) return null;
  if (!sameText(e.event_hash, createHmac("sha256", key).update(`${e.event_time}${e.event_type}`).digest("hex"))) return null;
  // the answer Dropbox Sign wants, or it keeps retrying and in the end turns the callback off
  const reply = "Hello API Event Received";
  if (!triggers[e.event_type]) return { reply, events: async () => [] };
  const { event: _, ...rest } = payload!;
  const related = e.event_metadata?.related_signature_id ?? undefined;
  const signer = related ? payload!.signature_request?.signatures?.find((s) => s.signature_id === related) : undefined;
  const data: EventData = { event_type: e.event_type, event_time: e.event_time, ...(e.event_metadata?.event_message && { event_message: e.event_metadata.event_message }), ...(signer && { signer }), ...rest };
  const about = payload!.signature_request?.signature_request_id ?? payload!.template?.template_id ?? "";
  const event: WebhookEvent = { id: [connection, about, e.event_time, e.event_type, related].join(":"), triggers: [e.event_type], data, watch: `dropbox_sign:${connection}` };
  return { reply, events: async () => [event] };
}
