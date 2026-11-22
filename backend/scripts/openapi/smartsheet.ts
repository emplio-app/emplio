// Smartsheet: what the generator (../openapi-actions.ts) can't tell from the spec. The spec is Smartsheet's own, from
// developers.smartsheet.com (OpenAPI 3.0, every operation of API 2.0).
import type { AppConfig } from "../openapi-actions";
import { composioNames, namer } from "./composio-names";

export default {
  spec: "https://developers.smartsheet.com/_spec/api/smartsheet/openapi.yaml",
  out: "src/integrations/own/smartsheet/actions.json",
  name: namer(await composioNames("smartsheet")),
  // Composio's names for the same calls, so saved automations carry over
  rename: {
    get_favorites: "list_favorites",
    is_favorite: "check_favorite",
    create_folder: "create_folder_in_folder",
    list_image_urls: "get_image_urls",
    send_report_via_email: "send_report_by_email",
    gets_report_s_publish_settings: "get_report_publish_status",
    set_report_s_publish_status: "set_report_publish_status",
    gets_application_constants: "get_server_info",
    list_attachments: "list_sheet_attachments",
    attach_file_or_url_to_sheet: "attach_to_sheet",
    list_versions: "list_attachment_versions",
    attach_new_version: "add_attachment_version",
    delete_versions: "delete_attachment_versions",
    attach_file_or_url_to_comment: "attach_to_comment",
    list_discussions: "list_sheet_discussions",
    create_discussion: "create_sheet_discussion",
    create_comment: "create_discussion_comment",
    send_sheet_via_email: "send_sheet_by_email",
    attach_file_to_proof: "attach_to_proof",
    send_rows_via_email: "send_rows_by_email",
    attach_file_or_url_to_row: "attach_to_row",
    lists_sent_update_requests: "list_sent_update_requests",
    add_image_to_sheet_summary: "add_summary_field_image",
    reset_shared_secret: "reset_webhook_shared_secret",
    // GET /summary is the whole summary, GET /summary/fields its fields page by page
    list_summary_fields: "get_sheet_summary",
    get_summary_fields: "list_summary_fields",
  },
  skip: {
    "tokens-getOrRefresh": "trades an OAuth code or refresh token for an access token; Emplio connects with an API access token",
    "tokens-delete": "revokes the very token Emplio is connected with, which would break the connection; disconnect in Emplio instead",
  },
  // POSTs that only look things up
  reads: ["list_filtered_events", "get_image_urls"],
  // the webhook list and a webhook hand back its shared secret
  secrets: ["list_webhooks", "get_webhook"],
  // the token is sent by Emplio, the rest are internal or set by the upload itself (own/smartsheet/index.ts)
  drop: { "*": ["Authorization", "smartsheet-integration-source", "x-smar-sc-actor-id", "Accept-Encoding", "Content-Type", "Content-Disposition"] },
  // the rows body is the one most calls need, and the spec leaves it as "The request body"
  after: async () => {
    const file = new URL("../../src/integrations/own/smartsheet/actions.json", import.meta.url).pathname;
    const out = await Bun.file(file).json();
    const ROWS = 'One row or a list of rows. Each row has its cells as [{"columnId": <id from list_columns>, "value": "..."}]. Adding: also say where, like {"toBottom": true} or {"parentId": <row id>}. Updating: each row needs its "id".';
    for (const a of out.actions) {
      if (["add_rows", "update_rows"].includes(a.name)) a.input.properties.body.description = ROWS;
      // a parameter's default is Smartsheet's own, so it's said rather than sent; sending includeAll=false with page=1 on every call surprises
      for (const p of Object.values<Record<string, any>>(a.input.properties)) {
        if (p.default === undefined) continue;
        p.description = `${p.description ?? ""} (default ${JSON.stringify(p.default)})`.trim();
        delete p.default;
      }
    }
    await Bun.write(file, JSON.stringify(out));
  },
} satisfies AppConfig;
