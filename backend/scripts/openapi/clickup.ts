// ClickUp: what the generator (../openapi-actions.ts) can't tell from the specs. Two specs make the app: v2 has
// tasks, lists and the rest; v3 has Docs, Chat, permissions and attachments on any object.
import type { AppConfig } from "../openapi-actions";
import { composioNames, namer } from "./composio-names";

export default {
  spec: ["https://developer.clickup.com/openapi/clickup-api-v2-reference.json", "https://developer.clickup.com/openapi/ClickUp_PUBLIC_API_V3.yaml"],
  out: "src/integrations/own/clickup/actions.json",
  name: namer(await composioNames("clickup")),
  rename: {
    get_authorized_workspaces: "get_authorized_teams_workspaces",
    create_group: "create_team",
    get_groups: "get_teams",
    shared_hierarchy: "get_shared_hierarchy",
    get_task_s_time_in_status: "get_task_time_in_status",
    get_time_entries_within_date_range: "get_time_entries_in_date_range",
    get_singular_time_entry: "get_time_entry",
    change_tag_names_from_time_entries: "update_time_entry_tag",
    create_direct_message: "create_direct_message_channel",
    update_message: "update_chat_message",
    update_privacy_and_access_of_object_or_location: "update_workspace_acl",
    create_page: "create_doc_page",
    get_page: "get_doc_page_content",
    edit_page: "click_up_update_doc_page",
    move_task_to_new_list: "move_task_to_home_list",
  },
  skip: {
    GetAccessToken: "swaps an OAuth code for a token with our client secret; a pasted personal token has no use for it",
  },
  // the spec lists Content-Type as a parameter on some calls; call() sets it from the body
  drop: { "*": ["Content-Type"] },
  // answers carry each webhook's signing secret
  secrets: ["get_webhooks"],
  // a POST that only searches the audit log
  reads: ["create_workspace_level_audit_logs"],
} satisfies AppConfig;
