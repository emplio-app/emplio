// Karbon: what the generator (../openapi-actions.ts) can't tell from the spec.
import type { AppConfig } from "../openapi-actions";

const OUT = "src/integrations/own/karbon/actions.json";
const PARTNER = "only Karbon integration partners approved to run integrated workflows can call it";

// what each list's $filter takes (Karbon's KARBON_API.md); the spec only says "a $filter expression"
const ODATA = "An OData filter, like FullName eq 'Northwind' or contains(Title, 'tax') and WorkType eq 'Payroll' (text in single quotes).";
const FILTERS: Record<string, string> = {
  list_contacts: "Fields: FullName, EmailAddress, PhoneNumber, ContactType, ExternalKey. Operators: eq, contains (not on ExternalKey), and.",
  list_organizations: "Fields: FullName, EmailAddress, ContactType, ExternalKey. Operators: eq, contains (not on ExternalKey), and.",
  list_client_groups: "Field: FullName, with eq only.",
  list_teams: "Field: Name, with eq only.",
  list_roles: "Field: Name, with eq only.",
  list_work_items:
    "Fields: AssigneeEmailAddress, ClientKey, PrimaryStatus (Planned, Ready To Start, In Progress, Waiting, Completed), Title, WorkScheduleKey, WorkStatus, WorkTemplateKey, WorkType with eq (contains on Title, AssigneeEmailAddress, WorkStatus, WorkType); StartDate with ge and le, like StartDate ge 2026-01-01T00:00:00Z. Join with and.",
  list_time_entries: "Fields: TimesheetKey, EntityKey, WorkItemKey, ClientKey, UserKey, RoleName, TaskTypeName with eq; Date with eq, gt, ge, lt, le, like Date ge 2026-11-01. Join with and.",
  list_users: "Fields: Name, EmailAddress, with eq only.",
  list_invoices: "Field: InvoiceStatus eq one of Approved, AwaitingPayment, Paid, Exported, Voided.",
  list_work_templates: "Fields: Title, WorkTypeKey, PublishedDate, DateModified, DateLastWorkItemCreated, NumberOfWorkItemsCreated, HasScheduledClientTaskGroups, DraftHasChanges, with eq.",
  list_files: "Fields: IsArchived, IsShared, Source, MimeType, with eq and and, like IsArchived eq false and MimeType eq 'application/pdf'.",
  list_work_item_files: "Fields: IsArchived, IsShared, Source, MimeType, FolderPath (ignores case), with eq and and.",
  list_contact_files: "Fields: IsArchived, IsShared, Source, MimeType, with eq and and.",
  list_organization_files: "Fields: IsArchived, IsShared, Source, MimeType, with eq and and.",
  list_client_group_files: "Fields: IsArchived, IsShared, Source, MimeType, with eq and and.",
};

export default {
  spec: "https://karbonhq.github.io/karbon-api-reference/KarbonAPI.json",
  out: OUT,
  skip: {
    ListIntegrationTaskDefintions: PARTNER,
    ListIntegrationTasks: PARTNER,
    GetIntegrationTask: PARTNER,
    UpdateIntegrationTask: PARTNER,
  },
  // the operation ids are uneven (get_all_contacts, put_contact_by_id, patch_contacts_by_id): one plain pattern instead
  rename: {
    get_invoices: "list_invoices",
    get_invoice_by_key: "get_invoice",
    get_payments: "list_payments",
    get_payment_by_payment_key: "get_payment",
    get_business_card_by_key: "get_business_card",
    update_business_card_by_key: "update_business_card",
    get_client_groups: "list_client_groups",
    get_client_group_by_id: "get_client_group",
    put_client_group_by_id: "update_client_group",
    patch_client_group_by_id: "patch_client_group",
    get_all_contacts: "list_contacts",
    get_contact_by_id: "get_contact",
    put_contact_by_id: "update_contact",
    patch_contacts_by_id: "patch_contact",
    get_custom_field_definitions: "list_custom_fields",
    create_custom_field_definition: "create_custom_field",
    delete_custom_field_definition: "delete_custom_field",
    get_estimate_summaries_by_work_item_key: "list_estimate_summaries",
    get_estimate_summary_by_key: "get_estimate_summary",
    create_file: "upload_file",
    download_file: "download_file_by_token",
    get_file_details_by_key: "get_file_details",
    update_file_details: "move_file",
    download_file_details_by_key: "download_file",
    get_note_by_note_key: "get_note",
    get_all_organizations: "list_organizations",
    get_organization_by_id: "get_organization",
    put_organization_by_id: "update_organization",
    patch_organization_by_id: "patch_organization",
    get_all_roles: "list_roles",
    get_all_teams: "list_teams",
    get_team_by_key: "get_team",
    get_segment_by_key: "get_segment",
    get_all_individual_time_entries: "list_time_entries",
    get_individual_time_entry_by_key: "get_time_entry",
    get_all_users: "list_users",
    get_user_by_id: "get_user",
    get_webhook_subscriptions_by_webhook_type: "get_webhook_subscription",
    del_webhook_subscriptions_by_webhook_type: "delete_webhook_subscription",
    del_all_webhook_subscriptions: "delete_all_webhook_subscriptions",
    get_all_work_items: "list_work_items",
    get_work_item_by_id: "get_work_item",
    put_work_item_by_id: "update_work_item",
    patch_work_item_by_id: "patch_work_item",
    get_work_schedule_by_id: "get_work_schedule",
    put_work_schedule_by_id: "update_work_schedule",
    patch_work_schedule_by_id: "patch_work_schedule",
    get_all_work_templates: "list_work_templates",
    get_work_template_by_id: "get_work_template",
  },
  params: {
    $top: "How many to return (1 to 100; some file lists allow 500). Lists answer with @odata.nextLink when there are more.",
    $skip: "How many to skip, for the next page",
  },
  after: async () => {
    const file = new URL(`../../${OUT}`, import.meta.url).pathname;
    const out = await Bun.file(file).json();
    for (const a of out.actions) {
      // the server's defaults are what it does anyway, and sending them hurts: Contacts' $orderby "ClientGroupKey" isn't
      // one of its own choices, and RestrictionLevel "Public" on a PATCH would make a private contact public
      for (const p of Object.values<Record<string, unknown>>(a.input.properties)) delete p.default;
      const f = a.input.properties.$filter;
      if (f) f.description = `${ODATA} ${FILTERS[a.name] ?? ""}`.trim();
    }
    await Bun.write(file, JSON.stringify(out));
  },
} satisfies AppConfig;
