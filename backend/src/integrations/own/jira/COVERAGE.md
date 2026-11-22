# Jira coverage

Source: Atlassian's OpenAPI specs for Jira Cloud — the platform REST API v3
(developer.atlassian.com/cloud/jira/platform/swagger-v3.v3.json) and Jira Software
(developer.atlassian.com/cloud/jira/software/swagger.v3.json) — generated 2026-11-22 by
`bun scripts/openapi-actions.ts jira`. 600 operations are actions, plus 6 written by hand and 12 extra
Composio names (aliases) for calls already here. Composio's Jira toolkit (171 tools, 17 triggers) was the benchmark.

## Deliberately left out

| What | Why |
| --- | --- |
| /rest/atlassian-connect, /rest/forge, /rest/api/3/app, /forge, /uiModifications, /webhook (dynamic), Connect select options, Connect workflow rules, JQL function precomputations (48) | Only a Connect or Forge app installed on the site can call them, never a person's API token |
| Development tool data: /rest/devinfo, builds, deployments, featureflags, remotelinks, security, operations, devopscomponents (44) | How a Connect/Forge dev tool feeds Jira; needs that app's own login |
| Deprecated operations (37) | Atlassian marks them deprecated; each has a newer call here (search → search/jql, delete version → delete_and_replace_version, field configurations → field schemes, board/sprint/epic issue lists → the /rest/software enhanced ones). Composio's list_field_configuration_fields and list_field_project_associations are on that retired family |
| Jira Service Management (Composio's service desk, customers, request types, approvals: 6 tools) | A separate product with its own API (/rest/servicedeskapi) and spec; belongs in its own integration |
| Jira Forms (Composio's get/list/delete issue form: 3 tools) | A separate API on api.atlassian.com that needs the site's cloud id and a scoped token |

## Hand adjustments (scripts/openapi/jira.ts, own/jira/index.ts)

- Calls go to the person's own site (https://<site>/...) with basic auth, email:token. Every call carries
  `X-Atlassian-Token: no-check`, which uploads need.
- The two specs share operation ids (getIssue, getConfiguration): the board one is `agile_get_issue`; the other became get_board_configuration.
- add_attachment: the spec lists no fields; files go under `file`.
- A few board query values the spec calls objects (a sprint's `state`) are plain strings.
- create_issue, edit_issue, add_comment, update_comment take plain text for a description or comment body and turn it
  into Atlassian document format (Jira v3 refuses plain strings there).
- By hand, because the generator can't send their bodies: load_issue_type_avatar*, load_project_avatar*, load_avatar*, update_plan*, update_atlassian_team_in_plan*, update_plan_only_team* (a picture as the whole body; JSON Patch).
- Lookups that are POSTs run without asking: searches, counts, bulk fetches, JQL parse/sanitize/match, expression
  evaluation, permission checks, workflow reads and validations (see `reads`).
- Names follow Composio's wherever one means the same call (renames in the script, aliases in index.ts).

## Auth

| Method | Status |
| --- | --- |
| Site + account email + API token (id.atlassian.com/manage-profile/security/api-tokens), pasted on one line, sent as basic auth | done |
| OAuth 2.0 (3LO) | not built, by choice for this run: key sign-in only |

## Triggers

Polled (polls/jira.ts), for anyone, every 5 minutes by default:
issue_created, issue_updated (JQL `created/updated >= -1d`, optional project and extra JQL), comment_created, comment_updated
(comments on issues updated in the last day), sprint_created, sprint_started, sprint_closed, sprint_updated (a board's
sprints), version_created, version_released, version_updated (a project's versions).

Webhook (triggers.ts), because a list can't show what's gone: issue_deleted, comment_deleted, version_deleted,
version_merged, version_moved, version_unreleased. One Jira webhook per connection
(/rest/webhooks/1.0/webhook), made with the first such automation and removed with the last. Jira lets only admins
register webhooks, so these need a Jira admin's login; a non-admin is told so. The URL carries an HMAC token
(Jira's own signing secret isn't settable through this API); `X-Atlassian-Webhook-Identifier` is the delivery id.

Not tried live: no Jira account was used. All of the above is tested with fetch faked.

## Actions by group (* asks first)

**Agents** (2): bulk_start_agent_sessions_batch*, bulk_start_agent_sessions_uniform*

**Announcement banner** (2): get_announcement_banner_configuration, update_announcement_banner_configuration*

**Jira settings** (4): get_application_property, get_advanced_settings, set_application_property*, get_global_settings

**Application roles** (2): get_application_roles, get_application_role

**Issue attachments** (8): get_attachment_content, get_attachment_meta, get_attachment_thumbnail, delete_attachment*, get_attachment, get_metadata_for_expanded_attachment, get_contents_metadata_for_expanded_attachment, add_attachment*

**Audit records** (1): get_audit_records

**Avatars** (6): get_system_avatars, get_universal_avatar_type_owner, delete_avatar*, get_universal_avatar_view_type, get_view_type_avatar, get_avatar_image_by_owner

**Issue bulk operations** (9): bulk_delete_issues*, get_bulk_editable_fields, bulk_edit_issues*, bulk_move_issues*, get_available_transitions, bulk_transition_issue_statuses*, bulk_unwatch_issues*, bulk_watch_issues*, get_bulk_operation_status

**Issues** (23): bulk_fetch_issue_changelogs, get_events, create_issue*, archive_issue_s_by_jql*, archive_issue_s_by_issue_id_key*, bulk_create_issue*, fetch_bulk_issues, get_issue_create_metadata, get_create_metadata_issue_type_fields, get_issue_adf_limit_report, get_issue_limit_report, unarchive_issue_s_by_issue_keys_id*, delete_issue*, get_issue, edit_issue*, assign_issue*, get_issue_changelogs, get_changelogs_by_ids, get_issue_edit_metadata, send_notification_for_issue*, get_transitions, transition_issue*, export_archived_issue_s*

**Classification levels** (1): get_classification_levels

**Issue comments** (6): get_comments_by_ids, list_issue_comments, add_comment*, delete_comment*, get_comment, update_comment*

**Issue comment properties** (4): get_comment_property_keys, delete_comment_property*, get_comment_property, set_comment_property*

**Project components** (8): find_components_for_projects, create_component*, delete_component*, get_component, update_component*, get_component_issues_count, get_project_components_paginated, get_project_components

**Field schemes** (15): get_field_schemes, create_field_scheme*, remove_fields_associated_with_field_schemes*, update_fields_associated_with_field_schemes*, remove_field_parameters*, update_field_parameters*, get_projects_with_field_schemes, associate_projects_to_field_schemes*, delete_field_scheme*, get_field_scheme, update_field_scheme*, clone_field_scheme*, list_field_scheme_fields, get_field_parameters, search_field_scheme_projects

**Time tracking** (5): get_selected_time_tracking_provider, select_time_tracking_provider*, get_time_tracking_providers, get_time_tracking_settings, set_time_tracking_settings*

**Issue custom field options** (7): get_custom_field_option, list_custom_field_context_options, create_custom_field_context_options*, update_custom_field_options_context*, reorder_custom_field_options_context*, delete_custom_field_options_context*, replace_custom_field_options*

**Dashboards** (17): get_dashboards, create_dashboard*, bulk_edit_dashboards*, get_available_gadgets, search_dashboards, list_dashboard_gadgets, add_gadget_to_dashboard*, remove_gadget_from_dashboard*, update_gadget_on_dashboard*, get_dashboard_item_properties, delete_dashboard_item_property*, get_dashboard_item_property, set_dashboard_item_property*, delete_dashboard*, get_dashboard, update_dashboard*, copy_dashboard*

**App data policies** (2): get_data_policy_for_workspace, get_data_policy_for_projects

**Jira expressions** (2): analyse_expression, evaluate_jira_expression

**Issue fields** (10): get_fields, create_custom_field*, get_fields_paginated, get_fields_in_trash_paginated, update_custom_field*, get_field_project_associations, delete_custom_field*, restore_custom_field_from_trash*, move_custom_field_to_trash*, get_fields_for_projects

**Issue custom field associations** (2): remove_associations*, create_associations*

**Issue custom field contexts** (13): list_custom_field_contexts, create_custom_field_context*, list_custom_field_context_default_values, set_default_values_for_custom_field_by_context_and_issue_type*, list_custom_field_context_issue_type_mappings, get_custom_field_contexts_for_projects_and_issue_types, list_custom_field_context_project_mappings, delete_custom_field_context*, update_custom_field_context*, add_issue_types_to_context*, remove_issue_types_from_context*, assign_custom_field_context_projects*, remove_custom_field_context_from_projects*

**Screens** (7): get_screens_for_field, list_screens, create_screen*, add_field_to_default_screen*, delete_screen*, update_screen*, get_available_screen_fields

**Filters** (13): create_filter*, get_favorite_filters, get_my_filters, list_filters, delete_filter*, get_filter, update_filter*, reset_columns*, get_columns, set_columns*, remove_filter_as_favorite*, add_filter_as_favorite*, change_filter_owner*

**Filter sharing** (6): get_default_share_scope, set_default_share_scope*, get_share_permissions, add_share_permission*, delete_share_permission*, get_share_permission

**Groups** (7): remove_group*, create_group*, bulk_get_groups, list_group_members, remove_user_from_group*, add_user_to_group*, get_all_groups

**Group and user picker** (1): find_users_and_groups

**License metrics** (3): get_license, get_approximate_license_count, get_approximate_application_license_count

**JQL** (7): get_invalid_jql_searches, get_jql_autocompletedata, create_jql_autocompletedata, get_jql_autocompletedata_suggestions, parse_jql_queries, convert_user_identifiers_to_account_ids_in_jql_queries, sanitize_jql_queries

**Issue search** (5): get_issue_picker_suggestions, check_issues_against_jql, search_approximate_count, search_for_issues_using_jql_get, search_for_issues_using_jql_post

**Issue properties** (8): bulk_set_issues_properties_by_list*, bulk_set_issue_properties_by_issue*, bulk_delete_issue_property*, bulk_set_issue_property*, list_issue_property_keys, delete_issue_property*, get_issue_property, set_issue_property*

**Issue watchers** (4): get_is_watching_issue_bulk, remove_watcher_from_issue*, get_issue_watchers, add_watcher_to_issue*

**Issue remote links** (6): delete_remote_issue_link_by_global_id*, get_remote_issue_links, create_or_update_remote_issue_link*, delete_remote_issue_link_by_id*, get_remote_issue_link_by_id, update_remote_issue_link_by_id*

**Issue votes** (3): delete_vote*, get_votes, add_vote*

**Issue worklogs** (10): bulk_delete_worklogs*, get_issue_worklogs, add_worklog*, bulk_move_worklogs*, delete_worklog*, get_worklog, update_worklog*, get_ids_of_deleted_worklogs, get_worklogs_by_ids, list_updated_worklogs

**Issue worklog properties** (4): get_worklog_property_keys, delete_worklog_property*, get_worklog_property, set_worklog_property*

**Issue links** (3): create_issue_link*, delete_issue_link*, get_issue_link

**Issue link types** (5): get_issue_link_types, create_issue_link_type*, delete_issue_link_type*, get_issue_link_type, update_issue_link_type*

**Issue security schemes** (16): get_issue_security_schemes, create_issue_security_scheme*, get_issue_security_levels, set_default_issue_security_levels*, get_issue_security_level_members, get_projects_using_issue_security_schemes, associate_security_scheme_to_project*, search_issue_security_schemes, get_issue_security_scheme, update_issue_security_scheme*, delete_issue_security_scheme*, add_issue_security_levels*, remove_issue_security_level*, update_issue_security_level*, add_issue_security_level_members*, remove_member_from_issue_security_level*

**Issue security level** (2): get_issue_security_level_members_by_issue_security_scheme, get_issue_security_level

**Issue types** (7): get_issue_types_for_user, create_issue_type*, get_issue_types_for_project, delete_issue_type*, get_issue_type, update_issue_type*, get_alternative_issue_types

**Issue type properties** (4): get_issue_type_property_keys, delete_issue_type_property*, get_issue_type_property, set_issue_type_property*

**Issue type schemes** (10): get_all_issue_type_schemes, create_issue_type_scheme*, get_issue_type_scheme_items, list_project_issue_type_schemes, assign_issue_type_scheme_to_project*, delete_issue_type_scheme*, update_issue_type_scheme*, add_issue_types_to_issue_type_scheme*, change_order_of_issue_types*, remove_issue_type_from_issue_type_scheme*

**Issue type screen schemes** (11): get_issue_type_screen_schemes, create_issue_type_screen_scheme*, list_issue_type_screen_scheme_mappings, get_issue_type_screen_schemes_for_projects, assign_issue_type_screen_scheme_to_project*, delete_issue_type_screen_scheme*, update_issue_type_screen_scheme*, append_mappings_to_issue_type_screen_scheme*, update_issue_type_screen_scheme_default_screen_scheme*, remove_mappings_from_issue_type_screen_scheme*, get_issue_type_screen_scheme_projects

**Labels** (1): get_labels

**Permissions** (4): get_my_permissions, get_permissions, check_permissions, get_permitted_projects

**Myself** (5): delete_preference*, get_preference, set_preference*, get_mypreferences_locale, get_current_user

**Issue notification schemes** (8): get_notification_schemes_paginated, create_notification_scheme*, get_projects_using_notification_schemes_paginated, get_notification_scheme, update_notification_scheme*, add_notifications_to_notification_scheme*, delete_notification_scheme*, remove_notification_from_notification_scheme*

**Permission schemes** (9): get_permission_schemes, create_permission_scheme*, delete_permission_scheme*, get_permission_scheme, update_permission_scheme*, get_permission_scheme_grants, create_permission_grant*, delete_permission_scheme_grant*, get_permission_scheme_grant

**Plans** (6): get_plans_paginated, create_plan*, get_plan, archive_plan*, duplicate_plan*, trash_plan*

**Teams in plan** (7): get_teams_in_plan_paginated, add_atlassian_team_to_plan*, remove_atlassian_team_from_plan*, get_atlassian_team_in_plan, create_plan_only_team*, delete_plan_only_team*, get_plan_only_team

**Policies** (7): get_policies, get_project_policy_state, set_policies_applied_to_project*, get_project_policy_rules, validate_policy_application_to_project, apply_policy_to_projects*, remove_policy_from_projects*

**Issue priorities** (7): create_priority*, set_default_priority*, move_priorities*, list_priorities, delete_priority*, get_priority, update_priority*

**Priority schemes** (8): get_priority_schemes, create_priority_scheme*, suggested_priorities_for_mappings*, get_available_priorities_by_priority_scheme, delete_priority_scheme*, update_priority_scheme*, get_priorities_by_priority_scheme, get_projects_by_priority_scheme

**Projects** (12): create_project*, get_recent_projects, get_projects_paginated, delete_project*, get_project, update_project*, archive_project*, delete_project_asynchronously*, restore_deleted_or_archived_project*, get_all_statuses, get_project_issue_type_hierarchy, get_project_notification_scheme

**Project templates** (5): create_custom_project*, edit_custom_project_template*, gets_custom_project_template, deletes_custom_project_template*, save_custom_project_template*

**Project types** (4): list_project_types, get_licensed_project_types, get_project_type_by_key, get_accessible_project_type_by_key

**Project avatars** (3): set_project_avatar*, delete_project_avatar*, get_project_avatars

**Project classification levels** (4): get_classification_configuration_for_project, remove_default_data_classification_level_from_project*, get_default_data_classification_level_of_project, update_default_data_classification_level_of_project*

**Project features** (2): get_project_features, set_project_feature_state*

**Project properties** (4): get_project_property_keys, delete_project_property*, get_project_property, set_project_property*

**Project roles** (9): get_project_roles, get_project_role_for_project, get_project_role_details, get_all_project_roles, create_project_role*, delete_project_role*, get_project_role_by_id, partial_update_project_role*, fully_update_project_role*

**Project role actors** (6): remove_user_from_project_role*, add_users_to_project_role*, set_actors_for_project_role*, delete_default_actors_from_project_role*, get_default_actors_for_project_role, add_default_actors_to_project_role*

**Project versions** (14): list_project_versions_paginated, get_project_versions, create_version*, get_version, update_version*, merge_versions*, move_version*, get_version_s_related_issues_count, get_related_work, create_related_work*, update_related_work*, delete_and_replace_version*, get_version_s_unresolved_issues_count, delete_related_work*

**Project email** (2): get_project_s_sender_email, set_project_s_sender_email*

**Project permission schemes** (4): get_project_issue_security_scheme, get_project_permission_scheme, assign_permission_scheme*, get_project_issue_security_levels

**Project categories** (5): get_project_categories, create_project_category*, delete_project_category*, get_project_category_by_id, update_project_category*

**Project key and name validation** (3): validate_project_key, get_valid_project_key, get_valid_project_name

**Issue redaction** (2): redact*, get_redaction_status

**Issue resolutions** (7): create_resolution*, set_default_resolution*, move_resolutions*, get_issue_resolutions, delete_resolution*, get_resolution, update_resolution*

**Screen tabs** (6): get_bulk_screen_tabs, list_screen_tabs, create_screen_tab*, delete_screen_tab*, update_screen_tab*, move_screen_tab*

**Screen tab fields** (4): list_screen_tab_fields, add_field_to_screen_tab*, remove_field_from_screen_tab*, move_screen_tab_field*

**Screen schemes** (4): list_screen_schemes, create_screen_scheme*, delete_screen_scheme*, update_screen_scheme*

**Server info** (1): get_server_info

**Issue navigator settings** (2): get_issue_navigator_default_columns, set_issue_navigator_default_columns*

**Workflow statuses** (2): get_statuses, get_status

**Workflow status categories** (2): get_status_categories, get_status_category

**Status** (9): delete_statuses*, bulk_get_statuses, bulk_create_statuses*, bulk_update_statuses*, bulk_get_statuses_by_name, search_statuses_paginated, get_issue_type_usages_by_status_and_project, get_project_usages_by_status, get_workflow_usages_by_status

**Tasks** (2): get_task, cancel_task*

**Users** (13): delete_user*, get_user, create_user*, bulk_get_users, get_account_ids_for_users, reset_user_default_columns*, get_user_default_columns, set_user_default_columns*, get_user_email, get_user_email_bulk, get_user_groups, get_users_default, get_all_users

**User search** (8): find_users_assignable_to_projects, find_users_assignable_to_issues, find_users_with_permissions, find_users_for_picker, find_users, find_users_by_query, find_user_keys_by_query, find_users_with_browse_permission

**User properties** (4): get_user_property_keys, delete_user_property*, get_user_property, set_user_property*

**Workflows** (16): read_workflow_version_from_history, list_workflow_history_entries, delete_inactive_workflow*, get_issue_types_in_project_that_are_using_given_workflow, get_projects_using_given_workflow, get_workflow_schemes_which_are_using_given_workflow, bulk_get_workflows, get_available_workflow_capabilities, copy_workflow*, bulk_create_workflows*, validate_create_workflows, get_user_s_default_workflow_editor, preview_workflow, search_workflows, bulk_update_workflows*, validate_update_workflows

**Workflow schemes** (19): get_workflow_schemes, create_workflow_scheme*, switch_workflow_scheme_for_project*, bulk_get_workflow_schemes, update_workflow_scheme*, get_required_status_mappings_for_workflow_scheme_update, delete_workflow_scheme*, get_workflow_scheme, classic_update_workflow_scheme*, delete_default_workflow*, get_default_workflow, update_default_workflow*, delete_workflow_for_issue_type_in_workflow_scheme*, get_workflow_for_issue_type_in_workflow_scheme, set_workflow_for_issue_type_in_workflow_scheme*, delete_issue_types_for_workflow_in_workflow_scheme*, get_issue_types_for_workflows_in_workflow_scheme, update_workflow_mapping*, get_projects_which_are_using_given_workflow_scheme

**Workflow scheme project associations** (2): get_project_workflow_schemes, assign_workflow_scheme_to_project*

**Workflow scheme drafts** (14): create_draft_workflow_scheme*, delete_draft_workflow_scheme*, get_draft_workflow_scheme, update_draft_workflow_scheme*, delete_draft_default_workflow*, get_draft_default_workflow, update_draft_default_workflow*, delete_workflow_for_issue_type_in_draft_workflow_scheme*, get_workflow_for_issue_type_in_draft_workflow_scheme, set_workflow_for_issue_type_in_draft_workflow_scheme*, publish_draft_workflow_scheme*, delete_issue_types_for_workflow_in_draft_workflow_scheme*, get_issue_types_for_workflows_in_draft_workflow_scheme, set_issue_types_for_workflow_in_workflow_scheme*

**Backlog** (2): move_issues_to_backlog*, move_issues_to_backlog_for_board*

**Board** (28): list_boards, create_board*, get_board_by_filter_id, delete_board*, get_board, get_issues_for_backlog_enhanced, get_approximate_issue_count_for_backlog, get_board_configuration, get_epics, get_issues_without_epic_for_board_enhanced, get_board_issues_for_epic_enhanced, get_features_for_board, toggle_features*, move_issues_to_board*, get_issues_for_board_enhanced, get_approximate_issue_count_for_board, get_all_projects, get_projects_full, get_board_property_keys, delete_board_property*, get_board_property, set_board_property*, list_board_quick_filters, get_quick_filter, get_reports_for_board, list_sprints, get_board_issues_for_sprint_enhanced, get_versions

**Epic** (7): remove_issues_from_epic*, get_issues_without_epic_enhanced, get_epic, partially_update_epic*, move_issues_to_epic*, get_issues_for_epic_enhanced, rank_epics*

**Issue** (4): rank_issues*, agile_get_issue, get_issue_estimation_for_board, estimate_issue_for_board*

**Sprint** (12): create_sprint*, delete_sprint*, get_sprint, partially_update_sprint*, update_sprint*, move_issue_to_sprint*, get_issues_for_sprint_enhanced, get_properties_keys, delete_property*, get_property, set_property*, swap_sprint*

**hand-written** (6): load_issue_type_avatar*, load_project_avatar*, load_avatar*, update_plan*, update_atlassian_team_in_plan*, update_plan_only_team*

**aliases** (12): list_comments, search_issues, who_am_i, get_info, get_project_type, find_users2, list_all_projects, list_assignable_users, list_groups_picker, get_group, get_project_templates, delete_version*
