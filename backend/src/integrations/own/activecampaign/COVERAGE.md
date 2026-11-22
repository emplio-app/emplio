# ActiveCampaign coverage

Source: ActiveCampaign's own OpenAPI specs from its docs site (developers.activecampaign.com/openapi/v3.json, sms.json,
v2.json, trackcmp.json), generated 2026-11-22 by `bun scripts/openapi-actions.ts activecampaign`. Every operation is an
action (578): all 575 of v3 but one, the two SMS exports only sms.json has, the v2 template share link, and event
tracking. Plus four by hand (index.ts): graphql_query, graphql_mutation, get_api and call_api. 582 in all.

## Deliberately left out

| What | Why |
| --- | --- |
| POST /settings/developer (reset an API key) | Resets the key Emplio is connected with, which would disconnect it |
| sms.json's 15 other calls | The same calls are in v3 |
| WhatsApp spec (whatsapp.yml) | Hilos's API with its own key (app.hilos.io), not the ActiveCampaign key |
| Partners API (partners.json) | The agency partner hub, its own login; for agencies, not businesses |
| OAuth sign-in | ActiveCampaign offers it only to CX apps listed in its marketplace; key sign-in only |

Composio's 49 unmatched names (coverage.ts, 2026-11-22), and where each is:

- Ecommerce GraphQL (products, browse sessions, recurring payments, upserts): add_browse_session_cart, save_browse_session,
  search_browse_session, create_product, update_product, delete_product, get_product_by_id, search_product, upsert_products,
  search_recurring_payment, upsert_recurring_payments_bulk, upsert_order, upsert_orders_bulk, upsert_orders_bulk_async →
  graphql_query / graphql_mutation (that API is GraphQL only; its schema is read by introspection).
- v3 paths ActiveCampaign doesn't document: labels and label associations (create_label, list_labels,
  create/delete/list_label_automation_associations, list_label_campaign_folder_associations), campaign link data and MPP
  data, get_campaign_aggregate_revenues, get_campaign_user, get_campaign_automations, get_campaign_automation_campaign_lists,
  list_automation_campaigns, list_automation_site_messages, get_message_campaign_association, segment counts
  (get_recent_segment_counts, get_segment_count_by_timestamp, get_segment_count_history), list_segments,
  get_users_by_group, get_user_configs, list_order_subscriber_conversions, list_bulk_import_status, upsert_account → get_api / call_api.
- Same call under another name, or a Composio duplicate: add_contact_note = create_note_on_contact, create_contact_task =
  create_deal_task (relType Subscriber), find_contact_task = list_tasks with filters, list_deals2 = retrieve_all_deals, retrieve_an_order = get_order, retrieve_deal_activities =
  list_deal_activities, update_field_value = update_custom_field_value_for_contact, manage_contact_tag =
  add_tag_to_contact / remove_tag_from_contact, test_tracking_event = track_event.

## Hand adjustments (scripts/openapi/activecampaign.ts, own/activecampaign/)

- The key is the API URL and the API key on one line (`https://acme.api-us1.com 1a2b...`, either order; a bare account
  name works too). Calls go only to `<account>.api-us<N>.com` or `<account>.activehosted.com`; the key rides in
  `Api-Token`. Every spec's `{youraccountname}` host becomes the person's own.
- track_event goes to trackcmp.net as a form (the spec says JSON), with the account's actid and event key from Website →
  Site tracking, and without the API key. `{"success": 0}` on a 200 counts as a failure.
- Writes the spec gives no body (segments, settings, form opt-in, SMS 10DLC forms...) take one whole as `body`.
- Lookups that are POSTs run unasked: preview_campaign_message, check_contact_bulk_edit_before_running_it,
  create_match_all_request_for_new_segment, create_match_some_request, get_broadcast_metrics, create_metrics_snapshot.
- retrieve_api_credentials asks first: it shows the API key.
- About 230 actions take Composio's names (`rename`); the rest come from the spec's summaries through `namer`.
- graphql_query refuses mutations, so it can run unasked; graphql_mutation asks. get_api / call_api take a path under
  /api/3 only (no `..`).
- No retry on ActiveCampaign's limit of 5 requests a second per account; a 429 comes back as an error.

## Auth

| Method | Status |
| --- | --- |
| API URL + key (Settings → Developer), sent as Api-Token | done |
| OAuth | not offered to us (marketplace CX apps only) |

## Plans

The API and webhooks work on every ActiveCampaign plan, but each call only reaches what the account has: deals,
pipelines, accounts and tasks need a plan with the CRM (Plus and up); SMS needs the SMS add-on; site and event tracking,
custom objects and some AI calls need higher plans. A call outside the plan comes back as ActiveCampaign's error.

## Triggers

Webhooks (triggers.ts): one per connection, made through the API, carrying every event its automations want, from all four
sources (public, admin, api, system). ActiveCampaign doesn't sign webhooks, so the URL holds a token worked out from
ENCRYPTION_KEY and the connection. Deliveries are forms, turned into nested objects. No delivery id: the body's hash
stands in, so a retry runs once. The last automation removes the webhook. deal_stage_changed, deal_won and deal_lost are
deal_update deliveries whose updated_fields name the stage or status.

| Trigger | Event | Settings |
| --- | --- | --- |
| contact_subscribed | subscribe | source, list_id |
| contact_unsubscribed | unsubscribe | source, list_id |
| contact_updated | update | source, list_id |
| contact_note_added | subscriber_note | source |
| contact_tag_added | contact_tag_added | source, tag |
| contact_tag_removed | contact_tag_removed | source, tag |
| contact_task_added | contact_task_add | source |
| list_created | list_add | source |
| campaign_sent | sent | source, list_id, campaign_id |
| campaign_opened | open | source, list_id, campaign_id |
| link_clicked | click | source, list_id, campaign_id |
| campaign_replied | reply | source, list_id, campaign_id |
| campaign_forwarded | forward | source, list_id, campaign_id |
| campaign_shared | share | source, list_id, campaign_id |
| email_bounced | bounce | source, list_id, campaign_id |
| sms_sent | sms_sent | source |
| sms_replied | sms_reply | source |
| sms_unsubscribed | sms_unsub | source |
| new_deal | deal_add | source, pipeline_id, stage_id, owner_id |
| deal_updated | deal_update | source, pipeline_id, stage_id, owner_id, field |
| deal_stage_changed | deal_update (filtered) | source, pipeline_id, stage_id, owner_id |
| deal_won | deal_update (filtered) | source, pipeline_id, stage_id, owner_id |
| deal_lost | deal_update (filtered) | source, pipeline_id, stage_id, owner_id |
| deal_note_added | deal_note_add | source, pipeline_id, stage_id, owner_id |
| deal_task_added | deal_task_add | source, pipeline_id, stage_id, owner_id |
| deal_task_completed | deal_task_complete | source, pipeline_id, stage_id, owner_id |
| deal_task_type_created | deal_tasktype_add | source, pipeline_id, stage_id, owner_id |
| pipeline_created | deal_pipeline_add | source, pipeline_id, stage_id, owner_id |
| deal_stage_created | deal_stage_add | source, pipeline_id, stage_id, owner_id |
| new_account | account_add | source |
| account_updated | account_update | source |
| account_contact_added | account_contact_add | source |
| account_contact_updated | account_contact_update | source |

Polled every 5 minutes (polls/activecampaign.ts), for what no webhook reports: new_contact (a contact added without joining
a list), new_ecommerce_order, new_tracked_event (site visits and tracked events, optional type).

Composio has no ActiveCampaign triggers, so the names are ours.

Not built: a contact entering an automation (list_recent_automation_entries needs one automation's id, and its rows have no
documented shape).

## Actions by resource (* asks first)

**accountContacts** (5): create_account_contacts*, list_account_contacts, get_account_contact, update_account_contact*, delete_account_contacts*

**accountCustomFieldData** (7): create_account_custom_field_data*, list_account_custom_field_data, create_bulk_account_custom_field_data*, update_account_custom_field_data_bulk*, get_account_custom_field_data, update_account_custom_field_data*, delete_account_custom_field_data*

**accountCustomFieldMeta** (5): create_account_custom_field_meta*, list_account_custom_field_meta, get_account_custom_field_meta, update_account_custom_field_meta*, delete_account_custom_field_meta*

**accounts** (8): create_account*, list_all_accounts, delete_accounts_bulk*, update_account*, retrieve_account, delete_account*, create_account_note*, update_account_note*

**activities** (2): get_contact_events_and_activities, get_activity_entry

**activityRecipients** (4): list_activity_recipients, retrieve_activity_recipient, retrieve_activity_of_activity_recipient, retrieve_recipient_of_activity_recipient

**addressGroups** (6): list_address_group_associations, create_address_group_association*, delete_association_by_address_and_group*, get_address_group_association, update_address_group_association*, delete_address_group*

**addressLists** (6): list_address_list_associations, create_address_list_association*, delete_association_by_address_and_list*, get_address_list_association, update_address_list_association*, delete_address_list_association*

**addresses** (5): create_address*, list_addresses, get_address, update_address*, delete_address*

**ai** (25): save_automation_from_drafted_schema*, list_automation_starts_and_steps_for_ai_build, draft_automation_from_prompt*, check_whether_automation_can_be_edited, edit_automation_from_prompt*, create_brand_kit*, list_brand_kits, get_primary_brand_kit, get_brand_kit, update_brand_kit*, delete_brand_kit*, get_brand_kit_history, get_brand_kit_competitors, set_primary_brand_kit*, refresh_brand_kit_tone*, get_brand_kit_tone, update_ai_instruction_of_account*, create_ai_instruction_of_account*, delete_ai_instruction_of_account*, list_ai_instructions_of_account, get_ecommerce_customer_behavior_summary, get_ecommerce_order_status_summary, get_ranked_ecommerce_products, get_ecommerce_revenue_summary, get_contact_trends_for_list

**audiences** (2): list_audiences, get_audiences

**automations** (7): list_automations, bulk_edit_automations*, get_automation, get_automation_blocks, get_automation_triggers, list_automation_contacts, get_contact_automation_steps

**bounceLogs** (1): list_bounce_logs

**brandings** (3): list_brandings, get_branding, update_branding*

**businessGoals** (2): list_business_goal_data, get_business_goal_data

**calendars** (5): create_calendars*, list_calendars, get_calendar, update_calendar*, delete_calendar*

**campaign** (1): create_campaign*

**campaignMessages** (3): create_campaign_message*, update_campaign_message*, delete_campaign_message*

**campaigns** (20): list_campaigns, delete_multiple_campaigns*, preview_campaign_message, send_test_of_campaign*, schedule_campaign*, pause_sending_campaign*, retrieve_report_totals_of_campaign, list_contacts_whose_campaign_email_bounced, list_forwards_of_campaign, list_contacts_who_opened_campaign, list_contacts_who_did_not_open_campaign, list_contacts_who_unsubscribed_through_campaign, resume_paused_campaign*, stop_campaign*, get_campaign_by_id, get_campaign_messages, create_duplicate_campaign*, delete_campaign*, edit_campaign*, get_campaign_links

**channel** (13): list_whats_app_templates, update_whats_app_template*, delete_whats_app_template*, get_whats_app_template, send_whats_app_template*, list_flow_executions, list_flow_execution_contacts, get_flow_execution_contact_by_id, get_flow_execution, create_flow_execution*, list_conversations, partially_update_conversation*, update_conversation*

**configs** (1): update_configs*

**connections** (5): create_connection*, retrieve_all_connections, retrieve_connection, update_connection*, delete_connection*

**contact** (5): bulk_sync_contacts*, bulk_edit_contacts*, check_contact_bulk_edit_before_running_it, merge_contacts*, create_or_update_contact*

**contactArchives** (8): list_archived_contacts, permanently_delete_several_archived_contacts*, restore_matching_archived_contacts*, list_running_contact_restores, restore_archived_contacts_by_id*, get_contact_restore, get_archived_contact, permanently_delete_archived_contact*

**contactAutomationLogs** (2): list_contact_automation_history_entries, retrieve_contact_automation_history_entry

**contactAutomations** (11): remove_contact_from_automation_by_ids*, list_automations_contact_is_in, add_contact_to_automation*, get_automation_contact_is_in, update_contact_automation*, remove_contact_from_automation*, retrieve_automation_of_contact_automation, list_history_of_contact_automation, retrieve_contact_of_contact_automation, list_goals_reached_in_contact_automation, retrieve_how_contact_automation_ended

**contactConversionPoints** (4): list_contact_conversion_points, retrieve_contact_conversion_point, list_attributions_of_contact_conversion_point, retrieve_contact_of_contact_conversion_point

**contactConversions** (7): list_contact_conversions, retrieve_contact_conversion, list_activities_of_contact_conversion, list_attributions_of_contact_conversion, retrieve_contact_of_contact_conversion, retrieve_conversion_of_contact_conversion, retrieve_trigger_of_contact_conversion

**contactData** (2): list_contact_data_records, get_contact_data_record

**contactDeals** (5): list_contact_deals, add_secondary_contact_to_deal*, get_secondary_contact, update_contact_deals*, delete_secondary_contact*

**contactEmails** (2): list_contact_emails, retrieve_contact_email

**contactGoalLists** (4): list_contact_goal_list_entries, retrieve_contact_goal_list_entry, retrieve_reached_goal_of_contact_goal_list_entry, retrieve_list_of_contact_goal_list_entry

**contactGoalTags** (4): list_contact_goal_tag_entries, retrieve_contact_goal_tag_entry, retrieve_reached_goal_of_contact_goal_tag_entry, retrieve_tag_of_contact_goal_tag_entry

**contactGoals** (8): list_goal_completions, retrieve_goal_completion, retrieve_automation_of_goal_completion, retrieve_contact_of_goal_completion, retrieve_contact_automation_of_goal_completion, list_lists_of_goal_completion, list_tags_of_goal_completion, retrieve_goal_of_goal_completion

**contactImports** (2): list_contact_import_log_rows, get_contact_import_log_row

**contactLists** (4): list_contact_subscriptions_to_lists, add_contact_to_list*, get_contact_list_subscription, update_contact_list_subscription*

**contactLogs** (2): list_contact_log_entries, retrieve_contact_log_entry

**contactTags** (4): list_contact_tag_associations, add_tag_to_contact*, get_contact_tag_association, remove_tag_from_contact*

**contacts** (30): list_all_contacts, create_contact*, delete_multiple_contacts*, get_contact_notes, create_note_on_contact*, delete_note_from_contact*, update_note_on_contact*, remove_contact_tag_by_name*, apply_contact_tags*, remove_contact_tag_by_id*, find_contact, update_contact*, delete_contact*, get_contact_account_contacts, get_contact_automation_entry_counts, get_contact_bounce_logs, get_contact_automations, get_contact_data, get_contact_deal_associations, get_contact_data_goals, get_contact_lists, get_contact_logs, get_contact_tags, get_contact_deals, get_contact_field_values, get_contact_geo_ips_list, get_contact_organization, get_contact_plus_append, get_contact_score_values, get_contact_tracking_logs

**content-proxy** (8): search_content_manager_files, get_content_manager_file, get_folders_containing_file, list_keywords_on_content_manager_file, list_content_manager_folders, get_content_manager_folder, list_files_in_content_manager_folder, list_files_with_keyword

**content** (2): check_email_authentication_of_from_address_domain, get_editor_markup

**conversions** (21): list_conversions, create_conversion*, list_conversion_statistics, create_conversion_label*, list_conversion_labels, bulk_create_conversion_labels*, bulk_delete_conversion_labels*, set_conversion_target_for_business_goal*, get_conversion_label, update_conversion_label*, delete_conversion_label*, disable_conversion_label_goal*, list_conversion_metrics, disable_conversion_target_for_business_goal*, get_conversion, update_conversion*, delete_conversion*, partially_update_conversion*, get_conversion_statistics, get_conversion_metrics, get_daily_conversion_trends

**customObjects** (14): list_records_for_schema, create_or_update_custom_object_record*, delete_record_by_external_id*, get_record_by_external_id, get_record_by_id, delete_record_by_id*, list_all_schemas, create_custom_object_schema*, create_public_custom_object_schema*, get_schema_by_id, delete_schema*, create_child_schema*, update_schema*, delete_custom_object_schema_field*

**dashboardWidgets** (5): list_dashboard_widgets, generate_new_dashboard_widget_from_prompt*, insert_or_replace_dashboard_widget*, delete_dashboard_widget*, redesign_dashboard_widget_from_prompt*

**dealActivities** (1): list_deal_activities

**dealCustomFieldData** (7): set_deal_custom_field_value*, list_deal_custom_field_data, bulk_create_custom_deal_field_value*, bulk_update_deal_custom_field_values*, get_deal_custom_field_data, update_deal_custom_field_data*, delete_deal_custom_field_data*

**dealCustomFieldMeta** (5): create_deal_custom_field_meta*, list_deal_custom_field_meta, get_deal_custom_field_meta, update_deal_custom_field_meta*, delete_deal_custom_field_meta*

**dealGroup** (1): get_inaccessible_pipelines_by_user

**dealGroups** (5): create_deal_pipeline*, list_dealgroups, get_deal_pipeline, update_deal_groups*, delete_deal_pipeline*

**dealRoles** (3): list_deal_roles, create_deal_role*, delete_deal_role*

**dealStages** (6): create_deal_stage*, list_deal_stages, get_deal_stage, update_deal_stage*, delete_deal_stage*, update_dealstages_deals*

**dealTasks** (5): create_deal_task*, list_tasks, get_deal_task, update_deal_task*, delete_deal_tasks*

**dealTasktypes** (6): create_deal_task_type*, list_deal_task_types, get_deal_task_type, update_deal_task_type*, delete_deal_task_type*, move_tasks_to_another_task_type*

**deals** (9): retrieve_all_deals, create_deal*, update_deal_owners_bulk*, retrieve_a_deal, update_a_deal*, delete_deal*, get_deal_notes, create_a_deal_note*, update_a_deal_note*

**ecomCustomers** (5): create_customer*, retrieve_all_customers, retrieve_customer, update_customer*, delete_customer*

**ecomOrderProducts** (2): list_order_products, retrieve_an_order_product

**ecomOrders** (6): create_an_order*, retrieve_all_orders, get_order, delete_an_order*, update_an_order*, retrieve_all_products_for_order

**emailActivities** (1): list_email_activities

**eventTracking** (2): update_event_tracking_status*, get_event_tracking_status

**eventTrackingEvents** (3): create_event_tracking_event*, list_all_events_name_only, delete_event*

**fieldDetails** (3): list_standard_field_settings, update_standard_field_settings*, patch_standard_field_settings*

**fieldOption** (2): add_custom_field_options*, update_custom_field_options_in_bulk*

**fieldOptions** (5): list_field_options, create_field_option*, get_field_option, update_field_option*, delete_field_option*

**fieldRel** (2): sync_field_list_relationships*, sync_field_list_relationships_by_exclusion*

**fieldRels** (5): get_all_field_relationships, add_field_relationship*, get_field_relationship_to_lists, update_field_relationship_to_lists*, delete_field_relationship*

**fieldValues** (5): set_contact_custom_field_value*, list_all_custom_field_values, get_field_value, update_custom_field_value_for_contact*, delete_field_value*

**fields** (5): list_all_custom_fields2, add_custom_field*, get_custom_field, update_custom_field*, delete_custom_field*

**form** (1): create_form_optin*

**forms** (12): create_form*, list_forms, get_form, update_form*, delete_form*, allow_personal_email_addresses_on_form*, block_personal_email_addresses_on_form*, block_email_domains_on_form*, unblock_email_domain_on_form*, get_form_html, pause_form*, resume_paused_form*

**geoAddresses** (2): list_geographical_addresses, get_geographical_address

**geoIps** (3): list_geographical_ip_entries, get_geographical_ip_entry, get_ip_entry_location

**goal** (2): get_goal_statistics, get_goal_showcase

**goals** (2): list_goals, get_goal

**group** (1): delete_multiple_groups*

**groupDefinitions** (1): create_custom_field_group*

**groupLimits** (1): get_group_limits

**groupMembers** (5): add_custom_field_to_field_group*, list_group_members, update_custom_field_field_group*, delete_custom_field_field_group*, get_custom_field_group_membership

**groups** (5): create_group*, list_groups, get_group_by_id, update_group*, delete_group*

**import** (5): create_import_bulk*, list_bulk_import_status_aggregate, list_import_history, list_import_failures, get_bulk_import_status_info

**initiatives** (7): create_business_goal*, list_business_goals, build_business_goal_from_schema*, archive_multiple_business_goals*, update_business_goal*, get_business_goal, archive_business_goal*

**listGroups** (5): create_list_group_permission*, list_list_group_permissions, get_list_group_permission, update_list_group_permission*, delete_list_group_permission*

**lists** (8): get_lists, create_list*, get_exclusions_list, get_exclusion, update_exclusion*, retrieve_list, delete_list*, update_list*

**message** (1): get_source_of_campaign_message

**messages** (6): list_messages, create_message*, delete_multiple_messages*, retrieve_message, delete_message*, update_message*

**notes** (5): list_notes, create_note*, get_note, update_note*, delete_note*

**persTags** (1): list_personalization_tags

**personalizations** (8): list_variables, create_variable*, delete_variables_bulk*, get_variable, update_edit_variable*, delete_variable*, lock_personalization*, unlock_personalization*

**plusAppends** (2): list_contact_plus_appends, get_contact_plus_append_record

**prism** (3): create_prism_url_whitelist*, list_prism_url_whitelistings, remove_domain_from_whitelist*

**savedResponses** (5): create_saved_response*, list_saved_responses, get_saved_response, update_saved_response*, delete_saved_response*

**scores** (2): list_scores, get_score

**segmentMatch** (2): get_segment_match, get_segment_match_by_external_id

**segmentMatchAll** (3): create_match_all_request_for_new_segment, list_segment_match_all, get_segment_match_all_result

**segmentMatchDetail** (2): explain_segment_match, explain_segment_match_by_external_id

**segmentMatchSome** (2): create_match_some_request, get_segment_match_some_result

**segmentsV2** (7): create_segments_v2*, get_segments_v2, update_segments_v2*, delete_segments_v2*, get_segments_v2_created_date, update_segments_v2_created_date*, translate_segment

**settings** (4): update_account_settings*, get_hosted_account_information, retrieve_api_credentials*, check_dkim_records_of_domain

**siteTracking** (3): get_site_tracking_status, update_site_tracking*, get_site_tracking_code

**siteTrackingDomains** (3): list_all_white_listed_domains, add_domain_to_white_list*, remove_site_tracking_domain*

**sms** (31): list_automation_sms_blocks, get_10dlc_area_code, list_available_10dlc_area_codes, get_brand_form, update_brand_form*, create_brand_form*, list_campaign_forms, create_campaign_form*, get_campaign_form, update_campaign_form*, create_sms_broadcast_message*, list_sms_broadcasts, create_sms_broadcast_with_ai*, update_sms_broadcast_with_ai*, get_ai_broadcast_request_status, list_sms_quiet_hours, create_sms_quiet_hours_window*, update_sms_quiet_hours_window*, get_broadcast_metrics, get_sms_broadcast_metrics_snapshot, create_metrics_snapshot, get_broadcast_metrics_failures, get_broadcast_recipients, delete_sms_broadcast*, get_sms_broadcast, update_sms_broadcast*, get_sms_credits, list_sms_broadcast_lists, retrieve_automation_sms_block, export_broadcast_metrics*, export_broadcast_recipients*

**statsActivityItem** (2): list_recent_activity_items, list_recent_automation_entries

**tags** (5): list_all_tags2, create_a_tag2*, get_tag, update_a_tag*, delete_tag*

**taskNotifications** (2): create_task_reminder*, list_task_reminders

**taskOutcomes** (5): create_taskoutcome*, list_task_outcomes, get_taskoutcome, update_task_outcome*, delete_task_outcome*

**tasktypeOutcomeRels** (5): create_task_type_outcome_relation*, list_task_type_outcome_relations, get_task_type_outcome_relation, update_task_type_outcome_relation*, delete_task_type_outcome_relation*

**templates** (5): create_email_template*, list_email_templates, get_template, delete_email_template*, update_email_template*

**trackingLogs** (3): list_tracked_events_and_their_contacts, get_contact_by_event_id, get_tracking_log_entry

**users** (9): create_user*, list_users, find_user_action, get_logged_in_user, get_user_by_username, get_user, update_user*, delete_user*, create_single_sign_on_token_for_user*

**webhook** (1): list_webhook_events

**webhooks** (5): create_webhook*, list_webhooks, get_webhook, update_webhook*, delete_webhook*

**template** (1): create_shareable_campaign_template_link

**event tracking (trackcmp.net)** (1): track_event*

**hand-written (index.ts)** (4): graphql_query, graphql_mutation*, get_api, call_api*
