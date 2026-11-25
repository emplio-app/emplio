# Smartsheet coverage

Source: Smartsheet's own OpenAPI spec (developers.smartsheet.com/_spec/api/smartsheet/openapi.yaml, API 2.0, 189
operations), generated 2026-11-22 by `bun scripts/openapi-actions.ts smartsheet`. Every operation is an action (182),
plus four hand-written ones (186). Benchmark: Composio's Smartsheet toolkit, 185 tools and no triggers; every one of its
tools is here under the same name except the five deprecated ones below.

## Deliberately left out

| What | Why |
| --- | --- |
| `GET /folders/personal`, `GET /home/folders`, `POST /home/folders` (Composio: list_home_contents, list_folders_in_home, create_folder_in_home) | Marked deprecated by Smartsheet: "Home" is gone in favour of workspaces. Use list_workspaces, list_workspace_children, create_folder_in_workspace |
| `POST /sheets`, `POST /sheets/import` (Composio: create_sheet_in_sheets_folder, import_sheet_from_csv_xlsx) | Deprecated for the same reason. Use create_sheet_in_workspace / create_sheet_in_folder and import_sheet_into_workspace / import_sheet_into_folder |
| `POST /token` | Trades an OAuth code or refresh token; Emplio connects with an API access token |
| `DELETE /token` | Revokes the very token Emplio is connected with; disconnecting in Emplio is the way |

## Hand adjustments (scripts/openapi/smartsheet.ts, own/smartsheet/)

- Names follow Composio's where it has the same call (26 renamed by hand), so its automations and skills carry over.
- The spec's `Authorization`, `Content-Type`, `Content-Disposition`, `smartsheet-integration-source`, `x-smar-sc-actor-id`
  and `Accept-Encoding` header params are dropped: Emplio sends the token, and uploads name themselves from the file.
- Parameter defaults are said in the description, not sent, so a call carries only what was asked.
- Uploads (attachments, versions, proofs, imports, cell and summary images) go as the raw file with
  `Content-Disposition: attachment; filename="..."` and the file's own type.
- `add_rows` / `update_rows`: the body (a row or a list of rows) gets a plain description with the cell shape.
- Region: a token works only where its account lives. The first call tries US, EU, Australia and Smartsheet Gov and
  remembers the one that answers (in memory, per token).
- Every call sends `Smartsheet-Change-Agent: emplio`, so webhook events caused by Emplio are marked (see triggers).
- Lookups that are POSTs run without asking: list_filtered_events, get_image_urls.
- Webhook reads ask first, since they show the webhook's shared secret: list_webhooks, get_webhook.
- Hand-written: export_sheet (xlsx, pdf, csv as a file), export_report (xlsx, csv), download_attachment (the file
  itself, not Smartsheet's short-lived link), attach_link (a URL or cloud file on a sheet, row or comment: the spec's
  JSON form of the attach calls, which the generator can't offer next to the file upload).

## Auth

| Method | Status |
| --- | --- |
| API access token (Personal Settings → API Access), sent as Bearer | done |
| OAuth | not built (key/token only, as asked) |

Limits: 300 requests a minute per token. API tokens aren't offered on Smartsheet's free plan, and on Business and
Enterprise plans an admin can turn API access off. Webhook callbacks must be HTTPS. Admin calls (users, groups, list_org_sheets, events) need a System Admin; list_events and
new_admin_event also need the Event Reporting add-on.

## Triggers

By webhook (own/smartsheet/triggers.ts), one webhook per connection and sheet, all events, switched on with
Smartsheet's challenge handshake. The URL carries a token worked out from ENCRYPTION_KEY (Smartsheet's own HMAC uses a
secret it generates, which we'd have to store). Callbacks only carry ids, so the row (values by column name), comment,
discussion, attachment or column is read back before the automation runs. Changes made by Emplio itself are skipped
unless `include_emplio_changes` is on. Filters: `row_id`, `column` (name or id) and `value` on cell triggers.

- Rows: new_row, row_updated, row_deleted
- Cells: cell_changed (any of the three), cell_created, cell_updated, cell_deleted
- Columns: column_created, column_updated, column_deleted
- Comments: comment_created, comment_updated, comment_deleted
- Conversations: discussion_created, discussion_updated, discussion_deleted
- Attachments: attachment_created, attachment_updated, attachment_deleted
- Sheet: sheet_updated, sheet_deleted, sheet_activity (anything)
- Plan (plan-wide webhook, System Admin): user_seat_type_updated

Polled every 5 minutes (polls/smartsheet.ts), for what no sheet webhook can say: new_sheet, sheet_modified (any sheet in
the account), new_report, new_dashboard, new_workspace, new_admin_event (the plan's event log).

Not a trigger: `sheet.created` (a sheet webhook is on a sheet that already exists; new_sheet covers it).

## Actions by group (* asks first)

**hand-written** (4): export_sheet, export_report, download_attachment, attach_link*

**contacts** (2): list_contacts, get_contact

**events** (2): list_events, list_filtered_events

**favorites** (5): list_favorites, add_favorites*, delete_multiple_favorites*, delete_favorite*, check_favorite

**folders** (8): delete_folder*, update_folder*, get_folder_metadata, list_folder_children, copy_folder*, create_folder_in_folder*, move_folder*, get_folder_path

**sheets** (14): create_sheet_in_folder*, list_sheets, get_sheet, delete_sheet*, update_sheet*, copy_sheet*, send_sheet_by_email*, move_sheet*, get_sheet_path, get_sheet_publish_status, set_sheet_publish_status*, get_sheet_version, list_org_sheets, create_sheet_in_workspace*

**imports** (2): import_sheet_into_folder*, import_sheet_into_workspace*

**governance** (2): get_classification_settings, set_sheet_data_classification*

**groups** (5): list_org_groups, add_group*, get_group, update_group*, delete_group*

**groupMembers** (2): add_group_members*, delete_group_members*

**cellImages** (2): get_image_urls, add_cell_image*

**reports** (18): list_reports, create_report*, get_report, delete_report*, list_report_columns, add_report_columns*, get_report_column, update_report_column*, delete_report_column*, get_report_definition, update_report_definition*, send_report_by_email*, get_report_path, get_report_publish_status, set_report_publish_status*, list_report_scope, add_report_scope*, remove_report_scope*

**search** (2): search_everything, search_sheet

**serverInfo** (1): get_server_info

**sharing** (5): list_asset_shares, share_asset*, get_asset_share, update_asset_share*, delete_asset_share*

**attachments** (11): list_sheet_attachments, attach_to_sheet*, get_attachment, delete_attachment*, list_attachment_versions, add_attachment_version*, delete_attachment_versions*, attach_to_comment*, list_discussion_attachments, list_row_attachments, attach_to_row*

**automationRules** (4): list_automation_rules, get_automation_rule, update_automation_rule*, delete_automation_rule*

**columns** (5): list_columns, add_columns*, get_column, delete_column*, update_column*

**comments** (4): get_comment, edit_comment*, delete_comment*, create_discussion_comment*

**crossSheetReferences** (3): create_cross_sheet_references*, list_cross_sheet_references, get_cross_sheet_reference

**discussions** (6): list_sheet_discussions, create_sheet_discussion*, get_discussion, delete_discussion*, list_row_discussions, create_row_discussion*

**proofs** (15): list_proofs, get_proof, delete_proof*, update_proof_status*, list_proof_attachments, attach_to_proof*, list_proof_discussions, create_proof_discussion*, list_proof_request_actions, delete_proof_requests*, create_proof_request*, list_proof_versions, delete_proof_version*, create_proof_version*, create_proof*

**rows** (8): add_rows*, delete_rows*, update_rows*, send_rows_by_email*, copy_rows_to_another_sheet*, move_rows_to_another_sheet*, get_row, sort_rows_in_sheet*

**cells** (1): list_cell_history

**updateRequests** (8): list_sent_update_requests, get_sent_update_request, delete_sent_update_request*, list_update_requests, create_update_request*, get_update_request, update_update_request*, delete_update_request*

**sheetSummary** (6): get_sheet_summary, list_summary_fields, update_summary_fields*, delete_summary_fields*, add_summary_fields*, add_summary_field_image*

**dashboards** (9): list_dashboards, get_dashboard, update_dashboard*, delete_dashboard*, copy_dashboard*, move_dashboard*, get_dashboard_path, get_dashboard_publish_status, set_dashboard_publish_status*

**users** (13): list_users, add_user*, get_current_user, get_user, remove_user_from_organization*, update_user*, deactivate_user*, downgrade_user*, update_user_profile_image*, reactivate_user*, upgrade_user*, remove_user_from_plan*, list_user_plans

**alternateEmailAddress** (5): list_alternate_emails, add_alternate_emails*, get_alternate_email, delete_alternate_email*, make_alternate_email_primary*

**webhooks** (6): list_webhooks*, create_webhook*, get_webhook*, update_webhook*, delete_webhook*, reset_webhook_shared_secret*

**workspaces** (8): list_workspaces, create_workspace*, delete_workspace*, update_workspace*, get_workspace_metadata, list_workspace_children, copy_workspace*, create_folder_in_workspace*
