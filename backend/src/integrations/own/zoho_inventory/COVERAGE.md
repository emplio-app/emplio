# Zoho Inventory coverage

Source: Zoho's own OpenAPI files (zoho.com/inventory/api/v1/openapi-all.zip, generated 2026-11-19 by `bun scripts/openapi-actions.ts zoho_inventory`). Every operation in them is an action: 583 in all, against Composio's 91 (all 91 matched by name).

## Left out

Nothing. Zoho's webhooks for Inventory are made by hand in its workflow rules and have no API, so every trigger is polled.

## Sign-in

Sign in with Zoho only (no key), through the shared Zoho client (`zohoOAuth`). Scope: `ZohoInventory.FullAccess.all`, as Zoho's OAuth page writes it: the per-module scopes leave out settings, reports and the newer modules. Tokens last an hour and are renewed by `zohoOAuth`. Callback: `https://api.emplio.app/oauth/zoho_inventory/callback`.

Every call needs `organization_id`: when it's left out, the login's only organisation is used; with several, the error lists them so the caller can say which. The list is cached for 10 minutes per login. `check` labels the connection with the organisation name(s).

## Hand adjustments

- Zoho's spec gives defaults for fields; they are stripped, so nothing is sent that wasn't asked for. `sort_order` is added next to every `sort_column` (shared with Books, `zohoZip`).
- `salesorder_number` and `purchaseorder_number` are no longer required: Zoho numbers orders itself unless `ignore_auto_number_generation` is set.
- Three reporting tag calls (mark_tag_option_active, mark_tag_option_as_inactive, get_options) are written by hand: the spec's paths hold a regular expression where the id goes.
- Renamed to Composio's names: add_credit_note_comment, add_invoice_comment, bulk_email_invoices, cancel_invoice_write_off, confirm_sales_order, deactivate_contact, deactivate_item, deactivate_item_group, email_contact_statement, get_customer_payment, list_item_serial_numbers, mark_invoice_sent, mark_shipment_delivered, void_sales_order. mark_item_master_as_active / _inactive tidied from doubled names.
- Failures sent with a 200 become errors; a dead login (401 except scope errors, or INVALID_TOKEN) marks the connection expired.

## Triggers (polled, polls/zoho_inventory.ts)

Each check looks at the newest 200. Composio has none for this app.

- item_low_stock (warehouse_id): Zoho's own low-stock list; id `<item_id>:<stock_on_hand>`, so it fires when an item goes low and again as its stock changes while low.
- new_item, item_changed (`<id>:<last_modified_time>`).
- new_sales_order, sales_order_changed (customer_id, status); new_purchase_order, purchase_order_changed (vendor_id, status). Zoho's order lists can't be sorted by change, so a change to an order older than the newest 200 isn't seen.
- package_changed (customer_id, status; id `<package_id>:<status>`), new_purchase_receive (vendor_id), new_sales_return (customer_id), new_bill (vendor_id), new_transfer_order.
- new_invoice (customer_id, status), customer_changed (new_only), payment_received (customer_id): the same as Zoho Books'.

## Actions by group (* asks first)

**batches** (10): bulk_delete_batches*, create_batch*, delete_batch*, list_batches, mark_batch_as_active*, mark_batch_as_inactive*, mark_batches_as_active*, mark_batches_as_inactive*, retrieve_batch, update_batch*

**bills** (14): approve_bill*, bulk_approve_bills*, bulk_submit_bills_for_approval*, create_bill*, delete_bill*, final_approval_of_bill*, get_bill, list_bills, mark_as_open*, mark_as_void*, reject_bill*, submit_bill_for_approval*, update_bill*, update_custom_field_in_existing_bills*

**categories** (5): create_category*, delete_category*, list_categories, retrieve_category, update_category*

**compositeitems** (16): assemblies_history, create_assemblies*, creating_composite_item*, delete_assemblies*, delete_composite_item*, delete_composite_item_image*, list_composite_items, mark_as_active*, mark_as_inactive*, mark_assembly_as_assembled*, mark_assembly_as_confirmed*, retrieve_assemblies, retrieving_composite_item, update_assembly*, updating_composite_item*, upload_composite_item_images*

**contact-persons** (6): create_contact_person*, delete_contact_person*, get_contact_person, list_contact_persons, mark_as_primary_contact_person*, update_contact_person*

**contacts** (12): create_contact*, deactivate_contact*, delete_contact*, email_contact*, email_contact_statement*, get_contact, get_contact_address, get_statement_mail_content, list_comments, list_contacts, mark_contact_as_active*, update_contact*

**credit-notes** (32): add_attachment_to_credit_note*, add_credit_note_comment*, apply_credits_to_invoices*, approve_credit_note*, convert_credit_note_to_draft*, convert_credit_note_to_open*, create_credit_note*, delete_attachment*, delete_comment*, delete_credit_note*, delete_credit_note_refund*, delete_credits_applied_to_invoice*, email_credit_note*, email_history, get_credit_note, get_credit_note_email_content, get_credit_note_refund, list_credit_note_comments_history, list_credit_note_refunds, list_credit_note_templates, list_credit_notes, list_invoices_credited, list_refunds_of_credit_note, refund_credit_note*, reject_credit_note*, submit_credit_note_for_approval*, update_billing_address*, update_credit_note*, update_credit_note_refund*, update_credit_note_template*, update_shipping_address*, void_credit_note*

**currency** (5): create_currency*, delete_currency*, get_currency, list_currencies, update_currency*

**customer-payments** (6): create_customer_payment*, delete_payment*, get_customer_payment, list_customer_payments, update_custom_field_in_existing_customerpayments*, update_payment*

**delivery-challans** (17): add_attachment_to_delivery_challan*, create_delivery_challan*, delete_delivery_challan*, delete_delivery_challan_attachment*, get_delivery_challan_attachment, list_delivery_challan_templates, list_delivery_challans, mark_delivery_challan_as_delivered*, mark_delivery_challan_as_open*, mark_delivery_challan_as_returned*, mark_delivery_challan_as_undelivered*, retrieve_delivery_challan, return_delivery_challans*, undo_return_of_delivery_challans*, update_delivery_challan*, update_delivery_challan_shipping_address*, update_delivery_challan_template*

**inventoryadjustments** (9): approve_inventory_adjustment*, create_inventory_adjustment*, delete_inventory_adjustment*, final_approval_of_inventory_adjustment*, list_inventory_adjustments, reject_inventory_adjustment*, retrieve_inventory_adjustment, submit_inventory_adjustment_for_approval*, update_inventory_adjustment*

**inventorycounting** (15): approve_or_reject_line_items_in_stock_count*, bulk_delete_stock_counts*, cancel_stock_count*, create_stock_count*, delete_stock_count*, list_serial_batch_tracking_details_for_count_line_item, list_stock_counts, list_storage_details_for_count_item, retrieve_stock_count, search_items_in_in_progress_stock_counts, search_storage_locations_in_in_progress_stock_counts, start_stock_count*, submit_stock_count_for_approval*, update_counted_quantities*, update_stock_count*

**inventorycounting-settings** (2): update_stock_count_auto_numbering_settings*, update_stock_counts_preferences*

**invoices** (42): add_invoice_attachment*, add_invoice_comment*, apply_credits_to_invoice*, approve_invoice*, bulk_approve_invoices*, bulk_email_invoices*, bulk_export_invoices, bulk_print_invoices, bulk_submit_invoices_for_approval*, cancel_invoice_write_off*, create_invoice*, delete_applied_credit*, delete_invoice*, delete_invoice_attachment*, delete_invoice_comment*, delete_invoice_payment*, disable_payment_reminder*, email_invoice*, enable_invoice_payment_reminder*, final_approval_of_invoice*, get_invoice, get_invoice_attachment, get_invoice_email_content, get_payment_reminder_mail_content, list_credits_applied, list_invoice_comments_history, list_invoice_payments, list_invoice_templates, list_invoices, mark_as_draft*, mark_invoice_sent*, reject_invoice*, submit_invoice_for_approval*, update_attachment_preference*, update_comment*, update_custom_field_in_existing_invoices*, update_invoice*, update_invoice_billing_address*, update_invoice_shipping_address*, update_invoice_template*, void_invoice*, write_off_invoice*

**itemgroups** (7): create_item_group*, deactivate_item_group*, delete_item_group*, list_item_groups, mark_item_group_active*, retrieve_item_group, update_item_group*

**items** (60): bulk_delete_item_variants*, bulk_get_item_details, bulk_mark_item_masters_active*, bulk_mark_item_masters_inactive*, bulk_mark_item_variants_as_active*, bulk_mark_item_variants_as_inactive*, bulk_mark_items_as_active*, bulk_mark_items_as_inactive*, bulk_update_item_location_permissions*, create_item*, create_item_master*, create_item_variant*, deactivate_item*, delete_item*, delete_item_back_image*, delete_item_image*, delete_item_master*, delete_item_variant*, delete_multiple_item_images*, delete_multiple_items*, disable_storage_location_for_items*, enable_storage_location_for_items*, get_item, get_item_master, get_variant_opening_stock, group_items*, list_delivery_challans_for_item, list_invoices_for_item, list_item_masters, list_item_variants, list_items, list_move_orders_for_item, list_purchase_orders_for_item, list_putaways_for_item, list_sales_orders_for_item, list_sales_receipts_for_item, mark_image_as_back_image*, mark_item_as_active*, mark_item_master_as_active*, mark_item_master_as_inactive*, mark_item_variant_as_active*, mark_item_variant_as_inactive*, mark_item_variants_as_single_items*, move_item*, move_item_variant*, reorder_item_images*, retrieve_item_image, retrieve_item_variant, ungroup_items*, update_custom_field_in_existing_items*, update_item*, update_item_location_permissions*, update_item_master*, update_item_variant*, update_variant_opening_stock*, upload_item_back_image*, upload_item_image*, upload_multiple_item_images*, validate_and_map_serial_numbers*, validate_serial_numbers*

**landedcosts** (6): create_bulk_landed_costs*, creates_landed_cost_for_bill*, deletes_landed_cost_from_bill*, get_bill_details_for_bulk_landed_cost, retrieves_details_of_specific_landed_cost, updates_existing_landed_cost_on_bill*

**locations** (10): create_location*, delete_location*, enable_locations*, get_location, list_locations, list_users_of_location, mark_as_primary*, mark_location_as_active*, mark_location_as_inactive*, update_location*

**moveorders** (14): attach_files_to_move_order*, create_move_order*, delete_move_order*, delete_move_orders*, download_move_order_document, get_move_order_auto_number_generation_settings, list_comments_for_move_order, list_move_orders, mark_move_order_as_completed*, mark_move_order_as_confirmed*, mark_move_order_as_in_progress*, remove_attachment_from_move_order*, retrieve_move_order, update_move_order*

**organizations** (4): create_organization*, get_organization, list_organizations, update_organization*

**packages** (6): bulk_print_packages, create_package*, delete_package*, get_package, list_packages, updating_package*

**picklists** (15): add_comment_to_picklist*, bulk_delete_picklists*, bulk_set_status_of_picklists*, create_picklist*, delete_comment_on_picklist*, delete_picklist*, get_advanced_tracking_details_for_picklist, get_picklist, list_picklists, search_purchase_return_line_items, search_sales_order_line_items, search_sales_orders, set_status_of_picklist*, update_advanced_tracking_details_for_picklist*, update_picklist*

**pricelists** (6): create_pricebook*, delete_pricebook*, list_pricebooks, mark_pricebook_active*, mark_pricebook_inactive*, update_pricebook*

**purchase-returns** (16): add_attachment_to_purchase_return*, close_purchase_return*, confirm_purchase_return*, create_purchase_return*, delete_purchase_return*, delete_purchase_return_attachment*, email_purchase_return*, fulfill_purchase_return*, list_purchase_returns, reopen_purchase_return*, retrieve_purchase_return, unfulfill_purchase_return*, update_purchase_return*, update_purchase_return_billing_address*, update_purchase_return_shipping_address*, void_purchase_return*

**purchaseorders** (13): approve_purchase_order*, bulk_approve_purchase_orders*, bulk_submit_purchase_orders_for_approval*, create_purchase_order*, delete_purchase_order*, final_approve_purchase_order*, get_purchase_order, list_purchase_orders, mark_as_cancelled*, mark_as_issued*, reject_purchase_order*, submit_purchase_order_for_approval*, update_purchase_order*

**purchasereceives** (18): add_attachment_to_purchase_receive*, add_comment_to_purchase_receive*, approve_purchase_receive*, create_purchase_receive*, delete_purchase_receive*, delete_purchase_receive_attachment*, delete_purchase_receive_comment*, delete_purchase_receives_in_bulk*, get_purchase_receive, get_purchase_receive_attachment, list_purchase_receives, mark_purchase_receive_as_in_transit*, mark_purchase_receive_as_received*, mark_purchase_receives_as_in_transit_in_bulk*, mark_purchase_receives_as_received_in_bulk*, reject_purchase_receive*, submit_purchase_receive_for_approval*, update_purchase_receive*

**putaways** (10): attach_files_to_putaway*, create_putaway*, delete_putaway*, download_putaway_document, get_putaway_auto_number_generation_settings, list_comments_for_putaway, list_putaways, remove_attachment_from_putaway*, retrieve_putaway, update_putaway*

**recurringinventorycounting** (7): create_recurring_stock_count_profile*, delete_recurring_stock_count_profile*, list_recurring_stock_count_profiles, mark_recurring_stock_count_profile_as_active*, mark_recurring_stock_count_profile_as_inactive*, retrieve_recurring_stock_count_profile, update_recurring_stock_count_profile*

**replenishment** (19): bulk_dismiss_replenishment_tasks*, bulk_generate_replenishment_tasks*, bulk_pause_replenishment_configurations*, bulk_resume_replenishment_configurations*, bulk_update_replenishment_configurations*, create_replenishment_configuration*, dismiss_replenishment_task*, generate_replenishment_task*, list_replenishment_tasks, pause_replenishment_configuration*, resume_replenishment_configuration*, retrieve_replenishment_configuration, retrieve_replenishment_configurations_for_associated_locations, retrieve_replenishment_configurations_for_associated_warehouses, retrieve_replenishment_order_details, retrieve_replenishment_task, retrieve_replenishment_task_details_for_item, retrieve_replenishment_task_details_report, update_replenishment_configuration*

**reporting-tags** (14): create_reporting_tag*, delete_reporting_tag*, get_options, get_reporting_tags_options_detail_page, list_of_reporting_tags, mark_option_as_default_for_reporting_tag*, mark_reporting_tag_as_active*, mark_reporting_tag_as_inactive*, mark_tag_option_active*, mark_tag_option_as_inactive*, reorder_reporting_tags*, update_reporting_tag*, update_reporting_tag_options*, update_reporting_tag_visibility_conditions*

**retainer-invoices** (22): add_attachment_to_retainer_invoice*, approve_retainer_invoice*, create_retainer_invoice_comment*, create_retainerinvoice*, delete_retainer_invoice*, delete_retainer_invoice_attachment*, delete_retainer_invoice_comment*, email_retainer_invoice*, get_retainer_invoice, get_retainer_invoice_attachment, get_retainer_invoice_email_content, list_retainer_invoice_comments_history, list_retainer_invoice_templates, list_retainer_invoices, mark_retainer_invoice_as_draft*, mark_retainer_invoice_as_sent*, submit_retainer_invoice_for_approval*, update_retainer_invoice_billing_address*, update_retainer_invoice_comment*, update_retainer_invoice_template*, update_retainerinvoice*, void_retainer_invoice*

**salesorders** (15): approve_sales_order*, bulk_approve_sales_orders*, bulk_confirm_sales_orders*, bulk_delete_sales_orders*, bulk_submit_sales_orders_for_approval*, confirm_sales_order*, create_sales_order*, delete_sales_order*, final_approval_of_sales_order*, get_sales_order, list_sales_orders, reject_sales_order*, submit_sales_order_for_approval*, update_sales_order*, void_sales_order*

**salesreturns** (7): create_sales_return*, create_sales_return_receive*, delete_sales_return*, delete_sales_return_receive*, list_sales_returns, retrieve_sales_return, update_sales_return*

**serialnumbers** (2): list_item_serial_numbers, retrieve_serial_number

**shipmentorders** (5): create_shipment_order*, delete_shipment_order*, get_shipment_order, mark_shipment_delivered*, update_shipment_order*

**storagelocations** (25): bulk_delete_bins*, configure_composite_item_default_bin*, configure_item_default_bin*, create_bin*, create_zone*, delete_bin*, delete_zone*, disable_bin_locations_for_location*, disable_bin_locations_for_warehouse*, enable_bin_locations_for_location*, enables_bin_locations_for_specific_warehouse*, get_bin, get_composite_item_default_bin, get_item_bin_mappings, get_item_default_bin, get_zone, list_bins, list_zones, mark_bins_as_active*, mark_bins_as_inactive*, mark_zones_as_active*, mark_zones_as_inactive*, update_bin*, update_item_bin_mappings*, update_zone*

**tasks** (17): add_attachment_to_task*, add_comment_to_task*, add_task*, delete_comment_of_task*, delete_document_of_task*, delete_task*, delete_tasks*, get_document_of_task, get_task, list_comments_of_task, list_tasks, mark_task_as_completed*, mark_task_as_ongoing*, mark_task_as_open*, update_a_task*, update_completed_percentage*, update_tasks*

**taxes** (19): create_tax*, create_tax_authority_us_and_ca_edition_only*, create_tax_exemption_us_edition_only*, create_tax_group*, delete_tax*, delete_tax_authority_us_and_ca_edition_only*, delete_tax_exemption_us_edition_only*, delete_tax_group*, get_tax, get_tax_authority_us_and_ca_edition_only, get_tax_exemption_us_edition_only, get_tax_group, list_tax_authorities_us_edition_only, list_tax_exemptions_us_edition_only, list_taxes, update_tax*, update_tax_authority_us_and_ca_edition_only*, update_tax_exemption_us_edition_only*, update_tax_group*

**transferorders** (12): approve_transfer_order*, bulk_delete_transfer_orders*, create_transfer_order*, delete_transfer_order*, final_approval_of_transfer_order*, get_transfer_order, list_transfer_orders, mark_as_received*, mark_transfer_order_as_in_transit*, reject_transfer_order*, submit_transfer_order_for_approval*, update_transfer_order*

**unit_of_measurement** (13): create_unit*, create_unit_conversion*, create_unit_group*, delete_unit*, delete_unit_conversion*, delete_unit_group*, list_unit_conversions, list_unit_groups, list_units, retrieve_unit_group, update_unit*, update_unit_conversion*, update_unit_group*

**users** (9): create_user*, delete_user*, get_current_user, get_user, invite_user*, list_users, mark_user_as_active*, mark_user_as_inactive*, update_user*

**vendor-credits** (21): add_vendor_credit_comment*, apply_credits_to_bill*, approve_vendor_credit*, convert_to_open*, create_vendor_credit*, delete_bills_credited*, delete_vendor_credit*, delete_vendor_credit_comment*, delete_vendor_credit_refund*, get_vendor_credit, get_vendor_credit_refund, list_bills_credited, list_refunds_of_vendor_credit, list_vendor_credit_comments_history, list_vendor_credit_refunds, list_vendor_credits, refund_vendor_credit*, submit_vendor_credit_for_approval*, update_vendor_credit*, update_vendor_credit_refund*, void_vendor_credit*
