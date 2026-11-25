import { mcpApp } from "../mcp-app";

// NeoSapien's Neo 1 pendant and desktop app: conversation memories, transcripts and projects, through NeoSapien's own
// MCP server, its only way in (no public API). COVERAGE.md.
export const neosapien = mcpApp({ app: "neosapien", name: "NeoSapien", logo: "/logos/neosapien.svg", url: "https://api.neosapien.ai/mcp" });
