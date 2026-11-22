// Toggl Track telling us about changes the moment they happen, through its Webhooks API. Subscriptions are per
// workspace: one per workspace and connection, at /webhooks/app/toggl/<connection>/<workspace>, carrying the events its
// automations need. Toggl signs each delivery with a secret we set: an HMAC of ENCRYPTION_KEY and the connection,
// worked out again on arrival, never stored. Composio has no Toggl triggers, so names are Toggl's <entity>_<action>.
import { createHmac, timingSafeEqual } from "node:crypto";
import type { ActionDetail } from "@emplio/shared";
import { AppsError } from "../../types";
import type { Delivery, WebhookEvent } from "../index";
import { type Api, call, type Send } from "../openapi";

// GET /webhooks/api/v1/event_filters, as of 2026-11
const FILTERS: Record<string, string[]> = {
  client: ["created", "updated", "deleted"],
  project: ["created", "updated", "deleted"],
  project_group: ["created", "updated", "deleted"],
  project_user: ["created", "updated", "deleted"],
  tag: ["created", "updated", "deleted"],
  task: ["created", "updated", "deleted"],
  time_entry: ["created", "updated", "deleted"],
  timesheet: ["created", "updated", "deleted"],
  workspace: ["updated"],
  workspace_user: ["created", "updated", "deleted"],
};
const SPOKEN: Record<string, string> = {
  client: "A client",
  project: "A project",
  project_group: "A group's access to a project",
  project_user: "A person's membership of a project",
  tag: "A tag",
  task: "A task",
  time_entry: "A time entry",
  timesheet: "A timesheet",
  workspace: "The workspace's settings",
  workspace_user: "A member of the workspace",
};
// our trigger name → "<entity>:<action>"
export const events: Record<string, string> = Object.fromEntries(Object.entries(FILTERS).flatMap(([entity, actions]) => actions.map((a) => [`${entity}_${a}`, `${entity}:${a}`])));

const WORKSPACE = { name: "workspace_id", type: "number", required: true, description: "The Toggl Track workspace to watch: its number (get_user_workspaces lists them)" };
const PROJECT = { name: "project_id", type: "number", required: false, description: "Only this project (its id, from get_projects)" };
const USER = { name: "user_id", type: "number", required: false, description: "Only this person's (their Toggl user id, from get_workspace_users)" };
const filters = (entity: string) => [
  ...(["time_entry", "task", "project", "project_user", "project_group"].includes(entity) ? [PROJECT] : []),
  ...(["time_entry", "project_user", "workspace_user", "timesheet"].includes(entity) ? [USER] : []),
];
const OUTPUT: ActionDetail["input"] = [
  { name: "entity", type: "string", required: true, description: "What changed: time_entry, project, client, task, tag, project_user, project_group, timesheet, workspace or workspace_user" },
  { name: "action", type: "string", required: true, description: "created, updated or deleted" },
  { name: "payload", type: "object", required: true, description: "The item as it is now (for a time entry: description, start, stop, duration in seconds, negative while running, project_id, tags, billable, user_id)" },
  { name: "metadata", type: "object", required: false, description: "Where it happened: workspace_id, project_id, and event_user_id, who made the change" },
  { name: "created_at", type: "string", required: true, description: "When it happened" },
];
const echoes = (entity: string, action: string) => (action === "updated" && entity !== "workspace" ? " A run that edits the same item starts this again, so say in the prompt when to stop." : "");
export const triggers: Record<string, { description: string; config: ActionDetail["input"]; output: ActionDetail["input"] }> = Object.fromEntries(
  Object.entries(events).map(([name, event]) => {
    const [entity = "", action = ""] = event.split(":");
    const extra = name === "time_entry_created" ? " Starting a timer counts." : name === "time_entry_updated" ? " Stopping a timer counts." : "";
    return [name, { description: `${SPOKEN[entity]} was ${action} in Toggl Track.${extra}${echoes(entity, action)}`, config: [WORKSPACE, ...filters(entity)], output: OUTPUT }];
  }),
);

type Payload = { event_id: number; created_at: string; metadata?: Record<string, unknown>; payload: unknown; validation_code?: string };
type Data = { entity: string; action: string; payload: Record<string, unknown> | null; metadata?: Record<string, unknown>; created_at: string };

export const wanted = (config: unknown, data: unknown) => {
  const want = (config ?? {}) as { project_id?: unknown; user_id?: unknown };
  const d = data as Data;
  const project = d.payload?.project_id ?? d.metadata?.project_id;
  const user = d.payload?.user_id ?? d.payload?.uid;
  return (!want.project_id || String(project) === String(want.project_id)) && (!want.user_id || String(user) === String(want.user_id));
};

const secretFor = (connection: string, workspace: string) => createHmac("sha256", process.env.ENCRYPTION_KEY!).update(`toggl-webhook:${connection}:${workspace}`).digest("hex");
const hookUrl = (connection: string, workspace: string) => `${process.env.WEBHOOK_URL}/webhooks/app/toggl/${connection}/${workspace}`;

const HOOKS = "https://api.track.toggl.com/webhooks/api/v1";
const send = (method: string, path: string, fields: string[] = []): Send => ({ method, base: HOOKS, path, query: [], headers: [], ...(fields.length && { body: { kind: "fields", fields: fields.map((f): [string, string] => [f, f]) } }) });
type Filter = { entity: string; action: string };
type Hook = { subscription_id: number; url_callback: string; event_filters: Filter[]; enabled: boolean; validated_at?: string | null };
const findHook = async (api: Api, key: string, workspace: string, url: string) =>
  (((await call(api, key, send("GET", "/subscriptions/{workspace}"), { workspace })) as Hook[] | null) ?? []).find((h) => h.url_callback === url);
const covers = (have: Filter[], f: Filter) => have.some((h) => (h.entity === "*" || h.entity === f.entity) && (h.action === "*" || h.action === f.action));
const FIELDS = ["url_callback", "event_filters", "enabled", "description", "secret"];

// Make sure this workspace's subscription exists, is on, is validated and carries `event`.
export async function watch(api: Api, key: string, connection: string, event: string, config: unknown) {
  if (!process.env.WEBHOOK_URL) throw new AppsError("this server can't receive Toggl Track's events (WEBHOOK_URL isn't set)");
  const workspace = String((config as { workspace_id?: unknown } | null)?.workspace_id ?? "");
  if (!/^\d+$/.test(workspace)) throw new AppsError("workspace_id: give the Toggl Track workspace's number (get_user_workspaces lists them)");
  const [entity = "", action = ""] = event.split(":");
  const url = hookUrl(connection, workspace);
  const id = `toggl:${connection}:${workspace}`;
  const found = await findHook(api, key, workspace, url);
  if (found?.enabled && found.validated_at && covers(found.event_filters, { entity, action })) return id;
  const body = {
    workspace,
    url_callback: url,
    event_filters: covers(found?.event_filters ?? [], { entity, action }) ? found!.event_filters : [...(found?.event_filters ?? []), { entity, action }],
    enabled: true,
    // unique per workspace, as Toggl asks
    description: `Emplio ${connection}`,
    secret: secretFor(connection, workspace),
  };
  // Toggl's plan limits (1 subscription and 3 events on Free) come back as its own error message
  const hook = found
    ? ((await call(api, key, send("PUT", "/subscriptions/{workspace}/{subscription_id}", FIELDS), { ...body, subscription_id: found.subscription_id })) as Hook)
    : ((await call(api, key, send("POST", "/subscriptions/{workspace}", FIELDS), body)) as Hook);
  // a new subscription only gets events once validated: the ping carries a code, and receive() answers it
  if (!hook.validated_at) await call(api, key, send("POST", "/ping/{workspace}/{subscription_id}"), { workspace, subscription_id: hook.subscription_id });
  return id;
}

export async function unwatch(api: Api, key: string, id: string) {
  const [, connection = "", workspace = ""] = id.split(":");
  const found = await findHook(api, key, workspace, hookUrl(connection, workspace));
  if (found) await call(api, key, send("DELETE", "/subscriptions/{workspace}/{subscription_id}"), { workspace, subscription_id: found.subscription_id });
}

export async function receive(delivery: Delivery) {
  const workspace = delivery.rest.split("/")[0] ?? "";
  const header = delivery.headers["x-webhook-signature-256"];
  const got = Buffer.from(String(Array.isArray(header) ? header[0] : (header ?? "")));
  const want = Buffer.from(`sha256=${createHmac("sha256", secretFor(delivery.connection, workspace)).update(delivery.body).digest("hex")}`);
  if (!workspace || got.length !== want.length || !timingSafeEqual(got, want)) return null;
  const e = JSON.parse(delivery.body) as Payload;
  // Toggl's test event; on a subscription not yet validated, answering its code validates it
  if (e.payload === "ping") return { reply: e.validation_code ? { validation_code: e.validation_code } : { ok: true }, events: async () => [] };
  const entity = String(e.metadata?.model ?? "");
  const action = String(e.metadata?.action ?? "");
  const name = `${entity}_${action}`;
  const data: Data = { entity, action, payload: e.payload as Data["payload"], metadata: e.metadata, created_at: e.created_at };
  // `seen` is shared across apps and connections, so the connection is in the id
  const out: WebhookEvent = { id: `${delivery.connection}:${e.event_id}`, triggers: events[name] ? [name] : [], data };
  return { events: async () => [out] };
}
