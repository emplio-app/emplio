# HighLevel coverage

Source: HighLevel's OpenAPI specs, v3 edition (github.com/GoHighLevel/highlevel-api-docs, `apps/v3/*-v3.json`, 42 areas,
published 2026-06-19), generated 2026-11-22 by `bun scripts/openapi-actions.ts gohighlevel`. Every operation a
private integration token can call is an action (592). Composio's toolkit is `highlevel`; actions carry
its names wherever it has the same call.

## Deliberately left out

| What | Why |
| --- | --- |
| OAuth calls (/oauth/token, /oauth/location-token, /oauth/installed-locations) | Token exchange for Marketplace apps; Emplio signs in with a pasted token |
| Marketplace calls (billing charges, has-funds, app installs, rebilling config, external-auth migration) | They act on a Marketplace app, which a private integration isn't (Composio's check_account_funds is one) |
| GET /social-media-posting/oauth/{platform}/start | Opens a sign-in page for a social account in a browser; social accounts are connected in HighLevel itself. The later steps (list and attach accounts) are actions |
| Deprecated calls (22): old saas-api/public-api, agent-studio public-api, calendar resources, message upload initiate/complete, review reply | HighLevel marks them deprecated and lists replacements, which are actions (Composio's initiate/complete_file_upload, fetch_calendar_resources, get_agent_studio_public_api_agents are these) |
| v2-only calls dropped from the v3 specs: GET /users/ (Composio get_user_by_location), GET /emails/builder (fetch_email_templates), contacts association shortcut (contacts_create_association) | Covered by search_users (with locationId), get_emails_templates, create_relation |
| Webhooks | HighLevel sends webhooks only to Marketplace (OAuth) apps, so every trigger is polled |

## Hand adjustments (scripts/openapi/gohighlevel.ts, own/gohighlevel/index.ts)

- Each call's `Version` header (`v3`, or `2021-07-28` for older calls) is taken from the spec and sent by index.ts, not
  asked of the agent; `2021-07-28` when a call's spec names none (store shipping, funnels, phone numbers).
- `locationId` / `location_id` / `altId` + `altType` are optional everywhere and filled with the connected sub-account.
- The spec gives an empty body for search_contacts, create_record and update_record (custom objects): their fields are
  written from HighLevel's docs.
- Lookups sent as POST run without asking (contact, opportunity, task and record searches, social planner lists…).
- A 401 that's about a scope or a route private tokens can't use isn't treated as a dead token.
- Names: Composio's list is read from its toolkit page directly (the shared composioNames() finds nothing there now), plus
  `rename` for calls whose summary differs from Composio's.

## Auth

| Method | Status |
| --- | --- |
| Sub-account private integration token + Location ID, pasted as "token locationId" | done |
| Agency private integration token alone (agency calls; each sub-account call then needs its locationId) | done, polled triggers need a sub-account key |
| OAuth (Marketplace app) | not built: key sign-in only for now |

## Triggers (all polled, every 5 minutes by default)

new_contact, contact_updated, contact_tag_added, new_opportunity, opportunity_stage_changed, opportunity_status_changed,
new_appointment, appointment_updated, new_inbound_message, form_submission, survey_submission, new_invoice, invoice_paid,
new_order, new_payment, new_subscription, new_task, task_completed. Composio has no HighLevel triggers.

Limits: each check reads the newest 100 of a list (stage and status changes: the newest 500 deals, since HighLevel
sorts deals only by date added); several inbound messages on one conversation between two checks arrive as one.

## Actions by group (* asks first)

**Search** (8): search_contacts, search_duplicate_contact, search_conversations, search_opportunities, search_opportunities_advanced, search_users, filter_users_by_email, search_locations

**Tasks** (6): get_all_tasks, create_contact_task*, get_task, update_contact_task*, delete_task*, update_task_completed*

**Appointments** (1): get_appointments_for_contact

**Tags** (7): add_contact_tags*, remove_contact_tags*, list_tags, create_tag*, get_tag, update_tag*, delete_tag*

**Notes** (5): get_all_notes, create_contact_note*, get_note, update_note*, delete_note*

**Bulk** (2): create_association*, add_remove_contact_from_business*

**Contacts** (6): delete_contact*, get_contact, update_contact*, upsert_contact*, get_contacts_by_business_id, create_contact*

**Followers** (4): add_followers_contact*, remove_followers_contact*, add_followers_opportunity*, remove_followers_opportunity*

**Campaigns** (14): add_contact_to_campaign*, remove_contact_from_campaign*, remove_contact_from_every_campaign*, fetch_campaigns, create_email_campaign*, get_emails_campaigns_emails, update_email_campaign*, get_email_campaign_by_id, delete_campaign*, list_workflow_campaigns, get_workflow_campaign_by_id, get_emails_campaigns_bulk_actions2, get_bulk_action_campaign_by_id, schedule_campaign*

**Workflow** (2): add_contact_to_workflow*, delete_contact_from_workflow*

**Conversations** (4): get_conversation, update_conversation*, delete_conversation*, create_conversation*

**Email** (3): get_email_by_id, cancel_scheduled_email_message*, update_email_message_status*

**Messages** (13): export_messages_by_location, get_message, get_conversations_messages2, send_message*, add_an_inbound_message*, add_external_outbound_call*, cancel_scheduled_message*, upload_file_attachments*, update_message_status*, add_message_attachments*, get_recording_by_message_id, get_transcription_by_message_id, download_transcription_by_message_id

**Providers** (1): agent_ai_bot_is_typing_message_indicator_for_live_chat*

**Lost reason** (1): get_lost_reason

**Pipelines** (1): get_pipelines

**Opportunities** (6): get_opportunity, delete_opportunity*, update_opportunity*, update_opportunity_status*, upsert_opportunity*, create_opportunity*

**Calendar Groups** (6): get_groups, create_calendar_group*, validate_groups_slug, delete_group*, edit_group*, disable_group*

**Service Bookings** (5): get_calendars_services_bookings, create_service_booking*, get_service_booking_by_id, update_service_booking*, delete_service_booking*

**Services** (5): get_services, create_service*, get_service_by_id, update_service*, delete_service*

**Service Locations** (5): get_service_locations, create_calendars_service_location*, get_service_location_by_id, update_service_location*, delete_service_location*

**Calendar Events** (8): create_appointment*, edit_appointment*, get_appointment, get_calendar_events, get_blocked_slots, create_block_slot*, edit_block_slot*, delete_event*

**Calendars** (6): get_slots, update_calendar*, get_calendar, delete_calendar*, get_calendars, create_calendar*

**Appointment Notes** (4): get_appointment_notes, create_appointment_note*, update_appointment_note*, delete_appointment_note*

**Calendar Notifications** (5): list_event_notifications, create_event_notification*, get_event_notification, update_notification*, delete_event_notification*

**Availability** (10): get_all_schedules, get_schedule_by_id, update_calendar_schedule*, delete_schedule*, create_schedule*, apply_user_availability_schedule_to_calendar*, remove_user_availability_schedule_from_calendar*, create_event_calendar_availability_schedule*, get_calendars_schedules_event_calendar, update_calendars_schedules_event_calendar*

**Template** (9): create_template*, list_templates, get_template, update_template*, delete_template*, update_template_late_fees_configuration*, update_invoice_payment_methods_configuration*, get_all_or_email_sms_templates, delete_email_sms_template*

**Schedule** (9): create_invoice_schedule*, get_invoices_schedule, get_schedule, update_schedule*, delete_invoice_schedule*, update_scheduled_recurring_invoice*, schedule_schedule_invoice*, manage_auto_payment_for_schedule_invoice*, cancel_scheduled_invoice*

**Text2Pay** (1): create_send*

**Invoice** (12): generate_invoice_number, get_invoice_settings, get_invoice, update_invoice*, delete_invoice*, update_invoice_late_fees_configuration*, void_invoice*, send_invoice*, record_manual_payment_for_invoice*, update_invoice_last_visited_at*, create_invoice*, list_invoices

**Estimate** (13): create_new_estimate*, update_estimate*, delete_estimate*, generate_estimate_number, send_estimate*, create_invoice_from_estimate*, list_estimates, update_estimate_last_visited_at*, list_estimate_templates, create_estimate_template*, update_estimate_template*, delete_estimate_template*, preview_estimate_template

**Integrations** (2): create_white_label_integration_provider*, list_white_label_integration_providers

**Orders** (3): list_orders, get_order_by_id, record_order_payment*

**Order fulfillments** (2): create_order_fulfillment*, list_fulfillment

**Order Notes** (1): list_order_notes

**Transactions** (2): list_transactions, get_transaction_by_id

**Subscriptions** (2): list_subscriptions, get_subscription_by_id

**Coupons** (5): list_payments_coupon, create_coupon*, update_coupon*, delete_coupon*, fetch_coupon

**Custom Provider** (6): create_new_integration*, deleting_existing_integration*, fetch_given_provider_config, create_new_provider_config*, disconnect_existing_provider_config*, custom_provider_marketplace_app_update_capabilities*

**Products** (7): bulk_update*, bulk_edit*, get_product_by_id, delete_product_by_id*, update_product_by_id*, create_product*, get_products

**Prices** (7): create_product_price*, get_products_price, get_list_inventory, update_inventory*, get_price_by_id_for_product, update_price_by_id_for_product*, delete_price_by_id_for_product*

**Store** (3): get_product_store_stats, update_store_status*, update_display_priority*

**Collections** (5): list_product_collections, create_product_collection*, get_product_collection_id, update_product_collection*, delete_product_collection*

**Reviews** (5): get_product_reviews, get_reviews_count, update_product_reviews*, delete_product_review*, bulk_update_product_review*

**Shipping Zone** (6): create_shipping_zone*, list_shipping_zones, get_shipping_zone, update_shipping_zone*, delete_shipping_zone*, get_available_shipping_rates

**Shipping Zone Rates** (5): create_shipping_rate*, list_shipping_rates, get_shipping_rate, update_shipping_rate*, delete_shipping_rate*

**Shipping Carrier** (5): create_shipping_carrier*, list_shipping_carriers, get_shipping_carrier, update_shipping_carrier*, delete_shipping_carrier*

**Store Setting** (2): create_update_store_settings*, get_store_store_setting

**Forms** (3): get_forms_submissions, upload_files_to_custom_fields*, get_forms

**Surveys** (2): get_surveys_submissions, get_surveys

**Workflows** (1): get_workflow

**Templates** (9): create_email_template*, get_emails_templates, import_email_template*, create_emails_templates_folder*, get_email_template_by_id, delete_email_template*, update_email_template*, list_documents_contracts_templates, send_template*

**Statistics** (2): get_campaign_statistics, get_social_media_statistics

**Email Verification** (1): email_verification*

**Users** (4): get_user, update_user*, delete_user*, create_user*

**Sub-Account (Formerly Location)** (4): get_location, put_location*, delete_sub_account_formerly_location*, create_sub_account_formerly_location*

**Permissions** (2): get_permissions, update_permissions*

**Tasks Search** (1): task_search

**Recurring Tasks** (4): get_recurring_task_by_id, update_recurring_task*, delete_recurring_task*, create_recurring_task*

**Custom Field** (6): get_custom_fields, locations_create_custom_field*, get_custom_field, locations_update_custom_field*, locations_delete_custom_field*, upload_file_custom_fields*

**Custom Value** (5): get_custom_values, create_custom_value*, get_custom_value, update_custom_value*, delete_custom_value*

**Timezone** (1): get_timezones

**Conversation Channel** (1): get_conversation_channel

**Businesses** (5): update_business*, delete_business*, get_business, get_businesses_by_location, create_business*

**Companies** (1): get_company

**Custom Fields V2** (8): get_custom_field_by_id, update_custom_field*, delete_custom_field*, get_custom_fields_by_object_key, create_custom_field_folder*, update_custom_field_folder*, delete_custom_field_folder*, create_custom_field*

**Custom Menu Links** (5): get_custom_menu_link, delete_custom_menu_link*, update_custom_menu_link*, get_custom_menu_links, create_custom_menu_link*

**Object Schema** (4): get_object_schema, update_custom_object*, get_object_by_location_id, create_custom_object_schema*

**Records** (4): get_objects_records, update_object_record*, delete_objects_record*, create_object_record*

**Search Object Records** (1): search_object_records

**Relations** (3): create_relation*, get_relations_by_record_id, delete_relation*

**Associations** (7): get_association_key_by_key_name, get_association_by_object_keys, update_associations*, delete_association*, get_association_by_id, create_association_associations*, find_associations

**Medias** (7): get_medias_files, upload_media_file*, delete_medias*, update_file_folder*, create_medias_folder*, update_medias_update_files*, update_medias_delete_files*

**Trigger Links** (5): get_link_by_id, update_link*, delete_link*, get_links, create_link*

**Trigger Links Search** (1): search_links

**Redirect** (4): create_redirect*, update_redirect_by_id*, delete_redirect_by_id*, fetch_redirects_list

**Funnel** (3): list_funnels_funnel, get_funnels_page, get_funnels_page_count

**Blogs** (7): check_url_slug_exists, update_blog_post*, create_blog_post*, get_all_blog_authors_by_location, get_all_categories_by_location, get_blog_posts_by_blog_id, get_blogs

**other** (1): import_courses*

**Post** (6): get_posts, create_post*, get_post, edit_post*, delete_post*, bulk_delete_social_planner_posts*

**Account** (2): get_accounts, delete_account*

**CSV** (7): upload_csv*, get_upload_status, set_accounts*, get_csv_post, start_csv_finalize*, delete_csv*, delete_csv_post*

**OAuth | Generic** (2): get_available_accounts_step_2_of_3, connect_account_step_3_of_3*

**Category** (2): get_categories_by_location_id, get_categories_by_id

**Tag** (2): get_tags_by_location_id, get_tags_by_ids

**Category Queue** (18): get_categories_with_their_queue_status, create_new_category_queue*, fetch_category_queues_for_location, fetch_category_queue_by_id, update_queue_settings_or_status*, fetch_items_from_queue, start_or_resume_edit_session*, save_edit_session_changes*, discard_edit_session_changes*, fetch_calendar_view_for_edit_session, fetch_slot_information_for_queue_items, delete_item_from_queue*, update_item_in_queue*, get_scheduled_posts_calendar_view, delete_active_post_and_schedule_next_one*, reset_item_in_queue*, clone_queue_item*, create_new_item_in_queue*

**Comments** (4): create_comment_or_reply*, like_comment*, unlike_comment*, list_comments_for_post_or_thread

**Facebook Reporting** (3): get_reporting_data, get_campaign_reporting, get_reporting_list

**Facebook Integration** (16): get_current_facebook_user, get_facebook_pages, get_instagram_accounts_for_page, get_page_lead_forms, create_page_lead_form*, get_ad_accounts, get_ad_account_details, delete_ad_account*, get_conversation_forms, create_conversation_form*, create_facebook_integration*, get_facebook_integration, delete_facebook_integration*, delete_page_connection*, set_default_page*, get_lead_form_by_id

**Facebook Ads** (29): search_targeting_options, publish_campaign*, get_conversion_pixels, upsert_conversion_pixel*, get_custom_audiences, delete_custom_audience*, update_custom_audience*, get_custom_audience_by_id, add_custom_audience_member*, remove_custom_audience_member*, batch_update_audience_members*, get_campaign_with_linked_entities, get_entities, upsert_campaign*, upsert_adset*, upsert_ad*, pause_campaign*, resume_campaign*, duplicate_campaign*, fb_delete_campaign*, pause_ad_set*, resume_ad_set*, duplicate_ad_set*, delete_ad_set*, pause_ad*, resume_ad*, duplicate_ad*, delete_ad*, get_campaign_publishing_progress

**Google Reporting** (3): google_get_reporting, google_get_reporting_list, google_get_campaign_reporting

**Google Ads** (22): get_conversions, upsert_conversion*, get_conversion_by_id, delete_conversion*, publish_ad*, google_search_targeting, get_keyword_ideas, get_assets, upsert_assets*, google_get_entity, get_target_interests, get_segments, upsert_segment*, delete_segment*, get_segment_by_id, create_offline_user_list_job*, upsert_audience*, get_audiences, get_audience_by_id, upsert_google_campaign*, get_google_campaign_by_id, get_conversion_goals

**Google Integration** (6): get_google_integration, create_google_integration*, get_current_google_user, get_google_ad_accounts, google_get_ad_account_details, google_delete_ad_account*

**LinkedIn Integration** (6): get_linked_in_integration, create_linked_in_integration*, get_linked_in_ad_accounts, li_get_ad_account_details, li_delete_ad_account*, get_current_linked_in_user

**LinkedIn Ads** (7): get_ad_campaign_group, publish_ad_campaign_group*, upsert_ad_campaign_group*, li_search_targeting, get_lead_forms, create_lead_form*, update_ad_status*

**LinkedIn Reporting** (3): get_ad_analytics, li_get_reporting_list, get_campaign_group_reporting

**Affiliates** (2): list_affiliates, get_affiliate

**Payouts** (1): list_payouts

**Commissions** (1): list_commissions

**Agents** (18): create_agent*, list_agent_studio_agent, update_agent*, update_agent_metadata*, delete_agent*, get_agent, promote_to_production*, execute_agent*, create_agent_conversation_ai*, search_conversation_ai_agents, update_agent_conversation_ai*, get_agent_conversation_ai, delete_agent_conversation_ai*, create_agent_voice_ai*, get_agents, patch_agent*, get_agent_voice_ai, delete_agent_voice_ai*

**Actions** (10): attach_action_to_agent*, list_actions_for_agent, get_action_by_id, update_action*, remove_action_from_agent*, update_followup_settings*, create_agent_action*, update_agent_action*, get_agent_action, delete_agent_action*

**Generations** (1): get_generation_details

**Dashboard** (2): list_call_logs, get_call_log

**Faqs** (4): get_faqs_by_knowledge_base_with_pagination_support, create_new_faq_inside_knowledge_base*, update_existing_knowledge_base_faq*, delete_existing_knowledge_base_faq*

**Web Crawler** (5): get_trained_page_links_by_knowledge_base, start_crawling_and_discover_pages_for_training*, delete_trained_pages*, get_crawling_status_for_latest_operation, train_discovered_website_pages_and_ingest_into_knowledge_base*

**Knowledge Base** (5): get_knowledge_base_by_id, delete_knowledge_base*, update_knowledge_base*, get_knowledge_bases_for_location_by_location_id_paginated, create_new_knowledge_base_max_15_knowledge_bases_per_location*

**Brand Voices** (6): list_brand_boards_voices, create_brand_boards_voices*, get_brand_voice, update_brand_voice*, delete_brand_voice*, set_default_brand_voice*

**Brand Boards** (5): get_brand_boards, get_brand_board, update_brand_board*, delete_brand_board*, create_new_brand_board*

**Chat Widget** (8): list_chat_widgets, get_chat_widget, update_chat_widget*, patch_chat_widget*, get_widget_config, delete_chat_widget*, clone_chat_widget*, create_chat_widget*

**lc-phone** (4): list_number_pools, list_available_phone_numbers, purchase_number_for_location*, list_active_numbers

**Documents** (2): list_documents, send_document*

**Saas** (14): get_locations_by_stripe_id_with_company_id, update_saa_s_subscription*, disable_saa_s_for_locations*, enable_saa_s_for_sub_account_formerly_location*, pause_location*, update_rebilling*, get_agency_plans, get_location_subscription_details, bulk_enable_saa_s*, get_saa_s_locations, get_saa_s_plan, allow_attach_rebilling*, get_location_wallet_balance, update_location_wallet_balance*

**Snapshots** (4): get_snapshots, create_snapshot_share_link*, get_snapshot_push_between_dates, get_last_snapshot_push
