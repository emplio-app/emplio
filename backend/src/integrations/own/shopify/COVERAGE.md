# Shopify coverage

Source: Shopify's Admin GraphQL API, version 2026-10 (the REST Admin API is legacy), read by introspection from
shopify.dev's public GraphiQL proxy on 2026-11-19 by `bun src/integrations/own/shopify/generate.ts` (run from backend/).
Every query and mutation that isn't deprecated is an action (750 = 278 queries + 483 mutations, less 11 below), with its
arguments as input and a default set of fields to return, sized under Shopify's 1,000-point query cost. Every generated
operation was checked against the schema with graphql-js. Every action also takes `fields` to return other fields.
Plus 5 hand-written actions and 42 aliases under Composio's names. Benchmark: Composio's `shopify` toolkit (478 tools,
45 triggers), from `coverage.ts`.

## Deliberately left out

| What | Why |
| --- | --- |
| appPurchaseOneTimeCreate, appSubscriptionCreate/Cancel/LineItemUpdate/TrialExtend, appUsageRecordCreate (Composio's application charges, usage charges, app subscriptions) | App billing: only public apps charge merchants, and this is the store's own app |
| taxAppConfigure, taxSummaryCreate | Only tax partner apps may call them |
| shopifyPaymentsPayoutAlternateCurrencyCreate, financeAppAccessPolicy, financeKycInformation | Only Shopify's finance partners may call them |
| 74 deprecated operations | Each has a named replacement that is an action (collectionAddProducts → update_collection, productCreateMedia → update_product / create_file, fulfillmentCreateV2 → create_fulfillment…) |
| A public Shopify app with an install page (OAuth) | Not wanted: it needs a Partner account and Shopify's app review. Owners paste their own app's key instead |
| Polled triggers | Everything Shopify can report has a webhook topic, so none are needed |

## Composio names not matched (294)

Composio's toolkit is mostly the legacy REST API, so names differ. Its capabilities map here:

| Composio | Here |
| --- | --- |
| custom / smart collections, collects, add_product_to_collection, list_collection_products | One kind of collection in GraphQL: list_collections, get_collection (its products), create_collection, update_collection (products by `sourcesToCreate`) |
| price rules, discount codes, batch codes, lookups | list_discount_nodes, get_discount_node, get_code_discount_node_by_code, create_discount_code_basic / bxgy / free_shipping, add_discount_redeem_code_bulk, … |
| product images | create_file / upload_file, update_product (media), product_variant_append_media, delete_file |
| per-resource metafield calls (product, shop, order…) | set_metafields, delete_metafields, and each resource's get_* (its metafields); list_metafield_definitions |
| count_* | count_* where Shopify has a count (orders, products, customers, collections, draft orders, gift cards…); otherwise list_* with `fields` |
| order risks, transactions, refunds | get_order (risk, transactions, refunds), create_order_risk_assessment, order_create_manual_payment, capture_order, create_refund, calculate_refund |
| fulfillment events, holds, moves, requests | get_fulfillment_order, get_fulfillment, create_fulfillment_event, hold_fulfillment_order, fulfillment_order_release_hold, move_fulfillment_order, fulfillment_order_submit_/accept_/reject_… |
| redirects | list_url_redirects, create_url_redirect, update_url_redirect, delete_url_redirect |
| theme assets | get_theme (its files), upsert_theme_files, delete_theme_files, copy_theme_files |
| countries, provinces, shipping zones, currencies | list_delivery_profiles, update_delivery_profile, list_markets, get_shop (currency settings) |
| checkouts, checkout payments, checkout profiles | list_abandoned_checkouts, get_abandonment, list_checkout_and_accounts_configurations |
| payments balance, payouts, balance transactions, disputes | get_shopify_payments_account (balance, payouts, transactions), list_disputes, get_dispute, update_dispute_evidence |
| users, current user, access scopes | list_staff_members, get_current_staff_member, get_current_app_installation |
| product/collection listings, publish | list_publications, publish_publishable, unpublish_publishable |
| comments, article tags | list_comments, approve_comment, comment_spam, comment_not_spam, delete_comment, list_article_tags, list_articles |
| graph_ql_* helpers (orders, products, customers…) | graphql_query, graphql, get_graphql_type, or the matching generated action |
| analytics | run_analytics_query (= get_shopifyql_query, ShopifyQL) |
| EventBridge / Pub/Sub webhooks | Deprecated; create_webhook_subscription takes any address |

## Sign-in

| Method | Status |
| --- | --- |
| Store + Admin API access token (`shpat_`) of a legacy custom app made in the store admin (none can be made since 2026-01-01) | done |
| Store + Client ID + Client secret of an app made in the Dev Dashboard; swapped for a 24-hour token by the client credentials grant, kept per key in memory, renewed 5 minutes early and when Shopify turns it down | done |
| Shopify OAuth through a public app | left out (above) |

The client credentials grant only works when the app and the store belong to the same Shopify organization, so the
app must be made from the store's own admin (Settings → Apps → Develop apps → Build apps in Dev Dashboard). A 401 marks
the connection expired (uninstalled app or revoked token). Missing scopes come back as `_warnings` with the rest of the
answer, or as an error when nothing came back.

## Hand adjustments (client.ts, index.ts, generate.ts)

- Lists ask for 10 unless `first`/`last` is given; Shopify requires one.
- A mutation's `userErrors` (and `*UserErrors`) are a failure, not an answer.
- Throttling (THROTTLED, 429, 5xx) waits as long as Shopify's cost header says, up to 10 s, twice.
- A `fields` override must have matched braces, so a read-only action can't carry a second operation.
- Mutations that only calculate run without asking: calculate_draft_order, preview_draft_order_invoice,
  subscription_contract_create_calculate, subscription_billing_cycle_contract_edit_calculate, flow_generate_signature.
- Names: queries are list_/get_/count_ plus the field; mutations put a final verb first (orderCancel → cancel_order).
- Hand-written: graphql* (any document; asks), graphql_query (refuses mutations; runs unasked), get_graphql_type,
  upload_file (staged upload, then Files), calculate_refund (Order.suggestedRefund, ready for create_refund).

## Triggers (webhooks, 280)

One subscription per topic per connection, made with webhookSubscriptionCreate after looking ours up by address, and
deleted when its last automation goes. Address: /webhooks/app/shopify/<connection>/<token>, the token an HMAC of
ENCRYPTION_KEY and the connection. Dev Dashboard keys also have Shopify's `X-Shopify-Hmac-Sha256` checked with the
client secret; legacy tokens sign with a secret we're never given, so the address token is the proof there.
Deliveries are deduplicated by `X-Shopify-Webhook-Id`.

- Every one of the 234 topics in WebhookSubscriptionTopic, named like `orders_create`, `orders_paid`, `refunds_create`,
  `checkouts_create`, `inventory_levels_update`, `variants_out_of_stock`…
- Composio's 45 names for the same topics (product_created, inventory_level_updated, shop_settings_updated…).
- `inventory_low`: inventory_levels/update filtered by the server to stock below `below` (and one `location_id`).
  It starts on each change while stock stays below.
- Inventory level topics take `location_id`.

## Not tried live

No store was available: sign-in, a real webhook delivery, and Shopify's real answers are tested with faked fetch only.

## Actions by group (* asks first)

**hand-written** (5): graphql*, graphql_query, get_graphql_type, upload_file*, calculate_refund

**abandoned** (2): list_abandoned_checkouts, count_abandoned_checkouts

**abandonment** (3): get_abandonment, get_abandonment_by_abandoned_checkout_id, abandonment_update_activities_delivery_statuses*

**analytics** (7): create_analytics_annotation*, delete_analytics_annotation*, update_analytics_annotation*, create_analytics_target*, update_analytics_target*, list_analytics_targets, delete_analytics_targets*

**app** (10): get_app, get_app_by_handle, get_app_by_key, get_app_discount_type, get_app_discount_types, list_app_discount_types_nodes, get_app_installation, list_app_installations, app_revoke_access_scopes*, app_uninstall*

**article** (6): get_article, list_article_authors, create_article*, delete_article*, get_article_tags, update_article*

**articles** (1): list_articles

**assigned** (1): list_assigned_fulfillment_orders

**automatic** (1): list_automatic_discount_saved_searches

**available** (3): get_available_backup_regions, get_available_carrier_services, get_available_locales

**backup** (2): get_backup_region, update_backup_region*

**blog** (4): get_blog, create_blog*, delete_blog*, update_blog*

**blogs** (2): list_blogs, count_blogs

**bulk** (6): get_bulk_operation, cancel_bulk_operation*, bulk_operation_run_mutation*, bulk_operation_run_query*, list_bulk_operations, create_bulk_product_resource_feedback*

**business** (2): get_business_entities, get_business_entity

**carrier** (5): get_carrier_service, create_carrier_service*, delete_carrier_service*, update_carrier_service*, list_carrier_services

**cart** (3): create_cart_transform*, delete_cart_transform*, list_cart_transforms

**cash** (12): get_cash_drawer, create_cash_drawer*, cash_drawer_find_or_create*, update_cash_drawer*, list_cash_drawers, get_cash_management_location_summary, create_cash_management_reason_code*, delete_cash_management_reason_code*, list_cash_management_reason_codes, get_cash_management_shop_summary, get_cash_tracking_session, list_cash_tracking_sessions

**catalog** (6): get_catalog, update_catalog_context*, create_catalog*, delete_catalog*, get_catalog_operations, update_catalog*

**catalogs** (2): list_catalogs, count_catalogs

**channel** (6): get_channel, get_channel_by_handle, create_channel*, delete_channel*, sync_channel_full*, update_channel*

**channels** (1): list_channels

**checkout** (3): get_checkout_and_accounts_configuration, update_checkout_and_accounts_configuration*, list_checkout_and_accounts_configurations

**code** (2): get_code_discount_node_by_code, list_code_discount_saved_searches

**collection** (14): get_collection, get_collection_by_identifier, get_collection_condition_metafield_definitions, create_collection_conditions_source*, delete_collection_conditions_source*, update_collection_conditions_source*, list_collection_conditions_sources, list_collection_conditions_sources_by_app, create_collection*, delete_collection*, duplicate_collection*, collection_reorder_products*, list_collection_saved_searches, update_collection*

**collections** (2): list_collections, count_collections

**combined** (1): update_combined_listing*

**comment** (5): get_comment, approve_comment*, delete_comment*, comment_not_spam*, comment_spam*

**comments** (1): list_comments

**companies** (3): list_companies, count_companies, delete_companies*

**company** (32): get_company, delete_company_address*, company_assign_customer_as_contact*, company_assign_main_contact*, get_company_contact, company_contact_assign_role*, company_contact_assign_roles*, create_company_contact*, delete_company_contact*, company_contact_remove_from_company*, company_contact_revoke_role*, company_contact_revoke_roles*, get_company_contact_role, company_contact_send_welcome_email*, update_company_contact*, delete_company_contacts*, create_company*, delete_company*, get_company_location, company_location_assign_address*, company_location_assign_roles*, company_location_assign_staff_members*, create_company_location*, delete_company_location*, company_location_remove_staff_members*, company_location_revoke_roles*, update_company_location_tax_settings*, update_company_location*, list_company_locations, delete_company_locations*, company_revoke_main_contact*, update_company*

**consent** (3): get_consent_policy, get_consent_policy_regions, update_consent_policy*

**current** (2): get_current_app_installation, get_current_staff_member

**customer** (40): get_customer, get_customer_account_page, list_customer_account_pages, customer_add_tax_exemptions*, create_customer_address*, delete_customer_address*, update_customer_address*, get_customer_by_identifier, customer_cancel_data_erasure*, create_customer*, delete_customer*, update_customer_email_marketing_consent*, customer_generate_account_activation_url*, merge_customer*, get_customer_merge_job_status, get_customer_merge_preview, get_customer_payment_method, customer_payment_method_create_from_duplication_data*, customer_payment_method_credit_card_create*, customer_payment_method_credit_card_update*, customer_payment_method_get_duplication_data*, customer_payment_method_get_update_url*, create_customer_payment_method_paypal_billing_agreement*, update_customer_payment_method_paypal_billing_agreement*, create_customer_payment_method_remote*, revoke_customer_payment_method*, customer_payment_method_send_update_email*, customer_remove_tax_exemptions*, customer_replace_tax_exemptions*, customer_request_data_erasure*, get_customer_segment_members, get_customer_segment_members_query, create_customer_segment_members_query*, get_customer_segment_membership, customer_send_account_invite_email*, set_customer*, update_customer_sms_marketing_consent*, update_customer*, customer_update_default_address*, update_customer_whats_app_marketing_consent*

**customers** (2): list_customers, count_customers

**data** (1): data_sale_opt_out*

**delegate** (2): create_delegate_access_token*, destroy_delegate_access_token*

**delivery** (17): get_delivery_customization, delivery_customization_activation*, create_delivery_customization*, delete_delivery_customization*, update_delivery_customization*, list_delivery_customizations, get_delivery_profile, create_delivery_profile*, remove_delivery_profile*, update_delivery_profile*, list_delivery_profiles, list_delivery_promise_participants, update_delivery_promise_participants*, get_delivery_promise_provider, upsert_delivery_promise_provider*, get_delivery_promise_settings, update_delivery_setting*

**discount** (37): activate_discount_automatic*, create_discount_automatic_app*, update_discount_automatic_app*, create_discount_automatic_basic*, update_discount_automatic_basic*, delete_discount_automatic_bulk*, create_discount_automatic_bxgy*, update_discount_automatic_bxgy*, deactivate_discount_automatic*, delete_discount_automatic*, create_discount_automatic_free_shipping*, update_discount_automatic_free_shipping*, add_discount_bulk_tags*, remove_discount_bulk_tags*, activate_discount_code*, create_discount_code_app*, update_discount_code_app*, create_discount_code_basic*, update_discount_code_basic*, activate_discount_code_bulk*, deactivate_discount_code_bulk*, delete_discount_code_bulk*, create_discount_code_bxgy*, update_discount_code_bxgy*, deactivate_discount_code*, delete_discount_code*, create_discount_code_free_shipping*, update_discount_code_free_shipping*, delete_discount_code_redeem_code_bulk*, count_discount_codes, get_discount_node, list_discount_nodes, count_discount_nodes, add_discount_redeem_code_bulk*, get_discount_redeem_code_bulk_creation, list_discount_redeem_code_saved_searches, list_discount_tags

**dispute** (3): get_dispute, get_dispute_evidence, update_dispute_evidence*

**disputes** (1): list_disputes

**domain** (1): get_domain

**draft** (18): get_draft_order, get_draft_order_available_delivery_options, draft_order_bulk_add_tags*, delete_draft_order_bulk*, draft_order_bulk_remove_tags*, calculate_draft_order, complete_draft_order*, create_draft_order*, draft_order_create_from_order*, delete_draft_order*, duplicate_draft_order*, preview_draft_order_invoice, send_draft_order_invoice*, list_draft_order_saved_searches, get_draft_order_tag, update_draft_order*, list_draft_orders, count_draft_orders

**event** (2): get_event, update_event_bridge_server_pixel*

**events** (2): list_events, count_events

**file** (5): file_acknowledge_update_failed*, create_file*, delete_file*, list_file_saved_searches, update_file*

**files** (1): list_files

**flow** (2): flow_generate_signature, receive_flow_trigger*

**fulfillment** (34): get_fulfillment, cancel_fulfillment*, create_fulfillment_constraint_rule*, delete_fulfillment_constraint_rule*, update_fulfillment_constraint_rule*, get_fulfillment_constraint_rules, create_fulfillment*, create_fulfillment_event*, get_fulfillment_order, fulfillment_order_accept_cancellation_request*, fulfillment_order_accept_fulfillment_request*, cancel_fulfillment_order*, close_fulfillment_order*, hold_fulfillment_order*, fulfillment_order_line_items_prepared_for_pickup*, merge_fulfillment_order*, move_fulfillment_order*, open_fulfillment_order*, fulfillment_order_reject_cancellation_request*, fulfillment_order_reject_fulfillment_request*, fulfillment_order_release_hold*, fulfillment_order_report_progress*, reschedule_fulfillment_order*, split_fulfillment_order*, fulfillment_order_submit_cancellation_request*, fulfillment_order_submit_fulfillment_request*, list_fulfillment_orders, reroute_fulfillment_orders*, fulfillment_orders_set_fulfillment_deadline*, get_fulfillment_service, create_fulfillment_service*, delete_fulfillment_service*, update_fulfillment_service*, update_fulfillment_tracking_info*

**gift** (12): get_gift_card, get_gift_card_configuration, create_gift_card*, credit_gift_card*, deactivate_gift_card*, debit_gift_card*, set_gift_card_product*, gift_card_send_notification_to_customer*, gift_card_send_notification_to_recipient*, update_gift_card*, list_gift_cards, count_gift_cards

**inventory** (36): activate_inventory*, inventory_adjust_quantities*, inventory_bulk_toggle_activation*, deactivate_inventory*, get_inventory_item, update_inventory_item*, list_inventory_items, get_inventory_level, inventory_move_quantities*, get_inventory_properties, get_inventory_purchase_order, list_inventory_purchase_orders, inventory_set_quantities*, get_inventory_shipment, inventory_shipment_add_items*, create_inventory_shipment*, inventory_shipment_create_in_transit*, delete_inventory_shipment*, inventory_shipment_mark_in_transit*, receive_inventory_shipment*, inventory_shipment_remove_items*, inventory_shipment_set_barcode*, inventory_shipment_set_tracking*, inventory_shipment_update_item_quantities*, list_inventory_shipments, get_inventory_transfer, cancel_inventory_transfer*, create_inventory_transfer*, inventory_transfer_create_as_ready_to_ship*, delete_inventory_transfer*, duplicate_inventory_transfer*, edit_inventory_transfer*, inventory_transfer_mark_as_ready_to_ship*, inventory_transfer_remove_items*, inventory_transfer_set_items*, list_inventory_transfers

**job** (1): get_job

**location** (9): get_location, activate_location*, add_location*, get_location_by_identifier, deactivate_location*, delete_location*, edit_location*, disable_location_local_pickup*, enable_location_local_pickup*

**locations** (3): list_locations, list_locations_available_for_delivery_profiles_connection, count_locations

**manual** (1): list_manual_holds_fulfillment_orders

**market** (11): get_market, create_market*, delete_market*, get_market_localizable_resource, list_market_localizable_resources, list_market_localizable_resources_by_ids, register_market_localizations*, remove_market_localizations*, list_market_relationships, get_market_relationships_status, update_market*

**marketing** (11): list_marketing_activities, marketing_activities_delete_all_external*, get_marketing_activity, create_marketing_activity*, marketing_activity_delete_external*, update_marketing_activity*, marketing_activity_update_external*, marketing_activity_upsert_external*, create_marketing_engagement*, get_marketing_event, list_marketing_events

**markets** (2): list_markets, get_markets_resolved_values

**menu** (4): get_menu, create_menu*, delete_menu*, update_menu*

**menus** (1): list_menus

**metafield** (8): get_metafield_definition, create_metafield_definition*, delete_metafield_definition*, pin_metafield_definition*, get_metafield_definition_types, unpin_metafield_definition*, update_metafield_definition*, list_metafield_definitions

**metafields** (2): delete_metafields*, set_metafields*

**metaobject** (13): get_metaobject, delete_metaobject_bulk*, get_metaobject_by_handle, create_metaobject*, get_metaobject_definition, get_metaobject_definition_by_type, create_metaobject_definition*, delete_metaobject_definition*, update_metaobject_definition*, list_metaobject_definitions, delete_metaobject*, update_metaobject*, upsert_metaobject*

**metaobjects** (1): list_metaobjects

**mobile** (5): get_mobile_platform_application, create_mobile_platform_application*, delete_mobile_platform_application*, update_mobile_platform_application*, list_mobile_platform_applications

**node** (1): get_node

**nodes** (1): get_nodes

**online** (1): get_online_store

**order** (33): get_order, delete_order_attribution_definition*, upsert_order_attribution_definition*, list_order_attribution_definitions, get_order_by_identifier, cancel_order*, capture_order*, close_order*, create_order*, order_create_mandate_payment*, order_create_manual_payment*, remove_order_customer*, set_order_customer*, delete_order*, order_edit_add_custom_item*, order_edit_add_line_item_discount*, order_edit_add_shipping_line*, order_edit_add_variant*, order_edit_begin*, order_edit_commit*, order_edit_remove_discount*, order_edit_remove_shipping_line*, get_order_edit_session, order_edit_set_quantity*, order_edit_update_discount*, order_edit_update_shipping_line*, send_order_invoice*, order_mark_as_paid*, open_order*, get_order_payment_status, create_order_risk_assessment*, list_order_saved_searches, update_order*

**orders** (2): list_orders, count_orders

**page** (4): get_page, create_page*, delete_page*, update_page*

**pages** (2): list_pages, count_pages

**payment** (13): get_payment_customization, payment_customization_activation*, create_payment_customization*, delete_payment_customization*, update_payment_customization*, list_payment_customizations, payment_instrument_send_add_email*, send_payment_reminder*, capture_payment_schedule*, create_payment_terms*, delete_payment_terms*, get_payment_terms_templates, update_payment_terms*

**pending** (1): count_pending_orders

**point** (8): get_point_of_sale_device, point_of_sale_device_assign_to_cash_drawer*, get_point_of_sale_device_payment_session, point_of_sale_device_payment_session_adjust*, close_point_of_sale_device_payment_session*, point_of_sale_device_payment_session_count*, open_point_of_sale_device_payment_session*, list_point_of_sale_device_payment_sessions

**preview** (1): preview_install*

**price** (9): get_price_list, create_price_list*, delete_price_list*, add_price_list_fixed_prices*, update_price_list_fixed_prices_by_product*, delete_price_list_fixed_prices*, update_price_list_fixed_prices*, update_price_list*, list_price_lists

**privacy** (2): disable_privacy_features*, get_privacy_settings

**product** (41): get_product, create_product_bundle*, update_product_bundle*, get_product_by_identifier, create_product*, delete_product*, duplicate_product*, get_product_duplicate_job, get_product_feed, create_product_feed*, delete_product_feed*, list_product_feeds, sync_product_full*, product_join_selling_plan_groups*, product_leave_selling_plan_groups*, get_product_operation, update_product_option*, create_product_options*, delete_product_options*, reorder_product_options*, product_reorder_media*, get_product_resource_feedback, list_product_saved_searches, set_product*, list_product_tags, list_product_types, update_product*, get_product_variant, product_variant_append_media*, get_product_variant_by_identifier, product_variant_detach_media*, product_variant_join_selling_plan_groups*, product_variant_leave_selling_plan_groups*, update_product_variant_relationship_bulk*, list_product_variants, create_product_variants_bulk*, delete_product_variants_bulk*, reorder_product_variants_bulk*, update_product_variants_bulk*, count_product_variants, list_product_vendors

**products** (2): list_products, count_products

**pub** (1): update_pub_sub_server_pixel*

**public** (1): get_public_api_versions

**publication** (4): get_publication, create_publication*, delete_publication*, update_publication*

**publications** (2): list_publications, count_publications

**publishable** (2): publish_publishable*, unpublish_publishable*

**published** (1): count_published_products

**quantity** (3): update_quantity_pricing_by_variant*, add_quantity_rules*, delete_quantity_rules*

**refund** (2): get_refund, create_refund*

**remove** (1): remove_from_return*

**requested** (4): get_requested_order_edit_calculate, requested_order_edit_create*, requested_order_edit_decline*, requested_order_edit_resolve*

**return** (13): get_return, return_approve_request*, get_return_calculate, cancel_return*, close_return*, create_return*, return_decline_request*, get_return_policy_profile, list_return_policy_profiles, process_return*, list_return_reason_definitions, reopen_return*, request_return*

**returnable** (2): get_returnable_fulfillment, list_returnable_fulfillments

**reverse** (5): get_reverse_delivery, reverse_delivery_create_with_shipping*, update_reverse_delivery_shipping*, get_reverse_fulfillment_order, dispose_reverse_fulfillment_order*

**rollout** (1): get_rollout

**rollouts** (1): list_rollouts

**saved** (3): create_saved_search*, delete_saved_search*, update_saved_search*

**script** (5): get_script_tag, create_script_tag*, delete_script_tag*, update_script_tag*, list_script_tags

**segment** (7): get_segment, create_segment*, delete_segment*, list_segment_filter_suggestions, list_segment_filters, update_segment*, list_segment_value_suggestions

**segments** (2): list_segments, count_segments

**selling** (9): get_selling_plan_group, selling_plan_group_add_product_variants*, selling_plan_group_add_products*, create_selling_plan_group*, delete_selling_plan_group*, selling_plan_group_remove_product_variants*, selling_plan_group_remove_products*, update_selling_plan_group*, list_selling_plan_groups

**server** (3): get_server_pixel, create_server_pixel*, delete_server_pixel*

**shipping** (5): get_shipping_label, shipping_label_purchase*, delete_shipping_package*, shipping_package_make_default*, update_shipping_package*

**shop** (10): get_shop, get_shop_billing_preferences, disable_shop_locale*, enable_shop_locale*, update_shop_locale*, get_shop_locales, get_shop_pay_payment_request_receipt, list_shop_pay_payment_request_receipts, update_shop_policy*, create_shop_resource_feedback*

**shopify** (3): get_shopify_function, list_shopify_functions, get_shopify_payments_account

**shopifyql** (1): get_shopifyql_query

**staff** (2): get_staff_member, list_staff_members

**staged** (1): create_staged_uploads*

**standard** (3): enable_standard_metafield_definition*, list_standard_metafield_definition_templates, enable_standard_metaobject_definition*

**store** (4): get_store_credit_account, store_credit_account_credit*, store_credit_account_debit*, get_store_credit_configuration

**storefront** (2): create_storefront_access_token*, delete_storefront_access_token*

**subscription** (32): get_subscription_billing_attempt, create_subscription_billing_attempt*, list_subscription_billing_attempts, get_subscription_billing_cycle, charge_subscription_billing_cycle_bulk*, list_subscription_billing_cycle_bulk_results, subscription_billing_cycle_bulk_search*, charge_subscription_billing_cycle*, commit_subscription_billing_cycle_contract_draft*, subscription_billing_cycle_contract_draft_concatenate*, edit_subscription_billing_cycle_contract*, subscription_billing_cycle_contract_edit_calculate, subscription_billing_cycle_edit_delete*, delete_subscription_billing_cycle_edits*, edit_subscription_billing_cycle_schedule*, skip_subscription_billing_cycle*, unskip_subscription_billing_cycle*, list_subscription_billing_cycles, get_subscription_contract, activate_subscription_contract*, create_subscription_contract_atomic*, get_subscription_contract_calculation, commit_subscription_contract_calculation*, cancel_subscription_contract*, subscription_contract_create_calculate, expire_subscription_contract*, fail_subscription_contract*, pause_subscription_contract*, subscription_contract_product_change*, subscription_contract_set_next_billing_date*, subscription_contract_update_calculate*, list_subscription_contracts

**tags** (2): add_tags*, remove_tags*

**taxonomy** (1): get_taxonomy

**tender** (1): list_tender_transactions

**theme** (9): get_theme, create_theme*, delete_theme*, duplicate_theme*, copy_theme_files*, delete_theme_files*, upsert_theme_files*, publish_theme*, update_theme*

**themes** (1): list_themes

**transaction** (1): void_transaction*

**translatable** (3): get_translatable_resource, list_translatable_resources, list_translatable_resources_by_ids

**translations** (2): register_translations*, remove_translations*

**url** (14): get_url_redirect, url_redirect_bulk_delete_all*, url_redirect_bulk_delete_by_ids*, url_redirect_bulk_delete_by_saved_search*, url_redirect_bulk_delete_by_search*, create_url_redirect*, delete_url_redirect*, get_url_redirect_import, create_url_redirect_import*, submit_url_redirect_import*, list_url_redirect_saved_searches, update_url_redirect*, list_url_redirects, count_url_redirects

**validation** (4): get_validation, create_validation*, delete_validation*, update_validation*

**validations** (1): list_validations

**web** (8): get_web_pixel, create_web_pixel*, delete_web_pixel*, update_web_pixel*, create_web_presence*, delete_web_presence*, update_web_presence*, list_web_presences

**webhook** (6): get_webhook_subscription, create_webhook_subscription*, delete_webhook_subscription*, update_webhook_subscription*, list_webhook_subscriptions, count_webhook_subscriptions

