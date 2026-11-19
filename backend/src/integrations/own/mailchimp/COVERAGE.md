# Mailchimp coverage

Source: Mailchimp's Marketing API Swagger 2 file (github.com/mailchimp/mailchimp-client-lib-codegen, `spec/marketing.json`),
lifted to OpenAPI 3 and generated 2026-11-19 by `bun scripts/openapi-actions.ts mailchimp`. Every live operation is an
action (294). Benchmark: Composio's `mailchimp` toolkit (278 tools, 4 triggers), checked with
`.claude/skills/new-integration/coverage.ts`: every tool and trigger matched by name except the five below.

## Deliberately left out

| What | Why |
| --- | --- |
| Conversations (`list_conversations`, `get_conversation`, `list_messages`, `get_message`) | Mailchimp marks them deprecated; the inbox they read is retired |
| `list_customer_journeys` (Composio) | Not in Mailchimp's published API; the only Customer Journeys call is `customer_journeys_api_trigger_for_a_contact`, which is here |
| Transactional email (Mandrill) | A separate product: its own host (mandrillapp.com/api/1.0), its own key and add-on billing, every call a POST with the key in the body. It can't share a Marketing API connection, so it would be its own app (`mandrill`) later |
| Polled triggers | Everything Mailchimp reports comes by webhook; other changes (a new campaign, an order) are made by the business or its shop, not reported by Mailchimp |

## Hand adjustments (scripts/openapi/mailchimp.ts, own/mailchimp/)

- Swagger 2 lifted to OpenAPI 3 in the config: the body param becomes a JSON body; `fields`/`exclude_fields` go comma separated.
- Names are Composio's: from the summaries, plus a `rename` list for the 13 its summaries don't give.
- The key's data centre (`-us21`) is the host: `Api.url` swaps it into `https://<dc>.api.mailchimp.com/3.0`. A key that
  doesn't end in a data centre is refused before any call, so a key can't send requests to another host.
- `subscriber_hash` takes an email too: it's hashed (MD5 of the lower-case address) before the call.
- `verify_connected_site_script` (a POST) only checks, so it runs without asking.
- Errors come back as Mailchimp's JSON problem text (`title`, `detail`), since `own/openapi.ts` doesn't read `detail`.

## Auth

| Method | Status |
| --- | --- |
| API key (profile → Extras → API keys), Basic auth | done, not tried live |
| OAuth 2 (no token expiry; the data centre comes from login.mailchimp.com/oauth2/metadata) | later: no OAuth app registered in this batch |

## Triggers

All 4 of Composio's, under the same names, plus `email_changed_trigger` and `cleaned_trigger`: Mailchimp's six webhook
events. Webhooks are per audience: one per connection and audience, made through `/lists/{list_id}/webhooks` with all
three sources (contact, admin, API) on, extended with each event an automation needs and deleted with the last one.
Mailchimp signs nothing, so the address carries a token (an HMAC of `ENCRYPTION_KEY`, the connection and the audience)
checked with a timing-safe compare. Mailchimp checks the address with a GET first; the shared route answers it.
Deliveries are form-encoded and read into an object. Settings: `list_id` (required) and `email` (one contact).

| Trigger | Mailchimp event |
| --- | --- |
| subscribe_trigger | subscribe |
| unsubscribe_trigger | unsubscribe |
| profile_update_trigger | profile |
| email_changed_trigger | upemail |
| cleaned_trigger | cleaned |
| campaign_trigger | campaign (sent or cancelled) |

Not tried live: connecting a real key, a webhook created and validated by Mailchimp, a real delivery.

## Actions by group (* asks first)

**root** (1): list_api_root_resources

**activityFeed** (1): get_latest_chimp_chatter

**accountExports** (2): list_account_exports, add_export*

**accountExport** (1): get_account_export_info

**contacts** (4): get_list_of_audiences, get_audience_info, archive_contact*, forget_contact*

**audiences** (4): get_audiences_contacts, add_contact_to_audience*, get_audiences_contacts_detail, update_audiences_contacts*

**authorizedApps** (2): list_authorized_apps, get_authorized_app_info

**automations** (18): list_automations, add_automation*, get_automation_info, pause_automation_emails*, start_automation_emails*, archive_automation*, list_automated_emails, get_workflow_email_info, delete_workflow_email*, update_workflow_email*, list_automated_email_subscribers, add_subscriber_to_workflow_email*, get_automated_email_subscriber, pause_automated_email*, start_automated_email*, list_subscribers_removed_from_workflow, remove_subscriber_from_workflow*, get_subscriber_removed_from_workflow

**batches** (4): list_batch_requests, start_batch_operation*, get_batch_operation_status, delete_batch_request*

**batchWebhooks** (5): list_batch_webhooks, add_batch_webhook*, get_batch_webhook_info, update_batch_webhook*, delete_batch_webhook*

**templateFolders** (5): list_template_folders, add_template_folder*, get_template_folder, update_template_folder*, delete_template_folder*

**campaignFolders** (5): list_campaign_folders, add_campaign_folder*, get_campaign_folder, update_campaign_folder*, delete_campaign_folder*

**campaigns** (22): list_campaigns, add_campaign*, get_campaign_info, update_campaign_settings*, delete_campaign*, cancel_campaign*, replicate_campaign*, send_campaign*, schedule_campaign*, unschedule_campaign*, send_test_email*, pause_rss_campaign*, resume_rss_campaign*, resend_campaign*, get_campaign_content, set_campaign_content*, list_campaign_feedback, add_campaign_feedback*, get_campaign_feedback_message, update_campaign_feedback_message*, delete_campaign_feedback_message*, get_campaign_send_checklist

**connectedSites** (7): list_connected_sites, add_connected_site*, get_connected_site, delete_connected_site*, verify_connected_site_script, enable_pixel_for_connected_site*, disable_pixel_for_connected_site*

**customerJourneys** (1): customer_journeys_api_trigger_for_a_contact*

**fileManager** (11): list_stored_files, add_file*, get_file, update_file*, delete_file*, list_folders, add_folder*, get_folder, update_folder*, delete_folder*, retrieve_folder_contents

**lists** (70): get_lists_info, add_list*, get_list_info, update_lists*, delete_list*, batch_subscribe_or_unsubscribe*, list_abuse_reports, get_abuse_report, list_recent_activity, list_top_email_clients, list_growth_history_data, get_growth_history_by_month, list_interest_categories, add_interest_category*, get_interest_category_info, update_interest_category*, delete_interest_category*, list_interests_in_category, add_interest_in_category*, get_interest_in_category, update_interest_in_category*, delete_interest_in_category*, list_segments, add_segment*, get_segment_info, delete_segment*, update_lists_segments*, batch_add_or_remove_members*, list_members_in_segment, add_member_to_segment*, remove_list_member_from_segment*, search_for_tags_on_a_list_by_name, list_members_info, add_list_member*, get_member_info, add_or_update_list_member*, update_list_member*, archive_list_member*, view_recent_activity50, view_recent_activity, list_member_tags, add_or_remove_member_tags*, list_member_events, add_event*, list_member_goal_events, list_recent_member_notes, add_member_note*, get_member_note, update_note*, delete_note*, delete_list_member*, list_merge_fields, add_merge_field*, get_merge_field, update_merge_field*, delete_merge_field*, list_webhooks, add_webhook*, get_webhook_info, delete_webhook*, update_webhook*, list_signup_forms, customize_signup_form*, list_locations, get_information_about_all_surveys_for_a_list, create_survey*, get_survey, update_survey*, delete_survey*, replicate_survey*

**Surveys** (3): publish_a_survey*, unpublish_a_survey*, create_a_survey_campaign*

**landingPages** (8): list_landing_pages, add_landing_page*, get_landing_page_info, update_landing_page*, delete_landing_page*, publish_landing_page*, unpublish_landing_page*, get_landing_page_content

**reports** (22): list_campaign_reports, get_campaign_report, retrieve_campaign_abuse_complaints, campaign_abuse_report_details, campaign_statistics_feedback, list_campaign_click_details, get_campaign_link_details, list_clicked_link_subscribers, get_clicked_link_subscriber, list_campaign_open_details, get_opened_campaign_subscriber, list_domain_performance_stats, list_eep_url_activity, list_email_activity, get_subscriber_email_activity, list_top_open_activities, list_campaign_recipients, get_campaign_recipient_info, list_child_campaign_reports, list_unsubscribed_members, get_unsubscribed_member, list_campaign_product_activity

**templates** (6): list_templates, add_template*, get_template_info, update_template*, delete_template*, view_default_content

**ecommerce** (60): list_account_orders, list_stores, add_store*, get_store_info, update_store*, delete_store*, list_carts, add_cart*, get_cart_info, update_cart*, delete_cart*, list_cart_line_items, add_cart_line_item*, get_cart_line_item, update_cart_line_item*, delete_cart_line_item*, list_customers, add_customer*, get_customer_info, add_or_update_customer*, update_customer*, delete_customer*, list_promo_rules, add_promo_rule*, get_promo_rule, update_promo_rule*, delete_promo_rule*, list_promo_codes, add_promo_code*, get_promo_code, update_promo_code*, delete_promo_code*, list_orders, add_order*, get_order_info, upsert_ecommerce_stores_orders*, update_order*, delete_order*, list_order_line_items, add_order_line_item*, get_order_line_item, update_order_line_item*, delete_order_line_item*, list_product, add_product*, get_product_info, update_product*, upsert_ecommerce_stores_products*, delete_product*, list_product_variants, add_product_variant*, get_product_variant_info, add_or_update_product_variant*, update_product_variant*, delete_product_variant*, list_product_images, add_product_image*, get_product_image_info, update_product_image*, delete_product_image*

**searchCampaigns** (1): search_campaigns

**sms-campaigns** (10): list_sms_campaigns, add_sms_campaign*, get_sms_campaign_info, update_sms_campaign_settings*, delete_sms_campaign*, send_sms_campaign*, schedule_sms_campaign*, cancel_sms_campaign_send*, get_sms_campaign_content, set_sms_campaign_content*

**searchMembers** (1): search_members

**ping** (1): ping

**facebookAds** (2): list_facebook_ads, get_facebook_ad_info

**reporting** (12): list_facebook_ads_reports, get_facebook_ad_report, list_facebook_ecommerce_report, get_landing_page_report, list_landing_pages_reports, list_survey_reports, get_survey_report, list_survey_question_reports, get_survey_question_report, list_answers_for_question, list_survey_responses, get_survey_response

**verifiedDomains** (5): get_domain_info, delete_domain*, verify_domain*, list_sending_domains, add_domain_to_account*
