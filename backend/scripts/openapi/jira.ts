// Jira Cloud: what the generator (../openapi-actions.ts) can't tell from the specs. Two specs make the app: the
// Jira platform REST API (issues, projects, users, workflows, admin) and Jira Software (boards, sprints, epics, backlog).
// Both live on the person's own site; own/jira/index.ts sends every call there.
import type { AppConfig } from "../openapi-actions";
import { composioNames, namer } from "./composio-names";

const named = namer(await composioNames("jira"));
const used = new Set<string>();
// the two specs share some operation ids (getIssue, getConfiguration): the board's copy gets "agile_" in front
const name: AppConfig["name"] = (id, method, path, op) => {
  let n = named(id, method, path, op);
  if (used.has(n)) n = `agile_${id}`;
  used.add(n);
  return n;
};

const APP_ONLY = "only a Connect or Forge app installed on the site can call it, never a person's API token";
const DEV_TOOLS = "how a Connect or Forge development tool (builds, deployments, feature flags, security) feeds data in; needs that app's own login";

export default {
  spec: ["https://developer.atlassian.com/cloud/jira/platform/swagger-v3.v3.json", "https://developer.atlassian.com/cloud/jira/software/swagger.v3.json"],
  out: "src/integrations/own/jira/actions.json",
  name,
  skip: (_method, path) => {
    if (/^\/rest\/(atlassian-connect|forge|internal)\//.test(path)) return APP_ONLY;
    if (/^\/rest\/api\/3\/(app|forge|uiModifications|webhook)(\/|$)/.test(path)) return APP_ONLY;
    if (path.startsWith("/rest/api/3/jql/function/computation")) return `precomputed values of an app's own JQL functions; ${APP_ONLY}`;
    if (/^\/rest\/api\/3\/field\/\{fieldKey\}\/option/.test(path)) return `select options a Connect app added; ${APP_ONLY}`;
    if (path.startsWith("/rest/api/3/workflow/rule/config")) return `workflow rules a Connect app added; ${APP_ONLY}`;
    if (/^\/rest\/(devinfo|featureflags|deployments|builds|remotelinks|security|operations|devopscomponents)\//.test(path)) return DEV_TOOLS;
    return undefined;
  },
  // Composio's names for the same calls, so skills and automations made with Composio's Jira keep working
  rename: {
    add_actors_to_project_role: "add_users_to_project_role",
    delete_actors_from_project_role: "remove_user_from_project_role",
    add_watcher: "add_watcher_to_issue",
    delete_watcher: "remove_watcher_from_issue",
    bulk_fetch_changelogs: "bulk_fetch_issue_changelogs",
    get_changelogs: "get_issue_changelogs",
    get_bulk_permissions: "check_permissions",
    get_field_reference_data_get: "get_jql_autocompletedata",
    get_field_reference_data_post: "create_jql_autocompletedata",
    get_field_auto_complete_suggestions: "get_jql_autocompletedata_suggestions",
    bulk_delete_statuses: "delete_statuses",
    evaluate_jira_expression_using_enhanced_search_api: "evaluate_jira_expression",
    get_configuration: "get_board_configuration",
    get_bulk_issue_operation_progress: "get_bulk_operation_status",
    get_create_field_metadata_for_project_and_issue_type_id: "get_create_metadata_issue_type_fields",
    get_create_metadata_issue_types_for_project: "get_issue_create_metadata",
    get_dashboard_item_property_keys: "get_dashboard_item_properties",
    search_resolutions: "get_issue_resolutions",
    get_locale: "get_mypreferences_locale",
    get_assigned_permission_scheme: "get_project_permission_scheme",
    get_workflow_scheme_project_associations: "get_project_workflow_schemes",
    get_system_avatars_by_type: "get_system_avatars",
    get_avatars: "get_universal_avatar_type_owner",
    get_avatar_image_by_type: "get_universal_avatar_view_type",
    get_avatar_image_by_id: "get_view_type_avatar",
    get_worklogs: "get_worklogs_by_ids",
    get_quick_filters: "list_board_quick_filters",
    get_boards: "list_boards",
    get_comments: "list_issue_comments",
    get_default_values_for_custom_field_grouped_by_context_and_issue_type: "list_custom_field_context_default_values",
    get_issue_types_for_custom_field_context: "list_custom_field_context_issue_type_mappings",
    get_custom_field_options_context: "list_custom_field_context_options",
    get_project_mappings_for_custom_field_context: "list_custom_field_context_project_mappings",
    get_custom_field_contexts: "list_custom_field_contexts",
    get_gadgets: "list_dashboard_gadgets",
    search_field_scheme_fields: "list_field_scheme_fields",
    search_for_filters: "list_filters",
    get_users_from_group: "list_group_members",
    get_issue_property_keys: "list_issue_property_keys",
    get_issue_type_screen_scheme_items: "list_issue_type_screen_scheme_mappings",
    search_priorities: "list_priorities",
    get_issue_type_schemes_for_projects: "list_project_issue_type_schemes",
    get_project_types: "list_project_types",
    get_project_versions_paginated: "list_project_versions_paginated",
    get_screens: "list_screens",
    get_screen_schemes: "list_screen_schemes",
    get_screen_tab_fields: "list_screen_tab_fields",
    get_screen_tabs: "list_screen_tabs",
    get_sprints: "list_sprints",
    get_ids_of_updated_worklogs: "list_updated_worklogs",
    move_issues_to_sprint_and_rank: "move_issue_to_sprint",
    count_issues_using_jql: "search_approximate_count",
    search_for_issues_using_jql_enhanced_search_get: "search_for_issues_using_jql_get",
    search_for_issues_using_jql_enhanced_search_post: "search_for_issues_using_jql_post",
  },
  // POSTs that only look things up
  reads: [
    "search_for_issues_using_jql_post",
    "search_approximate_count",
    "fetch_bulk_issues",
    "bulk_fetch_issue_changelogs",
    "get_changelogs_by_ids",
    "get_comments_by_ids",
    "get_worklogs_by_ids",
    "get_is_watching_issue_bulk",
    "check_permissions",
    "get_permitted_projects",
    "create_jql_autocompletedata",
    "get_custom_field_contexts_for_projects_and_issue_types",
    "check_issues_against_jql",
    "parse_jql_queries",
    "sanitize_jql_queries",
    "convert_user_identifiers_to_account_ids_in_jql_queries",
    "analyse_expression",
    "evaluate_jira_expression",
    "validate_policy_application_to_project",
    "read_workflow_version_from_history",
    "list_workflow_history_entries",
    "bulk_get_workflows",
    "preview_workflow",
    "validate_create_workflows",
    "validate_update_workflows",
    "bulk_get_workflow_schemes",
    "get_required_status_mappings_for_workflow_scheme_update",
  ],
  // the spec gives the attachment upload no fields: Jira takes the files under "file"; and fixes below
  after: async () => {
    const file = new URL(`../../src/integrations/own/jira/actions.json`, import.meta.url).pathname;
    const out = await Bun.file(file).json();
    const a = out.actions.find((x: { name: string }) => x.name === "add_attachment");
    a.input.properties.file = { type: "array", items: {}, description: 'One or more files from the computer: [{"file": "/work/report.pdf"}]' };
    a.input.required.push("file");
    a.send.body.fields = [["file", "file"]];
    // the board API calls some plain query values (a sprint's state, "active,closed") an object
    for (const x of out.actions)
      for (const q of x.send.query) {
        const p = x.input.properties[q];
        if (p?.type === "object" && !p.properties) x.input.properties[q] = { type: "string", description: p.description };
      }
    await Bun.write(file, JSON.stringify(out));
  },
} satisfies AppConfig;
