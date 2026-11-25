# NeoSapien coverage

Source: https://api.neosapien.ai/.well-known/oauth-protected-resource (checked 2026-11-24).

## Sign-in

NeoSapien's own MCP server sign-in (OAuth 2.1 with PKCE). Emplio signs itself up with the server (dynamic client
registration) for each return address, so there's no client id or secret to set up, here or when self-hosting. No key
option: NeoSapien doesn't offer keys for customer accounts. Logins expire and are refreshed; the refresh token is kept
with the client id it was issued to.

## Actions

Every tool the server lists, read live (`mcp-app.ts`), under its own name: `emplio apps actions neosapien`. Tools the
server marks read-only run without asking; the rest ask first. Nothing to regenerate when NeoSapien adds tools.

NeoSapien doesn't publish its tool list; it covers conversation memories, transcripts and Projects from Neo 1 and the
desktop app. The tool names were not seen before the first real sign-in: check them with `emplio apps actions neosapien`.
No public REST API exists.

## Triggers

`neosapien.new_conversation`, polled every 15 minutes (at least 5) in `polls/recorders.ts`. The tool names aren't published, so it calls the server's read-only tool whose name says it lists conversations, memories or recordings, and reads the first list in its answer. The server has no webhooks.
