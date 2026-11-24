# Plaud coverage

Source: https://docs.plaud.ai/plaud-mcp-cli/mcp.md (checked 2026-11-24).

## Sign-in

Plaud's own MCP server sign-in (OAuth 2.1 with PKCE). Emplio signs itself up with the server (dynamic client
registration) for each return address, so there's no client id or secret to set up, here or when self-hosting. No key
option: Plaud doesn't offer keys for customer accounts. Logins expire and are refreshed; the refresh token is kept
with the client id it was issued to.

## Actions

Every tool the server lists, read live (`mcp-app.ts`), under its own name: `emplio apps actions plaud`. Tools the
server marks read-only run without asking; the rest ask first. Nothing to regenerate when Plaud adds tools.

At the time of writing: `get_current_user` (labels the connection), `list_files` (by name, date range, page),
`get_file` (details, 24-hour audio link, transcript segments, notes), `get_note` (AI summary, action items, topics),
`get_transcript` (timestamps and speakers). The server can't record, upload, or edit recordings or transcripts.

Left out: Plaud's partner API (Plaud Embedded: device binding, uploads, transcription for hardware makers), which needs
a partner contract and doesn't reach customers' own recordings.

## Triggers

None yet. The server has no webhooks; a polled "new recording" trigger is possible later through `polls/`.
