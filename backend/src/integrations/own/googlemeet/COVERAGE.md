# Google Meet coverage

Source: the Meet API Discovery document (meet.googleapis.com/$discovery/rest?version=v2), generated 2026-11-09 by `bun scripts/openapi-actions.ts googlemeet`. 24 from the API and 1 added on top (25 actions), 1 trigger. All of Composio's 25 actions match.

## Sign-in

Google sign-in only (no key), shared with Calendar, Docs and Sheets: one OAuth client, `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`. Callback `/oauth/googlemeet/callback`.

| Scope | Google's class | What it gives |
| --- | --- | --- |
| `meetings.space.created` | Sensitive | Make meeting rooms, and manage rooms Emplio made |
| `meetings.space.readonly` | Sensitive | Read any of the person's meetings: records, participants, recordings' and transcripts' details |
| `meetings.space.settings` | Non-sensitive | Change settings of the person's other rooms |
| `openid`, `email` | Non-sensitive | The connection's label |

Only scopes Google classes as sensitive or non-sensitive are asked for. The test in `own/google-login.test.ts` fails if a restricted one appears (`drive`, `drive.readonly`, `drive.metadata`, `drive.meet.readonly`...). Tokens last an hour and renew with the refresh token (`offline`, `prompt=consent`).

## What works, and what can't

**Recording files can't be downloaded.** Fetching a recording needs `drive.meet.readonly`, a restricted scope we never ask for (`get_recording`, `list_recordings` say so). The catalog says "find where recordings are saved", not "get recordings".

| Works | How |
| --- | --- |
| Create a room, read it, change its settings | `create_meet`, `get_meet`, `update_space` (other rooms through `meetings.space.settings`) |
| End a call, manage members | `end_active_conference`, member actions, only in rooms Emplio made (Google limits these to `meetings.space.created`) |
| Past calls, participants, sessions | `list_conference_records`, `get_participant`..., any of the person's meetings |
| **Recording details** | State, times and the Drive link (`driveDestination.exportUri`) to open signed in, from `get_recording`, `list_recordings` |
| **Transcript entries** | The full text, line by line with speaker and time, through `list_transcript_entries`, `get_transcript_entry` |
| Smart notes | `list_smart_notes`, `get_smart_note`: details and the link to the notes in Docs |

Reading a transcript's or a smart note's Google Doc needs Google Docs connected too, and the id from `docsDestination`.

## Hand adjustments

- A resource's full name (`spaces/abc`) or just its last part both work as an id; the actions send the last part.
- Paths come from Discovery's `flatPath`, so ids are separate inputs (`spacesId`, `conferenceRecordsId`).

## Triggers (polled)

Composio has none. Added one, as it's cheap:

| Trigger | How | Limits |
| --- | --- | --- |
| `conference_ended` | `conferenceRecords.list`, an `endTime` in the last day; `meeting_code` setting | The newest 100 calls per check |

Google's Workspace Events API can push Meet events, but it needs a Pub/Sub topic per subscription; left out for now.

## Actions (* asks first)

**From the API** (24): list_conference_records, get_conference_record_by_name, get_participant, list_participants, get_participant_session, list_participant_sessions, get_transcript, get_transcripts_by_conference_record_id, get_transcript_entry, list_transcript_entries, get_recording, list_recordings, list_smart_notes, get_smart_note, update_space*, get_meet, create_meet*, end_active_conference*, update_member*, delete_member*, get_member, batch_update_members*, create_member*, list_members

**Added on top** (1): get_recordings_by_conference_record_id
