# Zendesk coverage

Source: Zendesk's own OpenAPI specs, generated 2026-11-22 by `bun scripts/openapi-actions.ts zendesk`: the Support API
(developer.zendesk.com/zendesk/oas.yaml, 675 operations), the Help Center API (developer.zendesk.com/help_center/oas.yaml,
188) and the Talk API (developer.zendesk.com/voice/oas.yaml, 60). 919 operations are actions, plus 85 written by hand
from the API reference for APIs none of the specs include. Composio's Zendesk toolkit (484 tools, 2 triggers) was the
benchmark: every one of its tools and triggers has a match here except the two below.

## Deliberately left out

| What | Why |
| --- | --- |
| API tokens list/create/update/delete (4) | Zendesk marks them deprecated in the spec |
| Composio's get_guide_surveys, get_guide_survey_responses | Not in any of Zendesk's published specs or its API reference that we could find; added once Zendesk documents them |
| Zendesk Chat, Sunshine Conversations (messaging), Sell, Explore, WFM, QA | Separate products with their own hosts and logins (OAuth clients or app keys); not callable with a Support API token |

## Hand adjustments (scripts/openapi/zendesk.ts, own/zendesk/)

- Calls go to the person's own https://<subdomain>.zendesk.com with basic auth `email/token:TOKEN`; only *.zendesk.com hosts.
- About a hundred writes have no request body in the spec (custom roles, targets, OAuth clients, support addresses,
  routing attributes…). Each takes an optional `body`, sent whole, e.g. `{"custom_role": {...}}`.
- create_zendesk_attachments (POST /uploads) sends the file itself with its own type. Macro, article and suspended-ticket
  attachments go up as forms (`attachment` / `file`, with `filename` / `inline`).
- Two operations share the id UpdateAttributeValue (PUT and PATCH); the PATCH one is update_attribute_value2.
- Lookups that are POSTs run without asking: tag and user autocomplete, view previews and counts, custom object and
  asset searches, problem autocomplete, trigger validation (see `reads`).
- Names follow Composio's wherever one means the same call (`rename` in the script).
- By hand (hand.ts), because no spec has them: the Webhooks API, side conversations, apps and app installations,
  business-hours schedules and holidays, customer profiles and events, help center themes; plus three conveniences:
  reply_zendesk_ticket (reply or internal note, with status/assignee), download_attachment (the file into the chat's
  computer) and list_help_center_content (categories → sections → articles).

## Auth

| Method | Status |
| --- | --- |
| Subdomain + agent email + API token (Admin Center → Apps and integrations → APIs → API tokens), pasted on one line | done |
| OAuth | not built, by choice for this run: key sign-in only |

## Triggers

Webhooks (own/zendesk/triggers.ts), the moment it happens, 104 of them: one per Zendesk event type,
named after it (`zen:event-type:ticket.comment_added` → ticket_comment_added). Only an admin's login can set up
webhooks; others are told so and pointed at the polled ones. One webhook per connection (named "Emplio"), subscribed to
the events its automations use; removed when the last one goes. Each request must carry our URL token and a valid
Zendesk signature (base64 HMAC-SHA256 of timestamp + body with the webhook's signing secret, fetched once and kept in
memory). Ticket triggers can filter by status, group_id, brand_id and tag.

- Tickets (37): ticket_created, ticket_comment_added, ticket_status_changed, ticket_custom_status_changed,
  ticket_priority_changed, ticket_agent_assignment_changed, ticket_group_assignment_changed, ticket_tags_changed,
  ticket_subject_changed, ticket_description_changed, ticket_type_changed, ticket_requester_changed,
  ticket_submitter_changed, ticket_organization_changed, ticket_brand_changed, ticket_form_changed,
  ticket_custom_field_changed, ticket_external_id_changed, ticket_email_ccs_changed, ticket_followers_changed,
  ticket_problem_link_changed, ticket_task_due_at_changed, ticket_sla_policy_changed, ticket_ola_policy_changed,
  ticket_next_sla_breach_changed, ticket_schedule_changed, ticket_comment_made_private, ticket_comment_redacted,
  ticket_attachment_linked_to_comment, ticket_attachment_redacted_from_comment, ticket_marked_as_spam, ticket_merged,
  ticket_soft_deleted, ticket_permanently_deleted, ticket_undeleted, ticket_csat_requested, ticket_csat_received
- People (27): user_created, user_deleted, user_merged, user_*_changed (name, alias, details, notes, external_id,
  custom_field, tags, time_zone, photo, role, custom_role, default_group, only_private_comments, active, suspended,
  last_login, password), user_identity_created/changed/deleted, user_group_membership_created/deleted,
  user_organization_membership_created/deleted
- Organizations (6): organization_created, organization_deleted, organization_name_changed,
  organization_external_id_changed, organization_custom_field_changed, organization_tags_changed
- Help center articles (11) and community posts (14): article_published/unpublished/author_changed/subscription_created,
  article_vote_*, article_comment_*, community_post_created/changed/published/unpublished/subscription_created,
  community_post_vote_*, community_post_comment_*, community_post_comment_vote_created/changed
- Agent availability (9): agent_state_changed, agent_unified_state_changed, agent_work_item_added/updated/removed,
  agent_max_capacity_changed, agent_channel_created/deleted, agent_groups_updated

Not covered: Zendesk's omnichannel config, messaging live metrics, messaging ticket and access-log event families
(streams about Zendesk's own routing setup, live chat dashboards and sign-in logs, not about the business's work; add
them to EVENTS in triggers.ts if someone needs one).

Polled (polls/zendesk.ts), for anyone, every 5 minutes by default, through search (optional extra search words):
new_zendesk_ticket_trigger, new_user_trigger (Composio's names), zendesk_ticket_updated (id + updated_at),
new_zendesk_organization.

## Not tried live

No Zendesk account was used: sign-in, webhook delivery and signature, and the polled search are tested with fetch faked.

## Actions

`*` = asks first (changes something). By the spec's groups:

- **Account Settings**: show_email_settings, update_email_settings*, get_account_settings, update_zendesk_account_settings*
- **Activity Stream**: get_zendesk_activities, show_activity, get_activities_count
- **Addresses**: list_addresses, create_address*, show_address, update_address*, delete_address*
- **Applications**: list_applications, get_application, create_access_request*, get_latest_access_request, get_application_access_status, list_application_filters
- **Approval Requests**: create_approval_clarification_flow_message*, show_approval_clarification_flow_messages, list_approval_requests, create_approval_request*, show_approval_request, decide_approval_request*, withdraw_approval_workflow_instance*
- **Article Attachments**: list_article_attachments_by_locale, list_article_block_attachments_by_locale, list_article_inline_attachments_by_locale, list_article_attachments, create_article_attachment*, show_article_attachment_in_article, list_article_block_attachments, list_article_inline_attachments, create_unassociated_attachment*, get_article_attachment, delete_article_attachment*
- **Article Comments**: list_article_comments_by_locale, create_comment*, show_article_comment_by_locale, update_article_comment_by_locale*, delete_article_comment_by_locale*, list_article_comments, create_article_comment*, show_article_comment, update_article_comment*, delete_article_comment*, list_article_comments_by_user
- **Article Labels**: list_article_labels_by_locale, create_label_by_locale*, delete_label_from_article_by_locale*, list_article_labels, create_label*, delete_label_from_article*, list_labels, show_label, delete_label*
- **Articles**: list_articles_by_locale, get_localized_article, update_article*, archive_article_by_locale*, associate_attachments_in_bulk_to_article_by_locale*, update_article_source_locale_by_locale*, list_articles_in_category_by_locale, list_articles_in_section_by_locale, create_article*, list_articles, get_article, update_article_no_locale*, archive_article*, associate_attachments_in_bulk_to_article*, update_article_source_locale*, list_articles_in_category, list_articles_incrementally, list_articles_in_section, create_article_in_section*, list_articles_by_user
- **Attachments**: get_attachment, update_zendesk_attachment*, delete_attachment*, redact_comment_attachment*, create_zendesk_attachments*, delete_upload*
- **Audit Logs**: list_audit_logs, show_audit_log, export_audit_logs*
- **Automations**: list_automations, create_automation*, get_automation, update_automation*, delete_automation*, list_active_automations, delete_many_automations*, get_automations_search, update_many_automations*
- **Availabilities**: get_voice_availability, update_availability*
- **Basics**: open_ticket_in_agent_s_browser*, open_users_profile_in_agent_browser*, create_zendesk_ticket_or_voicemail_ticket*
- **Bookmarks**: list_bookmarks, create_bookmark*, delete_zendesk_bookmark*
- **Brand Agents**: list_brand_agents, create_brand_agent_membership*, show_brand_agent_membership, delete_brand_agent_membership*, get_brands_agents, get_users_brand_agents, show_brand_agent_membership_by_user
- **Brand User Migrations**: list_brand_user_migrations, create_brand_user_migration*, show_brand_user_migration
- **Brands**: get_brands, create_brand*, get_brands2, update_brand*, delete_brand*, check_host_mapping_validity_for_existing_brand, update_brand_logo*, delete_brand_logo*, check_host_mapping_validity
- **Call Console**: show_call_console_information
- **Callback Requests**: create_callback_request*
- **Calls**: create_call_object*, retrieve_single_call_by_id, update_call*, creates_voice_comment_on_ticket*
- **Categories**: list_categories_by_locale, create_category_by_locale*, show_category_by_locale, update_category_by_locale*, delete_category_by_locale*, update_category_source_locale_by_locale*, list_categories, create_category*, show_category, update_category*, delete_category*, update_category_source_locale*
- **Channel Framework**: report_channelback_error_to_zendesk*, push_content_to_support*, validate_token*
- **Content Subscriptions**: list_post_subscriptions, create_post_subscription*, show_post_subscription, delete_post_subscription*, list_topic_subscriptions, create_topic_subscription*, show_topic_subscription, update_topic_subscription*, delete_topic_subscription*, list_article_subscriptions_by_locale, create_article_subscription_by_locale*, show_article_subscription_by_locale, delete_article_subscription_by_locale*, list_section_subscriptions_by_locale, create_section_subscription_by_locale*, show_section_subscription_by_locale, delete_section_subscription_by_locale*, list_article_subscriptions, create_article_subscription*, show_article_subscription, delete_article_subscription*, list_section_subscriptions, create_section_subscription*, show_section_subscription, delete_section_subscription*, list_content_subscriptions_by_user
- **Conversation Log**: get_tickets_conversation_log
- **Countries**: list_countries_and_calling_codes, show_country
- **Custom Object Fields**: list_zendesk_custom_object_fields, create_zendesk_custom_object_field*, show_custom_object_field, update_zendesk_custom_object_field*, delete_zendesk_custom_object_field*, reorder_custom_object_fields*, get_custom_object_fields_limit
- **Custom Object Permissions**: list_zendesk_access_rules, create_access_rule*, show_access_rule, update_access_rule*, delete_access_rule*, list_access_rule_definitions, list_zendesk_permission_policies, show_permission_policy, update_permission_policy*
- **Custom Object Record Attachments**: list_custom_object_record_attachments, create_custom_object_record_attachment*, update_custom_object_record_attachment_for_malware*, delete_custom_object_record_attachment*, download_custom_object_record_attachment
- **Custom Object Records**: create_custom_object_bulk_job*, list_custom_object_records, create_custom_object_record*, upsert_custom_object_record_by_external_id_or_name*, delete_custom_object_record_by_external_id_or_name*, show_custom_object_record, update_custom_object_record*, delete_zendesk_custom_object_record*, autocomplete_custom_object_record_search, count_zendesk_custom_object_records, search_custom_object_records, filtered_search_of_custom_object_records, show_custom_object_record_by_unique_identifier, update_custom_object_record_by_unique_identifier_put*, update_custom_object_record_by_unique_identifier*, get_custom_object_records_limit, list_incremental_custom_object_records
- **Custom Objects**: list_zendesk_custom_objects, create_zendesk_custom_object*, show_custom_object, update_custom_object*, delete_zendesk_custom_object*, get_custom_objects_limit
- **Custom Roles**: get_zendesk_custom_roles, create_custom_role*, show_custom_role, update_custom_role*, delete_custom_role*
- **Custom Ticket Statuses**: set_default_custom_status*, get_custom_statuses, create_custom_statuses*, get_custom_status, update_custom_status*, delete_zendesk_custom_status*, create_ticket_form_statuses_for_custom_status*, show_many_custom_ticket_statuses
- **Dashboard**: get_account_level_activity, get_agent_level_activity, get_queue_level_activity
- **Deletion Schedules**: list_deletion_schedules, create_deletion_schedule*, get_deletion_schedule, update_deletion_schedule*, delete_deletion_schedule*
- **Digital lines**: create_digital_line*, show_digital_line, update_digital_line*, delete_digital_line*
- **Dynamic Content**: get_dynamic_content_items, create_dynamic_content_items*, get_dynamic_content_item_show, update_zendesk_dynamic_content_item*, delete_zendesk_dynamic_content_item*, get_dynamic_content_items_show_many
- **Dynamic Content Item Variants**: get_dynamic_content_items_variants, create_dynamic_content_items_variants*, get_dynamic_content_item_variant, update_dynamic_content_items_variant*, delete_zendesk_dynamic_content_item_variant*, create_many_dynamic_content_items_variants*, update_dynamic_content_items_variants*
- **Email Notifications**: list_email_notifications, get_email_notification, get_email_notifications_show_many
- **Global Clients**: list_global_oauth_clients, show_global_oauth_client, show_token_summary_for_global_oauth_clients
- **Grant Type Tokens**: create_token_for_grant_type*
- **Greetings**: list_greeting_categories, show_greeting_category, list_greetings, create_greeting*, show_greeting, update_greeting*, delete_greeting*, get_greeting_audio_file
- **Group Memberships**: get_group_memberships, create_group_memberships*, get_group_membership, delete_group_membership*, list_assignable_group_memberships, bulk_create_memberships*, delete_group_memberships_destroy_many*, get_group_memberships_by_group, list_assignable_group_memberships_by_group, get_users_group_memberships, create_group_membership_for_user*, get_users_group_memberships_by_id, delete_users_group_memberships*, set_group_membership_as_default*
- **Group SLA Policies**: list_group_sla_policies, create_group_sla_policy*, show_group_sla_policy, update_group_sla_policy*, delete_group_sla_policy*, retrieve_supported_filter_definition_items, reorder_group_sla_policies*, list_ticket_group_sla_policy_metrics
- **Groups**: list_groups, create_zendesk_group*, get_group, update_group*, delete_group*, get_groups_assignable, autocomplete_groups, list_available_agents, get_groups_count, show_default_group, get_users_groups, get_users_groups_count
- **Help Center Search**: unified_search, embeddable_widget_search, search_help_center_articles, search_posts, list_suggested_articles, list_featured_articles
- **Help Center Sessions**: show_help_center_session
- **Incremental Export**: get_incremental_sample, get_incremental_organizations, get_incremental_ticket_events, get_incremental_tickets, get_incremental_tickets_cursor, get_incremental_users, get_incremental_users_cursor
- **Incremental Exports**: get_incremental_voice_calls, incremental_call_legs_export
- **Incremental Skill Based Routing**: get_incremental_routing_attribute_values, get_incremental_routing_attributes, get_incremental_routing_instance_values
- **ITAM Asset Fields**: list_asset_fields, show_asset_field, list_fields, create_field*, show_field, update_field*, delete_field*
- **ITAM Asset Locations**: list_asset_locations, create_asset_location*, show_asset_location, update_asset_location*, delete_asset_location*
- **ITAM Asset Statuses**: list_asset_statuses, create_asset_status*, show_asset_status, update_asset_status*, delete_asset_status*
- **ITAM Asset Types**: list_asset_types, create_asset_type*, show_asset_type, update_asset_type*, delete_asset_type*
- **ITAM Assets**: list_assets, create_asset*, show_asset, update_asset*, delete_asset*, asset_bulk_jobs*, search_assets, filtered_search_of_assets
- **IVR Menus**: list_ivr_menus, create_ivr_menu*, show_ivr_menu, update_ivr_menu*, delete_ivr_menu*
- **IVR Routes**: list_ivr_routes, create_ivr_route*, show_ivr_route, update_ivr_route*, delete_ivr_route*
- **IVRs**: list_ivrs, create_ivr*, show_ivr, update_ivr*, delete_ivr*
- **Job Statuses**: get_job_statuses, get_job_statuses2, show_many_job_statuses
- **Lines**: list_lines
- **Locales**: list_locales, get_locale, get_locales_agent, get_locales_current, detect_best_locale, get_public_locales
- **Lookup Relationships**: get_sources_by_target, filter_definitions
- **Macros**: get_macros, create_macro*, get_macro2, update_macro*, delete_macro*, get_macros_apply, get_macro_attachments, create_macro_attachment*, get_macros_actions, get_macros_active, create_unassociated_macro_attachment*, show_macro_attachment, download_macro_attachment, get_macro_categories, get_macro_definitions, delete_macros_destroy_many*, list_macro_groups, list_most_used_macros, get_macro_replica, get_macros_search, update_many_macros*, apply_zendesk_macro
- **OAuth Clients**: list_clients, create_client*, show_client, update_client*, delete_client*, generate_secret*, list_current_user_s_clients
- **OAuth Tokens**: list_tokens, show_token, revoke_token*, get_current_oauth_token, revoke_current_token*, revoke_many_tokens*
- **Object Triggers**: list_object_triggers, create_object_trigger*, get_object_trigger, update_object_trigger*, delete_zendesk_object_trigger*, list_active_object_triggers, list_object_triggers_definitions, delete_many_object_triggers*, search_object_triggers, update_many_object_triggers*
- **Omnichannel Routing Queues**: list_queues, create_queue*, show_queue, update_queue*, delete_queue*, list_queue_definitions, reorder_queues*
- **Organization Fields**: get_organization_fields, create_organization_field*, get_organization_field2, update_organization_field*, delete_organization_field*, reorder_organization_field*
- **Organization Memberships**: list_organization_memberships, create_organization_membership*, get_organization_membership2, delete_organization_membership*, create_organization_memberships_create_many*, delete_many_organization_memberships*, list_organization_memberships_by_organization, get_users_organization_memberships, create_organization_membership_for_user*, get_users_organization_memberships2, delete_organization_membership_for_user*, make_default_organization_membership*, unassign_user_organization*, set_users_organization_as_default*
- **Organization Subscriptions**: list_organization_subscriptions, create_organization_subscription*, get_organization_subscription, delete_organization_subscription*, get_zendesk_organizations_subscriptions, get_users_organization_subscriptions
- **Organizations**: get_zendesk_organization_merge, get_all_zendesk_organizations, create_zendesk_organization*, get_zendesk_organization, update_zendesk_organization*, delete_zendesk_organization*, create_organization_merge*, get_organizations_merges, get_organization_related, get_organizations_autocomplete, count_zendesk_organizations, create_many_organizations*, create_or_update_organization*, destroy_many_organizations*, search_zendesk_organizations, get_organizations_show_many, update_many_organizations*, get_users_organizations, get_users_organizations_count
- **Phone numbers**: list_phone_numbers, create_phone_number*, show_phone_number, update_phone_number*, delete_phone_number*, search_for_available_phone_numbers
- **Post Comments**: list_post_comments, create_post_comment*, show_comment, update_comment*, delete_comment*, list_post_comments_by_user, show_post_comment_by_locale
- **Posts**: list_posts, create_post*, show_post, update_post*, delete_post*, list_posts_in_topic, list_posts_by_user
- **Push Notification Devices**: create_push_notification_devices_destroy_many*
- **Recordings**: delete_recording*, delete_recording_by_type*
- **Remote Authentications**: get_remote_authentications
- **Requests**: get_organization_requests, get_zendesk_requests, create_zendesk_request*, show_request, update_zendesk_requests*, get_request_comments, get_requests_comment, get_requests_ccdb, get_open_requests, get_requests_search, get_requests_solved, get_users_requests
- **Reseller**: create_trial_account*, verify_subdomain_availability
- **Resource Collections**: list_resource_collections, create_resource_collection*, show_resource_collection, update_resource_collection*, delete_resource_collection*
- **Satisfaction Ratings**: get_satisfaction_ratings, show_satisfaction_rating, get_satisfaction_ratings_count, create_satisfaction_rating*
- **Satisfaction Reasons**: list_reasons_for_satisfaction_rating, show_reason_for_satisfaction_rating
- **Saved Searches**: list_saved_searches, create_saved_search*, update_saved_search*, delete_saved_search*
- **Search**: search_zendesk, get_search_count, get_search_export
- **Sections**: list_sections_in_category_by_locale, create_section*, list_sections_by_locale, show_section_by_locale, update_section*, delete_section_by_locale*, update_section_source_locale_by_locale*, list_sections_in_category, create_section_in_category*, list_sections, show_section, update_section_no_locale*, delete_section*, update_section_source_locale*
- **Security Settings**: get_security_settings
- **Service Catalog Items**: list_service_catalog_items, show_service_catalog_item, search_service_catalog_items
- **Sessions**: get_zendesk_sessions, get_user_sessions, delete_users_sessions*, show_session, delete_user_session*, delete_users_me_logout*, get_users_me_session, renew_session
- **Sharing Agreements**: get_zendesk_sharing_agreements, create_sharing_agreement*, show_sharing_agreement, update_sharing_agreement*, delete_sharing_agreement*
- **Skill Based Routing**: get_routing_agents_instance_values, set_agent_attribute_values*, list_attribute_values_for_many_agents, bulk_set_agent_attribute_values_jobs*, list_routing_attributes, create_attribute*, show_attribute, update_attribute*, delete_attribute*, list_routing_attribute_values, create_attribute_value*, show_attribute_value, update_attribute_value*, update_attribute_value2*, delete_attribute_value*, list_routing_attribute_definitions, list_tickets_fulfilled_by_user, list_ticket_attribute_values, set_ticket_attribute_values*
- **SLA Policies**: list_sla_policies, create_sla_policy*, show_sla_policy, update_sla_policy*, delete_sla_policy*, retrieve_sla_policy_filter_definition_items, reorder_sla_policies*, get_ticket_sla_policy_metrics
- **Stats**: show_account_overview, list_agents_activity, show_agents_overview, show_current_queue_activity
- **Support Addresses**: list_support_addresses, create_support_address*, get_support_address, update_support_address*, delete_zendesk_support_address*, verify_support_address*
- **Suspended Tickets**: get_zendesk_suspended_tickets, show_suspended_ticket, delete_suspended_ticket*, recover_suspended_ticket*, suspended_ticket_attachments*, bulk_recover_suspended_tickets*, delete_suspended_tickets_destroy_many*, create_suspended_tickets_export*, recover_many_suspended_tickets*
- **Tags**: get_autocomplete_tags, create_autocomplete_tags, get_organization_tags, create_organizations_tags*, update_organizations_tags*, delete_organizations_tags*, get_tags, get_tags_count, get_zendesk_tickets_tags, set_tags*, update_tickets_tags*, delete_tickets_tags*, get_users_tags, create_users_tags*, update_users_tags*, delete_users_tags*
- **Target Failures**: list_target_failures, get_target_failure
- **Targets**: list_targets, create_zendesk_target*, get_target, update_target*, delete_target*
- **Task List Templates**: list_task_list_templates, create_task_list_template*, show_task_list_template, update_task_list_template*, delete_task_list_template*, get_tasks_by_task_list_template_id
- **Task Lists**: show_task_list, update_custom_task_list*, delete_task_list*, list_task_items, create_custom_task_item*, show_task_item, update_task_item*, delete_custom_task_item*, list_parent_ticket_references, create_subticket*, list_linked_tickets, link_existing_ticket*, unlink_ticket*, show_task_lists_for_ticket, create_task_list*
- **Ticket Audits**: list_ticket_audits, get_tickets_audits, get_ticket_audit_by_id, make_comment_private*, get_tickets_audits_count
- **Ticket Comments**: redact_chat_comment_attachment*, redact_chat_comment*, create_comment_redaction*, get_ticket_comments, make_ticket_comment_private*, redact_string_in_comment*, get_tickets_comments_count
- **Ticket Content Pins**: list_ticket_content_pins, create_ticket_content_pin*, delete_content_pin_from_ticket*
- **Ticket Fields**: get_ticket_fields, create_ticket_field*, get_ticket_field2, update_ticket_field*, delete_ticket_field*, get_zendesk_ticket_fields_options, create_ticket_field_option*, get_zendesk_ticket_fields_options2, delete_ticket_field_option*, get_ticket_fields_count, reorder_ticket_fields*, get_ticket_fields_show_many
- **Ticket Form Statuses**: list_ticket_form_statuses, show_many_ticket_form_statuses, delete_ticket_form_statuses*, delete_ticket_form_status_by_id*
- **Ticket Forms**: get_ticket_forms, create_ticket_form*, get_zendesk_ticket_form, update_ticket_form*, delete_ticket_form*, clone_already_existing_ticket_form*, list_ticket_form_statuses_of_ticket_form, create_ticket_form_statuses*, bulk_update_ticket_form_statuses_of_ticket_form*, update_ticket_form_status_by_id*, reorder_ticket_forms*, get_ticket_forms_show_many
- **Ticket Import**: create_zendesk_import_ticket*, create_imports_tickets_create_many*
- **Ticket Metric Events**: get_incremental_ticket_metric_events, list_ticket_metric_events_by_ticket
- **Ticket Metrics**: list_ticket_metrics, get_ticket_metrics, show_ticket_metrics_by_ticket
- **Ticket Skips**: list_skips, record_new_skip_for_current_user*, get_ticket_skips, get_users_skips
- **Tickets**: get_deleted_tickets, delete_deleted_ticket*, restore_zendesk_ticket*, destroy_many_deleted_tickets*, restore_many_tickets*, get_organization_tickets, get_organizations_tickets_count, get_problems, autocomplete_problems, list_zendesk_tickets, create_zendesk_ticket*, get_zendesk_ticket_by_id, update_zendesk_ticket*, delete_zendesk_ticket*, get_ticket_collaborators, get_ticket_email_c_cs, get_ticket_followers, get_ticket_incidents, mark_ticket_as_spam_and_suspend_requester*, merge_zendesk_tickets*, get_zendesk_ticket_related, autocomplete_tickets, get_tickets_count, create_many_tickets*, bulk_delete_tickets*, mark_many_tickets_as_spam*, show_ticket_by_messaging_conversation_id, get_recent_tickets, show_many_tickets, update_many_tickets*, get_users_assigned_tickets, get_user_tickets_assigned_count, get_users_ccd_tickets, count_user_ccd_tickets, get_users_followed_tickets, get_users_requested_tickets
- **Topics**: list_topics, create_topic*, show_topic, update_topic*, delete_topic*
- **Translations**: list_article_translations, create_translation*, get_article_translation, update_article_translation*, list_missing_translations, list_category_translations, create_category_translation*, show_category_translation, update_category_translation*, list_missing_category_translations, list_enabled_locales_and_default_locale, list_section_translations, create_section_translation*, show_section_translation, update_section_translation*, list_missing_section_translations, delete_translation*
- **Trigger Categories**: get_trigger_categories, create_trigger_category*, get_trigger_categories2, update_trigger_category*, delete_trigger_category*, create_trigger_categories_job*
- **Triggers**: list_ticket_triggers, create_trigger*, get_trigger, update_ticket_trigger*, delete_trigger*, list_ticket_trigger_revisions, show_ticket_trigger_revision, get_active_triggers, get_triggers_definitions, bulk_delete_ticket_triggers*, show_ticket_trigger_limits, reorder_triggers*, get_triggers_search, update_many_triggers*, validate_ticket_trigger
- **User Fields**: get_user_fields, create_zendesk_user_field*, get_user_field_by_id, update_user_field*, delete_user_field*, get_user_field_options, create_user_field_option*, show_user_field_option, delete_user_field_option*, reorder_user_field*, get_user_fields_show_many
- **User Identities**: get_end_user_identities, create_end_user_identity*, get_end_user_identity, delete_end_user_identity*, make_end_user_identity_primary*, request_end_user_verification*, list_user_identities, create_user_identity*, get_users_identities2, update_users_identity*, delete_users_identity*, make_user_identity_primary*, request_user_verification*, verify_user_identity*
- **User Images**: create_image_path*, create_image_upload_url_and_token*
- **User Passwords**: set_user_s_password*, change_password*, get_users_password_requirements
- **User Segments**: list_user_segments, create_user_segment*, show_user_segment, update_user_segment*, delete_user_segment*, list_sections_with_user_segment, list_topics_with_user_segment, list_applicable_user_segments, list_user_segments_by_user
- **User Subscriptions**: list_user_subscriptions_by_user, create_user_subscription*, delete_user_subscription*
- **Users**: list_deleted_users, get_deleted_user, delete_user_permanently*, count_deleted_users, get_group_users, get_groups_users_count, get_organization_users, get_organization_users_count, list_zendesk_users, create_zendesk_user*, get_user, update_user*, delete_zendesk_user*, get_users_compliance_deletion_statuses, get_user_entitlements_full, merge_users*, get_users_related, show_user_s_suspension, create_user_suspension*, update_user_s_suspension*, delete_user_suspension*, get_users_autocomplete, autocomplete_users, get_users_count, create_many_users*, create_or_update_user*, create_or_update_many_users*, delete_users_destroy_many*, create_users_logout_many*, get_about_me, get_users_me_settings, update_users_me_settings*, request_user_create*, search_zendesk_users, show_many_users, update_many_users*
- **Views**: get_views, create_view*, show_view, update_view*, delete_view*, get_view_ticket_count, get_views_execute, get_views_export, get_views_tickets, get_views_active, get_views_compact, get_views_count, get_views_count_many, get_view_definitions, delete_many_views*, create_views_preview, create_views_preview_count, get_views_search, get_views_show_many, update_many_views*
- **Voice Settings**: show_voice_settings, update_voice_settings*
- **Votes**: downvote_post_comment*, upvote_post_comment*, list_post_comment_votes, downvote_post*, upvote_post*, list_post_votes, list_article_comment_votes_by_locale, create_vote*, list_article_votes_by_locale, downvote_article_comment*, upvote_article_comment*, list_article_comment_votes, downvote_article*, upvote_article*, list_article_votes, list_votes_by_user, list_votes, show_vote, delete_vote*
- **WhatsApp Templates**: list_whats_app_templates, toggle_whats_app_template*, list_whats_app_template_languages, bulk_toggle_whats_app_templates*
- **Workspaces**: list_workspaces, create_workspace*, show_workspace, update_workspace*, delete_workspace*, bulk_delete_workspaces*, reorder_workspaces*
- **X Channel**: list_monitored_twitter_handles, show_monitored_x_handle, create_ticket_from_tweet*, list_ticket_statuses

By hand: list_webhooks, create_webhook*, show_webhook, update_webhook*, patch_webhook*, delete_webhook*, test_webhook*, show_webhook_signing_secret*, reset_webhook_signing_secret*, list_webhook_invocations, list_webhook_invocation_attempts, list_ticket_side_conversations, get_zendesk_tickets_side_conversation_id, create_side_conversation*, reply_to_side_conversation*, update_side_conversation*, get_tickets_side_conversations_events, get_side_conversations_events, import_side_conversation*, import_side_conversation_events*, upload_side_conversation_attachment*, redact_side_conversation_attachment*, list_apps, get_owned_apps, get_app, get_apps_public_key, get_apps_public_key_pem, upload_app_package*, create_app*, update_app*, delete_app*, get_apps_job_status, create_apps_notify*, list_app_installations, list_app_installations_of_app, get_app_installation, create_apps_installation*, update_apps_installation*, delete_zendesk_app_installation*, get_apps_installations_requirements, get_apps_installation_job_status, list_app_locations, get_apps_location, get_apps_location_installations, reorder_location_installations*, list_business_hours_schedules, get_business_hours_schedule, create_business_hours_schedule*, update_business_hours_schedule*, delete_business_hours_schedule*, update_schedule_workweek*, list_schedule_holidays, get_schedule_holiday, create_schedule_holiday*, update_schedule_holiday*, delete_schedule_holiday*, get_users_profiles, get_user_profiles2, get_user_profile_by_identifier, update_users_profiles*, replace_user_profile*, replace_user_profile_by_id*, update_user_profile*, update_user_profile_by_id*, delete_user_profile*, update_profile_namespace*, delete_profile_namespace*, get_user_events, list_user_event_types, get_user_profile_events, get_user_profiles_events2, create_user_event*, create_user_profiles_events*, create_user_profile_event_by_id*, list_guide_themes, get_guide_theme, publish_guide_theme*, delete_guide_theme*, get_guide_theme_job, create_theme_import_job*, create_theme_update_job*, create_theme_export_job*, reply_zendesk_ticket*, download_attachment, list_help_center_content
