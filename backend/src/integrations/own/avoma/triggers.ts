// Avoma telling us the moment a meeting's notes are ready or a scheduler booking changes. Avoma's webhooks are one
// subscription per event, organization-wide, so each event gets its own: /webhooks/app/avoma/<connection>/<EVENT>.
// Avoma signs every delivery with one secret for the whole organization: if it has none, we set ours (an HMAC of
// ENCRYPTION_KEY and the connection, never stored); if it already has one (someone else's integration), we keep it and
// check deliveries against it, read through the connection's key.
import type { ActionDetail } from "@emplio/shared";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { AppsError } from "../../types";
import type { Delivery, WebhookEvent } from "../index";
import { type Api, call, type Send } from "../openapi";

// our trigger → Avoma's event; every organization event its API offers
export const events: Record<string, string> = {
  notes_ready: "AINOTE",
  meeting_booked: "MEETING_BOOKED_VIA_SCHEDULER",
  booking_canceled: "MEETING_BOOKED_VIA_SCHEDULER_CANCELED",
  booking_rescheduled: "MEETING_BOOKED_VIA_SCHEDULER_RESCHEDULED",
};

const ORGANIZER = { name: "organizer_email", type: "string", required: false, description: "Only meetings this person organized (their email)" };
const NOTES: ActionDetail["input"] = [
  { name: "uuid", type: "string", required: true, description: "The meeting's uuid; get_meeting, list_notes and get_meeting_analysis take it" },
  { name: "subject", type: "string", required: true, description: "The meeting's title" },
  { name: "start_at", type: "string", required: false, description: "When it started" },
  { name: "organizer_email", type: "string", required: false, description: "Who organized it" },
  { name: "attendees", type: "object[]", required: false, description: "Who was invited: name, email, response_status" },
  { name: "ai_notes_txt", type: "string", required: false, description: "Avoma's AI notes, as text" },
  { name: "action_items", type: "object[]", required: false, description: "Action items: action_item, name, email, company" },
  { name: "purpose", type: "object", required: false, description: "The meeting type (label)" },
  { name: "outcome", type: "object", required: false, description: "The meeting outcome (label)" },
  { name: "is_internal", type: "boolean", required: false, description: "True when everyone was from the organization" },
  { name: "is_call", type: "boolean", required: false, description: "A phone call rather than a video meeting" },
  { name: "meeting_url", type: "string", required: false, description: "The meeting in Avoma" },
  { name: "transcription_uuid", type: "string", required: false, description: "The transcript's uuid; get_transcription takes it" },
];
const BOOKING: ActionDetail["input"] = [
  { name: "meeting_uuid", type: "string", required: true, description: "The meeting Avoma made for the booking" },
  { name: "subject", type: "string", required: true, description: "The meeting's title" },
  { name: "event_start_time", type: "string", required: true, description: "When it starts" },
  { name: "event_end_time", type: "string", required: false, description: "When it ends" },
  { name: "invitee_details", type: "object", required: true, description: "Who booked: name, email, tz" },
  { name: "invitee_responses", type: "object[]", required: false, description: "Their answers to the booking questions: question, response" },
  { name: "organizer_email", type: "string", required: false, description: "Whose calendar it's on" },
  { name: "conference_link", type: "string", required: false, description: "The video call link" },
  { name: "cancel_reason", type: "string", required: false, description: "Why it was cancelled" },
];
const trigger = (description: string, output: ActionDetail["input"]) => ({ description, config: [ORGANIZER], output });
export const triggers: Record<string, { description: string; config: ActionDetail["input"]; output: ActionDetail["input"] }> = {
  notes_ready: trigger("Avoma has finished a meeting's notes: AI notes, action items and the transcript are ready.", NOTES),
  meeting_booked: trigger("Someone books a meeting through an Avoma scheduling page.", BOOKING),
  booking_canceled: trigger("A meeting booked through an Avoma scheduling page is cancelled.", BOOKING),
  booking_rescheduled: trigger("A meeting booked through an Avoma scheduling page is moved.", BOOKING),
};

export const ourSecret = (connection: string) => createHmac("sha256", process.env.ENCRYPTION_KEY!).update(`avoma-webhook:${connection}`).digest("hex");
const hookUrl = (connection: string, event: string) => `${process.env.WEBHOOK_URL}/webhooks/app/avoma/${connection}/${event}`;
const send = (method: string, path: string, fields: string[] = []): Send => ({
  method,
  path,
  query: [],
  headers: [],
  ...(fields.length && { body: { kind: "fields" as const, fields: fields.map((f): [string, string] => [f, f]) } }),
});
const LIST = send("GET", "/v1/webhooks/");
const CREATE = send("POST", "/v1/webhooks/", ["event_type", "target_type", "target_url"]);
const REMOVE = send("DELETE", "/v1/webhooks/{uuid}/");
const SECRET = send("GET", "/v1/webhooks/signing-secret/");
const SET_SECRET = send("PATCH", "/v1/webhooks/signing-secret/", ["signing_secret"]);

type Subscription = { uuid: string; event_type: string; target_url: string; is_active?: boolean };
// ponytail: the first page of subscriptions; an organization with more than a page of them could make a second one of ours
const find = async (api: Api, key: string, url: string) =>
  ((await call(api, key, LIST, {})) as { results?: Subscription[] }).results?.find((s) => s.target_url === url && s.is_active !== false);
const orgSecret = async (api: Api, key: string) => ((await call(api, key, SECRET, {})) as { signing_secret?: string }).signing_secret ?? "";

export async function watch(api: Api, key: string, connection: string, event: string) {
  if (!process.env.WEBHOOK_URL) throw new AppsError("this server can't receive Avoma's events (WEBHOOK_URL isn't set)");
  const url = hookUrl(connection, event);
  try {
    // unsigned deliveries are refused, so the organization must have a secret
    if (!(await orgSecret(api, key))) await call(api, key, SET_SECRET, { signing_secret: ourSecret(connection) });
    if (!(await find(api, key, url))) await call(api, key, CREATE, { event_type: event, target_type: 2, target_url: url });
  } catch (error) {
    if (!(error instanceof AppsError) || error.expired) throw error;
    throw new AppsError(`can't watch this Avoma account: its webhooks need an admin's API key and a plan with webhooks (${error.message})`);
  }
  return `avoma:${connection}:${event}`;
}

export async function unwatch(api: Api, key: string, id: string) {
  const [, connection = "", event = ""] = id.split(":");
  const found = await find(api, key, hookUrl(connection, event));
  if (found) await call(api, key, REMOVE, { uuid: found.uuid });
}

const matches = (body: string, secret: string, got: string) => {
  const want = Buffer.from(createHmac("sha256", secret).update(body).digest("hex"));
  const sent = Buffer.from(got);
  return Boolean(secret) && sent.length === want.length && timingSafeEqual(sent, want);
};

export async function receive(api: Api, delivery: Delivery, key: string) {
  const got = String(delivery.headers["x-avoma-signature"] ?? "");
  if (!got) return null;
  // ours, or the one the organization already had
  if (!matches(delivery.body, ourSecret(delivery.connection), got) && !matches(delivery.body, await orgSecret(api, key), got)) return null;
  return {
    events: async (): Promise<WebhookEvent[]> => {
      const { ai_notes, ...body } = JSON.parse(delivery.body || "{}") as Record<string, unknown>;
      const event = String(body.event_type ?? delivery.rest.split("/")[0]);
      const names = Object.keys(events).filter((t) => events[t] === event);
      // Avoma sends no delivery id; a retry is the same body
      return names.length ? [{ id: `avoma:${delivery.connection}:${createHash("sha256").update(delivery.body).digest("hex")}`, triggers: names, data: body }] : [];
    },
  };
}

export const wanted = (config: unknown, data: unknown) => {
  const who = String((config as { organizer_email?: string } | null)?.organizer_email ?? "").toLowerCase();
  return !who || String((data as { organizer_email?: string }).organizer_email ?? "").toLowerCase() === who;
};
