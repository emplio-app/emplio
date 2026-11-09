// ClickUp telling us about events the moment they happen. Webhooks are per Workspace: one per Workspace and connection,
// at /webhooks/app/clickup/<connection>/<team>/<token>, carrying the events its automations need.
// Trigger names are the event's in snake_case, which is what Composio called them.
import { createHmac, timingSafeEqual } from "node:crypto";
import type { ActionDetail } from "@emplio/shared";
import { AppsError } from "../../types";
import type { Delivery, WebhookEvent } from "../index";
import { type Api, call, type Send } from "../openapi";

const ALL = [
  "taskCreated", "taskUpdated", "taskDeleted", "taskPriorityUpdated", "taskStatusUpdated", "taskAssigneeUpdated", "taskDueDateUpdated", "taskTagUpdated", "taskMoved",
  "taskCommentPosted", "taskCommentUpdated", "taskTimeEstimateUpdated", "taskTimeTrackedUpdated",
  "listCreated", "listUpdated", "listDeleted", "folderCreated", "folderUpdated", "folderDeleted", "spaceCreated", "spaceUpdated", "spaceDeleted",
  "goalCreated", "goalUpdated", "goalDeleted", "keyResultCreated", "keyResultUpdated", "keyResultDeleted",
];
const trigger = (event: string) => event.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
const spoken = (event: string) => trigger(event).replace(/_/g, " ");
export const events: Record<string, string> = Object.fromEntries(ALL.map((e) => [trigger(e), e]));

const TEAM = { name: "team_id", type: "string", required: true, description: "The ClickUp Workspace to watch: the first number in its links (get_authorized_teams_workspaces lists them)" };
const only = (name: string, what: string) => ({ name, type: "string", required: false, description: `Only this ${what} (its id)` });
const LIST = only("list_id", "list");
const TASK = only("task_id", "task");
const filters = (event: string) =>
  event === "taskDeleted" ? [TASK]
  : event.startsWith("task") ? [LIST, TASK]
  : event.startsWith("list") ? [LIST]
  : event.startsWith("folder") ? [only("folder_id", "folder")]
  : event.startsWith("space") ? [only("space_id", "space")]
  : event.startsWith("goal") ? [only("goal_id", "goal")]
  : [only("key_result_id", "target")];

const OUTPUT: ActionDetail["input"] = [
  { name: "event", type: "string", required: true, description: "ClickUp's name for what happened, like taskCreated" },
  { name: "task_id", type: "string", required: false, description: "The task, on task events" },
  { name: "list_id", type: "string", required: false, description: "The list, on list events" },
  { name: "folder_id", type: "string", required: false, description: "The folder, on folder events" },
  { name: "space_id", type: "string", required: false, description: "The space, on space events" },
  { name: "goal_id", type: "string", required: false, description: "The goal, on goal and target events" },
  { name: "key_result_id", type: "string", required: false, description: "The target, on target events" },
  { name: "history_items", type: "array", required: false, description: "What changed: who did it, the field, its value before and after, and the list in parent_id" },
];

// a run that changes the task reports the same event again
const echoes = (event: string) => event.startsWith("task") && !/Created|Deleted/.test(event) ? " A run that changes the same task starts this again, so say in the prompt when to stop." : "";
export const triggers: Record<string, { description: string; config: ActionDetail["input"]; output: ActionDetail["input"] }> = Object.fromEntries(
  ALL.map((e) => [trigger(e), { description: `ClickUp reports: ${spoken(e)}.${echoes(e)}`, config: [TEAM, ...filters(e)], output: OUTPUT }]),
);

type Payload = { event: string; webhook_id?: string; history_items?: { id?: string; parent_id?: string }[] } & Record<string, unknown>;

export const wanted = (config: unknown, data: unknown) => {
  const want = (config ?? {}) as Record<string, unknown>;
  const d = data as Payload;
  // a task's list is the parent of its history entries
  const got: Record<string, unknown> = { ...d, list_id: d.list_id ?? d.history_items?.[0]?.parent_id };
  return ["list_id", "task_id", "folder_id", "space_id", "goal_id", "key_result_id"].every((k) => !want[k] || String(got[k]) === String(want[k]));
};

// ponytail: ClickUp picks the signing secret and we store none, so an unguessable URL proves the sender. Ceiling: a leaked URL can forge events; store the webhook's secret from the create response if that ever matters
const hookToken = (connection: string, team: string) => createHmac("sha256", process.env.ENCRYPTION_KEY!).update(`clickup-webhook:${connection}:${team}`).digest("hex");
const hookUrl = (connection: string, team: string) => `${process.env.WEBHOOK_URL}/webhooks/app/clickup/${connection}/${team}/${hookToken(connection, team)}`;

const LIST_HOOKS: Send = { method: "GET", path: "/v2/team/{team}/webhook", query: [], headers: [] };
const body = (method: string, path: string, fields: string[]): Send => ({ method, path, query: [], headers: [], body: { kind: "fields", fields: fields.map((f) => [f, f]) } });
type Hook = { id: string; endpoint: string; events: string[]; health?: { status?: string } };
const findHook = async (api: Api, key: string, team: string, url: string) => ((await call(api, key, LIST_HOOKS, { team })) as { webhooks: Hook[] }).webhooks.find((h) => h.endpoint === url);

// Make sure this Workspace's webhook exists and carries `event`.
export async function watch(api: Api, key: string, connection: string, event: string, config: unknown) {
  if (!process.env.WEBHOOK_URL) throw new AppsError("this server can't receive ClickUp's events (WEBHOOK_URL isn't set)");
  const team = String((config as { team_id?: unknown } | null)?.team_id ?? "");
  if (!/^\d+$/.test(team)) throw new AppsError("team_id: give the ClickUp Workspace's id, the first number in its links");
  const endpoint = hookUrl(connection, team);
  const id = `clickup:${connection}:${team}`;
  const found = await findHook(api, key, team, endpoint);
  const healthy = found?.health?.status === undefined || found.health.status === "active";
  if (found && healthy && (found.events.includes(event) || found.events.includes("*"))) return id;
  if (found) await call(api, key, body("PUT", "/v2/webhook/{id}", ["endpoint", "events", "status"]), { id: found.id, endpoint, events: found.events.includes("*") ? ["*"] : [...new Set([...found.events, event])], status: "active" });
  else await call(api, key, body("POST", "/v2/team/{team}/webhook", ["endpoint", "events"]), { team, endpoint, events: [event] });
  return id;
}

export async function unwatch(api: Api, key: string, id: string) {
  const [, connection = "", team = ""] = id.split(":");
  const found = await findHook(api, key, team, hookUrl(connection, team));
  if (found) await call(api, key, { method: "DELETE", path: "/v2/webhook/{id}", query: [], headers: [] }, { id: found.id });
}

export async function receive(delivery: Delivery) {
  const [team = "", token = ""] = delivery.rest.split("/");
  const want = Buffer.from(hookToken(delivery.connection, team));
  const got = Buffer.from(token);
  if (got.length !== want.length || !timingSafeEqual(got, want)) return null;
  const payload = JSON.parse(delivery.body) as Payload;
  const name = trigger(String(payload.event ?? ""));
  const history = payload.history_items?.[0]?.id;
  const subject = payload.key_result_id ?? payload.task_id ?? payload.list_id ?? payload.folder_id ?? payload.space_id ?? payload.goal_id;
  // A history entry identifies a change; `seen` is shared, so the connection is in it, and the event because one change reports several.
  // Without one, only a create or delete is a once-only thing (ponytail: an update with no history may run twice on a retry)
  const id = history ? `${delivery.connection}:${payload.event}:${history}` : /Created$|Deleted$/.test(payload.event) && subject ? `${delivery.connection}:${payload.event}:${subject}` : undefined;
  const out: WebhookEvent = { ...(id && { id }), triggers: events[name] ? [name] : [], data: payload };
  return { events: async () => [out] };
}
