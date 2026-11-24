import { mcpApp } from "../mcp-app";

// Plaud's recorders (NotePin, Note): recordings, transcripts and AI notes, through Plaud's own MCP server. Plaud has no
// API for its customers' accounts (its partner API is for device makers), so this is the only way in. COVERAGE.md.
export const plaud = mcpApp({ app: "plaud", name: "Plaud", logo: "/logos/plaud.png", url: "https://mcp.plaud.ai/mcp", whoami: "get_current_user" });
