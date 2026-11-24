# tl;dv coverage

Source: tl;dv's OpenAPI spec (v1alpha1), embedded in its Redoc page doc.tldv.io, generated 2026-11-24 by
`bun scripts/openapi-actions.ts tldv` (scripts/openapi/tldv.ts reads it out of the page). Every operation but one is an
action (12). Composio's tldv toolkit (7 tools, no triggers) is matched by name except get_meeting_highlights, which tl;dv
deprecated. No call has run against a real account.

## Left out

| What | Why |
| --- | --- |
| GET /meetings/{id}/highlights (Composio: get_meeting_highlights) | Deprecated by tl;dv; get_meeting_notes replaces it. tl;dv wasn't on Composio in our catalog, so no saved automations use the old name |
| Webhook management | Not in the API: subscriptions are made in tl;dv's own settings (user, team or organization level) |

## Hand adjustments

- `User-Agent: Emplio-tldv-integration/1.0` on every call: tl;dv blocks default library agents (403).
- download_meeting_recording (hand-written): answers the signed link from the 302 (good 6 hours) instead of following
  it, since recordings run to gigabytes. The computer downloads it with curl.
- Recording uploads (start/get/complete/abort_recording_upload) are tl;dv beta, enabled per user on request
  (support@tldv.io); until then they answer 404. The parts are PUT to the signed URLs from the computer.

## Triggers (polled, polls/tldv.ts)

| Trigger | tl;dv's webhook event | How |
| --- | --- | --- |
| meeting_ready | MeetingReady | meetings of the last day (list_meetings from=); meetingType, onlyParticipated filters |
| transcript_ready | TranscriptReady | for the 10 newest meetings of the last day, the transcript call; one with sentences is ready |

tl;dv's webhooks are set up only in its settings, have no API to register them and carry no signature, so both are
polled. Unverified: whether a meeting still processing already shows in list_meetings (meeting_ready may then fire a
little before its notes are ready).

## Auth

| Method | Status |
| --- | --- |
| API key (tldv.io/app/settings/personal-settings/api-keys), sent as x-api-key. Only meetings organized by Pro, Business or Enterprise users can be read; free-plan organizers' meetings can't | done |

tl;dv offers no OAuth app registration.

## Actions by group (* asks first)

**Meetings** (8): list_meetings, get_meeting, download_meeting_recording, import_meeting*, start_recording_upload*,
get_recording_upload, complete_recording_upload*, abort_recording_upload*

**Transcripts** (1): get_meeting_transcript

**Notes** (1): get_meeting_notes

**Folders** (1): search_folders

**Health check** (1): check_health
