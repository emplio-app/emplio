# Brevo coverage

Source: Brevo's OpenAPI 3.1 specs, one per product, listed at developers.brevo.com/openapi.json (email-api,
transactional-sms, transactional-whatsapp, marketing-campaigns, contact-management, events, object-management,
accounts-and-settings, sales-crm, conversations, ecommerce, loyalty, wallet). Generated 2026-11-19 by
`bun scripts/openapi-actions.ts brevo`: 286 operations, 286 actions. Composio benchmark (`brevo`): 62 tools, 0 triggers;
all 62 matched by name except `create_or_update_email_template`, which is our create_email_template plus
update_email_template.

## Deliberately left out

| What | Why |
| --- | --- |
| GET /crm/pipeline/details (deals_getPipelineStages) | Deprecated by Brevo; list_crm_pipelines and get_pipeline replace it |
| SMS webhook triggers | Brevo documents SMS webhook payloads, but not which `events` values register them by API (the spec's list is email only). Use list_sms_events / get_sms_daily_report instead |
| CRM, payment, loyalty, meetings, push and Conversations webhooks | Set up in Brevo's dashboard only, not through /webhooks |
| OAuth sign-in | Brevo's OAuth is for partner apps (brevo-cli); a business pastes an API key |

## Hand adjustments (scripts/openapi/brevo.ts, own/brevo/index.ts)

- Names: Composio's where it has the same call (61 of 62); otherwise shortened from Brevo's sentence-like summaries
  (list_blocked_contacts, send_transactional_sms, whatsapp not whats_app). Brevo's "Delete a contact from a list" is
  remove_contacts_from_list; delete_contact_list deletes the list itself, as in Composio.
- The key goes in the `api-key` header. A 401 means the key is gone (or Brevo's Authorised IPs blocks us; the key help says so).
- Brevo's spec points four request bodies at schemas it doesn't include, so these are written by hand from its older
  Swagger 2 spec (github.com/getbrevo/brevo-go api/swagger.yaml): add_contacts_to_list, remove_contacts_from_list,
  send_whatsapp_message, export_webhook_history.
- upsert_object_records `records` and delete_object_records `identifiers` have the same gap but stay open objects with
  Brevo's own description (ids or ext_ids).
- preview_email_template is a POST that only reads, so it runs without asking.

## Auth

| Method | Status |
| --- | --- |
| API key (app.brevo.com/settings/keys/api), sent as api-key; checked with GET /account | done |

## Triggers (webhooks, triggers.ts)

One Brevo webhook per connection and type, at `/webhooks/app/brevo/<connection>/<type>/<token>`; inbound email gets one
per receiving domain (`inbound-<domain>`). The token is an HMAC of ENCRYPTION_KEY and the connection, never stored
(Brevo signs nothing). A new event is added to our webhook with PUT; the last automation deletes it. Settings filter on
the server: `tag` (transactional), `campaign_id` (campaign events), `list_id` (contact_added_to_list), `domain` (inbound,
required). Brevo allows 40 webhooks per account.

- Transactional email: transactional_email_sent, _delivered, _opened, _first_opened, _clicked, _soft_bounced,
  _hard_bounced, _spam, _invalid, _deferred, _blocked, _unsubscribed
- Marketing: campaign_email_delivered, campaign_email_opened, campaign_email_clicked, campaign_email_soft_bounced,
  campaign_email_hard_bounced, campaign_email_spam, campaign_unsubscribed, contact_added_to_list, contact_updated,
  contact_deleted
- Inbound: inbound_email_received (one event per email in the delivery)

## Actions by group (* asks first)

- **transactionalEmails** (22): send_transactional_email*, list_transactional_emails, get_transactional_email, delete_scheduled_email*, get_scheduled_email, delete_hardbounces*, get_transactional_email_daily_report, list_transactional_email_events, get_aggregated_transactional_email_report, delete_smtp_transactional_log*, get_all_email_templates, create_email_template*, delete_email_template*, update_email_template*, get_email_template, send_transactional_template_test*, preview_email_template, list_blocked_contacts, unblock_contact*, block_domain*, list_blocked_domains, unblock_domain*
- **inboundParsing** (3): list_inbound_email_events, get_inbound_email_events, download_inbound_attachment
- **transactionalSms** (4): send_transactional_sms*, get_aggregated_sms_report, get_sms_daily_report, list_sms_events
- **transactionalWhatsApp** (2): send_whatsapp_message*, list_whatsapp_events
- **emailCampaigns** (13): list_email_campaigns, create_email_campaign*, update_email_campaign*, delete_email_campaign*, get_email_campaign_details, send_email_campaign_now*, send_email_campaign_test*, update_email_campaign_status*, get_shared_template_url, export_email_campaign_recipients*, send_email_campaign_report*, get_ab_test_campaign_result, upload_campaign_image*
- **smsCampaigns** (10): get_sms_campaigns, create_sms_campaign*, get_sms_campaign_details, update_sms_campaign*, delete_sms_campaign*, send_sms_campaign_now*, update_sms_campaign_status*, send_test_sms_campaign*, export_sms_campaign_recipients*, send_sms_campaign_report*
- **whatsAppCampaigns** (9): get_whatsapp_campaign, delete_whatsapp_campaign*, update_whatsapp_campaign*, list_whatsapp_templates, create_whatsapp_campaign*, list_whatsapp_campaigns, get_whatsapp_config, create_whatsapp_template*, send_whatsapp_template_for_approval*
- **contacts** (29): create_contact_attribute*, update_contact_attribute*, delete_contact_attribute*, list_contact_attributes, delete_multiple_choice_attribute_option*, create_contact_list*, get_contact_lists, get_contact_list, update_contact_list*, delete_contact_list*, get_contacts_in_list, remove_contacts_from_list*, add_contacts_to_list*, create_contact_folder*, list_contact_folders, get_contact_folder, update_contact_folder*, delete_contact_folder*, list_contact_lists_in_folder, get_all_contacts, create_contact*, create_double_opt_in_contact*, get_contact_details, delete_contact*, update_contact*, get_contact_campaign_stats, list_contact_segments, export_contacts*, import_contacts*
- **consentGroups** (5): list_consent_groups, create_consent_group*, get_consent_group, update_consent_group*, delete_consent_group*
- **event** (3): get_events, create_event*, create_events_in_batch*
- **customObjects** (4): upsert_object_records*, list_custom_object_records, delete_object_records*, get_associated_object_records
- **senders** (7): get_all_senders, create_sender*, update_sender*, delete_sender*, validate_sender_using_otp*, list_dedicated_ips, list_sender_ips
- **domains** (5): list_sender_domains, create_sender_domain*, delete_sender_domain*, get_sender_domain_configuration, authenticate_sender_domain*
- **webhooks** (6): get_webhooks, create_webhook*, get_webhook_details, update_webhook*, delete_webhook*, export_webhook_history*
- **account** (2): get_account_info, get_user_activity_logs
- **masterAccount** (26): list_sub_accounts, create_sub_account*, get_sub_account_details, delete_sub_account*, update_sub_account_plan*, update_sub_accounts_plan*, generate_sso_token_to_access_admin_account*, generate_sso_token_to_access_sub_account*, get_master_account, create_api_key_for_sub_account*, toggle_sub_account_applications*, create_sub_account_group*, list_master_account_ips, associate_ip_to_sub_accounts*, dissociate_ip_from_sub_accounts*, get_sub_account_group, update_sub_account_group*, delete_sub_account_group*, remove_sub_accounts_from_group*, send_invitation_to_admin_user*, resend_cancel_admin_user_invitation*, revoke_admin_user*, list_admin_users, check_admin_user_permissions, change_admin_user_permissions*, list_sub_account_groups
- **user** (6): list_organization_users, check_user_permission, revoke_user_permission*, resend_cancel_invitation*, send_invitation_to_user*, update_permission_for_user*
- **process** (2): list_processes, get_process
- **externalFeeds** (5): get_external_feeds, create_external_feed*, get_external_feed_details, update_external_feed*, delete_external_feed*
- **companies** (9): list_all_companies, create_a_company*, get_company_details, delete_company*, update_company*, create_company_deal_attribute*, get_company_attributes, link_and_unlink_company_with_contact_and_deal*, import_companies*
- **deals** (10): get_pipeline, list_crm_pipelines, get_deal_attributes, list_deals, create_deal*, get_deal, delete_deal*, update_deal*, link_and_unlink_deal_with_contacts_and_companies*, import_deals*
- **tasks** (6): get_task_types, get_tasks, create_task*, get_task, delete_task*, update_task*
- **notes** (5): list_crm_notes, create_note*, get_note, update_note*, delete_note*
- **files** (5): get_files, upload_file*, download_file, delete_file*, get_file_details
- **conversations** (10): delete_message_sent_by_agent*, update_message_sent_by_agent*, get_message, send_message_as_agent*, delete_automated_message*, update_automated_message*, get_automated_message, send_automated_message_to_visitor*, set_agent_online*, set_visitor_group_assignment*
- **ecommerce** (18): create_order*, create_orders_in_batch*, list_orders, create_update_product*, list_products, get_product, create_products_in_batch*, create_product_alert_for_contact*, list_categories, create_update_category*, get_category, create_categories_in_batch*, get_campaign_attribution_metrics, get_attributed_product_sales, get_attribution_metrics, activate_ecommerce*, set_display_currency*, get_display_currency
- **coupons** (5): get_coupon_collections, create_coupon_collection*, get_coupon_collection, update_coupon_collection*, create_coupons*
- **payments** (3): create_payment_request*, get_payment_request_details, delete_payment_request*
- **program** (12): get_loyalty_program_list, create_loyalty_program*, get_loyalty_program_info, update_loyalty_program*, partially_update_loyalty_program*, delete_loyalty_program*, publish_loyalty_program*, create_subscription*, create_subscription_member*, delete_subscription_member*, delete_subscription*, get_subscription_data
- **reward** (10): get_code_count, get_voucher_for_contact, list_rewards, create_reward*, get_reward_information, create_voucher*, create_redeem_voucher_request*, complete_redeem_voucher_request*, revoke_vouchers*, validate_reward*
- **balance** (18): get_balance_definition_list, create_balance_definition*, get_balance_definition, update_balance_definition*, delete_balance_definition*, create_balance_limits*, get_balance_limits, delete_balance_limit*, update_balance_limit*, get_subscription_balances, create_subscription_balances*, get_balance_list, create_balance_transaction*, complete_balance_transaction*, cancel_balance_transaction*, create_balance_order*, get_active_balances, get_transaction_history
- **tier** (10): create_tier_group*, list_tier_groups, update_tier_group*, delete_tier_group*, get_tier_group, list_tiers, create_tier*, delete_tier*, update_tier*, assign_tier*
- **wallet** (2): get_wallet_pass_install_url, redeem_wallet_pass*
