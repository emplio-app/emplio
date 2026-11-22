# monday.com coverage

Source: monday.com's published GraphQL schema (api.monday.com/v2/get_schema, API version 2026-10), read 2026-11-22 by
`bun scripts/openapi/monday.ts`, which writes actions.json. Every query and mutation is an action (334: the `search`
and `notetaker` queries are split into one action per part), plus 10 by hand and 32 Composio names. 376 in all.

## Deliberately left out

| What | Why |
| --- | --- |
| app_subscription, app_subscription_operations | Answer only for an app's own token, about the account that installed it |
| set_mock_app_subscription, remove_mock_app_subscription, increase_app_subscription_operations | An app's own token only (testing a paid app) |
| empty | A placeholder in monday's schema that does nothing |
| add_subscribers_to_board | Deprecated by monday; add_users_to_board replaces it (and answers to the old name) |
| mutation complexity | Only means something next to another mutation in the same call; the complexity query and `graphql` cover it |

Composio names with no matching call in monday's API, so no action: archive_workspace, delete_asset, delete_tag,
update_tag, update_team, query_dashboards (monday has none of these; a file column is cleared with change_column_value,
dashboards are made and changed with create_dashboard / update_dashboard), create_item_from_nl (Emplio writes the
item itself), update_doc (update_doc_name, update_doc_block, create_doc_blocks and add_content_to_doc_from_markdown
cover it). Coverage reports these 8 and nothing else.

## Hand adjustments

- Each action sends a typed GraphQL operation with only the arguments given, so monday's defaults apply.
- What comes back: every value of the returned type and one level into the objects it points at (wrappers like
  `{results: [...]}` don't count as a level; union fields that clash between kinds are left out). Item, Board, User,
  Update, Reply and Asset have a hand-picked set (an item's column values, a board's columns and groups). Every
  action takes `fields` to ask for something else in GraphQL. All 334 generated operations validate against the schema.
- JSON arguments (column_values…) take an object and are sent as the JSON text monday wants.
- File arguments (add_file_to_column, add_file_to_update) go to /v2/file as multipart, monday's upload route.
- `service_user_tokens` hands back tokens, so it asks first.
- By hand: `graphql` (any query or mutation, asks first), `download_asset` (a file comes back as a file),
  `list_board_items` (a board's items with column values; next_items_page for more), `list_columns`, `list_groups`,
  `get_board_views`, `get_activity_logs`, `list_subitems_by_parent`, `list_team_members`, `blocks` (a doc's content).
- Errors: monday answers most with a 200 and `{"errors": [...]}`; they show in its words. A 401 means the token is dead.
- `API-Version: 2026-10` is sent on every call. When monday retires it, run the script with the new version.

## Auth

| Method | Status |
| --- | --- |
| Personal API token (picture → Developers → My access tokens), `Authorization: <token>` | done |
| OAuth | not in this job |

## Triggers

Webhook per connection, board and event (a monday webhook is one board and one event):
`/webhooks/app/monday/<connection>/<board>/<event>/<token>`. Personal-token webhooks aren't signed, so the URL holds an
HMAC token (see the `ponytail:` notes in triggers.ts). monday's challenge is echoed through `receive`'s reply. monday
doesn't list a webhook's URL, so ours are told apart by board, event and no settings; the ceiling is in triggers.ts.
Only config-free events are used; the column and group filters are applied by Emplio (`wanted`). No polled triggers:
everything comes by webhook. All take `board_id` (for subitems, the main board's).

| Trigger | monday event | Filters |
| --- | --- | --- |
| item_created | create_item | group_id |
| item_column_value_updated | change_column_value (status columns too) | column_id, group_id |
| item_name_updated | change_name | |
| item_moved_to_group | item_moved_to_any_group | group_id (the group moved into) |
| item_archived / item_deleted / item_restored | item_archived / item_deleted / item_restored | |
| item_update_posted | create_update without replyId | |
| item_update_reply_posted | create_update with replyId | |
| item_update_edited / item_update_deleted | edit_update / delete_update | |
| column_created | create_column | |
| subitem_created / subitem_name_updated / subitem_moved | create_subitem / change_subitem_name / move_subitem | |
| subitem_column_value_updated | change_subitem_column_value | column_id |
| subitem_archived / subitem_deleted | subitem_archived / subitem_deleted | |
| subitem_update_posted | create_subitem_update | |

All 17 of Composio's are here, under its names; item_restored and subitem_moved are extra. The delivery id is
connection + board + event + item, update, reply, column and time (monday's triggerUuid isn't documented as per event).

Not tried live. No real account or token was used.

## Actions by group (* asks first)

**Forms** (13): form, update_form*, update_form_settings*, create_form_question*, update_form_question*, delete_question*, activate_form*, deactivate_form*, shorten_form_url*, create_form_tag*, delete_form_tag*, create_form*, set_form_password*

**Webhooks** (3): webhooks, create_webhook*, delete_webhook*

**Automations, integrations and sequences** (16): board_automations, connections, user_connections, account_connections, connection, connection_board_ids, allowed_sequences_to_enroll, trigger_events, trigger_event, block_events, tool_events, account_trigger_statistics, account_triggers_statistics_by_entity_id, execute_integration_block*, delete_board_automation*, enroll_items_to_sequence*

**Dashboards and widgets** (6): all_widgets_schema, create_widget*, delete_widget*, create_dashboard*, update_dashboard*, delete_dashboard*

**Time off, schedules and resources** (23): get_directory_resources, work_schedules, time_offs, resources_availability, account_availability_defaults, user_pto, update_directory_resources_attributes*, create_work_schedule*, update_work_schedule*, delete_work_schedule*, assign_work_schedule*, unassign_work_schedule*, create_time_off*, update_time_off*, delete_time_off*, assign_time_off*, unassign_time_off*, create_time_off_entry*, update_time_off_entry*, delete_time_off_entry*, create_pto_entry*, update_pto_entry*, delete_pto_entry*

**Docs and articles** (25): search_docs, ask_developer_docs, article_blocks, articles, doc_version_diff, doc_version_history, export_markdown_from_doc, docs, configure_open_block_ai_column*, add_content_to_doc_from_markdown*, create_article*, create_doc_blocks*, delete_article*, delete_doc*, delete_doc_blocks*, duplicate_doc*, import_doc_from_html*, publish_article*, update_article_block*, update_doc_name*, create_doc*, create_doc_block*, delete_doc_block*, update_doc_block*, blocks

**Objects and schemas** (34): get_view_schema_by_type, object_types_unique_keys, objects, object_relations, managed_column, get_column_type_schema, get_object_schemas, create_object*, delete_object*, archive_object*, add_subscribers_to_object*, update_object*, publish_object*, unpublish_object*, create_object_relations*, delete_object_relation*, create_dropdown_managed_column*, create_status_managed_column*, update_dropdown_managed_column*, update_status_managed_column*, activate_managed_column*, deactivate_managed_column*, delete_managed_column*, attach_status_managed_column*, attach_dropdown_managed_column*, create_object_schema*, update_object_schema*, delete_object_schema*, connect_board_to_object_schema*, create_object_schema_columns*, set_object_schema_column_active_state*, detach_boards_from_object_schema*, update_object_schema_columns*, bulk_object_schema_column_actions*

**Apps and marketplace** (18): app, get_app_lifecycle_subscriptions, marketplace_app_discounts, app_subscriptions, app_installs, apps_monetization_info, apps_monetization_status, create_app*, update_app*, update_app_feature*, create_app_feature*, update_app_lifecycle_subscription*, delete_app_lifecycle_subscription*, promote_app*, create_marketplace_app_discount*, delete_marketplace_app_discount*, grant_marketplace_app_discount*, batch_extend_trial_period*

**Updates and replies** (10): updates, replies, like_update*, unlike_update*, delete_update*, edit_update*, pin_to_top*, create_update*, add_file_to_update*, clear_item_updates*

**Items and subitems** (29): item_dependency, search_items, search_timeline_items, timeline_item, items_history, items, items_page_by_column_values, next_items_page, bulk_delete_items*, bulk_archive_items*, backfill_items*, ingest_items*, create_timeline_item*, delete_timeline_item*, set_item_description_content*, archive_item*, change_column_value*, change_item_position*, change_multiple_column_values*, change_simple_column_value*, create_item*, create_subitem*, delete_item*, duplicate_item*, move_item_to_board*, move_item_to_group*, update_assets_on_item*, list_board_items, list_subitems_by_parent

**Boards, columns and groups** (72): dependency_column_config, board_dependencies, would_create_mls_rollup_cycle, search_boards, search_overviews, validations, custom_activity, timeline, mute_board_settings, boards, board_candidates, update_dependency_column*, batch_update_dependency_column*, add_required_column*, remove_required_column*, create_validation_rule*, update_validation_rule*, delete_validation_rule*, create_custom_activity*, delete_custom_activity*, create_view_table*, create_view*, update_view_table*, update_view*, delete_view*, change_board_kind*, duplicate_view*, restore_view*, configure_categorize_ai_column*, configure_summarize_ai_column*, configure_translate_ai_column*, configure_improve_text_ai_column*, configure_extract_ai_column*, configure_write_me_ai_column*, configure_person_assignment_ai_column*, remove_ai_from_column*, update_status_column*, update_dropdown_column*, update_column*, create_status_column*, create_dropdown_column*, create_column*, create_board_export*, update_mute_board_settings*, add_file_to_column*, add_teams_to_board*, add_users_to_board*, archive_board*, archive_group*, change_column_metadata*, change_column_title*, create_board*, create_group*, delete_board*, delete_column*, delete_group*, delete_subscribers_from_board*, delete_teams_from_board*, duplicate_board*, duplicate_group*, set_board_permission*, update_board*, update_board_hierarchy*, update_group*, update_overview_hierarchy*, update_teams_board_role*, update_users_board_role*, convert_board_to_project*, list_columns, list_groups, get_board_views, get_activity_logs

**Workspaces, folders and favorites** (22): search_workspaces, favorites, folders, template_installation_status, workspaces, connect_project_to_portfolio*, create_portfolio*, create_favorite*, delete_favorite*, update_favorite_position*, add_teams_to_workspace*, add_users_to_workspace*, create_folder*, create_workspace*, delete_folder*, delete_teams_from_workspace*, delete_users_from_workspace*, delete_workspace*, update_folder*, update_workspace*, use_template*, create_project*

**Users, teams and departments** (32): search_users, departments, account_roles, service_user_tokens*, service_users, me, teams, user_configs, users, assign_department_members*, clear_users_department*, assign_department_owner*, unassign_department_owners*, create_department*, update_department*, delete_department*, create_team*, activate_users*, deactivate_users*, delete_team*, update_users_role*, assign_team_owners*, remove_team_owners*, update_email_domain*, update_multiple_users*, invite_users*, revoke_service_user_tokens*, regenerate_service_user_token*, create_service_user*, add_users_to_team*, remove_users_from_team*, list_team_members

**Everything else: account, search, tags, files, notifications, logs** (41): export_graph, export_events, fetch_job_status, search_updates, notetaker_meetings, job_status, aggregate_history, audit_logs, audit_event_catalogue, sprints, export_job_status, analytics_events, campaigns, campaign, brand_kit, insights, insight, segments, segment, settings, usage, knowledge_base_search, notifications, notifications_settings, aggregate, account, assets, complexity, tags, version, versions, platform_api, undo_action*, unpin_from_top*, run_prompt*, update_notification_setting*, create_notification*, create_or_get_tag*, submit_api_feedback*, graphql*, download_asset

**Composio's names** (32, the same action): add_subscribers_to_board, aggregate_data, create_tag, create_user, get_account_info, get_api_version, get_assets, get_favorites, get_folders, get_form, get_items, get_me, who_am_i, get_query_complexity, get_mutation_complexity, get_tags, get_teams, get_update_replies, get_updates, get_versions, get_webhooks, get_workspaces, list_boards, list_users, list_items_by_column_values, query_sprints, remove_users_from_workspace, update_item, upload_asset, items_page, list_items, columns
