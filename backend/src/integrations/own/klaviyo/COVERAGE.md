# Klaviyo coverage

Source: Klaviyo's official OpenAPI spec, github.com/klaviyo/openapi (openapi/stable.json, API revision 2026-10-15),
generated 2026-11-22 by `bun scripts/openapi-actions.ts klaviyo`. Every operation in it is an action (436), none skipped.
Compared with Composio's Klaviyo toolkit (233 actions, no triggers) on the same day.

## Deliberately left out

| What | Why |
| --- | --- |
| Beta operations (Klaviyo's beta.json) | Pre-release and change without notice; stable covers the same areas |
| Webhooks as triggers | Klaviyo's webhooks need its paid Advanced KDP add-on; every trigger is polled instead, which works on every plan. The webhook calls are still actions (get_webhooks, create_webhook...) |
| OAuth sign-in | Not in this job: key sign-in only |

Composio's unmatched names are renames of calls we have: create_client_event2 = create_client_event; create/delete_tag_relationships =
tag_flows, tag_campaigns, tag_lists, tag_segments and remove_tag_from_*; get_bulk_update_catalog_items_job = get_update_items_job;
get_coupon_id_for_coupon_code = get_coupon_code_relationships_coupon; get_event/list/profile/segment/tag_relationships = the
get_*_ids_for_* and get_*_relationships_* calls (get_metric_id_for_event, get_list_ids_for_profile, get_flow_ids_for_tag...);
unsubscribe_profiles_bulk = unsubscribe_profiles; unsuppress_profiles_bulk = unsuppress_profiles;
update_catalog_category_relationships = update_catalog_category_relationships_items.

## Hand adjustments (scripts/openapi/klaviyo.ts, own/klaviyo/index.ts)

- Base `https://a.klaviyo.com`. The key goes as `Authorization: Klaviyo-API-Key pk_...`, and `revision: 2026-10-15` on every call
  (the spec's revision header is dropped from every action). Move `REVISION` in index.ts when regenerating.
- The spec says `application/vnd.api+json`, which the generator doesn't read; it generates from a copy that says
  `application/json`, which Klaviyo accepts (checked against the live API). Bodies are JSON:API: one `data` field holding
  `type`, `attributes` and `relationships`.
- The /client/ calls (they take `company_id`, the public site key) go without the private key, as Klaviyo means them to.
- Names: Klaviyo's operation ids, or Composio's name where it has one for the same call (Klaviyo lists old names in
  `x-klaviyo-operation-aliases`, which Composio mostly uses).
- Run unasked though they're POSTs: query_campaign_values, query_flow_values, query_flow_series, query_form_values,
  query_form_series, query_segment_values, query_segment_series, query_metric_aggregates, create_template_render.
- No GET hands back a secret: webhooks answer with a truncated URL and never the secret key.
- Errors come back as `{"errors": [...]}`; a 401 means the key is dead. Rate limits are per call (burst/steady, in each
  action's description); a 429 surfaces as an error.

## Auth

| Method | Status |
| --- | --- |
| Private API key (Settings → Account → API keys → Create Private API Key, Full Access or Custom), pk_... | done |
| OAuth (Klaviyo app) | not built: key sign-in only |

## Triggers

All polled (polls/klaviyo.ts), every 5 minutes by default, looking back a day:

- Events, by metric name (resolved to Klaviyo's metric ids, several where integrations share a name): new_event (any metric
  named in `metric`), new_order, checkout_started, order_fulfilled, order_cancelled, order_refunded, subscribed, unsubscribed,
  form_submitted, email_bounced, email_marked_spam. Each comes with the metric's name, the event's properties and the person.
- new_profile, profile_updated (a change counts again), new_list_member (`list_id`), new_segment_member (`segment_id`),
  new_list, new_segment, campaign_sent, new_review (`max_rating` filter).

Limits: the newest 1000 events per metric per check; metrics looked up in the first five pages.

Not tried live: no Klaviyo account was used. Metric names are Klaviyo's standard ones; a shop integration that names its
metrics differently needs new_event with its own names.

## Actions by group (* asks first)

**Accounts** (2): get_accounts, get_account

**Billing** (2): list_billing_usage, get_billing_usage

**Brands** (25): get_brand_logos, create_brand_logo*, get_brand_logo, update_brand_logo*, delete_brand_logo*, get_brand_buttons, create_brand_button*, get_brand_button, update_brand_button*, delete_brand_button*, get_brand_colors, create_brand_color*, get_brand_color, update_brand_color*, delete_brand_color*, get_brand_voice, update_brand_voice*, get_brand_social_groups, create_brand_social_group*, get_brand_social_group, update_brand_social_group*, delete_brand_social_group*, get_brand_email_defaults, get_brand_email_default, update_brand_email_default*

**Campaigns** (59): get_campaigns, create_campaign*, get_campaign, update_campaign*, delete_campaign*, get_campaign_messages, create_campaign_message*, get_campaign_message, update_campaign_message*, delete_campaign_message*, get_campaign_send_job, cancel_campaign_send*, get_campaign_recipient_estimation_job, get_campaign_recipient_estimation, get_campaign_audience, update_campaign_audience*, delete_campaign_audience*, get_campaign_variation, update_campaign_variation*, delete_campaign_variation*, create_campaign_clone*, assign_campaign_message_template*, create_campaign_send_job*, create_campaign_recipient_estimation_job*, create_campaign_audience*, clone_campaign_audience*, clone_campaign_message*, create_campaign_variation*, schedule_campaign_message*, update_campaign_message_schedule*, get_campaign_message_campaign, get_campaign_message_relationships_campaign, get_campaign_message_template, get_campaign_message_relationships_template, get_image_for_campaign_message, get_image_id_for_campaign_message, update_image_for_campaign_message*, get_audience_for_campaign_message, get_audience_id_for_campaign_message, get_campaign_tags, get_campaign_relationships_tags, get_tags_for_campaign_message, get_tag_ids_for_campaign_message, get_campaign_campaign_messages, get_campaign_relationships_campaign_messages, get_campaign_audiences_for_campaign, get_audience_ids_for_campaign, get_campaign_for_campaign_audience, get_campaign_id_for_campaign_audience, get_campaign_messages_for_campaign_audience, get_message_ids_for_campaign_audience, get_message_for_campaign_variation, get_message_id_for_campaign_variation, get_translation_for_campaign_variation, get_translation_id_for_campaign_variation, get_image_for_campaign_variation, get_image_id_for_campaign_variation, get_variations_for_campaign_message, get_variation_ids_for_campaign_message

**Catalogs** (55): get_catalog_items, create_catalog_item*, get_catalog_item, update_catalog_item*, delete_catalog_item*, get_catalog_variants, create_catalog_variant*, get_catalog_variant, update_catalog_variant*, delete_catalog_variant*, get_catalog_categories, create_catalog_category*, get_catalog_category, update_catalog_category*, delete_catalog_category*, get_create_items_jobs, spawn_create_items_job*, get_create_items_job, get_update_items_jobs, spawn_update_items_job*, get_update_items_job, get_delete_items_jobs, spawn_delete_items_job*, get_bulk_delete_catalog_items_job, get_create_variants_jobs, spawn_create_variants_job*, get_create_variants_job, get_update_variants_jobs, spawn_update_variants_job*, get_bulk_update_variants_job, get_delete_variants_jobs, spawn_delete_variants_job*, get_delete_variants_job, get_create_categories_jobs, spawn_create_categories_job*, get_create_categories_job, get_update_categories_jobs, spawn_update_categories_job*, get_bulk_update_categories_job, get_delete_categories_jobs, spawn_delete_categories_job*, get_delete_categories_job, create_back_in_stock_subscription*, get_catalog_category_items, get_catalog_category_relationships_items, create_catalog_category_relationships_items*, update_catalog_category_relationships_items*, delete_catalog_category_relationships_items*, get_catalog_item_variants, get_variant_ids_for_catalog_item, get_catalog_item_categories, get_catalog_item_relationships_categories, create_catalog_item_relationships_categories*, update_catalog_item_relationships_categories*, delete_catalog_item_relationships_categories*

**Conversations** (1): create_conversation_message*

**Coupons** (17): get_coupons, create_coupon*, get_coupon, update_coupon*, delete_coupon*, get_coupon_codes, create_coupon_code*, get_coupon_code, update_coupon_code*, delete_coupon_code*, get_coupon_code_bulk_create_jobs, spawn_coupon_code_bulk_create_job*, get_coupon_code_bulk_create_job, get_coupon_for_coupon_code, get_coupon_relationships_coupon_codes, get_coupon_codes_for_coupon, get_coupon_code_relationships_coupon

**Custom Objects** (39): get_data_sources, create_data_source*, get_data_source, delete_data_source*, get_source_mapping, update_source_mapping*, get_object_types, create_object_type*, get_object_type, delete_object_type*, get_object_schema, update_object_schema*, get_object_record, bulk_create_data_source_records*, create_data_source_record*, create_object_schema*, bulk_delete_object_records*, get_records_for_object_type, get_record_ids_for_object_type, get_ingestion_logs_for_object_type, get_ingestion_log_ids_for_object_type, get_current_schema_for_object_type, get_current_schema_id_for_object_type, get_draft_schema_for_object_type, get_draft_schema_id_for_object_type, get_schema_versions_for_object_type, get_schema_version_ids_for_object_type, get_object_type_relationships, get_profile_type_relationships, get_source_mapping_for_object_schema, get_source_mapping_id_for_object_schema, get_object_schema_relationships, create_object_schema_relationship*, update_object_schema_relationship*, delete_object_schema_relationship*, get_profile_schema_relationships, create_profile_schema_relationship*, update_profile_schema_relationship*, delete_profile_schema_relationship*

**Data Privacy** (1): request_profile_deletion*

**Events** (8): get_events, create_event*, get_event, bulk_create_events*, get_event_metric, get_metric_id_for_event, get_event_profile, get_profile_id_for_event

**Flows** (22): get_flows, create_flow*, get_flow, update_flow_status*, delete_flow*, get_flow_action, update_flow_action*, delete_flow_action*, get_flow_message, create_flow_action*, get_flow_flow_actions, get_flow_relationships_flow_actions, get_flow_tags, get_flow_relationships_tags, get_flow_for_flow_action, get_flow_action_relationships_flow, get_flow_action_messages, get_flow_action_relationships_messages, get_flow_action_for_message, get_flow_message_relationships_action, get_flow_message_template, get_flow_message_relationships_template

**Forms** (12): get_forms, create_form*, get_form, update_form*, delete_form*, get_form_version, publish_form*, unpublish_form*, get_versions_for_form, get_version_ids_for_form, get_form_for_form_version, get_form_id_for_form_version

**Images** (5): get_images, upload_image_from_url*, get_image, update_image*, upload_image_from_file*

**Lists** (13): get_lists, create_list*, get_list, update_list*, delete_list*, get_list_tags, get_list_relationships_tags, get_list_profiles, get_profile_ids_for_list, add_profiles_to_list*, remove_profiles_from_list*, get_flows_triggered_by_list, get_ids_for_flows_triggered_by_list

**Metrics** (24): get_metrics, get_metric, get_metric_property, get_custom_metrics, create_custom_metric*, get_custom_metric, update_custom_metric*, delete_custom_metric*, get_mapped_metrics, get_mapped_metric, update_mapped_metric*, query_metric_aggregates, get_flows_triggered_by_metric, get_ids_for_flows_triggered_by_metric, get_properties_for_metric, get_property_ids_for_metric, get_metric_for_metric_property, get_metric_id_for_metric_property, get_metrics_for_custom_metric, get_metric_ids_for_custom_metric, get_metric_for_mapped_metric, get_metric_id_for_mapped_metric, get_custom_metric_for_mapped_metric, get_custom_metric_id_for_mapped_metric

**Profiles** (38): get_profiles, create_profile*, get_profile, update_profile*, get_bulk_profile_import_jobs, spawn_bulk_profile_import_job*, get_bulk_profile_import_job, get_bulk_suppress_profiles_jobs, suppress_profiles*, get_bulk_suppress_profiles_job, get_bulk_unsuppress_profiles_jobs, unsuppress_profiles*, get_bulk_unsuppress_profiles_job, get_push_tokens, create_or_update_push_token*, get_push_token, delete_push_token*, create_or_update_profile*, merge_profiles*, subscribe_profiles*, unsubscribe_profiles*, get_push_tokens_for_profile, get_push_token_ids_for_profile, get_profile_lists, get_list_ids_for_profile, get_profile_segments, get_segment_ids_for_profile, get_conversation_for_profile, get_conversation_id_for_profile, get_conversations_for_profile, get_conversation_ids_for_profile, get_bulk_profile_import_job_lists, get_bulk_profile_import_job_relationships_lists, get_bulk_profile_import_job_profiles, get_bulk_profile_import_job_relationships_profiles, get_errors_for_bulk_import_profiles_job, get_profile_for_push_token, get_profile_id_for_push_token

**Reporting** (7): query_campaign_values, query_flow_values, query_flow_series, query_form_values, query_form_series, query_segment_values, query_segment_series

**Reviews** (3): get_reviews, get_review, update_review*

**Segments** (11): get_segments, create_segment*, get_segment, update_segment*, delete_segment*, get_segment_tags, get_tag_ids_for_segment, get_segment_profiles, get_profile_ids_for_segment, get_flows_triggered_by_segment, get_ids_for_flows_triggered_by_segment

**Tags** (26): get_tags, create_tag*, get_tag, update_tag*, delete_tag*, get_tag_groups, create_tag_group*, get_tag_group, update_tag_group*, delete_tag_group*, get_flow_ids_for_tag, tag_flows*, remove_tag_from_flows*, get_campaign_ids_for_tag, tag_campaigns*, remove_tag_from_campaigns*, get_list_ids_for_tag, tag_lists*, remove_tag_from_lists*, get_segment_ids_for_tag, tag_segments*, remove_tag_from_segments*, get_tag_tag_group, get_tag_group_id_for_tag, get_tag_group_tags, get_tag_group_relationships_tags

**Templates** (17): get_templates, create_template*, get_template, update_template*, delete_template*, get_all_universal_content, create_universal_content*, get_universal_content, update_universal_content*, delete_universal_content*, get_template_conversion_jobs, create_template_conversion_job*, get_template_conversion_job, create_template_render, create_template_clone*, create_template_preview_send_job*, clone_universal_content*

**Text Messaging** (9): get_text_messaging_configuration, get_text_messaging_senders, create_text_messaging_sender*, get_text_messaging_sender, get_text_messaging_sender_registration, create_text_messaging_configuration*, create_text_messaging_sender_registration*, get_messaging_sender_registration_for_text_messaging_sender, get_messaging_sender_registration_id_for_text_messaging_sender

**Tracking Settings** (3): get_tracking_settings, get_tracking_setting, update_tracking_setting*

**Translations** (13): get_translations, create_translation*, get_translation, update_translation*, delete_translation*, get_campaign_variation_for_translation, get_campaign_variation_id_for_translation, get_flow_message_for_translation, get_flow_message_id_for_translation, get_template_for_translation, get_template_id_for_translation, get_template_universal_content_for_translation, get_template_universal_content_id_for_translation

**Web Feeds** (5): get_web_feeds, create_web_feed*, get_web_feed, update_web_feed*, delete_web_feed*

**Webhooks** (7): get_webhooks, create_webhook*, get_webhook, update_webhook*, delete_webhook*, get_webhook_topics, get_webhook_topic

**Client** (12): get_client_review_values_reports, get_client_reviews, create_client_review*, get_client_geofences, create_client_subscription*, create_or_update_client_push_token*, unregister_client_push_token*, create_client_event*, create_or_update_client_profile*, bulk_create_client_events*, create_client_back_in_stock_subscription*, get_client_ip_allowlist
