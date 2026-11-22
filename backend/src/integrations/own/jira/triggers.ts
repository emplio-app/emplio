// What Jira can only tell by webhook: something deleted, merged, moved or unreleased (a list can't show what's gone).
// Everything else is polled (polls/jira.ts). Jira lets only a Jira admin's login register a webhook, so these say so.
// One webhook per connection, at /webhooks/app/jira/<connection>/<token>, carrying all the events below; each
// automation's settings pick what it wants. Trigger names are Composio's.
import { createHmac, timingSafeEqual } from "node:crypto";
import type { ActionDetail } from "@emplio/shared";
import { AppsError } from "../../types";
import type { Delivery, WebhookEvent } from "../index";
import { type Api, call, type Send } from "../openapi";

const ADMIN = "Needs a Jira admin's login, since only admins can set up Jira webhooks.";
const PROJECT = { name: "project", type: "string", required: false, description: "Only this project: its key, like SALES, or its id" };
const ISSUE = { name: "issue", type: "object", required: false, description: "The issue: key, fields.summary, project, status" };
const VERSION = { name: "version", type: "object", required: false, description: "The version: id, name, projectId, released, releaseDate" };
const COMMON: ActionDetail["input"] = [
  { name: "webhookEvent", type: "string", required: true, description: "Jira's name for what happened, like jira:issue_deleted" },
  { name: "timestamp", type: "number", required: true, description: "When it happened (milliseconds)" },
  { name: "user", type: "object", required: false, description: "Who did it" },
];

const trigger = (description: string, ...output: ActionDetail["input"]) => ({ description: `${description} ${ADMIN}`, config: [PROJECT], output: [...COMMON, ...output] });
export const triggers: Record<string, { description: string; config: ActionDetail["input"]; output: ActionDetail["input"] }> = {
  issue_deleted: trigger("A Jira issue is deleted.", ISSUE),
  comment_deleted: trigger("A comment on a Jira issue is deleted.", { name: "comment", type: "object", required: true, description: "The comment that was deleted" }, ISSUE),
  version_deleted: trigger("A version (release) of a Jira project is deleted.", VERSION),
  version_merged: trigger("A version of a Jira project is merged into another.", VERSION, { name: "mergedTo", type: "object", required: false, description: "The version it was merged into" }),
  version_moved: trigger("A version of a Jira project is moved to another place in the list.", VERSION),
  version_unreleased: trigger("A released version of a Jira project is marked unreleased again.", VERSION),
};
// our trigger → Jira's event
export const events: Record<string, string> = {
  issue_deleted: "jira:issue_deleted",
  comment_deleted: "comment_deleted",
  version_deleted: "jira:version_deleted",
  version_merged: "jira:version_merged",
  version_moved: "jira:version_moved",
  version_unreleased: "jira:version_unreleased",
};
const byEvent = Object.fromEntries(Object.entries(events).map(([t, e]) => [e, t]));

type Data = { webhookEvent?: string; issue?: { id?: string; key?: string; fields?: { project?: { id?: string; key?: string } } }; version?: { projectId?: number | string } };

export const wanted = (config: unknown, data: unknown) => {
  const want = (config as { project?: string } | null)?.project;
  if (!want) return true;
  const d = data as Data;
  const p = d.issue?.fields?.project;
  return [p?.key, p?.id, d.version?.projectId].some((x) => x !== undefined && String(x).toLowerCase() === want.toLowerCase());
};

// ponytail: the URL's token proves the sender (Jira's own signing secret isn't settable through this API). Ceiling: a leaked URL can forge events
const hookToken = (connection: string) => createHmac("sha256", process.env.ENCRYPTION_KEY!).update(`jira-webhook:${connection}`).digest("hex");
export const hookUrl = (connection: string) => `${process.env.WEBHOOK_URL}/webhooks/app/jira/${connection}/${hookToken(connection)}`;

const PATH = "/rest/webhooks/1.0/webhook";
const send = (method: string, path = PATH, body = false): Send => ({ method, path, query: [], headers: [], ...(body && { body: { kind: "whole", field: "body" } }) });
type Hook = { self: string; url: string };
const findHook = async (api: Api, key: string, url: string) => ((await call(api, key, send("GET"), {})) as Hook[]).find((h) => h.url === url);
const hookId = (h: Hook) => h.self.split("/").pop()!;

const adminOnly = (e: unknown) => {
  if (e instanceof AppsError && /\(403\)$/.test(e.message)) throw new AppsError(`Jira only lets an admin set up this trigger. Connect Jira with a Jira admin's login, or use a polled Jira trigger instead`);
  throw e;
};

export async function watch(api: Api, key: string, connection: string) {
  if (!process.env.WEBHOOK_URL) throw new AppsError("this server can't receive Jira's events (WEBHOOK_URL isn't set)");
  const url = hookUrl(connection);
  const id = `jira:${connection}`;
  try {
    if (await findHook(api, key, url)) return id;
    await call(api, key, send("POST", PATH, true), { body: { name: "Emplio", url, events: Object.values(events), excludeBody: false } });
  } catch (e) {
    adminOnly(e);
  }
  return id;
}

export async function unwatch(api: Api, key: string, id: string) {
  const found = await findHook(api, key, hookUrl(id.split(":")[1] ?? ""));
  if (found) await call(api, key, send("DELETE", `${PATH}/{id}`), { id: hookId(found) });
}

// links and pictures Jira puts on everything, which only make the event longer
const strip = (v: unknown): unknown =>
  Array.isArray(v) ? v.map(strip) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).filter(([k]) => k !== "self" && k !== "avatarUrls" && k !== "iconUrl").map(([k, x]) => [k, strip(x)])) : v;

export async function receive(delivery: Delivery) {
  const want = Buffer.from(hookToken(delivery.connection));
  const got = Buffer.from(delivery.rest);
  if (got.length !== want.length || !timingSafeEqual(got, want)) return null;
  const data = JSON.parse(delivery.body || "{}") as Data;
  const name = byEvent[data.webhookEvent ?? ""];
  const header = delivery.headers["x-atlassian-webhook-identifier"];
  const id = typeof header === "string" ? `${delivery.connection}:${header}` : undefined;
  return { events: async (): Promise<WebhookEvent[]> => (name ? [{ id, triggers: [name], data: strip(data) }] : []) };
}
