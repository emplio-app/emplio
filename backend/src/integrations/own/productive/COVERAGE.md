# Productive coverage

Source: Productive's own OpenAPI 3.1 spec (developer.productive.io/openapi.json, 842 operations), generated
2026-11-22 by `bun scripts/openapi-actions.ts productive`. Every operation is an action (811) except the
31 below. Composio has no Productive toolkit (docs.composio.dev/toolkits/productive is a 404), so the
benchmark is Productive's API itself. Webhook events come from the developer docs' "Webhook events" list
(developer-old.productive.io/webhooks.html) and help.productive.io's "Using webhooks in Productive".

## Deliberately left out

| What | Why |
| --- | --- |
| POST /api/v2/organization_subscriptions/{id}/create_setup_intent | adds a payment card through Stripe in the browser |
| POST /api/v2/passwords | signing in, signing up and passwords: done by a person in Productive, not with an API token |
| GET /api/v2/passwords/{id} | signing in, signing up and passwords: done by a person in Productive, not with an API token |
| PATCH /api/v2/passwords/{id} | signing in, signing up and passwords: done by a person in Productive, not with an API token |
| GET /api/v2/public/artifacts/{uuid}/attachments/{id}/auth | public pages for the business's clients (a shared doc, a proposal to sign), opened with their link, not the account's login |
| GET /api/v2/public/artifacts/{uuid} | public pages for the business's clients (a shared doc, a proposal to sign), opened with their link, not the account's login |
| GET /api/v2/public/pages/{uuid} | public pages for the business's clients (a shared doc, a proposal to sign), opened with their link, not the account's login |
| PATCH /api/v2/public/proposals/{uuid}/accept | public pages for the business's clients (a shared doc, a proposal to sign), opened with their link, not the account's login |
| PATCH /api/v2/public/proposals/{uuid}/confirm_identity | public pages for the business's clients (a shared doc, a proposal to sign), opened with their link, not the account's login |
| PATCH /api/v2/public/proposals/{uuid}/decline | public pages for the business's clients (a shared doc, a proposal to sign), opened with their link, not the account's login |
| GET /api/v2/public/proposals/{uuid}/file_authorize | public pages for the business's clients (a shared doc, a proposal to sign), opened with their link, not the account's login |
| POST /api/v2/public/proposals/{uuid}/file_presign | public pages for the business's clients (a shared doc, a proposal to sign), opened with their link, not the account's login |
| GET /api/v2/public/proposals/{uuid} | public pages for the business's clients (a shared doc, a proposal to sign), opened with their link, not the account's login |
| POST /api/v2/public/proposals/{uuid}/unlock | public pages for the business's clients (a shared doc, a proposal to sign), opened with their link, not the account's login |
| POST /api/v2/sessions | signing in, signing up and passwords: done by a person in Productive, not with an API token |
| GET /api/v2/sessions | signing in, signing up and passwords: done by a person in Productive, not with an API token |
| DELETE /api/v2/sessions/{id} | signing in, signing up and passwords: done by a person in Productive, not with an API token |
| POST /api/v2/sessions/machine | signing in, signing up and passwords: done by a person in Productive, not with an API token |
| PUT /api/v2/sessions/{id}/validate_otp | signing in, signing up and passwords: done by a person in Productive, not with an API token |
| POST /api/v2/signups/{id}/authenticated_finalize | signing in, signing up and passwords: done by a person in Productive, not with an API token |
| POST /api/v2/signups | signing in, signing up and passwords: done by a person in Productive, not with an API token |
| POST /api/v2/signups/{id}/finalize | signing in, signing up and passwords: done by a person in Productive, not with an API token |
| POST /api/v2/signups/unsubscribe | signing in, signing up and passwords: done by a person in Productive, not with an API token |
| POST /api/v2/signups/{id}/verify | signing in, signing up and passwords: done by a person in Productive, not with an API token |
| GET /api/v2/signups/xero_connect | signing in, signing up and passwords: done by a person in Productive, not with an API token |
| GET /api/v2/signups/xero_finalize | signing in, signing up and passwords: done by a person in Productive, not with an API token |
| POST /api/v2/two_factor_authentications | signing in, signing up and passwords: done by a person in Productive, not with an API token |
| DELETE /api/v2/two_factor_authentications/{id} | signing in, signing up and passwords: done by a person in Productive, not with an API token |
| GET /api/v2/two_factor_authentications/{id} | signing in, signing up and passwords: done by a person in Productive, not with an API token |
| PATCH /api/v2/two_factor_authentications/{id} | signing in, signing up and passwords: done by a person in Productive, not with an API token |
| PATCH /api/v2/users/{id}/update_password | changing a person's password needs their current one |
| Webhook event ids 6 and 35 | The spec's enum allows them but no doc says what they are; every documented event is a trigger |

## Hand adjustments (scripts/openapi/productive.ts, own/productive/)

- JSON:API bodies: the generator can't read `application/vnd.api+json`, so the config rewrites the spec first. Each
  body's `data.attributes` become plain fields and each relationship a `<name>_id` (or `<name>_ids`) field;
  `jsonapi` in actions.json says which is which, and index.ts builds `{"data": {"type", "id", "attributes",
  "relationships"}}` back. A relationship's type is guessed from its name (assignee → people, budget → deals…);
  passing `{"type", "id"}` instead of an id overrides the guess.
- Bulk calls (`bulk_*`) take JSON:API's `data` array as is and go with `Content-Type: application/vnd.api+json; ext=bulk`.
- Filters: the spec's filter schema nests itself without end, so `filter` is a plain object whose keys are listed in
  its description; `{"due_date": {"lt": "…"}}` becomes `filter[due_date][lt]=…`. Lists in the query (sort,
  include, several ids) go comma separated.
- The X-Count / X-No-Count headers are dropped (a total count only slows lists).
- Names: `tasks-create` → create_task, `tasks-index` → list_tasks, `boards-archive-archive` → archive_board,
  `…-destroy-bulk` → bulk_delete_…, `reports/task_reports` → get_task_reports; a few renamed by hand.
- Ask first although they're GETs: list_webhooks, get_webhook (they show signing secrets), regenerate_webhook_signing_secret.
- Run unasked although they're PATCHes: check_export_status_expense, check_export_status_invoice, check_dependencies_integration.

## Auth

| Method | Status |
| --- | --- |
| API token + Organization ID (Settings → API integrations), pasted as ORGANIZATION_ID:TOKEN, sent as X-Auth-Token and X-Organization-Id | done |
| OAuth | Not built: Productive's documented API sign-in is the personal token |

## Triggers

Webhooks (own/productive/triggers.ts), one Productive webhook per connection and event (Productive webhooks carry
one event for the whole organization). Checked by our URL token and Productive's `Productive-Signature`
(HMAC-SHA256 of `<t>.<body>` with the webhook's signature token, read from Productive and kept only in memory).
**Productive webhooks need its Ultimate plan**; on other plans saving such an automation fails with Productive's message.

| Thing | Added | Changed | Gone | Filters |
| --- | --- | --- | --- | --- |
| Task | task_created | task_updated | task_deleted | project_id, assignee_id, task_list_id |
| Invoice | invoice_created | invoice_updated | invoice_deleted | company_id |
| Deal | deal_created | deal_updated | deal_deleted | company_id, project_id |
| Budget | budget_created | budget_updated | budget_deleted | company_id, project_id |
| Project | project_created | project_updated | project_deleted | company_id |
| Time entry | time_entry_created | time_entry_updated | time_entry_deleted | person_id, service_id |
| Booking (incl. time off) | booking_created | booking_updated | booking_deleted | person_id |
| Expense | expense_created | expense_updated | expense_deleted | person_id |
| Person | person_created | person_updated | person_archived | — |
| Company | company_created | company_updated | company_archived | — |
| Payment | payment_created | payment_updated | payment_deleted | invoice_id |

Polled (polls/productive.ts, every 5 minutes, any plan): comment_created (project_id, task_id, deal_id),
discussion_created (page_id), page_created (project_id), task_completed (project_id, assignee_id).

## Actions by group (* asks first)

**Activities** (2): list_activities, get_activity

**Agent Configs** (5): create_agent_config*, list_agent_configs, delete_agent_config*, get_agent_config, update_agent_config*

**Agent Roles** (2): get_agent_role, update_agent_role*

**Agents** (6): activate_agent*, create_agent*, list_agents, deactivate_agent*, get_agent, update_agent*

**Allocations** (1): list_allocations

**Approval Policy** (6): archive_approval_policy*, create_approval_policy*, list_approval_policies, restore_approval_policy*, get_approval_policy, update_approval_policy*

**Approval Policy Assignment** (6): create_approval_policy_assignment*, bulk_delete_approval_policy_assignments*, list_approval_policy_assignments, delete_approval_policy_assignment*, get_approval_policy_assignment, update_approval_policy_assignment*

**Approval Status** (5): approve_approval_status*, bulk_approve_approval_statuses*, list_approval_statuses, reject_approval_status*, get_approval_status

**Approval Workflow** (6): create_approval_workflow*, list_approval_workflows, bulk_update_approval_workflows*, delete_approval_workflow*, get_approval_workflow, update_approval_workflow*

**Artifacts** (5): delete_artifact*, get_artifact, list_artifacts, publish_artifact*, unpublish_artifact*

**Attachments** (5): create_attachment*, list_attachments, delete_attachment*, get_attachment, update_attachment*

**Automatic Invoicing Rules** (5): create_automatic_invoicing_rule*, list_automatic_invoicing_rules, delete_automatic_invoicing_rule*, get_automatic_invoicing_rule, update_automatic_invoicing_rule*

**AWS Policies** (1): create_aws_policy*

**BankAccounts** (6): archive_bank_account*, create_bank_account*, list_bank_accounts, restore_bank_account*, get_bank_account, update_bank_account*

**BillItems** (5): create_bill_item*, list_bill_items, delete_bill_item*, get_bill_item, update_bill_item*

**Bills** (5): create_bill*, list_bills, delete_bill*, get_bill, update_bill*

**Bookings** (5): create_booking*, list_bookings, delete_booking*, get_booking, update_booking*

**Calendar events** (2): create_calendar_event*, list_calendar_events

**Comments** (9): add_reaction_comment*, create_comment*, list_comments, delete_comment*, get_comment, update_comment*, pin_comment*, remove_reaction_comment*, unpin_comment*

**Companies** (6): archive_company*, create_company*, list_companies, restore_company*, get_company, update_company*

**Connections** (5): accept_connection*, create_connection*, list_connections, delete_connection*, get_connection

**Contact Entries** (5): create_contact_entry*, list_contact_entries, delete_contact_entry*, get_contact_entry, update_contact_entry*

**Contracts** (8): bulk_generate_contracts*, create_contract*, list_contracts, delete_contract*, get_contract, update_contract*, generate_contract*, recalculate_rolled_over_time_contract*

**Custom domains** (6): create_custom_domain*, list_custom_domains, delete_custom_domain*, get_custom_domain, update_custom_domain*, verify_custom_domain*

**Custom Field Options** (5): archive_custom_field_option*, create_custom_field_option*, list_custom_field_options, get_custom_field_option, update_custom_field_option*

**Custom Fields** (5): archive_custom_field*, create_custom_field*, list_custom_fields, get_custom_field, update_custom_field*

**Custom Field Section** (5): archive_custom_field_section*, create_custom_field_section*, list_custom_field_sections, get_custom_field_section, update_custom_field_section*

**Dashboards** (6): copy_dashboard*, create_dashboard*, list_dashboards, delete_dashboard*, get_dashboard, update_dashboard*

**Deal Cost Rates** (5): create_deal_cost_rate*, list_deal_cost_rates, delete_deal_cost_rate*, get_deal_cost_rate, update_deal_cost_rate*

**Deal Cost Rates - Bulk** (1): bulk_delete_deal_cost_rates*

**Deals** (11): bulk_close_deals*, bulk_open_deals*, close_deal*, copy_deal*, create_deal*, list_deals, create_from_origin_deal*, delete_deal*, get_deal, update_deal*, open_deal*

**Deals - Bulk** (2): bulk_delete_deals*, bulk_update_deals*

**Deal Statuses** (7): archive_deal_status*, create_deal_status*, list_deal_statuses, delete_deal_status*, get_deal_status, update_deal_status*, merge_deal_status*

**Deleted Items** (3): list_deleted_items, restore_deleted_item*, get_deleted_item

**Discussions** (9): create_discussion*, list_discussions, delete_discussion*, get_discussion, update_discussion*, reopen_discussion*, resolve_discussion*, subscribe_discussion*, unsubscribe_discussion*

**Document Styles** (6): copy_document_style*, create_document_style*, list_document_styles, delete_document_style*, get_document_style, update_document_style*

**Document Types** (6): archive_document_type*, copy_document_type*, create_document_type*, list_document_types, get_document_type, update_document_type*

**E-invoice Identities** (4): create_einvoice_identity*, list_einvoice_identities, get_einvoice_identity, update_einvoice_identity*

**Email Links** (3): create_email_link*, list_email_links, delete_email_link*

**Emails** (5): attach_email*, delete_email*, get_email, dismiss_email*, list_emails

**Entitlements** (5): create_entitlement*, list_entitlements, delete_entitlement*, get_entitlement, update_entitlement*

**Events** (7): archive_event*, create_event*, list_events, delete_event*, get_event, update_event*, restore_event*

**Exchange Rates** (1): list_exchange_rates

**Expenses** (15): approve_expense*, check_export_status_expense, copy_expense*, create_expense*, list_expenses, delete_expense*, get_expense, update_expense*, download_datev_files_expense, export_expense*, export_update_expense*, reject_expense*, unapprove_expense*, unlink_purchase_order_expense*, unreject_expense*

**Expenses - Bulk** (5): bulk_approve_expenses*, bulk_delete_expenses*, bulk_update_expenses*, bulk_download_datev_files_expenses*, bulk_export_expenses*

**Export jobs** (1): get_export_job

**Filter Preferences** (6): create_filter_preference*, list_filter_preferences, delete_filter_preference*, get_filter_preference, increment_filter_preference*, track_filter_preference*

**Filters** (6): copy_filter*, create_filter*, list_filters, delete_filter*, get_filter, update_filter*

**Folders** (9): archive_folder*, copy_folder*, create_folder*, list_folders, move_folder*, reposition_folder*, restore_folder*, get_folder, update_folder*

**Holiday calendars** (6): list_holiday_calendar_countries, create_holiday_calendar*, list_holiday_calendars, delete_holiday_calendar*, get_holiday_calendar, update_holiday_calendar*

**Holidays** (5): create_holiday*, list_holidays, delete_holiday*, get_holiday, update_holiday*

**Imports** (8): create_import*, list_imports, create_flatfile_import*, import_from_harvest*, process_import*, revert_import*, get_import, update_import*

**Integration Exporter Configuration** (5): create_integration_exporter_configuration*, list_integration_exporter_configurations, delete_integration_exporter_configuration*, get_integration_exporter_configuration, update_integration_exporter_configuration*

**Integrations** (9): check_integration, check_dependencies_integration, connect_integration*, create_integration*, list_integrations, delete_integration*, get_integration, update_integration*, sync_integration

**Integration Task Management Configuration** (5): create_integration_task_management_configuration*, list_integration_task_management_configurations, delete_integration_task_management_configuration*, get_integration_task_management_configuration, update_integration_task_management_configuration*

**Invitations** (3): create_invitation*, get_invitation, update_invitation*

**Invoice Attributions** (7): create_invoice_attribution*, bulk_delete_invoice_attributions*, list_invoice_attributions, bulk_update_invoice_attributions*, delete_invoice_attribution*, get_invoice_attribution, update_invoice_attribution*

**Invoices** (17): check_export_status_invoice, copy_invoice*, create_invoice*, list_invoices, credit_note_invoice*, delete_invoice*, get_invoice, update_invoice*, download_datev_files_invoice, download_xml_invoice, export_invoice*, export_pdf_invoice*, export_update_invoice*, finalize_invoice*, preview_invoice, send_einvoice_invoice*, send_mail_invoice*

**Invoices - Bulk** (4): bulk_delete_invoices*, bulk_update_invoices*, bulk_download_datev_files_invoices*, bulk_export_invoices*

**Invoice Templates** (5): create_invoice_template*, list_invoice_templates, delete_invoice_template*, get_invoice_template, update_invoice_template*

**Job Role Rate Card** (7): archive_job_role_rate_card*, create_job_role_rate_card*, list_job_role_rate_cards, delete_job_role_rate_card*, get_job_role_rate_card, update_job_role_rate_card*, restore_job_role_rate_card*

**Job Role** (6): archive_job_role*, create_job_role*, list_job_roles, restore_job_role*, get_job_role, update_job_role*

**Line Items - Bulk** (3): bulk_create_line_items*, bulk_delete_line_items*, bulk_update_line_items*

**Line Items** (5): list_line_items, delete_line_item*, get_line_item, update_line_item*, generate_line_item*

**Lost Reasons** (5): archive_lost_reason*, create_lost_reason*, list_lost_reasons, get_lost_reason, update_lost_reason*

**Memberships** (5): create_membership*, list_memberships, delete_membership*, get_membership, update_membership*

**Notifications** (6): dismiss_notification*, list_notifications, read_notification*, get_notification, undismiss_notification*, unread_notification*

**Organization Champions** (4): create_organization_champion*, list_organization_champions, delete_organization_champion*, update_organization_champion*

**Organization Invoices** (4): list_organization_invoices, overdue_organization_invoice, get_organization_invoice, upcoming_organization_invoice

**Organization Membership Counts** (1): get_organization_membership_count

**Organization Memberships** (7): clear_notifications_organization_membership*, delete_organization_membership*, get_organization_membership, update_organization_membership*, dismiss_notifications_organization_membership*, list_organization_memberships, read_notifications_organization_membership*

**Organizations** (10): delete_organization*, get_organization, update_organization*, disable_scim_organization*, force_two_factor_login_organization*, generate_scim_token_organization*, list_organizations, resend_code_organization*, sample_revert_organization*, sample_organization*

**Organization Subscriptions** (7): allocate_seats_organization_subscription*, cancel_organization_subscription*, cancel_trial_organization_subscription*, reactivate_organization_subscription*, retry_last_payment_organization_subscription*, get_organization_subscription, update_organization_subscription*

**Overheads** (4): list_overheads, recalculate_overhead*, get_overhead, update_overhead*

**Pages** (16): convert_to_doc_page*, copy_page*, delete_page*, get_page, list_pages, move_page*, proxy_append_html_page*, proxy_append_markdown_page*, proxy_create_with_markdown_page*, proxy_replace_body_with_html_page*, proxy_replace_body_with_markdown_page*, publish_page*, template_apply_as_doc_page*, template_apply_as_target_page*, template_apply_on_parent_page*, unpublish_page*

**PageVersions** (4): create_page_version*, list_page_versions, get_page_version, update_page_version*

**Payment reminders** (6): copy_payment_reminder*, create_payment_reminder*, list_payment_reminders, delete_payment_reminder*, get_payment_reminder, update_payment_reminder*

**Payment reminder sequences** (5): create_payment_reminder_sequence*, list_payment_reminder_sequences, delete_payment_reminder_sequence*, get_payment_reminder_sequence, update_payment_reminder_sequence*

**Payments** (5): create_payment*, list_payments, delete_payment*, get_payment, update_payment*

**Payments - Bulk** (2): bulk_delete_payments*, bulk_update_payments*

**People** (13): activate_person*, archive_person*, create_person*, list_people, deactivate_person*, invite_person*, merge_person*, regenerate_recovery_codes_person*, resend_person*, restore_person*, get_person, update_person*, virtualize_person*

**Pipelines** (5): create_pipeline*, list_pipelines, delete_pipeline*, get_pipeline, update_pipeline*

**Placeholders** (5): create_placeholder*, list_placeholders, delete_placeholder*, get_placeholder, update_placeholder*

**Placeholder Usages** (5): create_placeholder_usage*, list_placeholder_usages, delete_placeholder_usage*, get_placeholder_usage, update_placeholder_usage*

**Prices** (5): create_price*, list_prices, delete_price*, get_price, update_price*

**Project Milestones** (5): create_project_milestone*, list_project_milestones, delete_project_milestone*, get_project_milestone, update_project_milestone*

**Project Preferences** (5): create_project_preference*, list_project_preferences, delete_project_preference*, get_project_preference, update_project_preference*

**Projects** (15): apply_navigation_tabs_project*, archive_project*, change_workflow_project*, copy_project*, create_project*, list_projects, delete_project*, get_project, update_project*, export_project*, export_update_project*, preferences_update_project*, restore_project*, subscribe_project*, unsubscribe_project*

**Proposals** (17): approve_proposal*, bulk_approve_proposals*, create_proposal*, list_proposals, delete_proposal*, get_proposal, update_proposal*, list_proposal_services, list_proposal_sessions, publish_proposal*, reject_proposal*, send_approval_mail_proposal*, send_proposal*, signed_pdf_proposal, sync_status_proposal, sync_proposal*, unapprove_proposal*

**Pulses** (6): create_pulse*, list_pulses, delete_pulse*, get_pulse, update_pulse*, send_pulse*

**Purchase Orders** (9): copy_purchase_order*, create_purchase_order*, list_purchase_orders, delete_purchase_order*, get_purchase_order, update_purchase_order*, export_purchase_order*, export_update_purchase_order*, send_mail_purchase_order*

**Purchase Orders - Bulk** (2): bulk_delete_purchase_orders*, bulk_update_purchase_orders*

**Rate cards** (8): archive_rate_card*, copy_rate_card*, create_rate_card*, list_rate_cards, delete_rate_card*, get_rate_card, update_rate_card*, restore_rate_card*

**Report Category** (5): create_report_category*, list_report_categories, delete_report_category*, get_report_category, update_report_category*

**Reports** (30): get_automation_reports, get_balancing_hour_reports, get_bill_reports, get_booking_reports, get_budget_reports, get_company_reports, get_deal_funnel_reports, get_deal_reports, get_entitlement_reports, get_expense_reports, get_financial_item_reports, get_invoice_reports, get_line_item_reports, get_page_reports, get_payment_reports, get_payroll_item_reports, get_person_reports, get_price_reports, get_project_milestone_reports, get_project_reports, get_proposal_reports, get_purchase_order_reports, get_resource_request_reports, get_salary_reports, get_service_reports, get_survey_reports, get_task_reports, get_time_entry_reports, get_time_reports, get_timesheet_reports

**Resource Requests** (8): cancel_resource_request*, create_resource_request*, list_resource_requests, delete_resource_request*, get_resource_request, update_resource_request*, reject_resource_request*, resolve_resource_request*

**Revenue Distributions** (5): create_revenue_distribution*, list_revenue_distributions, delete_revenue_distribution*, get_revenue_distribution, update_revenue_distribution*

**Permission Sets** (6): create_role*, list_roles, delete_role*, get_role, update_role*, transfer_people_role*

**Salaries** (6): create_salary*, list_salaries, delete_salary*, get_salary, update_salary*, set_default_salary*

**Scenario Bookings** (5): create_scenario_booking*, list_scenario_bookings, delete_scenario_booking*, get_scenario_booking, update_scenario_booking*

**Scenario Items** (5): create_scenario_item*, list_scenario_items, delete_scenario_item*, get_scenario_item, update_scenario_item*

**Scenarios** (8): copy_scenario*, create_scenario*, list_scenarios, delete_scenario*, get_scenario, update_scenario*, overwrite_scenario*, sync_scenario*

**Scenario Sections** (5): create_scenario_section*, list_scenario_sections, delete_scenario_section*, get_scenario_section, update_scenario_section*

**Scenario Services** (5): create_scenario_service*, list_scenario_services, delete_scenario_service*, get_scenario_service, update_scenario_service*

**Sections** (5): create_section*, list_sections, delete_section*, get_section, update_section*

**Service Assignments** (5): create_service_assignment*, list_service_assignments, delete_service_assignment*, get_service_assignment, update_service_assignment*

**Service Assignments - Bulk** (1): bulk_delete_service_assignments*

**Services** (6): create_service*, list_services, delete_service*, get_service, update_service*, move_service*

**Services - Bulk** (2): bulk_delete_services*, bulk_update_services*

**Service Suggestions** (1): list_service_suggestions

**Service Type Assignments** (5): create_service_type_assignment*, list_service_type_assignments, delete_service_type_assignment*, get_service_type_assignment, update_service_type_assignment*

**Service Type Assignments - Bulk** (1): bulk_delete_service_type_assignments*

**Service Types** (7): archive_service_type*, create_service_type*, list_service_types, merge_service_type*, restore_service_type*, get_service_type, update_service_type*

**Skills** (5): create_skill*, list_skills, delete_skill*, get_skill, update_skill*

**Subsidiaries** (5): archive_subsidiary*, create_subsidiary*, list_subsidiaries, get_subsidiary, update_subsidiary*

**Survey Field Options** (5): archive_survey_field_option*, create_survey_field_option*, list_survey_field_options, get_survey_field_option, update_survey_field_option*

**Survey Fields** (5): archive_survey_field*, create_survey_field*, list_survey_fields, get_survey_field, update_survey_field*

**Survey Responses** (4): create_survey_response*, list_survey_responses, delete_survey_response*, get_survey_response

**Surveys** (6): copy_survey*, create_survey*, list_surveys, delete_survey*, get_survey, update_survey*

**Tags** (2): list_tags, get_tag

**TaskDependency** (5): create_task_dependency*, list_task_dependencies, delete_task_dependency*, get_task_dependency, update_task_dependency*

**Task Lists** (9): archive_task_list*, copy_task_list*, create_task_list*, list_task_lists, move_task_list*, reposition_task_list*, restore_task_list*, get_task_list, update_task_list*

**Tasks** (8): copy_task*, create_task*, list_tasks, delete_task*, get_task, update_task*, move_dependent_task*, reposition_task*

**Tasks - Bulk** (2): bulk_delete_tasks*, bulk_update_tasks*

**TaxRates** (6): archive_tax_rate*, create_tax_rate*, list_tax_rates, restore_tax_rate*, get_tax_rate, update_tax_rate*

**Team Memberships** (4): create_team_membership*, list_team_memberships, delete_team_membership*, get_team_membership

**Teams** (5): create_team*, list_teams, delete_team*, get_team, update_team*

**Templates** (6): copy_template*, create_template*, list_templates, delete_template*, get_template, update_template*

**Time Entries** (12): approve_time_entry*, bulk_create_time_entries*, list_time_entries, delete_time_entry*, get_time_entry, update_time_entry*, mark_as_invoiced_time_entry*, reject_time_entry*, start_time_entry*, stop_time_entry*, unapprove_time_entry*, unreject_time_entry*

**Time Entries - Bulk** (4): bulk_approve_update_time_entries*, bulk_delete_time_entries*, bulk_update_time_entries*, bulk_unapprove_update_time_entries*

**Time Entry Versions** (2): list_time_entry_versions, get_time_entry_version

**Timers** (4): create_timer*, list_timers, get_timer, stop_timer*

**Timesheets** (4): create_timesheet*, list_timesheets, delete_timesheet*, get_timesheet

**Time Tracking Policies** (7): archive_time_tracking_policy*, create_time_tracking_policy*, list_time_tracking_policies, delete_time_tracking_policy*, get_time_tracking_policy, update_time_tracking_policy*, restore_time_tracking_policy*

**Todos** (5): create_todo*, list_todos, delete_todo*, get_todo, update_todo*

**Users** (4): delete_user*, get_user, update_user*, list_users

**Webhook Logs** (1): list_webhook_logs

**Webhooks** (9): activate_webhook*, create_webhook*, list_webhooks*, deactivate_webhook*, delete_webhook*, get_webhook*, update_webhook*, regenerate_webhook_signing_secret*, send_webhook_test*

**Widgets** (6): create_widget*, list_widgets, delete_widget*, get_widget, update_widget*, move_widget*

**Widgets - Bulk** (1): bulk_update_widgets*

**Workflows** (8): archive_workflow*, copy_workflow*, create_workflow*, list_workflows, delete_workflow*, get_workflow, update_workflow*, restore_workflow*

**Workflow Statuses** (5): create_workflow_status*, list_workflow_statuses, delete_workflow_status*, get_workflow_status, update_workflow_status*
