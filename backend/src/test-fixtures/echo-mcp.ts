// a tiny MCP server over stdio, for mcp-local.test.ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({ name: "echo", version: "1.0.0" });
server.tool("echo", "Say it back", { text: z.string() }, async ({ text }) => ({ content: [{ type: "text", text: `you said ${text}` }] }));
await server.connect(new StdioServerTransport());
