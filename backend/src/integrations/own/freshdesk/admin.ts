// Helpdesk set-up: ticket fields and forms, the account and its exports, email mailboxes, products, business
// hours, SLA policies, automation rules and scenarios, settings, custom objects, and side conversations.
import { z } from "zod";
import type { OwnAction } from "../index";
import { call } from "../openapi";
import { api, id, page, r } from "./client";

const fieldId = id("ticket field", "freshdesk.list_ticket_fields");
const formId = id("ticket form", "freshdesk.list_ticket_forms");
const ruleType = z.number().int().describe("Kind of automation: 1 on ticket creation, 3 hourly (time triggers), 4 on ticket updates");
const schemaId = z.string().min(1).describe("Custom object's id (freshdesk.list_custom_objects)");
const recordId = z.string().min(1).describe("Record's display_id");
const any = (what: string) => z.record(z.string(), z.any()).optional().describe(what);

const ticketFieldFields = {
  label: z.string().optional().describe("Name agents see (required on create)"),
  label_for_customers: z.string().optional().describe("Name customers see"),
  type: z.string().optional().describe("On create: custom_text, custom_paragraph, custom_checkbox, custom_number, custom_decimal, custom_date, custom_dropdown, nested_field"),
  position: z.number().int().optional().describe("Place in the form, from 1"),
  customers_can_edit: z.boolean().optional().describe("Customers can fill it in"),
  displayed_to_customers: z.boolean().optional().describe("Customers see it"),
  required_for_closure: z.boolean().optional().describe("Must be filled to close a ticket"),
  required_for_agents: z.boolean().optional().describe("Agents must fill it in"),
  required_for_customers: z.boolean().optional().describe("Customers must fill it in"),
  choices: z.array(z.record(z.string(), z.any())).optional().describe('Dropdown choices, e.g. [{"value": "Refund", "position": 1}]'),
  dependent_fields: z.array(z.record(z.string(), z.any())).optional().describe("Levels 2 and 3 of a nested field"),
  section_mappings: z.array(z.record(z.string(), z.any())).optional().describe("Sections it shows in"),
};
const formFields = {
  title: z.string().optional().describe("Form name (required)"),
  description: z.string().optional().describe("About it"),
  fields: z.array(z.record(z.string(), z.any())).optional().describe('Fields on the form, e.g. [{"id": 1}, {"id": 4}] (ids from freshdesk.list_ticket_fields; required)'),
};
const mailboxFields = {
  name: z.string().optional().describe("Mailbox name"),
  support_email: z.string().optional().describe("The support address (unique; required on create)"),
  group_id: z.number().int().optional().describe("Group its tickets go to"),
  product_id: z.number().int().optional().describe("Product it's for"),
  default_reply_email: z.string().optional().describe("Reply-from address"),
  mailbox_type: z.string().optional().describe('"freshdesk_mailbox" or "custom_mailbox" (required on create)'),
  access_type: z.string().optional().describe('With a custom mailbox: "incoming", "outgoing" or "both"'),
  custom_mailbox: any('With a custom mailbox: {"incoming": {mail_server, port, use_ssl, delete_from_server, authentication, username, password}, "outgoing": {...}}'),
};
const ruleFields = {
  name: z.string().optional().describe("Rule name (required on create)"),
  description: z.string().optional().describe("What it does"),
  position: z.number().int().optional().describe("Order it runs in"),
  active: z.boolean().optional().describe("On or off"),
  conditions: z.array(z.record(z.string(), z.any())).optional().describe('When it applies, e.g. [{"name": "c1", "match_type": "all", "properties": [{"resource_type": "ticket", "field_name": "priority", "operator": "in", "value": [4]}]}] (required on create)'),
  actions: z.array(z.record(z.string(), z.any())).optional().describe('What it does, e.g. [{"field_name": "group_id", "value": 12}] or a webhook {"field_name": "trigger_webhook", "url": "...", "request_type": "POST"} (required on create)'),
  operator: z.string().optional().describe('How condition sets join: "condition_set_1 or condition_set_2"'),
  performer: any("Who must make the change (ticket-update rules)"),
  events: z.array(z.record(z.string(), z.any())).optional().describe("Which changes start it (ticket-update rules), e.g. [{\"field_name\": \"status\", \"from\": \"--\", \"to\": 4}]"),
};

// records filtered by field: Freshdesk takes field[operator]=value in the query
const listRecords: OwnAction = {
  description: 'Records of a custom object, optionally filtered, e.g. filters {"age[gte]": 35, "customer_name": "Sarah"}.',
  readOnly: true,
  input: z.object({
    schema_id: schemaId,
    filters: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional().describe('Field filters: "field": value, or "field[gte]" / "[lte]" / "[gt]" / "[lt]" for ranges'),
    sort_by: z.string().optional().describe('Field and direction, e.g. "customer_name;ASC"'),
    page_size: z.number().int().min(1).max(100).optional().describe("How many (default 20, up to 100)"),
    next_token: z.string().optional().describe("From _links.next in the last answer, for the next page"),
  }),
  run: (i: { schema_id: string; filters?: Record<string, unknown>; sort_by?: string; page_size?: number; next_token?: string }, key: string) => {
    const { filters, ...rest } = i;
    const all: Record<string, unknown> = { ...filters, ...rest };
    const query = Object.keys(all).filter((k) => k !== "schema_id" && all[k] !== undefined);
    return call(api, key, { method: "GET", path: "/custom_objects/schemas/{schema_id}/records", query, headers: [] }, all);
  },
};

export const adminActions: Record<string, OwnAction> = {
  // ── account, jobs, exports
  get_account: r("GET", "/account", "The helpdesk account: name, plan, agents, time zone, address, data centre."),
  export_account: r("POST", "/account/export", "Start an export of helpdesk data (tickets, contacts, companies...). Freshdesk emails the account admin and freshdesk.get_job tracks it.", {
    resources: z.array(z.record(z.string(), z.any())).optional().describe('What to export, e.g. [{"name": "tickets", "include": ["notes", "attachments"]}, {"name": "contacts"}]'),
    date_range: z.object({ start_date: z.string(), end_date: z.string() }).optional().describe("Only data in this range, YYYY-MM-DD"),
    output_format: z.string().optional().describe('"json" or "xml"'),
  }, { loose: true }),
  get_job: r("GET", "/jobs/{id}", "Progress of a background job (bulk updates, bulk agent creation, exports).", { id: z.string().min(1).describe("Job id from the earlier answer") }),
  export_audit_log: r("POST", "/audit_log/export", "Start an export of the audit log (who changed which settings, agents, automations). freshdesk.get_audit_log_export gives the file.", {
    from: z.string().describe("From date, YYYY-MM-DD"),
    to: z.string().describe("To date, YYYY-MM-DD"),
    export_format: z.enum(["csv", "json"]).describe("File type"),
    receive_via: z.enum(["email", "api"]).describe('"api" to fetch it with freshdesk.get_audit_log_export, "email" to email it to you'),
    filter: any('Only some changes, e.g. {"filter_set": [{"entity": ["agent", "automation_1"]}], "condition": "filter_set_1"}'),
    archived: z.boolean().optional().describe("Look in archived logs"),
  }, { loose: true }),
  get_audit_log_export: r("GET", "/audit_log/export/{id}", "Status of an audit log export, and its download link when done.", { id: z.string().min(1).describe("Export id") }),
  view_helpdesk_settings: r("GET", "/settings/helpdesk", "Helpdesk languages: the main one and the others it supports."),

  // ── ticket fields and sections
  list_ticket_fields: r("GET", "/ticket_fields", "Every ticket field, built-in and custom, with names, types and choices (the names custom_fields takes).", { type: z.string().optional().describe("Only fields of this type, e.g. default_status") }),
  list_admin_ticket_fields: r("GET", "/admin/ticket_fields", "Ticket fields with their admin settings."),
  view_ticket_field: r("GET", "/admin/ticket_fields/{id}", "One ticket field.", { id: fieldId }),
  create_admin_ticket_field: r("POST", "/admin/ticket_fields", "Add a custom ticket field.", ticketFieldFields, { loose: true }),
  update_admin_ticket_field: r("PUT", "/admin/ticket_fields/{id}", "Change a ticket field or its choices.", { id: fieldId, ...ticketFieldFields }, { loose: true }),
  delete_ticket_field: r("DELETE", "/admin/ticket_fields/{id}", "Delete a custom ticket field and its values.", { id: fieldId }),
  list_all_sections_for_ticket_field: r("GET", "/admin/ticket_fields/{id}/sections", "Sections of a dropdown field (extra fields that show for some choices).", { id: fieldId }),
  list_specific_section_details: r("GET", "/admin/ticket_fields/{id}/sections/{section_id}", "One section.", { id: fieldId, section_id: id("section") }),
  create_admin_ticket_field_section: r("POST", "/admin/ticket_fields/{id}/sections", "Add a section to a dropdown field: fields that show for some of its choices.", {
    id: fieldId,
    label: z.string().min(1).describe("Section name"),
    choice_ids: z.array(z.number().int()).min(1).describe("Choices it shows for"),
  }),
  update_admin_ticket_field_section: r("PUT", "/admin/ticket_fields/{id}/sections/{section_id}", "Change a section.", {
    id: fieldId,
    section_id: id("section"),
    label: z.string().optional().describe("Section name"),
    choice_ids: z.array(z.number().int()).optional().describe("Choices it shows for"),
  }),
  delete_section: r("DELETE", "/admin/ticket_fields/{id}/sections/{section_id}", "Delete a section.", { id: fieldId, section_id: id("section") }),

  // ── ticket forms
  list_ticket_forms: r("GET", "/ticket-forms", "Ticket forms customers choose from in the portal."),
  view_ticket_form: r("GET", "/ticket-forms/{id}", "One ticket form and its fields.", { id: formId }),
  create_ticket_form: r("POST", "/ticket-forms", "Add a ticket form.", formFields, { loose: true }),
  update_ticket_form: r("PUT", "/ticket-forms/{id}", "Change a ticket form.", { id: formId, ...formFields }, { loose: true }),
  delete_ticket_form: r("DELETE", "/ticket-forms/{id}", "Delete a ticket form.", { id: formId }),
  clone_ticket_form: r("POST", "/ticket-forms/{id}/clone", "Copy a ticket form.", { id: formId }),
  view_ticket_form_field: r("GET", "/ticket-forms/{id}/fields/{field_id}", "One field on a ticket form.", { id: formId, field_id: fieldId }),
  update_ticket_form_field: r("PUT", "/ticket-forms/{id}/fields/{field_id}", "Change how a field shows on a ticket form for customers.", {
    id: formId,
    field_id: fieldId,
    label_for_customers: z.string().optional().describe("Name customers see"),
    customers_can_edit: z.boolean().optional().describe("Customers can fill it in"),
    required_for_customers: z.boolean().optional().describe("Customers must fill it in"),
    hint_for_customers: z.string().optional().describe("Help text"),
    placeholder_for_customers: z.string().optional().describe("Placeholder"),
    position: z.number().int().optional().describe("Place on the form"),
  }, { loose: true }),
  delete_ticket_form_field: r("DELETE", "/ticket-forms/{id}/fields/{field_id}", "Take a field off a ticket form.", { id: formId, field_id: fieldId }),

  // ── email
  list_email_configs: r("GET", "/email_configs", "Support email addresses (the ids tickets are sent from).", page),
  view_email_config: r("GET", "/email_configs/{id}", "One support email address.", { id: id("email config") }),
  list_email_mailboxes: r("GET", "/email/mailboxes", "Support mailboxes with their full settings.", {
    support_email: z.string().optional().describe("Only this address"),
    group_id: z.number().int().optional().describe("Only this group's"),
    product_id: z.number().int().optional().describe("Only this product's"),
    active: z.boolean().optional().describe("Only active (true) or inactive mailboxes"),
    ...page,
  }),
  get_email_mailbox: r("GET", "/email/mailboxes/{id}", "One support mailbox.", { id: id("mailbox") }),
  create_email_mailbox: r("POST", "/email/mailboxes", "Add a support mailbox (a Freshdesk one or your own mail server).", mailboxFields, { loose: true }),
  update_email_mailbox: r("PUT", "/email/mailboxes/{id}", "Change a support mailbox.", { id: id("mailbox"), ...mailboxFields }, { loose: true }),
  delete_email_mailbox: r("DELETE", "/email/mailboxes/{id}", "Delete a support mailbox.", { id: id("mailbox") }),
  view_email_settings: r("GET", "/email/settings", "Mailbox settings: personalised replies, who becomes the requester on forwards..."),
  update_email_settings: r("PUT", "/email/settings", "Change mailbox settings.", {
    personalized_email_replies: z.boolean().optional().describe("Replies show the agent's name"),
    create_requester_using_reply_to: z.boolean().optional().describe("Use the Reply-To address as the requester"),
    allow_agent_to_initiate_conversation: z.boolean().optional().describe("Agents may start email conversations"),
    original_sender_as_requester_for_forward: z.boolean().optional().describe("On forwarded emails, the original sender is the requester"),
  }, { loose: true }),
  view_notification_email_bcc: r("GET", "/notifications/email/bcc", "Addresses blind-copied on every email Freshdesk sends."),
  update_notification_email_bcc: r("PUT", "/notifications/email/bcc", "Set the addresses blind-copied on every email.", { emails: z.array(z.string()).describe("Addresses; [] clears them") }),

  // ── products, business hours, SLA
  list_products: r("GET", "/products", "Products (each can have its own portal and support address).", page),
  view_product: r("GET", "/products/{id}", "One product.", { id: id("product") }),
  get_business_hours: r("GET", "/business_hours", "Business hours set-ups (working hours and holidays SLA timers follow)."),
  view_business_hour: r("GET", "/business_hours/{id}", "One business hours set-up.", { id: id("business hours") }),
  list_sla_policies: r("GET", "/sla_policies", "SLA policies: response and resolution targets per priority, and who they apply to."),
  create_sla_policies: r("POST", "/sla_policies", "Add an SLA policy.", {
    name: z.string().min(1).describe("Policy name"),
    description: z.string().optional().describe("About it"),
    sla_target: z.record(z.string(), z.any()).describe('Targets per priority, e.g. {"priority_4": {"respond_within": 1800, "resolve_within": 14400, "business_hours": false, "escalation_enabled": true}, ...} (seconds)'),
    applicable_to: z.record(z.string(), z.any()).describe('Who it covers, e.g. {"company_ids": [1], "group_ids": [2], "sources": [1], "ticket_types": ["Question"], "product_ids": [3]}'),
    escalation: any("Who is told when targets are missed"),
    active: z.boolean().optional().describe("On or off"),
  }, { loose: true }),
  update_sla_policies: r("PUT", "/sla_policies/{id}", "Change an SLA policy.", {
    id: id("SLA policy", "freshdesk.list_sla_policies"),
    name: z.string().optional(),
    description: z.string().optional(),
    sla_target: any("Targets per priority, as for create"),
    applicable_to: any("Who it covers, as for create"),
    escalation: any("Who is told when targets are missed"),
    active: z.boolean().optional(),
  }, { loose: true }),

  // ── automations
  list_automation_rules: r("GET", "/automations/{automation_type_id}/rules", "Automation rules of one kind.", { automation_type_id: ruleType, ...page }),
  view_automation_rule: r("GET", "/automations/{automation_type_id}/rules/{id}", "One automation rule.", { automation_type_id: ruleType, id: id("rule") }),
  create_automation_rule: r("POST", "/automations/{automation_type_id}/rules", "Add an automation rule: when tickets match the conditions, the actions run.", { automation_type_id: ruleType, ...ruleFields }, { loose: true }),
  update_automation_rule: r("PUT", "/automations/{automation_type_id}/rules/{id}", "Change an automation rule.", { automation_type_id: ruleType, id: id("rule"), ...ruleFields }, { loose: true }),
  delete_automation_rule: r("DELETE", "/automations/{automation_type_id}/rules/{id}", "Delete an automation rule.", { automation_type_id: ruleType, id: id("rule") }),
  list_scenario_automations: r("GET", "/scenario_automations", "Scenarios: sets of ticket changes agents apply in one click."),

  // ── custom objects
  list_custom_objects: r("GET", "/custom_objects/schemas", "Custom objects (your own record types, like bookings or orders) and their fields."),
  get_custom_object: r("GET", "/custom_objects/schemas/{schema_id}", "One custom object and its fields.", { schema_id: schemaId }),
  list_custom_object_records: listRecords,
  count_custom_object_records: r("GET", "/custom_objects/schemas/{schema_id}/records/count", "How many records a custom object has.", { schema_id: schemaId }),
  get_custom_object_record: r("GET", "/custom_objects/schemas/{schema_id}/records/{record_id}", "One record.", { schema_id: schemaId, record_id: recordId }),
  create_custom_object_record: r("POST", "/custom_objects/schemas/{schema_id}/records", "Add a record to a custom object.", {
    schema_id: schemaId,
    data: z.record(z.string(), z.any()).describe('Field values by name, e.g. {"customer_name": "Sarah", "age": 35}'),
  }),
  update_custom_object_record: r("PUT", "/custom_objects/schemas/{schema_id}/records/{record_id}", "Change a record. Send every field and the version from freshdesk.get_custom_object_record.", {
    schema_id: schemaId,
    record_id: recordId,
    display_id: z.string().optional().describe("The record's display_id"),
    version: z.number().int().optional().describe("The version it had when read"),
    data: z.record(z.string(), z.any()).describe("Every field value"),
  }),
  delete_custom_object_record: r("DELETE", "/custom_objects/schemas/{schema_id}/records/{record_id}", "Delete a record.", { schema_id: schemaId, record_id: recordId }),

  // ── side conversations (threads on a ticket with people outside it)
  create_thread: r("POST", "/collaboration/threads", "Start a side conversation on a ticket (e.g. email a supplier).", {
    type: z.string().describe('"forward" for an email side conversation'),
    parent: z.object({ id: z.string(), type: z.string() }).describe('The ticket: {"id": "156", "type": "ticket"}'),
    title: z.string().optional().describe("Thread title"),
    participants: any('Who is in it, e.g. {"email": {"to": ["supplier@example.com"]}}'),
    additional_info: any('e.g. {"email_config_id": 1060000012850}'),
  }, { loose: true }),
  get_thread: r("GET", "/collaboration/threads/{id}", "One side conversation.", { id: z.string().min(1).describe("Thread id") }),
  update_thread: r("PUT", "/collaboration/threads/{id}", "Rename or change a side conversation.", { id: z.string().min(1).describe("Thread id"), title: z.string().optional() }, { loose: true }),
  delete_thread: r("DELETE", "/collaboration/threads/{id}", "Delete a side conversation.", { id: z.string().min(1).describe("Thread id") }),
  create_thread_message: r("POST", "/collaboration/messages", "Send a message in a side conversation.", {
    thread_id: z.string().min(1).describe("Thread id"),
    body: z.string().min(1).describe("The message, HTML"),
    participants: any('Recipients, e.g. {"email": {"to": ["supplier@example.com"]}}'),
    additional_info: any('e.g. {"has_quoted_text": true, "email_subject": "Fwd: ..."}'),
    attachment_ids: z.array(z.number().int()).optional().describe("Files already uploaded"),
  }, { loose: true }),
  get_thread_message: r("GET", "/collaboration/messages/{id}", "One message in a side conversation.", { id: z.string().min(1).describe("Message id") }),
  update_thread_message: r("PUT", "/collaboration/messages/{id}", "Edit a message in a side conversation.", { id: z.string().min(1).describe("Message id"), body: z.string().optional() }, { loose: true }),
  delete_thread_message: r("DELETE", "/collaboration/messages/{id}", "Delete a message in a side conversation.", { id: z.string().min(1).describe("Message id") }),
  get_thread_message_quoted_text: r("GET", "/collaboration/messages/{id}/generate-quote", "A message's text quoted, for replying to it.", { id: z.string().min(1).describe("Message id") }),
};
