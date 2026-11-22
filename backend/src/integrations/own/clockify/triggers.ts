// Clockify telling us about events the moment they happen. A Clockify webhook carries one event for one workspace, so
// each event an automation wants gets its own, at /webhooks/app/clockify/<connection>/<workspace>-<EVENT>/<token>.
// Composio has no Clockify triggers; ours are Clockify's event names in snake_case.
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { ActionDetail } from "@emplio/shared";
import { AppsError } from "../../types";
import type { Delivery } from "../index";
import { type Api, call, type Send } from "../openapi";

// every webhookEvent in Clockify's spec (CreateWebhookRequestV1)
const ALL = [
  "NEW_PROJECT", "PROJECT_UPDATED", "PROJECT_DELETED", "NEW_TASK", "TASK_UPDATED", "TASK_DELETED", "NEW_CLIENT", "CLIENT_UPDATED", "CLIENT_DELETED",
  "NEW_TAG", "TAG_UPDATED", "TAG_DELETED",
  "NEW_TIMER_STARTED", "TIMER_STOPPED", "NEW_TIME_ENTRY", "TIME_ENTRY_UPDATED", "TIME_ENTRY_DELETED", "TIME_ENTRY_SPLIT", "TIME_ENTRY_RESTORED",
  "USER_JOINED_WORKSPACE", "USER_DELETED_FROM_WORKSPACE", "USER_DEACTIVATED_ON_WORKSPACE", "USER_ACTIVATED_ON_WORKSPACE", "USER_EMAIL_CHANGED", "USER_UPDATED",
  "USERS_INVITED_TO_WORKSPACE", "LIMITED_USERS_ADDED_TO_WORKSPACE", "USER_GROUP_CREATED", "USER_GROUP_UPDATED", "USER_GROUP_DELETED",
  "COST_RATE_UPDATED", "BILLABLE_RATE_UPDATED",
  "NEW_INVOICE", "INVOICE_UPDATED", "NEW_APPROVAL_REQUEST", "APPROVAL_REQUEST_STATUS_UPDATED",
  "TIME_OFF_REQUESTED", "TIME_OFF_REQUEST_UPDATED", "TIME_OFF_REQUEST_APPROVED", "TIME_OFF_REQUEST_REJECTED", "TIME_OFF_REQUEST_STARTED", "TIME_OFF_REQUEST_WITHDRAWN", "BALANCE_UPDATED",
  "ASSIGNMENT_CREATED", "ASSIGNMENT_UPDATED", "ASSIGNMENT_PUBLISHED", "ASSIGNMENT_DELETED",
  "EXPENSE_CREATED", "EXPENSE_UPDATED", "EXPENSE_DELETED", "EXPENSE_RESTORED",
];
export const events: Record<string, string> = Object.fromEntries(ALL.map((e) => [e.toLowerCase(), e]));

const WORKSPACE = { name: "workspace_id", type: "string", required: false, description: "The Clockify workspace to watch (get_all_my_workspaces lists them). Left out: the account's current workspace" };
const PROJECT = { name: "project_id", type: "string", required: false, description: "Only events about this project (its id, from get_projects)" };
const USER = { name: "user_id", type: "string", required: false, description: "Only events about this person (their user id, from find_users_on_workspace)" };
const OUTPUT: ActionDetail["input"] = [
  { name: "id", type: "string", required: false, description: "The id of what the event is about: the time entry, project, task, client, tag, person, invoice, request or expense" },
  { name: "workspaceId", type: "string", required: false, description: "The workspace" },
  { name: "projectId", type: "string", required: false, description: "The project, where there is one" },
  { name: "userId", type: "string", required: false, description: "The person, where there is one" },
  { name: "description", type: "string", required: false, description: "On time entries: what the time was spent on" },
  { name: "timeInterval", type: "object", required: false, description: "On time entries: start, end and duration (ISO 8601, like PT1H30M)" },
  { name: "name", type: "string", required: false, description: "On projects, tasks, clients, tags and groups: its name" },
];

const spoken = (event: string) => event.toLowerCase().replace(/_/g, " ");
// a run that changes the same thing reports it again
const echoes = (event: string) => (/UPDATED|STOPPED|SPLIT/.test(event) ? " A run that changes the same item starts this again, so say in the prompt when to stop." : "");
export const triggers: Record<string, { description: string; config: ActionDetail["input"]; output: ActionDetail["input"] }> = Object.fromEntries(
  ALL.map((e) => [e.toLowerCase(), { description: `Clockify reports: ${spoken(e)}.${echoes(e)}`, config: [WORKSPACE, PROJECT, USER], output: OUTPUT }]),
);

type Payload = { id?: string; projectId?: string; project?: { id?: string }; userId?: string; user?: { id?: string } } & Record<string, unknown>;
export const wanted = (config: unknown, data: unknown) => {
  const want = (config ?? {}) as { project_id?: string; user_id?: string };
  const d = (data ?? {}) as Payload & { event?: string };
  // a project or person event is about itself
  const project = d.projectId ?? d.project?.id ?? (d.event?.includes("PROJECT") ? d.id : undefined);
  const user = d.userId ?? d.user?.id ?? (/^USERS?_|LIMITED_USERS/.test(d.event ?? "") ? d.id : undefined);
  return (!want.project_id || project === want.project_id) && (!want.user_id || user === want.user_id);
};

// ponytail: Clockify picks each webhook's signing token and we store none, so an unguessable URL proves the sender. Ceiling: a leaked URL can forge events; compare the Clockify-Signature header with the stored token if that ever matters
const hookToken = (connection: string, at: string) => createHmac("sha256", process.env.ENCRYPTION_KEY!).update(`clockify-webhook:${connection}:${at}`).digest("hex");
const hookUrl = (connection: string, at: string) => `${process.env.WEBHOOK_URL}/webhooks/app/clockify/${connection}/${at}/${hookToken(connection, at)}`;

const send = (method: string, path: string, fields: string[] = []): Send => ({ method, path, query: [], headers: [], ...(fields.length && { body: { kind: "fields" as const, fields: fields.map((f): [string, string] => [f, f]) } }) });
type Hook = { id: string; url: string; enabled?: boolean };
const findHook = async (api: Api, key: string, workspaceId: string, url: string) =>
  ((await call(api, key, send("GET", "/v1/workspaces/{workspaceId}/webhooks"), { workspaceId })) as { webhooks?: Hook[] }).webhooks?.find((h) => h.url === url);
const remove = (api: Api, key: string, workspaceId: string, webhookId: string) => call(api, key, send("DELETE", "/v1/workspaces/{workspaceId}/webhooks/{webhookId}"), { workspaceId, webhookId });

// Make sure this workspace has our webhook for `event`.
export async function watch(api: Api, key: string, connection: string, event: string, config: unknown) {
  if (!process.env.WEBHOOK_URL) throw new AppsError("this server can't receive Clockify's events (WEBHOOK_URL isn't set)");
  if (!ALL.includes(event)) throw new AppsError(`Clockify has no event ${event}`);
  let workspaceId = String((config as { workspace_id?: unknown } | null)?.workspace_id ?? "");
  if (!workspaceId) {
    const me = (await call(api, key, send("GET", "/v1/user"), {})) as { activeWorkspace?: string; defaultWorkspace?: string };
    workspaceId = me.activeWorkspace || me.defaultWorkspace || "";
  }
  if (!/^[a-z0-9]+$/i.test(workspaceId)) throw new AppsError("workspace_id: give the Clockify workspace's id (get_all_my_workspaces lists them)");
  const at = `${workspaceId}-${event}`;
  const url = hookUrl(connection, at);
  const found = await findHook(api, key, workspaceId, url);
  if (found && found.enabled !== false) return `clockify:${connection}:${at}`;
  // Clockify switches a webhook off when deliveries keep failing; a new one starts clean
  if (found) await remove(api, key, workspaceId, found.id);
  await call(api, key, send("POST", "/v1/workspaces/{workspaceId}/webhooks", ["name", "url", "webhookEvent", "triggerSourceType", "triggerSource"]), {
    workspaceId,
    name: "Emplio",
    url,
    webhookEvent: event,
    triggerSourceType: "WORKSPACE_ID",
    triggerSource: [workspaceId],
  });
  return `clockify:${connection}:${at}`;
}

export async function unwatch(api: Api, key: string, id: string) {
  const [, connection = "", at = ""] = id.split(":");
  const workspaceId = at.split("-")[0]!;
  const found = await findHook(api, key, workspaceId, hookUrl(connection, at));
  if (found) await remove(api, key, workspaceId, found.id);
}

export async function receive(delivery: Delivery) {
  const [at = "", token = ""] = delivery.rest.split("/");
  const want = Buffer.from(hookToken(delivery.connection, at));
  const got = Buffer.from(token);
  if (got.length !== want.length || !timingSafeEqual(got, want)) return null;
  const event = at.split("-")[1] ?? "";
  const name = event.toLowerCase();
  // Clockify sends no delivery id: a retry is the same body, and `seen` is shared, so the connection and event are in it
  const id = `${delivery.connection}:${event}:${createHash("sha256").update(delivery.body).digest("hex")}`;
  const data = { event, ...(JSON.parse(delivery.body || "{}") as object) };
  return { events: async () => [{ id, triggers: events[name] ? [name] : [], data }] };
}
