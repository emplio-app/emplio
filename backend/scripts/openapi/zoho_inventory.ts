// Zoho Inventory: what the generator can't tell from Zoho's spec zip.
import type { AppConfig } from "../openapi-actions";
import { composioNames } from "./composio-names";
import { BOOKISH, zohoNamer, zohoZip } from "./zoho-spec";

const files = await zohoZip("inventory");
// Zoho numbers orders itself unless ignore_auto_number_generation is set, but the spec marks the number required
for (const f of files.filter((f) => /(salesorders|purchaseorders)\.yml$/.test(f)))
  await Bun.write(f, (await Bun.file(f).text()).replace(/^ *- (salesorder_number|purchaseorder_number)\n/gm, ""));

export default {
  spec: files,
  out: "src/integrations/own/zoho_inventory/actions.json",
  name: zohoNamer(await composioNames("zoho_inventory")),
  // Zoho's spec writes these three paths with a regular expression where the tag or option id goes; index.ts writes them by hand
  skip: {
    "POST /reportingtags/{tag_id}/option/(\\d+)/active": "written by hand: the spec's path has a regular expression in it",
    "POST /reportingtags/{tag_id}/option/(\\d+)/inactive": "written by hand: the spec's path has a regular expression in it",
    "GET /reportingtags/(\\d+)/options/all": "written by hand: the spec's path has a regular expression in it",
  },
  // Composio's names for the same calls, so its skills and automations carry over
  rename: {
    add_comment: "add_credit_note_comment",
    create_invoice_comment: "add_invoice_comment",
    email_invoices: "bulk_email_invoices",
    cancel_write_off: "cancel_invoice_write_off",
    mark_as_confirmed: "confirm_sales_order",
    mark_contact_as_inactive: "deactivate_contact",
    mark_item_as_inactive: "deactivate_item",
    mark_item_group_inactive: "deactivate_item_group",
    email_statement: "email_contact_statement",
    retrieve_payment: "get_customer_payment",
    list_serial_numbers: "list_item_serial_numbers",
    mark_invoice_as_sent: "mark_invoice_sent",
    mark_as_delivered: "mark_shipment_delivered",
    mark_sales_order_as_void: "void_sales_order",
    mark_item_master_as_active_active: "mark_item_master_as_active",
    mark_item_master_as_inactive_inactive: "mark_item_master_as_inactive",
  },
  ...BOOKISH,
} satisfies AppConfig;
