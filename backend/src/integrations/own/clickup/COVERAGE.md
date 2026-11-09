# ClickUp coverage

Source: ClickUp's OpenAPI specs, generated 2026-11-09 by `bun scripts/openapi-actions.ts clickup`:
developer.clickup.com/openapi/clickup-api-v2-reference.json (tasks, lists, spaces...) and
developer.clickup.com/openapi/ClickUp_PUBLIC_API_V3.yaml (Docs, Chat, permissions, attachments). Every operation
is an action (172) but one.

## Deliberately left out

| What | Why |
| --- | --- |
| POST /v2/oauth/token (GetAccessToken) | Swaps an OAuth code for a token with a client secret; a pasted personal token has no use for it |

## Composio names with no action of the same name

| Composio | Ours |
| --- | --- |
| get_access_token | left out, above |
| create_list_from_template | create_list_from_template_in_folder or _in_space: the two places a list can go |
| get_doc_content | get_doc_pages_public (with content_format) returns the pages and their content |

`authorization_get_work_space_list` and `attachments_upload_file_to_task_as_attachment` are aliases in own/clickup/index.ts.

## Hand adjustments (scripts/openapi/clickup.ts, own/clickup/index.ts)

- Auth is `Authorization: <token>`, no Bearer.
- A 401 "Team not authorized" means this token can't see one Workspace; it doesn't mark the login as dead (`deadToken`).
- `Content-Type` listed as a parameter on some calls is dropped; call() sets it.
- `get_webhooks` asks first: its answers carry signing secrets. `create_workspace_level_audit_logs` is a POST that only reads, so it runs unasked.
- The generator's `resolve` now decodes JSON-pointer escapes (`~1`), which this spec's refs use.

## Auth

| Method | Status |
| --- | --- |
| Personal API token (Settings → Apps), sent bare | done |
| OAuth | not in this job |

## Triggers

Webhook per Workspace and connection: `/webhooks/app/clickup/<connection>/<team>/<token>`. `team_id` required. ClickUp
picks the signing secret and we store none, so the URL holds an HMAC token (see the `ponytail:` note in triggers.ts).
Every event ClickUp has (28) is a trigger: Composio's 21, plus task_moved and the goal and key result events.
Filters read from the payload: `list_id` (a task's list is its history entry's parent), `task_id`, `folder_id`, `space_id`,
`goal_id`, `key_result_id`.

Delivery id: the history entry when there is one (with the event and connection); otherwise only creates and deletes get an
id, so an update with no history may run twice on a retry.

Not tried live. No real account or token was used.

## Actions by group (* asks first)

**Attachments** (3): create_task_attachment*, get_attachments, create_attachment*

**Authorization** (1): get_authorized_user

**Workspaces** (3): get_authorized_teams_workspaces, get_workspace_seats, get_workspace_plan

**Task Checklists** (6): create_checklist*, update_checklist*, delete_checklist*, create_checklist_item*, update_checklist_item*, delete_checklist_item*

**Comments** (11): get_task_comments, create_task_comment*, get_chat_view_comments, create_chat_view_comment*, get_list_comments, create_list_comment*, update_comment*, delete_comment*, get_threaded_comments, create_threaded_comment*, get_subtypes

**Custom Fields** (6): get_accessible_custom_fields, get_folder_available_fields, get_space_available_fields, get_team_available_fields, set_custom_field_value*, remove_custom_field_value*

**Task Relationships** (4): add_dependency*, delete_dependency*, add_task_link*, delete_task_link*

**Folders** (7): get_folders, create_folder*, get_folder, update_folder*, delete_folder*, move_folder*, create_folder_from_template*

**Goals** (8): get_goals, create_goal*, get_goal, update_goal*, delete_goal*, create_key_result*, update_key_result*, delete_key_result*

**Guests** (10): invite_guest_to_workspace*, get_guest, update_guest_on_workspace*, remove_guest_from_workspace*, add_guest_to_task*, remove_guest_from_task*, add_guest_to_list*, remove_guest_from_list*, add_guest_to_folder*, remove_guest_from_folder*

**Lists** (11): get_lists, create_list*, get_folderless_lists, create_folderless_list*, get_list, update_list*, delete_list*, add_task_to_list*, remove_task_from_list*, create_list_from_template_in_folder*, create_list_from_template_in_space*

**Members** (2): get_task_members, get_list_members

**Roles** (1): get_custom_roles

**Shared Hierarchy** (1): get_shared_hierarchy

**Spaces** (5): get_spaces, create_space*, get_space, update_space*, delete_space*

**Tags** (6): get_space_tags, create_space_tag*, update_space_tag*, delete_space_tag*, add_tag_to_task*, remove_tag_from_task*

**Tasks** (13): get_tasks, create_task*, get_task, update_task*, delete_task*, get_filtered_team_tasks, merge_tasks*, get_task_time_in_status, get_bulk_tasks_time_in_status, create_task_from_template*, move_task_to_home_list*, update_task_time_estimates_by_user*, replace_task_time_estimates*

**Templates** (3): get_task_templates, get_list_templates, get_folder_templates

**User Groups** (4): create_team*, update_team*, delete_team*, get_teams

**Custom Task Types** (1): get_custom_task_types

**Time Tracking (Legacy)** (4): get_tracked_time, track_time*, update_time_tracked*, delete_time_tracked*

**Time Tracking** (13): get_time_entries_in_date_range, create_a_time_entry*, get_time_entry, delete_time_entry*, update_time_entry*, get_time_entry_history, get_running_time_entry, remove_tags_from_time_entries*, get_all_tags_from_time_entries, add_tags_to_time_entries*, update_time_entry_tag*, start_time_entry*, stop_time_entry*

**Users** (4): invite_user_to_workspace*, get_user, update_user_on_workspace*, remove_user_from_workspace*

**Views** (12): get_workspace_everything_level_views, create_workspace_everything_level_view*, get_space_views, create_space_view*, get_folder_views, create_folder_view*, get_list_views, create_list_view*, get_view, update_view*, delete_view*, get_view_tasks

**Webhooks** (4): get_webhooks*, create_webhook*, update_webhook*, delete_webhook*

**Chat** (19): get_chat_channels, create_chat_channel*, create_location_chat_channel*, create_direct_message_channel*, get_chat_channel, update_chat_channel*, delete_chat_channel*, get_chat_channel_followers, get_chat_channel_members, get_chat_messages, create_chat_message*, update_chat_message*, delete_chat_message*, get_chat_message_reactions, create_chat_reaction*, delete_chat_reaction*, get_chat_message_replies, create_reply_message*, get_chat_message_tagged_users

**Acls** (1): update_workspace_acl*

**Auditlogs** (1): create_workspace_level_audit_logs

**Docs** (8): search_docs, create_doc*, get_doc, get_doc_page_listing, get_doc_pages_public, create_doc_page*, get_doc_page_content, click_up_update_doc_page*

