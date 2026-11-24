# Sybill coverage

Source: Sybill's OpenAPI spec (https://api.sybill.ai/docs/openapi.yaml, linked from api.sybill.ai/docs), generated
24 Nov 2026 by `bun scripts/openapi-actions.ts sybill`: every operation is an action (35), none skipped. Also read:
the docs' Authentication, Rate Limiting, Pagination and MCP pages, and help.sybill.ai's API and webhook articles.
Composio has no Sybill toolkit and n8n no Sybill node. Nothing has run against a real Sybill account yet.

## Hand adjustments (scripts/openapi/sybill.ts)

- Names come from the spec's summaries (no Composio names to keep); health_check is check_key.
- ask_sybill is a POST that only reads, so it runs without asking. It waits up to 60 seconds; a longer answer comes
  back as threadId and runId with status running, for get_ask_sybill_result.

## Sign-in

| Method | Status |
| --- | --- |
| API key (Settings → Integrations → API Keys, sk_live_...), sent as Bearer | done |
| OAuth | None for the REST API. Sybill's MCP server (mcp.sybill.ai/mcp) signs in with OAuth as a user, but its only tools are ask_sybill and get_ask_sybill_result, already covered here |

Keys are for the whole organization and carry permissions: Export (read, the GETs), Import (ingest: POST, PATCH,
DELETE) and Ask Sybill (ask_sybill). A missing one answers 403 naming it. Keys don't see users' private calls.
Limits: 60 requests a minute, 1,000 an hour, 10,000 a day per key.

## Triggers (polled, polls/sybill.ts)

Sybill has webhooks (meeting.new_recording.v1/v2, deal.stage_changed.v1), but they can only be made in its dashboard
(Settings → Integrations → Webhooks), with a signing secret shown there; the API has no webhook endpoints. So:

| Trigger | How | Filters |
| --- | --- | --- |
| new_conversation | list_conversations started in the last day, every 10 minutes | title, attendees, type |
| new_deal | list_deals active in the last day, created in the last day, every 15 minutes | owner |
| deal_stage_changed | list_deals active in the last week (up to 200), id is deal and stage, every 15 minutes | stage, owner |
| new_account | list_accounts created in the last day, every 15 minutes | owner |
| new_message | list_messages created in the last day, every 10 minutes | participant_email |

Left out: documents, rows, sources and object types are records you import yourself; there's nothing to be told.
A later instant path: the owner adds a dashboard webhook pointing at an app-wide address and pastes its signing secret.

## Actions by group (* asks first)

**Key** (1): check_key

**Ask Sybill** (2): ask_sybill, get_ask_sybill_result

**Conversations** (4): list_conversations, get_conversation, import_conversation*, delete_imported_conversation*

**Deals and accounts** (4): list_deals, get_deal, list_accounts, get_account

**Messages** (4): list_messages, get_message, import_message*, delete_imported_message*

**Rows** (5): list_rows, get_row, import_row*, update_imported_row*, delete_imported_row*

**Sources** (5): list_sources, get_source, create_source*, update_source*, delete_source*

**Object types** (5): list_object_types, get_object_type, create_object_type*, update_object_type*, delete_object_type*

**Documents** (5): list_documents, get_document, import_document*, update_imported_document*, delete_imported_document*

## Not verified

No live account. A 422 validation error's detail is a list, which the shared error reader (own/openapi.ts) prints
as-is rather than field by field.
