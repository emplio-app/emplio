# Apollo.io coverage

Source: Apollo's official OpenAPI spec, https://docs.apollo.io/openapi/apollo-rest-api.json (87 operations), generated
2026-11-22 by `bun scripts/openapi-actions.ts apollo`. Every operation but one is an action (85 generated, plus
get_auth_status by hand: 86). Benchmark: Composio's `apollo` toolkit (72 tools, 0 triggers).

## Deliberately left out

| What | Why |
| --- | --- |
| GET /typed_custom_fields (get a list of all custom fields) | Marked deprecated by Apollo; list_fields replaces it (Composio's get_typed_custom_fields) |
| OAuth sign-in | Apollo's OAuth is for registered partner apps; Emplio connects with an API key |
| Composio's create_sequence_step | Not in Apollo's public API: steps are made in Apollo, or with create_sequence / update_sequence |
| Composio's add_people_to_prospects | Not a call of its own: people_search finds people, create_contact / create_bulk_contacts saves them |
| Composio's get_user | Apollo has no "one user" call; list_users and get_current_user_profile cover it |
| Composio's bulk_update_account_stage | bulk_update_accounts sets account_stage_id on many accounts at once |
| Composio's get_typed_custom_fields | Deprecated, see above |

## Hand adjustments (scripts/openapi/apollo.ts, own/apollo/index.ts)

- Base `https://api.apollo.io/api/v1`; the key goes in `x-api-key`. A 401 means the key is dead; a 403 means the key
  can't reach that endpoint (not a master key) or the plan doesn't include it, and Apollo's message says which.
- Apollo opens each description with an "Endpoint essentials" table; the generator script cuts it to one line saying
  what a call costs ("Credits: 1 credit per company") and turns the rest of the HTML into text.
- Every call that spends credits asks first, even a GET (enrichment, get_organization, get_complete_person_info, company
  search, job postings, news, conversation details and export, email/phone validation, the AI assistant).
- POSTs that only search and cost nothing run unasked (`reads`).
- Names follow Composio's where it has the same call (`rename`).
- get_auth_status (GET /auth/health) is written by hand: it isn't in the spec, and Composio has it.
- docs.apollo.io has a bot check; if the download is refused, save the file in a browser and run with `APOLLO_SPEC=<path>`.

## Auth

| Method | Status |
| --- | --- |
| API key (Settings → Integrations → API → API keys), sent as x-api-key; a master key reaches every endpoint | done |
| OAuth 2.0 | not built: partner-only |

check() reads GET /users/api_profile for the user's name; a key without that endpoint falls back to GET /auth/health.

## Plans and credits

Many endpoints need a master API key and a paid Apollo plan: sequences, outreach emails, calls, deals, analytics and
usage. Free accounts must be registered with a work email to use search and enrichment. Enrichment (1-9 credits per
person, 1 per company), company search (1 per page), job postings and news (1 per page), validation (1-20 per row) and
conversation AI insights spend credits; people_search costs none.

## Triggers

Apollo has no webhooks to subscribe to (its only webhook_url is a one-off callback for phone-number enrichment, read
with poll_webhook_result), so all are polled every 5 minutes (polls/apollo.ts). Composio has none.

- Contacts: new_contact, contact_updated (filters: contact_stage_id, label_id)
- Accounts: new_account, account_updated (filters: account_stage_id, label_id)
- Deals: new_deal, deal_updated, deal_stage_changed, deal_won, deal_lost (filters: pipeline_id, stage_id, owner_id)
- Tasks: new_task, task_completed
- Calls: new_call (filter: direction); Conversations: new_conversation (filter: conversation_type); Notes: new_note
- Outreach emails: email_replied (filters: reply_class, sequence_id), email_bounced (filter: sequence_id)

Limits: each poll reads the newest 100 rows. Task search can't sort by creation date, so new_task can miss tasks in a busy
account. Accounts and deals may not say when they last changed; then a change is spotted by comparing the row itself.

## Actions (* asks first)

- Search and enrich: people_search, people_enrichment*, bulk_people_enrichment*, organization_enrichment*,
  bulk_organization_enrichment*, organization_search*, get_organization*, get_complete_person_info*,
  get_organization_job_postings*, search_news_articles*, validate_email_addresses_and_phone_numbers*, poll_webhook_result
- Accounts: search_accounts, get_account, create_account*, create_bulk_accounts*, update_account*, bulk_update_accounts*,
  update_account_owners*, list_account_stages
- Contacts: search_contacts, get_contact, create_contact*, create_bulk_contacts*, update_contact*, update_contacts_bulk*,
  update_contact_stage*, update_contact_ownership*, list_contact_stages, find_potential_duplicate_contact,
  merge_duplicate_contacts*, view_contact_merge_job, view_associated_deals
- Deals: list_deals, get_deal, create_deal*, update_deals*, get_opportunity_stages
- Lists: get_labels, create_list*, update_label*, add_records_to_list*, remove_records_from_list*
- Notes: list_notes
- Sequences: search_sequences, create_sequence*, update_sequence*, activate_sequence*, deactivate_sequence*,
  archive_sequence*, add_contacts_to_sequence*, update_contact_status_in_sequence*, get_contact_sequence_activity,
  list_email_schedules
- Outreach emails: search_outreach_emails, create_email_draft*, send_email_now*, get_email_content,
  check_email_send_status, get_email_activities
- Tasks: search_tasks, get_task, create_task*, bulk_create_tasks*, update_task*, complete_task*, skip_task*
- Calls: search_calls, create_call_record*, update_call_record*
- Conversations: search_conversations, get_conversation*, export_conversations*, get_conversation_export
- AI assistant: run_assistant_task*, poll_assistant_task
- Workspace: list_users, get_current_user_profile, list_email_accounts, list_fields, create_custom_field*,
  update_custom_field*, get_auth_status
- Usage and analytics: view_credit_usage_stats, view_api_usage_stats, query_analytics_report
