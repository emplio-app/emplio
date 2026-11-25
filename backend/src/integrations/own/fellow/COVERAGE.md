# Fellow coverage

Sources, swept 24 Nov 2026: Fellow's API reference at https://developers.fellow.ai (llms.txt, every endpoint page's
OpenAPI definition, Webhooks, Authentication, Super Admin, Pagination, Request limits). Fellow publishes no single spec;
`scripts/openapi/fellow.ts` merges the per-page definitions and the generator makes `actions.json`. Composio has no
Fellow toolkit and n8n no Fellow node. Nothing has run against a real Fellow account yet: requests and payloads follow the
docs and are tested with fetch faked.

## Sign-in

| Method | Status |
| --- | --- |
| Developer API key (User settings → Developer API), sent as `X-API-KEY` to `<subdomain>.fellow.app` | done; pasted as `<subdomain>:<key>` (or the workspace address, a colon, the key) |
| Super Admin key (Enterprise) | the same key box; sees the whole workspace and can delete notes and recordings |
| OAuth | Fellow has no OAuth app registration for the REST API. Its hosted MCP server (https://fellow.app/mcp) signs in with OAuth and dynamic client registration (`/.well-known/oauth-authorization-server` lists `registration_endpoint` https://fellow.app/mcp/register; scopes read_calendar, read_meeting_content, read_action_items, read_channels, write_meeting_agenda, write_action_items, write_channels). A later key-free sign-in could use own/mcp-app.ts with that URL; an admin must first allow MCP connections (Workspace settings → Security). Not built |

The Developer API must be turned on by a workspace admin (Workspace settings → Security). Limits: 3 requests a second,
10,000 a day per key.

## Actions (23; `*` asks first)

| Group | Actions |
| --- | --- |
| Account | get_me |
| Notes | list_notes, get_note, delete_note*, prepend_note_agenda*, append_note_agenda*, find_replace_note_agenda*, replace_note_agenda* |
| Recordings | list_recordings, get_recording, delete_recording*, upload_recording*, list_uploads, get_upload |
| Action items | list_action_items, get_action_item, mark_action_item_complete*, archive_action_item* |
| Webhooks | list_webhooks, get_webhook, create_webhook*, update_webhook*, delete_webhook* |

The list calls are POSTs that only read, so they run without asking. delete_note and delete_recording need a Super Admin
key.

## Triggers

| Trigger | How | Fellow event |
| --- | --- | --- |
| ai_notes_ready | webhook | ai_note.generated |
| ai_notes_shared_to_channel (filter: channel_id) | webhook | ai_note.shared_to_channel |
| action_item_assigned | webhook | action_item.assigned |
| action_item_completed | webhook | action_item.completed |
| new_note (filter: channel_id) | polled, 5 min | list_notes, created in the last day |
| new_recording (filter: channel_id) | polled, 5 min | list_recordings |
| new_action_item (filter: scope) | polled, 5 min | list_action_items |

One user-scope webhook per connection, found by its address and extended with each event; removed with the last
automation. Fellow makes the signing secret itself (svix, `whsec_...`) and shows it only once at creation, so it isn't
kept: the address carries an HMAC token of ENCRYPTION_KEY and the connection instead, checked timing-safe, and the
svix-id is the delivery id. Fellow's url_verification challenge is answered as plain text. The transcript is moved to
the end of the event so the 20,000-character cut takes it first.

## Left out

| What | Why |
| --- | --- |
| Workspace-scope webhooks | Need a Super Admin key and send every meeting in the workspace; per-user ones match what the person can see. create_webhook takes `scope` for anyone who wants one |
| Checking Fellow's svix signature | Its secret is only shown once at creation; storing it would break the never-stored rule. The URL token covers it |
| `X-On-Behalf-Of` (Super Admin acting as a user) | A header, not in the per-page specs; add as a header param if a Super Admin needs it |
| Realtime/MCP-only data (calendar, channels lists) | Only through the MCP server, not the REST API |
