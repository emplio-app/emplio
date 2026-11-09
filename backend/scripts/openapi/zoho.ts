// Zoho CRM: what the generator can't tell from Zoho's specs (github.com/zoho/crm-oas, one YAML per area).
// The CRM call's host depends on the login's data centre: index.ts swaps it in, so the servers here are the US ones.
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AppConfig } from "../openapi-actions";
import { composioNames } from "./composio-names";
import { zohoNamer } from "./zoho-spec";

const TREE = "https://api.github.com/repos/zoho/crm-oas/git/trees/main?recursive=1";
const files = ((await (await fetch(TREE)).json()) as { tree: { path: string }[] }).tree.map((t) => t.path).filter((p) => /^v8\.0\/[^/]+\/[^/]+\.ya?ml$/.test(p));
const dir = await mkdtemp(join(tmpdir(), "zoho-crm-"));
const spec = await Promise.all(files.map(async (p) => {
  const doc = Bun.YAML.parse(await (await fetch(`https://raw.githubusercontent.com/zoho/crm-oas/main/${p}`)).text()) as Record<string, any>;
  tidy(doc);
  const f = join(dir, `${p.split("/").pop()}.json`);
  await Bun.write(f, JSON.stringify(doc));
  return f;
}));

// Zoho's specs give defaults for some fields, which would quietly go out on every write; uploads are typed as plain objects
function tidy(node: any) {
  if (!node || typeof node !== "object") return;
  if (typeof node.default !== "object") delete node.default;
  const schema = node["multipart/form-data"]?.schema as Record<string, any> | undefined;
  // upload by file or by link: one schema with both
  if (schema?.oneOf) Object.assign(schema, { type: "object", properties: Object.assign({}, ...schema.oneOf.map((o: any) => o.properties)), oneOf: undefined, required: undefined });
  for (const prop of Object.values<any>(schema?.properties ?? {})) if (prop.type === "object" && !prop.properties) Object.assign(prop, { type: "string", format: "binary" });
  Object.values(node).forEach(tidy);
}

const SHARE = "needs a separate permission for every module; see COVERAGE.md";

export default {
  spec,
  out: "src/integrations/own/zoho/actions.json",
  name: zohoNamer(await composioNames("zoho")),
  // sharing needs a separate permission for every module (ZohoCRM.share.<module>.*), too many to ask for at sign-in
  skip: { "GET /{moduleApiName}/{recordId}/actions/share": SHARE, "POST /{moduleApiName}/{recordId}/actions/share": SHARE, "PUT /{moduleApiName}/{recordId}/actions/share": SHARE, "DELETE /{moduleApiName}/{recordId}/actions/share": SHARE },
  // POSTs that only read
  reads: ["get_related_records_count", "retrieve_records_using_coql_query", "bulk_search_records_by_criteria_word_email_or_phone"],
  rename: {
    convert_lead: "convert_zoho_lead",
    module_record_count: "count_records",
    create_custom_fields_in_module: "create_custom_field",
    create_email_drafts_for_record: "create_email_draft",
    function: "create_function",
    create_records_in_specified_module: "create_zoho_record",
    create_tags: "create_zoho_tag",
    delete_tag_by_id: "delete_tag",
    download_specific_attachment_file: "download_record_attachment",
    get_record_photo: "download_record_photo",
    specific_assignment_rule_details: "get_assignment_rule",
    automation_task: "get_automation_task",
    list_fields_metadata: "get_module_fields",
    get_timelines: "get_record_timeline",
    retrieve_workflow_rule_by_id: "get_workflow_rule",
    get_records_from_specified_module: "get_zoho_records",
    get_users: "get_zoho_users",
    functions: "list_functions",
    retrieve_modules: "list_modules",
    retrieve_attachments: "list_record_attachments",
    tags: "list_tags",
    retrieve_variables: "list_variables",
    list_workflow_rules_in_zoho_crm_organization: "list_workflow_rules",
    merge_records: "merge_leads",
    search_records_by_criteria_word_email_or_phone: "search_zoho_records",
    update_records_in_specified_module: "update_zoho_record",
  },
  // the address each call goes to: bulk jobs, uploads and everything else; index.ts swaps in the login's data centre
  server: (path) => (path === "/upload" ? "https://upload.zoho.com/crm/v8" : /^\/(read|write)\b/.test(path) ? "https://www.zohoapis.com/crm/bulk/v8" : "https://www.zohoapis.com/crm/v8"),
} satisfies AppConfig;
