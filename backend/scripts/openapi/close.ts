// Close: what the generator (../openapi-actions.ts) can't tell from the spec.
import type { AppConfig } from "../openapi-actions";
import { composioNames, namer } from "./composio-names";

const OAUTH_ONLY = "only an OAuth app can call it; Emplio connects with an API key";

export default {
  spec: "https://developer.close.com/openapi.json",
  out: "src/integrations/own/close/actions.json",
  name: namer(await composioNames("close")),
  // Composio's names where the summary-made name means the same call, so automations written for it carry over
  rename: {
    log_external_call_activity: "create_call",
    create_new_custom_activity_instance: "create_custom_activity",
    create_email_activity: "create_email",
    create_note_activity: "create_note",
    create_sms_activity: "create_sms",
    delete_call_activity: "delete_call",
    delete_custom_activity_instance: "delete_custom_activity",
    delete_email_activity: "delete_email",
    delete_note_activity: "delete_note",
    delete_sms_activity: "delete_sms",
    fetch_activity_custom_field_s_details: "get_activity_custom_field",
    get_single_call_activity: "get_call",
    fetch_single_contact: "get_contact",
    get_single_created_activity: "get_created_activity",
    get_single_email_activity: "get_email",
    retrieve_single_event_by_id: "get_event",
    get_single_export: "get_export",
    get_single_lead: "get_lead",
    fetch_lead_custom_field_s_details: "get_lead_custom_field",
    get_single_meeting_activity: "get_meeting",
    get_single_note_activity: "get_note",
    fetch_shared_custom_field_s_details: "get_shared_custom_field",
    get_single_sms_activity: "get_sms",
    fetch_task_s_details: "get_task",
    fetch_single_user: "get_user",
    list_or_filter_activity_types: "list_activities",
    list_or_filter_custom_activity_instances: "list_custom_activities",
    list_custom_object_instances: "list_custom_objects",
    retrieve_list_of_events: "list_events",
    list_lead_statuses_for_organization: "list_lead_statuses",
    list_or_filter_opportunities: "list_opportunities",
    list_opportunity_statuses_for_organization: "list_opportunity_statuses",
    list_or_filter_outcomes: "list_outcomes",
    list_pipelines_for_organization: "list_pipelines",
    list_or_filter_tasks: "list_tasks",
    list_users_in_organization: "list_users",
    list_webhook_subscriptions: "list_webhooks",
    search_objects_with_filters: "search_data",
    updating_custom_activity_instance: "update_custom_activity",
    update_email_activity: "update_email",
    update_note_activity: "update_note",
    update_sms_activity: "update_sms",
    fetch_information_about_yourself: "who_am_i",
    fetch_contact_custom_field_s_details: "get_contact_custom_field",
    fetch_opportunity_custom_field_s_details: "get_opportunity_custom_field",
    fetch_custom_object_custom_field_s_details: "get_custom_object_custom_field",
    get_organization_s_details: "get_organization",
    retrieve_single_webhook_subscription: "get_webhook",
  },
  skip: {
    activitiesMeetings_createIntegration: OAUTH_ONLY,
    schedulingLinks_createIntegration: OAUTH_ONLY,
    schedulingLinks_deleteIntegration: OAUTH_ONLY,
  },
  // POSTs that only look things up
  reads: ["search_data", "get_activity_report", "get_funnel_report_stages", "get_funnel_report_totals"],
  // each webhook comes back with its signature_key
  secrets: ["list_webhooks", "get_webhook"],
  // Close takes custom field values as top-level "custom.cf_..." keys, which the spec can't list: a `custom` object
  // instead, spread into those keys by own/close/index.ts
  after: async () => {
    const file = new URL("../../src/integrations/own/close/actions.json", import.meta.url).pathname;
    const out = await Bun.file(file).json();
    // the spec's defaults (often null, or "" for a pipeline's name) would be filled in and sent, so an update would wipe
    // every field it didn't mention; left out, Close applies its own
    const plain = (s: any): void => {
      if (!s || typeof s !== "object") return;
      if (!Array.isArray(s)) delete s.default;
      for (const v of Object.values(s)) plain(v);
    };
    for (const a of out.actions) plain(a.input);
    for (const a of out.actions) {
      if (a.send.body?.kind !== "fields" || !/custom\.(\{|cf_)/.test(a.description)) continue;
      a.input.properties.custom = {
        type: "object",
        additionalProperties: true,
        description:
          'Custom field values by the field\'s id, like {"cf_v6S011I6Mqcb...": "Gold", "cf_8wtB...": ["A", "B"]} (list_lead_custom_fields and its contact, opportunity and activity twins give the ids). A field that takes several values takes a list; null clears one.',
      };
    }
    await Bun.write(file, JSON.stringify(out));
  },
} satisfies AppConfig;
