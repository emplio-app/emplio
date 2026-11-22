// Productive telling us about events the moment they happen. A Productive webhook carries one event for the whole
// organization, so there's one per connection and event, at /webhooks/app/productive/<connection>/<event id>/<token>;
// filters (one project, one person) are applied here. Webhooks need Productive's Ultimate plan.
import { createHmac, timingSafeEqual } from "node:crypto";
import type { ActionDetail } from "@emplio/shared";
import { AppsError } from "../../types";
import type { Delivery, WebhookEvent } from "../index";
import { call, type Send } from "../openapi";
import { api } from "./client";

// Productive's event ids (developer docs, "Webhook events")
const EVENTS: Record<string, number> = {
  task_created: 1, task_updated: 24, task_deleted: 25,
  invoice_created: 2, invoice_updated: 14, invoice_deleted: 15,
  deal_created: 3, deal_updated: 12, deal_deleted: 13,
  budget_created: 4, budget_updated: 16, budget_deleted: 20,
  project_created: 5, project_updated: 10, project_deleted: 11,
  time_entry_created: 7, time_entry_updated: 8, time_entry_deleted: 9,
  booking_created: 17, booking_updated: 18, booking_deleted: 19,
  expense_created: 21, expense_updated: 22, expense_deleted: 23,
  person_created: 26, person_updated: 27, person_archived: 28,
  company_created: 29, company_updated: 30, company_archived: 31,
  payment_created: 32, payment_updated: 33, payment_deleted: 34,
};
export const events: Record<string, string> = Object.fromEntries(Object.entries(EVENTS).map(([t, id]) => [t, String(id)]));
const byId = Object.fromEntries(Object.entries(EVENTS).map(([t, id]) => [String(id), t]));

const only = (field: string, what: string) => ({ name: field, type: "string", required: false, description: `Only ${what} (its id)` });
const FILTERS: Record<string, ActionDetail["input"]> = {
  task: [only("project_id", "tasks in this project"), only("assignee_id", "tasks assigned to this person"), only("task_list_id", "tasks in this task list")],
  invoice: [only("company_id", "invoices for this client company")],
  deal: [only("company_id", "deals with this client company"), only("project_id", "deals in this project")],
  budget: [only("company_id", "budgets for this client company"), only("project_id", "budgets in this project")],
  project: [only("company_id", "projects for this client company")],
  time_entry: [only("person_id", "time logged by this person"), only("service_id", "time on this service")],
  booking: [only("person_id", "bookings of this person")],
  expense: [only("person_id", "expenses of this person")],
  person: [],
  company: [],
  payment: [only("invoice_id", "payments of this invoice")],
};
const OUTPUT: ActionDetail["input"] = [
  { name: "event", type: "string", required: true, description: "What happened, like task_created" },
  { name: "id", type: "string", required: true, description: "The id of the task, deal, invoice… it's about" },
  { name: "type", type: "string", required: true, description: "Productive's kind of thing: tasks, deals, invoices…" },
  { name: "attributes", type: "object", required: true, description: "All its fields as they are now (title, dates, amounts, status…)" },
  { name: "relationships", type: "object", required: false, description: "Ids of what it's linked to, like project, assignee or company" },
];

const subject = (t: string) => t.replace(/_(created|updated|deleted|archived)$/, "");
const spoken: Record<string, string> = { created: "added", updated: "changed", deleted: "deleted", archived: "archived" };
export const triggers: Record<string, { description: string; config: ActionDetail["input"]; output: ActionDetail["input"] }> = Object.fromEntries(
  Object.keys(EVENTS).map((t) => {
    const what = subject(t).replace(/_/g, " ");
    const how = spoken[t.split("_").pop()!]!;
    const echo = how === "changed" ? ` A run that changes the same ${what} starts this again, so say in the prompt when to stop.` : "";
    return [t, { description: `A ${what} was ${how} in Productive. Needs Productive's Ultimate plan.${echo}`, config: FILTERS[subject(t)]!, output: OUTPUT }];
  }),
);

type Resource = { id: string; type: string; attributes?: Record<string, unknown>; relationships?: Record<string, { data?: { id: string } | { id: string }[] | null }> };
export type EventData = { event: string; id: string; type: string; attributes: Record<string, unknown>; relationships: Record<string, string | string[] | null> };

// {"project": {"data": {"type", "id"}, "meta": …}} → {"project": "12"}; links and meta are clutter
const ids = (rels: Resource["relationships"] = {}) =>
  Object.fromEntries(
    Object.entries(rels)
      .filter(([, r]) => r && "data" in r)
      .map(([k, r]) => [k, Array.isArray(r.data) ? r.data.map((d) => d.id) : (r.data?.id ?? null)]),
  );

export const wanted = (config: unknown, data: unknown) => {
  const d = data as EventData;
  return Object.entries((config ?? {}) as Record<string, unknown>).every(([k, want]) => {
    if (!k.endsWith("_id") || want === undefined || want === "") return true;
    const got = d.attributes?.[k] ?? d.relationships?.[k.slice(0, -3)];
    return [got].flat().some((g) => g != null && String(g) === String(want));
  });
};

// the URL proves which connection and event it's for; Productive's own signature then proves it came from Productive
const hookToken = (connection: string, event: string) => createHmac("sha256", process.env.ENCRYPTION_KEY!).update(`productive-webhook:${connection}:${event}`).digest("hex");
const hookUrl = (connection: string, event: string) => `${process.env.WEBHOOK_URL}/webhooks/app/productive/${connection}/${event}/${hookToken(connection, event)}`;

type Hook = { id: string; attributes: { target_url: string; deactivated_at?: string | null; signature_token?: string } };
const LIST: Send = { method: "GET", path: "/api/v2/webhooks", query: ["filter[event_id]", "page[size]"], headers: [] };
const findHook = async (key: string, event: string, url: string) =>
  ((await call(api, key, LIST, { "filter[event_id]": event, "page[size]": 200 })) as { data: Hook[] }).data.find((h) => h.attributes.target_url === url);
const patch = (path: string): Send => ({ method: "PATCH", path, query: [], headers: [] });

export async function watch(key: string, connection: string, event: string, _config: unknown) {
  if (!process.env.WEBHOOK_URL) throw new AppsError("this server can't receive Productive's events (WEBHOOK_URL isn't set)");
  if (!byId[event]) throw new AppsError(`Productive has no event ${event}`);
  const url = hookUrl(connection, event);
  const id = `productive:${connection}:${event}`;
  const found = await findHook(key, event, url);
  // Productive switches a webhook off after 12 failed deliveries
  if (found?.attributes.deactivated_at) await call(api, key, patch("/api/v2/webhooks/{id}/activate"), { id: found.id });
  if (found) return id;
  const body = { data: { type: "webhooks", attributes: { name: `Emplio: ${byId[event]!.replace(/_/g, " ")}`, event_id: Number(event), target_url: url, type_id: 1 } } };
  await call(api, key, { method: "POST", path: "/api/v2/webhooks", query: [], headers: [], body: { kind: "whole", field: "body" } }, { body });
  return id;
}

export async function unwatch(key: string, id: string) {
  const [, connection = "", event = ""] = id.split(":");
  const found = await findHook(key, event, hookUrl(connection, event));
  if (found) await call(api, key, { method: "DELETE", path: "/api/v2/webhooks/{id}", query: [], headers: [] }, { id: found.id });
}

// each webhook's signing secret, read from Productive once and kept in memory only
const secrets = new Map<string, string>();
const secretFor = async (key: string, event: string, url: string, fresh: boolean) => {
  if (!fresh && secrets.has(url)) return secrets.get(url);
  const token = (await findHook(key, event, url).catch(() => undefined))?.attributes.signature_token;
  if (token) secrets.set(url, token);
  return token;
};
const same = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

export async function receive(delivery: Delivery, key: string) {
  const [event = "", token = ""] = delivery.rest.split("/");
  if (!same(token, hookToken(delivery.connection, event)) || !byId[event]) return null;
  // Productive-Signature: "t=<unix seconds> s=<hex HMAC-SHA256 of '<t>.<body>' with the webhook's secret>"
  const header = String([delivery.headers["productive-signature"]].flat()[0] ?? "");
  const t = header.match(/t=(\d+)/)?.[1];
  const s = header.match(/s=([0-9a-fA-F]+)/)?.[1]?.toLowerCase();
  if (!t || !s) return null;
  const url = hookUrl(delivery.connection, event);
  const sign = (secret: string) => createHmac("sha256", secret).update(`${t}.${delivery.body}`).digest("hex");
  let secret = await secretFor(key, event, url, false);
  // a webhook made again since has a new secret
  if (secret && !same(sign(secret), s)) secret = await secretFor(key, event, url, true);
  if (!secret || !same(sign(secret), s)) return null;

  const payload = JSON.parse(delivery.body || "{}") as { object?: { data?: Resource }; data?: Resource };
  const r = payload.object?.data ?? payload.data;
  if (!r?.id) return { events: async () => [] };
  const name = byId[event]!;
  const data: EventData = { event: name, id: String(r.id), type: r.type, attributes: r.attributes ?? {}, relationships: ids(r.relationships) };
  // no delivery id from Productive: a create or delete happens once; a change is told apart by when it was made
  const when = name.endsWith("_updated") ? `:${String(r.attributes?.updated_at ?? t)}` : "";
  const out: WebhookEvent = { id: `${delivery.connection}:${event}:${r.id}${when}`, triggers: [name], data };
  return { events: async () => [out] };
}
