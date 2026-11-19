# Zoho Billing coverage

Source: Zoho's own OpenAPI files (zoho.com/billing/api/v1/openapi-all.zip, generated 2026-11-19 by `bun scripts/openapi-actions.ts zoho_billing`). Every operation in them is an action: 277 (274 generated, 3 by hand). Composio has no toolkit for Zoho Billing, so names come from Zoho's summaries.

## Left out

Nothing from the spec.

## Sign-in

Sign in with Zoho only (no key), through the shared Zoho client (`zohoOAuth`). Scope: `ZohoSubscriptions.fullaccess.all` (Billing's scopes keep the old Subscriptions name; this one is the docs' own example and covers every module, webhooks and settings included). Tokens last an hour and are renewed by `zohoOAuth`. Callback: `<API address>/oauth/zoho_billing/callback`.

Every call needs the organisation, sent in the `X-com-zoho-subscriptions-organizationid` header: `organization_id`, when left out, is the login's only organisation; with several, the error lists them. The organisation calls themselves don't take it. `check` labels the connection with the organisation name(s).

## Hand adjustments

- The organisation header is dropped from every action and sent from `organization_id` instead (as Zoho Invoice does).
- Defaults in Zoho's spec are stripped; `sort_order` (A or D) added next to every `sort_column`.
- Required fields fixed where the spec marks either-or fields as all required: creating a subscription (and its hosted page) needs only `plan`, with a `customer` or a `customer_id`; the update-payment-method hosted page needs one of card, bank account or PayPal.
- Three reporting tag calls (mark_option_as_active, mark_option_as_inactive, get_options) are written by hand: the spec's paths hold a regular expression where the id goes.
- Names that didn't say what they act on are renamed (mark_as_active → mark_addon_as_active, list_notes → list_subscription_notes, and so on); the hosted page calls are named `create_*_hosted_page` so they aren't mistaken for creating a subscription itself.
- Failures sent with a 200 become errors; a dead login (401 except scope errors, or INVALID_TOKEN) marks the connection expired.

## Triggers (polled, polls/zoho_billing.ts)

Billing's webhooks can be set up only in its own settings (Settings → Automation → Webhooks), not by API, so nothing is registered. Instead, Billing logs every happening as an event (kept 180 days, `list_of_events`), and the triggers read the newest 200 each check (every 15 minutes, at least 5):

- new_event: any of Zoho's 39 event kinds, or one picked with `event_type`.
- new_subscription (subscription_created), subscription_activated, subscription_cancelled, subscription_cancellation_scheduled, subscription_plan_changed (upgraded or downgraded), subscription_renewed, subscription_reactivated, subscription_expired, subscription_unpaid, trial_expiring, payment_received (payment_thankyou), payment_failed (payment_declined), payment_refunded, card_expiring (expiring or expired).
- Each takes `customer_id`, matched against the customer on the event's subscription, payment or invoice.
- new_invoice (customer_id, subscription_id filters) and new_customer read their lists, newest first.

## Not tried live

Nothing has been run against a real Zoho Billing account: the events list's order (assumed newest first) and payload shape (an object, or a JSON string, both handled) come from the docs.

## Actions by group (* asks first)

**addons** (10): add_addon_comment*, create_addon*, delete_addon*, delete_addon_comment*, list_addon_comments, list_addons, mark_addon_as_active*, mark_addon_as_inactive*, retrieve_addon, update_addon*

**bank-account** (1): retrieve_bank_account_information

**cards** (3): delete_credit_card*, list_active_credit_cards_of_customer, retrieve_credit_card_information

**contact-persons** (5): create_contact_person*, delete_contact_person*, list_of_contact_persons, retrieve_contact_person, update_contact_person*

**coupons** (11): bulk_mark_coupon_sets_as_active*, bulk_mark_coupon_sets_as_inactive*, create_coupon*, delete_coupon*, list_coupons, mark_a_coupon_as_active*, mark_a_coupon_as_inactive*, mark_coupon_set_as_active*, mark_coupon_set_as_inactive*, retrieve_coupon, update_coupon*

**credit-notes** (7): apply_credits_to_multiple_invoices*, create_credit_note*, delete_credit_note*, email_credit_note*, open_voided_credit_note*, retrieve_credit_note, void_credit_note*

**custom-module-records** (7): bulk_update_custom_module_records*, create_custom_module_record*, delete_custom_module_record*, delete_custom_module_records*, get_custom_module_record, list_custom_module_records, update_custom_module_record*

**custom-modules** (5): create_custom_module*, delete_custom_module*, get_custom_module, list_custom_modules, update_custom_module*

**customers** (9): create_customer*, delete_customer*, list_customers, list_of_transactions, mark_a_customer_as_active*, mark_a_customer_as_inactive*, retrieve_customer, retrieve_customer_using_crm_reference, update_customer*

**estimates** (19): add_quote_comment*, bulk_export_quotes, bulk_print_quotes, create_quote*, delete_a_comment_of_a_quote*, delete_quote*, email_multiple_quotes*, email_quote*, get_quote_email_content, list_quote_comments_history, list_quote_templates, list_quotes, mark_quote_as_accepted*, mark_quote_as_declined*, mark_quote_as_sent*, retrieve_quote, update_quote*, update_quote_comment*, update_quote_template*

**events** (2): list_of_events, retrieve_event

**expenses** (5): create_expense*, delete_expense*, list_expenses, retrieve_expense, update_expense*

**hosted-pages** (9): create_add_payment_method_hosted_page*, create_buy_addon_hosted_page*, create_invoice_payment_hosted_page*, create_new_subscription_hosted_page*, create_update_card_hosted_page*, create_update_payment_method_hosted_page*, create_update_subscription_hosted_page*, list_of_hosted_pages, retrieve_hosted_page

**integration** (2): import_customer_using_crm_account_id*, import_customer_using_crm_contact_id*

**invoices** (17): add_attachment_to_invoice*, add_items_to_pending_invoice*, apply_multiple_credits_to_invoice*, cancel_invoice_write_off*, collect_charge_via_bank_account_credit_card*, convert_invoice_to_open*, create_invoice*, delete_invoice*, delete_items_from_pending_invoice*, email_invoice*, list_invoices, retrieve_invoice, update_custom_field_in_existing_invoices*, update_invoice*, update_invoice_address*, void_invoice*, write_off_invoice*

**items** (8): bulk_fetch_item_details, create_item*, delete_item*, list_items, mark_an_item_as_active*, mark_an_item_as_inactive*, retrieve_item, update_item*

**organizations** (4): create_organization*, get_organization, list_organizations, update_organization*

**payment-links** (6): cancel_payment_link*, create_payment_link*, delete_payment_link*, list_payment_links, retrieve_payment_link, update_payment_link*

**payments** (5): create_payment*, delete_payment*, list_payments, retrieve_payment, update_payment*

**plans** (12): add_a_plan_comment*, create_plan*, delete_a_plan_comment*, delete_plan*, list_plan_comments, list_plans, mark_a_plan_as_active*, mark_a_plan_as_inactive*, mark_plan_as_free*, mark_plan_as_non_free*, retrieve_plan, update_plan*

**pricebooks** (8): create_pricebook*, delete_pricebook*, delete_pricebook_item*, delete_pricebook_line_item*, list_pricebooks, retrieve_pricebook, update_pricebook_item*, update_pricebook_line_item*

**products** (8): create_product*, delete_product*, list_of_products, mark_a_product_as_active*, mark_a_product_as_inactive*, retrieve_product, update_email_templates*, update_product*

**projects** (18): activate_project*, add_project_comment*, assign_project_users*, clone_project*, create_project*, deactivate_project*, delete_a_comment_of_a_project*, delete_project*, delete_project_user*, get_project, get_project_user, invite_project_user*, list_all_invoices_of_a_project, list_project_comments, list_project_users, list_projects, update_project*, update_project_user*

**recurring-expenses** (9): create_recurring_expense*, delete_recurring_expense*, list_child_expenses_created, list_recurring_expense_history, list_recurring_expenses, resume_recurring_expense*, retrieve_recurring_expense, stop_recurring_expense*, update_recurring_expense*

**refunds** (3): refund_credit_note*, refund_payment*, retrieve_refund_details

**reporting-tags** (14): create_reporting_tag*, delete_reporting_tag*, get_options, get_reporting_tags_options_detail_page, list_of_reporting_tags, mark_option_as_active*, mark_option_as_default_for_reporting_tag*, mark_option_as_inactive*, mark_reporting_tag_as_active*, mark_reporting_tag_as_inactive*, reorder_reporting_tags*, update_reporting_tag*, update_reporting_tag_options*, update_reporting_tag_visibility_conditions*

**settings** (4): retrieve_churn_message_preferences, retrieve_list_of_tax_authorities, retrieve_list_of_tax_exemptions, retrieve_list_of_taxes

**subscription** (32): add_edit_description_for_item_in_line_items_list*, add_subscription_charge*, add_subscription_contact_person*, add_subscription_note*, associate_coupon*, buy_one_time_addon*, cancel_subscription*, create_subscription*, delete_scheduled_changes*, delete_subscription*, delete_subscription_note*, disable_metered_billing*, enable_metered_billing*, extend_billing_cycles*, get_subscription_custom_fields, list_subscription_activities, list_subscription_notes, list_subscriptions, pause_subscription*, postpone_renewal*, reactivate_subscription*, remove_coupon*, remove_subscription_card*, resume_subscription*, retrieve_subscription, set_subscription_auto_collect*, update_subscription*, update_subscription_card*, update_subscription_custom_fields*, update_subscription_reference*, update_subscription_sales_person*, view_scheduled_changes

**tasks** (22): add_attachment_to_task*, add_comment_to_task*, add_project_task*, add_task*, delete_a_task*, delete_comment_of_task*, delete_document_of_task*, delete_project_task*, delete_tasks*, get_document_of_task, get_project_task, get_task, list_comments_of_task, list_project_tasks, list_tasks, mark_task_as_completed*, mark_task_as_ongoing*, mark_task_as_open*, update_a_task*, update_completed_percentage*, update_project_task*, update_tasks*

**time-entries** (9): delete_time_entries*, delete_time_entry*, get_time_entry, get_timer, list_time_entries, log_time_entries*, start_timer*, stop_timer*, update_time_entry*

**unbilled-charges** (3): convert_unbilled_charge_to_invoice*, delete_unbilled_charge*, retrieve_unbilled_charge

