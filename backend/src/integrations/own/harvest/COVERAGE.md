# Harvest coverage

Source: Harvest API v2 reference (help.getharvest.com/api-v2, 59 pages), read on 2026-11-22 by
`bun src/integrations/own/harvest/generate.ts`, which writes actions.json. Harvest publishes no OpenAPI spec (checked
the API and docs hosts), so the docs pages are the list.
Composio's harvest toolkit (57 actions, no triggers): every one matched by name.

254 actions: every operation on every page. Composio's names where it has the action.

## Deliberately left out

| What | Why |
| --- | --- |
| PUT /v2/notification_preferences | Same as update_notification_preferences (PATCH) |
| "Access Roles" (users page) | A table of role names, not an operation |
| Create/update/delete an invoice or estimate line item | Not separate calls: update_invoice / update_estimate with line_items (the docs say how) |
| Approvals as a trigger | Beta endpoint with no updated_since and a shape that may change; list_approvals is an action |
| OAuth | Key only for now (Harvest has OAuth2; not built on this run) |

## Auth

| Method | Status |
| --- | --- |
| Personal access token + Account ID (id.getharvest.com/developers), pasted as `ACCOUNT_ID:TOKEN` | done; sent as `Authorization: Bearer` and `Harvest-Account-Id`, with a User-Agent. Pasted the other way round also works. `check` reads GET /v2/company and labels the connection with the company name |

## Hand adjustments (generate.ts, index.ts)

- Names: Harvest's section titles, renamed where Composio has the action or the title was long (RENAME, RENAME_PATH).
- "Mark as sent/closed/draft", "re-open", "accept", "decline": event_type is fixed, so the agent needn't send it.
  archive_user sends is_active=false.
- Nested tables (line items, recipients, the time/expense import of create_invoice_from_tracked_time, bulk
  allocations) are written into their parent field's description.
- Updates (PATCH) take null on optional fields, to clear them.
- Array filters (Forecast, time off) go in the query as `name[]=1&name[]=2`.
- create_expense and create_import are multipart: the receipt / CSV is `{"file": "/work/..."}`.
- Downloads (download_report_export, download_import_csv_errors) come back as a file or the CSV text.
- POSTs that only read run without asking: generate_report, preview_gusto_sync_run, create_report_export.

## Triggers (all polled: Harvest has no webhooks)

polls/harvest.ts, every 5 minutes by default (1 at least). Each lists what changed in the last day (updated_since,
one page of 2000).

| Trigger | Fires when | Filters |
| --- | --- | --- |
| new_time_entry / time_entry_updated | hours logged / changed | user_id, client_id, project_id, task_id |
| timer_started | someone starts a timer | user_id, client_id, project_id, task_id |
| new_invoice / invoice_updated | invoice added / changed | client_id, project_id |
| invoice_sent / invoice_paid | invoice goes open / paid | client_id, project_id |
| new_estimate / estimate_updated | estimate added / changed | client_id |
| estimate_accepted / estimate_declined | client answers an estimate | client_id |
| new_expense / expense_updated | expense added / changed | user_id, client_id, project_id |
| new_project / project_updated | | client_id |
| new_client / client_updated | | |
| new_client_contact / client_contact_updated | | client_id |
| new_task / task_updated | | |
| new_user / user_updated | | |
| new_time_off_request / time_off_request_updated | | user_id |

## Actions by group (* asks first)

**contacts** (5): list_client_contacts, get_client_contact, create_client_contact*, update_client_contact*, delete_client_contact*

**clients** (5): list_clients, get_client, create_client*, update_client*, delete_client*

**company** (6): get_company_info, update_company_info*, get_reimbursement_settings, update_reimbursement_settings*, enroll_in_e_invoicing*, disconnect_from_e_invoicing*

**invoice-messages** (8): list_invoice_messages, create_invoice_message*, get_invoice_message_template, delete_invoice_message*, mark_invoice_as_sent*, mark_invoice_as_closed*, reopen_invoice*, mark_invoice_as_draft*

**invoice-payments** (3): list_invoice_payments, create_invoice_payment*, delete_invoice_payment*

**invoices** (8): list_invoices, get_invoice, create_invoice*, create_invoice_from_tracked_time*, update_invoice*, delete_invoice*, send_e_invoice*, get_e_invoice_status

**invoice-item-categories** (5): list_invoice_item_categories, get_invoice_item_category, create_invoice_item_category*, update_invoice_item_category*, delete_invoice_item_category*

**estimate-messages** (7): list_estimate_messages, create_estimate_message*, delete_estimate_message*, mark_estimate_as_sent*, mark_estimate_as_accepted*, mark_estimate_as_declined*, reopen_estimate*

**estimates** (5): list_estimates, get_estimate, create_estimate*, update_estimate*, delete_estimate*

**estimate-item-categories** (5): list_estimate_item_categories, get_estimate_item_category, create_estimate_item_category*, update_estimate_item_category*, delete_estimate_item_category*

**expenses** (7): list_expenses, get_expense, create_expense*, update_expense*, delete_expense*, approve_expense*, withdraw_expense*

**expense-categories** (5): list_expense_categories, get_expense_category, create_expense_category*, update_expense_category*, delete_expense_category*

**tasks** (5): list_tasks, get_task, create_task*, update_task*, delete_task*

**time-entries** (9): list_time_entries, get_time_entry, create_time_entry*, create_time_entry_with_start_and_end*, update_time_entry*, delete_time_entry_external_reference*, delete_time_entry*, restart_time_entry*, stop_time_entry*

**tags** (1): list_tags

**user-assignments** (6): list_user_assignments, list_project_user_assignments, get_user_assignment, create_user_assignment*, update_user_assignment*, delete_user_assignment*

**task-assignments** (6): list_task_assignments, list_project_task_assignments, get_task_assignment, create_task_assignment*, update_task_assignment*, delete_task_assignment*

**projects** (5): list_projects, get_project, create_project*, update_project*, delete_project*

**permissions** (1): list_permissions

**custom-roles** (5): list_custom_roles, get_custom_role, create_custom_role*, update_custom_role*, delete_custom_role*

**roles** (5): list_roles, get_role, create_role*, update_role*, delete_role*

**teammates** (2): list_user_teammates, update_user_teammates*

**billable-rates** (3): list_billable_rates, get_billable_rate, create_billable_rate*

**cost-rates** (3): list_cost_rates, get_cost_rate, create_cost_rate*

**project-assignments** (2): list_user_project_assignments, list_my_project_assignments

**users** (7): list_users, get_me, get_user, create_user*, update_user*, archive_user*, delete_user*

**saved-and-generated-reports** (7): list_saved_reports, create_saved_report*, get_saved_report, update_saved_report*, delete_saved_report*, generate_report, run_saved_report

**report-exports** (3): create_report_export, get_report_export, download_report_export

**profitability-report** (1): get_profitability_report

**detailed-reports** (2): get_detailed_time_report, get_detailed_expense_report

**expense-reports** (4): get_expense_report_by_client, get_expense_report_by_project, get_expense_report_by_category, get_expense_report_by_team_member

**uninvoiced-report** (1): get_uninvoiced_report

**time-reports** (4): get_time_report_by_client, get_time_report_by_project, get_time_report_by_task, get_time_report_by_team_member

**project-budget-report** (1): get_project_budget_report

**work-schedules** (5): list_work_schedules, get_work_schedule, create_work_schedule*, update_work_schedule*, deactivate_work_schedule*

**time-off-requests** (10): list_time_off_requests, get_time_off_request, create_time_off_request*, update_time_off_request*, cancel_time_off_request*, approve_time_off_request*, decline_time_off_request*, request_changes_on_time_off_request*, approve_multiple_time_off_requests*, decline_multiple_time_off_requests*

**time-off-policies** (5): list_time_off_policies, get_time_off_policy, create_time_off_policy*, update_time_off_policy*, delete_time_off_policy*

**time-off-balances** (1): get_time_off_balances

**holiday-calendars** (9): list_holiday_calendars, get_holiday_calendar, create_holiday_calendar*, update_holiday_calendar*, delete_holiday_calendar*, list_holiday_calendar_entries, create_holiday_calendar_entry*, update_holiday_calendar_entry*, delete_holiday_calendar_entry*

**assignments-and-allocations** (5): list_time_off_assignments, update_time_off_assignments*, list_time_off_allocations, update_time_off_allocation*, bulk_update_time_off_allocations*

**approvals** (2): list_approvals, submit_timesheet_for_approval*

**notifications** (5): list_notifications, get_unread_notification_count, peek_notifications, mark_notification_as_read*, mark_all_notifications_as_read*

**notification-preferences** (2): get_notification_preferences, update_notification_preferences*

**reimbursements** (3): list_reimbursements, reject_reimbursement*, restore_reimbursement*

**imports** (5): list_imports, create_import*, get_import, download_import_csv_errors, revert_import*

**gusto-sync-runs** (3): preview_gusto_sync_run, create_gusto_sync_run*, get_gusto_sync_run

**gusto-settings** (5): get_gusto_settings, update_gusto_settings*, create_gusto_user_mapping*, bulk_create_gusto_user_mappings*, delete_gusto_user_mapping*

**time-off** (4): list_forecast_time_off, create_company_holiday*, update_company_holiday*, delete_company_holiday*

**scheduled-assignments** (6): list_scheduled_assignments, get_scheduled_assignment, create_scheduled_assignment*, update_scheduled_assignment*, delete_scheduled_assignment*, divide_scheduled_assignment*

**schedule** (1): export_schedule

**repeating-assignments** (6): list_repeating_assignment_sets, get_repeating_assignment_set, create_repeating_assignment_set*, update_repeating_assignment_set*, delete_repeating_assignment_set*, split_repeating_assignment_set*

**project-financials** (1): get_project_financials

**planned-expenses** (5): list_planned_expenses, get_planned_expense, create_planned_expense*, update_planned_expense*, delete_planned_expense*

**placeholders** (4): list_placeholders, get_placeholder, create_placeholder*, update_placeholder*

**milestones** (5): list_milestones, get_milestone, create_milestone*, update_milestone*, delete_milestone*

**forecast-settings** (5): get_forecast_settings, update_financial_estimates_switch*, update_weekly_digest_switch*, update_my_financials_preference*, update_my_weekly_digest_subscription*

**board-window** (1): get_board_window

**board-projects** (3): add_project_to_board*, remove_project_from_board*, set_project_board_colour*

**availability-heatmap** (1): get_availability_heatmap
