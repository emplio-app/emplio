# Otter.ai coverage

Sources, read 2026-11-24: Otter's own API articles, "Otter.ai Public API" (help.otter.ai/hc/en-us/articles/36130822688279,
updated 2026-10-29), "Super Admin APIs" (…/39661865499799) and "Workspace Webhooks" (…/35634832371735). Otter publishes
no OpenAPI spec, so the calls are written by hand in `own/otter/index.ts` and run through `own/openapi.ts`. Composio
has no Otter toolkit; n8n has no Otter node. No call has run against a real account (no Enterprise login to test with).

## Every documented operation

| Otter call | Action |
| --- | --- |
| GET /conversations | list_conversations |
| GET /conversations/{id}?include= | get_conversation |
| GET /conversations/{id}/audio | get_conversation_audio |
| POST /conversations | import_recording* |
| GET /channels | list_channels |
| GET /channels/{id}/members | list_channel_members |
| GET /workspace | get_workspace |
| GET /workspace/{id}/analytics | get_workspace_analytics (workspace admins) |
| GET /workspace/{id}/conversations | list_workspace_conversations (Super Admins) |

## Triggers (polled, polls/otter.ts)

| Trigger | Otter's webhook event | How |
| --- | --- | --- |
| conversation_completed | conversation.completed | newest 40 conversations of the last day whose summary/action items/outline are finished; channel_id, include_shared filters |
| conversation_shared | conversation.shared | a channel's newest 100 conversations; a new id there is a new share |

Otter's webhooks are made only by a workspace admin in Manage Workspace → Developer: no API to register one, no
signature on deliveries, and no way to update one. So both events are polled. If Otter adds a webhooks API, they move
to `push` (the payload is a conversation with every relationship, so the poll's follow-up call disappears).

## Left out

| What | Why |
| --- | --- |
| Webhook management | Not in the API (admin pages only) |
| Editing or deleting conversations, action items, channels | Not in the API |
| A file upload (the API takes a link only) | import_recording takes a public link; a file on the computer needs hosting first |

## Hand adjustments

- `include` on get_conversation goes comma separated (Otter's format), default action_items, insights, outline;
  transcript only when asked (long).
- The audio is returned as Otter's download link, not the file: recordings are large.

## Auth

| Method | Status |
| --- | --- |
| API key (Settings → Integrations → Developer, otter.ai/setting/developer), Bearer; Enterprise workspaces only, 2 keys per user, 10 requests/s | done |
| Otter's hosted MCP server (https://mcp.otter.ai/mcp), OAuth with dynamic client registration (https://otter.ai/oauth/register, scopes profile:read conversations:read, checked 2026-11-24) | not built; this is how non-Enterprise plans could sign in later, through `own/mcp-app.ts` like Plaud. Read only |

No OAuth app registration for the REST API exists.

## Actions (* asks first)

**conversations** (4): list_conversations, get_conversation, get_conversation_audio, import_recording*

**channels** (2): list_channels, list_channel_members

**workspace** (3): get_workspace, get_workspace_analytics, list_workspace_conversations
