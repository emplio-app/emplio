# Linear coverage

Source: Linear's GraphQL schema (github.com/linear/linear, packages/sdk/src/schema.graphql), generated 2026-11-22 by
`bun scripts/openapi/linear.ts`. Linear has no OpenAPI spec; every query (154) and mutation (324) in the schema is an
action, 478 in all, plus four hand-written ones and Composio's 41 names as aliases (523 names). Composio's
toolkit has 48 actions and 12 triggers; we match all but one action and every trigger.

## Deliberately left out

| What | Why |
| --- | --- |
| 17 deprecated queries and mutations: attachmentIssue, roadmap*, cycleCreate, integrationIntercomSettingsUpdate, integrationLoom, notificationSubscriptionDelete, organizationStartTrial, projectArchive, projectUpdateDelete | Linear marks them deprecated; each has a replacement (projectDelete, projectUpdateArchive, initiatives for roadmaps…). Cycles are made by the team's cycle settings |
| Subscriptions | Linear's GraphQL subscriptions are for its own apps; webhooks cover the same events |
| Composio's list_issue_drafts | Linear's public API has no issue drafts |
| OAuthApp "revoked" webhook event | Only sent to OAuth apps; we sign in with a key |
| OAuth sign-in | Not built in this run (key only). Linear offers OAuth 2 (linear.app/settings/api/applications) for later |

Some mutations only work for OAuth apps or agents (agentActivityCreate, createAsUser…) or for admins; Linear answers those
with its own error.

## Hand adjustments (scripts/openapi/linear.ts, own/linear/index.ts)

- A call's single `input` object (IssueCreateInput…) has its fields offered as the action's own and put back on the way
  out, unless a name clashes. On `*Update` mutations plain fields take null, to clear them (unassign).
- What comes back by default: the type's plain fields and its references as id and name; a mutation's record in full;
  lists as nodes plus pageInfo. `select` replaces it with any GraphQL selection (checked to stay inside its field).
  Fields named like secrets or tokens are never in the default.
- Filters and other nested inputs below the first level are free-form objects whose description lists their fields.
- Hand-written: run_graphql_query (reads only, refuses mutations), run_query_or_mutation*, upload_file* (fileUpload, then
  the PUT with Linear's headers; answers the assetUrl), download_file (uploads.linear.app only, so the key goes nowhere else).
- Errors Linear sends with a 200 or 400 become errors; a partial answer keeps them in `errors`. An authentication error
  marks the connection expired.

## Auth

| Method | Status |
| --- | --- |
| Personal API key (linear.app/settings/account/security), sent as `Authorization: <key>` | done |
| OAuth 2 | not built (key only by decision) |

## Triggers

Webhooks (own/linear/triggers.ts), made with webhookCreate, which needs an admin's key. One webhook per connection and
scope at `/webhooks/app/linear/<connection>/<scope>`: `all` (every public team), a team id (`team_id`, needed for private
teams), or `audit` (AuditEntry must be alone on its webhook). Each trigger adds its resource type; the last automation
removes the webhook. Signed with Linear-Signature (HMAC-SHA256 of the body, secret an HMAC of ENCRYPTION_KEY and the
connection, never stored); Linear-Delivery is the delivery id. No webhookTimestamp age check, so Linear's retries
still land.

Settings: team_id, action, field (changed field), issue (ENG-12 or id), project_id, assignee_id, state (status name),
label (name), where they apply.

| Resource type | Triggers |
| --- | --- |
| Issue | issue_created_trigger, public_team_issue_created, private_team_issue_created, issue_updated_trigger, public_team_issue_properties_updated, private_team_issue_properties_updated, issue_status_changed_trigger, issue_assigned_trigger, issue_completed_trigger, issue_removed_trigger |
| Comment | comment_event_trigger, comment_created_trigger, public_team_comment_created, private_team_comment_created, comment_updated_trigger, comment_removed_trigger |
| Attachment, IssueLabel, IssueSLA, Reaction | attachment_event_trigger, issue_label_event_trigger, issue_sla_event_trigger, reaction_event_trigger |
| Project, ProjectUpdate, ProjectLabel | project_created, project_properties_updated, project_removed_trigger, project_update_posted, project_update_event_trigger, project_label_event_trigger |
| Cycle, Document, Initiative, InitiativeUpdate | cycle_event_trigger, document_event_trigger, initiative_event_trigger, initiative_update_posted, initiative_update_event_trigger |
| Customer, CustomerNeed | customer_event_trigger, customer_request_event_trigger |
| User, Release, ReleaseNote, AuditEntry | user_event_trigger, release_event_trigger, release_note_event_trigger, audit_entry_created (Enterprise) |

Polled (polls/linear.ts, every 5 minutes, no admin needed): new_issue, issue_changed, issue_done, new_comment,
new_project, new_project_update.

## Actions by group (* asks first)

**hand-written** (4): run_graphql_query, run_query_or_mutation*, upload_file*, download_file

**Composio's names** (41, aliases): archive_issue, archive_project (project_delete), archive_project_update,
create_attachment, create_comment_reaction, create_linear_comment, create_linear_issue, create_linear_issue_relation,
create_linear_label, create_linear_project, create_project_milestone, create_project_update, create_team,
delete_linear_issue, get_all_linear_teams, get_current_user, get_cycles_by_team_id, get_issue_defaults (get_team),
get_linear_issue, get_linear_project, list_issues_by_team_id, list_linear_cycles, list_linear_issues,
list_linear_labels, list_linear_projects, list_linear_states, list_linear_teams, list_linear_users, remove_issue_label,
remove_reaction, resolve_comment, search_issues, unarchive_project_update, unresolve_comment, update_issue,
update_linear_comment, update_linear_project, update_project_update, update_team, validate_credential, who_am_i

**administrable** (1): list_administrable_teams

**agent** (14): list_agent_activities, get_agent_activity, get_agent_session, list_agent_sessions, get_agent_skill, list_agent_skills, agent_activity_create*, agent_session_create_on_comment*, agent_session_create_on_issue*, agent_session_update*, agent_session_update_external_url*, agent_skill_create*, agent_skill_delete*, agent_skill_update*

**airbyte** (1): airbyte_integration_connect*

**application** (1): get_application_info

**archived** (1): get_archived_integrations

**attachment** (17): get_attachment, get_attachment_sources, attachment_create*, attachment_delete*, attachment_link_discord*, attachment_link_front*, attachment_link_git_hub_issue*, attachment_link_git_hub_pr*, attachment_link_git_lab_mr*, attachment_link_intercom*, attachment_link_jira_issue*, attachment_link_salesforce*, attachment_link_slack*, attachment_link_url*, attachment_link_zendesk*, attachment_sync_to_slack*, attachment_update*

**attachments** (2): list_attachments, list_attachments_for_url

**audit** (2): list_audit_entries, get_audit_entry_types

**authentication** (1): get_authentication_sessions

**available** (1): get_available_users

**comment** (6): get_comment, comment_create*, comment_delete*, comment_resolve*, comment_unresolve*, comment_update*

**comments** (1): list_comments

**contact** (1): contact_create*

**create** (3): create_csv_export_report*, create_initiative_update_reminder*, create_project_update_reminder*

**custom** (6): get_custom_view, get_custom_view_has_subscribers, list_custom_views, custom_view_create*, custom_view_delete*, custom_view_update*

**customer** (25): get_customer, get_customer_need, list_customer_needs, get_customer_status, list_customer_statuses, get_customer_tier, list_customer_tiers, customer_create*, customer_delete*, customer_merge*, customer_need_archive*, customer_need_create*, customer_need_create_from_attachment*, customer_need_delete*, customer_need_unarchive*, customer_need_update*, customer_status_create*, customer_status_delete*, customer_status_update*, customer_tier_create*, customer_tier_delete*, customer_tier_update*, customer_unsync*, customer_update*, customer_upsert*

**customers** (1): list_customers

**cycle** (5): get_cycle, cycle_archive*, cycle_shift_all*, cycle_start_upcoming_cycle_today*, cycle_update*

**cycles** (1): list_cycles

**dependency** (1): get_dependency_package_metadata

**document** (7): get_document, get_document_content_history, document_create*, document_delete*, document_unarchive*, document_update*, document_update_workspace_access*

**documents** (1): list_documents

**email** (10): get_email_intake_address, list_email_intake_addresses, email_intake_address_create*, email_intake_address_delete*, email_intake_address_refresh_ses_domain_status*, email_intake_address_rotate*, email_intake_address_update*, email_token_user_account_auth*, email_unsubscribe*, email_user_account_auth_challenge*

**emoji** (3): get_emoji, emoji_create*, emoji_delete*

**emojis** (1): list_emojis

**entity** (4): get_entity_external_link, entity_external_link_create*, entity_external_link_delete*, entity_external_link_update*

**external** (2): get_external_user, list_external_users

**favorite** (4): get_favorite, favorite_create*, favorite_delete*, favorite_update*

**favorites** (1): list_favorites

**file** (2): file_upload*, file_upload_dangerously_delete*

**git** (6): git_automation_state_create*, git_automation_state_delete*, git_automation_state_update*, git_automation_target_branch_create*, git_automation_target_branch_delete*, git_automation_target_branch_update*

**google** (1): google_user_account_auth*

**image** (1): image_upload_from_url*

**import** (1): import_file_upload*

**inbox** (2): list_inbox_notifications, inbox_notification_update*

**initiative** (32): get_initiative, get_initiative_filter_suggestion, get_initiative_label, list_initiative_labels, get_initiative_relation, list_initiative_relations, get_initiative_to_project, list_initiative_to_projects, get_initiative_update, list_initiative_updates, initiative_add_label*, initiative_archive*, initiative_create*, initiative_delete*, initiative_label_create*, initiative_label_delete*, initiative_label_restore*, initiative_label_retire*, initiative_label_update*, initiative_relation_create*, initiative_relation_delete*, initiative_relation_update*, initiative_remove_label*, initiative_to_project_create*, initiative_to_project_delete*, initiative_to_project_update*, initiative_unarchive*, initiative_update*, initiative_update_archive*, initiative_update_create*, initiative_update_unarchive*, initiative_update_update*

**initiatives** (1): list_initiatives

**integration** (45): get_integration, get_integration_has_scopes, get_integration_template, list_integration_templates, integration_archive*, integration_asks_connect_channel*, integration_delete*, integration_discord*, integration_figma*, integration_front*, integration_git_hub_enterprise_server_connect*, integration_git_hub_personal*, integration_github_commit_create*, integration_github_connect*, integration_github_import_connect*, integration_github_import_refresh*, integration_github_remove_code_access*, integration_gitlab_connect*, integration_gitlab_rotate*, integration_gitlab_test_connection*, integration_gitlab_update_rotation_settings*, integration_gitlab_update_token*, integration_gong*, integration_google_sheets*, integration_intercom*, integration_intercom_delete*, integration_jira_personal*, integration_microsoft_personal_connect*, integration_microsoft_teams*, integration_request*, integration_salesforce*, integration_sentry_connect*, integration_slack*, integration_slack_asks*, integration_slack_custom_view_notifications*, integration_slack_customer_channel_link*, integration_slack_import_emojis*, integration_slack_or_asks_update_slack_team_name*, integration_slack_org_project_updates_post*, integration_slack_personal*, integration_slack_post*, integration_slack_project_post*, integration_template_create*, integration_template_delete*, integration_zendesk*

**integrations** (4): list_integrations, get_integrations_settings, integrations_settings_create*, integrations_settings_update*

**issue** (51): get_issue, list_issue_figma_file_key_search, get_issue_filter_suggestion, get_issue_import_check_csv, get_issue_import_check_sync, get_issue_import_jql_check, get_issue_label, list_issue_labels, get_issue_priority_values, get_issue_relation, list_issue_relations, get_issue_repository_suggestions, list_issue_search, get_issue_title_suggestion_from_customer_request, get_issue_to_release, list_issue_to_releases, get_issue_vcs_branch_search, issue_add_label*, issue_archive*, issue_batch_create*, issue_batch_update*, issue_create*, issue_delete*, issue_external_sync_disable*, issue_import_create_asana*, issue_import_create_csv_jira*, issue_import_create_clubhouse*, issue_import_create_github*, issue_import_create_jira*, issue_import_delete*, issue_import_process*, issue_import_update*, issue_label_create*, issue_label_delete*, issue_label_restore*, issue_label_retire*, issue_label_update*, issue_relation_create*, issue_relation_delete*, issue_relation_update*, issue_reminder*, issue_remove_label*, issue_share*, issue_subscribe*, issue_to_release_create*, issue_to_release_delete*, issue_to_release_delete_by_issue_and_release*, issue_unarchive*, issue_unshare*, issue_unsubscribe*, issue_update*

**issues** (1): list_issues

**jira** (3): get_jira_project, list_jira_projects, jira_project_batch_migrate*

**latest** (1): get_latest_release_by_access_key

**logout** (4): logout*, logout_all_sessions*, logout_other_sessions*, logout_session*

**notification** (14): get_notification, get_notification_subscription, list_notification_subscriptions, notification_archive*, notification_archive_all*, notification_category_channel_subscription_update*, notification_mark_read_all*, notification_mark_unread_all*, notification_snooze_all*, notification_subscription_create*, notification_subscription_update*, notification_unarchive*, notification_unsnooze_all*, notification_update*

**notifications** (1): list_notifications

**oauth** (8): get_oauth_application, get_oauth_application_coding_session_trusted_source, get_oauth_applications, oauth_application_archive*, oauth_application_create*, oauth_application_rotate_secret*, oauth_application_rotate_webhook_secret*, oauth_application_update*

**organization** (14): get_organization, get_organization_exists, get_organization_invite, get_organization_invite_details, list_organization_invites, organization_cancel_delete*, organization_delete*, organization_delete_challenge*, organization_domain_delete*, organization_invite_create*, organization_invite_delete*, organization_invite_update*, organization_start_trial_for_plan*, organization_update*

**project** (39): get_project, get_project_filter_suggestion, get_project_label, list_project_labels, get_project_milestone, list_project_milestones, get_project_relation, list_project_relations, get_project_status, list_project_statuses, get_project_update, list_project_updates, project_add_label*, project_create*, project_delete*, project_external_sync_disable*, project_label_create*, project_label_delete*, project_label_restore*, project_label_retire*, project_label_update*, project_milestone_create*, project_milestone_delete*, project_milestone_move*, project_milestone_update*, project_relation_create*, project_relation_delete*, project_relation_update*, project_remove_label*, project_status_archive*, project_status_create*, project_status_unarchive*, project_status_update*, project_unarchive*, project_update*, project_update_archive*, project_update_create*, project_update_unarchive*, project_update_update*

**projects** (1): list_projects

**push** (3): get_push_subscription_test, push_subscription_create*, push_subscription_delete*

**quotas** (1): list_quotas

**rate** (1): get_rate_limit_status

**reaction** (2): reaction_create*, reaction_delete*

**recent** (1): get_recent_releases_by_access_key

**refresh** (1): refresh_google_sheets_data*

**release** (32): get_release, get_release_note, list_release_notes, get_release_pipeline, get_release_pipeline_by_access_key, list_release_pipelines, get_release_search, get_release_stage, list_release_stages, release_archive*, release_complete*, release_complete_by_access_key*, release_create*, release_delete*, release_note_create*, release_note_delete*, release_note_update*, release_pipeline_archive*, release_pipeline_create*, release_pipeline_delete*, release_pipeline_unarchive*, release_pipeline_update*, release_stage_archive*, release_stage_create*, release_stage_unarchive*, release_stage_update*, release_sync*, release_sync_by_access_key*, release_unarchive*, release_update*, release_update_by_pipeline*, release_update_by_pipeline_by_access_key*

**releases** (1): list_releases

**resend** (2): resend_organization_invite*, resend_organization_invite_by_email*

**roadmap** (3): roadmap_to_project_create*, roadmap_to_project_delete*, roadmap_to_project_update*

**saml** (1): saml_token_user_account_auth*

**search** (3): list_search_documents, list_search_issues, list_search_projects

**semantic** (1): get_semantic_search

**sla** (1): get_sla_configurations

**sso** (1): get_sso_url_from_email

**team** (12): get_team, get_team_membership, list_team_memberships, team_create*, team_cycles_delete*, team_delete*, team_key_delete*, team_membership_create*, team_membership_delete*, team_membership_update*, team_unarchive*, team_update*

**teams** (1): list_teams

**template** (5): get_template, get_template_search, template_create*, template_delete*, template_update*

**templates** (2): get_templates, get_templates_for_integration

**time** (7): get_time_schedule, list_time_schedules, time_schedule_create*, time_schedule_delete*, time_schedule_refresh_integration_schedule*, time_schedule_update*, time_schedule_upsert_external*

**track** (1): track_anonymous_event*

**triage** (5): list_triage_responsibilities, get_triage_responsibility, triage_responsibility_create*, triage_responsibility_delete*, triage_responsibility_update*

**usage** (2): get_usage_alert, list_usage_alerts

**user** (16): get_user, get_user_sessions, get_user_settings, get_user_view_preferences, user_change_role*, user_discord_connect*, user_external_user_disconnect*, user_flag_update*, user_revoke_all_sessions*, user_revoke_session*, user_settings_flags_reset*, user_settings_update*, user_suspend*, user_unlink_from_identity_provider*, user_unsuspend*, user_update*

**users** (1): list_users

**verify** (1): get_verify_git_hub_enterprise_server_installation

**view** (3): view_preferences_create*, view_preferences_delete*, view_preferences_update*

**viewer** (1): get_viewer

**webhook** (5): get_webhook, webhook_create*, webhook_delete*, webhook_rotate_secret*, webhook_update*

**webhooks** (1): list_webhooks

**workflow** (5): get_workflow_state, list_workflow_states, workflow_state_archive*, workflow_state_create*, workflow_state_update*
