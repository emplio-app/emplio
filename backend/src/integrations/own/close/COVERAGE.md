# Close coverage

Source: Close's official OpenAPI spec, developer.close.com/openapi.json (308 operations), generated 2026-11-22 by
`bun scripts/openapi-actions.ts close`. Every operation is an action (305), plus two by hand (upload_file,
download_file): 307 in all. Compared with Composio's `close` toolkit on the same day: triggers 45 of 45 matched,
actions 72 of 75 matched by name (the other 3 below).

## Deliberately left out

| What | Why |
| --- | --- |
| POST /activity/meeting/{id}/integration/ | Only an OAuth app can call it; Emplio connects with an API key |
| POST /scheduling_link/integration/ | Only an OAuth app can call it |
| DELETE /scheduling_link/integration/{source_id}/ | Only an OAuth app can call it |
| Composio's create_custom_field | Close has one call per kind: create_new_lead_custom_field, create_new_contact_custom_field, create_new_opportunity_custom_field, create_new_activity_custom_field, create_new_custom_object_custom_field, create_new_shared_custom_field |
| Composio's get_note_by_id | Same call as get_note |
| Composio's list_unified_activities | Same call as list_activities (GET /activity/) |
| OAuth sign-in | Not in this job: key sign-in only |

## Hand adjustments (scripts/openapi/close.ts, own/close/index.ts)

- Base `https://api.close.com/api/v1`; the key is the HTTP basic-auth username with an empty password.
- A 401, or a 403 with `error_code: inactive_api_key`, means the key is dead.
- Names follow Composio's where one means the same call (`rename`), the rest come from the spec's summaries.
- The spec's defaults are dropped from every input: they're mostly `null` (and `""` for a pipeline's name), and
  filling them in would make an update wipe every field it didn't mention. Close applies its own defaults.
- Custom field values: Close takes them as top-level `custom.cf_...` keys the spec can't list. create/update for
  leads, contacts, opportunities and custom activities take a `custom` object (`{"cf_...": value}`) that is spread
  into those keys. Custom object instances take their whole body, so `custom.cf_...` goes straight in.
- search_data, get_activity_report, get_funnel_report_stages and get_funnel_report_totals are POSTs that only read:
  they run without asking.
- list_webhooks and get_webhook ask first: they answer with each subscription's signature_key.
- upload_file (hand-written): POST /files/upload/, then the file to Close's S3 form; answers a url that works for
  24 hours in attach_file_to_lead and email, note or opportunity attachments.
- download_file (hand-written): a Close file link to a file on the computer. The key only goes to close.com / close.io;
  the redirect to storage is followed without it.

## Auth

| Method | Status |
| --- | --- |
| API key (Settings → Developer → API Keys), sent as basic auth | done |
| OAuth (Close OAuth app) | not built: key sign-in only |

## Triggers

By webhook (own/close/triggers.ts), 152 of them: one subscription per connection on POST /webhook/, at
/webhooks/app/close/<connection>/<token>. The token is worked out from ENCRYPTION_KEY and the connection, never stored.
Each request is also checked against Close's `close-sig-hash` (HMAC-SHA256 of `close-sig-timestamp` + body with the
subscription's `signature_key`, fetched with the connection's key and kept in memory, fetched again on a mismatch).
A trigger adds its events to the subscription (PUT, which also re-activates one Close paused); the subscription is
deleted when the connection's last automation goes. Close's event id (`ev_...`) stops a retry running twice.

Close allows 40 webhook subscriptions per organization; Emplio uses one per connection. A non-admin key sees and
changes only subscriptions it made, which is all Emplio needs.

- Every Close event type and action, named `<thing>_<action>`: lead (created, updated, deleted, merged), contact,
  opportunity, task (every task kind, plus completed), email (plus sent), email_thread, call (plus answered,
  completed), sms (plus sent), whatsapp_message, note, meeting (plus scheduled, started, completed, canceled),
  form_submission, lead_status_change, opportunity_status_change, task_completion, lead_merge,
  lead_creation_activity, custom_activity, unsubscribed_email, import (plus completed, reverting, reverted), export,
  bulk_delete / bulk_edit / bulk_email / bulk_sequence_subscription (created, updated, completed, paused), the six
  kinds of custom field, custom_activity_type, custom_object_type, custom_object, lead_status, opportunity_status,
  membership (activated, deactivated), group, smart_view, phone_number, email_template, sms_template, sequence,
  sequence_subscription, comment, comment_thread.
- Composio's names where it has one for the same event: call_logged, comment_added, custom_activity_logged,
  email_logged, email_thread_started, lead_creation_activity_added, lead_status_changed,
  lead_status_change_entry_updated/deleted, note_added, opportunity_status_changed,
  opportunity_status_change_entry_updated/deleted, sms_logged, task_completion_logged, task_completion_entry_deleted,
  whatsapp_message_logged.
- opportunity_won, opportunity_lost: an opportunity's status_type changed to won or lost.
- Filters, applied by Emplio: lead_id, user_id (who did it, owns it or is assigned it), status_id, pipeline_id where
  they make sense, and field on every `*_updated` (only when that field changed).
- lead_creation_activity_* subscribe to object type `activity.created`, which Close's event list doesn't spell out
  (Composio has these triggers); not tried live.

Polled: none (polls/close.ts is empty). Close reports everything it has by webhook.

## Actions (`*` asks first)

- **leads**: list_leads, create_lead*, merge_two_leads*, get_lead, update_lead*, delete_lead*, list_files_attached_to_lead, attach_file_to_lead*
- **contacts**: list_contacts, create_contact*, get_contact, update_contact*, delete_contact*
- **opportunities**: list_opportunities, create_opportunity*, get_opportunity, update_opportunity*, delete_opportunity*
- **tasks**: list_tasks, create_task*, bulk_update_tasks*, get_task, update_task*, delete_task*
- **files**: generate_signed_s3_post*
- **custom_objects**: list_custom_objects, create_new_custom_object_instance*, retrieve_single_custom_object_instance, updating_custom_object_instance*, delete_custom_object_instance*
- **comments**: fetch_multiple_comments, create_comment*, fetch_individual_comment, update_comment*, remove_comment*, fetch_multiple_comment_threads, fetch_individual_comment_thread
- **activities**: list_activities
- **activities.notes**: list_or_filter_note_activities, create_note*, get_note, update_note*, delete_note*
- **activities.calls**: list_or_filter_call_activities, create_call*, get_call, update_call_activity*, delete_call*
- **activities.emails**: list_or_filter_email_activities, create_email*, get_email, update_email*, delete_email*
- **activities.email_threads**: list_or_filter_email_thread_activities, get_single_email_thread_activity, delete_email_thread_activity*
- **activities.sms**: list_or_filter_sms_activities, create_sms*, get_sms, update_sms*, delete_sms*
- **activities.whatsapp_messages**: list_or_filter_whats_app_message_activities, create_whats_app_message_activity*, get_single_whats_app_message_activity, update_whats_app_message_activity*, delete_whats_app_message_activity*
- **activities.meetings**: list_or_filter_meeting_activities, get_meeting, update_meeting_activity*, delete_meeting_activity*
- **activities.custom_activities**: list_custom_activities, create_custom_activity*, get_single_custom_activity_instance, update_custom_activity*, delete_custom_activity*
- **activities.creations**: list_or_filter_created_activities, get_created_activity
- **activities.form_submissions**: list_or_filter_form_submission_activities, get_single_form_submission_activity, delete_form_submission_activity*
- **activities.lead_status_changes**: list_or_filter_lead_status_change_activities, create_new_lead_status_change_activity*, get_single_lead_status_change_activity, delete_single_lead_status_change_activity*
- **activities.opportunity_status_changes**: list_or_filter_opportunity_status_change_activities, create_new_opportunity_status_change_activity*, get_single_opportunity_status_change_activity, delete_single_opportunity_status_change_activity*
- **activities.lead_merges**: list_or_filter_lead_merge_activities, get_single_lead_merge_activity
- **activities.task_completions**: list_or_filter_task_completed_activities, get_single_task_completed_activity, delete_task_completed_activity*
- **activities.import_updates**: list_or_filter_import_update_activities, get_single_import_update_activity, delete_import_update_activity*
- **webhooks**: list_webhooks*, create_new_webhook_subscription*, get_webhook*, update_existing_webhook_subscription*, delete_webhook_subscription*
- **events**: list_events, get_event
- **advanced_filtering**: search_data
- **smart_views**: list_smart_views, create_smart_view*, get_single_smart_view, update_smart_view*, delete_smart_view*
- **reporting**: get_activity_report, list_predefined_metrics_used_in_activity_reports, get_custom_report_explorer, get_funnel_report_stages, get_funnel_report_totals, get_sent_emails_report, get_lead_status_change_report, get_opportunity_status_change_report
- **sequences**: list_sequences, create_sequence*, get_sequence, update_sequence*, delete_sequence*, list_sequence_subscriptions, subscribe_contact_to_sequence*, fetch_single_sequence_subscription, update_specific_subscription*, delete_sequence_subscription*
- **bulk_actions.email**: list_bulk_emails, initiate_new_bulk_email*, fetch_single_bulk_email_object
- **bulk_actions.edit**: list_bulk_edits, initiate_new_bulk_edit*, fetch_single_bulk_edit_object
- **bulk_actions.delete**: list_bulk_deletes, initiate_new_bulk_delete*, fetch_single_bulk_delete_object
- **bulk_actions.sequence_subscriptions**: list_bulk_sequence_subscriptions, initiate_new_bulk_sequence_subscription*, fetch_single_bulk_sequence_subscription_object
- **exports**: list_exports, list_lead_exports, export_leads_based_on_search_query*, get_single_lead_export, list_opportunity_exports, export_opportunities_based_on_opportunity_filters*, get_single_opportunity_export, get_export
- **field_enrichment**: enrich_specific_field_on_lead_or_contact_using_ai*
- **custom_field_schemas**: retrieve_custom_field_schema, update_custom_field_schema*
- **custom_fields.lead**: list_lead_custom_fields, create_new_lead_custom_field*, get_lead_custom_field, update_lead_custom_field*, delete_lead_custom_field*
- **custom_fields.contact**: list_contact_custom_fields, create_new_contact_custom_field*, get_contact_custom_field, update_contact_custom_field*, delete_contact_custom_field*
- **custom_fields.opportunity**: list_opportunity_custom_fields, create_new_opportunity_custom_field*, get_opportunity_custom_field, update_opportunity_custom_field*, delete_opportunity_custom_field*
- **custom_fields.activity**: list_activity_custom_fields, create_new_activity_custom_field*, get_activity_custom_field, update_activity_custom_field*, delete_activity_custom_field*
- **custom_fields.custom_object**: list_custom_object_custom_fields, create_new_custom_object_custom_field*, get_custom_object_custom_field, update_custom_object_custom_field*, delete_custom_object_custom_field*
- **custom_fields.shared**: list_shared_custom_fields, create_new_shared_custom_field*, get_shared_custom_field, update_shared_custom_field*, delete_shared_custom_field*, associate_shared_custom_field_with_object_type*, fetch_shared_custom_field_association, update_existing_shared_custom_field_association*, disassociate_shared_custom_field_from_object_type*
- **custom_activity_types**: list_custom_activity_types, create_new_custom_activity_type*, retrieve_single_custom_activity_type, update_existing_custom_activity_type*, delete_custom_activity_type*
- **custom_object_types**: list_custom_object_types, create_new_custom_object_type*, retrieve_single_custom_object_type, update_existing_custom_object_type*, delete_custom_object_type*
- **pipelines**: list_pipelines, create_pipeline*, fetch_single_pipeline, update_pipeline*, delete_pipeline*
- **opportunity_statuses**: list_opportunity_statuses, create_opportunity_status*, fetch_single_opportunity_status, rename_opportunity_status*, delete_opportunity_status*
- **lead_statuses**: list_lead_statuses, create_new_status_that_can_be_applied_to_leads*, fetch_single_lead_status, update_lead_status*, delete_lead_status*
- **standard_object_labels**: list_standard_object_labels_for_organization, fetch_single_standard_object_label, rename_standard_object_label*, reset_standard_object_label_to_its_default*
- **integration_links**: get_integration_links_for_organization, create_integration_link*, get_single_integration_link, update_integration_link*, delete_integration_link*
- **forms**: list_forms, retrieve_form
- **email_templates**: list_email_templates, create_email_template*, fetch_email_template, update_email_template*, delete_email_template*, render_email_template
- **sms_templates**: list_sms_templates, create_sms_template*, fetch_sms_template, update_sms_template*, delete_sms_template*, render_sms_template
- **outcomes**: list_outcomes, create_outcome*, fetch_single_outcome, update_outcome*, delete_outcome*
- **playbooks**: list_or_filter_playbooks, create_playbook*, fetch_single_playbook, update_playbook*, delete_playbook*, archive_playbook*, unarchive_playbook*
- **scheduling_links**: list_user_scheduling_links, create_user_scheduling_link*, fetch_user_scheduling_link, update_user_scheduling_link*, delete_user_scheduling_link*, list_shared_scheduling_links, create_shared_scheduling_link*, fetch_shared_scheduling_link, update_shared_scheduling_link*, delete_shared_scheduling_link*, map_shared_scheduling_link*, unmap_shared_scheduling_link*
- **connected_accounts**: list_connected_accounts, fetch_single_connected_account
- **send_as**: list_send_as_associations, create_send_as_association*, delete_send_as_association_by_allowed_user*, edit_send_as_associations_in_bulk*, retrieve_single_send_as_association, delete_send_as_association_by_id*
- **unsubscribed_emails**: list_unsubscribed_emails, unsubscribe_email_address*, resubscribe_email_address*
- **phone_numbers**: list_or_search_for_phone_numbers, request_internal_phone_number*, retrieve_single_phone_number, update_phone_number*, delete_phone_number*
- **blocked_phone_numbers**: list_blocked_phone_numbers, create_blocked_phone_number*, retrieve_blocked_phone_number_settings, update_blocked_phone_number_settings*, retrieve_single_blocked_phone_number, update_blocked_phone_number*, delete_blocked_phone_number*
- **dialers**: list_or_filter_dialer_sessions, get_single_dialer_session
- **users**: who_am_i, list_users, list_user_availability_statuses, get_user
- **organizations**: get_organization, update_organization*
- **memberships**: create_membership*, bulk_update_memberships*, update_membership*, delete_membership*, get_pinned_views_for_membership, update_pinned_views_for_membership*
- **roles**: list_roles_defined_for_organization, create_new_role*, fetch_single_role, update_existing_role*, delete_role*
- **groups**: list_groups_for_organization, create_group*, add_user_to_group*, remove_user_from_group*, fetch_individual_group, update_group*, delete_group*
- **by hand**: upload_file*, download_file
