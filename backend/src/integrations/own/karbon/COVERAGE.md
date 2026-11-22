# Karbon coverage

Source: Karbon's official OpenAPI spec, https://karbonhq.github.io/karbon-api-reference/KarbonAPI.json (API v3, with
its KARBON_API.md guide), generated 2026-11-22 by `bun scripts/openapi-actions.ts karbon`. Every operation in it is an
action (83) except those below. Composio has no Karbon toolkit (docs.composio.dev/toolkits/karbon is a 404), so there is
nothing to match by name.

## Deliberately left out

| What | Why |
| --- | --- |
| GET /v3/IntegrationTaskDefinitions, GET /v3/IntegrationTasks, GET and PUT /v3/IntegrationTasks/{key} | Only Karbon integration partners approved to run integrated workflows can call them |
| IntegrationTask webhooks | The same: only for approved integration partners |
| GET /v3/Timesheets, GET /v3/Timesheets/{key} | Marked deprecated by Karbon; list_time_entries (IndividualTimeEntries) replaces them |
| Tags | Beta, not in the spec and not enabled for all API users |

## Hand adjustments (scripts/openapi/karbon.ts, own/karbon/index.ts)

- Base `https://api.karbonhq.com`. Every call sends `Authorization: Bearer <KARBON_APP_KEY>` (Emplio's application key,
  issued once by Karbon) and `AccessKey: <the firm's Access Key>`. Without KARBON_APP_KEY, connecting says so. A 401 means
  the Access Key is dead.
- Names: one plain pattern (list_x, get_x, create_x, update_x for PUT, patch_x for PATCH) instead of the spec's uneven
  operation ids.
- `$filter` on each list says which fields and operators that list takes (from KARBON_API.md), with an example.
- Spec defaults are never sent: Contacts' `$orderby` default isn't one of its own choices, and `RestrictionLevel: Public`
  on a PATCH would make a private contact public.
- DMS (connected folder) calls are only enabled by Karbon on request; they answer with Karbon's error otherwise.

## Auth

| Method | Status |
| --- | --- |
| Access Key (Karbon → Settings → Connected Apps), with Emplio's application key from KARBON_APP_KEY | done |
| OAuth | Karbon has none |

## Triggers

By webhook (own/karbon/triggers.ts): one multi-type subscription per connection (POST /v3/WebhookSubscriptions with
`WebhookTypes`, then PATCH /v3/WebhookSubscriptions/Multi to add a type), at /webhooks/app/karbon/<connection>, signed with
HMAC-SHA256 (`Signature` header) using a signing key worked out from ENCRYPTION_KEY and the connection (never stored).
Removed when the last automation goes. Karbon allows one multi-type subscription per firm for our application, so one
pointing at another address is replaced. Karbon sends only keys; the item is fetched and sent along (not for deletes).
Karbon gives up on a subscription after 10 failed deliveries; the next automation saved makes it again.

- For each of contact, organization, client_group, work_item, note, note_comment: `new_<x>`, `<x>_updated`, `<x>_deleted`
- user_joined (a colleague accepted their invite), invoice_status_changed, invoice_paid, work_item_budget_changed,
  custom_field_value_changed
- Filters: key (one item, on *_updated / *_deleted and invoices), assignee_email, client_key, work_type and primary_status
  (work items), note_key (comments), status (invoices), field_key and client_key (custom fields)

Polled (polls/karbon.ts), every 5 minutes: new_time_entry (by user, client or work item), new_payment, new_file (on one
work item, contact or organization; optionally only files shared with the client). Karbon has no webhook for these.

## Actions (* asks first)

- Billing: list_invoices, get_invoice, list_payments, create_manual_payment*, delete_manual_payment*, reverse_manual_payment*, get_payment, create_expense*
- Business Cards: get_business_card, update_business_card*
- Client Groups: list_client_groups, create_client_group*, get_client_group_by_udi, get_client_group, update_client_group*, patch_client_group*
- Files: list_client_group_files, list_contact_files, upload_file*, download_file_by_token, get_file_details, move_file*, download_file, list_files, list_work_item_folders, list_work_item_files, list_organization_files
- Comments: get_comment
- Contacts: list_contacts, create_contact*, get_contact_by_udi, get_contact, update_contact*, patch_contact*, list_segments, get_segment, list_segment_members
- Custom Fields: list_custom_fields, create_custom_field*, delete_custom_field*, get_custom_field_values, update_custom_field_values*
- DMS: connect_folder*, get_connected_folder, disconnect_connected_folder*
- Estimate Summaries: list_estimate_summaries, get_estimate_summary, update_estimate_summary*
- Notes: get_note, create_note*
- Organizations: list_organizations, create_organization*, get_organization_by_udi, get_organization, update_organization*, patch_organization*
- Users: list_roles, list_teams, get_team, add_team_members*, remove_team_member*, list_users, create_user*, get_user
- Tenant Settings: get_tenant_settings
- Timesheets and Time Entries: list_time_entries, get_time_entry
- Webhook Subscriptions: get_webhook_subscription, delete_webhook_subscription*, patch_webhook_subscription*, create_webhook_subscription*, delete_all_webhook_subscriptions*
- Work Items: list_work_items, create_work_item*, get_work_item, update_work_item*, patch_work_item*
- Work Schedules: create_work_schedule*, get_work_schedule, update_work_schedule*, patch_work_schedule*
- Work Templates: list_work_templates, get_work_template
