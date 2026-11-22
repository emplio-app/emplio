// Cal.com telling us about bookings, meetings, recordings, forms and time off the moment they happen. One webhook per
// connection (POST /v2/webhooks, the account's own: every event type the person hosts), at
// /webhooks/app/calcom/<connection>, holding every event an automation asked for. Cal.com signs each delivery with
// X-Cal-Signature-256, an HMAC of the body under a secret worked out from ENCRYPTION_KEY and the connection, never stored.
import { createHmac, timingSafeEqual } from "node:crypto";
import type { ActionDetail } from "@emplio/shared";
import { AppsError } from "../../types";
import type { Delivery } from "../index";
import { type Api, call, type Send } from "../openapi";

type Field = ActionDetail["input"][number];
const EVENT_TYPE: Field = { name: "event_type_id", type: "number", required: false, description: "Only bookings of this event type, like your 30-minute call (its id; list_event_types lists them)" };
const ATTENDEE: Field = { name: "attendee_email", type: "string", required: false, description: "Only bookings with this guest (their email)" };
const FORM: Field = { name: "form_id", type: "string", required: false, description: "Only answers to this routing form (its id)" };
const OUTPUT: ActionDetail["input"] = [
  { name: "event", type: "string", required: true, description: "Cal.com's name for what happened, like BOOKING_CREATED" },
  { name: "created_at", type: "string", required: true, description: "When it happened" },
  {
    name: "payload",
    type: "object",
    required: true,
    description:
      "What it's about, as Cal.com sends it. For a booking: uid, bookingId, title, type (the event type's slug), eventTypeId, startTime, endTime, organizer and attendees (name, email, timeZone), location, responses (the booking form's answers), status, cancellationReason, rescheduleUid, metadata.videoCallUrl. For a form: formId, formName, responses. For time off: oooEntry",
  },
];
const AGAIN = " A run that changes bookings can cause this again, so say in the prompt when to stop.";
const NO_SHOW_MINUTES = 15;

type Kind = "booking" | "form" | "other";
// trigger → Cal.com's event, what it means, and which filters fit
const T: Record<string, [event: string, about: string, kind: Kind]> = {
  booking_created: ["BOOKING_CREATED", `Someone booked a meeting on Cal.com and it's confirmed (one that waits for your OK is booking_requested).${AGAIN}`, "booking"],
  booking_requested: ["BOOKING_REQUESTED", "Someone asked for a meeting on Cal.com that needs your confirmation before it's booked.", "booking"],
  booking_rescheduled: ["BOOKING_RESCHEDULED", `A Cal.com booking moved to another time. payload.rescheduleUid is the old booking.${AGAIN}`, "booking"],
  booking_cancelled: ["BOOKING_CANCELLED", `A Cal.com booking was cancelled, by the guest or by you; payload.cancellationReason says why when given.${AGAIN}`, "booking"],
  booking_rejected: ["BOOKING_REJECTED", "A Cal.com booking request was declined.", "booking"],
  booking_payment_initiated: ["BOOKING_PAYMENT_INITIATED", "Someone started paying for a paid Cal.com booking.", "booking"],
  booking_paid: ["BOOKING_PAID", "A paid Cal.com booking was paid for.", "booking"],
  booking_no_show_updated: ["BOOKING_NO_SHOW_UPDATED", "Someone was marked as a no-show (or not) on a Cal.com booking.", "booking"],
  booking_location_updated: ["BOOKING_LOCATION_UPDATED", "Where a Cal.com booking happens changed (a new address, phone number or video link).", "booking"],
  booking_title_updated: ["BOOKING_TITLE_UPDATED", "A Cal.com booking's title changed.", "booking"],
  booking_reassigned: ["BOOKING_REASSIGNED", "A Cal.com booking was handed to another host on the team.", "booking"],
  booking_seat_accepted: ["BOOKING_SEAT_ACCEPTED", "Someone took a seat at a Cal.com event with seats (a class, a webinar).", "booking"],
  booking_seat_rejected: ["BOOKING_SEAT_REJECTED", "A seat request at a Cal.com event with seats was declined.", "booking"],
  sequence_booking_created: ["SEQUENCE_BOOKING_CREATED", "Someone booked a sequence of meetings on Cal.com (an event type sequence).", "booking"],
  meeting_started: ["MEETING_STARTED", "A Cal.com booking's meeting has started (at its start time).", "booking"],
  meeting_ended: ["MEETING_ENDED", "A Cal.com booking's meeting has ended (at its end time). Good for follow-ups.", "booking"],
  recording_ready: ["RECORDING_READY", "The recording of a Cal Video meeting is ready; payload.downloadLink has it.", "booking"],
  recording_transcription_generated: ["RECORDING_TRANSCRIPTION_GENERATED", "The transcript of a Cal Video meeting's recording is ready.", "booking"],
  instant_meeting: ["INSTANT_MEETING", "Someone asked for an instant meeting on Cal.com, to start right now.", "booking"],
  instant_meeting_accepted: ["INSTANT_MEETING_ACCEPTED", "A host accepted an instant meeting on Cal.com.", "booking"],
  after_hosts_cal_video_no_show: ["AFTER_HOSTS_CAL_VIDEO_NO_SHOW", `No host had joined a Cal Video meeting ${NO_SHOW_MINUTES} minutes after it started.`, "booking"],
  after_guests_cal_video_no_show: ["AFTER_GUESTS_CAL_VIDEO_NO_SHOW", `No guest had joined a Cal Video meeting ${NO_SHOW_MINUTES} minutes after it started.`, "booking"],
  form_submitted: ["FORM_SUBMITTED", "Someone filled in a Cal.com routing form; payload.responses has the answers.", "form"],
  form_submitted_no_event: ["FORM_SUBMITTED_NO_EVENT", "Someone filled in a Cal.com routing form but didn't go on to book.", "form"],
  routing_form_fallback_hit: ["ROUTING_FORM_FALLBACK_HIT", "A Cal.com routing form's answers matched no route, so the fallback route was used.", "form"],
  wrong_assignment_report: ["WRONG_ASSIGNMENT_REPORT", "Someone reported that a Cal.com booking went to the wrong host.", "booking"],
  ooo_created: ["OOO_CREATED", "Someone set time off (out of office) in Cal.com; payload.oooEntry has the dates and who covers.", "other"],
  calendar_entry_rejected: ["CALENDAR_ENTRY_REJECTED", "A connected calendar refused an event Cal.com tried to put on it.", "other"],
  event_registration_requested: ["CAL_EVENT_REGISTRATION_REQUESTED", "Someone asked to register for a Cal.com event (one that needs approval).", "other"],
  event_registration_confirmed: ["CAL_EVENT_REGISTRATION_CONFIRMED", "Someone's registration for a Cal.com event was confirmed.", "other"],
  event_registration_waitlisted: ["CAL_EVENT_REGISTRATION_WAITLISTED", "Someone was put on the waitlist for a full Cal.com event.", "other"],
  event_registration_declined: ["CAL_EVENT_REGISTRATION_DECLINED", "Someone's registration for a Cal.com event was declined.", "other"],
  event_registration_cancelled: ["CAL_EVENT_REGISTRATION_CANCELLED", "Someone's registration for a Cal.com event was cancelled.", "other"],
  delegation_credential_error: ["DELEGATION_CREDENTIAL_ERROR", "The organization's calendar access for its members (delegation credential) stopped working.", "other"],
  delegation_credential_rotation_required: ["DELEGATION_CREDENTIAL_ROTATION_REQUIRED", "The organization's delegation credential needs a new secret.", "other"],
  delegation_credential_secret_rotated: ["DELEGATION_CREDENTIAL_SECRET_ROTATED", "The organization's delegation credential got a new secret.", "other"],
  delegation_credential_secret_rotation_failed: ["DELEGATION_CREDENTIAL_SECRET_ROTATION_FAILED", "Giving the organization's delegation credential a new secret failed.", "other"],
};
const FILTERS: Record<Kind, Field[]> = { booking: [EVENT_TYPE, ATTENDEE], form: [FORM], other: [] };

export const triggers: Record<string, { description: string; config: ActionDetail["input"]; output: ActionDetail["input"] }> = Object.fromEntries(
  Object.entries(T).map(([name, [, about, kind]]) => [name, { description: about, config: FILTERS[kind], output: OUTPUT }]),
);
export const events: Record<string, string> = Object.fromEntries(Object.entries(T).map(([name, [event]]) => [name, event]));

export type EventData = { event: string; created_at: string; payload: Record<string, any> };

export const wanted = (config: unknown, data: unknown) => {
  const want = (config ?? {}) as { event_type_id?: number | string; attendee_email?: string; form_id?: string };
  const p = (data as EventData).payload ?? {};
  const given = (v: unknown) => v !== undefined && v !== "";
  if (given(want.event_type_id) && String(want.event_type_id) !== String(p.eventTypeId)) return false;
  if (given(want.attendee_email) && !(p.attendees ?? []).some((a: { email?: string }) => a.email?.toLowerCase() === want.attendee_email!.toLowerCase())) return false;
  if (given(want.form_id) && String(want.form_id) !== String(p.formId)) return false;
  return true;
};

const secret = (connection: string) => createHmac("sha256", process.env.ENCRYPTION_KEY!).update(`calcom-webhook:${connection}`).digest("hex");
const hookUrl = (connection: string) => `${process.env.WEBHOOK_URL}/webhooks/app/calcom/${connection}`;

const send = (method: string, path: string, fields: string[] = [], query: string[] = []): Send => ({ method, path, query, headers: [], ...(fields.length && { body: { kind: "fields" as const, fields: fields.map((f): [string, string] => [f, f]) } }) });
type Hook = { id: number | string; subscriberUrl: string; triggers: string[]; active: boolean };
const ours = async (api: Api, key: string, connection: string) => {
  const { data } = (await call(api, key, send("GET", "/v2/webhooks", [], ["take"]), { take: 250 })) as { data?: Hook[] };
  return (data ?? []).filter((h) => h.subscriberUrl === hookUrl(connection));
};
const FIELDS = ["active", "subscriberUrl", "triggers", "secret", "time", "timeUnit"];
const NO_SHOW = ["AFTER_HOSTS_CAL_VIDEO_NO_SHOW", "AFTER_GUESTS_CAL_VIDEO_NO_SHOW"];

export async function watch(api: Api, key: string, connection: string, event: string, _config?: unknown) {
  if (!process.env.WEBHOOK_URL) throw new AppsError("this server can't receive Cal.com's events (WEBHOOK_URL isn't set)");
  const id = `calcom:${connection}`;
  const [hook] = await ours(api, key, connection);
  if (hook?.active && hook.triggers.includes(event)) return id;
  const wanted = [...new Set([...(hook?.triggers ?? []), event])];
  const body = {
    active: true,
    subscriberUrl: hookUrl(connection),
    triggers: wanted,
    secret: secret(connection),
    // Cal.com asks how long after the start a missing host or guest counts as a no-show
    ...(wanted.some((t) => NO_SHOW.includes(t)) && { time: NO_SHOW_MINUTES, timeUnit: "MINUTE" }),
  };
  if (hook) await call(api, key, send("PATCH", "/v2/webhooks/{webhookId}", FIELDS), { webhookId: hook.id, ...body });
  else await call(api, key, send("POST", "/v2/webhooks", FIELDS), body);
  return id;
}

export async function unwatch(api: Api, key: string, id: string) {
  const [, connection = ""] = id.split(":");
  for (const h of await ours(api, key, connection)) await call(api, key, send("DELETE", "/v2/webhooks/{webhookId}"), { webhookId: h.id });
}

const signed = (body: string, header: unknown, connection: string) => {
  const got = Buffer.from(typeof header === "string" ? header : "");
  const want = Buffer.from(createHmac("sha256", secret(connection)).update(body).digest("hex"));
  return got.length === want.length && timingSafeEqual(got, want);
};

export async function receive(delivery: Delivery) {
  if (!signed(delivery.body, delivery.headers["x-cal-signature-256"], delivery.connection)) return null;
  const { triggerEvent = "", createdAt = "", payload, ...rest } = JSON.parse(delivery.body || "{}") as { triggerEvent?: string; createdAt?: string; payload?: Record<string, any>; [k: string]: unknown };
  // MEETING_STARTED and MEETING_ENDED come flat: the booking is the body itself
  const data: EventData = { event: triggerEvent, created_at: createdAt, payload: payload ?? rest };
  const names = Object.entries(T).filter(([, [e]]) => e === triggerEvent).map(([t]) => t);
  const p = data.payload;
  // `seen` is shared across apps, so the connection is in the id
  const id = [delivery.connection, triggerEvent, p.uid ?? p.bookingId ?? p.formId ?? p.oooEntry?.id ?? p.id ?? "", createdAt].join(":");
  return { events: async () => (names.length ? [{ id, triggers: names, data }] : []) };
}
