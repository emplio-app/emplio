// Wrike telling us about changes the moment they happen. One webhook per connection for the whole account (every event)
// at /webhooks/app/wrike/<connection>; an automation set to one folder or space gets a webhook on just that folder
// (with its subfolders) or space, at /webhooks/app/wrike/<connection>/f-<folder> or s-<space>. Wrike signs every delivery
// with X-Hook-Signature, an HMAC of the body keyed by a secret worked out from ENCRYPTION_KEY and the connection, never
// stored; when a webhook is made it first proves the secret with a handshake (X-Hook-Secret), answered here.
// Payloads only carry ids, so each event is sent on with the task or folder as it is now (item), fetched in one call.
import { createHmac, timingSafeEqual } from "node:crypto";
import type { ActionDetail } from "@emplio/shared";
import { AppsError } from "../../types";
import type { Delivery, WebhookEvent } from "../index";
import { type Api, call, type Send } from "../openapi";

type Field = ActionDetail["input"][number];
const FOLDER: Field = { name: "folder_id", type: "string", required: false, description: "Only what happens in this folder or project, subfolders included (its id; get_folders lists them). Leave out for the whole account" };
const SPACE: Field = { name: "space_id", type: "string", required: false, description: "Only what happens in this space (its id; list_spaces lists them). Leave out for the whole account" };
const TASK: Field = { name: "task_id", type: "string", required: false, description: "Only this task (its id)" };
const ASSIGNEE: Field = { name: "assignee_id", type: "string", required: false, description: "Only tasks assigned to this person, or projects they own (their id; get_contacts lists people)" };
const STATUS: Field = { name: "status", type: "string", required: false, description: "Only when the new status is this, like Completed or In Review (its name as Wrike shows it)" };
const OUTPUT: Field[] = [
  { name: "eventType", type: "string", required: true, description: "What happened, in Wrike's words (TaskStatusChanged...)" },
  { name: "eventAuthorId", type: "string", required: false, description: "Who did it (their user id; get_specific_user tells who)" },
  { name: "lastUpdatedDate", type: "string", required: true, description: "When (UTC)" },
  { name: "taskId", type: "string", required: false, description: "The task it's about (folderId for folders and projects)" },
  { name: "item", type: "object", required: false, description: "The task, folder or project as it is now: title, status, permalink, responsibleIds, parentIds, dates... (missing once deleted)" },
  { name: "changes", type: "object", required: false, description: "The rest of what Wrike sent: old and new values (oldValue, oldStatus, status, addedResponsibles...), commentId, attachmentId, approvalId..." },
];
const AGAIN = " A run that changes the same item starts this again, so say in the prompt when to stop.";

// Wrike's event → what it means; the trigger is its snake_case name (TaskStatusChanged → task_status_changed)
const EVENTS: Record<string, string> = {
  TaskCreated: "A task was created in Wrike",
  TaskDeleted: "A task was deleted in Wrike",
  TaskTitleChanged: "A Wrike task was renamed",
  TaskImportanceChanged: "A Wrike task's importance changed (High, Normal, Low)",
  TaskStatusChanged: "A Wrike task moved to another status",
  TaskDatesChanged: "A Wrike task's start date, due date or duration changed",
  TaskParentsAdded: "A Wrike task was added to another folder or project",
  TaskParentsRemoved: "A Wrike task was taken out of a folder or project",
  TaskResponsiblesAdded: "Someone was assigned to a Wrike task",
  TaskResponsiblesRemoved: "Someone was unassigned from a Wrike task",
  TaskSharedsAdded: "A Wrike task was shared with someone",
  TaskSharedsRemoved: "A Wrike task was unshared from someone",
  TaskDescriptionChanged: "A Wrike task's description changed (Wrike sends this about 5 minutes late)",
  TaskCustomFieldChanged: "A custom field changed on a Wrike task",
  AttachmentAdded: "A file was attached to a Wrike task",
  AttachmentDeleted: "A file was removed from a Wrike task",
  CommentAdded: "Someone commented on a Wrike task",
  CommentDeleted: "A comment on a Wrike task was deleted",
  TimelogChanged: "Time was logged, changed or removed on a Wrike task",
  TaskApprovalStatusChanged: "An approval on a Wrike task changed status (approved, rejected, cancelled...)",
  TaskApprovalDecisionChanged: "Someone approved or rejected a Wrike task's approval",
  TaskApprovalDecisionReset: "A Wrike task's approval decision was reset (a new file version, say)",
  FolderCreated: "A folder or project was created in Wrike",
  FolderDeleted: "A folder or project was deleted in Wrike",
  FolderTitleChanged: "A Wrike folder or project was renamed",
  FolderParentsAdded: "A Wrike folder or project was added to another folder",
  FolderParentsRemoved: "A Wrike folder or project was taken out of a folder",
  FolderSharedsAdded: "A Wrike folder or project was shared with someone",
  FolderSharedsRemoved: "A Wrike folder or project was unshared from someone",
  FolderDescriptionChanged: "A Wrike folder's or project's description changed",
  FolderCommentAdded: "Someone commented on a Wrike folder or project",
  FolderCommentDeleted: "A comment on a Wrike folder or project was deleted",
  FolderAttachmentAdded: "A file was attached to a Wrike folder or project",
  FolderAttachmentDeleted: "A file was removed from a Wrike folder or project",
  FolderCustomFieldChanged: "A custom field changed on a Wrike folder or project",
  ProjectDatesChanged: "A Wrike project's start or end date changed",
  ProjectOwnersAdded: "Someone was made an owner of a Wrike project",
  ProjectOwnersRemoved: "Someone stopped being an owner of a Wrike project",
  ProjectStatusChanged: "A Wrike project moved to another status",
  FolderApprovalStatusChanged: "An approval on a Wrike folder or project changed status",
  FolderApprovalDecisionChanged: "Someone approved or rejected a Wrike folder's or project's approval",
  FolderApprovalDecisionReset: "A Wrike folder's or project's approval decision was reset",
  WorkItemTypeChanged: "A Wrike item was changed to another item type (a task turned into a custom item type, say)",
  CreateFromBlueprintCompleted: "Wrike finished creating work from a blueprint",
  ImportFromFileCompleted: "Wrike finished importing tasks from an Excel or Microsoft Project file",
};
const snake = (s: string) => s.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
const onFolder = (event: string) => /^(Folder|Project)/.test(event);
const onTask = (event: string) => /^(Task|Comment|Attachment|Timelog)/.test(event);

type Trigger = { description: string; config: Field[]; output: Field[] };
export const triggers: Record<string, Trigger> = {};
export const events: Record<string, string> = {};
for (const [event, what] of Object.entries(EVENTS)) {
  const config = onTask(event) ? [FOLDER, SPACE, TASK, ASSIGNEE] : onFolder(event) ? [FOLDER, SPACE, ASSIGNEE] : [FOLDER, SPACE];
  if (/StatusChanged$/.test(event) && !/Approval/.test(event)) config.push(STATUS);
  const again = /Changed$|Added$/.test(event) && event !== "TaskCreated" ? AGAIN : "";
  triggers[snake(event)] = { description: `${what}.${again}`, config, output: OUTPUT };
  events[snake(event)] = event;
}
triggers.task_completed = { description: "A Wrike task was marked done (moved to a Completed status).", config: [FOLDER, SPACE, TASK, ASSIGNEE], output: OUTPUT };
events.task_completed = "TaskStatusChanged";

type Raw = { eventType?: string; taskId?: string; folderId?: string; webhookId?: string; lastUpdatedDate?: string; eventAuthorId?: string; [k: string]: unknown };
export type EventData = { eventType: string; eventAuthorId?: string; lastUpdatedDate?: string; taskId?: string; folderId?: string; item?: any; changes: Record<string, unknown> };

export const wanted = (config: unknown, data: unknown) => {
  const want = (config ?? {}) as { task_id?: string; assignee_id?: string; status?: string };
  const d = data as EventData;
  const item = d.item ?? {};
  const has = (list: unknown, v: string) => Array.isArray(list) && list.includes(v);
  if (want.task_id && want.task_id !== (d.taskId ?? item.id)) return false;
  if (want.assignee_id && ![item.responsibleIds, item.project?.ownerIds, d.changes.addedResponsibles, d.changes.addedOwners].some((l) => has(l, want.assignee_id!))) return false;
  const same = (s: unknown) => typeof s === "string" && s.toLowerCase() === want.status!.toLowerCase();
  if (want.status && !same(d.changes.status) && !same(item.status)) return false;
  return true;
};

const secret = (connection: string) => createHmac("sha256", process.env.ENCRYPTION_KEY!).update(`wrike-webhook:${connection}`).digest("hex");
const sign = (key: string, value: string) => createHmac("sha256", key).update(value).digest("hex");
const hookUrl = (connection: string, scope = "") => `${process.env.WEBHOOK_URL}/webhooks/app/wrike/${connection}${scope ? `/${scope}` : ""}`;
const ID = /^[A-Za-z0-9]+$/;
// the part of the address (and of the id automations are stored under) for one folder or space
const scopeOf = (config: unknown) => {
  const c = (config ?? {}) as { folder_id?: string; space_id?: string };
  const id = c.folder_id || c.space_id;
  if (!id) return "";
  if (!ID.test(id)) throw new AppsError(`${c.folder_id ? "folder_id" : "space_id"}: a Wrike id, like IEAAAOVII7777777`);
  return `${c.folder_id ? "f" : "s"}-${id}`;
};

const send = (method: string, path: string, fields: string[] = []): Send => ({ method, path, query: [], headers: [], ...(fields.length && { body: { kind: "urlencoded" as const, fields: fields.map((f): [string, string] => [f, f]) } }) });
type Hook = { id: string; hookUrl: string; status: string };
const ours = async (api: Api, key: string, url: string) => {
  const { data } = (await call(api, key, send("GET", "/webhooks"), {})) as { data?: Hook[] };
  return (data ?? []).filter((h) => h.hookUrl === url);
};

export async function watch(api: Api, key: string, connection: string, config: unknown) {
  if (!process.env.WEBHOOK_URL) throw new AppsError("this server can't receive Wrike's events (WEBHOOK_URL isn't set)");
  const scope = scopeOf(config);
  const id = ["wrike", connection, ...(scope ? [scope] : [])].join(":");
  const url = hookUrl(connection, scope);
  const found = await ours(api, key, url);
  if (found.some((h) => h.status === "Active")) return id;
  // Wrike suspends a webhook whose deliveries keep failing; it can be woken up
  if (found[0]) {
    await call(api, key, send("PUT", "/webhooks/{id}", ["status"]), { id: found[0].id, status: "Active" });
    return id;
  }
  const [kind, target] = scope ? [scope[0], scope.slice(2)] : ["", ""];
  const path = kind === "f" ? "/folders/{target}/webhooks" : kind === "s" ? "/spaces/{target}/webhooks" : "/webhooks";
  const fields = ["hookUrl", "secret", ...(kind === "f" ? ["recursive"] : [])];
  await call(api, key, send("POST", path, fields), { target, hookUrl: url, secret: secret(connection), recursive: true });
  return id;
}

export async function unwatch(api: Api, key: string, id: string) {
  const [, connection = "", scope = ""] = id.split(":");
  for (const h of await ours(api, key, hookUrl(connection, scope))) await call(api, key, send("DELETE", "/webhooks/{id}"), { id: h.id });
}

const header = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? "";
const signed = (body: string, signature: string, connection: string) => {
  const got = Buffer.from(signature);
  const want = Buffer.from(sign(secret(connection), body));
  return got.length === want.length && timingSafeEqual(got, want);
};

// the tasks and folders the events are about, as they are now; one call for each kind (up to 100 ids each)
async function items(api: Api, key: string, list: Raw[]) {
  const fetchAll = async (path: string, ids: string[]) => {
    const unique = [...new Set(ids)].filter((i) => ID.test(i)).slice(0, 100);
    if (!unique.length) return [];
    const got = (await call(api, key, send("GET", path), { ids: unique.join(",") }).catch(() => null)) as { data?: any[] } | null;
    return got?.data ?? [];
  };
  const live = list.filter((e) => !/Deleted$/.test(e.eventType ?? "") || /Comment|Attachment/.test(e.eventType ?? ""));
  const [tasks, folders] = await Promise.all([
    fetchAll("/tasks/{ids}", live.filter((e) => !onFolder(e.eventType ?? "") && e.taskId).map((e) => e.taskId!)),
    fetchAll("/folders/{ids}", live.filter((e) => onFolder(e.eventType ?? "")).map((e) => (e.folderId ?? e.taskId)!).filter(Boolean)),
  ]);
  return new Map([...tasks, ...folders].map((i) => [i.id, i]));
}

export async function receive(api: Api, delivery: Delivery, key: string) {
  if (!signed(delivery.body, header(delivery.headers["x-hook-signature"]), delivery.connection)) return null;
  const body = JSON.parse(delivery.body || "[]") as Raw | Raw[];
  const challenge = header(delivery.headers["x-hook-secret"]);
  if (!Array.isArray(body) && body.requestType) {
    // a random string, never something that makes us sign what someone chose
    if (!/^[A-Za-z0-9]{1,100}$/.test(challenge)) return null;
    return { headers: { "X-Hook-Secret": sign(secret(delivery.connection), challenge) }, events: async () => [] };
  }
  const list = [body].flat();
  return {
    events: async (): Promise<WebhookEvent[]> => {
      const found = await items(api, key, list);
      return list.flatMap((raw) => {
        const { webhookId: _, eventType = "", eventAuthorId, lastUpdatedDate, taskId, folderId, ...changes } = raw;
        const item = found.get((onFolder(eventType) ? (folderId ?? taskId) : taskId) ?? "");
        const names = Object.entries(events).filter(([t, e]) => e === eventType && (t !== "task_completed" || (item ? item.status === "Completed" : changes.status === "Completed"))).map(([t]) => t);
        if (!names.length) return [];
        const what = changes.commentId ?? changes.attachmentId ?? changes.timelogId ?? changes.approvalId ?? changes.customFieldId ?? changes.workItemId ?? taskId ?? folderId;
        // `seen` is shared across apps and webhooks, so the connection and the webhook's scope are in the id; a retry repeats it
        const id = [delivery.connection, delivery.rest, eventType, what, lastUpdatedDate, eventAuthorId].join(":");
        const data: EventData = { eventType, eventAuthorId, lastUpdatedDate, taskId, folderId, ...(item && { item }), changes };
        return [{ id, triggers: names, data }];
      });
    },
  };
}
