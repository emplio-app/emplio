// Everhour telling us about changes the moment they happen. One webhook per connection, for all of Everhour's events,
// at /webhooks/app/everhour/<connection>/all/<token>. Everhour doesn't sign deliveries (it sends a secret once, at the
// handshake), so the token in the address, worked out from ENCRYPTION_KEY and the connection and never stored, proves them.
import { createHmac, timingSafeEqual } from "node:crypto";
import type { ActionDetail } from "@emplio/shared";
import { AppsError } from "../../types";
import type { Delivery } from "../index";
import { type Api, call, type Send } from "../openapi";

type Field = ActionDetail["input"][number];
type Trigger = { description: string; config: ActionDetail["input"]; output: ActionDetail["input"] };
const PROJECT: Field = { name: "project_id", type: "string", required: false, description: "Only for this project (its id, like ev:1234567890; list_projects shows them)" };
const USER: Field = { name: "user_id", type: "number", required: false, description: "Only when this person did it or it's theirs (their Everhour user id; list_team_members shows them)" };
const OUTPUT: ActionDetail["input"] = [
  { name: "event", type: "string", required: true, description: "Everhour's event, like api:task:created" },
  { name: "id", type: "string", required: true, description: "The id of what changed (a task's ev:123, a client's number...)" },
  { name: "item", type: "object", required: false, description: "It as it is now, the same shape the matching get_ action answers with" },
  { name: "projects", type: "string[]", required: false, description: "Ids of the projects it belongs to" },
  { name: "users", type: "number[]", required: false, description: "Ids of the people it concerns" },
  { name: "user", type: "object", required: false, description: "Who did it: id and teamId" },
  { name: "created_at", type: "string", required: true, description: "When, as YYYY-MM-DD HH:MM:SS in UTC" },
];
const AGAIN = " A run that changes the same thing starts this again, so say in the prompt when to stop.";

// trigger → [Everhour event, what happened, filters it takes]
const EVENTS: Record<string, [string, string, Field[]]> = {
  new_project: ["api:project:created", "A project was created in Everhour.", [USER]],
  project_updated: ["api:project:updated", "A project's details changed in Everhour." + AGAIN, [PROJECT, USER]],
  project_deleted: ["api:project:removed", "A project was deleted in Everhour.", [PROJECT, USER]],
  new_task: ["api:task:created", "A task was created in Everhour.", [PROJECT, USER]],
  task_updated: ["api:task:updated", "A task's details changed in Everhour (name, status, assignees, due date...)." + AGAIN, [PROJECT, USER]],
  task_deleted: ["api:task:removed", "A task was deleted in Everhour.", [PROJECT, USER]],
  task_restored: ["api:task:recovered", "A deleted task was restored in Everhour.", [PROJECT, USER]],
  timer_started: ["api:timer:started", "Someone started a timer in Everhour.", [PROJECT, USER]],
  timer_stopped: ["api:timer:stopped", "Someone stopped a running timer in Everhour.", [PROJECT, USER]],
  time_updated: ["api:time:updated", "Time was logged or a time record changed in Everhour (a stopped timer, time added by hand or edited)." + AGAIN, [PROJECT, USER]],
  new_section: ["api:section:created", "A section was added to a project in Everhour.", [PROJECT, USER]],
  section_updated: ["api:section:updated", "A project section changed in Everhour.", [PROJECT, USER]],
  section_deleted: ["api:section:removed", "A project section was deleted in Everhour.", [PROJECT, USER]],
  section_restored: ["api:section:recovered", "A deleted project section was restored in Everhour.", [PROJECT, USER]],
  new_client: ["api:client:created", "A client was added in Everhour.", [USER]],
  client_updated: ["api:client:updated", "A client's details changed in Everhour." + AGAIN, [USER]],
  estimate_updated: ["api:estimate:updated", "A task's time estimate changed in Everhour.", [PROJECT, USER]],
  new_invoice: ["api:invoice:created", "An invoice was created in Everhour.", [USER]],
  invoice_updated: ["api:invoice:updated", "An invoice changed in Everhour (items, status, sent or paid)." + AGAIN, [USER]],
  invoice_deleted: ["api:invoice:deleted", "An invoice was deleted in Everhour.", [USER]],
};
export const triggers: Record<string, Trigger> = Object.fromEntries(Object.entries(EVENTS).map(([t, [, description, config]]) => [t, { description, config, output: OUTPUT }]));
export const events: Record<string, string> = Object.fromEntries(Object.entries(EVENTS).map(([t, [e]]) => [t, e]));
const ALL = Object.values(events);

export type EventData = { event: string; id: string; item?: any; projects?: string[]; users?: number[]; user?: { id?: number; teamId?: number }; created_at: string };

export const wanted = (config: unknown, data: unknown) => {
  const want = (config ?? {}) as { project_id?: string; user_id?: number | string };
  const d = data as EventData;
  const project = want.project_id ? String(want.project_id) : "";
  const user = want.user_id === undefined || want.user_id === "" ? "" : String(want.user_id);
  const projects = [...(d.projects ?? []), d.item?.project, ...(d.item?.projects ?? [])].filter(Boolean).map(String);
  const users = [...(d.users ?? []), d.user?.id, d.item?.user].filter((u) => u != null).map(String);
  return (!project || projects.includes(project)) && (!user || users.includes(user));
};

const token = (connection: string) => createHmac("sha256", process.env.ENCRYPTION_KEY!).update(`everhour-webhook:${connection}`).digest("hex");
const hookUrl = (connection: string) => `${process.env.WEBHOOK_URL}/webhooks/app/everhour/${connection}/all/${token(connection)}`;

const send = (method: string, path: string, fields: string[] = []): Send => ({ method, path, query: [], headers: [], ...(fields.length && { body: { kind: "fields" as const, fields: fields.map((f): [string, string] => [f, f]) } }) });
type Hook = { id: number; targetUrl: string; events: string[]; project?: string | null; active: boolean };
const ours = async (api: Api, key: string, connection: string) => ((await call(api, key, send("GET", "/hooks"), {})) as Hook[]).find((h) => h.targetUrl === hookUrl(connection));

// ponytail: one account-wide webhook with every event per connection, matched and filtered here; project-scoped hooks if that traffic ever matters
export async function watch(api: Api, key: string, connection: string) {
  if (!process.env.WEBHOOK_URL) throw new AppsError("this server can't receive Everhour's events (WEBHOOK_URL isn't set)");
  const id = `everhour:${connection}:all`;
  const found = await ours(api, key, connection);
  if (found?.active && ALL.every((e) => found.events?.includes(e))) return id;
  // Everhour switches a webhook off when deliveries keep failing; sending its events again switches it back on
  if (found) await call(api, key, send("PUT", "/hooks/{id}", ["events"]), { id: found.id, events: ALL });
  else await call(api, key, send("POST", "/hooks", ["targetUrl", "events"]), { targetUrl: hookUrl(connection), events: ALL });
  return id;
}

export async function unwatch(api: Api, key: string, id: string) {
  const [, connection = ""] = id.split(":");
  const found = await ours(api, key, connection);
  if (found) await call(api, key, send("DELETE", "/hooks/{id}"), { id: found.id });
}

export async function receive(delivery: Delivery) {
  const got = Buffer.from(delivery.rest.split("/")[1] ?? "");
  const want = Buffer.from(token(delivery.connection));
  if (got.length !== want.length || !timingSafeEqual(got, want)) return null;
  let body: { event?: string; createdAt?: string; data?: { id?: string | number; data?: any }; attributes?: { projects?: string[]; users?: number[] }; user?: EventData["user"] } = {};
  try {
    body = JSON.parse(delivery.body || "{}");
  } catch {
    // the handshake when the webhook is made or changed carries only X-Hook-Secret; a 200 is all it needs
  }
  const names = Object.entries(events).filter(([, e]) => e === body.event).map(([t]) => t);
  const itemId = String(body.data?.id ?? body.data?.data?.id ?? "");
  const data: EventData = {
    event: body.event ?? "",
    id: itemId,
    ...(body.data?.data != null && { item: body.data.data }),
    ...(body.attributes?.projects && { projects: body.attributes.projects }),
    ...(body.attributes?.users && { users: body.attributes.users }),
    ...(body.user && { user: body.user }),
    created_at: body.createdAt ?? "",
  };
  // Everhour sends no delivery id; a retry repeats the event, the item and the time. `seen` is shared, so the connection is in it
  const id = [delivery.connection, body.event, itemId, body.createdAt].join(":");
  return { events: async () => (names.length ? [{ id, triggers: names, data }] : []) };
}
