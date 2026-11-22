# Toggl Track coverage

Source: Toggl's three Swagger 2.0 files linked from engineering.toggl.com/docs/track/openapi/ (Track API v9, Reports API
v3 with Insights, Webhooks API v1), generated 2026-11-22 by `bun scripts/openapi-actions.ts toggl`. Every operation
is an action (325) apart from the four below. Composio's toolkit (59 actions, no triggers) is matched
name for name.

## Deliberately left out

| What | Why |
| --- | --- |
| GET /auth/saml2/login, POST /auth/saml2/login/{workspace_id} | Browser single sign-on and the identity provider's callback; a pasted API token has no use for them |
| POST /me/reset_token | Replaces the API token Emplio signs in with, which would cut the connection. Reset it on the profile page, then reconnect |
| GET /workspaces/{workspace_id}/groups | Marked deprecated by Toggl; get_organization_workspaces_groups replaces it |

## Hand adjustments (scripts/openapi/toggl.ts, own/toggl/index.ts)

- The specs are Swagger 2.0: the config turns body and form params into a request body, gives query/path params a schema
  (arrays comma separated unless `multi`), treats form params on GETs as query params, and makes Reports' one-param-per-field
  bodies a single object. Operations with no id (all of Reports, some of Track) get one from the call.
- Spec file names carry a hash that changes with each docs release, so they're read off the Open API page.
- Reports and Insights go to api.track.toggl.com/{reports/api/v3,insights/api/v1}; Webhooks to /webhooks/api/v1.
  Every one is a POST but only builds a report, so they all run without asking. So do the other POST lookups
  (clients/data, tasks/data, users/data, project counts, billable amounts, timesheet hours, favourite suggestions...).
- Exports (PDF, CSV, XLSX, zip) come back as files in the chat's computer.
- Auth is HTTP basic, `<token>:api_token`. A 403 saying "Incorrect username and/or password" counts as a dead token.
- `body_workspace_id` (Toggl wants the workspace in the body too) is filled from `workspace_id` when left out.
- create_time_entry sends `created_with: "Emplio"` (Toggl requires it) and `duration: -1` (a running timer) when no
  stop or duration is given.
- get_me is hand-written: Toggl's answer includes the API token, which is dropped.
- Ask first despite being GETs: get_desktop_login (hands out a login token), get_subscriptions (webhook secrets).
- Names: Composio's for the 59 calls it has, plain names for time entries, tasks, goals, alerts and calendar
  integrations; the rest are Toggl's operation ids.

## Auth

| Method | Status |
| --- | --- |
| API token (track.toggl.com/profile → API Token), basic auth | done |
| OAuth | Toggl Track offers none to third parties |

## Triggers

By webhook (own/toggl/triggers.ts), all 28 Toggl event filters, named `<entity>_<action>`: client, project,
project_group, project_user, tag, task, time_entry, timesheet, workspace_user × created/updated/deleted, and
workspace_updated. One subscription per connection and workspace, extended as automations are added, deleted with the
last. Signed with X-Webhook-Signature-256 (HMAC of a secret we set, worked out from ENCRYPTION_KEY and the connection);
the validation ping is answered with its code. Settings: workspace_id (required), project_id and user_id where they apply.
Toggl's plan limits apply per workspace (Free: 1 webhook, 3 events; Starter 2 and 6; Premium 3 and 12), and Toggl's
error says so when hit.

Polled (polls/toggl.ts): new_time_entry, the person's own new entries and timers, for plans whose webhook limit is used up.

## Actions by group (* asks first)

**audit_logs** (1): get_audit_logs

**avatars** (3): post_avatars*, delete_avatars*, post_use_gravatar*

**countries** (2): get_countries, get_country_subdivisions

**subscription** (24): get_currencies, get_organization_invoice, post_organization_premium_upgrade_discount_email*, get_organization_subscription, put_organization_subscription*, post_organization_subscription*, delete_organization_subscription*, post_organization_subscription_cancellation_feedback*, post_organization_subscription_discount_request*, get_organization_invoice_summary, post_organization_subscription_payment_confirm*, post_organization_subscription_create_trial*, delete_organization_trial*, get_organization_subscription_trial_opt_in_eligibility, post_organization_subscription_trial_opt_in*, post_organization_subscription_upgrade_request*, post_organization_subscription_usage_based_discount*, delete_organization_subscription_usage_based_discount*, get_all_plans, get_public_subscription_plans, get_workspace_currencies, get_workspace_invoice, get_workspace_payment_receipts, get_workspace_subscription

**auth** (2): get_desktop_login*, post_desktop_login_tokens*

**feedback** (1): post_unified_feedback*

**ical** (3): get_ical, post_workspace_ical_reset*, post_workspace_ical_toggle*

**calendar** (15): get_calendar_integrations, get_calendars, get_selected_calendars, get_calendar_events, suggest_calendar_events_details, refresh_calendar_events*, suggest_calendar_event_details, get_calendar_integration_setup_url, update_calendar_integration*, delete_calendar_integration*, get_calendar_integration_calendars, refresh_calendar_integration_calendars*, select_calendar*, get_calendar_event_attendees, get_calendar_integration_events

**invitations** (4): get_invitations, post_reject_invitation*, create_invitation*, put_invitation*

**keys** (1): get_keys

**me** (25): get_me, put_me*, post_me_accept_tos*, get_user_clients, post_close_account*, post_me_disable_product_emails*, disable_weekly_report*, get_me_features, get_me_flags, post_me_flags*, get_me_id, get_my_location, get_me_logged, get_organizations, get_user_projects, get_me_projects_paginated, get_push_services, post_push_services*, delete_push_services*, get_my_quota, get_user_tags, get_user_tasks, get_me_timesheets, get_me_track_reminders, get_web_timer

**authentication** (4): post_enable_sso*, get_workspace_sso, put_workspace_sso*, delete_workspace_linked_sso_profiles*

**exports** (6): get_me_export, post_me_export*, get_me_export_data_uuid_zip, get_workspace_exports, post_workspace_exports*, get_workspace_exports_data_uuid_zip

**favorites** (10): get_favorites, update_favorite*, create_favorite*, post_favorites_suggestions, delete_favorite*, get_workspace_favorites, update_workspace_favorite*, create_workspace_favorite*, post_workspace_favorites_suggestions, workspace_delete_favorite*

**preferences** (6): get_user_preferences, post_preferences*, get_preferences_client, post_preferences_client*, get_workspace_preferences, post_workspace_preferences*

**time_entries** (12): get_time_entries, get_time_entries_checklist, get_current_time_entry, get_time_entry, post_me_time_entries_shared_with*, create_time_entry*, edit_time_entries*, update_time_entry*, delete_time_entry*, patch_stop_time_entry*, get_workspace_time_entry_invitations, post_workspace_time_entry_invitation_action*

**workspaces** (15): get_user_workspaces, post_organization_workspaces*, get_organization_workspaces_workspaceusers, patch_organization_workspace_users*, get_workspace_details, put_workspaces*, post_import_preview_counts, create_rate*, get_rates_by_level, get_workspace_statistics, get_workspace_time_entry_constraints, get_workspace_track_reminders, post_workspace_track_reminders*, put_workspace_track_reminder*, delete_workspace_track_reminder*

**organizations** (18): create_organization*, post_organization_accept_invitation*, get_organization_details, put_organization*, put_organization_group*, patch_organization_group*, get_organization_owner, get_organizations_payments_records, get_organizations_plans, get_organizations_plan, get_organization_roles, get_organization_segmentation, put_organization_segmentation*, get_organization_users, patch_organization_users*, get_organization_users_detailed, put_organization_users*, get_organization_workspaces_statistics

**groups** (10): get_organization_groups, create_group*, delete_group*, get_organization_workspaces_groups, post_workspace_group*, put_workspace_group*, delete_workspace_group*, get_project_groups, post_project_group*, delete_project_group*

**integrations** (1): post_organization_slack_integration_request*

**organizations owner** (4): get_ownership_transfers, post_ownership_transfer*, get_ownership_transfer, post_ownership_transfer_actions*

**organizations/customer** (3): get_unified_customer, put_unified_customer*, post_unified_customer*

**organizations/subscription** (1): get_feature_upsell_multi

**other** (7): get_organization_subscription_payment_failed, get_my_goals, reports_comparative, reports_data_trends_clients, reports_data_trends_projects, reports_data_trends_users, reports_profitability_projects

**organizations/subscription/promocode** (2): post_promotion_code*, delete_promotion_code*

**organizations/subscription/setup_intent** (1): create_setup_intent*

**organizations/subscriptions/item/discount** (1): post_subscription_item_discount*

**users** (7): delete_organization_users_leave*, get_workspace_users, post_workspace_users_data, put_workspace_users*, get_workspace_workspace_users, put_workspace_workspace_users*, delete_workspace_user*

**smail** (3): send_email_contact*, send_demo_email*, send_smail_meet*

**status** (2): get_status, get_webhooks_status

**timeline** (3): get_timeline, post_timeline*, delete_timeline*

**timezones** (2): get_timezones, get_timezone_offsets

**alerts** (5): get_alerts, create_alert*, update_alert*, delete_alert*, get_alert_deliveries

**clients** (10): get_list_clients, create_client*, archive_clients*, get_workspace_clients_data, delete_workspace_clients*, get_client_details, update_client*, delete_client*, archive_client*, restore_client*

**dashboard** (3): get_workspace_all_activities, get_workspace_most_active, get_workspace_top_activity

**work** (2): get_expense, post_expense*

**goals** (5): get_goals, create_goal*, get_goal, update_goal*, delete_goal*

**user-invoices** (3): get_workspace_invoices, post_workspace_user_invoice*, delete_workspace_invoice*

**workspaces/logo** (3): get_workspace_logo, post_workspace_logo*, delete_workspace_logo*

**projects** (19): get_workspace_project_users, create_workspaces_project_users*, post_workspace_project_users_paginated, patch_workspace_project_users_ids*, put_workspace_project_users*, delete_workspace_project_users*, get_projects, create_project*, get_projects_billable_amounts, project_task_count, get_projects_templates, project_user_count, edit_projects*, get_project_details, update_project*, delete_project*, get_workspace_project_periods, post_pinned_project*, get_project_statistics

**tasks** (9): get_project_tasks, create_task*, edit_tasks*, get_task, update_task*, delete_task*, get_tasks, get_workspace_tasks_basic, get_workspace_tasks_data

**saved_reports** (11): get_shared_report, put_shared_report*, post_shared_report*, bulk_delete_saved_report_resource*, get_saved_report_resource, put_saved_report_resource*, delete_saved_report_resource*, reports_shared, reports_shared_csv, reports_shared_pdf, reports_shared_xlsx

**reports** (3): get_workspace_scheduled_reports, post_workspace_scheduled_reports*, delete_workspace_scheduled_reports*

**subscriptions_legacy** (1): get_workspace_purchase_order_pdf

**tags** (5): get_tags, create_tag*, patch_workspace_tags*, put_update_tag*, delete_tag*

**workspaces/time_entry_constraints** (1): post_workspace_time_entry_constraints*

**approvals** (10): get_timesheet_setups, post_timesheet_setups*, put_timesheet_setups*, delete_timesheet_setups*, get_workspace_timesheets_handler, put_workspace_timesheets_batch_handler*, get_workspace_timesheet_hours_handler, put_workspace_timesheets_handler*, get_workspace_timesheet_history_handler, get_workspace_timesheet_time_entries_handler

**insights** (4): insights_data_trends_projects, insights_profitability_employees_export, insights_profitability_projects_export, insights_trends_projects_export

**utils** (11): reports_filters_clients, reports_filters_project_groups, reports_filters_project_users, reports_filters_projects, reports_filters_projects_status, reports_filters_tasks_status, reports_filters_users, reports_search_clients, reports_search_projects, reports_search_users, reports_action_tasks

**summary_reports** (5): reports_projects_summary, get_project_summary_report, reports_summary_time_entries, reports_summary_time_entries_pdf, reports_summary_time_entries_export

**detailed_reports** (4): search_detailed_report_time_entries, reports_search_time_entries_pdf, reports_search_time_entries_export, reports_search_time_entries_totals

**weekly_reports** (3): reports_weekly_time_entries, reports_weekly_time_entries_csv, reports_weekly_time_entries_pdf

**event_filters** (1): get_event_filters

**limits** (1): get_workspace_limits

**ping** (1): ping_subscription*

**subscriptions** (5): get_subscriptions*, create_subscription*, update_subscription*, delete_subscription*, patch_subscription*

**validate** (1): validate_subscription
