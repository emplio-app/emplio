# Fathom coverage

Source, read 24 Nov 2026: Fathom's own OpenAPI spec (https://developers.fathom.ai/api-reference/openapi.yaml) and its
docs (quickstart, webhooks, FAQ, API overview). Benchmark: Composio's Fathom toolkit, 10 tools and 1 trigger; every
one is here under the same name. n8n has no Fathom node. Nothing has run against a real Fathom account yet.

## Sign-in

| Method | Status |
| --- | --- |
| API key (Settings → API Access), sent as X-Api-Key. Every plan. Sees what its owner can see in Fathom | done |
| OAuth (Fathom's marketplace apps: fathom.video/marketplace_applications/new, reviewed by Fathom, scope public_api) | not built, no app registered. OAuth apps can't use include_summary/include_transcript on list_meetings |

Fathom has no "who am I" call, so a key is checked by listing meetings and the connection isn't labelled with a name.

## Actions

Generated from the spec (`bun scripts/openapi-actions.ts fathom`, settings in `scripts/openapi/fathom.ts`). `*` asks first.

| Group | Actions |
| --- | --- |
| Meetings | list_meetings (filters: dates, recorder, teams, company domains, internal/external, meeting type; summary, transcript, action items, highlights, CRM matches on request), list_meeting_types |
| Recordings | get_recording_summary, get_recording_transcript, download_recording, get_recording_download |
| Teams and people | list_teams, list_team_members, list_users (account admins only) |
| Webhooks | create_webhook *, delete_webhook * |

By hand: download_recording (a POST) runs without asking, since it only prepares a file of an existing recording.
Answers come 10 per page; pass next_cursor as cursor for more. Rate limits: 60 calls a minute, 30 for summaries,
transcripts and list_meetings with summary or transcript.

## Triggers

| Trigger | How |
| --- | --- |
| meeting_content_ready | webhook |

Fathom has one event (new meeting content ready) and no call to list webhooks, so each connection gets one webhook
carrying everything it can (all four recording kinds, falling back to the two that work without a Team Plan; summary,
action items and CRM matches; not the transcript, which can be hundreds of KB). Its id is kept in the automations' id
(`fathom:<connection>:<webhook>`), found from there by the next automation (own/fathom/triggers.ts reads the
automations table), and deleted with the last one. Settings filter on the server: recorded_by, team, meeting_type,
external_only, invitee (email or domain).

Fathom makes each webhook's signing secret itself and shows it once, so it can't be worked out from ENCRYPTION_KEY.
Deliveries are checked instead by a token in the address (an HMAC of ENCRYPTION_KEY and the connection), compared in
constant time. Fathom's own signature (webhook-signature) isn't checked; that would need the secret kept, encrypted.
Duplicates are dropped by Fathom's webhook-id.

## Left out

| What | Why |
| --- | --- |
| Asynchronous answers (destination_url on summary, transcript, download) | Taken as an input, but Fathom then posts to that address, not to Emplio; leave it out to get the answer at once |
| Fathom's MCP server | The REST API covers the same meetings |
