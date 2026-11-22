// HighLevel: what the generator (../openapi-actions.ts) can't tell from its specs. HighLevel publishes one OpenAPI
// file per area (github.com/GoHighLevel/highlevel-api-docs, apps/v3); this lists them, names actions the way Composio
// does, and moves the per-call Version header and the sub-account id out of the agent's way (own/gohighlevel/index.ts
// puts them back when it sends).
import type { AppConfig } from "../openapi-actions";
import { namer } from "./composio-names";

const OUT = "src/integrations/own/gohighlevel/actions.json";
const AREAS = [
  "contacts", "conversations", "opportunities", "calendars", "invoices", "payments", "products", "store", "forms", "surveys",
  "workflows", "campaigns", "emails", "email-isv", "users", "locations", "businesses", "companies", "custom-fields", "custom-menus",
  "objects", "associations", "medias", "links", "funnels", "blogs", "courses", "social-planner", "ad-publishing", "affiliate-manager",
  "agent-studio", "conversation-ai", "voice-ai", "knowledge-base", "brand-boards", "chat-widget", "phone-system", "proposals",
  "saas", "snapshots", "marketplace", "oauth",
];
const SPEC = (area: string) => `https://raw.githubusercontent.com/GoHighLevel/highlevel-api-docs/main/apps/v3/${area}-v3.json`;
const MARKETPLACE = "billing and installs of a HighLevel Marketplace app; a private integration token isn't one";

// the same summary or operation id in two areas: the second gets its path's resource added
// Composio's names (its toolkit is "highlevel"). Read here rather than with composioNames(): the page now starts with an
// empty "tools":[] and lists the real ones further on
const page = (await (await fetch("https://docs.composio.dev/toolkits/highlevel")).text()).replace(/\\"/g, '"');
const composio = [...new Set([...page.matchAll(/"slug":"HIGHLEVEL_([A-Z0-9_]+)"/g)].map((m) => m[1]!.toLowerCase()))];
if (!composio.length) throw new Error("no Composio tool names found for highlevel");
const base = namer(composio);
const taken = new Set<string>();
const name: NonNullable<AppConfig["name"]> = (id, method, path, op) => {
  let n = base(id, method, path, op);
  if (taken.has(n)) n = `${n}_${path.split("/").filter((s) => s && !s.startsWith("{"))[0]!.replace(/-/g, "_")}`;
  taken.add(n);
  return n;
};

const RECORD = {
  properties: { type: "object", additionalProperties: {}, description: 'The record\'s fields by key, as the object\'s schema names them (get_object_schema), e.g. {"name": "Gold plan", "custom_objects.pets.breed": "Beagle"}' },
  owner: { type: "array", items: { type: "string" }, description: "User ids who own the record (only one owner is allowed today)" },
  followers: { type: "array", items: { type: "string" }, description: "User ids who follow the record" },
};
const BODIES: Record<string, Record<string, unknown>> = {
  search_contacts: {
    locationId: { type: "string", description: "The sub-account to search" },
    query: { type: "string", description: "Free text to look for in names, emails, phone numbers and company names" },
    page: { type: "number", description: "Page number, from 1. Use page or searchAfter, not both" },
    pageLimit: { type: "number", description: "Contacts per page, at most 500 (default 20)" },
    searchAfter: { type: "array", items: {}, description: "For deep paging past 10,000 results: the searchAfter value of the last contact in the previous page" },
    filters: {
      type: "array",
      items: { type: "object", additionalProperties: {} },
      description: 'Conditions, all of which must match, e.g. [{"field": "tags", "operator": "contains", "value": "vip"}, {"field": "dateAdded", "operator": "range", "value": {"gte": "2026-01-01T00:00:00Z"}}]. Operators: eq, not_eq, contains, not_contains, exists, not_exists, range, wildcard. For any-of, use {"group": "OR", "filters": [...]}',
    },
    sort: { type: "array", items: { type: "object", additionalProperties: {} }, description: 'Order, e.g. [{"field": "dateAdded", "direction": "desc"}]' },
  },
  create_record: { locationId: { type: "string", description: "The sub-account" }, ...RECORD },
  update_record: RECORD,
};

// searches and lookups sent as POST, so they run without asking (by call: their names come from Composio's list)
const READS = new Set([
  "/contacts/search", "/opportunities/search", "/calendars/groups/validate-slug", "/store/shipping-zone/shipping-rates",
  "/users/search/filter-by-email", "/locations/{locationId}/tasks/search", "/objects/{schemaKey}/records/search",
  "/social-media-posting/{locationId}/posts/list", "/social-media-posting/{locationId}/tags/details", "/social-media-posting/statistics",
  "/social-media-posting/category/queues/list", "/social-media-posting/category/queues/{queueId}/items",
  "/social-media-posting/category/queues/{queueId}/edit/calendar", "/social-media-posting/category/queues/{queueId}/slots",
  "/social-media-posting/category/queues/list/calendar", "/social-media-posting/comments/{platform}/list", "/ad-publishing/google/keyword-ideas",
]);

export default {
  spec: AREAS.map(SPEC),
  server: () => undefined,
  out: OUT,
  name,
  // Composio's name for the same call, where the summary gave another
  rename: {
    get_tag_by_id: "get_tag",
    update_calendar_schedule: "update_calendars_schedules_event_calendar",
    update_user_availability_schedule: "update_calendar_schedule",
    get_event_notification: "list_event_notifications",
    get_notification: "get_event_notification",
    add_tags: "add_contact_tags",
    remove_tags: "remove_contact_tags",
    create_note: "create_contact_note",
    create_task: "create_contact_task",
    update_task: "update_contact_task",
    get_duplicate_contact: "search_duplicate_contact",
    create_brand_voice: "create_brand_boards_voices",
    list_brand_voices: "list_brand_boards_voices",
    create_service_location: "create_calendars_service_location",
    create_template_folder: "create_emails_templates_folder",
    create_folder: "create_medias_folder",
    delete_file_or_folder: "delete_medias",
    delete_record: "delete_objects_record",
    list_email_templates: "get_emails_templates",
    get_event_calendar_availability_schedule: "get_calendars_schedules_event_calendar",
    get_service_bookings: "get_calendars_services_bookings",
    list_bulk_action_campaigns: "get_emails_campaigns_bulk_actions2",
    list_email_campaigns: "get_emails_campaigns_emails",
    fetch_list_of_funnel_pages: "get_funnels_page",
    fetch_count_of_funnel_pages: "get_funnels_page_count",
    fetch_list_of_funnels: "list_funnels_funnel",
    list_schedules: "get_invoices_schedule",
    get_list_of_files_folders: "get_medias_files",
    get_object_schema_by_key_id: "get_object_schema",
    list_products: "get_products",
    list_prices_for_product: "get_products_price",
    get_store_settings: "get_store_store_setting",
    list_agents: "list_agent_studio_agent",
    fetch_product_collections: "list_product_collections",
    list_coupons: "list_payments_coupon",
    get_tags: "list_tags",
    create_custom_field: "locations_create_custom_field",
    update_custom_field: "locations_update_custom_field",
    delete_custom_field: "locations_delete_custom_field",
    create_custom_field_custom_fields: "create_custom_field",
    update_custom_field_custom_fields: "update_custom_field",
    delete_custom_field_custom_fields: "delete_custom_field",
    search_agents: "search_conversation_ai_agents",
    search_trigger_links: "search_links",
    search_opportunity: "search_opportunities",
    update_association_by_id: "update_associations",
    bulk_delete_trash_files_or_folders: "update_medias_delete_files",
    bulk_update_files_folders: "update_medias_update_files",
    upload_file_into_media_storage: "upload_media_file",
    get_messages_by_conversation_id: "get_conversations_messages2",
    get_record_by_id: "get_objects_records",
  },
  skip: (method, path) => {
    if (path.startsWith("/oauth/")) return "HighLevel's OAuth token exchange for marketplace apps; a pasted private integration token doesn't use it";
    if (path.startsWith("/marketplace/")) return MARKETPLACE;
    if (/^\/social-media-posting\/oauth\/\{platform\}\/start$/.test(path)) return "opens a sign-in page for a social account in someone's browser; connect social accounts in HighLevel itself";
  },
  after: async () => {
    const file = new URL(`../../${OUT}`, import.meta.url).pathname;
    const out = await Bun.file(file).json();
    for (const a of out.actions) {
      delete a.send.base;
      if (a.send.method === "POST" && READS.has(a.send.path)) a.readOnly = true;
      const p = a.input.properties;
      const req = (f: string) => (a.input.required = (a.input.required ?? []).filter((r: string) => r !== f));
      // every call names its API version in a header; it's fixed per call, so it isn't the agent's to fill
      // (index.ts sends it, and 2021-07-28 for the few calls whose spec forgot it)
      if (p.version) {
        a.version = p.version.enum?.[0] ?? p.version.default;
        delete p.version;
        req("version");
      }
      a.send.headers = a.send.headers.filter(([f]: [string]) => f !== "version");
      // the sub-account: filled from the connection when the agent leaves it out
      for (const f of ["locationId", "location_id", "altId", "altType"]) {
        if (!p[f]) continue;
        req(f);
        p[f].description = `${f === "altType" ? 'Defaults to "location".' : "Defaults to the connected sub-account."} ${p[f].description ?? ""}`.trim();
      }
      if (!a.input.required?.length) delete a.input.required;
      // bodies the spec leaves as an empty object; filled from HighLevel's docs, only while the spec has nothing
      const hand = BODIES[a.name];
      if (hand && a.send.body?.kind === "fields" && !a.send.body.fields.length) {
        Object.assign(p, hand);
        a.send.body.fields = Object.keys(hand).map((k) => [k, k]);
      }
    }
    await Bun.write(file, JSON.stringify(out));
  },
} satisfies AppConfig;
