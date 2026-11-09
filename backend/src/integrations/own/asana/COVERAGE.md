# Asana coverage

Source: Asana's OpenAPI spec (github.com/Asana/openapi: defs/asana_oas.yaml), generated 2026-11-09 by
`bun scripts/openapi-actions.ts asana`. Every operation is an action (270), plus `get_current_user` by hand.

## Deliberately left out

| What | Why |
| --- | --- |
| GET /tables/{table_gid}/getCustomFieldSettings | Marked deprecated by Asana; get_table_s_custom_field_settings replaces it |

Nothing Composio has is missing. Its names are kept (`namer`, `rename` in scripts/openapi/asana.ts); two of its
names are aliases in own/asana/index.ts: `create_attachment_for_task` (= create_attachment_for_object with a task as `parent`)
and `create_project_status_update` (= create_status_for_object with a project as `parent`). Coverage reports 0 unmatched.

## Hand adjustments (scripts/openapi/asana.ts, own/asana/index.ts)

- Asana wraps every body as `{"data": {...}}`. An agent is only shown an action's top-level fields, so `after` lifts the
  fields out of `data` into the action's input (dropping the ones the spec marks readOnly) and lists them in `data` on the
  generated action; index.ts puts them back in the wrapper when it sends.
- `opt_fields`'s enum (over 100 names, per action) is removed for size; its description gives examples. `opt_pretty` dropped.
- Asana's other errors arrive as `{"errors": [...]}` and show as Asana's own text.

## Auth

| Method | Status |
| --- | --- |
| Personal access token (app.asana.com/0/my-apps), Bearer | done |
| OAuth | not in this job |

## Triggers

Webhook per project and connection: `/webhooks/app/asana/<connection>/<project>/<token>`. `project_gid` required. Asana
picks the signing secret and we store none, so the URL holds an HMAC token (see the `ponytail:` note in triggers.ts).
The handshake's `X-Hook-Secret` is echoed through `receive`'s headers.

| Trigger | Event |
| --- | --- |
| task_created | task added under a project (also an existing task moved in) |
| task_updated | task changed; filter `field` |
| task_moved_to_section | task added under a section (also new tasks placed straight in a section); filter `section_gid` |
| task_comment_added | story comment_added |
| task_attachment_added | story attachment_added |
| task_tag_added | story added_to_tag |

Events are skinny, so each mapped event fetches the task once per delivery (a story fetches the story too, for its text).
All take `assignee_gid`. Asana sends no delivery id; ours is connection + project + gid + created_at + action + field + parent.

Not tried live. No real account or token was used.

## Actions by group (* asks first)

**Access requests** (4): get_access_requests, create_access_request*, approve_access_request*, reject_access_request*

**Agents** (2): get_list_of_agents_in_workspace, get_agent

**AI Studio usage API** (2): get_ai_studio_credit_utilization, get_ai_studio_seats

**Allocations** (5): get_allocation, update_allocation*, delete_allocation*, get_allocations, create_allocation*

**Attachments** (4): get_attachment, delete_attachment*, get_task_attachments, create_attachment_for_object*

**Audit log API** (1): get_audit_log_events

**Batch API** (1): submit_parallel_requests*

**Budgets** (5): get_budgets, create_budget*, get_budget, update_budget*, delete_budget*

**Custom field settings** (4): get_project_custom_field_settings, get_portfolio_s_custom_fields, get_goal_s_custom_fields, get_team_s_custom_fields

**Custom fields** (8): create_custom_field*, get_custom_field, update_custom_field*, delete_custom_field*, get_custom_fields_for_workspace, create_enum_option_for_custom_field*, insert_enum_option_for_custom_field*, update_enum_option*

**Custom types** (2): get_custom_types, get_custom_type

**Events** (1): get_events

**Exports** (2): initiate_graph_export*, initiate_resource_export*

**Goal relationships** (5): get_goal_relationship, update_goal_relationship*, get_goal_relationships, add_supporting_relationship*, removes_supporting_goal_relationship*

**Goals** (12): get_goal, update_goal*, delete_goal*, get_goals, create_goal*, create_goal_metric*, update_goal_metric*, add_collaborator_to_goal*, remove_collaborator_from_goal*, get_parent_goals_from_goal, add_custom_field_to_goal*, remove_custom_field_from_goal*

**Jobs** (1): get_job

**Memberships** (5): get_memberships, create_membership*, get_membership, update_membership*, delete_membership*

**Notifications** (3): get_notifications_for_user, mark_notifications_as_read*, mark_notifications_as_unread*

**Ooo entries** (5): get_ooo_entry, update_ooo_entry*, delete_ooo_entry*, get_ooo_entries_for_user, create_ooo_entry*

**Organization exports** (2): create_organization_export_request*, get_details_on_org_export_request

**Portfolio memberships** (3): get_portfolio_memberships, get_portfolio_membership, get_portfolio_memberships_for_portfolio

**Portfolios** (13): get_portfolios, create_portfolio*, get_portfolio, update_portfolio*, delete_portfolio*, get_portfolio_items, add_item_to_portfolio*, remove_item_from_portfolio*, add_custom_field_to_portfolio*, remove_custom_field_from_portfolio*, add_users_to_portfolio*, remove_users_from_portfolio*, duplicate_portfolio*

**Project briefs** (4): get_project_brief, update_project_brief*, delete_project_brief*, create_project_brief*

**Project memberships** (2): get_project_membership, get_project_memberships

**Project portfolio settings** (4): get_project_portfolio_setting, update_project_portfolio_setting*, get_project_portfolio_settings_for_project, get_project_portfolio_settings_for_portfolio

**Project statuses** (4): get_project_status, delete_project_status*, get_project_status_updates, create_project_status*

**Project templates** (5): get_project_template, delete_project_template*, get_project_templates, get_project_templates_for_team, instantiate_project_template*

**Projects** (21): get_multiple_projects, create_a_project*, get_a_project, update_project*, delete_project*, duplicate_project*, get_projects_for_task, get_projects_for_team, create_project_for_team*, get_workspace_projects, create_project_for_workspace*, search_projects_in_workspace, add_custom_field_to_project*, remove_custom_field_from_project*, get_task_counts_for_project, add_members_to_project*, remove_members_for_project*, add_followers_to_project*, remove_followers_for_project*, create_project_template_from_project*, roll_up_subtask_dates_for_project*

**Rates** (5): get_multiple_rates, create_rate*, get_rate, update_rate*, delete_rate*

**Reactions** (1): get_reactions_on_object

**Records** (6): get_records_in_table, search_records_in_workspace, create_record*, get_record, update_record*, delete_record*

**Roles** (5): get_multiple_roles, create_role*, get_role, update_role*, delete_role*

**Rules** (1): trigger_rule*

**Sections** (7): get_section, update_section*, delete_section*, get_sections_in_project, create_section_in_project*, add_task_to_section*, insert_section_for_project*

**Status updates** (4): get_status, delete_status_update*, get_status_updates, create_status_for_object*

**Stories** (9): get_story, update_story*, delete_story*, get_stories_for_task, create_task_comment*, get_stories_from_record, create_story_on_record*, get_stories_from_goal, create_story_on_goal*

**Tables** (8): get_tables_in_workspace, create_table*, get_table, update_table*, delete_table*, add_custom_field_to_table*, remove_custom_field_from_table*, get_table_s_custom_field_settings

**Tags** (8): get_tags, create_tag*, get_tag, update_tag*, delete_tag*, get_tags_for_task, get_tags_for_workspace, create_a_tag_in_a_workspace*

**Task templates** (4): get_task_templates, get_task_template, delete_task_template*, instantiate_task_from_task_template*

**Tasks** (28): get_multiple_tasks, create_a_task*, get_a_task, update_a_task*, delete_task*, duplicate_task*, get_tasks_from_a_project, get_tasks_from_section, get_tasks_for_tag, get_tasks_for_user_task_list, get_task_subtasks, create_subtask*, set_parent_for_task*, list_task_dependencies, add_task_dependencies*, remove_task_dependencies*, list_task_dependents, set_dependents_for_task*, unlink_dependents_from_task*, add_project_for_task*, remove_project_from_task*, add_tag_to_task*, remove_tag_from_task*, add_followers_to_task*, remove_followers_from_task*, roll_up_subtask_dates_for_task*, get_task_for_given_custom_id, search_tasks_in_workspace

**Team memberships** (4): get_team_membership, get_team_memberships, get_team_memberships_for_team, get_team_memberships_for_user

**Teams** (7): create_team*, get_team, update_team*, get_teams_in_workspace, get_teams_for_user, add_user_to_team*, remove_user_for_team*

**Time periods** (2): get_time_period, get_time_periods

**Time tracking categories** (6): get_time_tracking_category, update_time_tracking_category*, delete_time_tracking_category*, get_time_tracking_entries_for_time_tracking_category, get_time_tracking_categories_for_workspace, create_time_tracking_category*

**Time tracking entries** (6): get_time_tracking_entries_for_task, create_time_tracking_entry*, get_time_tracking_entry, update_time_tracking_entry*, delete_time_tracking_entry*, get_time_tracking_entries

**Timesheet approval statuses** (4): get_timesheet_approval_status, update_timesheet_approval_status*, get_multiple_timesheet_approval_statuses, create_timesheet_approval_status*

**Typeahead** (1): get_typeahead_objects

**User task lists** (2): get_user_task_list, get_user_s_task_list

**Users** (8): get_multiple_users, get_user, update_user*, get_favorites_for_user, get_users_for_team, get_users_for_workspace, get_user_for_workspace, update_user_for_workspace*

**Webhooks** (5): get_webhooks, establish_webhook*, get_webhook, update_webhook*, delete_webhook*

**Workspace memberships** (3): get_workspace_membership, get_workspace_memberships_for_user, get_workspace_memberships_for_workspace

**Workspaces** (6): get_multiple_workspaces, get_workspace, update_workspace*, add_user_to_workspace*, remove_user_for_workspace*, get_workspace_events

