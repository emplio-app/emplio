# Everhour coverage

Source: Everhour's official OpenAPI 3 spec, developers.everhour.com/openapi.json (published with its Mintlify docs),
generated 2026-11-22 by `bun scripts/openapi-actions.ts everhour`. Every operation in it is an action (99 of 101), plus
2 by hand: 101 actions. Composio's 51 Everhour tools are all matched by name.

## Deliberately left out

| What | Why |
| --- | --- |
| GET /team/estimate/export (Estimates Report) | Marked deprecated by Everhour; get_projects_report and list_project_tasks (estimates) cover it |
| GET /team/time/export (Time Report) | Marked deprecated by Everhour; list_team_time_records and the dashboards reports cover it |
| OAuth 2.1 sign-in | Not in this job: key sign-in only |

## Hand adjustments (scripts/openapi/everhour.ts, own/everhour/index.ts)

- Base `https://api.everhour.com`; the key goes in `X-Api-Key`. Errors are `{"code", "message"}` with the status.
- Only a 401 marks the key dead. Everhour answers a bad key with 403 "Access denied", but also a call the person's role
  may not make, so a 403 is reported as an error and doesn't force a reconnect.
- get_user_profile drops `apiKey` (Everhour hands back the person's own key) and stays a read.
- list_hooks and get_webhook ask first: they show our webhook's address, whose last part proves deliveries.
- list_tags (GET /tags) and list_teams (GET /team): real calls the spec leaves out, which Composio has.
- Names follow Composio's where one means the same call, plainer ones for the rest (rename in the script). Path and query
  ids, and body fields the spec leaves as "Task ID", say what the id looks like and which action lists them.
- create_attachment takes the file as base64 `content` (jpg, png, pdf), as Everhour's API does.

## Auth

| Method | Status |
| --- | --- |
| Personal API key (My Profile, bottom of the page), sent as X-Api-Key | done |
| OAuth 2.1 with PKCE and dynamic client registration | not built: key sign-in only |

Access follows the person's Everhour role; there are no scopes. An admin's key sees the whole team.

## Triggers

By webhook (own/everhour/triggers.ts): one account-wide webhook per connection on POST /hooks with all 20 events, at
/webhooks/app/everhour/<connection>/all/<token>. Everhour doesn't sign deliveries (its X-Hook-Secret comes once, at the
handshake), so the token, an HMAC of ENCRYPTION_KEY and the connection that's never stored, proves them. The handshake
POST gets a 200 and starts nothing. A webhook Everhour switched off, or missing events, is updated with PUT /hooks/{id}
(which also switches it back on); removed when the last automation goes. Webhooks only see what the key's owner may see.

- new_project, project_updated, project_deleted
- new_task, task_updated, task_deleted, task_restored, estimate_updated
- timer_started, timer_stopped, time_updated
- new_section, section_updated, section_deleted, section_restored
- new_client, client_updated
- new_invoice, invoice_updated, invoice_deleted
- Filters: project_id (not on client, invoice or new_project events, which Everhour sends account-wide), user_id (who did it,
  or whose it is)

Polled every 5 minutes (polls/everhour.ts), for what has no webhook:

- new_expense (project_id, user_id), new_time_off, new_schedule_assignment (project_id, user_id)
- timesheet_submitted, timesheet_approved, timesheet_rejected (a resubmission after a rejection is new again)
- clocked_in (including back from a break), clocked_out
- new_team_member

Composio has no Everhour triggers.

Not reported at all: client deleted, expense changed, time-off approvals (the schedule's status) and tag changes; Everhour
has no webhook for them and their lists don't say what changed.

## Actions (`*` asks first)

- **Clients** (7): client_list, client_create*, get_client, update_client*, client_delete*, update_client_budget*, delete_client_budget*
- **Custom Fields** (5): list_project_custom_fields, create_custom_field*, update_custom_field*, delete_custom_field*, reorder_custom_fields*
- **Expenses** (12): expenses_list, create_expense*, update_expense*, delete_expense*, list_expense_categories, create_expense_category*, update_expense_category*, delete_expense_category*, create_attachment*, add_attachment_to_expense*, download_attachment, delete_attachment*
- **Invoices** (7): list_invoices, get_invoice, update_invoice*, delete_invoice*, create_invoice*, refresh_invoice_line_items*, export_invoice*
- **Projects** (13): list_projects, project_create*, get_project, update_project*, project_delete*, archive_unarchive_project*, update_project_billing_budget*, list_sections, section_create*, get_section, update_section*, section_delete*, sync_integration_project*
- **Reports** (3): get_projects_report, get_clients_report, get_users_report
- **Schedule** (4): list_schedule_assignments, create_schedule_assignment*, update_schedule_assignment*, delete_schedule_assignment*
- **Tasks** (10): list_project_tasks, task_create*, get_task, update_task*, delete_task*, update_task_billing*, update_task_estimate*, delete_task_estimate*, search_tasks, search_project_tasks
- **Time Off** (8): get_time_off_types, create_time_off_type*, update_time_off_type*, delete_time_off_type*, list_time_off_allocations, create_time_off_allocation*, update_time_off_allocation*, delete_time_off_allocation*
- **Time Records** (7): list_team_time_records, get_user_time_records, get_task_time_records, list_project_time_records, add_time*, update_time_record*, delete_time_record*
- **Timecards** (7): get_timecard, update_timecard*, delete_timecard*, list_user_timecards, list_timecards, clock_in*, clock_out*
- **Timers** (4): timer_start*, get_current_timer, stop_timer*, list_team_timers
- **Timesheets** (5): list_user_timesheets, list_team_timesheets, request_timesheet_approval*, review_timesheet_approval*, discard_timesheet_approval*
- **Users** (2): get_user_profile, list_team_members
- **Webhooks** (5): get_webhook*, update_webhook*, delete_hook*, list_hooks*, create_webhook*
- **By hand** (2): list_tags, list_teams

## Limits

- 100 requests per 10 seconds per key; a 429 says when to retry.
- Pagination differs per call (page/limit); client_list and list_invoices answer everything at once.
- Everhour labels its API beta. Invoices, expenses, timesheet approvals, timecards, the schedule and time off need the
  Everhour plans (and add-ons) that have them, and admin or supervisor rights for the team's data.
