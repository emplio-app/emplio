# Freshdesk coverage

Source: Freshdesk API v2 reference (developers.freshdesk.com/api), read endpoint by endpoint on 2026-11-22. Freshdesk
publishes no OpenAPI spec, so the calls are listed by hand in `own/freshdesk/*.ts` and run through `own/openapi.ts`.
Every documented endpoint is an action (263), named like Composio's toolkit where it has the same call.

## Deliberately left out

| What | Why |
| --- | --- |
| View / update / delete a service account | Same endpoints as get_agent / update_agent / delete_agent (/agents/{id}) |
| Service tasks, service groups, make field technician | Same endpoints as tickets, groups and update_contact_make_agent (type "field_agent") |
| Initiate a key rotation | Same endpoint as create_api_key (a key in the second position) |
| Webhook triggers | Freshdesk has no API to register webhooks; they are only made by hand in its automation rules. Every trigger is polled instead |
| A time-entry trigger | /time_entries filters by when the work was done, not when it was logged, so new entries can't be told apart reliably |

## Docs that disagree with themselves (followed the endpoint heading)

- Update agent availability: heading PUT, sample PATCH. Built as PUT.
- Add or remove agents in a group: heading PATCH, sample PUT. Built as PATCH.
- Bulk create canned responses: heading /canned_responses/bulk, sample /canned_responses/create_multiple. Built as /bulk.

## Hand adjustments

- Key: `yourco.freshdesk.com:API_KEY` (also `yourco:KEY` or with https://), sent as Basic `KEY:X` to that host. Any host
  that isn't *.freshdesk.com is refused before a call is made, so a pasted key can't be sent elsewhere.
- Files: create/update ticket, reply, note, update conversation, summary, canned responses, contacts (avatar) and CSV
  imports go as multipart when a file is given, with arrays as `name[]` and objects as `name[key]` the way Freshdesk reads
  them; otherwise JSON.
- search_tickets / search_contacts / search_companies wrap the query in the double quotes Freshdesk requires.
- bulk_update_tickets / delete_multiple_tickets nest their input under `bulk_action`.
- list_custom_object_records takes `field[gte]`-style filters into the query.

## Auth

| Method | Status |
| --- | --- |
| Helpdesk address + agent API key (profile picture → Profile settings → View API key), Basic auth | done |
| OAuth | not built: key sign-in only for this run (the docs list OAuth 2.0 scopes per endpoint; add later if wanted) |

## Triggers (all polled; Composio has none)

new_ticket, ticket_updated, ticket_status_changed (stats.status_updated_at, filter by new status), new_reply (customer,
agent or any, via stats.*_responded_at; brings the latest messages), new_contact, new_company, new_satisfaction_rating
(older survey accounts). Each reads the first 100 records changed in the last day.

## Composio names we answer under another name

create_admin → create_admin_group · create_companies → create_company · update_companies →
update_company · search_company → search_companies · create_email → create_email_mailbox · list_email →
list_email_mailboxes · view_email → get_email_mailbox · delete_email_mailboxes → delete_email_mailbox · get_search →
search_tickets · get_scenario_automations_json → list_scenario_automations · list_topic_comments2 → list_topic_comments ·
update_solutions → update_solution_article · view_solutions → view_solution_article · view_automations →
view_automation_rule · update_automations → update_automation_rule · view_notifications → view_notification_email_bcc ·
view_settings → view_helpdesk_settings.

## Actions by group (* asks first)

**Tickets** (51): create_ticket*, create_ticket_outbound_email*, view_ticket, get_tickets, search_tickets, update_ticket*, delete_ticket*, restore_ticket*, bulk_update_tickets*, delete_multiple_tickets*, merge_tickets*, get_associated_tickets, get_prime_association, delete_attachment*, list_all_ticket_conversations, reply_to_ticket*, add_note_to_ticket*, update_conversation*, delete_conversation*, forward_ticket*, reply_to_forward_ticket*, list_tickets_watchers, add_watcher*, remove_watcher*, update_ticket_bulk_watch*, bulk_unwatch_tickets*, view_ticket_summary, update_ticket_summary*, delete_ticket_summary*, view_archived_ticket, delete_archived_ticket*, list_archived_ticket_conversations, get_ticket_user_access, add_ticket_user_access*, update_ticket_user_access*, delete_ticket_user_access*, get_ticket_time_entries, create_ticket_time_entry*, list_time_entries, update_time_entry*, toggle_timer*, delete_time_entry*, list_surveys, list_satisfaction_ratings, list_ticket_satisfaction_ratings, create_satisfaction_rating*, list_csat_surveys, list_survey_responses, create_survey_response*, send_outbound_message*, get_outbound_message

**Contacts and companies** (42): get_contacts, get_contact, search_contacts, search_contacts_autocomplete, create_contact*, update_contact*, delete_contact*, hard_delete_contact*, restore_contact*, send_contact_invite*, merge_contacts*, update_contact_make_agent*, export_contacts*, get_contact_export, get_imported_contacts, get_contact_import, import_contact*, cancel_contact_import*, get_contact_fields, view_contact_field, create_contact_field*, update_contact_field*, delete_contact_field*, get_companies, get_company, search_companies, search_companies_autocomplete, create_company*, update_company*, delete_company*, export_companies*, get_company_export, list_company_imports, get_company_import, import_companies*, cancel_company_import*, get_company_fields, view_company_field, create_company_field*, update_company_field*, delete_company_field*, publish_contact_activity*

**Team** (37): currently_authenticated_agent, get_agents, get_agent, search_agents, create_agent*, create_multiple_agents*, update_agent*, delete_agent*, list_agents_availability, get_agent_availability, update_agent_availability*, create_service_account*, list_api_keys, create_api_key*, view_api_key, update_api_key*, delete_api_key*, rotate_api_key*, list_all_skills, view_skill, create_skill*, update_skill*, delete_skill*, list_roles, view_role, list_groups, view_group, create_group*, update_group*, delete_group*, list_admin_groups, view_admin_group, create_admin_group*, update_admin_group*, delete_admin_group*, list_all_agents_in_a_group, patch_admin_groups_agents*

**Knowledge base, canned responses, forums** (66): list_solution_categories, view_solution_category, create_solution_category*, update_solution_category*, delete_solution_category*, list_translated_solution_categories, get_translated_solution_category, create_translated_solution_category*, update_translated_solution_category*, list_solution_folders, list_solution_subfolders, view_solution_folder, create_solution_folder*, update_solution_folder*, delete_solution_folder*, list_solutions_category_folders_translated, list_translated_subfolders, view_translated_solution_folder, create_translated_solution_folder*, update_translated_solution_folder*, list_solution_articles, search_solution_articles, view_solution_article, create_solution_article*, update_solution_article*, delete_solution_article*, list_translated_solution_articles, view_translated_solution_article, create_translated_solution_article*, update_translated_solution_article*, get_canned_response_folders, get_canned_response_folder, get_folder_responses, create_canned_response_folder*, update_canned_response_folder*, view_a_canned_response, create_canned_response*, update_canned_response*, create_canned_response_bulk*, list_discussions, get_discussion_category, create_discussion_category*, update_discussion_category*, delete_discussion_category*, list_forums_in_category, create_forum*, view_forum, update_discussion_forum*, delete_discussion_forum*, monitor_forum*, delete_discussions_forums_follow*, get_forum_follow_status, list_discussions_topics, create_discussion_forum_topic*, get_discussion_topic, update_discussion_topic*, delete_discussion_topic*, monitor_topic*, delete_discussions_topics_follow*, get_topic_follow_status, list_monitored_topics, list_participated_topics, list_topic_comments, create_discussion_topic_comment*, update_discussion_comment*, delete_discussion_comment*

**Set-up and admin** (67): get_account, export_account*, get_job, export_audit_log*, get_audit_log_export, view_helpdesk_settings, list_ticket_fields, list_admin_ticket_fields, view_ticket_field, create_admin_ticket_field*, update_admin_ticket_field*, delete_ticket_field*, list_all_sections_for_ticket_field, list_specific_section_details, create_admin_ticket_field_section*, update_admin_ticket_field_section*, delete_section*, list_ticket_forms, view_ticket_form, create_ticket_form*, update_ticket_form*, delete_ticket_form*, clone_ticket_form*, view_ticket_form_field, update_ticket_form_field*, delete_ticket_form_field*, list_email_configs, view_email_config, list_email_mailboxes, get_email_mailbox, create_email_mailbox*, update_email_mailbox*, delete_email_mailbox*, view_email_settings, update_email_settings*, view_notification_email_bcc, update_notification_email_bcc*, list_products, view_product, get_business_hours, view_business_hour, list_sla_policies, create_sla_policies*, update_sla_policies*, list_automation_rules, view_automation_rule, create_automation_rule*, update_automation_rule*, delete_automation_rule*, list_scenario_automations, list_custom_objects, get_custom_object, list_custom_object_records, count_custom_object_records, get_custom_object_record, create_custom_object_record*, update_custom_object_record*, delete_custom_object_record*, create_thread*, get_thread, update_thread*, delete_thread*, create_thread_message*, get_thread_message, update_thread_message*, delete_thread_message*, get_thread_message_quoted_text
