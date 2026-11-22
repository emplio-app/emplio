// Cal.com: what the generator (../openapi-actions.ts) can't tell from the spec. One spec, API v2, every path under
// /v2. Each call wants its own cal-api-version header; it's taken out of the inputs and kept on the action as
// `version`, which own/calcom/index.ts sends.
import type { AppConfig } from "../openapi-actions";
import { composioNames, namer } from "./composio-names";

const SPEC = "https://cal.com/docs/api-reference/v2/openapi.json";
const OUT = "src/integrations/own/calcom/actions.json";
type Schema = Record<string, any>;

const SKIP: Record<string, string> = {
  "POST /v2/api-keys/refresh": "replaces the API key Emplio signs in with, which would lock Emplio out",
  "GET /v2/calendars/{calendar}/save": "where the calendar's own sign-in page sends the browser back; not a call a person makes",
  "GET /v2/conferencing/{app}/oauth/callback": "where the video app's sign-in page sends the browser back; not a call a person makes",
  "GET /v2/stripe/save": "where Stripe's sign-in page sends the browser back; not a call a person makes",
  "POST /v2/notifications/subscriptions/app-push": "registers a phone for Cal.com's own mobile app",
  "DELETE /v2/notifications/subscriptions/app-push": "unregisters a phone from Cal.com's own mobile app",
};
const skip = (method: string, path: string) => {
  const call = `${method} ${path}`;
  if (SKIP[call]) return SKIP[call];
  if (/^\/v2\/(oauth-clients|oauth\/)/.test(path)) return "Platform (OAuth client) calls: need the client's secret, not an API key; Cal.com marks them deprecated";
  if (path.startsWith("/v2/auth/oauth2/")) return "OAuth sign-in for Cal.com apps; Emplio connects with an API key";
  if (/\/(oauth\/callback|stripe\/save)$/.test(path)) return "where a sign-in page sends the browser back; not a call a person makes";
};

// The same summary is used for the organization's, a team's and the person's own call ("Get all webhooks"). The first
// one keeps it; the rest would fall back to the operation id (webhooks_controller_get_webhooks), so they say whose instead.
const used = new Set<string>();
const tidy = (id: string, name: string, path: string, op: Schema) => {
  const whose = [path.startsWith("/v2/organizations/") && "organization", /\/teams\/\{teamId\}/.test(path) && "team", path.includes("/event-types/{eventTypeId}/") && "event_type"].filter(Boolean).join("_");
  const [verb, ...rest] = String(op.summary ?? name).toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").split("_").filter((w) => !["a", "an", "the", "all", "s"].includes(w));
  const say = (who: string) => [verb, ...who.split("_"), ...rest.filter((w) => !who.split("_").includes(w))].filter(Boolean).join("_");
  const options = /controller/.test(name) ? [say(whose), say(`my_${whose}`), id] : [name, say(`my_${whose}`), id];
  const pick = options.find((n) => !used.has(n))!;
  used.add(pick);
  return pick;
};
// the cal-api-version each call wants, by "METHOD /path"
const versions: Record<string, string> = {};
const base = namer(await composioNames("cal"));

export default {
  spec: SPEC,
  out: OUT,
  name: (id, method, path, op: Schema) => {
    const v = (op.parameters ?? []).find((p: Schema) => p.in === "header" && p.name === "cal-api-version");
    const version = v?.schema?.default ?? v?.schema?.example ?? /\d{4}-\d\d-\d\d/.exec(v?.description ?? "")?.[0];
    if (version) versions[`${method} ${path}`] = String(version);
    return tidy(id, base(id, method, path, op), path, op);
  },
  skip,
  // the organization's webhooks come first in the spec and would take the plain names
  rename: { get_webhooks: "get_organization_webhooks", create_webhook: "create_organization_webhook", get_webhook: "get_organization_webhook", delete_webhook: "delete_organization_webhook", update_webhook: "update_organization_webhook" },
  // the key goes in Authorization; platform OAuth-client headers aren't for API keys; the version is sent per action
  drop: { "*": ["Authorization", "x-cal-secret-key", "x-cal-client-id", "cal-api-version"] },
  // POSTs that only work out numbers or open times
  reads: ["get_booking_limits_usage","get_booking_kpi_stats","get_booking_event_trends","get_average_booking_duration","get_booking_member_stats","get_routing_forms_by_status","get_my_routing_form_responses","get_routing_form_field_options","get_routing_form_response_headers","get_failed_bookings_by_routing_field","get_routed_to_users_per_period","calculate_slots_based_on_routing_form_response"],
  // webhooks answer with their signing secret, delegation credentials with a service account's key
  secrets: ["get_delegation_credentials_of_organization","get_delegation_credential_of_organization","get_organization_webhooks", "get_organization_webhook","get_event_type_webhooks","get_event_type_webhook","get_team_event_type_webhooks","get_team_event_type_webhook","get_my_webhooks","get_my_webhook"],
  after: async () => {
    const file = new URL(`../../${OUT}`, import.meta.url).pathname;
    const out = await Bun.file(file).json();
    for (const a of out.actions) {
      const version = versions[`${a.send.method} ${a.send.path}`];
      if (version) a.version = version;
    }
    await Bun.write(file, JSON.stringify(out));
  },
} satisfies AppConfig;
