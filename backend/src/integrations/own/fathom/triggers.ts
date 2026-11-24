// Fathom telling us the moment a meeting's notes are ready. Fathom has one webhook event (new meeting content ready)
// and no way to list webhooks, only to make and delete them, so each connection gets one webhook that carries
// everything (summary, action items, CRM matches; recordings of every kind the account can see), and automations
// narrow it with their settings. Its id rides in the id automations are stored under (fathom:<connection>:<webhook>),
// so the last automation can delete it, and the next automation on the connection finds it there.
// Fathom makes each webhook's signing secret itself and shows it once. Rather than keep it, the address carries a
// token worked out from ENCRYPTION_KEY and the connection (/webhooks/app/fathom/<connection>/<token>), checked on
// every delivery.
// ponytail: the address token stands in for Fathom's signature; keeping the secret (encrypted) would let us check both
import { createHmac, timingSafeEqual } from "node:crypto";
import type { ActionDetail } from "@emplio/shared";
import { like } from "drizzle-orm";
import { db } from "../../../db";
import { automations } from "../../../db/schema";
import { AppsError } from "../../types";
import type { Delivery } from "../index";
import { type Api, call } from "../openapi";

type Field = ActionDetail["input"][number];
type Meeting = Record<string, any>;

const CONFIG: Field[] = [
  { name: "recorded_by", type: "string", required: false, description: "Only meetings recorded by this person (their email)" },
  { name: "team", type: "string", required: false, description: "Only meetings recorded by someone on this Fathom team (its name, like Sales)" },
  { name: "meeting_type", type: "string", required: false, description: "Only meetings of this Fathom meeting type (its name; list_meeting_types lists them)" },
  { name: "external_only", type: "boolean", required: false, description: "Only meetings with someone from outside the company on the invite (customer calls, not internal syncs)" },
  { name: "invitee", type: "string", required: false, description: "Only meetings with this guest on the invite: an email, or a company's domain like northwind.com" },
];
const OUTPUT: Field[] = [
  { name: "title", type: "string", required: true, description: "The meeting's name in Fathom (meeting_title: the calendar event's)" },
  { name: "recording_id", type: "number", required: true, description: "The recording's id, for get_recording_transcript, get_recording_summary and download_recording" },
  { name: "url", type: "string", required: true, description: "The recording in Fathom (share_url: the link to share)" },
  { name: "recorded_by", type: "object", required: true, description: "Who recorded it: name, email, team" },
  { name: "calendar_invitees", type: "array", required: true, description: "Everyone on the invite: name, email, is_external" },
  { name: "calendar_invitees_domains_type", type: "string", required: true, description: "only_internal, or one_or_more_external for a call with outside guests" },
  { name: "default_summary", type: "object", required: false, description: "The AI summary: template_name, markdown_formatted" },
  { name: "action_items", type: "array", required: false, description: "Each: description, assignee (name, email), completed, recording_timestamp, recording_playback_url" },
  { name: "crm_matches", type: "object", required: false, description: "Matching contacts, companies and deals in the linked CRM, or error when none is linked" },
  { name: "scheduled_start_time", type: "string", required: false, description: "When it was planned to start and end (scheduled_end_time), and when recording started and ended (recording_start_time, recording_end_time)" },
];

export const triggers: Record<string, { description: string; config: Field[]; output: Field[] }> = {
  meeting_content_ready: {
    description:
      "A meeting recorded in Fathom has finished and its notes are ready: summary, action items and CRM matches come with it (the same moment Fathom sends its summary email). The transcript isn't included, to keep it short: get_recording_transcript with its recording_id fetches it. Only meetings after the automation is saved.",
    config: CONFIG,
    output: OUTPUT,
  },
};
// Fathom has only the one event; this is just its name for the shared code
export const events: Record<string, string> = { meeting_content_ready: "newMeeting" };

export const wanted = (config: unknown, data: unknown) => {
  const c = (config ?? {}) as { recorded_by?: string; team?: string; meeting_type?: string; external_only?: boolean; invitee?: string };
  const m = (data ?? {}) as Meeting;
  const same = (a: unknown, b: unknown) => String(a ?? "").toLowerCase() === String(b ?? "").toLowerCase();
  if (c.recorded_by && !same(c.recorded_by, m.recorded_by?.email)) return false;
  if (c.team && !same(c.team, m.recorded_by?.team)) return false;
  if (c.meeting_type && !same(c.meeting_type, m.meeting_type)) return false;
  if (c.external_only && m.calendar_invitees_domains_type !== "one_or_more_external") return false;
  if (c.invitee) {
    const want = c.invitee.toLowerCase().replace(/^@/, "");
    const emails = ((m.calendar_invitees ?? []) as { email?: string }[]).map((i) => (i.email ?? "").toLowerCase());
    if (!emails.some((e) => e === want || e.endsWith(`@${want}`))) return false;
  }
  return true;
};

export function token(connection: string) {
  const key = process.env.ENCRYPTION_KEY;
  if (!key) throw new Error("ENCRYPTION_KEY isn't set");
  return createHmac("sha256", key).update(`fathom-webhook:${connection}`).digest("hex");
}
const hookUrl = (connection: string) => `${process.env.WEBHOOK_URL}/webhooks/app/fathom/${connection}/${token(connection)}`;

// The id an automation on this connection already holds, when its webhook is set up. Swappable for tests.
export const store = {
  async existing(connection: string): Promise<string | undefined> {
    const prefix = `fathom:${connection}:`;
    const rows = await db.select({ id: automations.externalId }).from(automations).where(like(automations.externalId, `${prefix}%`)).limit(20);
    // LIKE's _ matches any character; the prefix itself must match
    return rows.map((r) => r.id).find((id): id is string => !!id?.startsWith(prefix));
  },
};

const ALL = ["my_recordings", "shared_external_recordings", "my_shared_with_team_recordings", "shared_team_recordings"];
// the two that work without a Team Plan
const SOLO = ["my_recordings", "shared_external_recordings"];
const CREATE = { method: "POST", path: "/webhooks", query: [], headers: [], body: { kind: "fields" as const, fields: ["destination_url", "triggered_for", "include_summary", "include_action_items", "include_crm_matches", "include_transcript"].map((f): [string, string] => [f, f]) } };

export async function watch(api: Api, key: string, connection: string) {
  if (!process.env.WEBHOOK_URL) throw new AppsError("this server can't receive Fathom's events (WEBHOOK_URL isn't set)");
  const found = await store.existing(connection);
  if (found) return found;
  const make = (triggered_for: string[]) =>
    call(api, key, CREATE, { destination_url: hookUrl(connection), triggered_for, include_summary: true, include_action_items: true, include_crm_matches: true, include_transcript: false }) as Promise<{ id: string }>;
  // the team kinds are for Team Plans only; without one, the person's own recordings and those shared with them
  const hook = await make(ALL).catch((e) => (e instanceof AppsError && !e.expired ? make(SOLO) : Promise.reject(e)));
  return `fathom:${connection}:${hook.id}`;
}

export async function unwatch(api: Api, key: string, id: string) {
  const [, , hook] = id.split(":");
  if (!hook) return;
  // already gone (deleted in Fathom's settings) is fine
  await call(api, key, { method: "DELETE", path: "/webhooks/{id}", query: [], headers: [] }, { id: hook }).catch((e) => {
    if (!(e instanceof AppsError && /\(404\)$/.test(e.message))) throw e;
  });
}

const ours = (rest: string, connection: string) => {
  const got = Buffer.from(rest.split("/")[0] ?? "");
  const want = Buffer.from(token(connection));
  return got.length === want.length && timingSafeEqual(got, want);
};

export async function receive(delivery: Delivery) {
  if (!ours(delivery.rest, delivery.connection)) return null;
  const meeting = JSON.parse(delivery.body || "{}") as Meeting;
  const header = delivery.headers["webhook-id"];
  // Fathom's message id stays the same on a retry; `seen` is shared across connections, so the connection is in it
  const id = `${delivery.connection}:${(typeof header === "string" && header) || meeting.recording_id}`;
  return {
    events: async () => {
      const watch = await store.existing(delivery.connection);
      return [{ id, triggers: ["meeting_content_ready"], data: meeting, ...(watch && { watch }) }];
    },
  };
}
