// Cloudflare: what the generator (../openapi-actions.ts) can't tell from the spec.
import type { AppConfig } from "../openapi-actions";
import { composioNames, namer } from "./composio-names";

// Areas a normal account's API token can't call: enterprise contracts, partner/reseller programs, Cloudflare's
// own internal endpoints, and calls that take a short-lived upload token instead of the account's. Grouped, for COVERAGE.md.
const SKIP: [RegExp, string][] = [
  [/^\/accounts\/\{[^}]+\}\/cloudforce-one\//, "Cloudforce One threat intelligence: enterprise subscription only"],
  [/^\/accounts\/\{[^}]+\}\/(magic|cni|mnm)\//, "Magic WAN / Transit / Network Monitoring and Network Interconnect: enterprise contract only"],
  [/^\/accounts\/\{[^}]+\}\/email-security\//, "Email Security (Area 1): enterprise contract only"],
  [/^\/accounts\/\{[^}]+\}\/brand-protection\//, "Brand Protection: enterprise contract only"],
  [/^\/(accounts|zones)\/\{[^}]+\}\/addressing\//, "BYOIP, address maps and regional services: enterprise only"],
  [/^\/accounts\/\{[^}]+\}\/dls\//, "Data Localization Suite: enterprise only"],
  [/^\/(accounts|zones)\/\{[^}]+\}\/secondary_dns\//, "Secondary DNS: enterprise only"],
  [/^\/accounts\/\{[^}]+\}\/dns_firewall(\/|$)/, "DNS Firewall: enterprise only"],
  [/^\/(accounts|zones|tenants)\/\{[^}]+\}\/custom_ns(\/|$)/, "Account custom nameservers: enterprise / partner only"],
  [/^\/zones\/\{[^}]+\}\/keyless_certificates(\/|$)/, "Keyless SSL: enterprise only"],
  [/^\/(accounts|zones)\/\{[^}]+\}\/intel\/(indicator-feeds|sinkholes)(\/|$)/, "Custom indicator feeds and sinkholes: enterprise threat intel only"],
  [/^\/accounts\/\{[^}]+\}\/data-security\//, "Data security posture (CASB findings): enterprise Zero Trust add-on"],
  [/^\/accounts\/\{[^}]+\}\/cws\//, "Cloudflare Workload Security: private enterprise beta"],
  [/^\/(tenants|user\/tenants)(\/|$)/, "Tenants: Cloudflare partner (reseller) program only"],
  [/^\/organizations(\/|$)|^\/accounts\/\{[^}]+\}\/(organizations|shares)(\/|$)/, "Organizations and cross-account resource sharing: enterprise organizations only"],
  [/^\/accounts\/\{[^}]+\}\/(registrar-sandbox)\//, "Registrar sandbox: registrar partner testing only"],
  [/^\/accounts\/\{[^}]+\}\/k2\/|^\/subscriptions(\/|$)/, "Internal Workers platform (K2) endpoints, not public"],
  [/^\/(internal|produce|live|ready)(\/|$)/, "Cloudflare-internal service endpoints"],
  [/^\/v1\/verify$|^\/v2\//, "Domain Connect: for DNS providers' templates, not account owners"],
  [/^\/pages\/assets\/|^\/accounts\/\{[^}]+\}\/workers\/assets\/upload$/, "Takes the short-lived upload JWT a deployment session hands out, not the account token (Wrangler's direct upload)"],
  [/\/scim\//, "SCIM: an identity provider pushes users here; not something a person calls"],
];

const SPEC = "https://raw.githubusercontent.com/cloudflare/api-schemas/main/openapi.json";

// Composio's name where it has the same call; else the summary ("List DNS Records" → list_dns_records), unless
// several operations share that summary ("Create app" is in four products): then Cloudflare's own SDK name
// (dns.records + edit → dns_records_edit), which is unique.
const composio = await composioNames("cloudflare");
const fromComposio = namer(composio);
const spec = await (/^https?:/.test(process.argv[3] ?? SPEC) ? fetch(process.argv[3] ?? SPEC).then((r) => r.json()) : Bun.file(process.argv[3]!).json());
const summaries = new Map<string, number>();
for (const ops of Object.values<any>(spec.paths)) for (const op of Object.values<any>(ops)) if (op?.operationId) summaries.set(op.summary, (summaries.get(op.summary) ?? 0) + 1);
const taken = new Set<string>();
const name: AppConfig["name"] = (id, method, path, op) => {
  const n = fromComposio(id, method, path, op);
  const sdk = `${op["x-fern-sdk-group-name"] ?? ""}_${op["x-fern-sdk-method-name"] ?? ""}`.replace(/[^a-zA-Z0-9]+/g, "_").replace(/^_|_$/g, "").toLowerCase();
  const pick = !taken.has(n) && (composio.includes(n) || (n !== id && summaries.get(op.summary) === 1)) ? n : sdk && !taken.has(sdk) ? sdk : id;
  taken.add(pick);
  return pick.replace(/_s(?=_|$)/g, ""); // "Get key's value" → get_key_value
};

const OUT = "src/integrations/own/cloudflare/actions.json";

// Access apps, identity providers and DNS records are unions of a dozen object shapes that mostly repeat each other
// (2.5 MB for two actions). One object with every field, required only where all shapes need it, says the same in a
// tenth of the space; Cloudflare checks the exact shape.
const merge = (s: any): any => {
  if (Array.isArray(s)) return s.map(merge);
  if (!s || typeof s !== "object") return s;
  const out: any = Object.fromEntries(Object.entries(s).map(([k, v]) => [k, merge(v)]));
  const alts: any[] | undefined = out.anyOf;
  if (alts && alts.length > 2 && alts.every((a) => a.type === "object" && a.properties)) {
    const properties: Record<string, any> = {};
    for (const a of alts) for (const [k, v] of Object.entries(a.properties)) {
      const had = properties[k];
      if (!had) properties[k] = v;
      else if (had.enum && (v as any).enum) had.enum = [...new Set([...had.enum, ...(v as any).enum])];
    }
    const required = alts.map((a) => a.required ?? []).reduce((x: string[], y: string[]) => x.filter((k) => y.includes(k)));
    delete out.anyOf;
    Object.assign(out, { type: "object", properties }, required.length ? { required } : {});
    out.description = `${out.description ? `${out.description} ` : ""}One of ${alts.length} kinds; the fields that apply depend on the kind.`;
  }
  return out;
};

export default {
  spec: SPEC,
  out: OUT,
  name,
  skip: (_method, path) => SKIP.find(([re]) => re.test(path))?.[1],
  // Composio's names for the same calls, where the summary came out different
  rename: {
    get_key_value: "get_kv_value",
    write_key_value_pair_with_optional_metadata: "write_kv_value",
    get_multiple_key_value_pairs: "bulk_read_kv_values",
    write_multiple_key_value_pairs: "bulk_write_workers_kv_entries",
    list_keys_in_namespace: "list_kv_keys",
    get_html_content_and_screenshot: "capture_browser_snapshot",
    scrape_elements: "scrape_page_elements",
    registrar_registrations_check: "check_registrar_domains",
    accounts_tokens_create: "create_account_api_token",
    accounts_tokens_delete: "delete_account_api_token",
    user_tokens_create: "create_user_api_token",
    user_tokens_delete: "delete_user_api_token",
    user_tokens_get: "get_user_api_token",
    user_tokens_list: "list_user_api_tokens",
    create_notification_policy: "create_alert_policy",
    create_destination_address: "create_email_routing_address",
    list_destination_addresses: "list_email_routing_addresses",
    create_cloudflare_pages_project: "create_pages_project",
    list_cloudflare_pages_projects: "list_pages_projects",
    get_cloudflare_pages_project: "get_pages_project",
    update_cloudflare_pages_project: "update_pages_project",
    list_pages_custom_domains: "list_pages_project_domains",
    get_upload_token: "get_pages_upload_token",
    roll_back_pages_deployment: "rollback_pages_deployment",
    create_bucket: "create_r2_bucket",
    list_buckets: "list_r2_buckets",
    get_bucket: "get_r2_bucket",
    get_bucket_lock_rules: "get_r2_bucket_lock",
    get_r2_dev_domain_of_bucket: "get_r2_managed_domain",
    get_object: "get_r2_object",
    list_objects: "list_r2_objects",
    upload_object: "upload_r2_object",
    create_build_trigger: "create_worker_build_trigger",
    list_triggers_for_worker: "list_worker_build_triggers",
    update_build_trigger: "update_worker_build_trigger",
    builds_tokens_list: "list_workers_build_tokens",
    get_build_minute_availability: "get_account_build_limits",
    delete_worker: "delete_worker_script",
    workers_delete: "delete_worker",
    upload_worker: "deploy_worker_script",
    list_versions: "list_worker_script_versions",
    upload_version: "upload_worker_script_version",
    list_secrets_bound_to_worker_script: "list_worker_secrets",
    add_secret_to_worker_script: "upsert_worker_secret",
    patch_worker_script_settings: "update_worker_script_settings",
    update_worker_script_schedules_cron_triggers: "manage_worker_schedules",
    create_worker_assets_upload_session: "start_worker_asset_upload_session",
    get_worker_environment_script_content: "get_worker_service_environment_content",
    list_values: "list_worker_telemetry_values",
    run_query: "query_worker_telemetry",
    account_details: "get_account",
    member_details: "get_account_member",
    list_members: "list_account_members",
    list_subscriptions: "list_account_subscriptions",
    user_details: "get_current_user",
    get_zone_bot_management_config: "get_bot_management_settings",
    zone_details: "get_zone",
    get_zone_entry_point_ruleset: "get_zone_ruleset_phase_entrypoint",
    update_zone_entry_point_ruleset: "update_zone_ruleset_phase_entrypoint",
    rerun_activation_check: "rerun_zone_activation_check",
    get_workflow_details: "get_workflow",
    get_logs_and_status_from_instance: "get_workflow_instance",
    get_ai_model_input_and_output_schemas: "get_workers_ai_model_schema",
    list_web_analytics_sites: "list_rum_sites",
    get_list_items: "list_rule_list_entries",
    update_list_items: "replace_list_items",
    query_d1_database: "execute_d1_query",
    read_details_of_mcp_server: "get_mcp_server",
    get_preview_deployment: "get_worker_preview_deployment",
    patch_latest_preview_deployment: "update_worker_preview_deployment",
  },
  // POSTs that only look things up
  reads: [
    "validate_custom_page_template", "check_top_up_status", "get_top_up_eligibility", "check_stored_provider_credentials",
    "ai_search_search", "multi_instance_search", "ai_search", "autorag_search",
    "query_analytics_summary", "query_analytics_timeseries", "query_analytics_top_n", "analytics_sql_accounts_post", "sql_query",
    "query_account_usage_version_2_alpha_restricted", "search_browser_extension_event_logs", "query_browser_extension_event_timeseries",
    "get_accessibility_tree_page", "get_html_content", "get_json", "get_links", "get_markdown", "get_pdf", "scrape_page_elements",
    "get_screenshot", "capture_browser_snapshot", "validate_dlp_regex_pattern", "preview_transformer", "validate_sql",
    "check_registrar_domains", "check_domain_transfer_eligibility", "bulk_read_kv_values", "get_vectors_by_identifier", "query_vectors",
    "list_keys", "query_worker_telemetry", "list_worker_telemetry_values", "validate_billing_address", "get_dataset_download_url",
    "preview_sending_subdomain_dns", "analyze_certificate", "preview_token_validation_rule",
  ],
  // GETs that hand back a credential: a tunnel's or connector's run token, an upload JWT, a Turnstile secret, signing keys
  secrets: [
    "get_cloudflare_tunnel_token", "get_mesh_node_token", "get_pages_upload_token", "turnstile_widget_details", "list_signing_keys",
    "create_workflow_instance_event_subscription_token",
  ],
  params: {
    account_id: "The Cloudflare account's id (32 hex characters): cloudflare.list_accounts lists them",
    zone_id: "The zone's (domain's) id (32 hex characters): cloudflare.list_zones lists them, with name=<domain> to find one",
  },
  after: async (spec) => {
    // every alert type Cloudflare can send a webhook for, for triggers.ts
    const types = spec.components.schemas.aaa_alert_type.enum;
    await Bun.write(new URL("../../src/integrations/own/cloudflare/events.json", import.meta.url).pathname, JSON.stringify({ alert_types: types }));
    const file = new URL(`../../${OUT}`, import.meta.url).pathname;
    const out = await Bun.file(file).json();
    out.actions = out.actions.map((a: any) => ({ ...a, input: merge(a.input) }));
    await Bun.write(file, JSON.stringify(out));
  },
} satisfies AppConfig;
