// Gong: what the generator (../openapi-actions.ts) can't tell from the spec. Gong serves its OpenAPI file to anyone at
// the address its API documentation page (gong.app.gong.io/settings/api/documentation) loads it from. The spec's
// server is a placeholder; each company has its own base URL, which own/gong/index.ts reads from the key.
import type { AppConfig } from "../openapi-actions";
import { composioNames, namer } from "./composio-names";

const base = namer(await composioNames("gong"));

export default {
  spec: "https://gong.app.gong.io/ajax/settings/api/documentation/specs?version=",
  out: "src/integrations/own/gong/actions.json",
  // Gong's summaries end with the path, "(/v2/calls)"; named from the words before it, or Composio's name for the same call
  name: (id, method, path, op) => base(id, method, path, { ...op, summary: String(op.summary ?? id).replace(/\s*\(\/v2[^)]*\)?\s*$/, "") }),
  skip: {
    assignProspectsCoolOffOverrides: "Gong marks it deprecated; assign_prospects_to_flow does the same",
  },
  // POSTs that only look things up: filtered lists, stats, transcripts, a check of the meeting integration
  // shorter names than Gong's summaries give
  rename: {
    retrieve_call_data_by_date_range: "list_calls",
    add_new_call: "add_call",
    retrieve_data_for_specific_call: "get_call",
    retrieve_detailed_call_data_by_various_filters: "list_calls_extensive",
    retrieve_transcripts_of_calls: "get_call_transcripts",
    give_individual_users_access_to_calls: "give_users_call_access",
    retrieve_users_that_have_specific_individual_access_to_calls: "list_users_call_access",
    remove_specific_individual_users_access_from_calls: "remove_users_call_access",
    report_content_view_event: "report_content_viewed",
    report_content_share_event: "report_content_shared",
    report_event_of_custom_action: "report_custom_action",
    update_gong_meeting: "update_meeting",
    create_new_gong_meeting: "create_meeting",
    validate_gong_meeting_integration: "validate_meeting_integration",
    integration_settings: "set_integration_origins",
    retrieve_interaction_stats_for_applicable_users_by_date: "get_interaction_stats",
    retrieve_answered_scorecards_for_applicable_reviewed_users_or_scorecards_for_date_range: "list_answered_scorecards",
    retrieve_daily_activity_for_applicable_users_for_date_range: "get_daily_activity",
    retrieve_aggregated_activity_for_defined_users_by_date: "get_aggregate_activity",
    retrieve_aggregated_activity_for_defined_users_by_date_range_with_grouping_in_time_periods: "get_aggregate_activity_by_period",
    get_flow_details_and_steps_for_one_or_more_engage_flows: "get_flow_steps",
    list_prospects_assigned_flows: "list_prospect_flows",
    unassign_flows_by_flow_instance_id: "unassign_flows_by_instance_id",
    unassign_flows_by_crm_prospect_id: "unassign_flows_by_crm_id",
    submit_bulk_assignment_of_prospects_to_flow: "bulk_assign_prospects_to_flow",
    assign_prospects_contacts_or_leads_to_engage_flow: "assign_prospects_to_flow",
    get_results_of_bulk_assignment_of_prospects_to_flow: "get_bulk_assignment_results",
    list_gong_engage_flows: "list_flows",
    search_gong_engage_flows_by_name: "search_flows",
    list_gong_engage_flow_folders: "list_flow_folders",
    delete_phone_number_and_associated_elements: "erase_data_for_phone_number",
    delete_email_address_and_associated_elements: "erase_data_for_email_address",
    retrieve_references_to_phone_number: "find_phone_number_references",
    retrieve_references_to_email_address: "find_email_address_references",
    upload_object_schema: "upload_crm_schema",
    contact_enrich: "enrich_contacts",
    retrieve_user: "get_user",
    retrieve_tracker_details: "list_trackers",
    retrieve_ai_brief_settings: "list_ai_brief_settings",
    retrieve_logs_data_by_type_and_time_range: "list_logs",
    retrieve_library_folders: "list_library_folders",
    list_users_attached_to_given_permission_profile: "list_permission_profile_users",
    list_company_permission_profiles_for_given_workspace: "list_permission_profiles",
    generate_brief_for_crm_entity: "generate_entity_brief",
    get_generic_crm_integration_details: "list_crm_integrations",
  },
  // POSTs that only look things up: filtered lists, stats, transcripts, a check of the meeting integration
  reads: [
    "list_calls_extensive",
    "list_users_call_access",
    "list_users_by_filter",
    "list_tasks",
    "get_interaction_stats",
    "list_answered_scorecards",
    "get_daily_activity",
    "get_aggregate_activity",
    "get_aggregate_activity_by_period",
    "get_flow_steps",
    "list_prospect_flows",
    "get_call_transcripts",
    "validate_meeting_integration",
  ],
} satisfies AppConfig;
