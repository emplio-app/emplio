// Zendesk calls none of its published OpenAPI specs include (webhooks, side conversations, apps, business hours,
// customer profiles and events, help center themes), written from its API reference, plus a few conveniences.
import { z } from "zod";
import { AppFile, AppsError } from "../../types";
import type { OwnAction } from "../index";
import { call, rest, type Send } from "../openapi";
import { api, parseKey } from "./api";

// The Webhooks API, which none of Zendesk's published specs include
const HOOK = { webhook_id: z.string().describe("The webhook's id, like 01EJFTSCC78X5V07NPY2MHR00M (list_webhooks shows them)") };
const WEBHOOK = z
  .object({
    name: z.string().describe("Its name"),
    endpoint: z.string().describe("The address Zendesk calls, starting https://"),
    http_method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]).describe("How it's called; POST for events"),
    request_format: z.enum(["json", "xml", "form_encoded"]).describe("The body's format; json for events"),
    status: z.enum(["active", "inactive"]).describe("Whether it's on"),
    subscriptions: z.array(z.string()).optional().describe('Events it receives, like ["zen:event-type:ticket.created"], or ["conditional_ticket_events"] to be called by a Zendesk trigger or automation'),
    description: z.string().optional().describe("What it's for"),
    authentication: z.record(z.string(), z.any()).optional().describe('How Zendesk signs in to the address: {"type": "bearer_token", "add_position": "header", "data": {"token": "..."}}, or basic_auth / api_key'),
    custom_headers: z.record(z.string(), z.string()).optional().describe("Extra headers to send, by name"),
  })
  .partial();
const webhook = (i: Record<string, any>) => {
  const { webhook_id, ...w } = i;
  return { ...(webhook_id && { webhook_id }), body: { webhook: w } };
};
const whole = (method: string, path: string, query: string[] = []): Send => ({ method, path, query, headers: [], body: { kind: "whole", field: "body" } });
const send = (method: string, path: string, query: string[] = []): Send => ({ method, path, query, headers: [] });
const PAGE = {
  "page[size]": z.number().int().optional().describe("How many to answer, up to 100"),
  "page[after]": z.string().optional().describe("The meta.after_cursor of the previous answer, for the next page"),
};
export const hooks: Record<string, OwnAction> = {
  list_webhooks: {
    description: "List the account's webhooks: the addresses Zendesk sends events or trigger notifications to. Admins only.",
    readOnly: true,
    input: z.object({
      "filter[name_contains]": z.string().optional().describe("Only webhooks whose name has this in it"),
      "filter[status]": z.enum(["active", "inactive"]).optional().describe("Only webhooks that are on, or off"),
      sort: z.enum(["name", "-name", "status", "-status"]).optional().describe("Order"),
      ...PAGE,
    }),
    run: (i, key) => call(api, key, send("GET", "/api/v2/webhooks", ["filter[name_contains]", "filter[status]", "sort", "page[size]", "page[after]"]), i),
  },
  create_webhook: {
    description: "Create a webhook: an address Zendesk sends events to, or one Zendesk triggers and automations can notify. Admins only.",
    input: WEBHOOK.required({ name: true, endpoint: true, http_method: true, request_format: true, status: true }),
    run: (i, key) => call(api, key, whole("POST", "/api/v2/webhooks"), webhook(i)),
  },
  show_webhook: rest(api, "GET", "/api/v2/webhooks/{webhook_id}", "Show one webhook.", z.object(HOOK)),
  update_webhook: {
    description: "Replace a webhook's settings (all of them; patch_webhook changes only some).",
    input: WEBHOOK.extend(HOOK).required({ name: true, endpoint: true, http_method: true, request_format: true, status: true }),
    run: (i, key) => call(api, key, whole("PUT", "/api/v2/webhooks/{webhook_id}"), webhook(i)),
  },
  patch_webhook: {
    description: "Change some of a webhook's settings: its name, address, events, whether it's on.",
    input: WEBHOOK.extend(HOOK),
    run: (i, key) => call(api, key, whole("PATCH", "/api/v2/webhooks/{webhook_id}"), webhook(i)),
  },
  delete_webhook: rest(api, "DELETE", "/api/v2/webhooks/{webhook_id}", "Delete a webhook. Triggers and automations that notify it stop working.", z.object(HOOK)),
  test_webhook: {
    description: "Send a test request to a webhook, or to settings not saved yet, and see what the address answered.",
    input: z.object({
      webhook_id: z.string().optional().describe("Test this saved webhook"),
      webhook: z.record(z.string(), z.any()).optional().describe('Or test these settings: {"endpoint": "https://...", "http_method": "POST", "request_format": "json"}'),
      request: z.record(z.string(), z.any()).optional().describe('What to send: {"payload": "{\\"a\\": 1}", "headers": [{"key": "X-Test", "value": "1"}]}'),
    }),
    run: (i, key) => call(api, key, { ...whole("POST", "/api/v2/webhooks/test", ["webhook_id"]) }, { webhook_id: i.webhook_id, body: { ...(i.webhook && { webhook: i.webhook }), ...(i.request && { request: i.request }) } }),
  },
  show_webhook_signing_secret: {
    description: "Show the secret a webhook signs its requests with. Shows a secret: only when the person needs it, never pasted in a chat.",
    input: z.object(HOOK),
    run: (i, key) => call(api, key, send("GET", "/api/v2/webhooks/{webhook_id}/signing_secret"), i),
  },
  reset_webhook_signing_secret: rest(api, "POST", "/api/v2/webhooks/{webhook_id}/signing_secret", "Make a new signing secret for a webhook; the old one stops working.", z.object(HOOK)),
  list_webhook_invocations: {
    description: "List a webhook's recent calls (the last 7 days): when, which event, and whether the address answered OK.",
    readOnly: true,
    input: z.object({
      ...HOOK,
      "filter[from_ts]": z.string().optional().describe("Only calls from this time (ISO 8601)"),
      "filter[to_ts]": z.string().optional().describe("Only calls up to this time"),
      "filter[status]": z.enum(["success", "failed", "circuit broken"]).optional().describe("Only calls that ended this way"),
      sort: z.enum(["latest_completed_at", "-latest_completed_at"]).optional().describe("Order"),
      ...PAGE,
    }),
    run: (i, key) =>
      call(api, key, send("GET", "/api/v2/webhooks/{webhook_id}/invocations", ["filter[from_ts]", "filter[to_ts]", "filter[status]", "sort", "page[size]", "page[after]"]), i),
  },
  list_webhook_invocation_attempts: rest(
    api,
    "GET",
    "/api/v2/webhooks/{webhook_id}/invocations/{invocation_id}/attempts",
    "List the tries of one webhook call: each try's time, status code and answer.",
    z.object({ ...HOOK, invocation_id: z.string().describe("The call's id, from list_webhook_invocations") }),
  ),
};

// A call written from the API reference: {names} in the path are its ids; anything else given goes in the query
// (GET, DELETE) or the JSON body, so every field Zendesk takes is reachable
const ids = (path: string) =>
  Object.fromEntries([...path.matchAll(/\{(\w+)\}/g)].map((m) => [m[1]!, z.string().describe(`The ${m[1]!.replace(/_id$/, "").replace(/_/g, " ")}'s id`)]));
const by = (method: string, path: string, description: string, fields: z.ZodRawShape = {}, opts: { readOnly?: boolean; query?: string[] } = {}) =>
  rest(api, method, path, description, z.object({ ...ids(path), ...fields }).loose(), opts);

const START = { start_time: z.number().int().describe("Only events from this time on (Unix seconds)") };
const IDENTIFIER = { identifier: z.string().describe('Which profile: "<source>:<type>:<identifier_type>:<value>", e.g. "shopify:customer:email:sarah@northwind.com"') };
const SIDE = (more: string) => `A side conversation is a separate email or Slack thread an agent starts from a ticket, with people outside it. ${more}`;
const MESSAGE = { message: z.record(z.string(), z.any()).describe('The message: {"subject": "Need a refund approval", "body": "Can you approve…", "to": [{"email": "finance@northwind.com"}]} (or {"support_group_id": 123} in to)') };

// a file going up as a multipart form, under `field`
const upload = (path: string, description: string, field: string, more: z.ZodRawShape = {}): OwnAction => ({
  description,
  input: z.object({ ...ids(path), file: z.any().describe('The file from the computer: {"file": "/work/report.pdf"}'), ...more }),
  run: (i, key) => {
    if (!(i.file instanceof AppFile)) throw new AppsError('file: give the file as {"file": "/work/report.pdf"}');
    const fields = Object.keys(more).map((k): [string, string] => [k, k]);
    return call(api, key, { method: "POST", path, query: [], headers: [], body: { kind: "form", fields: [["file", field], ...fields] } }, i);
  },
});

const GET = (path: string): Send => ({ method: "GET", path, query: [], headers: [] });

const more: Record<string, OwnAction> = {
  // side conversations
  list_ticket_side_conversations: by("GET", "/api/v2/tickets/{ticket_id}/side_conversations", SIDE("List the ticket's side conversations.")),
  get_zendesk_tickets_side_conversation_id: by("GET", "/api/v2/tickets/{ticket_id}/side_conversations/{side_conversation_id}", SIDE("Show one, with its people and state.")),
  create_side_conversation: by("POST", "/api/v2/tickets/{ticket_id}/side_conversations", SIDE("Start one on the ticket."), MESSAGE),
  reply_to_side_conversation: by("POST", "/api/v2/tickets/{ticket_id}/side_conversations/{side_conversation_id}/reply", SIDE("Reply in one."), {
    message: z.record(z.string(), z.any()).describe('The reply: {"body": "Thanks, approved."}'),
  }),
  update_side_conversation: by("PUT", "/api/v2/tickets/{ticket_id}/side_conversations/{side_conversation_id}", SIDE("Close or reopen one, or change its subject."), {
    side_conversation: z.record(z.string(), z.any()).describe('What to change: {"state": "closed"} or {"subject": "..."}'),
  }),
  get_tickets_side_conversations_events: by("GET", "/api/v2/tickets/{ticket_id}/side_conversations/{side_conversation_id}/events", SIDE("List what happened in one: messages, replies, state changes.")),
  get_side_conversations_events: by("GET", "/api/v2/tickets/side_conversations/events", SIDE("List events across all side conversations since a time, oldest first, for keeping a copy in sync."), START),
  import_side_conversation: by("POST", "/api/v2/tickets/{ticket_id}/side_conversations/import", SIDE("Bring in one from another system, with its past messages."), {
    side_conversation: z.record(z.string(), z.any()).describe("The side conversation to import, as Zendesk's import format describes"),
  }),
  import_side_conversation_events: by("POST", "/api/v2/tickets/{ticket_id}/side_conversations/{side_conversation_id}/events/import", SIDE("Bring in past messages from another system."), {
    events: z.array(z.record(z.string(), z.any())).describe("The events to import"),
  }),
  upload_side_conversation_attachment: upload("/api/v2/tickets/side_conversations/attachments", SIDE("Upload a file to attach to a side conversation message; answers the attachment id to put in the message's attachment_ids."), "file"),
  redact_side_conversation_attachment: by("PUT", "/api/v2/tickets/{ticket_id}/side_conversations/{side_conversation_id}/attachments/{attachment_id}/redact", SIDE("Remove a file from one for good.")),

  // apps from the Zendesk Marketplace, and private ones
  list_apps: by("GET", "/api/v2/apps", "List the Zendesk apps this account can install."),
  get_owned_apps: by("GET", "/api/v2/apps/owned", "List the Zendesk apps this account made itself."),
  get_app: by("GET", "/api/v2/apps/{app_id}", "Show one Zendesk app."),
  get_apps_public_key: by("GET", "/api/v2/apps/{app_id}/public_key", "Show the public key a Zendesk app signs its tokens with (JWK)."),
  get_apps_public_key_pem: by("GET", "/api/v2/apps/{app_id}/public_key.pem", "Show the public key a Zendesk app signs its tokens with (PEM)."),
  upload_app_package: upload("/api/v2/apps/uploads", "Upload a private Zendesk app's zip package; answers the upload id create_app takes.", "uploaded_data"),
  create_app: by("POST", "/api/v2/apps", "Create a private Zendesk app from an uploaded package. Answers a job id (get_apps_job_status).", {
    name: z.string().describe("The app's name"),
    short_description: z.string().optional().describe("One line about it"),
    upload_id: z.number().int().describe("The id upload_app_package gave"),
  }),
  update_app: by("PUT", "/api/v2/apps/{app_id}", "Update a private Zendesk app, from a new package or new details.", { upload_id: z.number().int().optional().describe("A new package's upload id") }),
  delete_app: by("DELETE", "/api/v2/apps/{app_id}", "Delete a private Zendesk app."),
  get_apps_job_status: by("GET", "/api/v2/apps/job_statuses/{job_status_id}", "Check how creating or updating a Zendesk app is going."),
  create_apps_notify: by("POST", "/api/v2/apps/notify", "Send a message to a Zendesk app open in agents' browsers.", {
    app_id: z.number().int().describe("The app's id"),
    event: z.string().describe("The event name the app listens for"),
    body: z.any().optional().describe("What to send it"),
    agent_id: z.number().int().optional().describe("Only this agent's browser"),
  }),
  list_app_installations: by("GET", "/api/v2/apps/installations", "List the Zendesk apps installed in this account, and whether each is on."),
  list_app_installations_of_app: by("GET", "/api/v2/apps/{app_id}/installations", "List the installations of one Zendesk app."),
  get_app_installation: by("GET", "/api/v2/apps/installations/{app_installation_id}", "Show one installed Zendesk app and its settings."),
  create_apps_installation: by("POST", "/api/v2/apps/installations", "Install a Zendesk app in the account.", {
    app_id: z.number().int().describe("The app's id"),
    settings: z.record(z.string(), z.any()).describe('Its settings, at least {"name": "..."} plus whatever the app asks for'),
  }),
  update_apps_installation: by("PUT", "/api/v2/apps/installations/{app_installation_id}", "Change an installed Zendesk app's settings, or turn it on or off.", {
    enabled: z.boolean().optional().describe("On or off"),
    settings: z.record(z.string(), z.any()).optional().describe("Settings to change"),
  }),
  delete_zendesk_app_installation: by("DELETE", "/api/v2/apps/installations/{app_installation_id}", "Uninstall a Zendesk app."),
  get_apps_installations_requirements: by("GET", "/api/v2/apps/installations/{app_installation_id}/requirements", "List what an installed Zendesk app set up (fields, targets, webhooks)."),
  get_apps_installation_job_status: by("GET", "/api/v2/apps/installations/job_statuses/{job_id}", "Check how installing a Zendesk app is going."),
  list_app_locations: by("GET", "/api/v2/apps/locations", "List the places in Zendesk an app can appear (ticket sidebar, nav bar…)."),
  get_apps_location: by("GET", "/api/v2/apps/locations/{location_id}", "Show one place in Zendesk an app can appear."),
  get_apps_location_installations: by("GET", "/api/v2/apps/location_installations", "List which installed apps show in each place, in order."),
  reorder_location_installations: by("POST", "/api/v2/apps/location_installations/reorder", "Set the order installed apps show in at one place.", {
    installations: z.array(z.number().int()).describe("Installation ids, in the order to show"),
    location_name: z.string().describe("The place, like zendesk.ticket_sidebar"),
  }),

  // business hours
  list_business_hours_schedules: by("GET", "/api/v2/business_hours/schedules", "List the business-hours schedules (opening hours used for SLAs and triggers)."),
  get_business_hours_schedule: by("GET", "/api/v2/business_hours/schedules/{schedule_id}", "Show one business-hours schedule, with its weekly hours."),
  create_business_hours_schedule: by("POST", "/api/v2/business_hours/schedules", "Create a business-hours schedule.", {
    schedule: z.record(z.string(), z.any()).describe('{"name": "Support hours", "time_zone": "London"}; set the hours with update_schedule_workweek'),
  }),
  update_business_hours_schedule: by("PUT", "/api/v2/business_hours/schedules/{schedule_id}", "Rename a business-hours schedule or change its time zone.", { schedule: z.record(z.string(), z.any()).describe("What to change") }),
  delete_business_hours_schedule: by("DELETE", "/api/v2/business_hours/schedules/{schedule_id}", "Delete a business-hours schedule."),
  update_schedule_workweek: by("PUT", "/api/v2/business_hours/schedules/{schedule_id}/workweek", "Set a schedule's weekly opening hours.", {
    workweek: z.record(z.string(), z.any()).describe('{"intervals": [{"start_time": 1980, "end_time": 2460}]}: minutes from Sunday midnight'),
  }),
  list_schedule_holidays: by("GET", "/api/v2/business_hours/schedules/{schedule_id}/holidays", "List a schedule's holidays."),
  get_schedule_holiday: by("GET", "/api/v2/business_hours/schedules/{schedule_id}/holidays/{holiday_id}", "Show one holiday."),
  create_schedule_holiday: by("POST", "/api/v2/business_hours/schedules/{schedule_id}/holidays", "Add a holiday to a schedule.", {
    holiday: z.record(z.string(), z.any()).describe('{"name": "New Year", "start_date": "2027-01-01", "end_date": "2027-01-01"}'),
  }),
  update_schedule_holiday: by("PUT", "/api/v2/business_hours/schedules/{schedule_id}/holidays/{holiday_id}", "Change a holiday.", { holiday: z.record(z.string(), z.any()).describe("What to change") }),
  delete_schedule_holiday: by("DELETE", "/api/v2/business_hours/schedules/{schedule_id}/holidays/{holiday_id}", "Delete a holiday."),

  // customer profiles and events (what customers did in other systems)
  get_users_profiles: by("GET", "/api/v2/users/{user_id}/profiles", "List a person's profiles from other systems (a shop, a CRM)."),
  get_user_profiles2: by("GET", "/api/v2/user_profiles/{profile_id}", "Show one customer profile."),
  get_user_profile_by_identifier: by("GET", "/api/v2/user_profiles", "Find a customer profile by its identifier.", IDENTIFIER),
  update_users_profiles: by("PUT", "/api/v2/users/{user_id}/profiles", "Create or replace a person's profile from another system.", { ...IDENTIFIER, profile: z.record(z.string(), z.any()).describe('{"name": "Sarah", "attributes": {...}}') }, { query: ["identifier"] }),
  replace_user_profile: by("PUT", "/api/v2/user_profiles", "Create or replace a customer profile by its identifier.", { ...IDENTIFIER, profile: z.record(z.string(), z.any()).describe("The profile") }, { query: ["identifier"] }),
  replace_user_profile_by_id: by("PUT", "/api/v2/user_profiles/{profile_id}", "Replace a customer profile.", { profile: z.record(z.string(), z.any()).describe("The profile") }),
  update_user_profile: by("PATCH", "/api/v2/user_profiles", "Change some of a customer profile, found by its identifier.", { ...IDENTIFIER, profile: z.record(z.string(), z.any()).describe("What to change") }, { query: ["identifier"] }),
  update_user_profile_by_id: by("PATCH", "/api/v2/user_profiles/{profile_id}", "Change some of a customer profile.", { profile: z.record(z.string(), z.any()).describe("What to change") }),
  delete_user_profile: by("DELETE", "/api/v2/user_profiles/{profile_id}", "Delete a customer profile."),
  update_profile_namespace: by("PUT", "/api/v2/user_profiles/namespaces/{namespace_ref_id}", "Set up a source's namespace for customer profiles.", { source: z.string().describe("The source, like shopify") }, { query: ["source"] }),
  delete_profile_namespace: by("DELETE", "/api/v2/user_profiles/namespaces/{namespace_ref_id}", "Remove a source's namespace for customer profiles.", { source: z.string().describe("The source") }),
  get_user_events: by("GET", "/api/v2/users/{user_id}/events", "List what a person did, from other systems and Zendesk (orders, visits, sign-ins)."),
  list_user_event_types: by("GET", "/api/v2/users/{user_id}/events/types", "List the kinds of events recorded for a person."),
  get_user_profile_events: by("GET", "/api/v2/user_profiles/events", "List a customer profile's events, found by its identifier.", IDENTIFIER),
  get_user_profiles_events2: by("GET", "/api/v2/user_profiles/{profile_id}/events", "List a customer profile's events."),
  create_user_event: by("POST", "/api/v2/users/{user_id}/events", "Record something a person did in another system.", {
    event: z.record(z.string(), z.any()).describe('{"source": "shopify", "type": "order_placed", "properties": {...}}'),
  }),
  create_user_profiles_events: by("POST", "/api/v2/user_profiles/events", "Record something a customer did, creating their profile if it isn't there.", {
    profile: z.record(z.string(), z.any()).describe('{"source": "shopify", "type": "customer", "identifiers": [{"type": "email", "value": "sarah@northwind.com"}]}'),
    event: z.record(z.string(), z.any()).describe('{"source": "shopify", "type": "order_placed", "properties": {...}}'),
  }),
  create_user_profile_event_by_id: by("POST", "/api/v2/user_profiles/{profile_id}/events", "Record something a customer did, on their profile.", { event: z.record(z.string(), z.any()).describe("The event") }),

  // help center themes
  list_guide_themes: by("GET", "/api/v2/guide/theming/themes", "List the help center's themes.", { brand_id: z.string().optional().describe("Only this brand's") }),
  get_guide_theme: by("GET", "/api/v2/guide/theming/themes/{theme_id}", "Show one help center theme."),
  publish_guide_theme: by("POST", "/api/v2/guide/theming/themes/{theme_id}/publish", "Make a theme the help center's live one."),
  delete_guide_theme: by("DELETE", "/api/v2/guide/theming/themes/{theme_id}", "Delete a help center theme."),
  get_guide_theme_job: by("GET", "/api/v2/guide/theming/jobs/{job_id}", "Check a theme import, update or export: its state and, for an export, the download link."),
  create_theme_import_job: by("POST", "/api/v2/guide/theming/jobs/themes/imports", "Start importing a help center theme; answers where to upload its zip.", { job: z.record(z.string(), z.any()).describe('{"attributes": {"brand_id": "123", "format": "zip"}}') }),
  create_theme_update_job: by("POST", "/api/v2/guide/theming/jobs/themes/updates", "Start replacing a help center theme's files; answers where to upload its zip.", { job: z.record(z.string(), z.any()).describe('{"attributes": {"theme_id": "...", "replace_settings": false, "format": "zip"}}') }),
  create_theme_export_job: by("POST", "/api/v2/guide/theming/jobs/themes/exports", "Start exporting a help center theme as a zip.", { job: z.record(z.string(), z.any()).describe('{"attributes": {"theme_id": "...", "format": "zip"}}') }),

  // conveniences
  reply_zendesk_ticket: {
    description: "Reply to a Zendesk ticket: a public reply the customer gets, or an internal note. Optionally change its status or assignee at the same time.",
    input: z.object({
      ticket_id: z.string().describe("The ticket's number"),
      body: z.string().describe("What to say"),
      public: z.boolean().optional().describe("false for an internal note only the team sees (default: a public reply)"),
      status: z.enum(["new", "open", "pending", "hold", "solved", "closed"]).optional().describe("Set the status too"),
      assignee_id: z.number().int().optional().describe("Assign it to this agent too"),
      uploads: z.array(z.string()).optional().describe("Upload tokens from create_zendesk_attachments, to attach files"),
    }),
    run: (i, key) =>
      call(api, key, { method: "PUT", path: "/api/v2/tickets/{ticket_id}", query: [], headers: [], body: { kind: "whole", field: "body" } }, {
        ticket_id: i.ticket_id,
        body: { ticket: { comment: { body: i.body, public: i.public ?? true, ...(i.uploads && { uploads: i.uploads }) }, ...(i.status && { status: i.status }), ...(i.assignee_id && { assignee_id: i.assignee_id }) } },
      }),
  },
  download_attachment: {
    description: "Download a file attached to a Zendesk ticket, into the chat's computer.",
    readOnly: true,
    input: z.object({ attachment_id: z.string().describe("The attachment's id (in a comment's attachments)") }),
    run: async (i, key) => {
      const { attachment } = (await call(api, key, GET("/api/v2/attachments/{attachment_id}"), i)) as { attachment: { file_name: string; content_type: string; content_url: string } };
      const url = new URL(attachment.content_url);
      // only the person's own Zendesk gets their login; Zendesk's file host takes the link alone
      const own = url.hostname === parseKey(key).host;
      const res = await fetch(url, { headers: own ? api.auth!(key, {}) : {} });
      if (!res.ok) throw new AppsError(`Zendesk: couldn't download ${attachment.file_name} (${res.status})`);
      return new AppFile(attachment.file_name, attachment.content_type, new Uint8Array(await res.arrayBuffer()));
    },
  },
  list_help_center_content: {
    description: "List one level of the help center in a language: its categories, the sections in a category, or the articles in a section.",
    readOnly: true,
    input: z.object({
      locale: z.string().describe("The language, like en-us"),
      category_id: z.string().optional().describe("List this category's sections"),
      section_id: z.string().optional().describe("List this section's articles"),
    }),
    run: (i, key) => {
      const path = i.section_id
        ? "/api/v2/help_center/{locale}/sections/{section_id}/articles"
        : i.category_id
          ? "/api/v2/help_center/{locale}/categories/{category_id}/sections"
          : "/api/v2/help_center/{locale}/categories";
      return call(api, key, GET(path), i);
    },
  },
};

export const hand: Record<string, OwnAction> = { ...hooks, ...more };
