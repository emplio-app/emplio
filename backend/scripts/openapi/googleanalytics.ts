// Google Analytics 4: every method of the Analytics Admin API (the setup: accounts, properties, data streams, custom
// dimensions, audiences, links to Ads, Search Console and BigQuery, who has access) and of the Analytics Data API
// (the numbers: reports, pivots, realtime, funnels, audience and report exports), from their Discovery documents.
//
// The Admin API's v1alpha has every method v1beta has and 110 more (audiences, channel groups, calculated metrics,
// subproperties, BigQuery and AdSense links), so v1alpha alone is read. The Data API's v1beta and v1alpha each have
// methods the other hasn't, so both are read and the two that repeat are taken from v1beta, the stable one.
import { GOOGLE_SCOPES } from "../../src/integrations/own/google-login";
import type { AppConfig } from "../openapi-actions";
import { discovery } from "./google-discovery";

const scopes = GOOGLE_SCOPES.googleanalytics;
const DATA = "https://analyticsdata.googleapis.com";

// Google's own ids read resource-first and verb-last (properties.customDimensions.archive), which makes for
// backwards action names. These put the verb in front, drop the "properties"/"accounts" the whole API hangs off,
// and land on Composio's names for the same calls, so a skill written for Composio's Analytics still reads right.
const VERBS = new Set(["list", "get", "create", "patch", "delete", "archive", "approve", "cancel", "update", "reorder", "query", "run", "search", "acknowledge", "provision", "fetch", "set", "check", "submit"]);
const IRREGULAR: Record<string, string> = { properties: "property", summaries: "summary", schemas: "schema", settings: "settings", data: "data" };
const singular = (s: string) => {
  const parts = s.split("_");
  const last = parts.at(-1)!;
  parts[parts.length - 1] = IRREGULAR[last] ?? (last.endsWith("ss") || !last.endsWith("s") ? last : last.slice(0, -1));
  return parts.join("_");
};
// access bindings and the access report live on both accounts and properties, so the account ones say so
const ACCOUNT_LEVEL: Record<string, string> = {
  accounts_run_access_report: "run_account_access_report",
  accounts_access_bindings_list: "list_account_access_bindings",
  accounts_access_bindings_get: "get_account_access_binding",
  accounts_access_bindings_create: "create_account_access_binding",
  accounts_access_bindings_patch: "update_account_access_binding",
  accounts_access_bindings_delete: "delete_account_access_binding",
  accounts_access_bindings_batch_create: "batch_create_account_access_bindings",
  accounts_access_bindings_batch_get: "batch_get_account_access_bindings",
  accounts_access_bindings_batch_update: "batch_update_account_access_bindings",
  accounts_access_bindings_batch_delete: "batch_delete_account_access_bindings",
};
// Google's spelling of these reads oddly once snake_cased, and Composio writes them the short way
const TIDY: [RegExp, string][] = [
  [/_data_streams_/, "_"],
  [/_s_k_ad_network_/, "_sk_ad_network_"],
  [/_ad_sense_/, "_adsense_"],
  [/_big_query_/, "_bigquery_"],
];

const name = (id: string) => {
  if (ACCOUNT_LEVEL[id]) return ACCOUNT_LEVEL[id]!;
  const parts = id.split("_");
  // the last verb, so a resource whose own name holds one (eventCreateRules) isn't mistaken for the call
  const at = parts.findLastIndex((p) => VERBS.has(p));
  if (at < 0) return id;
  const verb = parts[at] === "patch" ? "update" : parts[at]!;
  const batch = parts[at - 1] === "batch" ? "batch_" : "";
  let out: string;
  if (at < parts.length - 1) out = `${batch}${verb}_${parts.slice(at + 1).join("_")}`;
  else {
    const rest = parts.slice(0, batch ? at - 1 : at).filter((p) => p !== "properties" && p !== "accounts");
    const resource = rest.length ? rest.join("_") : parts[0]!;
    out = `${batch}${verb}_${verb === "list" || batch ? resource : singular(resource)}`;
  }
  return TIDY.reduce((n, [from, to]) => n.replace(from, to), out);
};

export default {
  spec: [
    await discovery("https://analyticsadmin.googleapis.com/$discovery/rest?version=v1alpha", "googleanalytics-admin", scopes),
    await discovery("https://analyticsdata.googleapis.com/$discovery/rest?version=v1beta", "googleanalytics-data", scopes),
    // the Data QA chat needs analytics.chatbot.read, a scope this app doesn't ask for
    await discovery("https://analyticsdata.googleapis.com/$discovery/rest?version=v1alpha", "googleanalytics-data-alpha", scopes, ["analyticsdata.properties.chat"]),
  ],
  // only the Admin API lives on the app's own base
  server: (_path, spec) => (spec > 0 ? DATA : undefined),
  out: "src/integrations/own/googleanalytics/actions.json",
  name: (id) => name(id),
  skip: (_method, path) =>
    path === "/v1alpha/properties/{propertiesId}:runReport" || path === "/v1alpha/properties/{propertiesId}/metadata"
      ? "the same call in the Data API's stable v1beta is the action (run_report, get_metadata)"
      : undefined,
  // POSTs that only look things up
  reads: [
    "run_report",
    "run_pivot_report",
    "batch_run_reports",
    "batch_run_pivot_reports",
    "run_realtime_report",
    "run_funnel_report",
    "check_compatibility",
    "run_access_report",
    "run_account_access_report",
    "search_change_history_events",
    "query_audience_export",
    "query_audience_list",
    "query_report_task",
    "batch_get_access_bindings",
    "batch_get_account_access_bindings",
  ],
  // the measurement protocol secret is the key anyone can use to send events into the property
  secrets: ["get_measurement_protocol_secret", "list_measurement_protocol_secrets"],
  params: {
    propertiesId: 'The property\'s number, from googleanalytics.list_properties (the "properties/123456" name, or just 123456)',
    accountsId: 'The account\'s number, from googleanalytics.list_accounts (the "accounts/123456" name, or just 123456)',
    filter: 'Which ones to return, in the API\'s own filter syntax, e.g. "parent:accounts/123456" for one account\'s properties. Required when listing properties',
  },
} satisfies AppConfig;
