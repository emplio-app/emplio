// Notion: what the generator (../openapi-actions.ts) can't tell from the spec. Writes the API version the spec is written for to own/notion/version.json.
import type { AppConfig } from "../openapi-actions";
import { composioNames, namer } from "./composio-names";

const VERSION = new URL("../../src/integrations/own/notion/version.json", import.meta.url).pathname;
const OAUTH = "needs the integration's client secret, not a connected token";

export default {
  spec: "https://developers.notion.com/openapi.json",
  out: "src/integrations/own/notion/actions.json",
  name: namer(await composioNames("notion")),
  // sent with every call from version.json, so it isn't an input
  drop: { "*": ["Notion-Version"] },
  skip: { "create-a-token": OAUTH, "revoke-token": OAUTH, "introspect-token": OAUTH },
  // Composio's name for the same call, where the summary doesn't lead to it
  rename: {
    retrieve_token_s_bot_user: "who_am_i",
    retrieve_user: "get_about_user",
    create_page: "create_notion_page",
    retrieve_page_property_item: "get_page_property_action",
    retrieve_page_as_markdown: "get_page_markdown",
    retrieve_block: "fetch_block_metadata",
    retrieve_block_children: "fetch_block_contents",
    update_data_source: "update_schema_database",
    search_by_title: "search_notion_page",
    list_comments: "fetch_comments",
    upload_file: "send_file_upload",
    list_skills_plugins: "list_plugins",
    get_plugin_directory: "get_plugin",
    complete_multi_part_file_upload: "complete_file_upload",
  },
  // POSTs that only look things up (a view query is a short-lived read of the view's results)
  reads: ["query_data_source", "search_notion_page", "query_meeting_notes", "query_agents", "query_sessions", "query_session_events", "create_view_query"],
  after: async (spec) => {
    const version = spec.components.parameters.notionVersion.schema.enum[0];
    await Bun.write(VERSION, `${JSON.stringify({ version })}\n`);
  },
} satisfies AppConfig;
