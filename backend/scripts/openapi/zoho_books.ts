// Zoho Books: what the generator can't tell from Zoho's spec zip.
import type { AppConfig } from "../openapi-actions";
import { composioNames } from "./composio-names";
import { BOOKISH, zohoNamer, zohoZip } from "./zoho-spec";

const files = await zohoZip("books");
// the one call Zoho's spec forgot organization_id on
const receipts = files.find((f) => f.endsWith("sales-receipt.yml"))!;
await Bun.write(receipts, (await Bun.file(receipts).text()).replace(/(operationId: email_sales_receipt[\s\S]*?parameters:\n)/, "$1        - $ref: '#/components/parameters/organization_id'\n"));

export default {
  spec: files,
  out: "src/integrations/own/zoho_books/actions.json",
  name: zohoNamer(await composioNames("zoho_books")),
  // Zoho's spec writes these three paths with a regular expression where the tag or option id goes; index.ts writes them by hand
  skip: {
    "POST /reportingtags/{tag_id}/option/(\\d+)/active": "written by hand: the spec's path has a regular expression in it",
    "POST /reportingtags/{tag_id}/option/(\\d+)/inactive": "written by hand: the spec's path has a regular expression in it",
    "GET /reportingtags/(\\d+)/options/all": "written by hand: the spec's path has a regular expression in it",
  },
  reads: ["preview_invoice_with_coupons"],
  rename: {
    mark_estimate_as_accepted: "accept_estimate",
    activate_account: "activate_bank_account",
    deactivate_account: "deactivate_bank_account",
    bulk_export_invoices: "bulk_export_invoices_pdf",
    log_time_entries: "create_time_entry",
    bulk_export_estimates: "export_bulk_estimates_pdf",
    bulk_export_sales_orders: "export_sales_orders_pdf",
    get_journal_list: "get_journals_list_v4",
    get_journal: "get_journal_details_v4",
    delete_journal: "delete_journal_v4",
    delete_journal_comment: "delete_journal_comment_v4",
    delete_project_comment: "delete_project_comment_v4",
    delete_project: "delete_project_v4",
    list_available_credits_of_journal: "get_journal_credits_list_v4",
    get_rules_list: "list_bank_rules",
    list_credit_note_refunds_for_contact: "list_contact_refunds",
    get_fixed_asset_type_list: "list_fixed_asset_types",
    list_vendor_credit_refunds_of_all_vendor_credits: "list_vendor_credit_refunds2",
    mark_as_active: "mark_contact_as_active",
    mark_as_inactive: "mark_contact_as_inactive",
    mark_option_as_default_for_reporting_tag: "mark_reporting_tag_default_option",
    mark_sales_order_as_void: "mark_sales_order_void",
    mark_sales_order_as_open: "open_sales_order",
    remind_customer: "remind_customer_invoice",
    bulk_invoice_reminder: "send_bulk_invoice_reminder",
    email_contact: "send_contact_email",
    untrack_1099: "untrack_contact1099",
  },
  ...BOOKISH,
} satisfies AppConfig;
