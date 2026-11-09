# HubSpot coverage

Source: HubSpot's API catalog (api.hubspot.com/public/api/spec/v1/specs, 127 specs), generated 2026-11-09 by
`bun scripts/openapi-actions.ts hubspot`. 1052 actions from the catalog (actions.json is about 3.2 MB and loads in about 0.4 s
with all apps), plus 7 hand-written, 7 polled triggers. For each spec the numbered version is used (HubSpot keeps those stable), else its
current dated one. Scheduler Meetings uses the dated version because every numbered operation there is deprecated.

## Deliberately left out

| What | Why |
| --- | --- |
| OAuth, Webhooks, Webhooks Journal, Public App Feature Flags, Public App CRM Cards, App Uninstalls, Video Conferencing Extension, Calling Extensions, Transcriptions, Media Bridge, Custom Channels, Actions V4, Timeline | App-developer APIs: they need a developer account's key or only make sense for an app plugged into HubSpot. A private app token can't call them |
| At Debug, At Tests | HubSpot's own API test endpoints |
| Lead Scoring, AEO, Commerce Contracts | Developer preview on dated betas only; HubSpot turns them on per account on request |
| Other deprecated or developer-key operations | Listed in `skipped` in actions.json (marketing event app settings, deprecated source-code call) |

## Composio names not matched, and why

| Composio's | Status |
| --- | --- |
| add/remove/update_token_on_event_template, create_event_template_for_app, delete_timeline_event_template, get_event_template, list_event_templates, update_event_template, create_timeline_event(_batch), retrieve_timeline_event_by_ids, render_event_* | Timeline API, deprecated and developer-key only |
| configure/delete/update_calling_extension_settings, retrieve_calling_settings_for_app, fetch_recording_settings, set_call_recording_settings, update_calling_app_recording_settings, *_video_conference_* | Developer-app settings, developer key only |
| create_feedback_submission, update_feedback_submission, archive/create/update batches of feedback submissions, merge_feedback_submissions | HubSpot's API only reads feedback submissions |
| merge_emails, merge_line_items, merge_products, merge_quotes | `merge_objects` (any object type) |
| delete_company_gdpr, delete_deal_gdpr, delete_line_items_gdpr | `delete_crm_object_gdpr` with the object type |
| permanently_delete_contact_via_gdpr | `delete_contact_gdpr`, the same call |
| create_engagement, get_engagement, list_all_engagements, list_associated_engagements, list_recently_modified_engagements | Old Engagements API; `create_call`, `create_meeting`, `create_note`, `create_task`, `search_*` and the associations calls replace it |
| list_company_activities, list_company_calls, list_company_meetings, list_contact_notes, list_contact_tasks, list_deal_activities, list_deal_meetings | Conveniences over `search_*` with an association filter |
| read_legacy_contact_profile(s...) | Old Contacts API; `read_contact` and `read_contacts` replace it |
| create_contact_from_nl, create_deal_from_nl, create_crm_object_from_nl | Composio's natural-language wrappers; Emplio fills the fields itself |
| create_content_template, list_content_templates, get_workflow_revision, purge_schema, list_association_types, list_granted_scopes | Not in HubSpot's published catalog |
| batch_create_contact_company_associations, batch_create_deal_company_associations | `batch_create_default_associations` |
| list_automation_flows, retrieve_page_of_crm_owners, search_campaigns, who_am_i, list_contact_properties, list_email_campaign_ids, get_communication_status | The same as `get_workflows`, `retrieve_owners`, `get_campaigns` (with its name filter), `get_account_info`, `read_all_properties_for_object_type`, `list_email_campaigns`, `get_email_subscription_status` |

## Hand adjustments (scripts/openapi/hubspot.ts, own/hubspot/index.ts)

- CRM object calls are named from the path (`list_contacts`, `create_contact`, `read_contact`, `search_contacts_by_criteria`...), under Composio's name where it differs. Other calls take the summary's words, or `CALLS` for Composio's name.
- Lookups that are POSTs run without asking: `/search`, `.../read` and `/idmapping`.
- HubSpot's specs mark `associations` required on every create; it isn't, so it's optional here.
- Hand-written, from older APIs that still run: enroll_contact_in_workflow, get_contact_workflow_enrollments, list_email_events, list_email_campaigns, list_form_submissions, remove_contact_secondary_email, list_call_dispositions.

## Auth

| Method | Status |
| --- | --- |
| Private app access token, sent as a Bearer token | done |
| OAuth | not in this job |

## Triggers

All polled through CRM search (`polls/hubspot.ts`), because webhooks need a developer app: contact_created_trigger, contact_updated_trigger, company_created_trigger, deal_created_trigger, deal_updated_trigger, ticket_created_trigger, deal_stage_updated_trigger (settings: pipeline, stage). The stage trigger ignores a deal whose stage was entered more than a day ago, so editing an old deal doesn't look like a move.

## Actions by group (* asks first)

**account-info** (5): list_audit_logs, list_login_activity, retrieve_security_history, get_private_app_daily_api_usage, get_account_info

**analytics** (42): search_dashboards, create_dashboard*, batch_archive_dashboards*, batch_restore_dashboards*, batch_update_dashboard_business_units*, batch_update_dashboard_owners*, batch_update_dashboard_permissions*, get_dashboard, update_dashboard*, batch_add_reports_to_dashboard*, clone_dashboard*, export_dashboard*, add_report_to_dashboard*, remove_report_from_dashboard*, list_favorites, add_favorite*, set_favorites*, remove_favorite*, create_recurring_dashboard_export*, batch_delete_recurring_dashboard_exports*, batch_update_recurring_dashboard_export_owners*, search_recurring_dashboard_exports, get_recurring_dashboard_export, delete_recurring_dashboard_export*, update_recurring_dashboard_export*, create_recurring_report_export*, batch_delete_recurring_report_exports*, batch_update_recurring_report_export_owners*, search_recurring_report_exports, get_recurring_report_export, delete_recurring_report_export*, update_recurring_report_export*, search_reports, batch_archive_reports*, batch_restore_reports*, batch_update_report_business_units*, batch_update_report_owners*, batch_update_report_permissions*, get_report, update_report*, clone_report*, export_report*

**associations** (15): retrieve_association_limits, retrieve_association_limits_configurations, configure_association_limits*, remove_association_limits*, update_association_limits*, list_association_labels, update_association_label*, create_association_label*, delete_association_label*, report_high_usage*, remove_associations*, batch_create_default_associations*, associate_records_labelled_associations*, batch_archive_association_labels*, read_associations_batch

**audit-logs** (1): get_audit_logs

**auto-associations** (3): batch_upsert*, retrieve_auto_association_customization, retrieve_auto_association_defaults

**automation** (18): get_workflows, create_workflow*, batch_read_workflows, retrieve_workflow_email_campaigns, get_workflow_performance, get_workflow_by_id, update_workflow*, delete_workflow*, batch_read_workflow_id_mappings, list_sequences, enroll_contact_in_sequence*, retrieve_enrollment_status_of_contact, retrieve_details_for_sequence, list_templates, create_email_templates*, list_folders_email_templates, retrieve_template, update_template*

**blog-settings** (9): retrieve_blogs, add_blog_to_multi_language_group*, create_language_variation_from_existing_blog*, remove_blog_from_multi_language_group*, set_primary_language_to_match_specific_blog*, update_blog_languages*, retrieve_blog, get_blog_revisions, get_specific_blog_revision

**blogs** (52): get_blog_authors, create_new_blog_author*, delete_batch_of_blog_authors*, create_batch_of_blog_authors*, retrieve_batch_of_blog_authors, update_batch_of_blog_authors*, attach_blog_author_to_multi_language_group*, post_blogs_authors_multi_language_create_language_variation*, detach_blog_author_from_multi_language_group*, put_blogs_authors_multi_language_set_new_lang_primary*, update_languages_of_multi_language_group_authors*, retrieve_blog_author, delete_blog_author*, update_blog_author*, get_blog_tags, create_new_blog_tag*, delete_batch_of_blog_tags*, create_batch_of_blog_tags*, retrieve_batch_of_blog_tags, update_batch_of_blog_tags*, attach_blog_tag_to_multi_language_group*, post_blogs_tags_multi_language_create_language_variation*, detach_blog_tag_from_multi_language_group*, put_blogs_tags_multi_language_set_new_lang_primary*, update_languages_of_multi_language_group_tags*, retrieve_blog_tag, delete_blog_tag*, update_blog_tag*, list_blog_posts, create_new_post*, delete_batch_of_blog_posts*, create_batch_of_blog_posts*, retrieve_batch_of_blog_posts, update_batch_of_blog_posts*, clone_blog_post*, attach_post_to_multi_language_group*, create_language_variation*, detach_post_from_multi_language_group*, put_blogs_posts_multi_language_set_new_lang_primary*, update_languages_of_multi_language_group_posts*, schedule_blog_post*, get_blog_post, delete_blog_post*, update_post*, retrieve_full_draft_version_of_blog_post, update_draft_of_post*, publish_blog_post_draft*, reset_post_draft_to_live_version*, retrieves_previous_versions_of_post, retrieve_previous_version_of_blog_post, restore_previous_version*, restore_draft_to_previous_version*

**business-units** (1): retrieve_brands_by_associated_user

**commerce** (36): retrieve_price_books, create_price_book*, retrieve_price_book, delete_price_book*, update_price_book*, activate_price_book*, deactivate_price_book*, list_price_book_items, add_price_book_items*, batch_archive_price_book_items*, batch_create_price_book_items*, batch_update_price_book_items*, retrieve_price_book_item, delete_price_book_item*, update_price_book_item*, validate_price_book*, create_payment*, retry_payment*, retrieve_status, retrieve_billing_settings, update_billing_settings*, retrieve_checkout_fees, update_checkout_fees*, delete_checkout_fee*, retrieve_policy_settings, update_policy_settings*, retrieve_shipping_settings, update_shipping_settings*, retrieve_payment_method_settings, update_payment_method_settings*, retrieve_status_and_general_information_about_portal_s_payments_account, retrieve_payment_links, create_payment_link*, retrieve_payment_link, delete_payment_link*, update_payment_link*

**communication-preferences** (10): retrieve_subscription_status_definitions, generate_subscription_links*, batch_read_statuses_communication_preferences, batch_unsubscribe_contacts_from_subscriptions*, batch_read_statuses_unsubscribe, batch_update_subscription_status*, get_email_subscription_status, update_email_subscriptions*, retrieve_contact_s_unsubscribed_status, unsubscribe_contact_from_subscriptions*

**conversations** (18): replace_conversations_threads_assignee*, delete_conversations_threads_assignee*, get_group_of_actors, get_single_actor, get_channel_accounts, get_single_channel_account, list_conversation_channels, get_single_channel, list_conversation_inboxes, get_single_conversations_inbox, list_conversation_threads, get_single_thread, archives_thread*, update_thread*, get_message_history_for_thread, send_message_to_thread*, get_single_message, get_original_content_of_single_message

**crm-object-schemas** (8): retrieve_all_object_schemas, create_object_schema*, retrieve_multiple_custom_object_schemas_in_batch_request, retrieve_object_schema, delete_schema*, update_object_schema*, create_association*, remove_association_from_schema*

**data-quality** (3): list_duplicate_rules, list_duplicate_groups, list_duplicate_pairs

**data-studio** (8): creates_file_datasource*, creates_json_datasource*, retrieve_data_source, update_data_source*, delete_data_source*, changes_display_name_of_datasource*, adds_additional_records_to_existing_datasource*, updates_json_datasource*

**domains** (2): list_domains, get_single_domain

**events** (12): get_events_events, get_events_events_event_types, send_custom_event_occurrence*, send_batch_of_event_occurrences*, retrieve_event_definitions, create_custom_event_definition*, retrieve_custom_event_definition, delete_event_definition*, update_custom_event_definition*, create_property_for_event_definition*, delete_property_from_custom_event_definition*, update_existing_custom_event_property*

**exports** (3): start_export*, get_crm_export_status, retrieve_details_of_specific_export_by_its_unique_id

**files** (21): upload_file*, import_file_from_url*, get_file_import_status, search_files, retrieve_file_by_path, get_file, replace_file*, delete_file_by_id*, update_file_properties*, get_files_files_download, gdpr_delete_file*, get_signed_url_to_access_private_file, create_folder_folders*, search_folders, update_folder_properties*, check_folder_update_status, retrieve_folder_by_id, delete_folder_by_id*, update_folder_properties_by_folder_id*, retrieve_folder_by_path, delete_folder_by_path*

**folders** (4): list_folders_, post_folders*, retrieve_folder, update_folder*

**forecast-settings** (2): list_forecast_types, retrieve_forecast_type

**forecast-submissions** (1): list_events

**hubdb** (31): get_published_tables, create_table*, return_draft_tables, get_details_of_published_table, archive_table*, get_details_for_draft_table, update_existing_table*, clone_table*, export_draft_table, import_data_into_draft_table*, publish_table_from_draft*, reset_table_draft*, export_published_version_of_table, get_rows_for_table, add_row_to_table*, get_set_of_rows, get_rows_from_draft_table, clone_rows_in_batch*, create_rows_in_batch*, delete_rows*, get_set_of_rows_from_draft_table, replace_rows_in_batch_in_draft_table*, update_rows_in_batch_in_draft_table*, get_table_row, get_row_from_draft_table, replace_existing_row*, permanently_deletes_row*, update_row*, clone_row*, unpublish_table*, delete_table_version*

**imports** (5): get_active_imports_list, start_import*, get_import_record_information, cancel_import*, fetch_import_error_details

**knowledge-base** (15): retrieve_articles, create_article*, retrieve_article, update_article*, retrieve_draft_articles, update_draft*, publish_draft*, unpublish_article*, retrieve_categories, retrieve_category, retrieve_featured_articles_for_category, retrieve_knowledge_bases, retrieve_knowledge_base, retrieve_tags_knowledge_base, retrieve_tag_tags

**limits** (9): read_association_label_limits, read_record_association_limits, read_record_association_limits_from_object, read_record_association_limits_between_two_objects, read_calculation_property_limits, read_custom_object_limits, read_custom_property_limits, read_pipeline_limits, read_record_limits

**lists** (30): get_crm_lists_by_ids, create_list*, retrieves_folder, creates_folder*, move_list_to_folder*, deletes_folder*, moves_folder*, rename_folder*, map_legacy_list_id, translate_legacy_list_id_to_modern_list_id_in_batch, get_crm_list_by_name, batch_read_list_memberships, get_record_list_memberships, search_crm_lists, get_crm_list, delete_crm_list*, get_segment_members, delete_records_from_list*, add_records_to_list*, update_list_memberships*, add_records_from_source_list_to_destination_list*, fetch_list_memberships_ordered_by_added_to_list_date, remove_records_from_list*, restore_list*, retrieve_conversion_details_for_list, schedule_or_update_conversion_of_list_to_static*, cancel_conversion_of_list*, get_lists_size_and_edits_history_between, update_list_filters*, rename_crm_list*

**marketing** (90): get_campaigns, create_campaign*, delete_campaigns_batch*, create_campaigns*, read_batch_of_campaigns, update_campaigns*, get_campaign, delete_campaign*, update_campaign*, list_assets, add_asset_association*, remove_asset_association*, add_budget_item*, read_budget, get_budget_item, update_budget_item*, delete_budget_item*, get_contact_ids, get_campaign_metrics, fetch_revenue, create_campaign_spend_item*, read_campaign_spend_item, update_campaign_spend_item*, delete_campaign_spend_item*, get_marketing_marketing_events, get_lists_associated_with_marketing_event_associations, associate_list_with_marketing_event_lists*, disassociate_list_from_marketing_event_lists*, get_marketing_marketing_events_associations_marketing_event_id_lists, put_marketing_marketing_events_associations_marketing_event_id_lists_list_id*, delete_marketing_marketing_events_associations_marketing_event_id_lists_list_id*, record_participants_by_contact_id_with_marketing_event_external_ids*, record_participants_by_email_with_marketing_event_external_ids*, delete_multiple_marketing_events_by_object_id*, update_multiple_marketing_events_by_object_id*, create_marketing_event*, delete_multiple_marketing_events_by_external_ids*, find_app_specific_marketing_events_by_external_event_id, create_or_update_multiple_marketing_events*, get_marketing_event_by_external_ids, create_or_update_marketing_event*, delete_marketing_event_by_external_ids*, update_marketing_event_by_external_ids*, mark_marketing_event_as_cancelled*, mark_marketing_event_as_completed*, record_subscriber_state_by_contact_email*, record_subscriber_state_by_contact_id*, read_participations_breakdown_by_contact_identifier, read_participations_counters_by_marketing_event_external_identifier, read_participations_breakdown_by_marketing_event_external_identifier, read_participations_counters_by_marketing_event_internal_identifier, get_marketing_event_participation_breakdown, find_marketing_events_by_external_event_id, get_marketing_event_by_object_id, delete_marketing_event_by_object_id*, update_marketing_event_by_object_id*, record_participants_by_contact_id_with_marketing_event_object_id*, record_participants_by_email_with_marketing_event_object_id*, send_email*, send_single_send_transactional_email_asynchronously*, query_smtp_api_tokens_by_campaign_name_or_email_campaign_id, create_smtp_api_token*, query_single_token_by_id, delete_single_token_by_id*, reset_password_of_existing_token*, get_all_marketing_emails_for_a_hubspot_account, create_a_new_marketing_email*, create_ab_test_variation*, clone_marketing_email*, get_aggregated_statistic_intervals, get_aggregated_statistics, get_the_details_of_a_specified_marketing_email, delete_marketing_email*, update_a_marketing_email*, get_ab_email_variation, get_marketing_email_draft, create_or_update_draft_version*, reset_draft*, publish_marketing_email*, get_marketing_email_revisions, get_marketing_email_revision, restore_marketing_email_revision*, restore_email_revision*, unpublish_or_cancel_marketing_email*, get_marketing_forms, create_marketing_forms*, get_form_definition, update_form_definition*, archive_form_definition*, partially_update_form_definition*

**menus** (9): list_menus, create_menu*, retrieve_menu, update_menu*, retrieve_draft_menus, update_draft_menu*, push_draft_live*, reset_draft_menus*, retrieve_revisions

**meta** (4): retrieve_ip_ranges_for_specified_services_and_directions, retrieve_simplified_list_of_ip_ranges_for_specified_services_and_directions, get_meta_network_origins_ip_ranges, get_network_origins_ip_ranges_simple

**notetaker** (1): retrieve_conversation_recap_data

**object-library** (2): get_object_library_enablement, get_object_library_enablement_

**object-tags** (6): retrieve_tags, create_tag*, retrieve_tag, update_tag_replace*, delete_object_tags*, update_tag_partial*

**objects** (12): read_apage_of_objects_by_type, read_crm_object_by_id, retrieve_price_books_objects, retrieve_price_book_objects, create_crm_object_with_properties*, archive_crm_object_by_id*, partially_update_crm_object_by_id*, list, create_objects*, read, archive*, update*

**objects: associations** (7): retrieve_associated_object_ids_for_given_object_type_with_optional_inclusion_of_fully_associated_objects, create_association_between_two_crm_objects*, remove_association_between_two_crm_objects*, associate_records_default*, list_object_associations, create_object_association*, remove_association*

**objects: batch** (11): read_batch_of_crm_objects_by_id_or_property_values, archive_batch_of_objects*, create_batch_of_objects*, read_batch_of_appointments_by_internal_id_or_unique_property_values, update_batch_of_objects_by_idor_property_values*, upsert_crm_objects*, archive_batch_of_objects_by_id*, create_batch_of_objects_*, read_batch_of_objects_by_internal_id_or_unique_property_values, update_batch_of_objects_by_internal_id_or_unique_property_values*, create_or_update_batch_of_objects_by_unique_property_values*

**objects: calls** (11): list_calls, create_call*, archive_calls*, create_calls*, read_calls, update_calls*, upsert_calls*, search_calls, read_call, delete_call*, update_call*

**objects: carts** (11): list_carts, create_cart*, archive_carts*, create_carts*, read_carts, update_carts*, upsert_carts*, search_carts, read_cart, archive_cart*, update_cart*

**objects: commerce_payments** (11): list_commerce_payments, create_commerce_payment*, archive_commerce_payments*, create_commerce_payments*, read_commerce_payments, update_commerce_payments*, upsert_commerce_payments*, search_commerce_payments, read_commerce_payment, archive_commerce_payment*, update_commerce_payment*

**objects: communications** (11): list_communications, create_communication*, archive_communications*, create_communications*, read_communications, update_communications*, upsert_communications*, search_communications, read_communication, archive_communication*, update_communication*

**objects: companies** (12): list_companies, create_company*, archive_companies*, create_companies*, batch_read_companies_by_properties, update_companies*, upsert_companies*, merge_companies*, search_companies, get_company, archive_company*, update_company*

**objects: contacts** (13): list_contacts, create_contact*, archive_contacts*, create_contacts*, read_contacts, update_contacts*, upsert_contacts*, delete_contact_gdpr*, merge_contacts*, search_contacts_by_criteria, read_contact, archive_contact*, update_contact*

**objects: contracts** (3): list_contracts, read_contracts, read_contract

**objects: courses** (11): list_courses, create_course*, archive_courses*, create_courses*, read_courses, update_courses*, upsert_courses*, search_courses, read_course, archive_course*, update_course*

**objects: deals** (14): list_deals, create_deal*, archive_deals*, create_deals*, get_deals, update_deals*, upsert_deals*, merge_deals*, search_deals, get_deal, remove_deal*, update_deal*, read_batch_of_deal_split_objects_by_their_associated_deal_object_internal_id, create_or_replace_deal_splits_for_deals_with_provided_ids_deal_split_percentages_for_each_deal_must_sum_up_to_1_0_100_and_may_have_up_to_8_decimal_places*

**objects: discounts** (11): list_discounts, create_discount*, archive_discounts*, create_discounts*, read_discounts, update_discounts*, upsert_discounts*, search_discounts, read_discount, archive_discount*, update_discount*

**objects: emails** (11): list_emails, create_email*, archive_emails*, create_emails*, get_emails, update_emails*, upsert_emails*, search_emails, read_email, archive_email*, update_email*

**objects: feedback_submissions** (4): list_feedback_submissions, read_batch_feedback_submissions_by_id_or_property, search_feedback_submissions, read_feedback_submission_by_id

**objects: fees** (11): list_fees, create_fee*, archive_fees*, create_fees*, read_fees, update_fees*, upsert_fees*, search_fees, read_fee, archive_fee*, update_fee*

**objects: gdpr-delete** (1): delete_crm_object_gdpr*

**objects: goal_targets** (11): list_goal_targets, create_goal_target*, archive_goal_targets*, create_goal_targets*, read_goal_targets, update_goal_targets*, upsert_goal_targets*, search_goal_targets, read_goal_target, archive_goal_target*, update_goal_target*

**objects: invoices** (11): list_invoices, create_invoice*, archive_invoices*, create_invoices*, read_invoices, update_invoices*, upsert_invoices*, search_invoices, read_invoice, archive_invoice*, update_invoice*

**objects: leads** (11): list_leads, create_lead*, archive_leads*, create_leads*, read_leads, update_leads*, upsert_leads*, search_leads, read_lead, archive_lead*, update_lead*

**objects: line_items** (11): retrieve_line_items, create_line_item*, archive_batch_of_line_items*, create_line_items*, read_batch_of_line_items_by_id_or_property_values, update_line_items*, upsert_line_items*, search_line_items_by_criteria, retrieve_line_item_by_id, archive_line_item*, update_line_item*

**objects: listings** (11): list_listings, create_listing*, archive_listings*, create_listings*, read_listings, update_listings*, upsert_listings*, search_listings, read_listing, archive_listing*, update_listing*

**objects: meetings** (11): list_meetings, create_meetings*, archive_meetings*, create_batch_of_meetings*, read_meetings, update_meetings*, upsert_meetings*, search_meetings, read_meeting, delete_meeting*, update_meeting*

**objects: merge** (2): merge_objects*, merge_two_objects_with_same_type*

**objects: notes** (11): list_notes, create_note*, archive_notes*, create_notes*, read_notes, update_notes*, upsert_notes*, search_notes, read_note, delete_note*, update_note*

**objects: orders** (11): list_orders, create_order*, archive_orders*, create_orders*, read_orders, update_orders*, upsert_orders*, search_orders, read_order, archive_order*, update_order*

**objects: partner_clients** (9): list_partner_clients, read_partner_clients, update_partner_clients*, search_partner_clients, read_partner_client, update_partner_client*, list_associations_of_partner_client_by_type, associate_partner_client_with_another_object*, remove_association_between_two_partner_clients*

**objects: partner_services** (9): list_partner_services, read_partner_services, update_partner_services*, search_partner_services, read_partner_service, update_partner_service*, list_associations_of_partner_service_by_type, associate_partner_service_with_another_object*, remove_association_between_two_partner_services*

**objects: postal_mail** (11): list_postal_mail, create_postal_mail*, archive_postal_mail*, create_postal_mail_batch_create*, read_postal_mail, update_postal_mail*, upsert_postal_mail*, search_postal_mail, get_objects_postal_mail, delete_objects_postal_mail*, update_objects_postal_mail*

**objects: products** (11): list_products, create_product*, archive_products*, create_products*, get_products, update_products*, upsert_products*, search_products, get_product, archive_product*, update_product*

**objects: projects** (12): list_projects, create_project*, archive_projects*, create_projects*, read_projects, update_projects*, upsert_projects*, merge_projects*, search_projects, read_project, archive_project*, update_project*

**objects: quotes** (11): list_quotes, create_quote_object*, archive_batch_of_quotes*, create_batch_of_quotes*, read_batch_of_quotes_by_property_values, batch_update_quotes*, upsert_quotes*, search_quotes_by_criteria, get_quote, archive_quote*, update_quote*

**objects: search** (2): search_crm_objects_by_criteria, search_for_crm_objects_of_specified_type

**objects: services** (11): list_services, create_service*, archive_services*, create_services*, read_services, update_services*, upsert_services*, search_services, read_service, archive_service*, update_service*

**objects: subscriptions** (11): list_subscriptions, create_subscription*, archive_subscriptions*, create_subscriptions*, read_subscriptions, update_subscriptions*, upsert_subscriptions*, search_subscriptions, read_subscription, archive_subscription*, update_subscription*

**objects: tasks** (11): list_tasks, create_task*, archive_tasks*, create_tasks*, read_tasks, update_tasks*, upsert_tasks*, search_tasks, read_task, delete_task*, update_task*

**objects: taxes** (11): list_taxes, create_tax*, archive_taxes*, create_taxes*, read_taxes, update_taxes*, upsert_taxes*, search_taxes, read_tax, archive_tax*, update_tax*

**objects: tickets** (12): list_tickets, create_ticket*, archive_tickets*, create_tickets*, get_tickets, update_tickets*, upsert_tickets*, merge_tickets*, search_tickets, get_ticket, archive_ticket*, update_ticket*

**objects: users** (11): list_users, create_user*, archive_users*, create_users*, read_users, update_users*, upsert_users*, search_users, read_user, archive_user*, update_user*

**owners** (2): retrieve_owners, retrieve_owner_by_id_or_user_id

**pages** (72): get_pages_landing_pages_cursor, get_landing_pages_cursor_query, get_landing_pages_folders_cursor, get_folders_cursor_query, get_pages_site_pages_cursor, get_site_pages_cursor_query, list_landing_pages, create_landing_page*, create_new_b_test_variation_ab_test*, end_active_b_test_ab_test*, rerun_previous_b_test_ab_test*, delete_landing_pages*, create_landing_pages*, retrieve_landing_pages, update_landing_pages*, clone_landing_page*, get_landing_page_folders, create_landing_page_folder*, delete_folders*, create_folders*, retrieve_folders, update_folders*, retrieve_landing_page_folder, delete_landing_page_folder*, update_landing_page_folder*, retrieves_previous_versions_of_folder, retrieve_previous_version_of_folder, restore_previous_version_of_folder*, add_landing_page_to_multi_language_group*, create_new_language_variation_multi_language*, remove_landing_page_from_multi_language_group*, set_new_primary_language_multi_language*, update_languages_of_multi_language_group_landing_pages*, schedule_landing_page*, get_landing_page, delete_landing_page*, update_landing_page*, get_landing_page_draft, update_landing_page_draft*, push_landing_page_draft_edits_live*, reset_landing_page_draft*, list_landing_page_revisions, retrieve_previous_version_of_landing_page, restore_previous_version_of_landing_page_landing_pages*, post_pages_landing_pages_object_id_revisions_revision_id_restore_to_draft*, list_site_pages, create_site_page*, post_pages_site_pages_ab_test_create_variation*, post_pages_site_pages_ab_test_end*, post_pages_site_pages_ab_test_rerun*, delete_website_pages*, create_website_pages*, retrieve_website_pages, update_website_pages*, clone_website_page*, add_website_page_to_multi_language_group*, post_pages_site_pages_multi_language_create_language_variation*, remove_website_page_from_multi_language_group*, put_pages_site_pages_multi_language_set_new_lang_primary*, update_languages_of_multi_language_group_site_pages*, schedule_website_page_to_be_published*, get_site_page, delete_website_page*, update_site_page*, get_site_page_draft, update_site_page_draft*, publish_site_page_draft*, reset_draft_of_website_page*, retrieve_previous_versions_of_website_page, retrieve_previous_version_of_website_page, restore_previous_version_of_website_page*, restore_previous_draft_of_website_page*

**payments-subscriptions** (3): cancel_subscription*, pause_subscription*, unpause_subscription*

**pipelines** (14): retrieve_all_pipelines_for_specified_object_type, create_pipeline*, get_pipeline_by_id, replace_all_properties_of_pipeline*, delete_pipeline*, update_pipeline*, audit_pipeline_changes, retrieve_pipeline_stages, create_pipeline_stage*, retrieve_pipeline_stage_by_id, replace_pipeline_stage_properties*, delete_pipeline_stage*, update_pipeline_stage*, get_pipeline_stage_audit

**pipelines-rules** (8): retrieve_rules, update_rules_replace*, delete_pipelines_rules*, update_rules_partial*, start_approval*, retrieve_approval, retrieve_permissions, update_permissions*

**properties** (13): read_all_properties_for_object_type, create_property_for_specified_object_type*, archive_batch_of_properties*, create_batch_of_properties*, read_batch_crm_object_properties, read_property_groups_for_object_type, create_and_return_a_new_property_group*, read_property_group, archive_property_group*, update_property_group*, read_a_crm_property_by_name, archive_property_by_object_type_and_name*, update_crm_property*

**property-validations** (4): read_property_validation_rules_for_object, read_validation_rules_for_property, read_validation_rule, update_validation_rule*

**scheduler** (5): create_meeting*, list_meeting_links, book_meeting*, retrieve_availability, retrieve_booking_info

**schemas** (12): list_properties, create_property*, batch_archive_properties*, batch_create_properties*, batch_purge_properties*, batch_read_properties, batch_restore_properties*, batch_update_properties*, resolve_externally_sourced_options, retrieve_property, delete_property*, update_property*

**settings** (31): list_teams, create_team*, retrieve_team, delete_team*, update_team*, list_members, add_team_members*, batch_assign_members*, delete_member*, list_settings_users, create_settings_users*, list_user_roles, see_details_about_this_account_s_teams, get_settings_user, modifies_user*, remove_settings_user*, add_new_currency_with_central_exchange_rates*, retrieve_information_about_central_exchange_rates_feature, retrieve_currencies_not_supported_by_central_exchange_rates, get_currency_codes, get_company_currency, set_or_update_company_currency*, get_exchange_rates, add_new_exchange_rate*, create_multiple_exchange_rates*, retrieve_multiple_rates, update_multiple_exchange_rates*, get_current_exchange_rates, change_visibility_of_specific_currency_pairs*, get_details_for_specific_exchange_rate, update_conversion_rate*

**site-search** (2): search_cms_content, get_indexed_properties

**source-code** (7): extract_zip_file*, get_extraction_status, download_cms_source_file, create_or_update_file*, delete_file*, get_cms_source_metadata, validate_contents_of_file*

**task-series** (4): create_task_series*, retrieve_task_series, delete_task_series*, update_task_series*

**tax-rates** (2): get_tax_rates, get_specific_tax_rate

**url-mappings** (4): get_url_mappings_url_mappings, create_url_mappings_url_mappings*, get_url_mappings_url_mappings_, delete_url_mappings_url_mappings*

**url-redirects** (5): get_url_redirects, create_url_redirects*, get_details_for_redirect, delete_redirect*, update_redirect*

**visitor-identification** (1): generate_visitor_token*

