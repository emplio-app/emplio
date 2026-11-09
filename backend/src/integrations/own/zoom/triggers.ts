// Zoom telling us about events the moment they happen. Event subscriptions are set once on our Zoom app, not per
// connection, so every event arrives at one address, /webhooks/app/zoom/events, and says which account it's for: an
// automation is stored under zoom:<the connected user's id>. Trigger names are Composio's where it has one, else the event's name with dots
// as underscores. Zoom's list of events is events.json, generated with the actions.
import type { ActionDetail } from "@emplio/shared";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { AppsError } from "../../types";
import type { Delivery, WebhookEvent } from "../index";
import { type Api, call } from "../openapi";
import list from "./events.json";

type Trigger = { description: string; config: ActionDetail["input"]; output: ActionDetail["input"] };

const NAMED: Record<string, { events: string[]; description: string }> = {
  new_meeting_created_trigger: { events: ["meeting.created"], description: "A new meeting is scheduled on Zoom." },
  meeting_details_changed_trigger: { events: ["meeting.updated"], description: "A Zoom meeting's time, topic or settings change." },
  new_meeting_participant_trigger: { events: ["meeting.participant_joined"], description: "Someone joins a Zoom meeting." },
  new_cloud_recording_trigger: { events: ["recording.completed"], description: "A Zoom meeting's cloud recording is ready to watch or download." },
  meeting_recording_changed_trigger: { events: ["recording.renamed", "recording.trashed", "recording.deleted", "recording.recovered", "recording.transcript_completed"], description: "A Zoom recording is renamed, deleted or brought back, or its transcript is ready." },
  meeting_summary_updated_trigger: { events: ["meeting.summary_completed", "meeting.summary_updated"], description: "A Zoom meeting's AI summary is ready, or someone edits it." },
  new_webinar_created_trigger: { events: ["webinar.created"], description: "A new webinar is scheduled on Zoom." },
  webinar_details_changed_trigger: { events: ["webinar.updated"], description: "A Zoom webinar's time, topic or settings change." },
  new_webinar_participant_trigger: { events: ["webinar.participant_joined"], description: "Someone joins a Zoom webinar." },
  user_information_changed_trigger: { events: ["user.updated"], description: "A Zoom user's profile changes." },
};

const OUTPUT: ActionDetail["input"] = [
  { name: "event", type: "string", required: true, description: "What happened, like meeting.created" },
  { name: "event_ts", type: "number", required: true, description: "When it happened, in milliseconds since 1970" },
  { name: "payload", type: "object", required: true, description: "account_id, and in object the meeting, recording, webinar or user it's about" },
];
const FILTERS: ActionDetail["input"] = [
  { name: "meeting_id", type: "string", required: false, description: "Only this meeting or webinar (its number or uuid)" },
  { name: "host", type: "string", required: false, description: "Only meetings hosted by this person (their Zoom user id or email)" },
];
const hasFilters = (event: string) => /^(meeting|webinar|recording)\./.test(event);
const trigger = (event: string, description: string): Trigger => ({ description, config: hasFilters(event) ? FILTERS : [], output: OUTPUT });

// an event a Composio name stands for alone needs no second name
const solo = new Set(Object.values(NAMED).flatMap((n) => (n.events.length === 1 ? n.events : [])));
const own = list.events.filter((e) => !solo.has(e.event));
const short = (event: string) => event.replace(/\./g, "_");

export const events: Record<string, string> = {
  ...Object.fromEntries(Object.entries(NAMED).map(([name, n]) => [name, n.events[0]!])),
  ...Object.fromEntries(own.map((e) => [short(e.event), e.event])),
};
export const triggers: Record<string, Trigger> = {
  ...Object.fromEntries(Object.entries(NAMED).map(([name, n]) => [name, trigger(n.events[0]!, n.description)])),
  ...Object.fromEntries(own.map((e) => [short(e.event), trigger(e.event, e.description)])),
};

const startedBy = new Map<string, string[]>();
const add = (event: string, name: string) => startedBy.set(event, [...(startedBy.get(event) ?? []), name]);
for (const [name, n] of Object.entries(NAMED)) for (const e of n.events) add(e, name);
for (const e of own) add(e.event, short(e.event));

type Payload = { account_id?: string; object?: Record<string, unknown> };
export const wanted = (config: unknown, data: unknown) => {
  const want = (config ?? {}) as { meeting_id?: string | number; host?: string };
  const o = (data as { payload?: Payload }).payload?.object ?? {};
  const meeting = [o.id, o.uuid, o.meeting_id, o.meeting_uuid].filter((v) => v != null).map(String);
  const hosts = [o.host_id, o.host_email, o.meeting_host_id, o.meeting_host_email].filter(Boolean).map((v) => String(v).toLowerCase());
  return (!want.meeting_id || meeting.includes(String(want.meeting_id).replace(/\s/g, ""))) && (!want.host || hosts.includes(want.host.trim().toLowerCase()));
};

export async function watch(api: Api, key: string) {
  if (!process.env.ZOOM_WEBHOOK_SECRET) throw new AppsError("this server can't receive Zoom's events (ZOOM_WEBHOOK_SECRET isn't set)");
  const me = (await call(api, key, { method: "GET", path: "/users/me", query: [], headers: [] }, {})) as { id?: string };
  if (!me.id) throw new AppsError("Zoom didn't say who this sign-in belongs to");
  return `zoom:${me.id}`;
}

// Whose event it is. Not the Zoom account: two people at one company can connect their own Zoom to different businesses here,
// and neither should get the other's meetings. An event that names nobody starts nothing.
const ownerOf = (event: string, p: Payload & { operator_id?: unknown }) => {
  const o = p.object ?? {};
  const id = o.host_id ?? o.meeting_host_id ?? o.user_id ?? o.owner_id ?? (event.startsWith("user.") ? o.id : undefined) ?? p.operator_id;
  return id === undefined || id === null || id === "" ? null : String(id);
};

const MAX_AGE_S = 5 * 60;
const hmac = (message: string) => createHmac("sha256", process.env.ZOOM_WEBHOOK_SECRET!).update(message).digest("hex");

export function signatureOk(delivery: Delivery) {
  if (!process.env.ZOOM_WEBHOOK_SECRET) return false;
  const stamp = String(delivery.headers["x-zm-request-timestamp"] ?? "");
  if (!/^\d+$/.test(stamp) || Math.abs(Date.now() / 1000 - Number(stamp)) > MAX_AGE_S) return false;
  const want = Buffer.from(`v0=${hmac(`v0:${stamp}:${delivery.body}`)}`);
  const got = Buffer.from(String(delivery.headers["x-zm-signature"] ?? ""));
  return got.length === want.length && timingSafeEqual(got, want);
}

export async function receive(delivery: Delivery) {
  if (!signatureOk(delivery)) return null;
  // download_token opens the recording to anyone holding it; our sign-in downloads without it
  const body = JSON.parse(delivery.body, (k, v) => (k === "download_token" ? undefined : v)) as { event: string; event_ts: number; payload: Payload & { plainToken?: string } };
  if (body.event === "endpoint.url_validation") {
    const plainToken = String(body.payload.plainToken);
    return { reply: { plainToken, encryptedToken: hmac(plainToken) }, events: async () => [] };
  }
  const owner = body.payload ? ownerOf(body.event, body.payload) : null;
  const out: WebhookEvent = {
    // a retry is the same body under a new timestamp and request id
    id: createHash("sha256").update(delivery.body).digest("hex"),
    triggers: owner ? (startedBy.get(body.event) ?? []) : [],
    data: { event: body.event, event_ts: body.event_ts, payload: body.payload },
    watch: `zoom:${owner}`,
  };
  return { events: async () => [out] };
}
