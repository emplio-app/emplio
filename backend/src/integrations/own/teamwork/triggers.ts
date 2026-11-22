// Teamwork.com telling us about changes the moment they happen. Teamwork's webhooks are one event each, so each event an
// automation wants gets its own site-level webhook at /webhooks/app/teamwork/<connection>/<EVENT>. Each delivery is
// signed: X-Projects-Signature is an HMAC-SHA256 of the body with the webhook's token, worked out from ENCRYPTION_KEY
// and the connection, never stored. Site-level webhooks need a site administrator's key and a paid plan.
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { ActionDetail } from "@emplio/shared";
import { AppsError } from "../../types";
import type { Delivery } from "../index";
import { type Api, call, type Send } from "../openapi";

type Field = ActionDetail["input"][number];
const PROJECT: Field = { name: "project_id", type: "number", required: false, description: "Only in this Teamwork project (its id; list_projects lists them)" };
const TASKLIST: Field = { name: "tasklist_id", type: "number", required: false, description: "Only tasks in this task list (its id; list_task_lists lists them)" };
const OUTPUT: ActionDetail["input"] = [
  { name: "event", type: "string", required: true, description: "Teamwork's name for what happened, like TASK.CREATED" },
  { name: "eventCreator", type: "object", required: false, description: "Who did it: id, firstName, lastName" },
  { name: "<item>", type: "object", required: false, description: "The item as it is now, under its kind (task, project, comment, time, taskList, milestone...). A delete sends only id and projectId" },
];
const AGAIN = " A run that changes the same item starts this again, so say in the prompt when to stop.";
const ADMIN = " Needs a site administrator's key on a paid Teamwork.com plan.";

// Teamwork's object → [what it is, its events, the payload's key, extra settings]
const OBJECTS: Record<string, [label: string, actions: string[], extra?: Field[]]> = {
  TASK: ["task", ["CREATED", "UPDATED", "COMPLETED", "REOPENED", "DELETED", "MOVED", "REMINDER", "TAGGED", "UNTAGGED"], [TASKLIST]],
  TASKLIST: ["task list", ["CREATED", "CREATEDFROMTEMPLATE", "UPDATED", "COMPLETED", "REOPENED", "DELETED"]],
  PROJECT: ["project", ["CREATED", "UPDATED", "COMPLETED", "REOPENED", "ARCHIVED", "COPIED", "DELETED", "TAGGED", "UNTAGGED"]],
  PROJECTUPDATE: ["project status update", ["CREATED", "UPDATED", "DELETED"]],
  PROJECTRATE: ["project billing rate", ["UPDATED"]],
  MILESTONE: ["milestone", ["CREATED", "UPDATED", "COMPLETED", "REOPENED", "DELETED", "REMINDER", "TAGGED", "UNTAGGED"]],
  COMMENT: ["comment", ["CREATED", "UPDATED", "DELETED"]],
  MESSAGE: ["message", ["CREATED", "UPDATED", "DELETED", "TAGGED", "UNTAGGED"]],
  MESSAGEREPLY: ["message reply", ["CREATED", "UPDATED", "DELETED"]],
  NOTEBOOK: ["notebook", ["CREATED", "UPDATED", "DELETED", "TAGGED", "UNTAGGED"]],
  LINK: ["link", ["CREATED", "UPDATED", "DELETED", "TAGGED", "UNTAGGED"]],
  FILE: ["file", ["CREATED", "UPDATED", "DELETED", "DOWNLOADED", "TAGGED", "UNTAGGED"]],
  TIME: ["time entry", ["CREATED", "UPDATED", "DELETED", "TAGGED", "UNTAGGED"]],
  TIMER: ["timer", ["CREATED"]],
  BUDGET: ["project budget", ["CREATED", "UPDATED", "DELETED"]],
  EXPENSE: ["expense", ["CREATED", "UPDATED", "DELETED"]],
  INVOICE: ["invoice", ["CREATED", "UPDATED", "COMPLETED", "REOPENED", "DELETED"]],
  RISK: ["risk", ["CREATED", "UPDATED", "DELETED"]],
  FORM: ["form", ["CREATED", "PUBLISHED", "SUBMITTED", "DELETED"]],
  CALENDAREVENT: ["calendar event", ["CREATED", "UPDATED", "DELETED", "REMINDER"]],
  COMPANY: ["company (client)", ["CREATED", "UPDATED", "DELETED"]],
  USER: ["user", ["CREATED", "UPDATED", "DELETED"]],
  TEAM: ["team", ["CREATED", "UPDATED", "DELETED"]],
  ROLE: ["job role", ["CREATED", "UPDATED", "DELETED"]],
  STATUS: ["person's status message", ["CREATED", "UPDATED", "DELETED"]],
  STAGE: ["board stage", ["CREATED", "UPDATED", "DELETED"]],
  CARD: ["board card", ["CREATED", "UPDATED", "DELETED"]],
  COLUMN: ["board column", ["CREATED", "UPDATED", "DELETED"]],
  PORTFOLIOBOARD: ["portfolio board", ["CREATED", "UPDATED", "DELETED"]],
  PORTFOLIOCARD: ["portfolio card", ["CREATED", "UPDATED", "MOVED", "REOPENED", "DELETED"]],
  PORTFOLIOCOLUMN: ["portfolio column", ["CREATED", "UPDATED", "DELETED"]],
  GOOGLEDRIVE: ["Google Drive link", ["CONNECTED", "INTEGRATED"]],
};
// our trigger names: words split as people say them
const SNAKE: Record<string, string> = {
  TASKLIST: "task_list", PROJECTUPDATE: "project_update", PROJECTRATE: "project_rate", MESSAGEREPLY: "message_reply", CALENDAREVENT: "calendar_event",
  PORTFOLIOBOARD: "portfolio_board", PORTFOLIOCARD: "portfolio_card", PORTFOLIOCOLUMN: "portfolio_column", GOOGLEDRIVE: "google_drive",
};
const SAID: Record<string, string> = {
  CREATED: "was added", UPDATED: "changed", COMPLETED: "was completed", REOPENED: "was reopened", DELETED: "was deleted", MOVED: "was moved",
  REMINDER: "reminder went off", TAGGED: "was tagged", UNTAGGED: "had a tag removed", ARCHIVED: "was archived", COPIED: "was copied",
  CREATEDFROMTEMPLATE: "was added from a template", DOWNLOADED: "was downloaded", PUBLISHED: "was published", SUBMITTED: "was filled in and submitted",
  CONNECTED: "was connected", INTEGRATED: "was set up",
};

export const triggers: Record<string, { description: string; config: ActionDetail["input"]; output: ActionDetail["input"] }> = {};
export const events: Record<string, string> = {};
for (const [object, [label, actions, extra = []]] of Object.entries(OBJECTS))
  for (const action of actions) {
    const name = `${SNAKE[object] ?? object.toLowerCase()}_${action === "CREATEDFROMTEMPLATE" ? "created_from_template" : action.toLowerCase()}`;
    const a = /^[aeio]/.test(label) ? "An" : "A";
    const what = action === "REMINDER" ? `A ${label} ${SAID[action]}` : `${a} ${label} ${SAID[action]}`;
    triggers[name] = { description: `${what} in Teamwork.com.${action === "UPDATED" ? AGAIN : ""}${ADMIN}`, config: [PROJECT, ...extra], output: OUTPUT };
    events[name] = `${object}.${action}`;
  }

// the item in the payload: under its kind's name in any case (taskList, messageReply), or the payload itself on a delete
const itemOf = (data: any) => {
  const kind = String(data?.event ?? "").split(".")[0]!.toLowerCase();
  const key = Object.keys(data ?? {}).find((k) => k.toLowerCase() === kind);
  return (key ? data[key] : data) ?? {};
};
export const wanted = (config: unknown, data: unknown) => {
  const want = (config ?? {}) as { project_id?: number | string; tasklist_id?: number | string };
  const d = data as any;
  const item = itemOf(d);
  const project = item.projectId ?? d?.projectId ?? (d?.event?.startsWith("PROJECT.") ? item.id : undefined);
  const same = (w: unknown, got: unknown) => w === undefined || w === "" || String(w) === String(got);
  return same(want.project_id, project) && same(want.tasklist_id, item.tasklistId ?? item.taskListId);
};

export const token = (connection: string) => createHmac("sha256", process.env.ENCRYPTION_KEY!).update(`teamwork-webhook:${connection}`).digest("hex");
const hookUrl = (connection: string, event: string) => `${process.env.WEBHOOK_URL}/webhooks/app/teamwork/${connection}/${event}`;
const send = (method: string, path: string, body = false): Send => ({ method, path, query: [], headers: [], ...(body && { body: { kind: "whole" as const, field: "body" } }) });
type Hook = { id: string | number; url: string; event: string; status?: string };
const ours = async (api: Api, key: string, url: string) => {
  const { webhooks } = (await call(api, key, send("GET", "/webhooks.json"), {})) as { webhooks?: Hook[] };
  return (webhooks ?? []).filter((h) => h.url === url);
};
const remove = (api: Api, key: string, id: string | number) => call(api, key, send("DELETE", "/webhooks/{id}.json"), { id });

export async function watch(api: Api, key: string, connection: string, event: string) {
  if (!process.env.WEBHOOK_URL) throw new AppsError("this server can't receive Teamwork.com's events (WEBHOOK_URL isn't set)");
  const id = `teamwork:${connection}:${event}`;
  const url = hookUrl(connection, event);
  const found = await ours(api, key, url);
  if (found.some((h) => h.event === event && (h.status ?? "ACTIVE").toUpperCase() === "ACTIVE")) return id;
  // Teamwork switches a webhook off after deliveries keep failing; a fresh one starts clean
  for (const h of found) await remove(api, key, h.id);
  await call(api, key, send("POST", "/webhooks.json", true), { body: { webhook: { event, url, version: "2", contentType: "application/json", token: token(connection) } } }).catch((e) => {
    throw e instanceof AppsError && !e.expired
      ? new AppsError(`${e.message}. Teamwork.com webhooks need a site administrator's key, a paid plan, and webhooks turned on in Settings → Webhooks`)
      : e;
  });
  return id;
}

export async function unwatch(api: Api, key: string, id: string) {
  const [, connection = "", event = ""] = id.split(":");
  for (const h of await ours(api, key, hookUrl(connection, event))) await remove(api, key, h.id);
}

const signed = (body: string, header: unknown, connection: string) => {
  const got = Buffer.from(typeof header === "string" ? header.toLowerCase() : "");
  const want = Buffer.from(createHmac("sha256", token(connection)).update(body).digest("hex"));
  return got.length === want.length && timingSafeEqual(got, want);
};

export async function receive(delivery: Delivery) {
  if (!signed(delivery.body, delivery.headers["x-projects-signature"], delivery.connection)) return null;
  const event = delivery.rest.split("/")[0]!.toUpperCase();
  const names = Object.keys(events).filter((t) => events[t] === event);
  const body = JSON.parse(delivery.body || "{}") as Record<string, unknown>;
  // `seen` is shared across apps, so the connection is in the id; a retry is the same body
  const deliveryId = delivery.headers["x-projects-delivery"];
  const id = [delivery.connection, event, typeof deliveryId === "string" && deliveryId ? deliveryId : createHash("sha256").update(delivery.body).digest("hex")].join(":");
  const data = { event, ...body };
  return { events: async () => (names.length ? [{ id, triggers: names, data }] : []) };
}
