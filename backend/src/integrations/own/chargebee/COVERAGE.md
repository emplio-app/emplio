# Chargebee coverage

Source: Chargebee's OpenAPI specs (github.com/chargebee/openapi: chargebee_api_v2_pc_v2_spec.json, then
chargebee_api_v2_pc_v1_spec.json), generated 2026-11-22 by `bun scripts/openapi-actions.ts chargebee`. Every
operation of API v2 for Product Catalog 2.0 is an action (499), plus the 47 calls only Product Catalog 1.0 sites have
(plans, addons, and the subscription, invoice, estimate, quote and checkout calls that take plan_id/addons): 546 in all.
Composio has no Chargebee toolkit, so there is nothing to match by name.

## Deliberately left out

| What | Why |
| --- | --- |
| Calls in both specs, the second time | The Product Catalog 2.0 version is kept (same path) |
| 9 deprecated events (product_*, variant_*, netd_payment_due_reminder, two omnichannel downgrade events) | Marked deprecated in the spec, and the Webhook endpoints API no longer accepts them |
| API v1 | The older API; v2 has everything it has |
| Polled triggers | Every event comes by webhook. A read-only key can't make a webhook endpoint, so with one there are no triggers |

## Hand adjustments (scripts/openapi/chargebee.ts, own/chargebee/index.ts, api.ts)

- Calls go to the person's own `<site>.chargebee.com/api/v2` (the spec's server is a template); basic auth with the
  API key as the username. The key is pasted as `site:api_key`; only `*.chargebee.com` hosts are accepted.
- List filters are deepObject (`status[in]`, `created_at[after]`): the generator's object becomes one query key per
  operator, and the input is flattened to match at call time; `in`/`not_in` take a list, sent as a JSON array.
- JSON fields in a form body (meta_data, metadata, additional_information, browser_details...) are sent as one JSON string.
- Path params like `{customer-id}` are renamed `customer_id`; where that clashes with a filter (list_attached_items,
  create_an_attached_item), the path one is `path_item_id`.
- The fraud-check headers (chargebee-request-origin-*) are dropped: Emplio is the caller, not the customer.
- Product Catalog 1.0-only actions start their description with "Only for sites still on Product Catalog 1.0".
- Run without asking (POSTs that only work something out): every *estimate*, the *_as_pdf download links,
  retrieve_direct_debit_agreement_pdf, retrieve_store_subscription, list_personalized_offers.
- Ask first although GETs: retrieve_a_portal_session (a signed-in portal link), list_gateway_payment_method_tokens_for_a_payment_source.

## Auth

| Method | Status |
| --- | --- |
| API key (Settings → Configure Chargebee → API keys and webhooks → API keys), pasted as `site:key` | done |
| OAuth | Chargebee offers none to third parties |

## Triggers (webhook, 260)

One webhook endpoint per connection, made with the Webhook endpoints API (needs a full-access key), for all events,
with basic auth whose password is an HMAC of ENCRYPTION_KEY and the connection. Deliveries are deduplicated by event id.
Removed when the last automation goes. Chargebee allows five endpoints per site; Emplio uses one per connection, and
with five already there Chargebee's own error says so. Filter: `customer_id`. Every event type in the spec is a trigger of the same name:

**coupon** (6): coupon_created, coupon_updated, coupon_deleted, coupon_codes_added, coupon_codes_deleted, coupon_codes_updated

**coupon_set** (3): coupon_set_created, coupon_set_updated, coupon_set_deleted

**customer** (7): customer_created, customer_changed, customer_deleted, customer_moved_out, customer_moved_in, customer_business_entity_changed, customer_entitlements_updated

**promotional** (2): promotional_credits_added, promotional_credits_deducted

**subscription** (43): subscription_created, subscription_created_with_backdating, subscription_started, subscription_trial_end_reminder, subscription_activated, subscription_activated_with_backdating, subscription_changed, subscription_trial_extended, subscription_changed_with_backdating, subscription_cancellation_scheduled, subscription_cancellation_reminder, subscription_cancelled, subscription_canceled_with_backdating, subscription_reactivated, subscription_reactivated_with_backdating, subscription_renewed, subscription_items_renewed, subscription_scheduled_cancellation_removed, subscription_changes_scheduled, subscription_scheduled_changes_removed, subscription_shipping_address_updated, subscription_deleted, subscription_paused, subscription_pause_scheduled, subscription_scheduled_pause_removed, subscription_resumed, subscription_resumption_scheduled, subscription_scheduled_resumption_removed, subscription_advance_invoice_schedule_added, subscription_advance_invoice_schedule_updated, subscription_advance_invoice_schedule_removed, subscription_renewal_reminder, subscription_entitlements_created, subscription_entitlements_updated, subscription_business_entity_changed, subscription_ramp_created, subscription_ramp_deleted, subscription_ramp_applied, subscription_ramp_drafted, subscription_ramp_updated, subscription_moved_in, subscription_moved_out, subscription_movement_failed

**mrr** (1): mrr_updated

**pending** (2): pending_invoice_created, pending_invoice_updated

**invoice** (4): invoice_generated, invoice_generated_with_backdating, invoice_updated, invoice_deleted

**credit_note** (4): credit_note_created, credit_note_created_with_backdating, credit_note_updated, credit_note_deleted

**einvoice** (2): einvoice_created, einvoice_updated

**payment** (12): payment_schedules_created, payment_schedules_updated, payment_schedule_scheme_created, payment_schedule_scheme_deleted, payment_schedules_cancelled, payment_due_reminder, payment_succeeded, payment_failed, payment_refunded, payment_initiated, payment_intent_created, payment_intent_updated

**add** (1): add_usages_reminder

**transaction** (3): transaction_created, transaction_updated, transaction_deleted

**dunning** (1): dunning_updated

**refund** (2): refund_failed, refund_initiated

**authorization** (2): authorization_succeeded, authorization_voided

**card** (5): card_added, card_updated, card_expiry_reminder, card_expired, card_deleted

**payment_source** (7): payment_source_added, payment_source_updated, payment_source_deleted, payment_source_expiring, payment_source_expired, payment_source_locally_deleted, payment_source_business_entity_changed

**virtual** (3): virtual_bank_account_added, virtual_bank_account_updated, virtual_bank_account_deleted

**token** (3): token_created, token_consumed, token_expired

**unbilled_charges** (4): unbilled_charges_created, unbilled_charges_voided, unbilled_charges_deleted, unbilled_charges_invoiced

**order** (9): order_created, order_updated, order_cancelled, order_delivered, order_returned, order_ready_to_process, order_ready_to_ship, order_deleted, order_resent

**quote** (3): quote_created, quote_updated, quote_deleted

**tax** (3): tax_withheld_recorded, tax_withheld_deleted, tax_withheld_refunded

**gift** (6): gift_scheduled, gift_unclaimed, gift_claimed, gift_expired, gift_cancelled, gift_updated

**hierarchy** (2): hierarchy_created, hierarchy_deleted

**contract** (5): contract_term_created, contract_term_renewed, contract_term_terminated, contract_term_completed, contract_term_cancelled

**item_family** (3): item_family_created, item_family_updated, item_family_deleted

**item_created** (1): item_created

**item_updated** (1): item_updated

**item_deleted** (1): item_deleted

**item_price** (5): item_price_created, item_price_updated, item_price_deleted, item_price_entitlements_updated, item_price_entitlements_removed

**attached** (3): attached_item_created, attached_item_updated, attached_item_deleted

**differential** (3): differential_price_created, differential_price_updated, differential_price_deleted

**feature** (6): feature_created, feature_updated, feature_deleted, feature_activated, feature_reactivated, feature_archived

**item_entitlements** (2): item_entitlements_updated, item_entitlements_removed

**entitlement** (3): entitlement_overrides_updated, entitlement_overrides_removed, entitlement_overrides_auto_removed

**business** (14): business_entity_created, business_entity_updated, business_entity_deleted, business_rule_created, business_rule_updated, business_rule_activated, business_rule_deactivated, business_rule_deleted, business_rule_released, business_ruleset_created, business_ruleset_updated, business_ruleset_activated, business_ruleset_deactivated, business_ruleset_deleted

**organization** (2): organization_details_created, organization_details_updated

**purchase** (1): purchase_created

**voucher** (3): voucher_created, voucher_expired, voucher_create_failed

**price** (6): price_variant_created, price_variant_updated, price_variant_deleted, price_ramp_created, price_ramp_updated, price_ramp_deleted

**omnichannel** (28): omnichannel_subscription_created, omnichannel_subscription_item_renewed, omnichannel_subscription_item_downgraded, omnichannel_subscription_item_expired, omnichannel_subscription_item_cancellation_scheduled, omnichannel_subscription_item_scheduled_cancellation_removed, omnichannel_subscription_item_resubscribed, omnichannel_subscription_item_upgraded, omnichannel_subscription_item_cancelled, omnichannel_subscription_imported, omnichannel_subscription_item_grace_period_started, omnichannel_subscription_item_grace_period_expired, omnichannel_subscription_item_dunning_started, omnichannel_subscription_item_dunning_expired, omnichannel_subscription_item_change_scheduled, omnichannel_subscription_item_scheduled_change_removed, omnichannel_subscription_item_reactivated, omnichannel_subscription_item_changed, omnichannel_subscription_item_paused, omnichannel_subscription_item_resumed, omnichannel_one_time_order_created, omnichannel_one_time_order_item_cancelled, omnichannel_subscription_item_pause_scheduled, omnichannel_subscription_moved_in, omnichannel_transaction_created, omnichannel_subscription_item_updated, omnichannel_subscription_item_recovered, omnichannel_subscription_item_mrr_updated

**rule** (3): rule_created, rule_updated, rule_deleted

**record** (1): record_purchase_failed

**sales** (2): sales_order_created, sales_order_updated

**usage** (1): usage_file_ingested

**alert** (1): alert_status_changed

**ledger** (2): ledger_account_balance_updated, ledger_updated

**grant** (2): grant_blocks_created, grant_blocks_updated

**vault** (3): vault_token_created, vault_token_updated, vault_token_deleted

**chargeback** (3): chargeback_initiated, chargeback_won, chargeback_lost

**collections** (13): collections_reminder_sequence_created, collections_reminder_sequence_paused, collections_reminder_sequence_resumed, collections_reminder_sequence_completed, collections_payment_promise_created, collections_payment_promise_updated, collections_payment_promise_fulfilled, collections_payment_promise_cancelled, collections_payment_promise_broken, collections_dispute_created, collections_dispute_updated, collections_dispute_resolved, collections_dispute_withdrawn

**email** (1): email_message_received

**private** (1): private_note_added

## Actions by group (* asks first)

**subscriptions** (54): remove_an_advance_invoice_schedules*, update_subscription_for_items*, remove_coupons*, resume_a_subscription*, cancel_subscription_for_items*, regenerate_an_invoice*, list_subscriptions, move_a_subscription*, retrieve_advance_invoice, remove_scheduled_cancellation*, retrieve_with_scheduled_changes, reactivate_a_subscription*, charge_future_renewals*, add_charge_at_term_end*, remove_scheduled_changes*, change_term_end*, delete_a_subscription*, import_unbilled_charges*, remove_scheduled_resumption*, retrieve_a_subscription, import_contract_term*, override_billing_profile*, remove_scheduled_pause*, edit_advance_invoice_schedule*, list_discounts_for_a_subscription, list_contract_terms_for_a_subscription, pause_a_subscription*, scheduled_changes_a_subscription_scheduled_change, update_scheduled_changes_a_subscription_scheduled_change*, subscription_renewal_estimate, cancel_subscription_for_items_estimate, resume_subscription_estimate, regenerate_invoice_estimate, subscription_change_term_end_estimate, pause_subscription_estimate, advance_invoice_estimate, retrieve_a_usage, create_a_usage*, delete_a_usage*, enable_or_disable_subscription_entitlements*, list_subscription_entitlements, list_entitlement_overrides_for_a_subscription, upsert_or_remove_entitlement_overrides_for_a_subscription*, create_a_ramp*, retrieve_usage_summary_for_a_subscription, retrieve_usage_charges_for_a_subscription, list_applicable_alerts_for_a_subscription, list_alert_statuses_for_a_subscription, create_a_subscription*, import_a_subscription*, update_a_subscription*, cancel_a_subscription*, charge_addon_at_term_end*, cancel_subscription_estimate

**customers** (40): import_subscription_for_items*, create_subscription_for_items*, link_a_customer*, delink_a_customer*, delete_contacts_for_a_customer*, assign_payment_role*, move_a_customer*, update_payment_method_for_a_customer*, list_customers, create_a_customer*, list_of_contacts_for_a_customer, clear_personal_data_of_a_customer*, record_an_excess_payment_for_a_customer*, send_payment_request_email*, update_hierarchy_access_settings_for_a_customer*, update_billing_info_for_a_customer*, delete_a_customer*, get_hierarchy, retrieve_a_customer, update_a_customer*, list_hierarchy_details, change_billing_date*, add_contacts_to_a_customer*, merge_customers*, collect_payment_for_customer*, update_contacts_for_a_customer*, copy_card*, switch_gateway*, delete_card_for_a_customer*, update_card_for_a_customer*, list_email_logs_for_a_customer, upcoming_invoices_estimate, estimate_for_creating_a_subscription, create_a_quote_for_a_new_subscription_items*, list_customer_entitlements, list_vouchers_for_a_customer, import_subscription_for_customer*, create_subscription_for_customer*, create_subscription_for_a_customer_estimate, create_quote_for_a_new_subscription*

**tokens** (3): create_using_vault_temp_token*, create_a_card_payment_method_token*, retrieve_a_token

**payment_sources** (17): create_using_permanent_token*, delete_a_payment_source*, create_a_card_payment_source*, list_gateway_payment_method_tokens_for_a_payment_source*, verify_bank_account_payment_source*, list_payment_sources, export_payment_source*, create_using_payment_intent*, retrieve_a_payment_source, create_a_voucher_payment_method*, create_using_gateway_temporary_token*, update_a_card_payment_source*, switch_gateway_account*, create_using_chargebee_token*, local_delete_a_payment_source*, create_a_bank_account_payment_source*, update_a_bank_account_payment_source*

**vaulted_payment_methods** (1): retrieve_vaulted_payment_method

**virtual_bank_accounts** (6): local_delete_a_virtual_bank_account*, delete_a_virtual_bank_account*, list_virtual_bank_accounts, create_a_virtual_bank_account*, retrieve_a_virtual_bank_account, create_a_virtual_bank_account_using_permanent_token*

**cards** (1): retrieve_card_for_a_customer

**promotional_credits** (5): retrieve_a_promotional_credit, list_promotional_credits, deduct_promotional_credits*, set_promotional_credits*, add_promotional_credits*

**gateway_request_logs** (2): retrieve_a_gateway_request_log, list_gateway_request_logs

**gateway_webhook_logs** (2): retrieve_a_gateway_webhook_log, list_gateway_webhook_logs

**invoices** (42): delete_line_items*, remove_credit_note_from_an_invoice*, remove_payment_from_an_invoice*, stop_dunning_for_invoice*, apply_payments_for_an_invoice*, apply_payment_schedule_scheme_to_an_invoice*, void_an_invoice*, add_one_time_charge_to_a_pending_invoice*, send_an_einvoice_for_invoices*, retrieve_payment_schedules_for_an_invoice, write_off_an_invoice*, add_a_charge_item_to_a_pending_invoice*, pause_dunning_for_invoice*, list_invoices, void_authorizations_before_capture*, close_a_pending_invoice*, apply_credits_for_an_invoice*, send_invoice_email*, retrieve_an_invoice, create_invoice_for_items_and_one_time_charges*, update_invoice_details*, record_an_invoice_payment*, delete_an_invoice*, import_invoice*, resume_dunning_for_invoice*, record_tax_withheld_for_an_invoice*, resend_failed_einvoice_in_invoices*, remove_tax_withheld_for_an_invoice*, list_payment_reference_numbers, remove_payment_schedule_scheme_from_an_invoice*, collect_payment_for_an_invoice*, sync_usages*, refund_an_invoice*, record_refund_for_an_invoice*, retrieve_invoice_as_pdf, download_e_invoice, list_payments_for_an_invoice, list_vouchers_for_an_invoice, create_invoice_for_a_non_recurring_addon*, add_non_recurring_addon_to_a_pending_invoice*, create_an_invoice*, create_invoice_for_a_one_time_charge*

**payment_schedules** (1): list_payment_schedules

**credit_notes** (15): record_refund_for_a_credit_note*, import_credit_note*, delete_a_credit_note*, retrieve_credit_note_as_pdf, send_an_einvoice_for_credit_notes*, void_a_credit_note*, refund_a_credit_note*, list_credit_notes, create_credit_note*, update_credit_note_details*, download_e_invoice_for_credit_note, resend_failed_einvoice_in_credit_notes*, remove_tax_withheld_refunds_from_a_credit_note*, retrieve_a_credit_note, send_credit_note_email*

**unbilled_charges** (6): delete_an_unbilled_charge*, create_an_estimate_for_unbilled_charges, create_an_invoice_for_unbilled_charges*, list_unbilled_charges, create_unbilled_charges_for_item_subscription*, create_unbilled_charges_for_a_subscription*

**orders** (11): list_orders, create_an_order*, import_an_order*, assign_order_number*, resend_an_order*, reopen_a_cancelled_order*, cancel_an_order*, retrieve_an_order, update_an_order*, delete_an_imported_order*, create_a_refundable_credit_note*

**gifts** (7): create_a_gift_subscription_for_items*, cancel_a_gift*, update_a_gift*, list_gifts, retrieve_a_gift, claim_a_gift*, create_a_gift*

**transactions** (8): list_transactions, reconcile_transaction*, retrieve_a_transaction, refund_a_payment*, record_an_offline_refund*, void_an_authorization_transaction*, create_an_authorization_payment*, delete_an_offline_transaction*

**disputes** (2): retrieve_a_dispute, list_disputes

**hosted_pages** (20): checkout_charge_items_and_one_time_charges*, extend_subscription*, notify_an_event*, checkout_gift_subscription_for_items*, list_hosted_pages, create_a_hosted_page_to_view_boleto_vouchers*, collect_now*, accept_a_quote*, create_checkout_for_a_new_subscription*, claim_a_gift_subscription*, create_checkout_to_update_a_subscription*, create_a_pre_cancel_hosted_page*, acknowledge_a_hosted_page*, retrieve_direct_debit_agreement_pdf, retrieve_a_hosted_page, manage_payment_sources*, checkout_one_time_payments*, checkout_new_subscription*, checkout_gift_subscription*, checkout_existing_subscription*

**estimates** (9): estimate_for_creating_a_customer_and_subscription, estimates_for_payment_schedules, create_invoice_for_items_estimate, gift_subscription_estimate_for_items, estimate_for_updating_a_subscription, update_subscription_estimate, gift_subscription_estimate, create_subscription_estimate, create_invoice_estimate

**quotes** (19): retrieve_a_quote, update_quote_status*, extend_expiry_date*, edit_update_subscription_quote_for_items*, list_quotes, convert_a_quote*, delete_a_quote*, edit_create_subscription_quote_for_items*, create_a_quote_for_update_subscription_items*, list_quote_line_groups, edit_quote_for_charge_items_and_charges*, retrieve_quote_as_pdf, create_a_quote_for_charge_and_charge_items*, list_quote_entitlements, edit_quote_for_one_time_charges*, create_quote_for_updating_a_subscription*, create_quote_for_one_time_charges*, edit_quote_for_updating_a_subscription*, edit_quote_for_a_new_subscription*

**coupons** (9): list_coupons, update_a_coupon_for_items*, unarchive_a_coupon*, delete_a_coupon*, copy_a_coupon*, retrieve_a_coupon, create_a_coupon_for_items*, create_a_coupon*, update_a_coupon*

**coupon_sets** (7): list_coupon_sets, create_a_coupon_set*, update_a_coupon_set*, retrieve_a_coupon_set, add_coupon_codes_to_coupon_set*, delete_unused_coupon_codes*, delete_a_coupon_set*

**coupon_codes** (3): list_coupon_codes, retrieve_a_coupon_code, archive_a_coupon_code*

**addresses** (2): retrieve_an_address, update_an_address*

**usages** (2): retrieve_usages_for_an_invoice_as_pdf, list_usages

**events** (2): list_events, retrieve_an_event

**comments** (4): delete_a_comment*, retrieve_a_comment, list_comments, create_a_comment*

**portal_sessions** (4): create_a_portal_session*, activate_a_portal_session*, logout_a_portal_session*, retrieve_a_portal_session*

**site_migration_details** (1): list_site_migration_details

**resource_migrations** (1): retrieve_latest_migration_details

**time_machines** (3): retrieve_a_time_machine, travel_forward*, start_afresh*

**exports** (19): export_customers*, export_attached_items*, export_transactions*, export_subscription_ramps*, export_differential_price*, export_item_families*, export_invoices*, retrieve_an_export, export_price_variants*, export_items*, export_deferred_revenue_reports*, export_revenue_recognition_reports*, export_credit_notes*, export_coupons*, export_orders*, export_item_prices*, export_subscriptions*, export_addons*, export_plans*

**full_exports** (1): retrieve_full_export_status

**payment_intents** (3): retrieve_a_payment_intent, update_a_payment_intent*, create_a_payment_intent*

**custom_field_configs** (2): retrieve_the_meta_data, list_custom_field_configs

**item_families** (5): delete_an_item_family*, list_item_families, create_an_item_family*, retrieve_an_item_family, update_an_item_family*

**products** (8): retrieve_a_product, update_a_product*, delete_a_product*, add_remove_or_update_options_for_the_product*, list_products, create_a_product*, list_product_variants, create_a_product_variant*

**variants** (3): retrieve_a_product_variant, update_a_product_variant*, delete_a_product_variant*

**items** (9): list_items, create_an_item*, delete_an_item*, retrieve_an_item, update_an_item*, list_attached_items, create_an_attached_item*, list_item_entitlements_for_an_item, upsert_or_remove_item_entitlements_for_an_item*

**price_variants** (5): delete_a_price_variant*, list_price_variants, create_a_price_variant*, retrieve_a_price_variant, update_a_price_variant*

**item_prices** (8): retrieve_an_item_price, update_an_item_price*, delete_an_item_price*, list_applicable_item_prices_for_a_plan_item_price, list_applicable_items_for_a_plan_item_price, list_item_prices, create_an_item_price*, create_a_differential_price*

**attached_items** (3): retrieve_an_attached_item_, update_an_attached_item*, delete_an_attached_item*

**differential_prices** (4): delete_a_differential_price*, list_differential_prices, retrieve_a_differential_price, update_a_differential_price*

**price_ramps** (5): list_price_ramps, create_a_price_ramp*, delete_a_price_ramp*, retrieve_a_price_ramp, update_a_price_ramp*

**configurations** (1): list_site_configurations

**features** (10): list_features, create_a_feature*, delete_a_feature*, retrieve_a_feature, update_a_feature*, archive_a_feature*, activate_a_feature*, reactivate_a_feature*, list_item_entitlements_for_a_feature, upsert_or_remove_item_entitlements_for_a_feature*

**credit_units** (5): list_credit_units, create_a_credit_unit*, archive_a_credit_unit*, update_a_credit_unit*, reactivate_a_credit_unit*

**entitlements** (2): list_all_entitlements, upsert_or_remove_entitlements_for_a_feature*

**in_app_subscriptions** (4): retrieve_store_subscription, import_receipt*, import_subscription_without_receipt*, process_purchase_command*

**non_subscriptions** (1): one_time_purchase*

**business_entities** (6): retrieve_a_business_entity, update_business_entity*, list_business_entities, create_a_business_entity*, list_the_business_entity_transfers, transfer_resources_to_another_business_entity*

**purchases** (2): create_a_purchase*, estimates_for_purchase

**payment_vouchers** (2): retrieve_voucher_data, create_a_voucher_for_the_customer_to_initiate_payment*

**csv_tax_rules** (1): taxes_csv_import*

**organization_details** (3): list_organization_details, update_organization_details*, retrieve_organization_details

**currencies** (6): add_schedule*, add_a_new_currency*, retrieve_a_currency, update_a_currency*, remove_schedule*, list_currencies

**ramps** (4): retrieve_a_ramp, list_ramps, update_a_subscription_ramp*, delete_a_ramp*

**payment_schedule_schemes** (4): retrieve_a_payment_schedule_scheme, list_payment_schedule_schemes, create_a_payment_schedule_scheme*, delete_a_payment_schedule_scheme*

**pc2_migrations** (4): contact_support_a_pc2_migration*, retrieve_a_pc2_migration, create_a_pc2_migration*, initiate_a_pc2_migration*

**pc2_migration_item_families** (5): delete_draft_family*, retrieve_a_pc2_migration_item_family, update_a_pc2_migration_item_family*, list_pc2_migration_item_families, create_a_pc2_migration_item_family*

**pc2_migration_items** (6): retrieve_a_pc2_migration_item, update_a_pc2_migration_item*, delete_draft_item*, list_pc2_migration_items, create_a_pc2_migration_item*, applicable_items_a_pc2_migration_item

**pc2_migration_item_prices** (4): list_pc2_migration_item_prices, delete_draft_item_price*, retrieve_a_pc2_migration_item_price, update_a_pc2_migration_item_price*

**pricing_page_sessions** (2): create_pricing_page_for_existing_subscription*, create_pricing_page_for_new_subscription*

**site_pc_meta_records** (1): list_site_pc_meta_records

**omnichannel_subscriptions** (4): move_an_omnichannel_subscription*, retrieve_an_omnichannel_subscription, list_omnichannel_transactions_of_an_omnichannel_subscription, list_omnichannel_subscriptions

**omnichannel_subscription_items** (1): list_scheduled_changes_for_omnichannel_subscription_item

**recorded_purchases** (2): retrieve_a_recorded_purchase, record_a_purchase*

**omnichannel_one_time_orders** (2): list_omnichannel_one_time_orders, retrieve_an_omnichannel_one_time_order

**rules** (1): retrieve_rule_data

**retry_segments** (1): retrieve_a_retry_segment

**meters** (1): list_all_available_meters

**usage_events** (1): create_a_usage_event*

**batch** (1): ingest_usages_in_batch*

**metered_features** (4): reactivate_a_metered_feature*, delete_a_metered_feature*, create_a_metered_feature*, archive_a_metered_feature*

**usage_files** (2): get_uploaded_file_processing_status, get_usages_file_upload_url*

**einvoices** (2): list_e_invoices, retrieve_an_e_invoice

**personalized_offers** (1): list_personalized_offers

**offer_fulfillments** (3): create_an_offer_fulfillment*, retrieve_an_offer_fulfillment, update_an_offer_fulfillment*

**offer_events** (1): create_an_offer_event*

**webhook_endpoints** (5): delete_a_webhook_endpoint*, retrieve_a_webhook_endpoint, update_a_webhook_endpoint*, list_webhook_endpoints, create_a_webhook_endpoint*

**business_rules** (11): apply_business_rules*, delete_a_business_rule_draft*, release_a_business_rule*, activate_a_business_rule*, retrieve_a_business_rule_draft, update_a_business_rule_draft*, delete_a_business_rule*, deactivate_a_business_rule*, retrieve_a_business_rule, list_business_rules, create_a_business_rule*

**business_rulesets** (10): retrieve_a_business_ruleset, update_a_business_ruleset*, remove_business_rules_from_a_ruleset*, delete_a_business_ruleset*, deactivate_a_business_ruleset*, list_rules_in_a_business_ruleset, list_business_rulesets, create_a_business_ruleset*, activate_a_business_ruleset*, add_business_rules_to_a_ruleset*

**alerts** (6): retrieve_an_alert, update_an_alert*, delete_an_alert*, list_alerts, create_an_alert*, list_alert_statuses_for_an_alert

**collections_payment_promises** (5): list_collections_payment_promises, create_a_collections_payment_promise*, cancel_a_collections_payment_promise*, retrieve_a_payment_promise, update_a_collections_payment_promise*

**ledger_account_balances** (2): update_overdraft_limit*, list_ledger_account_balances

**ledger_operations** (7): release_authorization*, capture*, allocate*, authorize*, list_ledger_operations, capture_authorization*, retrieve_ledger_operation

**grant_blocks** (1): list_grant_blocks

**promotional_grants** (1): create_promotional_grant*

**plans** (7): unarchive_a_plan*, delete_a_plan*, copy_a_plan*, list_plans, create_a_plan*, retrieve_a_plan, update_a_plan*

**addons** (7): copy_an_addon*, unarchive_an_addon*, retrieve_an_addon, update_an_addon*, list_addons, create_an_addon*, delete_an_addon*
