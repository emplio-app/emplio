// Zoom: what the generator (../openapi-actions.ts) can't tell from the spec. Zoom publishes one OpenAPI file per product,
// behind the "Download OpenAPI" button on each page of developers.zoom.us/docs/api/. Our Zoom app is user-managed, and such
// an app can only hold scopes for one person's own data, so an operation that needs an admin scope is left out: it could
// never run. Running this prints the scopes to enter on Zoom's site.
import type { AppConfig } from "../openapi-actions";
import { composioNames, namer } from "./composio-names";

const ZOOM = "https://developers.zoom.us/api/zoap";
const PRODUCTS = ["meetings", "users", "accounts", "chat", "whiteboard", "iq", "marketplace", "calendar", "mail", "scheduler", "tasks", "clips", "canvas", "my-notes", "events", "hub", "quality-management", "phone", "rooms", "video-management"];
// phone and rooms events are nearly all account-level; those that say so are dropped below
const EVENT_PRODUCTS = ["meetings", "users", "chat", "whiteboard", "iq", "calendar", "mail", "scheduler", "tasks", "canvas", "my-notes", "events", "quality-management", "phone", "video-management"];
const NOT_PER_PERSON = /^(account|group|information_barriers)\./;
const EVENTS = new URL("../../src/integrations/own/zoom/events.json", import.meta.url).pathname;

// The one admin call we keep: Composio has a trigger on it. On a user-managed app it answers with an explanation (own/zoom/index.ts)
const KEEP_ADMIN = new Set<string>(["GET /report/daily"]);

type Op = { description?: string; deprecated?: boolean; "x-extensions"?: { "x-granular-scopes"?: string[]; "x-macro-scopes"?: string[] } };
const get = (url: string) => fetch(url).then((r) => r.json()) as Promise<any>;
const specs = await Promise.all(PRODUCTS.map((p) => get(`${ZOOM}/${p}/methods`)));
const personal = (s: string) => !/:(admin|master)$/.test(s);

const skip: Record<string, string> = {};
const files = new Set<string>();
const scopes = new Map<string, Set<string>>();
PRODUCTS.forEach((product, i) => {
  for (const [path, ops] of Object.entries<Record<string, Op>>(specs[i].paths)) {
    for (const [method, op] of Object.entries(ops)) {
      if (!["get", "post", "put", "patch", "delete"].includes(method) || op.deprecated) continue;
      // the spec only says this in prose
      if (op.description?.includes("fileapi.zoom.us")) files.add(path);
      const call = `${method.toUpperCase()} ${path}`;
      const granular = op["x-extensions"]?.["x-granular-scopes"] ?? [];
      const scope = granular.find(personal);
      if (scope) {
        if (!scopes.has(product)) scopes.set(product, new Set());
        scopes.get(product)!.add(scope);
      } else if (!KEEP_ADMIN.has(call)) {
        skip[call] = granular.length ? `needs an admin scope (${granular[0]}), which a user-managed app can't hold` : `has no granular scope (Zoom lists only ${op["x-extensions"]?.["x-macro-scopes"]?.join(", ") ?? "none"}), so an app using granular scopes can't be given it`;
      }
    }
  }
});

// products repeat words ("Get channel" in Team Chat and Phone); the later one takes its product's name
const composio = namer(await composioNames("zoom"));
const used = new Set<string>();
const name: NonNullable<AppConfig["name"]> = (id, method, path, op) => {
  const base = composio(id, method, path, op);
  const tag = String(op.tags?.[0] ?? "other").toLowerCase().replace(/[^a-z0-9]+/g, "_");
  const out = [base, `${tag}_${base}`, `${tag}_${base}_${method.toLowerCase()}`].find((n) => !used.has(n)) ?? `${tag}_${id}_${path.replace(/[^a-z0-9]+/gi, "_")}`;
  used.add(out);
  return out;
};

export default {
  spec: PRODUCTS.map((p) => `${ZOOM}/${p}/methods`),
  out: "src/integrations/own/zoom/actions.json",
  // uploads go to Zoom's file server; Clips' spec leaves /v2 off its server, which only redirects
  server: (path) => (files.has(path) ? "https://fileapi.zoom.us/v2" : path.startsWith("/clips") ? "https://api.zoom.us/v2" : undefined),
  name,
  skip,
  // Composio's names for the same calls, which the summaries don't reach
  rename: {
    share_project_to_new_users: "add_project_collaborators",
    share_whiteboard_to_new_users_or_team_chat_channels: "add_whiteboard_collaborator",
    download_whiteboards_activity_file: "download_whiteboard_session_activity",
    get_whiteboard_export_generation_status: "get_whiteboard_export_status",
    list_whiteboard_sessions_activities: "get_whiteboard_session",
    create_new_whiteboard_by_import: "import_whiteboard",
    get_collaborators_of_project: "list_project_collaborators",
    update_project_basic_information: "update_project",
    update_whiteboard_collaborators: "update_whiteboard_collaborator",
    update_whiteboard_share_setting: "update_whiteboard_share_settings",
    upload_file_for_whiteboard_import: "upload_whiteboard_file",
    delete_meeting_or_webinar_recordings: "delete_meeting_recordings",
    delete_recording_file_for_meeting_or_webinar: "delete_recording_file",
    get_meeting_or_webinar_summary: "get_a_meeting_summary",
    get_meeting_summary_templates: "list_meeting_summary_templates",
    list_user_s_collaboration_devices: "list_users_collaboration_devices",
    get_user_settings: "list_users_settings",
    get_user_s_app_requests: "get_marketplace_user_apps",
    get_user_s_entitlements: "get_marketplace_user_entitlements",
    get_user_s_custom_field_values: "list_marketplace_app_custom_fields",
    validate_app_manifest: "validate_marketplace_app_manifest",
    list_conversations: "list_zra_conversations",
    add_conversation_by_file_id_or_download_url: "create_zra_conversation",
    add_conversation_by_meeting_record_url_or_meeting_uuid: "create_zra_user_conversation",
    delete_conversation_by_conversation_id: "delete_zra_conversation",
    get_conversation_comments: "get_zra_conversation_comments",
    add_new_comments_to_conversation: "create_zra_conversation_comment",
    delete_conversation_s_comment: "delete_zra_conversation_comment",
    edit_conversation_comment: "update_zra_conversation_comment",
    get_conversation_interactions: "get_zra_conversation_interactions",
    get_conversation_scorecards: "get_zra_conversation_scorecards",
    update_conversation_host_id: "update_zra_conversation_host",
    get_user_s_playlist: "list_zra_user_conversation_playlists",
    list_deals: "list_zra_deals",
    get_deal_activities: "get_zra_deal_activities",
    delete_activity_from_deal: "delete_zra_deal_activities",
    list_scheduled_meetings: "list_zra_scheduled",
    get_indicators_settings: "list_zra_settings_indicators",
  },
  reads: ["search_user_s_or_account_s_channels", "query_freebusy_information_for_set_of_calendars", "search_rows", "search_files"],
  // these let whoever holds them start or join as the person
  secrets: ["get_meeting_s_token", "get_webinar_s_token", "get_user_s_token", "get_user_s_zak", "get_meeting_s_join_token_for_local_recording", "get_meeting_s_join_token_for_live_streaming", "get_webinar_s_join_token_for_local_recording", "get_webinar_s_join_token_for_live_streaming", "get_ticket_session_join_token_by_event_id_and_session_id"],
  params: {
    userId: 'The user\'s id or email address, or "me" for the person whose Zoom is connected.',
    meetingId: "The meeting's id: the number in its join link, without spaces.",
    webinarId: "The webinar's id: the number in its join link, without spaces.",
  },
  // everything Zoom can report that one person's sign-in can receive, for triggers.ts
  after: async () => {
    const seen = new Map<string, string>();
    for (const product of EVENT_PRODUCTS) {
      const spec = await get(`${ZOOM}/${product}/events`);
      for (const [raw, ops] of Object.entries<any>(spec.paths)) {
        const event = raw.trim();
        const text: string = ops.post?.description ?? "";
        if (NOT_PER_PERSON.test(event) || /account[- ]level/i.test(text) || ops.post?.deprecated) continue;
        const first = text.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1").replace(/[*`]/g, "").trim().split(/(?<=\.)\s|\n/)[0]!;
        seen.set(event, first.slice(0, 240));
      }
    }
    await Bun.write(EVENTS, JSON.stringify({ events: [...seen].sort().map(([event, description]) => ({ event, description })) }));
    console.log(`${seen.size} events → ${EVENTS}`);
    console.log(`scopes for Zoom's site:\n${JSON.stringify(Object.fromEntries([...scopes].map(([p, s]) => [p, [...s].sort()])))}`);
  },
} satisfies AppConfig;
