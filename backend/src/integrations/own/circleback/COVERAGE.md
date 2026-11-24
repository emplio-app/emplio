# Circleback coverage

Source: Circleback's OpenAPI spec (https://circleback.ai/docs/api/openapi.json), generated 2026-11-24 by
`bun scripts/openapi-actions.ts circleback`, plus the docs at https://circleback.ai/docs (API, webhooks, MCP). Every
operation in the spec is an action (29), and none was skipped. Composio and n8n have no Circleback toolkit. Nothing here
has run against a real account yet: the tests fake Circleback's answers from its spec and docs.

## Left out

| What | Why |
| --- | --- |
| Nothing in the spec | — |
| Webhooks (meeting finished, with notes, action items, transcript, insights) | Circleback sets them up only by hand, as a "Send webhook request" step in its Automations page; the API can't create or remove one. The same events are polled instead (below) |
| Ask Circleback, emails, insights setup, automations | Not in the public API (the MCP server and the app only) |

## Hand adjustments

- The spec has no operation ids, so `scripts/openapi/circleback.ts` names each operation from its summary
  ("List action items" → list_action_items) in a copy of the spec before generating.
- Lists (meetings, search, action items, calendar events, people, companies) put the next page in a `Link` header,
  which the shared runner drops; `own/circleback/index.ts` runs those six itself and answers `{items, next_cursor}`.

## Auth

| Method | Status |
| --- | --- |
| API key (Settings → API keys, `cb_...`), sent as Bearer; every plan, Free included | done |
| OAuth | Circleback has no developer OAuth app to register. Its MCP server (https://circleback.ai/api/mcp) signs in with OAuth and dynamic client registration (registration_endpoint https://circleback.ai/api/oauth/register, scopes user and user:write, checked 2026-11-24), so own/mcp-app.ts could offer a sign-in later |

## Triggers (all polled, polls/circleback.ts, every 5 minutes)

| Trigger | What |
| --- | --- |
| new_meeting | A meeting's notes are ready (filters: ownership, tag, folder) |
| new_action_item | A new open action item (filter: whose) |
| action_item_completed | An action item is marked done (filter: whose) |
| meeting_starting_soon | A calendar meeting starts within N minutes |

## Actions by group (* asks first)

**Action items** (4): delete_action_item*, update_action_item*, list_action_items, create_action_item*

**Calendar** (2): list_calendar_events, update_meeting_for_calendar_event*

**Companies** (2): list_companies, get_company

**Folders** (6): list_folders, create_folder*, delete_folder*, get_folder, update_folder*, share_folder*

**Meetings** (8): delete_meeting*, get_meeting, update_meeting*, share_meeting*, get_meeting_transcript, list_meetings, import_meeting*, search_meetings

**other** (1): get_current_account

**People** (2): list_people, get_person

**Tags** (4): list_tags, create_tag*, delete_tag*, update_tag*
