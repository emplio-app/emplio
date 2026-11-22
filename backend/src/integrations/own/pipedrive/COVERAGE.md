# Pipedrive coverage

Source: Pipedrive's official OpenAPI specs, developers.pipedrive.com/docs/api/v2/openapi.yaml and
developers.pipedrive.com/docs/api/v1/openapi.yaml, generated 2026-11-22 by `bun scripts/openapi-actions.ts pipedrive`.
Every operation in both is an action (305): v2 first, then v1 for everything v2 doesn't have yet. Where both
specs have the same call (53 of them: fields, followers, projects, tasks, boards, phases, templates), only v2's is kept.

## Deliberately left out

| What | Why |
| --- | --- |
| POST /channels | Marked deprecated by Pipedrive |
| DELETE /channels/{id} | Marked deprecated by Pipedrive |
| POST /channels/messages/receive | Marked deprecated by Pipedrive |
| DELETE /channels/{channel-id}/conversations/{conversation-id} | Marked deprecated by Pipedrive |
| GET /deals/summary/archived | Marked deprecated by Pipedrive |
| GET /deals/timeline/archived | Marked deprecated by Pipedrive |
| POST /meetings/userProviderLinks | only a Marketplace video-call app can call it |
| DELETE /meetings/userProviderLinks/{id} | only a Marketplace video-call app can call it |
| GET /oauth/authorize | sign-in for Marketplace apps; Emplio connects with an API token |
| POST /oauth/token | sign-in for Marketplace apps; Emplio connects with an API token |
| POST /oauth/token/ | sign-in for Marketplace apps; Emplio connects with an API token |
| GET /pipelines/{id}/deals | Marked deprecated by Pipedrive |
| GET /stages/{id}/deals | Marked deprecated by Pipedrive |
| Bulk deletes of deals, persons, organizations, activities, activity types and stages (Composio's delete_*_bulk) | No longer in Pipedrive's specs: the v1 calls are gone and v2 deletes one at a time |
| Subscriptions (Composio's add_recurring_subscription, add_installment_subscription, get_subscription...) | Removed from Pipedrive's API; v2's deal installments (add_installment_to_deal and friends) replace them |
| Channels / messaging app calls (add_channel, get_conversations...) | Deprecated, and only a Marketplace messaging app can call them |
| *_beta list calls, and Composio's v1 duplicates (list_deals, get_deals_in_a_stage, list_person_deals...) | v2's list calls take the same filters (get_all_deals with stage_id, person_id...) |
| OAuth sign-in | Not in this job: key sign-in only |

Composio's other unmatched names are renames of calls we have: who_am_i = get_current_user_data, search_multiple_item_types =
perform_search_from_multiple_item_types, patch_deal_fields = update_deal_field, add_product_image = upload_image_for_product,
get_template(s) = get_all_project_templates / get_details_of_template, update_mail_thread = update_mail_thread_details, and so on.

## Hand adjustments (scripts/openapi/pipedrive.ts, own/pipedrive/index.ts)

- Base `https://api.pipedrive.com/api/v2`; v1 calls carry their own base `https://api.pipedrive.com/v1`. The token goes in `x-api-token`.
- `{"success": false, "error": ...}` counts as a failure even on a 200. A 401 means the token is dead.
- get_all_webhooks asks first: it answers with each webhook's basic-auth password.
- Action names follow Composio's where one means the same call (`namer`).

## Auth

| Method | Status |
| --- | --- |
| Personal API token (Settings → Personal preferences → API), sent as x-api-token | done |
| OAuth (Marketplace app) | not built: key sign-in only |

## Triggers

By webhook (own/pipedrive/triggers.ts): one webhook per connection on POST /v1/webhooks, version 2.0, event "*.*", at
/webhooks/app/pipedrive/<connection>, with HTTP basic auth user `emplio` and a password worked out from ENCRYPTION_KEY and the
connection (never stored). Removed when the last automation goes; a webhook Pipedrive switched off is replaced. Events only
cover what the connected user may see.

- For each of deal, person, organization, activity, lead, note, product, pipeline, stage, user: `new_<x>`, `<x>_updated`, `<x>_deleted`
- deal_stage_changed, deal_won, deal_lost, activity_done
- Composio's names: new_deal_trigger, new_note_trigger, new_organization_trigger
- Filters: owner_id (all), pipeline_id and stage_id (deals), field (on *_updated: only when that field changed)

Polled (polls/pipedrive.ts), for what Pipedrive's webhooks don't cover: new_project, new_project_task, new_file,
new_email (synced inbox, a reply counts again), new_call_log.

Not tried live: no Pipedrive account was used. The v2 webhook payload shape (meta.action/entity, data, previous) is from the
docs; v1's (current, meta.object, added/updated) is understood too.

## Actions by group (* asks first)

**Activities** (5): get_activities, add_an_activity*, delete_activity*, get_activity, update_activity*

**ActivityFields** (2): get_all_activity_fields, get_activity_field

**Deals** (30): get_all_deals, add_a_deal*, get_archived_deals, delete_deal*, get_deal, update_deal*, get_deal_followers, add_deal_follower*, get_deal_followers_changelog, delete_deal_follower*, search_deals, list_discounts_added_to_deal, add_deal_discount*, update_discount_added_to_deal*, delete_deal_discount*, convert_deal_to_lead*, get_deal_conversion_status, get_deals_summary, get_deals_timeline, get_deal_changelog, duplicate_deal*, get_deal_files, get_deal_updates, get_deal_participants_changelog, get_deal_mail_messages, merge_deals*, get_deal_participants, add_deal_participant*, delete_deal_participant*, get_deal_users

**DealProducts** (7): get_deals_products, get_deal_products, add_deal_product*, delete_many_products_from_deal*, update_deal_product*, delete_deal_product*, add_multiple_products_to_deal*

**DealInstallments** (4): list_installments_added_to_list_of_deals, add_installment_to_deal*, update_installment_added_to_deal*, delete_installment_from_deal*

**DealFields** (9): get_all_deal_fields, add_deal_field*, get_deal_field, update_deal_field*, delete_deal_field*, add_deal_field_options_in_bulk*, delete_deal_field_options*, update_deal_field_options_in_bulk*, delete_multiple_deal_fields_in_bulk*

**Persons** (20): get_all_persons, add_a_person*, delete_person*, get_person, update_person*, get_person_followers, add_person_follower*, get_person_followers_changelog, delete_person_follower*, get_person_picture, search_persons, get_person_changelog, get_person_files, get_person_updates, get_person_mail_messages, merge_persons*, get_person_users, delete_person_picture*, add_person_picture*, get_person_products

**PersonFields** (9): get_all_person_fields, add_person_field*, get_person_field, update_person_field*, delete_person_field*, add_person_field_options_in_bulk*, delete_person_field_options*, update_person_field_options_in_bulk*, delete_multiple_person_fields_in_bulk*

**Organizations** (16): get_all_organizations, add_an_organization*, delete_organization*, get_organization, update_organization*, get_organization_followers, add_organization_follower*, get_organization_followers_changelog, delete_organization_follower*, search_organizations, get_organization_changelog, get_organization_files, get_organization_updates, get_organization_mail_messages, merge_organizations*, get_organization_users

**OrganizationFields** (9): get_all_organization_fields, add_organization_field*, get_organization_field, update_organization_field*, delete_organization_field*, add_organization_field_options*, delete_organization_field_options*, update_organization_field_options*, delete_multiple_organization_fields_in_bulk*

**Products** (22): get_all_products, add_product*, get_product_followers, add_product_follower*, get_product_followers_changelog, delete_product_follower*, search_products, delete_product*, get_product, update_product*, duplicate_product*, get_product_variations, add_product_variation*, update_product_variation*, delete_product_variation*, get_image_of_product, upload_image_for_product*, update_product_image*, delete_product_image*, get_product_deals, get_product_files, get_product_users

**ProductFields** (9): get_all_product_fields, add_product_field*, get_product_field, update_product_field*, delete_product_field*, add_product_field_options_in_bulk*, delete_product_field_options*, update_product_field_options_in_bulk*, delete_multiple_product_fields_in_bulk*

**Leads** (10): search_leads, convert_lead_to_deal*, get_lead_conversion_status, get_all_leads, add_lead*, get_archived_leads, get_one_lead, update_lead*, delete_lead*, get_lead_users

**ItemSearch** (2): perform_search_from_multiple_item_types, search_item_by_field

**Stages** (5): get_all_stages, add_stage*, delete_stage*, get_stage, update_stage*

**Pipelines** (7): get_all_pipelines, add_pipeline*, delete_pipeline*, get_pipeline, update_pipeline*, get_pipeline_conversion_statistics, get_pipeline_movement_statistics

**ProjectFields** (8): get_project_fields, create_one_project_field*, get_project_field, update_one_project_field*, delete_one_project_field*, add_project_field_options_in_bulk*, delete_project_field_options_in_bulk*, update_project_field_options_in_bulk*

**Projects** (16): get_all_projects, add_project*, get_archived_projects, get_project, update_project*, delete_project*, search_projects, archive_project*, list_permitted_users, list_updates_about_project_field_values, get_project_plan, update_activity_in_project_plan*, update_task_in_project_plan*, get_project_groups, get_project_tasks, get_project_activities

**ProjectTemplates** (2): get_all_project_templates, get_details_of_template

**Tasks** (5): get_all_tasks, add_task*, get_task, update_task*, delete_task*

**ProjectBoards** (5): get_all_project_boards, add_project_board*, get_details_of_project_board, update_project_board*, delete_project_board*

**ProjectPhases** (5): get_project_phases, add_project_phase*, get_details_of_project_phase, update_project_phase*, delete_project_phase*

**Users** (10): get_user_followers, get_all_users, add_user*, find_users_by_name, get_current_user_data, get_user, update_user*, get_user_permissions, get_user_role_assignments, get_user_role_settings

**ActivityTypes** (4): get_all_activity_types, add_activity_type*, delete_activity_type*, update_activity_type*

**Billing** (1): get_add_ons_for_single_company

**CallLogs** (5): add_call_log*, get_user_call_logs, delete_call_log*, get_call_log, add_call_log_audio_file*

**Currencies** (1): get_all_supported_currencies

**Files** (8): get_all_files, add_file*, create_remote_file_and_link_it_to_item*, link_remote_file_to_item*, delete_file*, get_file, update_file*, download_file

**Filters** (7): delete_multiple_filters_in_bulk*, get_all_filters, add_filter*, get_all_filter_helpers, delete_filter*, get_filter, update_filter*

**Goals** (5): add_goal*, find_goals, update_goal*, delete_goal*, get_goal_result

**LeadFields** (1): get_lead_fields

**LeadLabels** (4): get_all_lead_labels, add_lead_label*, update_lead_label*, delete_lead_label*

**LeadSources** (1): get_all_lead_sources

**LegacyTeams** (8): get_all_teams, add_team*, get_team, update_team*, get_all_users_in_a_team, add_team_users*, delete_team_users*, get_all_teams_of_a_user

**Mailbox** (6): get_mail_message, get_mail_threads, delete_mail_thread*, get_mail_thread, update_mail_thread_details*, get_mail_thread_messages

**Notes** (10): get_all_notes, add_note*, delete_note*, get_note, update_note*, get_note_comments, add_note_comment*, get_comment, update_comment_for_note*, delete_comment*

**NoteFields** (1): get_all_note_fields

**OrganizationRelationships** (5): get_all_relationships_for_organization, create_organization_relationship*, delete_organization_relationship*, get_organization_relationship, update_organization_relationship*

**PermissionSets** (3): get_all_permission_sets, get_permission_set, get_permission_set_assignments

**Recents** (1): get_recents

**Roles** (12): get_all_roles, add_role*, delete_role*, get_role, update_role*, delete_role_assignment*, get_role_assignments, add_role_assignment*, get_role_settings, add_or_update_role_setting*, get_role_pipelines, update_role_pipelines*

**UserConnections** (1): get_all_user_connections

**UserSettings** (1): list_settings_of_authorized_user

**Webhooks** (3): get_all_webhooks*, create_webhook*, delete_webhook*
