// Grain telling us about recordings, clips, stories and uploads the moment they happen. A Grain hook carries one event
// type, so each event an automation wants gets its own, at /webhooks/app/grain/<connection>/<hook_type>/<token>.
// Grain doesn't sign its deliveries, so the unguessable token in the address (an HMAC of ENCRYPTION_KEY, the connection
// and the event, never stored) proves the sender. Composio has no Grain triggers; ours are Grain's hook types.
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { ActionDetail } from "@emplio/shared";
import { AppsError } from "../../types";
import type { Delivery } from "../index";
import { type Api, call, type Send } from "../openapi";

type Field = ActionDetail["input"][number];
type Kind = "recording" | "highlight" | "story" | "upload";
const AGAIN = " A run that changes the same one starts this again, so say in the prompt when to stop.";
// hook type → what it means
const T: Record<string, string> = {
  recording_added: "Grain has a new recording: a meeting it recorded, or an upload that became one. The AI summary may not be ready yet; recording_updated follows as it changes.",
  recording_updated: `A Grain recording changed: its title, tags, sharing, or Grain finishing its notes.${AGAIN}`,
  recording_deleted: "A Grain recording was deleted. Only its id comes with it.",
  highlight_added: "Someone made a clip (highlight) from a Grain recording.",
  highlight_updated: `A Grain clip (highlight) changed: its title, range or tags.${AGAIN}`,
  highlight_deleted: "A Grain clip (highlight) was deleted. Only its id comes with it.",
  story_added: "Someone made a Grain story (a reel of clips).",
  story_updated: `A Grain story changed.${AGAIN}`,
  story_deleted: "A Grain story was deleted. Only its id comes with it.",
  upload_added: "An upload to Grain started (a file or transcript on its way to becoming a recording).",
  upload_updated: `A Grain upload moved on (processing, staged, success or failure) or its details changed.${AGAIN}`,
};
export const events: Record<string, string> = Object.fromEntries(Object.keys(T).map((t) => [t, t]));
const kind = (hookType: string) => hookType.split("_")[0] as Kind;

// extra details each hook asks Grain to send, so a run needn't look them up
const INCLUDE: Record<Kind, Record<string, boolean>> = {
  recording: { participants: true, ai_summary: true, ai_action_items: true },
  highlight: { transcript: true, speakers: true },
  story: {},
  upload: { attributes: true },
};

const FILTERS: Record<Kind, Field[]> = {
  recording: [
    { name: "title_contains", type: "string", required: false, description: "Only recordings whose title contains this (any case)" },
    { name: "participant_email", type: "string", required: false, description: "Only meetings this person was in (their email)" },
    { name: "team_id", type: "string", required: false, description: "Only this team's recordings (list_teams)" },
    { name: "meeting_type_id", type: "string", required: false, description: "Only this meeting type (list_meeting_types), like Sales" },
  ],
  highlight: [{ name: "recording_id", type: "string", required: false, description: "Only clips from this recording" }],
  story: [],
  upload: [{ name: "status", type: "string", required: false, description: "Only when the upload reaches this status: staged, success or failure" }],
};
const ABOUT: Record<Kind, string> = {
  recording: "The recording: id, title, url, start_datetime, end_datetime, duration_ms, source, tags, teams, recorders, meeting_type, participants (name, email, internal or external, attended), ai_summary.text, ai_action_items",
  highlight: "The clip: id, recording_id, text (its title), transcript, speakers, timestamp and duration in ms, url",
  story: "The story: id, title, description, url, public_url, tags",
  upload: "The upload: id, title, media_type, status, recording_id (once it's a recording), failure.reason, attributes",
};
export const triggers: Record<string, { description: string; config: ActionDetail["input"]; output: ActionDetail["input"] }> = Object.fromEntries(
  Object.entries(T).map(([name, description]) => {
    const k = kind(name);
    const gone = name.endsWith("_deleted");
    return [
      name,
      {
        description,
        config: gone ? [] : FILTERS[k],
        output: [
          { name: "event", type: "string", required: true, description: "Grain's hook type, like recording_added" },
          { name: "user_id", type: "string", required: false, description: "The Grain user it happened for" },
          { name: k, type: "object", required: true, description: gone ? "Just its id" : ABOUT[k] },
        ],
      },
    ];
  }),
);

type Data = { event: string; user_id?: string } & Record<string, any>;
export function wanted(config: unknown, data: unknown) {
  const c = (config ?? {}) as Record<string, string | undefined>;
  const d = data as Data;
  const r = d.recording ?? {};
  const has = (v: unknown) => v !== undefined && v !== "";
  if (has(c.title_contains) && !String(r.title ?? "").toLowerCase().includes(c.title_contains!.toLowerCase())) return false;
  if (has(c.participant_email) && !(r.participants ?? []).some((p: { email?: string }) => p.email?.toLowerCase() === c.participant_email!.toLowerCase())) return false;
  if (has(c.team_id) && !(r.teams ?? []).some((t: { id?: string }) => t.id === c.team_id)) return false;
  if (has(c.meeting_type_id) && r.meeting_type?.id !== c.meeting_type_id) return false;
  if (has(c.recording_id) && d.highlight?.recording_id !== c.recording_id) return false;
  if (has(c.status) && d.upload?.status !== c.status) return false;
  return true;
}

const hookToken = (connection: string, hookType: string) => createHmac("sha256", process.env.ENCRYPTION_KEY!).update(`grain-webhook:${connection}:${hookType}`).digest("hex");
const hookUrl = (connection: string, hookType: string) => `${process.env.WEBHOOK_URL}/webhooks/app/grain/${connection}/${hookType}/${hookToken(connection, hookType)}`;

const send = (method: string, path: string, fields: string[] = []): Send => ({ method, path, query: [], headers: [], ...(fields.length && { body: { kind: "fields" as const, fields: fields.map((f): [string, string] => [f, f]) } }) });
type Hook = { id: string; hook_url: string; hook_type: string; enabled?: boolean };
const findHook = async (api: Api, key: string, hookType: string, url: string) =>
  ((await call(api, key, send("POST", "/hooks", ["filter"]), { filter: { hook_type: hookType } })) as { hooks?: Hook[] }).hooks?.find((h) => h.hook_url === url);

// Make sure there's our hook for this event type.
export async function watch(api: Api, key: string, connection: string, hookType: string) {
  if (!process.env.WEBHOOK_URL) throw new AppsError("this server can't receive Grain's events (WEBHOOK_URL isn't set)");
  if (!T[hookType]) throw new AppsError(`Grain has no event ${hookType}`);
  const id = `grain:${connection}:${hookType}`;
  const url = hookUrl(connection, hookType);
  const found = await findHook(api, key, hookType, url);
  if (found && found.enabled !== false) return id;
  // a hook Grain switched off starts clean as a new one
  if (found) await call(api, key, send("DELETE", "/hooks/{id}"), { id: found.id });
  const include = INCLUDE[kind(hookType)];
  await call(api, key, send("POST", "/hooks/create", ["hook_url", "hook_type", "include"]), { hook_url: url, hook_type: hookType, ...(!hookType.endsWith("_deleted") && Object.keys(include).length && { include }) });
  return id;
}

export async function unwatch(api: Api, key: string, id: string) {
  const [, connection = "", hookType = ""] = id.split(":");
  const found = await findHook(api, key, hookType, hookUrl(connection, hookType));
  if (found) await call(api, key, send("DELETE", "/hooks/{id}"), { id: found.id });
}

export async function receive(delivery: Delivery) {
  const [hookType = "", token = ""] = delivery.rest.split("/");
  const want = Buffer.from(hookToken(delivery.connection, hookType));
  const got = Buffer.from(token);
  if (got.length !== want.length || !timingSafeEqual(got, want)) return null;
  let body: { type?: string; user_id?: string; data?: unknown } = {};
  try {
    body = JSON.parse(delivery.body || "{}");
  } catch {}
  // Grain's reachability test when a hook is made, or anything that isn't this hook's event: answered, nothing starts
  if (body.type !== hookType || !T[hookType]) return { events: async () => [] };
  // Grain sends no delivery id: a retry is the same body, and `seen` is shared, so the connection and event are in it
  const id = `${delivery.connection}:${hookType}:${createHash("sha256").update(delivery.body).digest("hex")}`;
  const data: Data = { event: hookType, user_id: body.user_id, [kind(hookType)]: body.data ?? {} };
  return { events: async () => [{ id, triggers: [hookType], data }] };
}
