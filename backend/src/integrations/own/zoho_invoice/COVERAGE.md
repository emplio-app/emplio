# Zoho Invoice coverage

Source: Zoho's own OpenAPI files (zoho.com/invoice/api/v3/openapi-all.zip, generated 2026-11-09 by `bun scripts/openapi-actions.ts zoho_invoice`). Every operation in them is an action.

## Sign-in

Sign in with Zoho only (no key). Scope: `ZohoInvoice.fullaccess.all` (the one Zoho's docs name for all of Invoice). Tokens last an hour and are renewed by `zohoOAuth`.

Every call needs the organisation, sent in Invoice's `X-com-zoho-invoice-organizationid` header. `organization_id`, when left out, is the login's only organisation; with several, the error lists them. The list is cached for 10 minutes per login. `check` labels the connection with the organisation name(s).

## Hand adjustments

- Spec defaults are stripped and `sort_order` is added next to `sort_column`, as for Books.
- Failures sent with a 200 become errors; a dead login marks the connection expired.

## Triggers (polled, polls/zoho_invoice.ts)

new_invoice, customer_changed (`<id>:<last_modified_time>`), payment_received. Each check looks at the newest 200.

## Actions by group (* asks first)

**contact-persons** (6): create_contact_person*, delete_contact_person*, get_contact_person, list_contact_persons, mark_contact_person_as_primary*, update_contact_person*

**contacts** (22): create_additional_address*, create_contact*, delete_additional_address*, delete_contact*, disable_contact_payment_reminders*, email_contact_statement*, enable_payment_reminders*, enable_portal_access*, get_client_review, get_contact, get_contact_addresses, get_statement_mail_content, list_client_reviews, list_contact_comments, list_contact_refunds, list_contacts, mark_contact_active*, mark_contact_inactive*, reply_client_review*, send_contact_email*, update_additional_address*, update_contact*

**credit-notes** (25): add_creditnote_to_invoices*, create_credit_note*, create_credit_note_comment*, create_refund_credit_note_refunds*, delete_comment*, delete_credit_note*, delete_credit_note_refund*, delete_invoices_credited*, email_credit_note*, get_credit_note, get_credit_note_email_history, get_credit_note_refund, list_credit_note_comments_history, list_credit_note_refunds, list_credit_note_templates, list_credit_notes, list_invoices_credited, list_refunds_of_credit_note, open_voided_credit_note*, update_billing_address*, update_credit_note*, update_credit_note_refund*, update_credit_note_template*, update_shipping_address*, void_credit_note*

**currency** (10): create_currency*, create_exchange_rate*, delete_currency*, delete_exchage_rate*, get_currency, get_exchange_rate, list_currencies, list_exchange_rates, update_currency*, update_exchange_rate*

**customer-payments** (11): create_customer_payment*, delete_customer_payment*, delete_refund*, details_of_refund, list_customer_payment_refunds, list_payments, refund_customer_payment*, retrieve_payment, update_custom_field_in_existing_customerpayments*, update_customer_payment_refund*, update_payment*

**estimates** (22): bulk_export_estimates, create_estimate*, create_estimate_comment*, delete_a_comment_of_an_estimate*, delete_estimate*, email_estimate*, email_multiple_estimates*, get_estimate, get_estimate_email_content, list_estimate_comments_history, list_estimate_templates, list_estimates, mark_estimate_as_accepted*, mark_estimate_as_declined*, mark_estimate_as_sent*, print_estimates, update_billing_address_of_an_estimate*, update_comment*, update_custom_field_in_existing_estimates*, update_estimate*, update_estimate_template*, update_shipping_address_of_an_estimate*

**expense-category** (7): create_expense_category*, delete_expense_category*, get_expense_category, list_expense_categories, mark_expense_category_active*, mark_expense_category_as_inactive*, update_expense_category*

**expenses** (9): create_employee*, create_expense*, delete_employee*, delete_expense*, get_expense, list_employees, list_expense_comments, list_expenses, update_expense*

**integration** (3): import_customer_using_crm_account_id*, import_customer_using_crm_contact_id*, import_item_using_crm_product_id*

**invoices** (39): add_a_comment_to_an_invoice*, add_attachment_to_invoice*, apply_credits_to_invoice*, cancel_write_off_invoice*, create_invoice*, delete_a_comment_of_an_invoice*, delete_a_payment_from_an_invoice*, delete_credit_notes_applied_to_invoice*, delete_invoice*, delete_invoice_attachment*, delete_invoice_expense_receipt*, disable_invoice_payment_reminder*, email_invoice*, email_invoices*, enable_invoice_payment_reminder*, export_invoices_bulk, get_invoice, get_invoice_attachment, get_invoice_email_content, get_payment_reminder_mail_content, list_credits_applied, list_invoice_comments, list_invoice_payments, list_invoice_templates, list_invoices, mark_as_draft*, mark_invoice_as_sent*, mark_invoice_as_void*, print_invoices, remind_customer*, send_bulk_invoice_reminder*, update_a_comment_of_an_invoice*, update_attachment_preference*, update_billing_address_of_an_invoice*, update_custom_field_in_existing_invoices*, update_invoice*, update_invoice_template*, update_shipping_address_of_an_invoice*, write_off_invoice*

**items** (9): bulk_fetch_item_details, create_item*, delete_item*, get_item, list_items, mark_an_item_as_active*, mark_an_item_as_inactive*, update_custom_field_in_existing_items*, update_item*

**organizations** (4): create_organization*, get_organization, list_organizations, update_organization*

**price-lists** (5): create_price_list*, delete_price_list*, get_price_list, list_price_lists, update_price_list*

**projects** (18): activate_project*, assign_users*, clone_project*, create_project*, create_project_comment*, delete_a_comment_of_a_project*, delete_project*, delete_user*, get_project, get_project_user, inactivate_project*, invite_user*, list_project_comments, list_project_invoices, list_project_users, list_projects, update_project*, update_user*

**recurring-expenses** (9): create_recurring_expense*, delete_recurring_expense*, get_recurring_expense, list_child_expenses_created, list_recurring_expense_history, list_recurring_expenses, resume_recurring_expense*, stop_recurring_expense*, update_recurring_expense*

**recurring-invoices** (9): create_recurring_invoice*, delete_recurring_invoice*, get_recurring_invoice, list_recurring_invoice, list_recurring_invoice_history, resume_recurring_invoice*, stop_recurring_invoice*, update_recurring_invoice*, update_recurring_invoice_template*

**retainer-invoices** (20): add_a_comment_to_a_retainer_invoice*, add_attachment_to_retainer_invoice*, create_retainer_invoice*, delete_a_comment_of_a_retainer_invoice*, delete_an_attachment_from_a_retainer_invoice*, delete_retainer_invoice*, email_retainer_invoice*, get_retainer_invoice, get_retainer_invoice_attachment, get_retainer_invoice_email_content, list_retainer_invoice_comments_history, list_retainer_invoice_templates, list_retainer_invoices, mark_a_voided_retainer_invoice_as_draft*, mark_retainer_invoice_as_sent*, update_a_comment_of_a_retainer_invoice*, update_billing_address_of_a_retainer_invoice*, update_retainer_invoice*, update_retainer_invoice_template*, void_retainer_invoice*

**tasks** (5): create_task*, delete_task*, get_all_tasks, get_task, update_project_task*

**taxes** (17): create_tax*, create_tax_authority*, create_tax_exemption*, create_tax_group*, delete_setting_taxes*, delete_tax_authority*, delete_tax_exemption*, delete_tax_group*, get_tax, get_tax_group, list_tax_authorities, list_tax_exemptions, list_taxes, update_tax*, update_tax_authority*, update_tax_exemption*, update_tax_group*

**time-entries** (9): create_time_entry*, delete_time_entries*, delete_time_entry*, get_time_entry, get_timer, list_time_entries, start_timer*, stop_timer*, update_time_entry*

**users** (9): create_user*, delete_a_user*, get_a_user, get_current_user, invite_a_user*, list_users, mark_user_as_active*, mark_user_as_inactive*, update_a_user*
