// Fellow telling us the moment AI notes are ready or shared, and when action items are assigned or done. One webhook
// per connection (user scope: what the key's owner can see), at /webhooks/app/fellow/<connection>/<token>, holding every
// event an automation wants. Fellow makes the webhook's signing secret itself and shows it only once, so instead the
// <token> in the address is an HMAC of ENCRYPTION_KEY and the connection (worked out, never stored): nobody without it
// can post there. Fellow checks the address first with a url_verification challenge, answered with the challenge.
import { createHmac, timingSafeEqual } from "node:crypto";
import type { ActionDetail } from "@emplio/shared";
import { AppsError } from "../../types";
import type { Delivery, WebhookEvent } from "../index";
import { type Api, call, type Send } from "../openapi";

const MEETING: ActionDetail["input"] = [
  { name: "id", type: "string", required: true, description: "The note's id; get_note and the note's agenda actions take it" },
  { name: "event_title", type: "string", required: false, description: "The meeting's title (empty when unknown)" },
  { name: "event_start", type: "string", required: false, description: "When the meeting was booked to start (ISO 8601)" },
  { name: "event_end", type: "string", required: false, description: "When it was booked to end" },
  { name: "recording_start", type: "string", required: false, description: "When the recording started" },
  { name: "recording_end", type: "string", required: false, description: "When the recording ended" },
  { name: "recap_url", type: "string", required: false, description: "The meeting's recap page in Fellow" },
  { name: "organizer_email", type: "string", required: false, description: "Who organised the meeting (empty when unknown)" },
  { name: "attendees", type: "object[]", required: false, description: "Who was invited: name, email" },
  { name: "has_external_attendees", type: "boolean", required: false, description: "Whether anyone from outside the company was invited" },
  { name: "ai_notes", type: "string", required: false, description: "Fellow's AI notes, in Markdown: summary, decisions, next steps" },
  { name: "agenda_notes", type: "string", required: false, description: "The note's agenda and notes written by people, in Markdown" },
  { name: "event_id", type: "string", required: false, description: "The calendar event's id (empty when the note has none)" },
  { name: "transcript", type: "string", required: false, description: "The whole transcript, last so a long one is what gets cut" },
];
const ITEM: ActionDetail["input"] = [
  { name: "id", type: "string", required: true, description: "The action item's id; get_action_item, mark_action_item_complete and archive_action_item take it" },
  { name: "text", type: "string", required: true, description: "What has to be done" },
  { name: "note_id", type: "string", required: false, description: "The note it came from, if any" },
  { name: "due_date", type: "string", required: false, description: "Due date, YYYY-MM-DD, if set" },
  { name: "ai_generated", type: "boolean", required: false, description: "Whether Fellow's AI picked it out of the meeting" },
];

export const triggers: Record<string, { description: string; config: ActionDetail["input"]; output: ActionDetail["input"] }> = {
  ai_notes_ready: {
    description: "Fellow finished the AI notes for a recorded meeting the connected person can see. The event has the notes, attendees and transcript.",
    config: [],
    output: MEETING,
  },
  ai_notes_shared_to_channel: {
    description: "AI notes of a meeting were shared to a Fellow channel the connected person is in. The event has the notes, attendees and transcript.",
    config: [{ name: "channel_id", type: "string", required: false, description: "Only shares to this channel (its id, as in a note's channel or the webhook event)" }],
    output: [...MEETING, { name: "channel_id", type: "string", required: true, description: "The channel it was shared to" }],
  },
  action_item_assigned: {
    description: "An action item was assigned to the connected person in Fellow (also when it's made with them on it).",
    config: [],
    output: [
      ...ITEM,
      { name: "assignees", type: "object[]", required: true, description: "Everyone on it: id, full_name, email" },
      { name: "status", type: "string", required: false, description: "Incomplete, Done or Archived" },
      { name: "completion_type", type: "string", required: false, description: "any: one assignee finishing is enough; all: everyone must" },
    ],
  },
  action_item_completed: {
    description: "An action item assigned to the connected person was marked done in Fellow. A run that marks items done starts this again, so say in the prompt when to stop.",
    config: [],
    output: [
      ...ITEM,
      { name: "assignee_name", type: "string", required: false, description: "The assignee it's about" },
      { name: "assignee_email", type: "string", required: false, description: "Their email" },
      { name: "stream_title", type: "string", required: false, description: "The channel or meeting series the note belongs to" },
      { name: "event_title", type: "string", required: false, description: "The meeting it came from" },
    ],
  },
};
// trigger → Fellow's event type
export const events: Record<string, string> = {
  ai_notes_ready: "ai_note.generated",
  ai_notes_shared_to_channel: "ai_note.shared_to_channel",
  action_item_assigned: "action_item.assigned",
  action_item_completed: "action_item.completed",
};

export function hookToken(connection: string) {
  const key = process.env.ENCRYPTION_KEY;
  if (!key) throw new Error("ENCRYPTION_KEY isn't set");
  return createHmac("sha256", key).update(`fellow-webhook:${connection}`).digest("hex").slice(0, 32);
}
const hookUrl = (connection: string) => `${process.env.WEBHOOK_URL}/webhooks/app/fellow/${connection}/${hookToken(connection)}`;
const send = (method: string, path: string, fields: string[] = [], query: string[] = []): Send => ({
  method,
  path,
  query,
  headers: [],
  ...(fields.length && { body: { kind: "fields" as const, fields: fields.map((f): [string, string] => [f, f]) } }),
});

type Hook = { id: string; url: string; status: string; enabled_events: string[] };
async function ours(api: Api, key: string, connection: string) {
  const url = hookUrl(connection);
  let cursor: string | undefined;
  // ponytail: at most 10 pages of 50; nobody has 500 webhooks of their own
  for (let i = 0; i < 10; i++) {
    const page = (await call(api, key, send("GET", "/api/v1/webhooks", [], ["page_size", "cursor"]), { page_size: 50, cursor })) as { webhooks?: { page_info?: { cursor?: string | null }; data?: Hook[] } };
    const found = page.webhooks?.data?.find((h) => h.url === url);
    if (found) return found;
    cursor = page.webhooks?.page_info?.cursor ?? undefined;
    if (!cursor) return undefined;
  }
}

// Make sure this connection's webhook sends this event too: add it to ours, or make ours.
export async function watch(api: Api, key: string, connection: string, event: string) {
  if (!process.env.WEBHOOK_URL) throw new AppsError("this server can't receive Fellow's events (WEBHOOK_URL isn't set)");
  const id = `fellow:${connection}`;
  const found = await ours(api, key, connection);
  if (found?.status === "active" && found.enabled_events.includes(event)) return id;
  if (found)
    await call(api, key, send("PATCH", "/api/v1/webhook/{webhook_id}", ["enabled_events", "status"]), {
      webhook_id: found.id,
      enabled_events: [...new Set([...found.enabled_events, event])],
      status: "active",
    });
  else
    await call(api, key, send("POST", "/api/v1/webhook", ["url", "enabled_events", "description"]), {
      url: hookUrl(connection),
      enabled_events: [event],
      description: "Emplio automations",
    });
  return id;
}

export async function unwatch(api: Api, key: string, id: string) {
  const connection = id.split(":")[1] ?? "";
  const found = await ours(api, key, connection);
  if (found) await call(api, key, send("DELETE", "/api/v1/webhook/{webhook_id}"), { webhook_id: found.id });
}

const same = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

export const wanted = (config: unknown, data: unknown) => {
  const channel = (config as { channel_id?: string } | null)?.channel_id;
  return !channel || (data as { channel_id?: string }).channel_id === channel;
};

export async function receive(delivery: Delivery) {
  if (!same(delivery.rest.split("/")[0] ?? "", hookToken(delivery.connection))) return null;
  const body = JSON.parse(delivery.body || "{}") as Record<string, unknown> & { type?: string; challenge?: string; event_type?: string; id?: string };
  // Fellow checking the address before it saves the webhook: the challenge back, as plain text
  if (body.type === "url_verification") return { headers: { "content-type": "text/plain" }, reply: String(body.challenge ?? ""), events: async () => [] };
  const svix = delivery.headers["svix-id"];
  return {
    events: async (): Promise<WebhookEvent[]> => {
      const names = Object.entries(events).filter(([, e]) => e === body.event_type).map(([t]) => t);
      if (!names.length) return [];
      // the transcript last, so a long one is what the 20,000-character cut takes
      const { event_type: _, transcript, ...rest } = body;
      return [{ id: `fellow:${delivery.connection}:${typeof svix === "string" ? svix : `${body.event_type}:${body.id}`}`, triggers: names, data: { ...rest, ...(transcript !== undefined && { transcript }) } }];
    },
  };
}
