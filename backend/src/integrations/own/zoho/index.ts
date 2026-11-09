// Zoho CRM: every operation in github.com/zoho/crm-oas (v8), from `bun scripts/openapi-actions.ts zoho`, plus create/list/get/update/delete/search
// for each everyday module, under Composio's names, so saved automations keep working. Sign-in only.
import { z } from "zod";
import type { OwnAction, OwnApp } from "../index";
import { type Api, call, specActions } from "../openapi";
import { zohoClient, zohoOAuth } from "../zoho-login";

// the broad families, plus the separately named ones Zoho's spec asks for (mass actions, ownership, composite calls, Zia)
export const SCOPES = "ZohoCRM.modules.ALL,ZohoCRM.settings.ALL,ZohoCRM.users.ALL,ZohoCRM.org.ALL,ZohoCRM.bulk.ALL,ZohoCRM.coql.READ,ZohoCRM.notifications.ALL,ZohoCRM.send_mail.all.CREATE,ZohoCRM.templates.email.READ,ZohoCRM.templates.inventory.READ,ZohoCRM.files.READ,ZohoCRM.files.CREATE,ZohoCRM.features.READ,ZohoCRM.change_owner.READ,ZohoCRM.change_owner.CREATE,ZohoCRM.mass_update.READ,ZohoCRM.mass_update.UPDATE,ZohoCRM.mass_delete.READ,ZohoCRM.mass_delete.DELETE,ZohoCRM.mass_convert.leads.READ,ZohoCRM.mass_convert.leads.CREATE,ZohoCRM.composite_requests.CUSTOM,ZohoCRM.apis.READ,ZohoCRM.zia.enrichment.READ,ZohoCRM.zia.enrichment.CREATE,ZohoCRM.zia.enrichment.UPDATE,ZohoCRM.zia.enrichment.DELETE,ZohoFiles.files.ALL";
const api: Api = zohoClient("Zoho CRM", "https://www.zohoapis.com/crm/v8");

const spec = await specActions(new URL("./actions.json", import.meta.url), api);

const FIELDS = "Which fields to include, by API name with commas, e.g. Last_Name,Email. Leave out for the common ones for this module";
// the record fields worth having on a list when none are asked for
export const DEFAULT_FIELDS: Record<string, string> = {
  Leads: "Full_Name,First_Name,Last_Name,Company,Email,Phone,Mobile,Lead_Status,Lead_Source,Owner,Created_Time,Modified_Time",
  Contacts: "Full_Name,First_Name,Last_Name,Account_Name,Email,Phone,Mobile,Owner,Created_Time,Modified_Time",
  Accounts: "Account_Name,Phone,Website,Industry,Owner,Created_Time,Modified_Time",
  Deals: "Deal_Name,Amount,Stage,Closing_Date,Account_Name,Contact_Name,Owner,Created_Time,Modified_Time",
  Events: "Event_Title,Start_DateTime,End_DateTime,Owner,Created_Time,Modified_Time",
  Tasks: "Subject,Status,Due_Date,Priority,Owner,Created_Time,Modified_Time",
  Calls: "Subject,Call_Type,Call_Start_Time,Owner,Created_Time,Modified_Time",
  Notes: "Note_Title,Note_Content,Parent_Id,Owner,Created_Time,Modified_Time",
  Products: "Product_Name,Product_Code,Unit_Price,Owner,Created_Time,Modified_Time",
};
const fieldsOf = (module: string, given?: string) => given ?? DEFAULT_FIELDS[module] ?? "id,Created_Time,Modified_Time";

const send = (method: string, path: string, query: string[] = []) => ({ method, path, query, headers: [] as [string, string][] });
const record = z.record(z.string(), z.any()).describe("The record's fields by API name, e.g. {\"Last_Name\": \"Rao\", \"Email\": \"a@b.com\"}. zoho.get_module_fields lists a module's");
// one-call-per-module helpers, named the way Composio named them
const MODULES: [singular: string, plural: string, module: string][] = [
  ["lead", "leads", "Leads"],
  ["contact", "contacts", "Contacts"],
  ["account", "accounts", "Accounts"],
  ["deal", "deals", "Deals"],
  ["event", "events", "Events"],
  ["task", "tasks", "Tasks"],
  ["call", "calls", "Calls"],
  ["note", "notes", "Notes"],
  ["product", "products", "Products"],
];
const helpers: Record<string, OwnAction> = Object.fromEntries(
  MODULES.flatMap(([one, many, module]): [string, OwnAction][] => [
    [`list_${many}`, {
      description: `List ${module} from Zoho CRM, newest changes first unless you sort otherwise.`,
      readOnly: true,
      input: z.object({ fields: z.string().optional().describe(FIELDS), per_page: z.number().int().optional().describe("How many per page, up to 200"), page: z.number().int().optional(), sort_by: z.string().optional().describe("A field's API name, e.g. Modified_Time"), sort_order: z.enum(["asc", "desc"]).optional() }),
      run: (i: { fields?: string; [k: string]: unknown }, key: string) => call(api, key, send("GET", `/${module}`, ["fields", "per_page", "page", "sort_by", "sort_order"]), { sort_by: "Modified_Time", sort_order: "desc", ...i, fields: fieldsOf(module, i.fields) }),
    }],
    [`get_${one}`, {
      description: `Get one ${one} from Zoho CRM by its id.`,
      readOnly: true,
      input: z.object({ id: z.string().describe(`The ${one}'s id`), fields: z.string().optional().describe(FIELDS) }),
      run: (i: { id: string; fields?: string }, key: string) => call(api, key, send("GET", `/${module}/{id}`, ["fields"]), { ...i, fields: fieldsOf(module, i.fields) }),
    }],
    [`search_${many}`, {
      description: `Search ${module} in Zoho CRM by a word, an email, a phone number or a criteria expression.`,
      readOnly: true,
      input: z.object({ word: z.string().optional().describe("Find this word"), email: z.string().optional(), phone: z.string().optional(), criteria: z.string().optional().describe('For exact conditions, e.g. (Last_Name:equals:Rao)'), fields: z.string().optional().describe(FIELDS) }),
      run: (i: { fields?: string; [k: string]: unknown }, key: string) => call(api, key, send("GET", `/${module}/search`, ["word", "email", "phone", "criteria", "fields"]), { ...i, fields: fieldsOf(module, i.fields) }),
    }],
    [`create_${one}`, {
      description: `Add a ${one} to Zoho CRM.`,
      input: z.object({ record }),
      run: (i: { record: unknown }, key: string) => call(api, key, { ...send("POST", `/${module}`), body: { kind: "fields", fields: [["data", "data"]] } }, { data: [i.record] }),
    }],
    [`update_${one}`, {
      description: `Change a ${one} in Zoho CRM.`,
      input: z.object({ id: z.string().describe(`The ${one}'s id`), record }),
      run: (i: { id: string; record: unknown }, key: string) => call(api, key, { ...send("PUT", `/${module}/{id}`), body: { kind: "fields", fields: [["data", "data"]] } }, { id: i.id, data: [i.record] }),
    }],
    [`delete_${one}`, {
      description: `Delete a ${one} from Zoho CRM.`,
      input: z.object({ id: z.string().describe(`The ${one}'s id`) }),
      run: (i: { id: string }, key: string) => call(api, key, send("DELETE", `/${module}/{id}`), i),
    }],
  ]),
);

// a record's emails are a related list; these are Composio's names for it
const relatedEmails: Record<string, OwnAction> = {
  get_record_emails: { description: "List the emails linked to a record.", readOnly: true, input: z.object({ module: z.string().describe("The module's API name, e.g. Leads or Contacts"), id: z.string().describe("The record's id"), per_page: z.number().int().optional(), page: z.number().int().optional() }), run: (i: { module: string; id: string }, key: string) => call(api, key, send("GET", "/{module}/{id}/Emails", ["per_page", "page"]), i) },
  get_record_email: { description: "Read one email linked to a record.", readOnly: true, input: z.object({ module: z.string().describe("The module's API name, e.g. Leads or Contacts"), id: z.string().describe("The record's id"), message_id: z.string().describe("The email's id, from get_record_emails") }), run: (i: { module: string; id: string; message_id: string }, key: string) => call(api, key, send("GET", "/{module}/{id}/Emails/{message_id}"), i) },
};

export const zoho: OwnApp = {
  app: "zoho",
  name: "Zoho CRM",
  logo: "/logos/zoho.svg",
  async check(key) {
    const out = (await call(api, key, send("GET", "/users", ["type"]), { type: "CurrentUser" })) as { users?: { full_name?: string; email?: string }[] };
    const me = out.users?.[0];
    return me?.full_name ?? me?.email;
  },
  oauth: zohoOAuth("Zoho CRM", SCOPES),
  actions: { ...relatedEmails, ...helpers, ...spec },
};
