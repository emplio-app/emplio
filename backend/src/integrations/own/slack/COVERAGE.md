# Slack coverage

Source: Slack's docs at docs.slack.dev (each method page has a markdown twin with its scopes and arguments), checked
against `slackapi/node-slack-sdk`, generated on 2026-11-09 by `bun scripts/openapi/slack.ts`. Slack's old OpenAPI spec
(`slackapi/slack-api-specs`) is years stale, so it isn't used. Benchmark: Composio's Slack toolkit (171 tools, 9 triggers),
checked with `.claude/skills/new-integration/coverage.ts`. Action names are Composio's wherever one means the same call.
Where Composio has two names for one call, both work.

## Auth

| Method | Status |
| --- | --- |
| OAuth v2, sign-in only (`SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET`) | done |
| Pasted key | none: a Slack token is not something a business owner has |

Token rotation is off, so tokens never expire. One login stores two tokens as `<bot>|<user>`. Actions use the bot token,
so posts appear as Emplio and reading a channel needs Emplio invited to it. Methods with no bot scope use the person's
token: search, reminders, stars, Do Not Disturb changes, their own profile and photo, and making a file public. Those say
so plainly if the connection has no user token.

Slack answers failures as a 200 with `{ok: false}`. `invalid_auth`, `token_revoked`, `account_inactive` and
`token_expired` mark the connection expired; the rest come back as the error in words.

Without `SLACK_SIGNING_SECRET`, sign-in and actions still work, but automations can't start: triggers refuse to start
with a clear error, and the webhook answers 401 to everything.

## Limits to know

Apps not on the Slack Marketplace are limited to about 1 call a minute and 15 messages a call on
`conversations.history` and `conversations.replies` (`fetch_conversation_history`,
`fetch_message_thread_from_a_conversation`). The action descriptions say so.

## Deliberately left out

Every method is listed with its reason in `actions.json` under `skipped`.

| What | Why |
| --- | --- |
| `admin.*` (129 methods) and Composio's admin tools: emoji admin, Enterprise teams, workspace invites and settings, audit logs, SCIM | Need an Enterprise org admin token, which a workspace's bot or user login can't be |
| `rtm.*` | Classic apps only, and it opens a live socket rather than answering. Events API covers it |
| `oauth.*`, `openid.*`, `users.identity` | Part of signing in, done by the server. `users.identity` is for Sign in with Slack only |
| `apps.*` manifest, connections, uninstall, auth, icon, managed permissions, activities, datastore; `tooling.*`; `functions.*`; `workflows.triggers.*` | Take app-level or configuration tokens, or only work inside Slack-hosted workflows |
| `assistant.threads.*`, `agents.*`, `assistant.search.*`, `entity.*`, `slackbot.skills.*` | Need Slack's AI or Work Objects features turned on for the app, which could block a normal sign-in. `search_*` covers search |
| `team.accessLogs`, `team.billableInfo`, `team.integrationLogs` | Need the `admin` scope, which could stop ordinary members from connecting |
| `migration.exchange` | Enterprise migration helper needing the legacy `tokens.basic` scope |
| `auth.revoke` | Would log Emplio out of the connection; disconnecting is done in Emplio |
| `files.upload`, `users.setActive` | Slack retired them; `upload_or_create_a_file_in_slack` does the upload |
| Composio's `list_unread_channel_messages`, `get_unread_messages_from_user` | Conveniences: `retrieve_conversation_information` gives `last_read`, `fetch_conversation_history` the messages |
| Composio's `list_canvases`, `get_canvas` | `list_files_with_filters_in_slack` with `types: canvas`, and `retrieve_detailed_information_about_a_file` |
| Composio's `retrieve_a_user_s_identity_details`, `list_available_workspaces` | `retrieve_user_profile_information`, `test_auth`, and `list_auth_teams` cover them |

`views_*` and `dialog_open` are included, but all except `views_publish` need a `trigger_id` from someone clicking
something in Slack, which Emplio doesn't receive yet (no interactivity endpoint).

## Triggers

Events API, one app-wide address: `/webhooks/app/slack/events`, set in Slack's app settings. Signature `X-Slack-Signature`
v0 over `v0:<ts>:<body>` with `SLACK_SIGNING_SECRET`, timing-safe, timestamps over 5 minutes old refused, `url_verification`
answered with `{challenge}`. `start` calls `auth.test` and files automations under `slack:<team_id>`; each event carries it.
Delivery id is `event_id`. No `stop`: the subscription is app-level. Settings on all but `channel_created`: `channel`,
`user`; `direct_message_received` and `channel_created` take `user`.

Bot events to subscribe to: `message.channels`, `message.groups`, `message.im`, `message.mpim`, `reaction_added`,
`reaction_removed`, `channel_created`.

Same 9 names as Composio. Message triggers:

| Trigger | Starts on |
| --- | --- |
| `receive_message` | A person posts anywhere Emplio can see |
| `channel_message_received` | A person posts in a channel, private channel or group DM |
| `direct_message_received` | A person DMs Emplio's bot (only DMs to the bot; a person's own DMs are not sent to a bot subscription) |
| `receive_bot_message` | Another app or bot posts |

`message_reaction_added`/`reaction_added` and `message_reaction_removed`/`reaction_removed` are pairs that start together.

Skipped by default, so runs don't restart themselves: Emplio's own bot's posts and reactions. Edits, deletes, joins and
topic changes start nothing. Anything Emplio posts through a person's login or another app can still restart a message
trigger, as its description says.

Other Events API events (app_mention, member_joined_channel, channel_rename, team_join, file_shared...) aren't triggers
yet: the brief was Composio's nine. Adding one is a row in `events`, a case in `read`, and subscribing to it on Slack's site.

## Actions

155 generated (147 methods, the rest Composio's second names), and `upload_or_create_a_file_in_slack`,
`download_slack_file`, `find_channels`, `find_users` by hand. `*` asks first.

Generated from the docs; see the groups in `actions.json`: api, auth, blocks, bookmarks, bots, calls, canvases, chat,
conversations, dialog, dnd, emoji, files, pins, reactions, reminders, search, slackLists, stars, team, usergroups, users,
views, workflows. Reads (run unasked) are the methods named list, info, history, replies, members, search and similar,
worked out by name because Slack's listed HTTP verbs don't say; `reserve_file_upload` asks because it makes something.

## Adjustments by hand

- Arguments Slack's docs call arrays but describe as comma-separated are strings; other arrays and objects are sent as
  JSON text in the form, the way Slack's own SDK does.
- `users.setPhoto` and `files.remote.*` file arguments take `{"file": "/work/..."}` and go as multipart.
- Scopes come from the docs' per-method lists, with alternatives removed (`channels:write.topic` where `channels:manage`
  covers it). `chat:write.public` is added so Emplio can post in public channels without being invited. `mpim:write` is
  kept for the bot though its scope page lists only user and legacy bot, because the method pages list it for bots.
