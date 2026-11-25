// Figma telling us about files the moment something happens (webhooks v2). A Figma webhook is for one event on one
// team, folder or file, so ours is one per connection, place and event, at
// /webhooks/app/figma/<connection>/<context>-<id>-<EVENT>. Figma proves itself with the passcode in the body, worked out
// from ENCRYPTION_KEY, the connection and that place, never stored.
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { ActionDetail } from "@emplio/shared";
import { AppsError } from "../../types";
import type { Delivery, WebhookEvent } from "../index";
import { type Api, call, type Send } from "../openapi";

type Field = ActionDetail["input"][number];
const PLACE: Field[] = [
  { name: "file", type: "string", required: false, description: "Watch one file: its link (figma.com/design/AbC123xyz/...) or key. Anyone who can edit the file can do this" },
  { name: "folder_id", type: "string", required: false, description: "Or watch every file in a folder (Figma used to call folders projects): its link (figma.com/files/project/123456789/...) or id. Needs edit rights on the folder" },
  { name: "team_id", type: "string", required: false, description: "Or watch every file in a team: its link (figma.com/files/team/1170245155647481265/...) or id. Needs a team admin; files in invite-only folders aren't reported" },
];
const ONLY_FILE: Field = { name: "file_key", type: "string", required: false, description: "When watching a folder or team: only this file (its link or key)" };
const STATUS: Field = { name: "status", type: "string", required: false, description: "Only this Dev Mode status: READY_FOR_DEV, COMPLETED or NONE" };
const BASE: Field[] = [
  { name: "event_type", type: "string", required: true, description: "Figma's name for it: FILE_UPDATE, FILE_DELETE, FILE_VERSION_UPDATE, FILE_COMMENT, LIBRARY_PUBLISH or DEV_MODE_STATUS_UPDATE" },
  { name: "file_key", type: "string", required: true, description: "The file's key (figma.com/design/<file_key>)" },
  { name: "file_name", type: "string", required: true, description: "The file's name" },
  { name: "timestamp", type: "string", required: true, description: "When it happened" },
  { name: "triggered_by", type: "object", required: false, description: "Who did it: id, handle, img_url (not on file_updated)" },
];

// trigger → the payload's event_type, and the webhook it needs (deletes come with FILE_UPDATE's webhook, saving one of a
// file's three webhook places)
const T: Record<string, { type: string; hook: string; about: string; config?: Field[]; output?: Field[] }> = {
  file_updated: { type: "FILE_UPDATE", hook: "FILE_UPDATE", about: "A Figma file was edited: Figma reports it after 30 minutes without edits. A run that changes the file starts this again, so say in the prompt when to stop." },
  file_deleted: { type: "FILE_DELETE", hook: "FILE_UPDATE", about: "A Figma file was deleted (not files inside a deleted folder)." },
  file_version_created: {
    type: "FILE_VERSION_UPDATE",
    hook: "FILE_VERSION_UPDATE",
    about: "A named version was saved in a Figma file's version history (often the sign that a design is ready).",
    output: [
      { name: "version_id", type: "string", required: true, description: "The version's id" },
      { name: "description", type: "string", required: false, description: "What the version's author wrote about it" },
      { name: "created_at", type: "string", required: true, description: "When the version was saved" },
    ],
  },
  new_comment: {
    type: "FILE_COMMENT",
    hook: "FILE_COMMENT",
    about: "Someone commented on a Figma file. A run that comments on the same file starts this again, so say in the prompt when not to reply.",
    output: [
      { name: "comment_id", type: "string", required: true, description: "The comment's id (reply with add_a_comment_to_a_file and this as comment_id)" },
      { name: "text", type: "string", required: true, description: "The comment, as plain text" },
      { name: "comment", type: "array", required: true, description: "The comment as Figma sends it: pieces of text and mentions (user ids)" },
      { name: "mentions", type: "array", required: false, description: "People mentioned: id, handle" },
      { name: "created_at", type: "string", required: true, description: "When it was written" },
    ],
  },
  library_published: {
    type: "LIBRARY_PUBLISH",
    hook: "LIBRARY_PUBLISH",
    about: "A Figma library was published. One event comes for each kind of asset that changed (components, styles, variables).",
    output: [
      { name: "description", type: "string", required: false, description: "What the publisher wrote about it" },
      { name: "created_components", type: "array", required: true, description: "Components added: key, name. Likewise created_styles, created_variables, modified_* and deleted_*" },
      { name: "library_item", type: "object", required: true, description: "The library: key, name" },
    ],
  },
  dev_mode_status_changed: {
    type: "DEV_MODE_STATUS_UPDATE",
    hook: "DEV_MODE_STATUS_UPDATE",
    about: "A layer in a Figma file was marked ready for development, completed, or had that taken off (Dev Mode).",
    config: [STATUS],
    output: [
      { name: "node_id", type: "string", required: true, description: 'The layer\'s id, like "43:2"' },
      { name: "status", type: "string", required: true, description: "READY_FOR_DEV, COMPLETED or NONE" },
      { name: "related_links", type: "array", required: false, description: "Links attached to the layer (dev resources)" },
    ],
  },
};

export const triggers: Record<string, { description: string; config: ActionDetail["input"]; output: ActionDetail["input"] }> = Object.fromEntries(
  Object.entries(T).map(([name, t]) => [name, { description: `${t.about} Watches one file, folder or team.`, config: [...PLACE, ONLY_FILE, ...(t.config ?? [])], output: [...BASE, ...(t.output ?? [])] }]),
);
export const events: Record<string, string> = Object.fromEntries(Object.entries(T).map(([name, t]) => [name, t.hook]));

// a link or a bare key/id → the key/id
const fileKey = (s: string) => /figma\.com\/(?:file|design|board|proto|slides|deck|make|site)\/([A-Za-z0-9]+)/.exec(s)?.[1] ?? s.trim();
const numberAfter = (word: string, s: string) => new RegExp(`/${word}/(\\d+)`).exec(s)?.[1] ?? s.trim();

export const wanted = (config: unknown, data: unknown) => {
  const want = (config ?? {}) as { file_key?: string; status?: string };
  const d = data as { file_key?: string; status?: string };
  return (!want.file_key || fileKey(want.file_key) === d.file_key) && (!want.status || want.status.toUpperCase() === d.status);
};

// where the automation watches: Figma's context ("project" is a folder) and its id
function place(config: unknown): [context: string, id: string] {
  const c = (config ?? {}) as { file?: string; folder_id?: string; team_id?: string };
  const given = [c.file && ["file", fileKey(c.file)], c.folder_id && ["project", numberAfter("project", c.folder_id)], c.team_id && ["team", numberAfter("team", c.team_id)]].filter(Boolean) as [string, string][];
  if (given.length !== 1) throw new AppsError("give exactly one of file, folder_id or team_id: the Figma file, folder or team to watch");
  const [context, id] = given[0]!;
  if (!/^[A-Za-z0-9]+$/.test(id)) throw new AppsError(`${context === "project" ? "folder_id" : context === "team" ? "team_id" : "file"}: give the Figma link or its id`);
  return [context, id];
}

const passcode = (connection: string, spot: string) => createHmac("sha256", process.env.ENCRYPTION_KEY!).update(`figma-webhook:${connection}:${spot}`).digest("hex");
const hookUrl = (connection: string, spot: string) => `${process.env.WEBHOOK_URL}/webhooks/app/figma/${connection}/${spot}`;

type Hook = { id: string; endpoint: string; status: string };
const send = (method: string, path: string, query: string[] = [], fields: string[] = []): Send => ({
  method,
  path,
  query,
  headers: [],
  ...(fields.length && { body: { kind: "fields" as const, fields: fields.map((f): [string, string] => [f, f]) } }),
});
const ours = async (api: Api, key: string, context: string, contextId: string, url: string) =>
  (((await call(api, key, send("GET", "/v2/webhooks", ["context", "context_id"]), { context, context_id: contextId })) as { webhooks?: Hook[] }).webhooks ?? []).filter((h) => h.endpoint === url);

// Make sure this file, folder or team has our webhook for this event. Figma pings the address as it's made.
export async function watch(api: Api, key: string, connection: string, event: string, config: unknown) {
  if (!process.env.WEBHOOK_URL) throw new AppsError("this server can't receive Figma's events (WEBHOOK_URL isn't set)");
  const [context, contextId] = place(config);
  const spot = `${context}-${contextId}-${event}`;
  const url = hookUrl(connection, spot);
  const [found] = await ours(api, key, context, contextId, url);
  if (found?.status === "PAUSED") await call(api, key, send("PUT", "/v2/webhooks/{webhook_id}", [], ["status"]), { webhook_id: found.id, status: "ACTIVE" });
  if (!found)
    await call(api, key, send("POST", "/v2/webhooks", [], ["event_type", "context", "context_id", "endpoint", "passcode", "description"]), {
      event_type: event,
      context,
      context_id: contextId,
      endpoint: url,
      passcode: passcode(connection, spot),
      description: "Emplio automations",
    });
  return `figma:${connection}:${spot}`;
}

export async function unwatch(api: Api, key: string, id: string) {
  const [, connection = "", spot = ""] = id.split(":");
  const [context = "", contextId = ""] = spot.split("-");
  for (const h of await ours(api, key, context, contextId, hookUrl(connection, spot))) await call(api, key, send("DELETE", "/v2/webhooks/{webhook_id}"), { webhook_id: h.id });
}

const BY_TYPE = (type: string) => Object.entries(T).filter(([, t]) => t.type === type).map(([n]) => n);

export async function receive(delivery: Delivery) {
  const spot = delivery.rest.split("/")[0] ?? "";
  const body = JSON.parse(delivery.body || "{}") as { passcode?: string; event_type?: string; comment?: { text?: string; mention?: string }[]; [k: string]: unknown };
  const got = Buffer.from(String(body.passcode ?? ""));
  const want = Buffer.from(passcode(delivery.connection, spot));
  if (!spot || got.length !== want.length || !timingSafeEqual(got, want)) return null;
  return {
    events: async (): Promise<WebhookEvent[]> => {
      const names = BY_TYPE(String(body.event_type ?? ""));
      if (!names.length) return []; // PING, when the webhook is made
      const { passcode: _, ...data } = body;
      if (Array.isArray(body.comment)) Object.assign(data, { text: body.comment.map((f) => f.text ?? (f.mention ? `@${f.mention}` : "")).join("") });
      // Figma sends no delivery id; a retry is the same body, and `seen` is shared, so the connection goes in
      return [{ id: `figma:${delivery.connection}:${createHash("sha256").update(delivery.body).digest("hex")}`, triggers: names, data }];
    },
  };
}
