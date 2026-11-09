// HubSpot: what the generator (../openapi-actions.ts) can't tell from its specs. HubSpot publishes one OpenAPI file per
// area (a catalog of 127), so this picks a version of each, tidies them, and hands the generator local copies.
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AppConfig } from "../openapi-actions";

type Schema = Record<string, any>;
type Version = { version: string; stage: string; openApi: string };
type Entry = { name: string; group: string; versions: Version[] };

// the numbered version when there is one (it's what HubSpot keeps stable); else its current dated one
const pick = (e: Entry) =>
  (e.name === "Meetings" && e.group === "Scheduler" ? undefined : e.versions.filter((v) => /^\d+$/.test(v.version)).sort((a, b) => Number(b.version) - Number(a.version))[0]) ??
  e.versions.find((v) => v.stage === "LATEST");

const DEV_ONLY = "needs an app developer's key, a private app token can't call it";
const SKIP_SPECS: Record<string, string> = {
  Oauth: "HubSpot's OAuth token exchange; a pasted token doesn't use it",
  "At Debug": "HubSpot's own API test endpoints",
  "At Tests": "HubSpot's own API test endpoints",
  "Public App Feature Flags V3": DEV_ONLY,
  "Public App Crm Cards": DEV_ONLY,
  "App Uninstalls": DEV_ONLY,
  "Video Conferencing Extension": DEV_ONLY,
  "Calling Extensions": "only for apps that plug a phone system into HubSpot",
  Transcriptions: "only for apps that plug a phone system into HubSpot",
  Webhooks: DEV_ONLY,
  "Webhooks Journal": "a developer app's event journal, not reachable with a private app token",
  "Media Bridge": DEV_ONLY,
  "Custom Channels": DEV_ONLY,
  "Actions V4": "custom workflow actions belong to a developer app",
  Timeline: "deprecated, and its templates need an app developer's key",
};

const VERBS = new Set(["get", "post", "put", "patch", "delete"]);
const words = (s: string) => s.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase().replace(/\b(a|an|the|all|your)\b/g, " ").replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
const IGNORED = /^(v\d+|\d{4}-\d{2}(-beta)?|crm|cms)$/;
const pathName = (method: string, path: string) =>
  `${method.toLowerCase()}_${words(path.split("/").filter((s) => s && !IGNORED.test(s)).map((s) => s.replace(/[{}]/g, "")).join(" "))}`;

// HubSpot's CRM objects all have the same calls, so their names come from the path, the way Composio named them
const OBJECT = /^\/crm(?:\/v3\/objects|\/objects\/(?:v3|\d{4}-\d{2}(?:-beta)?))\/([^/]+)(\/.*)?$/;
const TYPES: Record<string, [string, string]> = {
  "0-3": ["deal", "deals"],
  "0-410": ["course", "courses"],
  "0-420": ["listing", "listings"],
  "0-162": ["service", "services"],
  companies: ["company", "companies"],
  taxes: ["tax", "taxes"],
  postal_mail: ["postal_mail", "postal_mail"],
  "{objectType}": ["crm_object", "crm_objects"],
};
function objectName(method: string, path: string) {
  const m = path.match(OBJECT);
  if (!m) return;
  const [s, p] = TYPES[m[1]!] ?? [m[1]!.replace(/s$/, ""), m[1]!];
  const tail = (m[2] ?? "").replace(/^\/\{\w+\}$/, "/{id}");
  const name = {
    "GET ": `list_${p}`,
    "POST ": `create_${s}`,
    "GET /{id}": `read_${s}`,
    "PATCH /{id}": `update_${s}`,
    "DELETE /{id}": `archive_${s}`,
    "POST /batch/archive": `archive_${p}`,
    "POST /batch/create": `create_${p}`,
    "POST /batch/read": `read_${p}`,
    "POST /batch/update": `update_${p}`,
    "POST /batch/upsert": `upsert_${p}`,
    "POST /search": `search_${p}`,
    "POST /merge": `merge_${p}`,
    "POST /gdpr-delete": `delete_${s}_gdpr`,
  }[`${method} ${tail}`];
  return name;
}
// where Composio called the same CRM call something else
const COMPOSIO: Record<string, string> = {
  read_company: "get_company", read_deal: "get_deal", read_ticket: "get_ticket", read_product: "get_product", read_quote: "get_quote",
  archive_deal: "remove_deal", read_deals: "get_deals", read_tickets: "get_tickets", read_products: "get_products", read_emails: "get_emails",
  read_line_item: "retrieve_line_item_by_id", list_line_items: "retrieve_line_items", read_companies: "batch_read_companies_by_properties",
  read_feedback_submission: "read_feedback_submission_by_id", read_feedback_submissions: "read_batch_feedback_submissions_by_id_or_property",
  archive_feedback_submissions: "archive_batch_of_feedback_submissions", create_feedback_submissions: "create_batch_of_feedback_submissions",
  update_feedback_submissions: "update_batch_feedback_submissions", archive_line_items: "archive_batch_of_line_items",
  read_line_items: "read_batch_of_line_items_by_id_or_property_values", search_line_items: "search_line_items_by_criteria",
  archive_quotes: "archive_batch_of_quotes", create_quotes: "create_batch_of_quotes", update_quotes: "batch_update_quotes",
  read_quotes: "read_batch_of_quotes_by_property_values", search_quotes: "search_quotes_by_criteria", create_quote: "create_quote_object",
  search_contacts: "search_contacts_by_criteria",
  archive_note: "delete_note", archive_task: "delete_task", archive_meeting: "delete_meeting", archive_call: "delete_call",
  list_crm_objects: "read_apage_of_objects_by_type", create_crm_object: "create_crm_object_with_properties", read_crm_object: "read_crm_object_by_id",
  update_crm_object: "partially_update_crm_object_by_id", archive_crm_object: "archive_crm_object_by_id", archive_crm_objects: "archive_batch_of_objects",
  create_crm_objects: "create_batch_of_objects", read_crm_objects: "read_batch_of_crm_objects_by_id_or_property_values",
  update_crm_objects: "update_batch_of_objects_by_idor_property_values", search_crm_objects: "search_crm_objects_by_criteria", merge_crm_objects: "merge_objects",
};

// Composio's name for the other calls, by call. Also shortens a few that HubSpot's summaries made unreadable.
const CALLS: Record<string, string> = {
  "POST /marketing/v3/emails/ab-test/create-variation": "create_ab_test_variation",
  "GET /marketing/v3/emails/{emailId}/ab-test/get-variation": "get_ab_email_variation",
  "POST /marketing/v3/emails": "create_a_new_marketing_email",
  "GET /marketing/v3/emails": "get_all_marketing_emails_for_a_hubspot_account",
  "GET /marketing/v3/emails/{emailId}": "get_the_details_of_a_specified_marketing_email",
  "GET /marketing/v3/emails/{emailId}/draft": "get_marketing_email_draft",
  "PATCH /marketing/v3/emails/{emailId}": "update_a_marketing_email",
  "POST /marketing/v3/emails/{emailId}/publish": "publish_marketing_email",
  "POST /marketing/v3/emails/{emailId}/draft/reset": "reset_draft",
  "GET /marketing/v3/emails/{emailId}/revisions/{revisionId}": "get_marketing_email_revision",
  "GET /marketing/v3/emails/{emailId}/revisions": "get_marketing_email_revisions",
  "POST /marketing/v3/emails/{emailId}/revisions/{revisionId}/restore": "restore_marketing_email_revision",
  "POST /marketing/v3/emails/{emailId}/revisions/{revisionId}/restore-to-draft": "restore_email_revision",
  "POST /crm/v3/imports": "start_import",
  "GET /crm/v3/imports": "get_active_imports_list",
  "GET /crm/v3/imports/{importId}": "get_import_record_information",
  "POST /crm/v3/imports/{importId}/cancel": "cancel_import",
  "GET /crm/v3/imports/{importId}/errors": "fetch_import_error_details",
  "POST /crm/v3/properties/{objectType}/groups": "create_and_return_a_new_property_group",
  "GET /crm/v3/properties/{objectType}/groups": "read_property_groups_for_object_type",
  "GET /crm/v3/properties/{objectType}": "read_all_properties_for_object_type",
  "GET /crm/v3/properties/{objectType}/{propertyName}": "read_a_crm_property_by_name",
  "POST /crm/v3/properties/{objectType}": "create_property_for_specified_object_type",
  "PATCH /crm/v3/properties/{objectType}/{propertyName}": "update_crm_property",
  "DELETE /crm/v3/properties/{objectType}/{propertyName}": "archive_property_by_object_type_and_name",
  "POST /crm/v3/properties/{objectType}/batch/read": "read_batch_crm_object_properties",
  "POST /marketing/v3/campaigns": "create_campaign",
  "GET /marketing/v3/campaigns": "get_campaigns",
  "GET /marketing/v3/campaigns/{campaignGuid}": "get_campaign",
  "POST /marketing/v3/campaigns/batch/create": "create_campaigns",
  "POST /marketing/v3/campaigns/batch/update": "update_campaigns",
  "POST /marketing/v3/campaigns/batch/archive": "delete_campaigns_batch",
  "GET /marketing/v3/campaigns/{campaignGuid}/reports/contacts/{contactType}": "get_contact_ids",
  "GET /crm/v3/pipelines/{objectType}": "retrieve_all_pipelines_for_specified_object_type",
  "GET /crm/v3/pipelines/{objectType}/{pipelineId}": "get_pipeline_by_id",
  "PUT /crm/v3/pipelines/{objectType}/{pipelineId}": "replace_all_properties_of_pipeline",
  "PATCH /crm/v3/pipelines/{objectType}/{pipelineId}": "update_pipeline",
  "GET /crm/v3/pipelines/{objectType}/{pipelineId}/audit": "audit_pipeline_changes",
  "GET /crm/v3/pipelines/{objectType}/{pipelineId}/stages": "retrieve_pipeline_stages",
  "GET /crm/v3/pipelines/{objectType}/{pipelineId}/stages/{stageId}": "retrieve_pipeline_stage_by_id",
  "PUT /crm/v3/pipelines/{objectType}/{pipelineId}/stages/{stageId}": "replace_pipeline_stage_properties",
  "PATCH /crm/v3/pipelines/{objectType}/{pipelineId}/stages/{stageId}": "update_pipeline_stage",
  "GET /crm/v3/pipelines/{objectType}/{pipelineId}/stages/{stageId}/audit": "get_pipeline_stage_audit",
  "POST /crm/v3/lists": "create_list",
  "GET /crm/v3/lists": "get_crm_lists_by_ids",
  "GET /crm/v3/lists/{listId}": "get_crm_list",
  "GET /crm/v3/lists/object-type-id/{objectTypeId}/name/{listName}": "get_crm_list_by_name",
  "DELETE /crm/v3/lists/{listId}": "delete_crm_list",
  "POST /crm/v3/lists/search": "search_crm_lists",
  "PUT /crm/v3/lists/{listId}/update-list-name": "rename_crm_list",
  "PUT /crm/v3/lists/{listId}/update-list-filters": "update_list_filters",
  "PUT /crm/v3/lists/{listId}/memberships/add-and-remove": "update_list_memberships",
  "PUT /crm/v3/lists/folders/move-list": "move_list_to_folder",
  "GET /crm/v3/lists/records/{objectTypeId}/{recordId}/memberships": "get_record_list_memberships",
  "POST /crm/v3/lists/records/memberships/batch/read": "batch_read_list_memberships",
  "GET /crm/v3/lists/{listId}/memberships": "get_segment_members",
  "GET /crm/v3/lists/idmapping": "map_legacy_list_id",
  "GET /crm/v3/owners": "retrieve_owners",
  "GET /crm/v3/owners/{ownerId}": "retrieve_owner_by_id_or_user_id",
  "GET /crm-object-schemas/v3/schemas": "retrieve_all_object_schemas",
  "POST /crm-object-schemas/v3/schemas": "create_object_schema",
  "GET /crm-object-schemas/v3/schemas/{objectType}": "retrieve_object_schema",
  "PATCH /crm-object-schemas/v3/schemas/{objectType}": "update_object_schema",
  "DELETE /crm-object-schemas/v3/schemas/{objectType}": "delete_schema",
  "DELETE /crm-object-schemas/v3/schemas/{objectType}/associations/{associationIdentifier}": "remove_association_from_schema",
  "POST /crm-object-schemas/v3/schemas/{objectType}/associations": "create_association",
  "GET /crm/v4/objects/{objectType}/{objectId}/associations/{toObjectType}": "list_object_associations",
  "PUT /crm/v4/objects/{objectType}/{objectId}/associations/{toObjectType}/{toObjectId}": "create_object_association",
  "DELETE /crm/v4/objects/{objectType}/{objectId}/associations/{toObjectType}/{toObjectId}": "remove_association",
  "POST /crm/v4/associations/{fromObjectType}/{toObjectType}/batch/read": "read_associations_batch",
  "GET /crm/associations/v4/{fromObjectType}/{toObjectType}/labels": "list_association_labels",
  "GET /conversations/v3/conversations/threads": "list_conversation_threads",
  "GET /conversations/v3/conversations/inboxes": "list_conversation_inboxes",
  "GET /conversations/v3/conversations/channels": "list_conversation_channels",
  "GET /cms/v3/domains": "list_domains",
  "GET /cms/v3/blogs/posts": "list_blog_posts",
  "GET /cms/v3/blogs/posts/{objectId}": "get_blog_post",
  "POST /cms/v3/blogs/posts/schedule": "schedule_blog_post",
  "GET /cms/v3/pages/landing-pages": "list_landing_pages",
  "GET /cms/v3/pages/landing-pages/{objectId}": "get_landing_page",
  "GET /cms/v3/pages/landing-pages/{objectId}/draft": "get_landing_page_draft",
  "PATCH /cms/v3/pages/landing-pages/{objectId}/draft": "update_landing_page_draft",
  "GET /cms/v3/pages/landing-pages/{objectId}/revisions": "list_landing_page_revisions",
  "POST /cms/v3/pages/landing-pages/schedule": "schedule_landing_page",
  "GET /cms/v3/pages/site-pages": "list_site_pages",
  "POST /cms/v3/pages/site-pages": "create_site_page",
  "GET /cms/v3/pages/site-pages/{objectId}": "get_site_page",
  "PATCH /cms/v3/pages/site-pages/{objectId}": "update_site_page",
  "GET /cms/v3/pages/site-pages/{objectId}/draft": "get_site_page_draft",
  "PATCH /cms/v3/pages/site-pages/{objectId}/draft": "update_site_page_draft",
  "POST /cms/v3/pages/site-pages/{objectId}/draft/push-live": "publish_site_page_draft",
  "GET /cms/site-search/v3/search": "search_cms_content",
  "POST /crm/v4/associations/{fromObjectType}/{toObjectType}/batch/labels/archive": "batch_archive_association_labels",
  "POST /crm/v4/associations/{fromObjectType}/{toObjectType}/batch/associate/default": "batch_create_default_associations",
  "GET /automation/v4/flows": "get_workflows",
  "GET /automation/v4/flows/{flowId}": "get_workflow_by_id",
  "GET /automation/v4/flows/performance/{flowId}": "get_workflow_performance",
  "POST /automation/v4/flows/batch/read": "batch_read_workflows",
  "POST /automation/v4/workflow-id-mappings/batch/read": "batch_read_workflow_id_mappings",
  "GET /automation/v4/sequences": "list_sequences",
  "GET /settings/users/v3": "list_settings_users",
  "GET /settings/v3/users/{userId}": "get_settings_user",
  "DELETE /settings/v3/users/{userId}": "remove_settings_user",
  "GET /settings/v3/users/roles": "list_user_roles",
  "GET /account-info/v3/details": "get_account_info",
  "GET /account-info/v3/api-usage/daily/private-apps": "get_private_app_daily_api_usage",
  "GET /account-info/v3/activity/audit-logs": "list_audit_logs",
  "GET /account-info/v3/activity/login": "list_login_activity",
  "GET /files/v3/files/{fileId}": "get_file",
  "GET /files/v3/files/import-from-url/async/tasks/{taskId}/status": "get_file_import_status",
  "GET /cms/v3/source-code/{environment}/content/{path}": "download_cms_source_file",
  "GET /cms/v3/source-code/{environment}/metadata/{path}": "get_cms_source_metadata",
  "GET /crm/v3/exports/export/async/tasks/{taskId}/status": "get_crm_export_status",
  "GET /marketing/v3/marketing-events/participations/{marketingEventId}/breakdown": "get_marketing_event_participation_breakdown",
  "GET /communication-preferences/v4/statuses/{subscriberIdString}": "get_email_subscription_status",
  "POST /communication-preferences/v4/statuses/{subscriberIdString}": "update_email_subscriptions",
  "GET /crm/v3/property-validations/{objectTypeId}/{propertyName}/rule-type/{ruleType}": "read_validation_rule",
  "PUT /crm/v3/property-validations/{objectTypeId}/{propertyName}/rule-type/{ruleType}": "update_validation_rule",
};

const ACTION = /^(ab-test|multi-language|draft|revisions|batch|async|tasks|status|cursor|query|schedule|clone|attach|detach|create|update|set|end|rerun|restore|reset|push-live)/;
// the thing a call is about, for telling calls with the same summary apart
const resource = (path: string, short: string) =>
  path.split("/").filter((s) => s && !s.startsWith("{") && !IGNORED.test(s)).reverse().map(words).find((s) => s && !ACTION.test(s) && !short.includes(s)) ?? "";

const HUMAN: Record<string, string> = { GET: "Get", POST: "Create", PUT: "Replace", PATCH: "Update", DELETE: "Delete" };

// the operations of every spec we use, each once: an operation can be in several specs (the generic object calls)
const catalog = (await (await fetch("https://api.hubspot.com/public/api/spec/v1/specs")).json()) as { results: Entry[] };
const dir = join(tmpdir(), "emplio-hubspot-specs");
await mkdir(dir, { recursive: true });

const skip: Record<string, string> = {};
const names: Record<string, string> = {};
const reads: string[] = [];
const spec: string[] = [];
const taken = new Set<string>(Object.values(CALLS));
const seen = new Set<string>();

const entries = (
  await Promise.all(
    catalog.results.map(async (entry) => {
      if (SKIP_SPECS[entry.name]) return [{ entry, why: SKIP_SPECS[entry.name] }];
      const version = pick(entry);
      if (!version) return [{ entry, why: "developer preview on a dated beta only: HubSpot enables it per account, on request" }];
      return [{ entry, version, doc: (await (await fetch(version.openApi)).json()) as Schema }];
    }),
  )
).flat();
const skipped: string[] = [];

// one list of who repeats a summary, so a repeated one gets its resource in the name instead of depending on order
const summaries = new Map<string, number>();
for (const { doc } of entries) for (const [path, ops] of Object.entries<Schema>(doc?.paths ?? {})) for (const [method, op] of Object.entries<Schema>(ops)) {
  if (VERBS.has(method) && op.summary && !OBJECT.test(path)) summaries.set(op.summary, (summaries.get(op.summary) ?? 0) + 1);
}

for (const [i, { entry, version, doc, why }] of entries.entries()) {
  if (!doc) {
    skipped.push(`${entry.group} / ${entry.name}: ${why}`);
    continue;
  }
  // HubSpot's specs call `associations` required on every create; the API works without it
  for (const schema of Object.values<Schema>(doc.components?.schemas ?? {})) if (schema.required) schema.required = schema.required.filter((r: string) => r !== "associations");
  for (const [path, ops] of Object.entries<Schema>(doc.paths)) {
    for (const [method, op] of Object.entries<Schema>(ops)) {
      if (!VERBS.has(method)) continue;
      const call = `${method.toUpperCase()} ${path}`;
      op.operationId = call;
      if (seen.has(call)) {
        delete ops[method];
        continue;
      }
      seen.add(call);
      const security: Schema[] = op.security ?? [];
      if (security.length && security.every((s) => "developer_hapikey" in s)) {
        skip[call] = DEV_ONLY;
        continue;
      }
      op.summary ||= `${HUMAN[method.toUpperCase()]} ${words(path.split("/").filter((s) => s && !s.startsWith("{") && !IGNORED.test(s)).slice(-3).join(" ")).replace(/_/g, " ")}`;
      const short = words(op.summary);
      const object = objectName(method.toUpperCase(), path);
      const about = resource(path, short);
      const candidates = [
        CALLS[call],
        object && (COMPOSIO[object] ?? object),
        (summaries.get(op.summary) ?? 0) > 1 ? `${short}_${about}` : short,
        `${short}_${about}`,
        pathName(method.toUpperCase(), path),
      ];
      const name = candidates.find((c): c is string => Boolean(c) && (CALLS[call] === c || !taken.has(c as string)))!;
      taken.add(name);
      names[call] = name;
      if (method === "post" && /\/search$|\/read$|\/idmapping$/.test(path)) reads.push(name);
    }
  }
  await Bun.write(join(dir, `${i}.json`), JSON.stringify(doc));
  spec.push(join(dir, `${i}.json`));
}
if (skipped.length) console.log(`left out, whole specs:\n  ${skipped.join("\n  ")}`);

export default {
  spec,
  out: "src/integrations/own/hubspot/actions.json",
  name: (_id, method, path) => names[`${method} ${path}`] ?? pathName(method, path),
  skip,
  reads,
} satisfies AppConfig;
