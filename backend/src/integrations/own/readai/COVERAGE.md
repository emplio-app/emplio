# Read AI coverage

Sources, checked 24 Nov 2026: Read AI's help centre (API and MCP Overview, API Keys & Authentication, API Reference,
MCP Server: support.read.ai section 49378920415891), and the server's live metadata:
https://api.read.ai/.well-known/oauth-protected-resource/mcp names the sign-in server https://authn.read.ai/, whose
metadata (/.well-known/oauth-authorization-server) lists registration_endpoint https://api.read.ai/oauth/register,
PKCE (S256) and token_endpoint_auth_method none. Composio has no Read AI toolkit. Nothing has run against a real
Read AI account yet; signing up a client with the server wasn't tried either.

## Sign-in

Read AI's own MCP server sign-in (OAuth 2.1 with PKCE, `mcp-app.ts`): Emplio signs itself up with the server
(dynamic client registration), so there's no client id or secret to set up. No key option: Read AI doesn't issue API
keys (the Zapier key is for Zapier only). Every plan, Free included; in a workspace, Downloads must be on in Workspace
Settings → Reports & Sharing, and admins need Global Report Access to see everyone's reports. Access tokens last 10
minutes and are refreshed (refresh tokens last about 6 months, single use). The connection is labelled with the
account's email from the sign-in server's user info (authn.read.ai/userinfo), since the server has no "who am I" tool.

EU accounts live on another server (https://prod-eu-api.read.ai/mcp) and can't connect yet: it would need a second
app or a region choice.

## Actions

Every tool the server lists, read live, under its own name. Tools marked read-only run without asking; the rest ask.
At the time of writing: list_meetings, search_meeting_agent (find meetings by what was said, 20 to 60 seconds),
get_meeting_by_id (summary, chapters, action items, key questions, topics, transcript, metrics, recording link),
share_meeting_report, create_meeting_agent (send the notetaker to a Zoom, Meet or Teams call), list_folders and the
other folder tools.

Read AI's REST API (api.read.ai/v1: list meetings, a meeting, a live meeting) takes the same kind of sign-in but only
reads, and the tools above cover it, so it isn't used.

## Triggers

| Trigger | How |
| --- | --- |
| meeting_ended | polled (polls/readai.ts), every 10 minutes: list_meetings, meetings that ended in the last day with a summary |

Read AI's webhooks (meeting ended, signed with HMAC) are set up by hand in Read AI (app.read.ai → Integrations →
Webhooks); neither the REST API nor the MCP server can register them, so they can't be used with this sign-in. The
poll reads the tool's text answer as JSON (data, meetings or a bare list); the exact shape is unconfirmed until it
runs against a real account. Only the newest page (about 10 meetings) is checked.
