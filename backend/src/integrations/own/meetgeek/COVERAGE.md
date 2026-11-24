# MeetGeek coverage

Sources, swept 24 Nov 2026: MeetGeek's API docs at https://docs.meetgeek.ai (llms.txt, the OpenAPI spec at
/api-reference/openapi.json, Authorization, Limits, Webhooks, template and language appendices) and Composio's MeetGeek
toolkit (12 tools, no triggers). `scripts/openapi/meetgeek.ts` gives the spec's operations Composio's names (the spec has
no operation ids) and the generator makes `actions.json`. Nothing has run against a real MeetGeek account yet.

## Sign-in

| Method | Status |
| --- | --- |
| API key (Integrations → Public API), sent as Bearer | done; any plan, Free and Pro limited to 100 calls a day, Business and Enterprise 100 a minute |
| US region | key pasted as `us:<key>` goes to api-us.meetgeek.ai; `eu:<key>` to api-eu; bare to api.meetgeek.ai (Europe) |
| OAuth | No OAuth app registration for the REST API. MeetGeek's Cloud MCP server signs in through auth.meetgeek.ai (Google or Microsoft); not built |

check() lists teams, since MeetGeek has no "who am I" call, so the connection isn't labelled with a name.

## Actions (13; `*` asks first)

| Group | Actions |
| --- | --- |
| Meetings | list_meetings, get_meeting, delete_meeting*, get_transcript, get_summary, get_highlights, get_insights, download_recording |
| Recording in | upload_recording*, join_meeting_bot* |
| Teams | list_teams, list_team_meetings |
| Setup | get_webhook_setup |

download_recording is a POST that only makes a temporary link (Pro plan and up), so it runs without asking.
join_meeting_bot (POST /v1/bot/join) is not in MeetGeek's published spec: the endpoint exists (it answers 400 without a
key, where unknown paths answer 404) and its fields follow Composio's; unverified.

## Triggers

| Trigger | How | Source |
| --- | --- | --- |
| meeting_analyzed | webhook | "File analyzed successfully" with meeting_id; the meeting, summary and highlights are fetched before the run |
| analysis_failed | webhook | "File analyzed failed" |
| new_meeting (filter: team_id) | polled, 15 min | list_meetings / list_team_meetings, ended in the last day |

MeetGeek has no API for webhooks: one address per account, pasted on Integrations → Public API. get_webhook_setup hands
the owner `/webhooks/app/meetgeek/<connection>/<token>`, where the token is an HMAC of ENCRYPTION_KEY and the connection
(never stored), checked timing-safe. MeetGeek's own X-MG-Signature uses a secret set on its side that Emplio never sees,
so it isn't checked. The poll runs every 15 minutes at least, to stay inside the Free and Pro 100-calls-a-day limit.

## Left out

| What | Why |
| --- | --- |
| Checking X-MG-Signature | Its secret lives in MeetGeek's settings; the URL token covers it |
| A per-upload webhook URL | The spec's upload request has no such field; uploads report to the account's webhook |
