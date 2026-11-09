// Asana telling us about events the moment they happen. Webhooks are per resource: one per project and connection, at
// /webhooks/app/asana/<connection>/<project>/<token>, and every task event in that project comes down it.
// Trigger names are Composio's.
import { createHmac, timingSafeEqual } from "node:crypto";
import type { ActionDetail } from "@emplio/shared";
import { AppsError } from "../../types";
import type { Delivery, WebhookEvent } from "../index";
import { type Api, call, type Send } from "../openapi";

const PROJECT = { name: "project_gid", type: "string", required: true, description: "The Asana project to watch: the long number in its link (get_multiple_projects lists them)" };
const ASSIGNEE = { name: "assignee_gid", type: "string", required: false, description: "Only tasks assigned to this person (their user gid)" };
const OUTPUT: ActionDetail["input"] = [
  { name: "action", type: "string", required: true, description: "added or changed" },
  { name: "created_at", type: "string", required: true, description: "When it happened" },
  { name: "user", type: "object", required: false, description: "Who did it" },
  { name: "resource", type: "object", required: true, description: "What it's about: the task or the story (a comment, an attachment, a tag)" },
  { name: "parent", type: "object", required: false, description: "What it was added to: the project, the section or the task" },
  { name: "change", type: "object", required: false, description: "On task_updated: the field that changed and its new value" },
  { name: "task", type: "object", required: false, description: "The whole task as it is now; missing if it's already gone" },
  { name: "story", type: "object", required: false, description: "The whole comment or activity entry, with its text, on story events" },
];

const trigger = (description: string, ...config: ActionDetail["input"]) => ({ description, config: [PROJECT, ASSIGNEE, ...config], output: OUTPUT });
export const triggers: Record<string, { description: string; config: ActionDetail["input"]; output: ActionDetail["input"] }> = {
  task_created: trigger("A task was added to the Asana project: a new one, or an existing one moved in."),
  task_updated: trigger("A task in the Asana project changed. A run that edits the task starts this again, so say in the prompt when to stop.", {
    name: "field",
    type: "string",
    required: false,
    description: "Only when this field changes, like due_on, assignee, completed or name",
  }),
  task_moved_to_section: trigger("A task went into a section of the Asana project. New tasks placed straight in a section count too.", {
    name: "section_gid",
    type: "string",
    required: false,
    description: "Only this section (its gid)",
  }),
  task_comment_added: trigger("Someone commented on a task in the Asana project. A run that comments on the same task starts this again, so say in the prompt when not to reply."),
  task_attachment_added: trigger("A file was attached to a task in the Asana project."),
  task_tag_added: trigger("A tag was added to a task in the Asana project."),
};
export const events: Record<string, string> = Object.fromEntries(Object.keys(triggers).map((t) => [t, t]));

type Ref = { gid: string; resource_type: string; resource_subtype?: string; name?: string };
type Raw = { action: string; created_at: string; user?: Ref; resource: Ref; parent?: Ref | null; change?: { field: string } };
export type EventData = Raw & { task?: { assignee?: { gid: string } | null }; story?: unknown };

const STORIES: Record<string, string> = { comment_added: "task_comment_added", attachment_added: "task_attachment_added", added_to_tag: "task_tag_added" };

const triggerFor = (e: Raw) => {
  if (e.resource.resource_type === "story") return e.action === "added" ? STORIES[e.resource.resource_subtype ?? ""] : undefined;
  if (e.resource.resource_type !== "task") return undefined;
  if (e.action === "changed") return "task_updated";
  if (e.action !== "added") return undefined;
  return e.parent?.resource_type === "project" ? "task_created" : e.parent?.resource_type === "section" ? "task_moved_to_section" : undefined;
};

export const wanted = (config: unknown, data: unknown) => {
  const want = (config ?? {}) as { field?: string; section_gid?: string; assignee_gid?: string };
  const d = data as EventData;
  return (!want.field || d.change?.field === want.field) && (!want.section_gid || d.parent?.gid === want.section_gid) && (!want.assignee_gid || d.task?.assignee?.gid === want.assignee_gid);
};

// ponytail: Asana picks the signing secret and we store none, so an unguessable URL proves the sender. Ceiling: a leaked URL can forge events; store the secret from the handshake if that ever matters
const hookToken = (connection: string, project: string) => createHmac("sha256", process.env.ENCRYPTION_KEY!).update(`asana-webhook:${connection}:${project}`).digest("hex");
const hookUrl = (connection: string, project: string) => `${process.env.WEBHOOK_URL}/webhooks/app/asana/${connection}/${project}/${hookToken(connection, project)}`;

const get = (path: string, query: string[] = []): Send => ({ method: "GET", path, query, headers: [] });
type Hook = { gid: string; target: string; active: boolean };
const findHook = async (api: Api, key: string, project: string, url: string) => {
  const { data } = (await call(api, key, get("/projects/{project}", ["opt_fields"]), { project, opt_fields: "workspace" })) as { data: { workspace: { gid: string } } };
  const hooks = (await call(api, key, get("/webhooks", ["workspace", "resource", "limit"]), { workspace: data.workspace.gid, resource: project, limit: 100 })) as { data: Hook[] };
  return hooks.data.find((h) => h.target === url);
};
const remove = (api: Api, key: string, gid: string) => call(api, key, { method: "DELETE", path: "/webhooks/{gid}", query: [], headers: [] }, { gid });

// Make sure this project has our webhook. Asana checks the URL (the handshake in receive) before this answers.
export async function watch(api: Api, key: string, connection: string, config: unknown) {
  if (!process.env.WEBHOOK_URL) throw new AppsError("this server can't receive Asana's events (WEBHOOK_URL isn't set)");
  const project = String((config as { project_gid?: unknown } | null)?.project_gid ?? "");
  if (!/^\d+$/.test(project)) throw new AppsError("project_gid: give the Asana project's id, the long number in its link");
  const url = hookUrl(connection, project);
  const id = `asana:${connection}:${project}`;
  const found = await findHook(api, key, project, url);
  if (found?.active) return id;
  // Asana switches a webhook off when deliveries keep failing, and won't make a second one for the same address
  if (found) await remove(api, key, found.gid);
  await call(api, key, { method: "POST", path: "/webhooks", query: [], headers: [], body: { kind: "fields", fields: [["data", "data"]] } }, { data: { resource: project, target: url } });
  return id;
}

export async function unwatch(api: Api, key: string, id: string) {
  const [, connection = "", project = ""] = id.split(":");
  const found = await findHook(api, key, project, hookUrl(connection, project));
  if (found) await remove(api, key, found.gid);
}

const fetchData = (api: Api, key: string, path: string, gid: string) =>
  (call(api, key, get(path), { gid }) as Promise<{ data: unknown }>).then((r) => r.data).catch(() => undefined);

export async function receive(api: Api, delivery: Delivery, key: string) {
  const [project = "", token = ""] = delivery.rest.split("/");
  const want = Buffer.from(hookToken(delivery.connection, project));
  const got = Buffer.from(token);
  if (got.length !== want.length || !timingSafeEqual(got, want)) return null;
  const secret = delivery.headers["x-hook-secret"];
  if (typeof secret === "string") return { headers: { "X-Hook-Secret": secret }, events: async () => [] };
  const raw = (JSON.parse(delivery.body || "{}") as { events?: Raw[] }).events ?? [];
  return {
    events: async () => {
      const tasks = new Map<string, unknown>();
      const out: WebhookEvent[] = [];
      for (const e of raw) {
        const name = triggerFor(e);
        if (!name) continue;
        const isStory = e.resource.resource_type === "story";
        const gid = isStory ? (e.parent?.gid ?? "") : e.resource.gid;
        if (!tasks.has(gid)) tasks.set(gid, await fetchData(api, key, "/tasks/{gid}", gid));
        const story = isStory ? await fetchData(api, key, "/stories/{gid}", e.resource.gid) : undefined;
        // Asana sends no delivery id. The parent is in it because a new task is added to its project and its section in one go; the connection and project because `seen` is shared
        const id = [delivery.connection, project, e.resource.gid, e.created_at, e.action, e.change?.field, e.parent?.gid].join(":");
        out.push({ id, triggers: [name], data: { ...e, task: tasks.get(gid), ...(story !== undefined && { story }) } });
      }
      return out;
    },
  };
}
