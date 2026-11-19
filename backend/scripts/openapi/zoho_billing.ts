// Zoho Billing (formerly Zoho Subscriptions): what the generator can't tell from Zoho's spec zip. Composio has no toolkit for it.
import type { AppConfig } from "../openapi-actions";
import { BOOKISH, zohoNamer, zohoZip } from "./zoho-spec";

const files = await zohoZip("billing");
// Zoho's spec marks either-or fields as all required (a customer or a customer_id; a card, bank account or PayPal); these keep only what truly is
const only: Record<string, Record<string, string[]>> = {
  "subscription.yml": { "create-a-subscription-request": ["plan"] },
  "hosted-pages.yml": { "create-a-subscription-request": ["plan"], "update-payment-method-request": [] },
};
for (const [file, schemas] of Object.entries(only)) {
  const path = files.find((f) => f.endsWith(`/${file}`))!;
  let text = await Bun.file(path).text();
  for (const [schema, keep] of Object.entries(schemas)) {
    const before = text;
    text = text.replace(new RegExp(`(\\n    ${schema}:\\n)      required:\\n(?:        - .*\\n)+`), (_m, head: string) => `${head}${keep.length ? `      required:\n${keep.map((k) => `        - ${k}\n`).join("")}` : ""}`);
    if (text === before) throw new Error(`${file}: ${schema} no longer lists required fields; check the fix`);
  }
  await Bun.write(path, text);
}

export default {
  spec: files,
  out: "src/integrations/own/zoho_billing/actions.json",
  name: zohoNamer([]),
  // Zoho's spec writes these three paths with a regular expression where the tag or option id goes; index.ts writes them by hand
  skip: {
    "POST /reportingtags/{tag_id}/option/(\\d+)/active": "written by hand: the spec's path has a regular expression in it",
    "POST /reportingtags/{tag_id}/option/(\\d+)/inactive": "written by hand: the spec's path has a regular expression in it",
    "GET /reportingtags/(\\d+)/options/all": "written by hand: the spec's path has a regular expression in it",
  },
  // names from the summaries that don't say what they act on, or clash in meaning with another
  rename: {
    mark_as_active: "mark_addon_as_active",
    mark_as_inactive: "mark_addon_as_inactive",
    add_comment: "add_addon_comment",
    delete_comment: "delete_addon_comment",
    retreive_credit_note: "retrieve_credit_note",
    create_subscription: "create_new_subscription_hosted_page",
    update_subscription: "create_update_subscription_hosted_page",
    update_card_for_subscription: "create_update_card_hosted_page",
    buy_one_time_addon_for_subscription: "create_buy_addon_hosted_page",
    associate_payment_method_for_customer: "create_add_payment_method_hosted_page",
    record_invoice_payment: "create_invoice_payment_hosted_page",
    update_customer_payment_details: "create_update_payment_method_hosted_page",
    create_a_subscription: "create_subscription",
    update_a_subscription: "update_subscription",
    convert_to_open: "convert_invoice_to_open",
    update_address: "update_invoice_address",
    cancel_write_off: "cancel_invoice_write_off",
    mark_as_free: "mark_plan_as_free",
    mark_as_non_free: "mark_plan_as_non_free",
    add_comments: "add_quote_comment",
    update_comment: "update_quote_comment",
    post_comment: "add_project_comment",
    list_comments: "list_project_comments",
    assign_users: "assign_project_users",
    list_users: "list_project_users",
    invite_user: "invite_project_user",
    update_user: "update_project_user",
    get_user: "get_project_user",
    delete_user: "delete_project_user",
    subscription_activities: "list_subscription_activities",
    update_card: "update_subscription_card",
    remove_card: "remove_subscription_card",
    add_charge: "add_subscription_charge",
    add_contact_person: "add_subscription_contact_person",
    update_reference: "update_subscription_reference",
    update_sales_person: "update_subscription_sales_person",
    get_custom_fields: "get_subscription_custom_fields",
    update_custom_fields: "update_subscription_custom_fields",
    list_notes: "list_subscription_notes",
    add_note: "add_subscription_note",
    delete_note: "delete_subscription_note",
    change_to_online_offline_mode: "set_subscription_auto_collect",
  },
  // sent from the organization_id field by index.ts
  drop: { "*": ["X-com-zoho-subscriptions-organizationid"] },
  ...BOOKISH,
} satisfies AppConfig;
