# Jamie coverage

Source: Jamie's developer docs (https://docs.meetjamie.ai/llms.txt: API overview, every API page, webhooks, MCP), swept
2026-11-24. Jamie publishes no OpenAPI spec, so the calls are written by hand in `own/jamie/index.ts`. Every documented
call is an action (7). Composio and n8n have no Jamie toolkit. Nothing here has run against a real account yet: the
tests fake Jamie's answers from its docs.

## Every documented call

| Jamie call (/v1/me/ or /v1/workspace/) | Action |
| --- | --- |
| meetings.list | list_meetings (filters: dates, tag on personal keys, userEmail on workspace keys) |
| meetings.get | get_meeting |
| meetings.search (personal keys only) | search_meetings |
| meetings.delete | delete_meeting * |
| tasks.list | list_tasks |
| tasks.update | update_task * |
| tags.list (personal keys only) | list_tags |

\* asks first.

## How calls are sent

- Reads are GETs with `?input={"json":{...}}`, changes POSTs with `{"json":{...}}`; answers come out of
  `result.data.json`.
- A personal key works only on /v1/me/, a workspace key only on /v1/workspace/, and nothing says which a key is. The
  first call tries /v1/me/; a 403 "requires a workspace-scoped API key" switches that key to /v1/workspace/, remembered
  in memory. The connection is labelled "Jamie" or "Jamie workspace".

## Left out

| What | Why |
| --- | --- |
| Webhooks (meeting.completed) | Made only by hand in Jamie → Settings → Webhooks; the API can't create or remove one. Polled instead (below) |
| Platform API (live speaker diarisation over a WebSocket, platform.meetjamie.ai) | A separate developer product with its own tokens, for streaming audio; not the business's meetings |
| Ask Jamie, workflows, templates | Not in the API |

## Auth

| Method | Status |
| --- | --- |
| API key (Settings → API & MCP → API keys, `jk_...`), sent as x-api-key; Pro, Team or Enterprise plan | done |
| OAuth | Jamie has no developer OAuth app to register ("No OAuth flows"). Its MCP server (https://mcp.meetjamie.ai/mcp, Pro and up) signs in with OAuth and dynamic client registration (registration_endpoint https://mcp.meetjamie.ai/oauth/register, checked 2026-11-24), so own/mcp-app.ts could offer a sign-in later |

## Triggers (all polled, polls/jamie.ts, every 5 minutes)

| Trigger | What |
| --- | --- |
| meeting_completed | A meeting's summary is ready (the webhook's meeting.completed); carries the full meeting. Filters: tag, teammate |
| new_task | A new task from a meeting (filters: assignee email, teammate) |
| task_completed | A task is marked done (filters: assignee email, teammate). Only the 100 newest done tasks are compared |
