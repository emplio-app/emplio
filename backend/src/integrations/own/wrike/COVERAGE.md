# Wrike coverage

Source: Wrike's own OpenAPI file for API v4 (wrike_api_v4_ver154.yaml, served by its ReadMe docs at
dash.readme.com/api/v1/api-registry/d2p4bhmuzfjvff), generated 2026-11-22 by `bun scripts/openapi-actions.ts wrike`.
Every operation in it is an action (204), plus 10 hand-written ones for what the spec leaves out: the
webhook calls (documented only at developers.wrike.com/docs/webhooks) and uploading a file from the computer.
214 actions in all. Composio's Wrike toolkit (144 tools, no triggers) is matched by name except the two below.

## Deliberately left out

| What | Why |
| --- | --- |
| Composio's delete_custom_field | Wrike's API v4 has no call to delete a custom field (not in the spec or the reference); modify_custom_field and the Wrike app do the rest |
| Composio's delete_inivtation | Their typo: it's delete_invitation here |
| Cloud Content Connector (ccc.yaml) and DataHub APIs | Separate APIs for building file-storage connectors and BI databases, not for running work in Wrike |
| OAuth sign-in | Wrike offers it, but the user chose key-only for now; a permanent token never runs out. Add `oauth` (login.wrike.com/oauth2/authorize, the token answer's `host` says the data centre) when wanted |

## Hand adjustments (scripts/openapi/wrike.ts, own/wrike/index.ts)

- Wrike's spec gives most list and object params as `content: application/json` with no schema. The script moves the
  schema into place before generating, so inputs are typed, and marks them (`json` in actions.json); index.ts sends
  them as JSON text (`responsibles=["KUAAA"]`), the way Wrike reads them.
- Writes (POST/PUT) send their params as a form body rather than the query, so long descriptions and comments fit.
- Names: Composio's where it has the same call; the rest from the path (GET /tasks/{taskId}/comments → get_tasks_comments).
- Path ids the spec leaves undescribed get a description saying where the id comes from.
- search_ediscovery (a POST) only reads, so it runs without asking.
- get_attachments_download / get_attachments_preview hand back the file under its real name, not "download".
- Hand-written: get_all_webhooks, get_webhook_by_id, create_account_webhooks, create_folder_webhook,
  create_space_webhook, update_webhook_state, delete_webhook (not in the spec); upload_task_attachment,
  upload_folder_attachment, upload_attachment_version (the spec only shows attaching from a link; these send the file
  itself with X-File-Name).

## Auth

| Method | Status |
| --- | --- |
| Permanent access token (Apps & Integrations → API), sent as Bearer | done |
| Data centre: www (default), app-eu (`eu:<token>`) or app-us2 (`us2:<token>`); a host or a link into Wrike before the token works too. A token pasted without its region is tried on the others and the error says which prefix to use | done |
| OAuth 2.0 | not built (see above) |

## Triggers

Webhooks (triggers.ts), one per connection for the whole account at /webhooks/app/wrike/<connection>; an automation with
`folder_id` gets a recursive webhook on that folder (/f-<id>), one with `space_id` a webhook on that space (/s-<id>).
Secret: HMAC of ENCRYPTION_KEY and the connection; Wrike signs each body with it (X-Hook-Signature) and proves it with
a handshake (X-Hook-Secret) when the webhook is made. A suspended webhook is resumed. Each event is sent on with the task
or folder as it is now (`item`, one GET for the batch), so `assignee_id`, `task_id` and `status` filter for free.

Every event Wrike sends, as its snake_case name (46): task_created, task_deleted, task_title_changed, task_importance_changed, task_status_changed, task_dates_changed, task_parents_added, task_parents_removed, task_responsibles_added, task_responsibles_removed, task_shareds_added, task_shareds_removed, task_description_changed, task_custom_field_changed, attachment_added, attachment_deleted, comment_added, comment_deleted, create_from_blueprint_completed, timelog_changed, folder_created, folder_deleted, folder_title_changed, folder_parents_added, folder_parents_removed, folder_shareds_added, folder_shareds_removed, folder_description_changed, folder_comment_added, folder_comment_deleted, folder_attachment_added, folder_attachment_deleted, folder_custom_field_changed, project_dates_changed, project_owners_added, project_owners_removed, project_status_changed, task_approval_status_changed, task_approval_decision_changed, task_approval_decision_reset, folder_approval_status_changed, folder_approval_decision_changed, folder_approval_decision_reset, work_item_type_changed, import_from_file_completed, task_completed.
task_completed is TaskStatusChanged into a Completed status.

Polled (polls/wrike.ts), every 15 minutes: new_user (someone joins the account), new_space.
Not reported by Wrike at all: changes made by mass actions and imports (Wrike's own limit).

## Limits

- Wrike rate-limits each user (about 400 requests a minute) and answers 429 past it.
- Some calls only work on some plans: spaces, custom statuses and workflows not on Team; bookings, job roles,
  placeholders, budget rates, blueprints, custom item types, approvals, timesheets and request forms on Business and up;
  audit log, eDiscovery, data export and user schedules for admins on Enterprise/Pinnacle. Wrike says so in its error.
- Account webhooks only report what the token's user can see.

## Actions by group (* asks first)

**hand-written** (10): get_all_webhooks, get_webhook_by_id, create_account_webhooks*, create_folder_webhook*, create_space_webhook*, update_webhook_state*, delete_webhook*, upload_task_attachment*, upload_folder_attachment*, upload_attachment_version*

**Access Roles** (1): get_access_roles

**Account** (2): get_account_information, modify_account*

**Approvals** (8): get_approvals, get_folders_approvals, create_folders_approvals*, get_tasks_approvals, create_tasks_approvals*, get_approvals_by_ids, update_approvals*, delete_approvals*

**Assets** (3): create_assets*, update_asset*, delete_asset*

**Async job** (1): get_async_job

**Attachments** (11): list_attachments, get_folders_attachments, create_folder_attachment*, get_tasks_attachments, create_task_attachment*, get_attachments, get_attachments_download, get_attachments_preview, get_attachments_url, update_attachment*, delete_attachments*

**Audit Log** (1): get_audit_log

**Batch operations** (1): create_batch*

**Bookings** (6): get_bookings_by_ids, get_bookings, get_folder_bookings, create_folder_booking*, update_bookings*, delete_booking*

**Cascading field settings** (4): create_folders_cascading_field_settings*, delete_folders_cascading_field_settings*, create_tasks_cascading_field_settings*, delete_tasks_cascading_field_settings*

**Colors** (1): get_colors

**Comments** (10): get_comments, get_folders_comments, create_folders_comments*, get_tasks_comments, create_task_comment*, get_comment_replies, create_comment_reply*, get_comments_by_ids, update_comment*, delete_comment*

**Contacts** (4): get_contacts, get_information_about_specific_contact, get_contacts_history, update_metadata_on_specific_contact*

**Copy Work Schedule** (1): create_workschedules_duplicate*

**Custom Fields** (5): get_all_custom_fields, create_customfield*, query_customfields, get_spaces_customfields, update_custom_field_by_id*

**Custom Item Types** (4): get_custom_item_types, get_space_custom_item_types, get_custom_item_types_by_ids, create_custom_item_types_instantiate*

**Data Export** (3): get_data_export, create_data_export*, get_data_export_by_id

**Data export schema** (1): get_data_export_schema

**Dependencies** (7): get_folders_dependencies, create_folders_dependencies*, get_task_dependencies, create_tasks_dependencies*, get_dependencies, update_dependency*, delete_dependencies*

**EDiscovery** (1): search_ediscovery

**Folder Blueprints** (3): list_folder_blueprints, list_space_folder_blueprints, launch_folder_blueprint_async*

**Folders & Projects** (11): get_folders, list_subfolders_by_folder_id, create_folder*, get_space_folders, get_folders_history, get_folders_by_ids, update_folders_bulk*, copy_folder*, copy_folder_async*, modify_folder*, delete_folder*

**Groups** (6): query_specific_group, modify_group*, delete_group*, retrieve_list_of_groups, create_group*, bulk_modify_groups*

**Hourly rates** (6): get_contact_hourly_rates, get_folders_hourly, update_folders_hourly_rates*, get_placeholder_hourly_rates, update_hourly_rates*, delete_folders_project_team_members*

**Hourly rates provision** (1): update_contacts_hourly_rates_provision*

**IDs** (1): get_ids

**Invitations** (4): query_invitations, create_invitation*, update_invitation*, delete_invitation*

**Job Roles** (5): query_job_roles, create_jobroles*, get_job_roles, update_job_role*, delete_job_role*

**Placeholders** (2): list_placeholders, get_placeholders

**Request Forms Prefill** (1): create_request_forms_prefill_url*

**Request Forms Submit** (1): create_request_forms_submit*

**Request forms** (3): get_request_forms, get_spaces_request_forms, get_request_forms_by_id

**Rollups** (4): get_folders_rollups, update_folders_rollups*, get_tasks_rollups, update_tasks_rollups*

**Spaces** (5): list_spaces, create_spaces*, get_space, update_spaces_by_id*, delete_space*

**Task Blueprints** (3): list_task_blueprints, list_space_task_blueprints, launch_task_blueprint_async*

**Tasks** (9): fetch_all_tasks, get_folders_tasks, create_task*, get_spaces_tasks, get_task_by_id, update_tasks_bulk*, get_tasks_history, modify_task*, delete_task*

**Timelog categories** (1): get_timelog_categories

**Timelog lock periods** (7): get_folders_timelog_lock_periods, create_folders_timelog_lock_period*, delete_folders_timelog_lock_period*, get_tasks_timelog_lock_periods, get_space_timelog_lock_periods, create_spaces_timelog_lock_period*, delete_spaces_timelog*

**Timelogs** (9): get_timelogs, get_contact_timelogs, get_folders_timelogs, get_task_timelogs, create_tasks_timelogs*, get_timelog_categories_timelogs, get_timelogs_by_ids, update_timelogs*, delete_timelog*

**Timesheet Rows** (1): update_timesheet_row*

**Timesheet Submission Rules** (3): get_timesheet_submission_rules, get_workschedules_timesheet, update_workschedule_timesheet_rules*

**Timesheets** (3): get_timesheets, create_timesheets*, update_timesheets*

**User Schedule capacity changes** (5): get_user_schedule_capacity_change, get_user_schedule_capacity_change_by_ids, create_users_user_schedule_capacity_change*, update_user_schedule_capacity_change_by_id*, delete_user_schedule_capacity_change_by_id*

**User Schedule exceptions** (5): get_user_schedule_exclusions, create_user_schedule_exclusions*, get_user_schedule_exclusions_by_id, update_user_schedule_exclusions_by_id*, delete_user_schedule_exclusions_by_id*

**User Schedule partial exclusions** (5): get_user_schedule_partial_exclusion, create_user_schedule_partial_exclusion*, get_user_schedule_partial_exclusion_by_ids, update_user_schedule_partial_exclusion_by_id*, delete_user_schedule_partial_exclusion_by_id*

**User Types** (1): get_user_types

**Users** (3): get_specific_user, update_specific_user*, update_users_bulk*

**Version** (1): get_version

**Whiteboard IDs converter** (1): get_whiteboard_ids

**Work Schedule capacity changes** (5): get_workschedule_capacity_change_by_ids, get_workschedules_workschedule_capacity_change, create_workschedules_workschedule_capacity_change*, update_workschedule_capacity_change_by_id*, delete_workschedule_capacity_change_by_id*

**Work Schedule exceptions** (5): get_workschedule_exclusions_by_id, update_workschedule_exclusions_by_id*, delete_workschedule_exclusions_by_id*, get_workschedules_workschedule_exclusions, create_workschedules_workschedule_exclusions*

**Work Schedules** (5): get_workschedules, create_workschedules*, get_workschedules_by_id, update_workschedules_by_id*, delete_workschedules_by_id*

**Workflows** (4): query_workflows, create_workflows*, get_spaces_workflows, update_workflow*
