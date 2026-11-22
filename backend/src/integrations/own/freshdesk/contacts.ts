// Customers: contacts and companies, their custom fields, CSV import and export, and activities from other
// systems on a contact's timeline.
import { z } from "zod";
import type { OwnAction } from "../index";
import { call } from "../openapi";
import { api, customFields, emails, id, page, r, tags, withFiles } from "./client";

const contactId = id("contact", "freshdesk.get_contacts or search_contacts");
const companyId = id("company", "freshdesk.get_companies or search_companies");

const contactFields = {
  name: z.string().optional().describe("Full name"),
  email: z.string().optional().describe("Main email (unique). A contact needs one of email, phone, mobile, twitter_id or unique_external_id"),
  phone: z.string().optional().describe("Phone"),
  mobile: z.string().optional().describe("Mobile"),
  twitter_id: z.string().optional().describe("Twitter handle (unique)"),
  unique_external_id: z.string().optional().describe("Their id in your own systems (unique)"),
  other_emails: emails("Up to 10 more email addresses"),
  company_id: z.number().int().optional().describe("Their main company"),
  view_all_tickets: z.boolean().optional().describe("Can see all of their company's tickets"),
  other_companies: z.array(z.object({ company_id: z.number().int(), view_all_tickets: z.boolean().optional() })).optional().describe("More companies they belong to"),
  address: z.string().optional().describe("Postal address"),
  description: z.string().optional().describe("About them"),
  job_title: z.string().optional().describe("Job title"),
  language: z.string().optional().describe("Language code, e.g. en, fr (default the helpdesk's)"),
  time_zone: z.string().optional().describe("Time zone, e.g. Eastern Time (US & Canada)"),
  tags,
  custom_fields: customFields,
  avatar: z.any().optional().describe('Profile picture, {"file": "/work/..."} (an image up to 5 MB)'),
  lookup_parameter: z.string().optional().describe('With a lookup custom field: "display_id" or "primary_field_value"'),
};

const companyFields = {
  name: z.string().optional().describe("Company name (unique)"),
  description: z.string().optional().describe("About the company"),
  note: z.string().optional().describe("Notes about it"),
  domains: z.array(z.string()).optional().describe("Its email domains, e.g. [\"northwind.com\"]; contacts from these join it. [] clears them"),
  health_score: z.string().optional().describe("Health score, one of the field's choices, e.g. Happy, Doing okay, At risk"),
  account_tier: z.string().optional().describe("Account tier, e.g. Basic, Premium, Enterprise"),
  renewal_date: z.string().optional().describe("Contract renewal date, YYYY-MM-DD"),
  industry: z.string().optional().describe("Industry, one of the field's choices"),
  custom_fields: customFields,
  lookup_parameter: z.string().optional().describe('With a lookup custom field: "display_id" or "primary_field_value"'),
};

const fieldFields = (what: string) => ({
  label: z.string().optional().describe("Name agents see"),
  type: z.string().optional().describe("Field type (on create): custom_text, custom_paragraph, custom_checkbox, custom_number, custom_dropdown, custom_phone_number, custom_url, custom_date"),
  position: z.number().int().optional().describe("Place in the form, from 1"),
  required_for_agents: z.boolean().optional().describe("Agents must fill it in"),
  choices: z.array(z.record(z.string(), z.any())).optional().describe('Dropdown choices, e.g. [{"value": "Gold", "position": 1}]'),
  ...(what === "contact" && {
    label_for_customers: z.string().optional().describe("Name customers see (required on create)"),
    customers_can_edit: z.boolean().optional().describe("Customers can change it"),
    required_for_customers: z.boolean().optional().describe("Customers must fill it in"),
    displayed_for_customers: z.boolean().optional().describe("Customers see it"),
    editable_in_signup: z.boolean().optional().describe("Shown on the portal sign-up form"),
  }),
});

const exportFields = {
  fields: z.object({ default_fields: z.array(z.string()), custom_fields: z.array(z.string()).optional() }).describe('Columns, e.g. {"default_fields": ["name", "email"], "custom_fields": ["cf_plan"]}'),
};
const importFields = (what: string) => ({
  file: z.any().describe(`The CSV of ${what}, {"file": "/work/....csv"}`),
  fields: z.record(z.string(), z.number().int()).describe(`Which CSV column (from 0) goes to which ${what === "contacts" ? "contact" : "company"} field, e.g. {"name": 0, "email": 2}`),
});

// filter search: Freshdesk wants the query in double quotes
const search = (what: string, path: string, fields: string): OwnAction => ({
  description: `Find ${what} with a query on their fields, e.g. ${fields}. Up to 30 per page, 10 pages; the answer has results and total.`,
  readOnly: true,
  input: z.object({
    query: z.string().min(1).describe("field:value joined by AND / OR, strings in single quotes, < and > for numbers and dates; custom fields by name"),
    page: z.number().int().min(1).max(10).optional().describe("Page 1-10 (default 1)"),
  }),
  run: (i: { query: string; page?: number }, key: string) =>
    call(api, key, { method: "GET", path, query: ["query", "page"], headers: [] }, { ...i, query: i.query.startsWith('"') ? i.query : `"${i.query}"` }),
});

export const contactActions: Record<string, OwnAction> = {
  // ── contacts
  get_contacts: r("GET", "/contacts", "List contacts (customers), with simple filters.", {
    email: z.string().optional().describe("Only the contact with this email"),
    mobile: z.string().optional().describe("Only contacts with this mobile"),
    phone: z.string().optional().describe("Only contacts with this phone"),
    company_id: z.number().int().optional().describe("Only this company's contacts"),
    state: z.enum(["blocked", "deleted", "unverified", "verified"]).optional().describe("Only contacts in this state"),
    updated_since: z.string().optional().describe("Only contacts changed since this ISO time"),
    ...page,
  }),
  get_contact: r("GET", "/contacts/{id}", "One contact with all its fields.", { id: contactId }),
  search_contacts: search("contacts", "/search/contacts", "\"email:'sarah@northwind.com'\", \"company_id:12 AND active:true\", \"tag:'vip'\", \"created_at:>'2026-11-01'\""),
  search_contacts_autocomplete: r("GET", "/contacts/autocomplete", "Contacts whose name starts with some letters (quick look-up by name).", { term: z.string().min(1).describe("The start of the name") }),
  create_contact: withFiles("POST", "/contacts", "Add a contact (customer). Needs a name and one of email, phone, mobile, twitter_id or unique_external_id.", {
    ...contactFields,
    name: z.string().min(1).describe("Full name"),
  }),
  update_contact: withFiles("PUT", "/contacts/{id}", "Change a contact's details. Fields left out stay as they are.", { id: contactId, ...contactFields }),
  delete_contact: r("DELETE", "/contacts/{id}", "Delete a contact (soft: freshdesk.restore_contact brings it back). Their tickets stay.", { id: contactId }),
  hard_delete_contact: r("DELETE", "/contacts/{id}/hard_delete", "Delete a contact for good, with their data (GDPR). Cannot be undone.", {
    id: contactId,
    force: z.boolean().optional().describe("true deletes even a contact that wasn't soft-deleted first"),
  }),
  restore_contact: r("PUT", "/contacts/{id}/restore", "Bring back a soft-deleted contact.", { id: contactId }),
  send_contact_invite: r("PUT", "/contacts/{id}/send_invite", "Email a contact an invite to the support portal.", { id: contactId }),
  merge_contacts: r("POST", "/contacts/merge", "Merge duplicate contacts into one; their tickets move to the primary contact.", {
    primary_contact_id: z.number().int().describe("Contact that stays"),
    secondary_contact_ids: z.array(z.number().int()).min(1).describe("Contacts merged into it"),
    contact: z.record(z.string(), z.any()).optional().describe("Which values to keep on the merged contact: email, phone, mobile, twitter_id, unique_external_id, other_emails, company_ids"),
  }),
  update_contact_make_agent: r("PUT", "/contacts/{id}/make_agent", "Turn a contact into an agent (uses a paid seat unless occasional; also how a field technician is made).", {
    id: contactId,
    occasional: z.boolean().optional().describe("Occasional (day pass) agent"),
    ticket_scope: z.number().int().optional().describe("Tickets they see: 1 all, 2 their groups', 3 only their own"),
    role_ids: z.array(z.number().int()).optional().describe("Roles (freshdesk.list_roles)"),
    group_ids: z.array(z.number().int()).optional().describe("Groups"),
    skill_ids: z.array(z.number().int()).optional().describe("Skills"),
    signature: z.string().optional().describe("Email signature, HTML"),
    type: z.string().optional().describe('"support_agent" (default), "field_agent" for a field technician, "collaborator"'),
  }, { loose: true }),
  export_contacts: r("POST", "/contacts/export", "Start a CSV export of all contacts. freshdesk.get_contact_export then gives the download link.", exportFields),
  get_contact_export: r("GET", "/contacts/export/{id}", "Status of a contact export, and its download link when done.", { id: z.string().min(1).describe("Export id from freshdesk.export_contacts") }),
  get_imported_contacts: r("GET", "/contacts/imports", "The 5 latest contact imports.", { status: z.enum(["in_progress", "completed"]).optional().describe("Only imports in this state") }),
  get_contact_import: r("GET", "/contacts/imports/{id}", "One contact import's progress.", { id: id("import") }),
  import_contact: withFiles("POST", "/contacts/imports", "Import contacts from a CSV file.", importFields("contacts")),
  cancel_contact_import: r("PUT", "/contacts/imports/{id}/cancel", "Stop a contact import that is running.", { id: id("import") }),

  // ── contact fields
  get_contact_fields: r("GET", "/contact_fields", "Every contact field, built-in and custom, with names, types and choices."),
  view_contact_field: r("GET", "/contact_fields/{id}", "One contact field.", { id: id("contact field") }),
  create_contact_field: r("POST", "/contact_fields", "Add a custom contact field (label, label_for_customers and type are needed).", fieldFields("contact"), { loose: true }),
  update_contact_field: r("PUT", "/contact_fields/{id}", "Change a contact field.", { id: id("contact field"), ...fieldFields("contact") }, { loose: true }),
  delete_contact_field: r("DELETE", "/contact_fields/{id}", "Delete a custom contact field and its values.", { id: id("contact field") }),

  // ── companies
  get_companies: r("GET", "/companies", "List companies.", { updated_since: z.string().optional().describe("Only companies changed since this ISO time"), ...page }),
  get_company: r("GET", "/companies/{id}", "One company with all its fields.", { id: companyId }),
  search_companies: search("companies", "/search/companies", "\"domain:'northwind.com'\", \"created_at:>'2026-11-01'\", or custom fields like \"account_tier:'Premium'\""),
  search_companies_autocomplete: r("GET", "/companies/autocomplete", "Companies whose name starts with some letters.", { name: z.string().min(1).describe("The start of the name") }),
  create_company: r("POST", "/companies", "Add a company.", { ...companyFields, name: z.string().min(1).describe("Company name (unique)") }, { loose: true }),
  update_company: r("PUT", "/companies/{id}", "Change a company's details. Fields left out stay as they are.", { id: companyId, ...companyFields }, { loose: true }),
  delete_company: r("DELETE", "/companies/{id}", "Delete a company. Its contacts stay, without the company.", { id: companyId }),
  export_companies: r("POST", "/companies/export", "Start a CSV export of all companies. freshdesk.get_company_export then gives the download link.", exportFields),
  get_company_export: r("GET", "/companies/export/{id}", "Status of a company export, and its download link when done.", { id: z.string().min(1).describe("Export id from freshdesk.export_companies") }),
  list_company_imports: r("GET", "/companies/imports", "The 5 latest company imports.", { status: z.enum(["in_progress", "completed"]).optional().describe("Only imports in this state") }),
  get_company_import: r("GET", "/companies/imports/{id}", "One company import's progress.", { id: id("import") }),
  import_companies: withFiles("POST", "/companies/imports", "Import companies from a CSV file.", importFields("companies")),
  cancel_company_import: r("PUT", "/companies/imports/{id}/cancel", "Stop a company import that is running.", { id: id("import") }),

  // ── company fields
  get_company_fields: r("GET", "/company_fields", "Every company field, built-in and custom."),
  view_company_field: r("GET", "/company_fields/{id}", "One company field.", { id: id("company field") }),
  create_company_field: r("POST", "/company_fields", "Add a custom company field (label and type are needed).", fieldFields("company"), { loose: true }),
  update_company_field: r("PUT", "/company_fields/{id}", "Change a company field.", { id: id("company field"), ...fieldFields("company") }, { loose: true }),
  delete_company_field: r("DELETE", "/company_fields/{id}", "Delete a custom company field and its values.", { id: id("company field") }),

  // ── activities from other systems on a contact's timeline
  publish_contact_activity: r("POST", "/contact-activities", "Show something that happened in another system (an order, a sign-up) on a contact's timeline.", {
    contact: z.record(z.string(), z.any()).describe('Who: {"email": "sarah@northwind.com"} or id, unique_external_id, twitter_id, facebook_id'),
    activity: z.record(z.string(), z.any()).describe('What: {"name": "Placed order", "timestamp": "2026-11-20T10:00:00Z", "description": "Order #1001", "link": "https://..."}'),
    actor: z.record(z.string(), z.any()).describe('Who did it: {"type": "system", "name": "Shop"} or {"type": "contact", "is_actor": true}'),
    source: z.record(z.string(), z.any()).describe('From where: {"name": "Shopify", "id": "shop1"}'),
    object: z.record(z.string(), z.any()).optional().describe("The thing it is about (order...)"),
    context: z.record(z.string(), z.any()).optional().describe("Extra details as key/value pairs"),
  }),
};
