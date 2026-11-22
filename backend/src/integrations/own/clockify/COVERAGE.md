# Clockify coverage

Source: Clockify's OpenAPI spec (docs.clockify.me/openapi.json), generated 2026-11-22 by
`bun scripts/openapi-actions.ts clockify`. One spec holds the main API (api.clockify.me/api), the reports API
(reports.api.clockify.me) and the audit log (auditlog-api.api.clockify.me); each operation goes to its own server.
Every operation that isn't deprecated is an action (166).

## Deliberately left out

| What | Why |
| --- | --- |
| POST /v1/workspaces/{workspaceId}/approval-requests (createApprrovalRequest) | Marked deprecated by Clockify |
| POST /v1/workspaces/{workspaceId}/approval-requests/users/{userId} (createApprovalForOtherDeprecated) | Marked deprecated by Clockify |
| GET /v1/workspaces/{workspaceId}/scheduling/assignments/projects/totals (getProjectTotals) | Marked deprecated by Clockify |
| GET /v1/workspaces/{workspaceId}/templates (getTemplates) | Marked deprecated by Clockify |
| POST /v1/workspaces/{workspaceId}/templates (createMany) | Marked deprecated by Clockify |
| DELETE /v1/workspaces/{workspaceId}/templates/{templateId} (delete_1) | Marked deprecated by Clockify |
| GET /v1/workspaces/{workspaceId}/templates/{templateId} (getTemplate) | Marked deprecated by Clockify |
| PATCH /v1/workspaces/{workspaceId}/templates/{templateId} (update) | Marked deprecated by Clockify |
| DELETE /v1/workspaces/{workspaceId}/users/{userId} (removeMember) | Marked deprecated by Clockify |

Composio's five template actions (create_templates_on_workspace, delete_template, get_template_by_id_on_workspace,
get_templates_on_workspace, update_template) are among these: Clockify deprecated templates. Everything else Composio
has matches by name (`rename` in scripts/openapi/clockify.ts keeps its names); coverage shows only those five.

## Hand adjustments (scripts/openapi/clockify.ts, own/clockify/index.ts)

- The spec gives nearly every field a default ("", null, false). They're removed, so only what the agent gives is sent
  and an update doesn't blank the fields it left out.
- `reads`: POSTs that only look up (reports, audit log, filters, totals, webhook logs) run without asking.
- `secrets`: the webhook GETs answer with each webhook's signing token, so they ask first.
- Regions: a key pasted as `euc1:<key>` (EU), `use2:` (USA), `euw2:` (UK) or `apse2:` (Australia) sends calls to
  `https://<region>.clockify.me/api` and reports to `https://<region>.clockify.me/report`. The audit log stays on its
  global server (Clockify documents no regional one).
- Rate limits are Clockify's: 30 requests an hour on the FREE plan, 20 a second on paid ones. Lists page with
  `page`/`pageSize`.

## Auth

| Method | Status |
| --- | --- |
| API key (app.clockify.me/user/preferences#advanced), header X-Api-Key | done |
| OAuth | Clockify offers none to outside apps (add-on tokens are for CAKE.com Marketplace add-ons) |

## Triggers

All 51 webhook events in the spec (CreateWebhookRequestV1.webhookEvent), named in snake_case
(`new_time_entry`, `timer_stopped`, ...). Composio has no Clockify triggers. A Clockify webhook carries one event, so each
event an automation uses gets its own webhook on the workspace (source WORKSPACE_ID), at
`/webhooks/app/clockify/<connection>/<workspace>-<EVENT>/<token>`; the last automation on it deletes it. A webhook
Clockify switched off is deleted and made again. FREE plans allow 3 webhooks per workspace, paid plans 10 per user.

Clockify picks the signing token (sent as Clockify-Signature) and we store none, so the URL holds an HMAC token (see the
`ponytail:` note in triggers.ts). Clockify sends no delivery id; ours is connection + event + a hash of the body.

Settings on every trigger: `workspace_id` (left out: the account's current workspace), and filters `project_id`,
`user_id`, applied by the server. Update events say that a run changing the same item starts them again.

Not tried live. No real account or key was used; that Clockify accepts WORKSPACE_ID as the source for every event type
is from the spec, unconfirmed.

## Actions by group (* asks first)

**User** (10): add_photo*, get_currently_logged_in_user_info, get_member_profile, update_member_s_profile*, find_users_on_workspace, filter_workspace_users, update_user_s_custom_field*, find_user_team_manager, remove_user_s_manager_role*, give_manager_role_to_user*

**Workspace** (10): get_all_my_workspaces, create_workspace*, get_workspace_info, update_workspace_cost_rate*, update_workspace_hourly_rate*, add_limited_users*, add_user_to_workspace*, update_user_s_status*, update_user_s_cost_rate*, update_user_hourly_rate*

**Webhooks** (9): get_all_addon_webhooks*, get_all_webhooks*, create_webhook*, delete_webhook*, get_webhook_by_id*, update_webhook*, get_webhook_logs, get_webhook_event_statuses_for_webhook, generate_new_webhook_token*

**Approval** (6): get_approval_requests, submit_non_pending_approved_entries_expenses_for_approval_to_existing_approval_request*, re_submit_rejected_withdrawn_entries_expenses_for_approval_of_user*, submit_approval_request_for_user_with_type*, update_approval_request*, submit_approval_request_with_type*

**Client** (5): get_clients, create_client*, delete_client*, get_client_by_id, update_client*

**Custom fields** (7): get_custom_fields_on_workspace, create_custom_fields_on_workspace*, delete_custom_field*, update_custom_field_on_workspace*, get_custom_fields_on_project, remove_custom_field_from_project*, update_custom_field_on_project*

**Entity changes (Experimental)** (3): get_created_entities, get_deleted_entities, get_updated_entities

**Expense** (11): get_expenses_on_workspace, create_expense*, get_expense_categories, add_expense_category*, delete_expense_category*, update_expense_category*, archive_expense_category*, delete_expense*, get_expense_by_id, update_expense*, download_receipt

**Holiday** (5): get_holidays, create_holiday*, get_holidays_in_period, delete_holiday*, update_holiday*

**Invoice** (17): get_invoices_on_workspace, add_invoice*, filter_out_invoices, get_invoice_settings, change_invoice_settings*, delete_invoice*, get_invoice_by_id, update_invoice*, duplicate_invoice*, export_invoice, add_item_to_invoice*, import_time_entries_and_expenses_to_invoice*, delete_item_from_invoice*, get_payments_for_invoice, add_payment_to_invoice*, delete_payment_from_invoice*, change_invoice_status*

**Project** (12): get_projects, create_new_project*, create_project_from_template*, delete_project*, get_project, update_project*, update_project_estimate*, update_project_memberships*, assign_remove_users_to_from_project*, update_project_template*, update_project_user_s_cost_rate*, update_project_user_hourly_rate*

**Task** (7): get_tasks, create_task*, update_task_s_cost_rate*, update_task_s_billable_rate*, delete_task*, get_task, update_task*

**Scheduling** (11): list_assignments, get_scheduled_assignments_per_project, get_scheduled_assignments_on_project, publish_assignments*, create_assignment*, delete_assignment*, update_assignment*, change_recurring_period*, get_total_of_users_capacity_on_workspace, get_total_capacity_of_user, copy_scheduled_assignment*

**Tag** (5): get_tags, create_tag*, delete_tag*, get_tag, update_tag*

**Time entry** (13): create_time_entry*, get_multiple_time_entries_on_workspace, mark_time_entries_as_invoiced*, get_in_progress_time_entries, delete_time_entry*, get_time_entry, update_time_entry*, delete_user_time_entries*, get_time_entries, stop_user_timer*, create_user_time_entry*, update_time_entries*, duplicate_time_entry*

**Balance Assignment** (4): creates_new_balance_assignment_for_user_in_policy*, get_balance_assignments_of_user_in_policy, deletes_specific_balance_assignment*, updates_specific_balance_assignment*

**Balance** (3): get_balances_for_policy, update_balance*, get_balance_for_user

**Policy** (6): get_policies_on_workspace, create_time_off_policy*, delete_policy*, get_time_off_policy, change_policy_status*, update_policy*

**Time Off** (5): create_time_off_request*, delete_time_off_request*, change_time_off_request_status*, create_time_off_request_for_user*, get_time_off_requests_on_workspace

**Group** (6): get_user_groups, create_user_group*, delete_user_group*, update_user_group*, add_users_to_group*, remove_user_from_group*

**Shared Report** (5): get_shared_report, get_shared_reports, create_shared_report*, delete_shared_report*, update_shared_report*

**Team Report** (1): generate_attendance_report

**Time Entry Report** (3): generate_detailed_report, generate_summary_report, generate_weekly_report

**Expense Report** (1): generate_expense_report

**Audit Log Report** (1): generate_audit_log_report
