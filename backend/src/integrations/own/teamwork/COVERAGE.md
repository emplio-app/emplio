# Teamwork.com coverage

Source: Teamwork's own Swagger 2 files for the Projects API v3, v2 and v1
(contento-assets.s3.eu-west-1.amazonaws.com/oas/teamwork_docs/projects/reference/projects-api-{v3,v2,v1}.oas2.yml, the
download on apidocs.teamwork.com), lifted to OpenAPI 3 and generated 2026-11-22 by
`bun scripts/openapi-actions.ts teamwork`. Every operation in all three is an action (814). Webhook events from
apidocs.teamwork.com/guides/teamwork/webhook-events. Benchmark: Composio's `teamwork` toolkit (12 tools, no triggers):
all 12 names are here.

## Deliberately left out

| What | Why |
| --- | --- |
| Nothing in the Projects specs | — |
| Teamwork Desk, Spaces, Chat and CRM | Separate products with their own APIs and keys; Teamwork.com here is Projects (Composio's toolkit is too) |
| Sign in with Teamwork (OAuth) | Key only for now, as asked. Teamwork's OAuth needs an app in its Developer Portal; add `oauth` when wanted |
| Sites on a custom domain | Only <site>.teamwork.com and <site>.eu.teamwork.com are accepted, since the key decides where the API key is sent; a custom-domain site still has its teamwork.com address |

## Hand adjustments (scripts/openapi/teamwork.ts, own/teamwork/index.ts)

- Swagger 2 → OpenAPI 3: body params become JSON bodies; v1's undeclared path params (most of them) are added; v1's
  two query flags listed as headers (getPermissions, onlyMyProjects) go in the query; If-None-Match dropped.
- v3's schemas mark nearly every field required (dates, tags, custom fields); that's dropped, Teamwork says what's missing.
- Non-JSON-Schema types (v3's "any") are left open.
- Names: the summary's words; where versions share a summary, v3 keeps the plain name and the older call ends `_v2`/`_v1`.
  Composio's 12 names point at the v3 calls (create_task, update_task, list_tasks, log_time_entry...; v1's matches are
  `create_task_v1`, `list_milestones_v1`, `list_tags_v1`).
- Report exports (.csv, .html, .pdf, .xlsx) are one action each (`..._as_pdf`); files come back as files.
- Every path is absolute; calls go to https://<site>.teamwork.com with basic auth (API key as the username).
- POSTs that only work something out run without asking: validate_syntax_of_formula_field,
  validate_custom_item_formula_expression, validate_request_without_scheduling_or_saving,
  optimise_without_persisting_return_plan, run_reporting_engine_query.
- Ask first though they're GETs: retrieve_api_keys_for_people_on_account (everyone's API keys), get_webhooks and
  get_specific_webhook (the token that signs deliveries).

## Auth

| Method | Status |
| --- | --- |
| Site + API key on one line (`acme tkn.v1_...`), sent as basic auth | done |
| OAuth (Developer Portal app) | not built (key only, as asked) |

## Triggers

**Webhooks (128)**, own/teamwork/triggers.ts: every event on Teamwork's list, one trigger each, named
`<object>_<action>` (task_created, task_list_created_from_template...). Each event gets its own site-level webhook at
/webhooks/app/teamwork/<connection>/<EVENT> (Teamwork's webhooks are one event each), created when the first automation
wants it and deleted with the last. Deliveries are checked against X-Projects-Signature (HMAC-SHA256 of the body with
a token worked out from ENCRYPTION_KEY and the connection). Settings: project_id on all, tasklist_id on tasks.
Needs a site administrator's key, a paid plan, and webhooks turned on in Settings → Webhooks; the error says so.

- **TASK**: task_created, task_updated, task_completed, task_reopened, task_deleted, task_moved, task_reminder, task_tagged, task_untagged
- **TASKLIST**: task_list_created, task_list_created_from_template, task_list_updated, task_list_completed, task_list_reopened, task_list_deleted
- **PROJECT**: project_created, project_updated, project_completed, project_reopened, project_archived, project_copied, project_deleted, project_tagged, project_untagged
- **PROJECTUPDATE**: project_update_created, project_update_updated, project_update_deleted
- **PROJECTRATE**: project_rate_updated
- **MILESTONE**: milestone_created, milestone_updated, milestone_completed, milestone_reopened, milestone_deleted, milestone_reminder, milestone_tagged, milestone_untagged
- **COMMENT**: comment_created, comment_updated, comment_deleted
- **MESSAGE**: message_created, message_updated, message_deleted, message_tagged, message_untagged
- **MESSAGEREPLY**: message_reply_created, message_reply_updated, message_reply_deleted
- **NOTEBOOK**: notebook_created, notebook_updated, notebook_deleted, notebook_tagged, notebook_untagged
- **LINK**: link_created, link_updated, link_deleted, link_tagged, link_untagged
- **FILE**: file_created, file_updated, file_deleted, file_downloaded, file_tagged, file_untagged
- **TIME**: time_created, time_updated, time_deleted, time_tagged, time_untagged
- **TIMER**: timer_created
- **BUDGET**: budget_created, budget_updated, budget_deleted
- **EXPENSE**: expense_created, expense_updated, expense_deleted
- **INVOICE**: invoice_created, invoice_updated, invoice_completed, invoice_reopened, invoice_deleted
- **RISK**: risk_created, risk_updated, risk_deleted
- **FORM**: form_created, form_published, form_submitted, form_deleted
- **CALENDAREVENT**: calendar_event_created, calendar_event_updated, calendar_event_deleted, calendar_event_reminder
- **COMPANY**: company_created, company_updated, company_deleted
- **USER**: user_created, user_updated, user_deleted
- **TEAM**: team_created, team_updated, team_deleted
- **ROLE**: role_created, role_updated, role_deleted
- **STATUS**: status_created, status_updated, status_deleted
- **STAGE**: stage_created, stage_updated, stage_deleted
- **CARD**: card_created, card_updated, card_deleted
- **COLUMN**: column_created, column_updated, column_deleted
- **PORTFOLIOBOARD**: portfolio_board_created, portfolio_board_updated, portfolio_board_deleted
- **PORTFOLIOCARD**: portfolio_card_created, portfolio_card_updated, portfolio_card_moved, portfolio_card_reopened, portfolio_card_deleted
- **PORTFOLIOCOLUMN**: portfolio_column_created, portfolio_column_updated, portfolio_column_deleted
- **GOOGLEDRIVE**: google_drive_connected, google_drive_integrated

Not verified live: the calendar event name (the docs write CALENDEREVENT; we use CALENDAREVENT) and whether deliveries
carry an X-Projects-Delivery id (without one, a retry is recognised by its body).

**Polled (1)**, polls/teamwork.ts: new_activity, the activity feed (every 5 minutes), for people who can't set up
webhooks. Filters: project_id, activity_types.

## Actions by group (* asks first)

**Activity** (9): deletes_activity_item*, latest_activity_projects, deletes_projects_activity_log*, list_latest_activity_for_specific_project, latest_activity_across_projects, list_latest_activity_for_a_specific_project_v1, get_task_activity, get_task_s_audit_history_premium_and_enterprise_plans_only, delete_activity_entry*

**TimeTracking** (30): get_time_entries_for_specific_allocation, get_time_entries_grouped_by_company_id, get_running_timers, create_new_timer*, delete_timer_by_id*, edits_timer*, complete_timer_by_id*, pause_timer_by_id*, resume_timer_by_id*, restore_deleted_timer_item*, get_time_entries_for_specific_project, create_time_entry_in_specific_project*, get_timelog_totals_for_specific_project, get_all_time_entries_grouped_by_company_id_v3, get_timelog_totals_for_specific_task, get_time_entries_for_specific_task, log_time_entry*, get_timelog_totals_for_a_specific_task_v3, list_time_entries, get_time_report, get_time_report_totals, get_time_report_by_type, get_timelog_totals, validate_if_timelog_can_be_created, delete_existing_timelog*, get_specific_time_entry, update_existing_time_entry*, update_an_existing_time_entry_v3*, get_all_running_timers_v3, get_specific_timer

**Budgets** (6): delete_existing_notification*, update_existing_notification*, creates_new_tasklist_budgets*, updates_tasklist_budget*, get_tasklist_budgets_in_project_budget, adds_or_updates_task_list_budgets_depending_on*

**CalendarEvents** (12): generate_agenda_report_in_csv_format_as_csv, generate_agenda_report_in_html_format_as_html, generate_agenda_report_in_pdf_format_as_pdf, generate_agenda_report_in_xlsx_format_as_xlsx, get_calendar_events, get_all_calendar_events_v3, create_new_calendar_event*, get_specific_calendar_event, get_all_calendar_events_v3_2, create_a_new_calendar_event_v3*, get_a_specific_calendar_event_v3, get_all_calendar_events_v3_3

**Calendars** (5): get_calendars, create_new_calendar*, get_specific_calendar, delete_existing_calendar*, update_existing_calendar*

**CalendarEvent** (1): create_task_from_calendar_event*

**Comments** (11): get_list_of_comments, create_comment*, retrieve_specific_comment, list_users_notified_for_comment, deleting_comment*, updating_comment*, retrieving_specific_comment, retrieving_recent_comments, creating_comment*, retrieving_comments_across_types, mark_comment_as_read*

**Companies** (16): get_companies, create_company*, delete_existing_company_domain*, update_existing_company_domain*, delete_existing_company*, get_specific_company, update_existing_company*, set_client_rates_for_company*, convert_company_s_currency*, create_new_company_domains*, retrieve_companies, create_a_company_v1*, retrieving_companies_within_project, retrieve_single_company, update_company*, delete_company*

**CustomFields** (29): company_custom_field_values, add_company_custom_field_value*, delete_many_company_custom_fields_values_at_once*, update_many_company_custom_field_values_at_once*, delete_existing_company_custom_field_value*, company_custom_field_value, update_existing_company_custom_field_value*, get_custom_fields, create_new_custom_field*, delete_many_custom_fields_at_once*, validate_syntax_of_formula_field, delete_existing_custom_field*, get_custom_field_by_id, update_existing_custom_field*, update_an_existing_custom_field_v3*, project_custom_field_values, add_project_custom_field_value*, delete_many_project_custom_fields_values_at_once*, update_many_project_custom_field_values_at_once*, delete_existing_project_custom_field_value*, project_custom_field_value, update_existing_project_custom_field_value*, task_custom_field_values, add_task_custom_field_value*, delete_many_task_custom_fields_values_at_once*, update_many_task_custom_field_values_at_once*, delete_existing_task_custom_field_value*, task_custom_field_value, update_existing_task_custom_field_value*

**Quotes** (15): get_list_of_quotes_for_specific_company, preview_next_auto_generated_quote_number, update_list_of_quote_sections*, delete_quote*, get_quote_by_id, update_quote*, create_new_quote_line_item*, deletes_quote_line_items*, update_quote_line_item*, deletes_quote_line_items_v3*, create_new_quote_section*, update_quote_section*, get_list_of_quotes_across_companies, create_new_quote*, clone_existing_quote*

**Containers** (14): get_containers, create_new_container*, get_insights_containers_for_specific_route, get_insights_containers_for_a_specific_route_v3, get_insights_containers_for_a_specific_route_v3_2, delete_existing_container*, get_specific_container, update_existing_container*, get_budget_chart_data, get_project_chart_data, get_task_chart_data, get_budget_chart_details, get_project_chart_details, get_task_chart_details

**ExchangeRate** (10): create_new_custom_exchange_rate*, list_latest_exchange_rate_per_currency_pair, get_live_exchange_rates_for_custom_pairs, lookup_custom_exchange_rate, list_exchange_rate_for_currency_pair, delete_custom_exchange_rate*, get_custom_exchange_rate, update_custom_exchange_rate*, get_exchange_rates_for_base_currency, get_exchange_rate_for_currency_pair

**CustomItems** (28): get_record_by_id, delete_existing_custom_item*, get_custom_item_by_id, edit_existing_custom_item*, get_custom_item_fields_for_specific_custom_item, create_new_field*, validate_custom_item_formula_expression, delete_existing_custom_item_field*, get_custom_item_field_by_id, edit_existing_custom_item_field*, create_new_option*, delete_existing_custom_item_field_option*, edit_existing_option*, get_custom_item_records_for_specific_custom_item, create_new_record*, create_multiple_records*, delete_many_custom_item_records_at_once*, delete_custom_item_record*, get_custom_item_record_by_id, edit_existing_custom_item_record*, delete_existing_custom_item_field_value*, get_custom_item_sections_for_specific_item, create_new_section*, delete_custom_item_section*, get_custom_item_section_by_id, edit_existing_custom_item_section*, get_custom_items_for_specific_project, create_new_customitem*

**CustomItemRecordComments** (2): get_list_of_comments_for_custom_item_record, create_comment_on_custom_item_record*

**Dashboards** (1): get_dashboards

**Features** (1): get_installation_features

**FileComments** (2): get_list_of_comments_for_file, create_comment_on_file*

**Files** (11): get_parent_project_for_specific_file, list_files_on_task, add_file_to_task*, list_files_on_project, add_file_to_project*, get_single_file, add_new_file_version_to_file*, delete_file_from_project*, get_short_url_for_sharing_file, copy_file_to_another_project*, move_file_to_another_project*

**FileVersionComments** (2): get_list_of_comments_for_file_version, create_comment_on_file_version*

**Forms** (7): get_forms, create_new_form*, delete_existing_form*, get_specific_form, update_existing_form*, get_draft_version_of_specific_form, update_draft_version_of_existing_form*

**FormsPublic** (3): get_forms_via_its_token, pre_signed_upload_url_for_form_attachments, copy_form*

**Importers** (1): get_stats_about_importers

**Utilization** (1): get_utilization_insights_by_report_type

**JobRoles** (9): get_job_roles, create_new_job_role*, delete_existing_job_role*, update_existing_job_role*, set_billable_rates_for_job_role*, set_cost_rates_for_job_role*, remove_user_from_job_role*, assign_job_role*, get_specific_job_role

**LinkItems** (3): get_list_of_comments_for_link_item, create_comment_on_link_item*, get_parent_project_for_specific_link_item

**People** (34): get_logged_user_information, list_people, performance_of_users_completing_most_tasks, return_user_utilization, delete_existing_person*, returns_person, bulk_applies_user_to_many_projects*, returns_list_of_people_on_project, add_people_to_project*, returns_person_on_project, returns_task_completions_for_users, generate_utilization_report_in_csv_format_as_csv, generate_utilization_report_in_html_format_as_html, generate_utilization_report_in_pdf_format_as_pdf, generate_utilization_report_in_xlsx_format_as_xlsx, get_people, creates_new_user_account*, get_available_people_for_calendar_event, get_available_people_for_message, get_available_people_for_milestone, get_available_people_for_following_notebook, get_available_people_for_task, get_available_people_to_notify_when_adding_file, get_available_people_to_notify_when_adding_link, get_people_within_project, get_people_within_company, get_current_user_details, current_user_summary_stats, retrieve_specific_person, editing_user*, delete_user*, retrieve_api_keys_for_people_on_account*, get_deleted_people, add_remove_people_to_existing_project*

**Tasks** (49): get_current_user_s_personal_tasks, creates_personal_task*, get_specific_personal_task, get_specific_project_s_tasks, generate_plannedvsactual_report_in_csv_format_as_csv, generate_plannedvsactual_report_in_html_format_as_html, generate_plannedvsactual_report_in_pdf_format_as_pdf, generate_plannedvsactual_report_in_xlsx_format_as_xlsx, generate_precanned_task_time_report, get_specific_taskgroup_s_tasks, creates_task_in_taskgroup*, get_specific_tasklist_s_tasks, create_task*, list_tasks, total_count_of_completed_tasks, get_total_count_of_late_tasks, delete_existing_task*, get_specific_task, update_task*, update_an_existing_task_v3*, get_parent_project_for_specific_task, get_subtasks_for_specific_task, creates_subtask*, retrieve_task_predecessors_dependencies_on_given_project, get_task_ids_on_given_task_list, get_tasks_ids_on_given_project, get_tasks_across_projects, get_tasks_on_given_project, create_task_on_project*, get_tasks_on_given_task_list, create_task_v1*, retrieve_task, create_sub_task*, update_a_task_v1*, delete_task*, retrieve_task_dependencies, get_completed_tasks, get_task_followers, get_task_predecessors, get_sub_tasks_of_task, get_recurring_tasks_related_to_original_task, quickly_add_multiple_sub_tasks*, quickly_add_multiple_tasks*, mark_task_complete*, mark_task_uncomplete*, reorder_tasks*, editing_task_predecessors*, move_task_from_one_project_to_another*, copy_task_from_one_project_to_another*

**MessageReplies** (3): get_replies, get_specific_message_reply, get_replies_to_given_message

**Messages** (16): get_messages, get_specific_message, edit_message*, get_parent_project_for_specific_message, retrieve_latest_messages, retrieve_latest_messages_by_project, create_message*, retrieve_messages_by_category, retrieve_single_message, update_message*, delete_message*, get_archived_messages, get_archived_messages_by_category, archive_message*, un_archive_message*, mark_message_as_read*

**Milestones** (19): list_milestones, get_milestones_by_due_date_in_time_range, get_milestone_by_id, get_parent_project_for_specific_milestone, get_milestones_in_project, get_milestone_chart_data, get_milestone_details, generate_milestone_report_in_csv_format_as_csv, generate_milestone_report_in_html_format_as_html, generate_milestone_report_in_pdf_format_as_pdf, generate_milestone_report_in_xlsx_format_as_xlsx, list_milestones_v1, list_milestones_on_project, create_single_milestone*, get_single_milestone, update_single_milestone*, delete_milestone*, complete_milestone*, un_complete_milestone*

**MilestoneComments** (2): get_list_of_comments_for_milestone, create_comment_on_milestone*

**Notebooks** (23): get_list_of_notebooks, delete_existing_notebook*, get_specific_notebook, edits_notebook*, compare_2_notebook_versions, lock_notebook*, get_parent_project_for_specific_notebook, unlock_notebook*, delete_notebook_versions*, get_notebook_versions, get_notebook_version, create_new_notebook*, list_notebooks, list_notebooks_on_project, create_single_notebook*, list_notebooks_in_specific_category, get_single_notebook, update_single_notebook*, delete_single_notebook*, lock_single_notebook_for_editing*, unlock_single_notebook*, copy_notebook_to_another_project*, move_notebook_to_another_project*

**NotebookComments** (2): get_list_of_comments_for_notebook, create_comment_on_notebook*

**Users** (1): create_new_user*

**AutoSchedule** (14): persist_accepted_previewed_schedule*, write_previewed_schedule_in_background*, get_state_of_apply_job, check_that_scheduling_service_is_reachable, runs_optimisation_and_computes_summary_highlights*, optimise_and_persist_result_to_db*, optimise_without_persisting_return_plan, enqueue_async_optimise_poll_it_by_job_id*, poll_enqueued_solve_by_job_id, list_stored_solve_versions_for_project, get_most_recently_committed_solve, get_most_recent_stored_solve, get_stored_solve_version_for_project, validate_request_without_scheduling_or_saving

**PricePlans** (2): get_price_plan_by_plan_id, get_single_price_plan_by_id

**Categories** (3): returns_list_of_project_categories, get_specific_project_category, returns_list_of_teamwork_project_categories

**Projects** (36): list_projects, get_total_count_of_active_projects, get_total_billable_time_per_project, get_health_summary_for_projects, return_open_invoices_across_projects, get_number_of_owned_and_un_assigned_projects, return_un_billed_expenses_across_projects, get_project_number_settings, set_project_number_settings*, returns_list_of_starred_projects, returns_list_of_teamwork_sample_projects, returns_list_of_projects_templates, returns_project_template, get_required_custom_fields_for_project_template, update_required_custom_fields_on_template*, converts_given_tentative_project_into_normal*, returns_project, returns_project_features_order_to_display_in_tab, sets_features_order_to_display_in_tab*, generate_project_report_in_csv_format_as_csv, generate_project_report_in_html_format_as_html, generate_project_report_in_pdf_format_as_pdf, generate_project_report_in_xlsx_format_as_xlsx, retrieve_projects, create_project*, retrieve_single_project, update_project*, delete_project*, copy_project*, retrieve_projects_assigned_to_specific_company, retrieve_starred_projects, get_project_rates, set_project_rates*, get_project_stats, star_project*, un_star_project*

**ProjectHealth** (1): get_health_scores_for_projects

**ProjectUpdates** (2): get_project_updates, get_updates_from_specific_project

**Summary** (2): get_project_summary_dashboard, get_installation_summary_dashboard

**Risks** (16): get_risks_for_specific_project, create_risk_in_specific_project*, copies_project_risks*, get_risk_chart_data, get_risk_details, get_risks, delete_existing_risk*, get_risk_by_id, update_existing_risk*, update_an_existing_risk_v3*, get_all_risks_v1, retrieve_risks_in_project, create_risk_on_project*, get_details_of_single_risk, updating_risk_on_project*, deleting_risk_on_project*

**TaskLists** (8): generate_tasklist_report_in_csv_format_as_csv, generate_tasklist_report_in_html_format_as_html, get_tasklists_in_project, generate_tasklist_report_in_pdf_format_as_pdf, generate_tasklist_report_in_xlsx_format_as_xlsx, list_task_lists, get_tasklist_templates, get_specific_tasklist

**Workflows** (14): remove_existing_workflow_from_project*, get_workflows, applies_workflow_to_project*, edits_position_of_task_in_stage*, get_all_workflows_v3, create_new_workflow*, delete_existing_workflow*, get_specific_workflow, update_existing_workflow*, get_stages, create_new_stage_for_workflow*, delete_existing_stage*, get_specific_stage, update_existing_stage*

**QuoteExportPreferences** (2): get_export_preferences_for_quote, save_quote_export_preferences*

**QuoteSettings** (2): get_quote_settings_for_current_installation, update_quote_settings*

**Reports** (18): list_scheduled_reports, create_scheduled_report*, bulk_delete_scheduled_reports*, download_scheduled_report_on_fly, unsubscribe_via_report_email_link, get_html_email_preview_for_scheduled_report, get_schedule_log_for_scheduled_report, start_google_oauth_authorization_flow, unauthenticated_google_oauth_callback, authenticated_google_oauth_callback, get_google_oauth_status_for_current_user, list_available_report_sources, send_scheduled_report_immediately, download_stored_report_file_from_s3, unsubscribe_from_scheduled_report, delete_scheduled_report*, get_scheduled_report_by_id, update_scheduled_report*

**CustomReports** (9): list_custom_reports, create_custom_report*, get_custom_report_builder_metadata, bulk_delete_custom_reports*, enqueue_custom_report_for_processing*, delete_custom_report*, get_custom_report_by_id, update_custom_report*, get_custom_report_s_data

**Estimation** (2): get_estimation_totals, get_estimation_details

**Timelogs** (2): get_timelog_chart_data, get_timelog_details

**AnalyticEngine** (10): export_financial_report_data_in_csv_format_as_csv, get_financial_report_data, export_financial_report_data_in_xlsx_format_as_xlsx, get_nested_financial_report_data, get_financial_report_totals, export_financial_report_trends_in_csv_format_as_csv, get_financial_report_trends, export_financial_report_trends_in_xlsx_format_as_xlsx, get_nested_financial_report_trends, get_per_period_financial_report_totals

**BudgetReport** (3): get_budget_report, get_budget_report_totals, get_object_details

**Person** (1): returns_task_completions_for_given_user

**Reporting** (1): run_reporting_engine_query

**ReportingViews** (5): get_reporting_views_for_type, create_new_reporting_view*, delete_existing_reporting_view*, get_specific_reporting_view, update_existing_reporting_view*

**Search** (2): search_resources, search

**Skills** (13): get_skills, create_new_skill*, delete_many_skills_at_once*, assign_skill*, delete_existing_skill*, update_existing_skill*, remove_skill_from_user*, assign_a_skill_v3*, assign_a_skill_v3_2*, remove_a_skill_from_a_user_v3*, rate_person_for_skill*, assign_skill_to_single_user*, get_specific_skill

**PeopleStatus** (2): get_statuses, get_people_statuses_timeline

**Tags** (13): list_tags, create_tag*, delete_many_tags_at_once*, deletes_tag*, get_details_of_individual_tag, update_single_tag*, list_tags_v1, create_a_single_tag_v1*, get_single_tag, update_a_single_tag_v1*, delete_single_tag*, list_tags_for_resource, update_tags_on_resource*

**Tasklists** (2): delete_existing_tasklist*, get_parent_project_for_specific_tasklist

**RecurringPreview** (1): returns_preview_list_of_recurring_dates

**TaskReminders** (4): gets_task_reminders, add_task_reminder*, delete_task_reminder*, update_task_reminder*

**TaskComments** (2): get_list_of_comments_for_task, create_comment_on_task*

**TimeApprovals** (2): reopen_time_approval_back_to_in_review*, request_to_reopen_time_approval*

**Timesheets** (2): get_list_of_timesheet_rows, get_totals_for_user_s_timesheets

**Workload** (3): return_workload_for_users, retrieve_user_workload_planner, get_workload

**Account Details** (1): get_account_details

**Project Templates** (4): get_project_templates, create_project_template*, update_specific_project_template*, delete_project_template*

**Custom Fields** (4): get_custom_fields_on_projects, get_custom_fields_on_tasks, get_custom_fields_on_task, get_custom_fields_on_project

**Account** (4): get_account_details_v1, get_referrals, claim_referral_earnings*, get_referral_code

**Project Categories** (6): retrieving_of_project_categories, creating_project_categories*, retrieve_single_project_category, updating_project_category*, deleting_project_category*, retrieving_tasks_associated_with_category

**Project Owner** (1): setting_project_owner*

**Site Owner** (1): change_site_owner*

**Task lists** (10): get_task_lists, get_task_lists_for_project, create_task_list*, retrieve_single_task_list, update_task_list*, delete_task_list*, template_task_lists_get_template_task_lists, reorder_lists*, copy_task_list_or_copy_task_list_to_another_project*, move_task_list_to_another_project*

**Task Reminders** (4): get_reminders_on_task, create_reminder_on_task*, update_existing_reminder_on_task*, delete_existing_reminder_on_task*

**Permissions** (4): add_remove_multiple_people_to_from_project*, add_new_user_to_project*, get_users_permissions_on_project, update_users_permissions_on_project*

**People Status** (11): retrieve_statuses, retrieve_persons_status, create_user_status*, retrieve_my_status, create_my_status*, update_my_status*, update_user_status*, delete_user_status*, update_status*, delete_status*, delete_my_status*

**Calendar Event** (9): get_events, create_event*, get_event, edit_event*, delete_event*, get_event_types, create_event_type*, edit_event_type*, delete_event_type*

**File Categories** (5): retrieving_of_file_categories, creating_file_categories*, retrieve_single_file_category, updating_file_category*, deleting_file_category*

**Notebook Categories** (5): retrieving_of_notebook_categories, creating_notebook_categories*, retrieve_single_notebook_category, updating_notebook_category*, deleting_notebook_category*

**Links** (6): list_links_on_project, create_single_link*, list_links, get_single_link, update_single_link*, delete_single_link*

**Link Categories** (5): retrieving_of_link_categories, creating_link_categories*, retrieve_single_link_category, updating_link_category*, deleting_link_category*

**Clock In/ Clock Out** (5): get_clock_ins, edit_clock_in_out_entry*, quick_log_for_another_user*, clock_me_in*, clock_me_out*

**Time Tracking** (19): retrieve_time_entries_across_projects, retrieve_time_entries_for_project, create_time_entry*, retrieve_task_times, create_time_entry_for_task*, retrieve_single_time_entry, update_time_entry*, delete_time_entry*, time_totals_on_project, get_total_time_across_account, time_totals_across_projects, estimated_time_totals_on_projects, total_time_on_tasklist, total_time_on_task, get_logged_time_by_person, get_all_running_timers_v1, get_all_your_running_timers_v1, get_running_timers_for_specific_person, add_time_estimate_to_task*

**Message Replies** (6): retrieve_single_message_reply, update_message_reply*, delete_message_reply*, retrieve_replies_to_message, create_message_reply*, mark_message_reply_as_read*

**Message Categories** (5): retrieving_of_message_categories, creating_message_categories*, retrieve_single_message_category, updating_category*, deleting_message_category*

**Invoices** (10): get_invoices_across_projects, get_invoices_on_single_project, create_new_invoice_in_project*, get_list_of_valid_currency_codes, get_invoice_line_items, update_specific_invoice*, delete_specific_invoice*, mark_specific_invoice_as_complete*, mark_specific_invoice_as_not_complete*, add_time_entry_to_invoice*

**Expenses** (6): get_expenses_across_projects, create_new_expense_in_project*, get_expenses_on_single_project, get_single_expense, update_single_expense*, delete_single_expense*

**Boards** (11): list_columns, create_new_column*, list_cards_in_column, add_card_to_column*, move_card*, edit_card*, remove_card*, get_card, delete_column*, edit_column*, get_column

**v1** (1): put_boards_columns_id_cards_json*

**Portfolio boards** (15): boards_in_portfolio_view, create_new_board*, get_specific_board, edit_board*, delete_board*, columns_inside_portfolio_board, add_column_to_given_board*, get_cards_inside_portfolio_column, adding_project_to_column_from_backlog*, get_specific_card_inside_column, delete_card_in_portfolio_column*, move_projects_on_portfolio_board*, edit_portfolio_column*, delete_portfolio_column*, get_portfolio_column

**File Uploading** (2): upload_file_classic*, file_upload_preferred*

**Project Updates** (6): get_project_updates_v1, get_most_recent_update, create_project_update*, modify_project_update*, delete_project_update*, requesting_project_update_from_project_owner*

**Project Roles** (6): remove_user_from_project*, list_roles_on_project, add_role_to_project*, get_individual_role, update_role_on_project*, delete_role*

**Likes** (3): get_likes_on_resource, like_resource_item*, un_like_resource_item*

**Project Email Addresses** (2): get_project_email_address, update_project_email_address*

**Webhooks** (13): get_webhooks*, create_webhook*, get_webhook_events, get_specific_webhook*, update_webhook*, delete_specific_webhook*, get_deliveries_from_specific_webhook, resend_specific_webhook*, pause_webhook*, resume_webhook*, enable_webhooks*, create_webhook_on_project*, disable_webhooks*

**Reactions** (10): get_comment_reactions_on_task, get_reactions_on_specific_comment, get_reactions_to_project_update, get_reactions_to_message, get_reactions_on_message_replies, react_to_comment*, react_to_message*, react_to_message_reply*, react_to_project_update*, unreacting_to_comment_message_project_update*

**Trashcan** (3): get_projects_in_trashcan, get_project_resources_in_trashcan, restore_resource_items_from_trashcan*

**Timezones** (1): get_timezones

**Teams** (31): get_teams, creates_new_team*, delete_teams_in_bulk*, returns_single_team_identified_by_it_s_id, updates_team*, delete_team_by_id*, add_or_replace_members_of_team*, get_project_s_teams, creates_new_project_specific_team*, get_teams_for_company_id, get_milestone_s_teams, get_message_s_teams, get_notebook_s_teams, get_task_s_teams, get_file_s_teams, get_tasklist_s_teams, get_link_s_teams, get_portfolio_board_s_teams, get_comment_s_teams, get_dataview_s_teams, get_team_s_subteams, get_person_s_teams, get_a_milestone_s_teams_v1, get_a_message_s_teams_v1, get_a_notebook_s_teams_v1, get_a_task_s_teams_v1, get_a_task_s_teams_v1_2, get_a_file_s_teams_v1, get_a_tasklist_s_teams_v1, get_a_link_s_teams_v1, get_user_ids_for_teams

**DataViews** (2): list_current_user_s_data_views, create_new_data_view*
