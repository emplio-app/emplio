# Grain coverage

Source: Grain's API docs at https://developers.grain.com (Endpoints, Uploads, Hooks, Authentication, Versions), read
24 Nov 2026, API version 2026-10-01 (current; 2025-10-31 is deprecated). Grain publishes no OpenAPI spec, so the
calls are listed by hand in index.ts and run through own/openapi.ts. Nothing has run against a real Grain account yet:
every call and hook is tested with fetch faked. Composio's Grain toolkit has 17 tools and no triggers; n8n has no
Grain node.

## Every documented operation

| Grain operation | Action |
| --- | --- |
| List / Get Recording | list_recordings, get_recording |
| Get Recording Transcript (json, txt, vtt, srt) | get_recording_transcript (format) |
| Download Recording | download_recording (a file) |
| Update Recording | update_recording_title* |
| Add / Remove a Tag | add_recording_tag*, remove_recording_tag* |
| Share / Unshare Recording to a User or Team | share_recording_with_user*, unshare_recording_from_user*, share_recording_with_team*, unshare_recording_from_team* |
| Create / Update / Delete Clip | create_clip*, update_clip*, delete_clip* |
| List Stories | list_stories |
| Playlists: list, create, get, list recordings, update, delete | list_playlists, create_playlist*, get_playlist, list_playlist_recordings, update_playlist*, delete_playlist* |
| Add / Remove a Recording to a Playlist | add_recording_to_playlist*, remove_recording_from_playlist* |
| Share / Unshare Playlist to a User or Team | share_playlist_with_user*, unshare_playlist_from_user*, share_playlist_with_team*, unshare_playlist_from_team* |
| Uploads: create, list, get, update, promote | create_upload*, list_uploads, get_upload, update_upload*, promote_upload* |
| Create / List / Delete Hook | create_hook*, list_hooks, delete_hook* |
| Token Info | get_connection_info |
| List Users / Teams / Meeting Types | list_users, list_teams, list_meeting_types |

On top: upload_recording* takes an MP4 or MP3 from the computer, creates the upload and PUTs the file to the address
Grain gives (create_upload alone leaves that step to the caller).

`*` asks first. Grain's list and get calls are POSTs that only read; they run without asking.

Composio names kept where the call is the same. Composio's list_reference_data is list_users, list_teams and
list_meeting_types; update_recording_tag is add_recording_tag / remove_recording_tag; update_recording_access
(changing a recording's link access) has no v2 endpoint: share it with people or teams, or put it in a public or
workspace playlist (which opens it up to match).

## Left out

| What | Why |
| --- | --- |
| OAuth2 token and refresh endpoints | Sign-in plumbing, not actions |
| Version 2025-10-31's Upload Recording and upload_status hook | Removed in 2026-10-01 (create_upload / upload_updated replace them) |
| Grain MCP server (api.grain.com/_/mcp) | The REST API covers the same data |

## Sign-in

| Method | Status |
| --- | --- |
| Personal access token (Settings → Integrations → API), sent as Bearer with Public-Api-Version | done |
| Workspace access token (admins, plans with the Workspace API): the same box, sees the whole workspace | done (same key field) |
| OAuth2 (authorization code + PKCE, refresh tokens, `scopes` personal or workspace) | Not built. Grain issues client ids by hand (no self-serve registration); it also accepts a Client ID Metadata Document URL as client_id (no secret, PKCE), but tokens expire and need refresh, and workspace scope needs a client verified by Grain. Nothing registered |

## Triggers (all webhooks, triggers.ts)

One Grain hook per event type and connection, made by API when the first automation needs it and deleted with the
last, at /webhooks/app/grain/<connection>/<hook_type>/<token>. Grain doesn't sign deliveries, so the token in the
address (an HMAC of ENCRYPTION_KEY, the connection and the event, never stored) proves the sender. Grain sends no
delivery id: a retry is recognised by a hash of the body. Grain's reachability POST when a hook is made gets a 2xx and
starts nothing. Recording hooks ask Grain to include participants, the AI summary and action items; clip hooks the
clip's transcript and speakers; upload hooks the upload's details.

| Trigger | Filters |
| --- | --- |
| recording_added, recording_updated | title_contains, participant_email, team_id, meeting_type_id |
| recording_deleted, highlight_deleted, story_deleted | none (only the id comes) |
| highlight_added, highlight_updated | recording_id |
| story_added, story_updated | none |
| upload_added, upload_updated | status |

Nothing is polled: playlists, users and teams have no events in Grain.

## Not verified

No live account: request shapes for PUT/DELETE calls with no body, the hook reachability test's body, and the exact
error format are from the docs, not a real call. Which Grain plans include the API isn't stated in the docs.
