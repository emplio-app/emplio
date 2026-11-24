# Supernormal coverage

Sources, swept 24 Nov 2026: Supernormal's API docs at https://docs.supernormal.com (llms.txt, llms-full.txt) and
its OpenAPI spec at https://docs.supernormal.com/api-reference/openapi.json (the spec isn't valid JSON as published:
a trailing comma after list_recordings' `page` parameter, so the calls are written by hand and run through
`own/openapi.ts`). Composio and n8n have no Supernormal toolkit. Nothing has run against a real account yet.

## Every documented operation

| Supernormal call | Action |
| --- | --- |
| GET /user | get_user |
| GET /user/calendar_events | list_upcoming_meetings |
| POST /calendar_events/{id}/record | set_meeting_capture * |
| GET /recordings | list_recordings |
| GET /recordings/{id} | get_recording |
| GET /recordings/{id}/transcript | get_transcript |

`*` asks first.

## Triggers

Supernormal's API can't register webhooks (its Slack, CRM and Zapier "New Meeting Notes" links are set up in its
app), so both are polled, in `polls/supernormal.ts`:

| Trigger | How |
| --- | --- |
| new_recording | polled: list_recordings, items finished (completed_at) in the last day |
| meeting_starting_soon | polled: list_upcoming_meetings in the next N minutes; id includes the start, so a moved meeting fires again |

## Left out

| What | Why |
| --- | --- |
| Agents and agent sessions (/agents, /agents/{id}, publish, unpublish, /agent_sessions) | In the spec but hidden from the published docs, and their scopes (agents:*, agent_sessions:*) aren't among the key scopes the spec offers (user, recordings, calendar_events), so a pasted key can't call them |
| Projects (projects:read/write) | Only on Supernormal's MCP server, not its REST API |

## Auth

| Method | Status |
| --- | --- |
| API key (Settings → API keys), sent as `X-API-TOKEN`; Business and Enterprise plans, API access turned on by Supernormal support | done |
| OAuth through Supernormal's MCP server (https://api.supernormal.com/mcp, dynamic client registration at https://api.supernormal.com/oauth/register, scopes recordings:read, projects:read, projects:write) | not built; could later sign in people on plans without API keys via `own/mcp-app.ts` |
