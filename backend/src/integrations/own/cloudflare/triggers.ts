// Cloudflare telling us about events the moment they happen, through its Notifications: one webhook destination per
// account and connection, at /webhooks/app/cloudflare/<connection>/<account>, and one notification policy per alert type
// (and filters) pointing at it. Cloudflare sends the secret we gave it in cf-webhook-auth on every delivery.
// Trigger names are Cloudflare's alert types (events.json, from the spec); Composio has no Cloudflare triggers.
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { ActionDetail } from "@emplio/shared";
import { AppsError } from "../../types";
import type { Delivery, WebhookEvent } from "../index";
import { type Api, call, type Send } from "../openapi";
import list from "./events.json";

// alert types for the products COVERAGE.md leaves out (enterprise contracts), which a normal account can't turn on
const ENTERPRISE = /^(brand_protection|logo_match|cloudforce_one|cmd_managed_defense|cni_|magic_|fbm_|secondary_dns|stakeout_|casb_|clickhouse_alert_fw_ent)/;

// what the common ones mean, in plain words; the rest are described from their name
const SAID: Record<string, string> = {
  pages_event_alert: "A Cloudflare Pages deployment starts, succeeds or fails (filters: project_id, environment, event like EVENT_DEPLOYMENT_FAILED)",
  universal_ssl_event_type: "A zone's free (Universal) SSL certificate is issued, renewed, or fails validation",
  dedicated_ssl_certificate_event_type: "An advanced or dedicated SSL certificate is issued, renewed, or fails",
  custom_ssl_certificate_event_type: "A custom SSL certificate is about to expire or has expired",
  health_check_status_notification: "A health check on an origin server goes healthy or unhealthy",
  load_balancing_health_alert: "A load balancer's pool or origin changes health",
  http_alert_origin_error: "Visitors get a burst of 5xx errors from the origin server (Business plan and up)",
  http_alert_edge_error: "Visitors get a burst of 5xx errors from Cloudflare's edge (Business plan and up)",
  dos_attack_l7: "Cloudflare blocks an HTTP DDoS attack on a zone",
  dos_attack_l4: "Cloudflare blocks a network-layer DDoS attack",
  billing_usage_alert: "Usage of a paid product crosses the set limit (filters: product, limit)",
  billing_budget_alert: "Spending crosses a budget",
  expiring_service_token_alert: "An Access service token is about to expire",
  tunnel_health_event: "A Cloudflare Tunnel goes healthy, degraded or down",
  incident_alert: "Cloudflare reports an incident on its own status page",
  maintenance_event_notification: "Cloudflare schedules maintenance in a data centre",
  workers_observability_alert: "A Worker's error rate or other observability alert fires",
  failing_logpush_job_disabled_alert: "A Logpush job keeps failing and is turned off",
  traffic_anomalies_alert: "A zone sees unusual traffic",
  web_analytics_metrics_update: "Weekly Web Analytics summary for a site",
  security_insights_alert: "Security Center finds a new security insight",
  abuse_report_alert: "Someone files an abuse report about a site on the account",
};

export const events: Record<string, string> = Object.fromEntries(list.alert_types.filter((t) => !ENTERPRISE.test(t)).map((t) => [t, t]));

const ACCOUNT = { name: "account_id", type: "string", required: true, description: "The Cloudflare account to watch (cloudflare.list_accounts lists them)" };
const FILTERS = {
  name: "filters",
  type: "object",
  required: false,
  description: 'Cloudflare\'s own filters for this alert, applied before it is sent: lists of values, like {"zones": ["<zone id>"]} or for Pages {"project_id": ["<id>"], "event": ["EVENT_DEPLOYMENT_FAILED"]}. Some alert types require some (see cloudflare.get_alert_types)',
};
const OUTPUT: ActionDetail["input"] = [
  { name: "alert_type", type: "string", required: true, description: "Cloudflare's alert type, the trigger's name" },
  { name: "text", type: "string", required: true, description: "Cloudflare's plain-words description of what happened" },
  { name: "data", type: "object", required: false, description: "The alert's details; what's in it depends on the alert type (zone, project, deployment, certificate…)" },
  { name: "alert_event", type: "string", required: false, description: "ALERT_STATE_EVENT_START or ALERT_STATE_EVENT_END, on alerts that start and end" },
  { name: "ts", type: "number", required: false, description: "When it happened, in Unix seconds" },
  { name: "account_id", type: "string", required: false, description: "The account it's about" },
];
const spoken = (t: string) => `Cloudflare alert: ${t.replace(/_/g, " ")}`;
export const triggers: Record<string, { description: string; config: ActionDetail["input"]; output: ActionDetail["input"] }> = Object.fromEntries(
  Object.keys(events).map((t) => [t, { description: `${SAID[t] ?? spoken(t)}. Only alerts the account's plan offers can be turned on.`, config: [ACCOUNT, FILTERS], output: OUTPUT }]),
);

// the secret Cloudflare sends back in cf-webhook-auth: worked out, never stored
const hookSecret = (connection: string, account: string) => createHmac("sha256", process.env.ENCRYPTION_KEY!).update(`cloudflare-webhook:${connection}:${account}`).digest("hex");
const hookUrl = (connection: string, account: string) => `${process.env.WEBHOOK_URL}/webhooks/app/cloudflare/${connection}/${account}`;
// one policy per alert type and filters; its name tells an automation its own alerts from another's
const policyName = (type: string, filters: unknown) =>
  `Emplio: ${type}${filters && Object.keys(filters).length ? ` ${createHash("sha256").update(JSON.stringify(filters)).digest("hex").slice(0, 8)}` : ""}`;

const send = (method: string, path: string, fields: string[] = []): Send => ({ method, path, query: [], headers: [], ...(fields.length && { body: { kind: "fields", fields: fields.map((f): [string, string] => [f, f]) } }) });
type Dest = { id: string; url: string };
type Policy = { id: string; name: string; alert_type: string; mechanisms?: { webhooks?: { id: string }[] } };
const results = async <T>(api: Api, key: string, path: string, account: string) => ((await call(api, key, send("GET", path), { account })) as { result?: T[] }).result ?? [];
const findDest = async (api: Api, key: string, account: string, url: string) =>
  (await results<Dest>(api, key, "/accounts/{account}/alerting/v3/destinations/webhooks", account)).find((d) => d.url === url);

const config = (c: unknown) => {
  const { account_id, filters } = (c ?? {}) as { account_id?: unknown; filters?: unknown };
  const account = String(account_id ?? "");
  if (!/^[0-9a-f]{32}$/.test(account)) throw new AppsError("account_id: give the Cloudflare account's id (32 letters and digits, from cloudflare.list_accounts)");
  if (filters !== undefined && (typeof filters !== "object" || filters === null || Array.isArray(filters))) throw new AppsError('filters: give an object of lists, like {"zones": ["<zone id>"]}');
  return { account, filters: filters as Record<string, string[]> | undefined };
};

// Make sure this account's webhook destination exists and a policy sends `type` (with these filters) to it.
export async function watch(api: Api, key: string, connection: string, type: string, raw: unknown) {
  if (!process.env.WEBHOOK_URL) throw new AppsError("this server can't receive Cloudflare's alerts (WEBHOOK_URL isn't set)");
  const { account, filters } = config(raw);
  const url = hookUrl(connection, account);
  const dest =
    (await findDest(api, key, account, url))?.id ??
    ((await call(api, key, send("POST", "/accounts/{account}/alerting/v3/destinations/webhooks", ["name", "url", "secret"]), { account, name: "Emplio", url, secret: hookSecret(connection, account) })) as { result: { id: string } }).result.id;
  const name = policyName(type, filters);
  const policy = (await results<Policy>(api, key, "/accounts/{account}/alerting/v3/policies", account)).find((p) => p.name === name);
  if (!policy)
    await call(api, key, send("POST", "/accounts/{account}/alerting/v3/policies", ["name", "alert_type", "enabled", "mechanisms", "filters", "description"]), {
      account, name, alert_type: type, enabled: true, mechanisms: { webhooks: [{ id: dest }] }, filters: filters ?? {}, description: "Sends this alert to Emplio, to start its automations",
    });
  else if (!policy.mechanisms?.webhooks?.some((w) => w.id === dest))
    await call(api, key, send("PUT", "/accounts/{account}/alerting/v3/policies/{id}", ["mechanisms", "enabled"]), {
      account, id: policy.id, enabled: true, mechanisms: { ...policy.mechanisms, webhooks: [...(policy.mechanisms?.webhooks ?? []), { id: dest }] },
    });
  return `cloudflare:${connection}:${account}`;
}

// The last automation on this account is gone: take away our policies and the destination.
export async function unwatch(api: Api, key: string, id: string) {
  const [, connection = "", account = ""] = id.split(":");
  const dest = await findDest(api, key, account, hookUrl(connection, account));
  if (!dest) return;
  for (const p of await results<Policy>(api, key, "/accounts/{account}/alerting/v3/policies", account))
    if (p.name.startsWith("Emplio: ") && p.mechanisms?.webhooks?.some((w) => w.id === dest.id)) await call(api, key, send("DELETE", "/accounts/{account}/alerting/v3/policies/{id}"), { account, id: p.id });
  await call(api, key, send("DELETE", "/accounts/{account}/alerting/v3/destinations/webhooks/{id}"), { account, id: dest.id });
}

type Payload = { alert_type?: string; policy_id?: string; policy_name?: string; alert_correlation_id?: string; alert_event?: string; ts?: number; data?: unknown; text?: string };

// an automation takes only the alerts of its own policy (same alert type and filters)
export const wanted = (raw: unknown, data: unknown) => {
  const { filters } = (raw ?? {}) as { filters?: unknown };
  const d = data as Payload;
  return !d.alert_type || d.policy_name === undefined || d.policy_name === policyName(d.alert_type, filters);
};

export async function receive(delivery: Delivery) {
  const account = delivery.rest.split("/")[0] ?? "";
  const want = Buffer.from(hookSecret(delivery.connection, account));
  const got = Buffer.from(String(delivery.headers["cf-webhook-auth"] ?? ""));
  if (got.length !== want.length || !timingSafeEqual(got, want)) return null;
  const payload = JSON.parse(delivery.body || "{}") as Payload;
  const type = String(payload.alert_type ?? "");
  // Cloudflare's test message ({"text": "Hello World!..."}) has no alert type, so starts nothing
  const id = payload.policy_id ? `${delivery.connection}:${payload.policy_id}:${payload.alert_correlation_id ?? ""}:${payload.alert_event ?? ""}:${payload.ts ?? ""}` : undefined;
  const out: WebhookEvent = { ...(id && { id }), triggers: events[type] ? [type] : [], data: payload };
  return { events: async () => [out] };
}
