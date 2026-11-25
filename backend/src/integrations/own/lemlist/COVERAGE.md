# lemlist coverage

Source: lemlist's official OpenAPI spec, developer.lemlist.com/api-reference/openapi/v2.json (linked from
developer.lemlist.com/llms.txt), generated 2026-11-22 by `bun scripts/openapi-actions.ts lemlist`. Every operation in it
is an action (240) except the 8 lemlist marks deprecated.

## Deliberately left out

| What | Why |
| --- | --- |
| GET /campaigns/{campaignId}/export/leads | Marked deprecated by lemlist (replaced, see below) |
| POST /campaigns/{campaignId}/leads/{leadIdOrEmail}/steps/{stepId}/skip | Marked deprecated by lemlist (replaced, see below) |
| GET /tasks | Marked deprecated by lemlist (replaced, see below) |
| GET /lemwarm/errors | Marked deprecated by lemlist (replaced, see below) |
| POST /lemwarm/{userMailboxId}/start | Marked deprecated by lemlist (replaced, see below) |
| POST /lemwarm/{userMailboxId}/pause | Marked deprecated by lemlist (replaced, see below) |
| GET /lemwarm/{userMailboxId}/settings | Marked deprecated by lemlist (replaced, see below) |
| PATCH /lemwarm/{userMailboxId}/settings | Marked deprecated by lemlist (replaced, see below) |
| Composio's get_people_schema, get_companies_schema | Not in lemlist's current API; get_database_filters lists the fields the people and companies databases search on |
| Composio's get_user_info (the signed-in user) | No such call in lemlist's spec; get_team_info lists the team's users and get_user reads one |
| New contacts and new tasks, polled | lemlist's lists of contacts and tasks can't be sorted by creation date, so a poll can't tell what's new. Contacts that enter a campaign show up as lead events by webhook; lead_annotated covers notes |
| OAuth sign-in | Not in this job: key sign-in only (lemlist's CLI signs in with OAuth, but there's no public app registration for it) |

Replacements for the deprecated calls: export_campaign_leads (v2), skip_step_for_leads, search_tasks (v2 tasks),
and the warmup calls (get_warmup_errors, start_warmup, pause_warmup, get_warmup_settings, update_warmup_settings) for lemwarm's.

Composio's other unmatched names are the same calls under our names. Most only add the HTTP method to ours:
post_create_campaign = create_campaign, patch_update_campaign = update_campaign, post_create_lead_in_campaign =
create_lead_in_campaign, post_pause_lead = pause_lead, post_mark_lead_as_interested(_in_campaign) =
mark_lead_as_interested(_in_campaign), post_add_variables_to_lead = add_custom_variables_on_leads,
post_add_unsubscribe_email_domain = unsubscribe_variable, delete_delete_unsubscribe_email = re_subscribe_variable,
get_get_unsubscribe_email = get_unsubscribed_variable, get_retrieve_unsubscribes = list_unsubscribed_variables,
get_export_unsubscribes = export_unsubscribed_variables, delete_delete_schedule = delete_schedule,
delete_unsubscribe_lead_from_campaign = unsubscribe_lead_from_campaign_by_email, get_list_campaigns = get_many_campaigns,
get_list_tasks = search_tasks, get_list_team_senders = get_team_senders, get_list_watchlist_signals =
get_signal_agent_signals, get_retrieve_activities = get_many_activities, get_retrieve_lead_by_email = get_lead_by_email,
get_lead_by_id = get_lead_by_email_or_id, get_campaign_export_start = start_campaign_stats_export,
get_export_campaign_leads = export_campaign_leads, get_lemwarm_settings = get_warmup_settings,
add_contacts_to_list = add_or_remove_contacts_in_list, and so on.

## Hand adjustments (scripts/openapi/lemlist.ts, own/lemlist/index.ts)

- Base `https://api.lemlist.com/api`; v2 calls keep their `/v2/...` paths. Basic auth with an empty login and the key as password.
- Most operations have no operationId: one is made from the summary (from the path when two summaries match).
- Names follow Composio's where it has a clean name for the same call (get_campaign_by_id, list_contacts, upsert_contact,
  send_inbox_email, get_all_webhooks...); "A/B" calls are named *_ab_test_*.
- Lookups that are POSTs run without asking: search_people_database, search_linked_in_post_engagers,
  search_companies_database, get_batch_campaign_stats, search_domains.
- get_team_info asks first: it answers with the team's Slack notification address.

## Auth

| Method | Status |
| --- | --- |
| API key (lemlist → Settings → Integrations → API), basic auth with an empty login | done |
| Webhooks need the key's user to have the "Edit integrations" permission | noted in the key help |

## Triggers

Composio has no lemlist triggers.

**Webhook** (79), one all-events webhook per connection (lemlist allows one webhook per address), checked by the
`secret` lemlist echoes in each body. Each can be narrowed to one campaign (campaign_id) or one sender (sender_id):
lead_contacted (contacted), lead_opened (hooked), lead_clicked (attracted), lead_replied (warmed), lead_interested (interested), lead_not_interested (notInterested), email_sent (emailsSent), email_opened (emailsOpened), email_clicked (emailsClicked), email_replied (emailsReplied), email_bounced (emailsBounced), email_failed (emailsFailed), email_interested (emailsInterested), email_not_interested (emailsNotInterested), email_unsubscribed (emailsUnsubscribed), contact_unsubscribed (entityUnsubscribed), variable_unsubscribed (variableUnsubscribed), linkedin_sent (linkedinSent), linkedin_opened (linkedinOpened), linkedin_replied (linkedinReplied), linkedin_interested (linkedinInterested), linkedin_not_interested (linkedinNotInterested), linkedin_send_failed (linkedinSendFailed), linkedin_visit_done (linkedinVisitDone), linkedin_visit_failed (linkedinVisitFailed), linkedin_follow_done (linkedinFollowDone), linkedin_follow_failed (linkedinFollowFailed), linkedin_follow_skipped (linkedinFollowSkipped), linkedin_invite_sent (linkedinInviteDone), linkedin_invite_failed (linkedinInviteFailed), linkedin_invite_accepted (linkedinInviteAccepted), linkedin_endorse_done (linkedinEndorseDone), linkedin_endorse_failed (linkedinEndorseFailed), linkedin_endorse_skipped (linkedinEndorseSkipped), linkedin_voice_note_sent (linkedinVoiceNoteDone), linkedin_voice_note_failed (linkedinVoiceNoteFailed), linkedin_like_post_done (linkedinLikeLastPostDone), linkedin_like_post_no_post (linkedinLikeLastPostNoPost), linkedin_like_post_failed (linkedinLikeLastPostFailed), linkedin_invite_withdrawn (linkedinWithdrawInvitationDone), linkedin_invite_withdraw_failed (linkedinWithdrawInvitationFailed), whatsapp_sent (whatsappMessageSent), whatsapp_delivered (whatsappMessageDelivered), whatsapp_opened (whatsappMessageOpened), whatsapp_replied (whatsappReplied), whatsapp_failed (whatsappMessageFailed), sms_sent (smsSent), sms_delivered (smsDelivered), sms_replied (smsReplied), sms_failed (smsFailed), call_started (aircallCreated), call_ended (aircallEnded), call_task_done (aircallDone), call_interested (aircallInterested), call_not_interested (aircallNotInterested), call_recording_ready (callRecordingDone), call_transcript_ready (callTranscriptDone), api_step_done (apiDone), api_interested (apiInterested), api_not_interested (apiNotInterested), api_step_failed (apiFailed), manual_interested (manualInterested), manual_not_interested (manualNotInterested), lead_annotated (annotated), lead_paused (paused), lead_resumed (resumed), lead_stopped (stopped), campaign_completed (campaignComplete), custom_domain_error (customDomainErrors), mailbox_connection_issue (connectionIssue), send_limit_reached (sendLimitReached), warmup_paused (lemwarmPaused), enrichment_done (enrichmentDone), enrichment_failed (enrichmentError), contact_sourcing_done (contactSourcingDone), contact_sourcing_failed (contactSourcingFailed), inbox_label_changed (inboxLabelUpdated), new_signal (signalRegistered), deliverability_alert (deliverabilityAlertTriggered)

**Polled** (2, polls/lemlist.ts): new_campaign, new_company (optionally one company list).

## Limits

- 20 requests per 2 seconds per key. A team holds at most 200 webhooks, disabled ones included.
- API access, LinkedIn, WhatsApp, calls, the people database and enrichment depend on the team's lemlist plan and credits;
  a call the plan lacks fails with lemlist's own message.

## Actions by group (* asks first)

**Self-recovery** (3): get_self_recovery_config, update_self_recovery_config*, list_self_recovery_history

**Message templates** (3): list_message_templates, list_message_template_tags, get_message_template

**Snippets** (2): list_snippets, get_snippet

**Team** (4): get_team_info*, get_team_senders, get_team_credits, get_team_crm_users

**Senders** (10): get_team_sender_exclusions, replace_team_sender_exclusions*, list_senders, get_campaign_senders, add_campaign_senders*, replace_campaign_senders*, update_campaign_sender_channels*, remove_campaign_sender*, get_campaign_sender_exclusions, replace_campaign_sender_exclusions*

**Users** (7): get_user, get_user_channels, get_sending_settings, update_sending_settings*, update_user_linked_in_limits*, get_user_signature, update_user_signature*

**Campaigns** (22): get_many_campaigns, create_campaign*, get_campaign_by_id, update_campaign*, get_campaign_settings, update_campaign_settings*, pause_campaign*, archive_campaign*, unarchive_campaign*, skip_step_for_everyone*, add_abm_campaign_leads*, skip_step_for_leads*, start_campaign*, start_campaign_stats_export, get_campaign_export_status, set_email_for_campaign_export_notification*, export_campaign_leads, get_campaign_reports, get_campaign_stats, get_batch_campaign_stats, duplicate_campaign*, get_campaign_statutes

**Signal Agents** (15): add_signal_agent_trigger*, remove_signal_agent_trigger*, get_signal_agent_signals, mark_signals_handled_or_ignored*, push_external_signals*, list_signal_agents, create_signal_agent*, update_signal_agent*, delete_signal_agent*, monitor_crm_lists_with_signal_agent*, get_signal_agent_configuration_history, list_available_signal_types, list_allowed_filters_per_signal_type, list_linked_in_profile_views_members, autocomplete_filter_values

**Sequences** (17): get_campaign_sequences, add_step_to_sequence*, update_sequence_step*, delete_sequence_step*, list_condition_branches, add_condition_branch*, reorder_condition_branches*, update_condition_branch*, delete_condition_branch*, get_step_sender, set_step_sender*, remove_step_sender*, create_ab_test_variant*, get_ab_test_variant, update_ab_test_variant*, delete_ab_test_variant*, select_ab_test_winner*

**Schedules** (7): get_many_schedules, create_schedule*, get_schedule, update_schedule*, delete_schedule*, get_campaign_schedules, associate_schedule_with_campaign*

**Leads** (23): get_lead_by_email_or_id, get_lead_by_email, get_campaign_leads, create_lead_in_campaign*, unsubscribe_lead_from_campaign*, update_campaign_lead*, delete_or_unsubscribe_lead*, unsubscribe_lead_from_campaign_by_email*, resume_paused_lead*, pause_lead*, launch_lead*, mark_lead_as_interested*, mark_lead_as_not_interested*, mark_lead_as_interested_in_campaign*, mark_lead_as_not_interested_in_campaign*, personalize_step_for_lead*, reset_step_personalization_for_lead*, add_custom_variables_on_leads*, update_values_of_custom_variables_of_lead*, erase_values_of_custom_variables_on_lead*, upload_audio_for_voice_message_step*, get_crm_filters, import_leads_from_crm*

**CRMs** (1): get_crm_logs

**People Database** (14): get_database_filters, search_people_database, search_linked_in_post_engagers, search_companies_database, export_people_database_search, export_companies_database_search, list_personas, create_persona*, delete_persona*, list_saved_searches, create_saved_search*, get_saved_search, update_saved_search*, delete_saved_search*

**Tasks** (5): search_tasks, list_task_filters, create_task*, update_task*, ignore_tasks*

**Inbox** (16): list_inbox_conversations, get_contact_messages, send_inbox_email*, send_linked_in_message*, send_whats_app_message*, send_sms_message*, list_labels, create_label*, get_label, attach_labels_to_conversations*, remove_labels_from_conversation*, list_drafts, create_draft*, get_draft, update_draft*, delete_draft*

**Contacts** (13): list_contacts, upsert_contact*, merge_contacts*, search_connect_contacts_in_crm*, create_contacts_in_crm*, delete_contact*, get_contact, get_contact_notes, create_contact_note*, list_contact_lists, create_contact_list*, add_or_remove_contacts_in_list*, export_contact_list

**warmup** (5): get_warmup_errors, start_warmup*, pause_warmup*, get_warmup_settings, update_warmup_settings*

**Companies** (13): list_companies, upsert_company*, get_company_lists, create_company_list*, add_or_remove_companies_in_list*, merge_companies*, search_connect_companies_in_crm*, create_companies_in_crm*, get_company, delete_company*, list_company_notes, create_company_note*, engage_company*

**Activities** (2): get_many_activities, delete_activity_recording_transcript*

**Calls** (4): log_call*, get_call, update_call*, get_call_statuses

**Unsubscribes** (10): list_unsubscribed_variables, bulk_unsubscribe_variables*, get_unsubscribed_variable, unsubscribe_variable*, re_subscribe_variable*, get_contact_subscription_status, unsubscribe_contact*, re_subscribe_contact*, export_unsubscribed_variables, export_unsubscribed_contacts

**Webhooks** (3): get_all_webhooks, add_webhook*, delete_webhook*

**Enrich** (4): get_enrichment_result, enrich_data*, bulk_enrich_data*, enrich_lead*

**Email Accounts** (3): connect_email_account*, disconnect_email_account*, test_email_account*

**Fields** (3): list_fields, create_or_update_field*, delete_field*

**Deliverability alerts** (6): list_deliverability_alerts, create_deliverability_alert*, get_deliverability_alert, update_deliverability_alert*, delete_deliverability_alert*, list_deliverability_incidents

**Sender picture** (2): get_sender_picture_status, sync_sender_picture*

**Contact sourcing** (3): run_contact_sourcing*, get_contact_sourcing_run, add_sourced_contact*

**Enrichment Providers** (3): list_enrichment_providers, connect_provider*, disconnect_provider*

**Enrichment Waterfalls** (4): list_enrichment_waterfalls, get_enrichment_waterfall, update_enrichment_waterfall*, reset_enrichment_waterfall*

**Domains** (6): search_domains, list_domains, purchase_domain*, order_mailboxes*, list_domain_mailboxes, update_domain_mailbox*

**Views** (7): list_views, create_view*, get_view_fields, set_view_tabs*, update_view*, delete_view*, duplicate_view*
