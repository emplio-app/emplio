// MCP servers: remote tools (Notion's, Linear's, a business's own) that the business adds by address, in
// Integrations → MCP or by asking the AI (`emplio mcp add`, owner/admin chats). Every chat in the business
// can then use them through `emplio mcp`; this server is the MCP client (Streamable HTTP, or the older SSE), so
// header values (tokens) never enter the sandbox. A value can be {{NAME}}: the caller's own saved key
// (logins.ts), so each person can use their own account. A tool that isn't marked read-only asks for an OK
// first, like an app action (approvals.ts).
// A server that wants its own sign-in (OAuth, like Swiggy's or Notion's) gets one per person, the way Claude and
// Cursor do it: a "Sign in" button in the chat (a link on Telegram) opens its login page, it comes back to us, and
// we keep that person's tokens encrypted (mcp_auth), refreshed by the SDK.
// A local server (a program on the person's Mac, like Logic Pro's) is `local:<command>`: the desktop app starts it and
// passes its messages along the device link (devices.ts); only the person who added it can use it, and the app asks
// them before running a command it hasn't run before.
// ponytail: started fresh for each job (no memory between calls); keep it running if a server needs that.
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { type ConnectCard, KEY_MASK, mcpLogo, type McpServer, type McpServerInput, type McpTool, type SaveLoginCard } from "@emplio/shared";
import { auth, type OAuthClientProvider, UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { OAuthClientInformationMixed, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { and, asc, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { record } from "./activity";
import { approve } from "./approvals";
import { availableApps, esc, fromLink } from "./integrations";
import { context, currentUser } from "./auth";
import { db } from "./db";
import { type Conn, deviceFor, notify } from "./devices";
import { mcpAuth, mcpServers } from "./db/schema";
import { loginsCommand, nameOf, siteOf, withKeys } from "./logins";
import type { Session } from "./sandbox";
import { decrypt, encrypt } from "./secrets";

type Row = typeof mcpServers.$inferSelect;
type Who = { workspaceId: string; userId: string };

const NAME = /^[a-z0-9][a-z0-9-]{0,39}$/;
const isRef = (v: string) => /^(Bearer |Token )?\{\{[A-Z0-9_]+\}\}$/.test(v);
const headersOf = (r: Row): Record<string, string> => (r.headers ? JSON.parse(decrypt(r.headers)) : {});
const toServer = (r: Row): McpServer => ({
  id: r.id,
  name: r.name,
  url: r.url,
  headers: Object.entries(headersOf(r)).map(([name, value]) => ({ name, value: isRef(value) ? value : `${KEY_MASK}${value.slice(-4)}` })),
  enabled: r.enabled,
});

const listRows = (workspaceId: string) => db.select().from(mcpServers).where(eq(mcpServers.workspaceId, workspaceId)).orderBy(asc(mcpServers.name));
const findRow = async (workspaceId: string, name: string) =>
  (await db.select().from(mcpServers).where(and(eq(mcpServers.workspaceId, workspaceId), eq(mcpServers.name, name.toLowerCase()))))[0];

class McpError extends Error {}
const LOCAL = "local:";
const isLocal = (r: { url: string }) => r.url.startsWith(LOCAL);
// the server wants this person to sign in first (OAuth)
class NeedsSignIn extends Error {}

// --- signing in (OAuth) --------------------------------------------------------------------------------------

const API_URL = () => process.env.PUBLIC_API_URL ?? `http://localhost:${process.env.PORT ?? 4000}`;
const FRONTEND_URL = () => process.env.FRONTEND_URL ?? "http://localhost:3000";
// back from the server's login page, at `base`: localhost on this computer, else the public address
// (WEBHOOK_URL), like app sign-ins; servers refuse wifi addresses (192.168…), and some (Zepto) every address
// they don't know but localhost
const callback = (base: string) => `${base}/mcp/oauth/callback`;
type AuthData = { client?: OAuthClientInformationMixed; tokens?: OAuthTokens; verifier?: string };

async function authData(serverId: string, userId: string): Promise<AuthData> {
  const row = (await db.select().from(mcpAuth).where(and(eq(mcpAuth.serverId, serverId), eq(mcpAuth.userId, userId))))[0];
  return row ? JSON.parse(decrypt(row.data)) : {};
}
async function saveAuth(serverId: string, userId: string, patch: AuthData) {
  const data = encrypt(JSON.stringify({ ...(await authData(serverId, userId)), ...patch }));
  await db.insert(mcpAuth).values({ serverId, userId, data }).onConflictDoUpdate({ target: [mcpAuth.serverId, mcpAuth.userId], set: { data, updatedAt: new Date() } });
}

// What the MCP SDK asks of us to sign `userId` in to `row`: their saved client and tokens, and where their login
// page is (`to`, once the SDK has it). `state` comes back with them, to tell who it was.
function provider(row: Row, userId: string, { base = API_URL(), state = randomUUID() as string } = {}) {
  const p: OAuthClientProvider & { to?: URL } = {
    get redirectUrl() {
      return callback(base);
    },
    get clientMetadata() {
      return {
        client_name: "Emplio",
        // only the one in use: some servers (Zepto) take only addresses they know, like localhost, so a second
        // one gets the whole sign-up refused
        redirect_uris: [callback(base)],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      };
    },
    state: () => state,
    // signed up for the other return address (web vs phone): sign up again for this one
    clientInformation: async () => {
      const client = (await authData(row.id, userId)).client as { redirect_uris?: string[] } | undefined;
      return client && (!client.redirect_uris || client.redirect_uris.includes(callback(base))) ? (client as OAuthClientInformationMixed) : undefined;
    },
    saveClientInformation: (client) => saveAuth(row.id, userId, { client }),
    tokens: async () => (await authData(row.id, userId)).tokens,
    saveTokens: (tokens) => saveAuth(row.id, userId, { tokens }),
    redirectToAuthorization: (url) => void (p.to = url),
    saveCodeVerifier: (verifier) => saveAuth(row.id, userId, { verifier }),
    codeVerifier: async () => (await authData(row.id, userId)).verifier ?? "",
    invalidateCredentials: async (scope) => {
      if (scope === "all") await db.delete(mcpAuth).where(and(eq(mcpAuth.serverId, row.id), eq(mcpAuth.userId, userId)));
      else await saveAuth(row.id, userId, scope === "tokens" ? { tokens: undefined } : scope === "client" ? { client: undefined } : { verifier: undefined });
    },
  };
  return p;
}

// a sign-in's state: whose, which server, how it was opened; signed so a stranger can't finish one as someone else
// The small pages around an MCP sign-in. Their words can come from the link or the server, so they're never taken as HTML.
export const signInPage = (text: string, close = false) =>
  `<!doctype html><meta charset="utf-8"><p style="font:15px system-ui;padding:24px">${esc(text)}</p>${close ? "<script>window.close()</script>" : ""}`;

const sign = (payload: string) => createHmac("sha256", process.env.ENCRYPTION_KEY!).update(`mcp:${payload}`).digest("base64url");
type State = { w: string; u: string; s: string; popup: boolean; base: string; phone: boolean; e: number };
const toState = (s: Omit<State, "e">) => {
  const payload = Buffer.from(JSON.stringify({ ...s, e: Date.now() + 15 * 60_000 })).toString("base64url");
  return `${payload}.${sign(payload)}`;
};
function fromState(state: string): State | null {
  const [payload = "", sig = ""] = state.split(".");
  const want = Buffer.from(sign(payload));
  if (Buffer.from(sig).length !== want.length || !timingSafeEqual(Buffer.from(sig), want)) return null;
  const s = JSON.parse(Buffer.from(payload, "base64url").toString()) as State;
  return s.e > Date.now() ? s : null;
}

const signInCard = (row: Row): ConnectCard => ({ app: row.name, name: row.name, path: `/mcp/${row.name}/connect`, mcp: true, logo: mcpLogo(row.url) || undefined });

function checkUrl(url: string) {
  if (url.startsWith(LOCAL)) {
    if (url.length > LOCAL.length && url.length <= 500) return url;
    throw new McpError("give the command to run on this Mac, like LogicProMCP");
  }
  try {
    const u = new URL(url);
    if (u.protocol === "https:" || (u.protocol === "http:" && ["localhost", "127.0.0.1"].includes(u.hostname))) return u.toString();
  } catch {}
  throw new McpError("give the server's https address, like https://mcp.notion.com/mcp");
}

// Add one (no id) or change it. A masked header value sent back as it was keeps the saved one.
async function save(who: Who, input: McpServerInput, id?: string) {
  const name = input.name.trim().toLowerCase();
  if (!NAME.test(name)) throw new McpError("name it in lowercase letters, digits and dashes, like notion or my-crm");
  const url = checkUrl(input.url.trim());
  const old = id ? (await db.select().from(mcpServers).where(and(eq(mcpServers.id, id), eq(mcpServers.workspaceId, who.workspaceId))))[0] : undefined;
  if (id && !old) throw new McpError("no such server");
  const before = old ? headersOf(old) : {};
  const headers: Record<string, string> = {};
  for (const h of input.headers.slice(0, 20)) {
    const k = h.name.trim();
    if (!k) continue;
    if (!/^[A-Za-z0-9-]+$/.test(k)) throw new McpError(`"${k}" isn't a header name`);
    const v = h.value.startsWith(KEY_MASK) ? before[k] : h.value.trim();
    if (v === undefined) throw new McpError(`type ${k}'s value again`);
    if (v.length > 4000) throw new McpError(`${k} is too long`);
    headers[k] = v;
  }
  const values = { name, url, headers: Object.keys(headers).length ? encrypt(JSON.stringify(headers)) : null, enabled: input.enabled, updatedAt: new Date() };
  // its tools go through emplio apps under this name, so it can't be one of our apps' names
  if ((await availableApps().catch(() => [])).some((a) => a.app === name)) throw new McpError(`${name} is one of our apps (connect it in Integrations instead), or name this one ${name}-mcp`);
  const taken = await findRow(who.workspaceId, name);
  if (taken && taken.id !== id) throw new McpError(`there's already one called ${name}`);
  const [row] = old
    ? await db.update(mcpServers).set(values).where(eq(mcpServers.id, old.id)).returning()
    : await db.insert(mcpServers).values({ ...values, workspaceId: who.workspaceId, createdBy: who.userId }).returning();
  tools.delete(row!.id);
  record({ ...who, kind: "settings", summary: `${old ? "Changed" : "Added"} MCP server ${name}${input.enabled ? "" : " (off)"}`, detail: { url } });
  return toServer(row!);
}

async function remove(who: Who, id: string) {
  const [row] = await db.delete(mcpServers).where(and(eq(mcpServers.id, id), eq(mcpServers.workspaceId, who.workspaceId))).returning();
  if (row) record({ ...who, kind: "settings", summary: `Removed MCP server ${row.name}` });
  return !!row;
}

// --- talking to a server ---------------------------------------------------------------------------------

// A local server's end of the pipe: the Mac app starts the command and hands back what it prints, line by line
export class DeviceTransport implements Transport {
  onmessage?: (m: JSONRPCMessage) => void;
  onclose?: () => void;
  onerror?: (e: Error) => void;
  reason?: string;
  constructor(
    private conn: Conn,
    private key: string,
    private command: string,
  ) {}
  async start() {
    this.conn.mcp.set(this.key, {
      data: (text) => {
        try {
          this.onmessage?.(JSON.parse(text));
        } catch (e) {
          this.onerror?.(e as Error);
        }
      },
      closed: (reason) => ((this.reason = reason), this.onclose?.()),
    });
    notify(this.conn, "mcp.open", { key: this.key, command: this.command });
  }
  async send(m: JSONRPCMessage) {
    if (!this.conn.alive) throw new Error("the computer went offline");
    notify(this.conn, "mcp.send", { key: this.key, data: JSON.stringify(m) });
  }
  async close() {
    this.conn.mcp.delete(this.key);
    notify(this.conn, "mcp.close", { key: this.key });
  }
}

async function connectedLocal<T>(who: Who, row: Row, job: (client: Client) => Promise<T>) {
  if (row.createdBy !== who.userId) throw new McpError(`${row.name} runs on the Mac of the person who added it, so only they can use it`);
  const conn = deviceFor(who.userId);
  if (!conn) throw new McpError(`${row.name} runs on this person's Mac: open the Emplio app there and keep it open, then try again`);
  const transport = new DeviceTransport(conn, randomUUID(), row.url.slice(LOCAL.length));
  const client = new Client({ name: "Emplio", version: "1.0.0" });
  try {
    await client.connect(transport);
    return { result: await job(client), scrub: (text: string) => text };
  } catch (error) {
    throw new McpError(`couldn't start ${row.name}: ${transport.reason ?? ((error instanceof Error && error.message) || String(error))}`);
  } finally {
    void client.close().catch(() => {});
  }
}

// Connected as `who` (their {{NAME}} keys swapped in), for one job, then closed. `scrub` blanks those keys out
// of anything that comes back.
async function connected<T>(who: Who, row: Row, job: (client: Client) => Promise<T>) {
  if (isLocal(row)) return connectedLocal(who, row, job);
  const keys = await withKeys(who, siteOf(row.url), Object.values(headersOf(row)));
  if (typeof keys === "string") {
    const missing = /nothing saved as (\S+)/.exec(keys)?.[1];
    throw new McpError(
      missing
        ? `${row.name} needs this person's own key, and they haven't saved ${missing} yet: emplio logins ask ${missing} --site ${siteOf(row.url)} --key gives them a box to paste it into (never ask for it in chat), then try again`
        : keys.replace(/^error: /, ""),
    );
  }
  const headers = Object.fromEntries(Object.entries(headersOf(row)).map(([k, v]) => [k, keys.put(v)]));
  const url = new URL(row.url);
  const client = new Client({ name: "Emplio", version: "1.0.0" });
  // used only when the server asks for a sign-in; no tokens yet means NeedsSignIn
  const authProvider = provider(row, who.userId);
  try {
    await client.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers }, authProvider })).catch(async (error: unknown) => {
      // an older server speaks SSE instead; anything else (a wrong key) is the real error
      if (error instanceof UnauthorizedError || !/40[45]/.test(String(error))) throw error;
      await client.connect(new SSEClientTransport(url, { requestInit: { headers }, authProvider }));
    });
    return { result: await job(client), scrub: keys.scrub };
  } catch (error) {
    if (error instanceof UnauthorizedError || authProvider.to) throw new NeedsSignIn(row.name);
    const reason = (error instanceof Error && error.message) || String(error) || "no reason given";
    // a refusal with no sign-in offered (Uber's lets in only the AI apps it has approved): a sign-in won't fix it,
    // so the AI shouldn't send the person to one
    if ((error as { code?: number }).code === 403 || /access denied|forbidden/i.test(reason))
      throw new McpError(
        `${row.name} refused us (${keys.scrub(reason)}) without offering a sign-in: it most likely lets in only apps it has approved, so signing in or retrying won't help. Tell the person that plainly, and offer to remove it (emplio mcp remove ${row.name})`,
      );
    throw new McpError(keys.scrub(`couldn't reach ${row.name}: ${reason}`));
  } finally {
    void client.close().catch(() => {});
  }
}

// ponytail: a server's tool list cached 5 minutes per process, as whoever asked first
const tools = new Map<string, { at: number; list: Promise<McpTool[]> }>();
function toolsOf(who: Who, row: Row) {
  const hit = tools.get(row.id);
  if (hit && Date.now() - hit.at < 5 * 60_000) return hit.list;
  const list = connected(who, row, async (c) => {
    const all: McpTool[] = [];
    let cursor: string | undefined;
    do {
      const page = await c.listTools(cursor ? { cursor } : undefined);
      for (const t of page.tools)
        all.push({ name: t.name, description: (t.description ?? "").trim(), readOnly: !!t.annotations?.readOnlyHint, schema: t.inputSchema } as McpTool & { schema: unknown });
      cursor = page.nextCursor;
    } while (cursor && all.length < 500);
    return all;
  }).then((r) => r.result);
  tools.set(row.id, { at: Date.now(), list });
  list.catch(() => tools.delete(row.id));
  return list;
}

// a tool's answer as text: its text parts, then any structured result; pictures and files are named, not shown
function answerText(result: { content?: unknown; structuredContent?: unknown; isError?: unknown }) {
  const parts = Array.isArray(result.content) ? (result.content as { type: string; text?: string; mimeType?: string; resource?: { uri?: string } }[]) : [];
  const text = parts
    .map((p) => (p.type === "text" ? p.text : p.type === "resource" ? `(resource ${p.resource?.uri ?? ""})` : `(${p.type}${p.mimeType ? `, ${p.mimeType}` : ""})`))
    .join("\n");
  const structured = result.structuredContent && !text.trim() ? JSON.stringify(result.structuredContent) : "";
  return `${result.isError ? "error: " : ""}${text}${structured}` || "done";
}

// --- the emplio command --------------------------------------------------------------------------------------

const USAGE = `usage: emplio mcp list                              the business's MCP servers
       emplio mcp tools <server> [words]           its tools (read-only ones run without an OK); same as emplio apps actions <server>
       emplio mcp info <server> <tool>             a tool's input (JSON schema); same as emplio apps info <server>.<tool>
       emplio mcp call <server> <tool> '<json>'    run it; same as emplio apps run <server>.<tool> '<json>' (long JSON: - <<'JSON' ... JSON)
       emplio mcp add <name> <https url> [--key] [--header "Name: value"]...   owner/admin chats
                                                --key: it needs a token; each person saves their own in a box in the
                                                chat (sent as Authorization: Bearer). A header value can also be
                                                {{KEY_NAME}}, a saved key (emplio logins). Never put a pasted token here.
       emplio mcp add <name> --local "<command>"    a program on this person's Mac (the Emplio app must be open); only they can use it
       emplio mcp update <name> [--url <url>] [--header "Name: value"]... [--on | --off]
       emplio mcp remove <name>`;

export async function mcpCommand(s: Session, args: string[], park: (name: string, text: string) => Promise<string>): Promise<string | { text: string; card: SaveLoginCard | ConnectCard }> {
  const who = { workspaceId: s.workspaceId, userId: s.user.id };
  const [sub, name, ...rest] = args;
  const flag = (f: string) => rest.flatMap((a, i) => (rest[i - 1] === f ? [a] : []));
  const headers = flag("--header").map((h) => ({ name: h.slice(0, h.indexOf(":")).trim(), value: h.slice(h.indexOf(":") + 1).trim() }));
  try {
    if (sub === "list") {
      const rows = await listRows(s.workspaceId);
      if (!rows.length) return `No MCP servers yet.${s.role === "member" ? " The owner or an admin can add one (Integrations → MCP)." : " Add one with emplio mcp add."}`;
      return rows.map((r) => `${r.name}\t${r.url}${r.enabled ? "" : "\t(off)"}`).join("\n");
    }
    if (["add", "update", "remove"].includes(sub ?? "")) {
      if (s.role === "member") return `error: only the owner or an admin can change MCP servers. Tell ${s.user.name} to ask one.`;
      if (!name) return USAGE;
      if (sub === "add") {
        const local = flag("--local")[0];
        const target = local !== undefined ? `${LOCAL}${local.trim()}` : rest[0];
        if (!target || target.startsWith("--")) return USAGE;
        // a token: a {{NAME}} each person fills with their own, through the in-app box
        const keyName = nameOf(`${name}_token`);
        if (rest.includes("--key")) headers.push({ name: "Authorization", value: `Bearer {{${keyName}}}` });
        const server = await save(who, { name, url: target, headers, enabled: true });
        if (rest.includes("--key")) {
          const ask = await loginsCommand(who, s.conversationId, s.channel, ["ask", keyName, "--site", siteOf(server.url), "--key"]);
          const lead = `added ${server.name}; it needs ${s.user.name}'s token first. `;
          return typeof ask === "string" ? `${lead}${ask}` : { ...ask, text: `${lead}${ask.text} Then check it with emplio apps actions ${server.name}.` };
        }
        const row = (await findRow(s.workspaceId, server.name))!;
        const list = await toolsOf(who, row).catch((e: Error) => e);
        // most servers want the person's own sign-in first: that's the next step, not something to fix
        if (list instanceof NeedsSignIn)
          return {
            card: signInCard(row),
            text: `added ${server.name}. It needs ${s.user.name}'s sign-in first: a "Connect ${server.name}" button is now in the chat. Ask them to use it and tell you when they're done, then check it with emplio mcp tools ${server.name}. Don't write a link.`,
          };
        if (list instanceof McpError && /refused us/.test(list.message)) return `added ${server.name}, but ${list.message}`;
        return list instanceof Error ? `added ${server.name}, but ${list.message}. Fix it with emplio mcp update.` : `added ${server.name}: ${list.length} tools (emplio mcp tools ${server.name})`;
      }
      const row = await findRow(s.workspaceId, name);
      if (!row) return `error: no MCP server called ${name} (emplio mcp list)`;
      if (sub === "remove") return (await remove(who, row.id)) ? "removed" : "error: already gone";
      const current = toServer(row);
      const merged = [...current.headers.filter((h) => !headers.some((n) => n.name.toLowerCase() === h.name.toLowerCase())), ...headers].filter((h) => h.value);
      const server = await save(who, { name: row.name, url: flag("--local")[0] !== undefined ? `${LOCAL}${flag("--local")[0]!.trim()}` : (flag("--url")[0] ?? row.url), headers: merged, enabled: rest.includes("--off") ? false : rest.includes("--on") ? true : row.enabled }, row.id);
      return `updated ${server.name}`;
    }
    if (sub === "tools" || sub === "info" || sub === "call") {
      if (!name) return USAGE;
      const row = await findRow(s.workspaceId, name);
      if (!row) return `error: no MCP server called ${name} (emplio mcp list)`;
      if (!row.enabled) return `error: ${row.name} is turned off (Integrations → MCP)`;
      const list = (await toolsOf(who, row)) as (McpTool & { schema: unknown })[];
      if (sub === "tools") {
        const words = rest.join(" ").toLowerCase().split(/\s+/).filter(Boolean);
        const shown = list.filter((t) => words.every((w) => `${t.name} ${t.description}`.toLowerCase().includes(w)));
        if (!shown.length) return words.length ? "No tools match." : "This server has no tools.";
        return shown.map((t) => `${row.name}.${t.name}${t.readOnly ? "" : " (asks for an OK)"}\t${t.description.split("\n")[0]!.slice(0, 200)}`).join("\n");
      }
      // the tool as listed (server.tool) or bare
      const wanted = rest[0]?.startsWith(`${row.name}.`) ? rest[0].slice(row.name.length + 1) : rest[0];
      const tool = list.find((t) => t.name === wanted);
      if (!tool) return `error: ${row.name} has no tool called ${rest[0] ?? "(none given)"} (emplio mcp tools ${row.name})`;
      if (sub === "info") return `${row.name}.${tool.name}${tool.readOnly ? "" : " (asks for an OK)"}\n${tool.description}\n\ninput: ${JSON.stringify(tool.schema, null, 2)}`;
      let input: Record<string, unknown>;
      try {
        input = JSON.parse(rest[1] || "{}");
      } catch {
        return "error: the input isn't valid JSON.";
      }
      const action = `mcp.${row.name}.${tool.name}`;
      const run = async () => {
        const { result, scrub } = await connected(who, row, (c) => c.callTool({ name: tool.name, arguments: input }));
        record({ ...who, conversationId: s.conversationId, kind: "app", summary: `${action}${result.isError ? ": failed" : ""}`, detail: { input } });
        return scrub(answerText(result as Parameters<typeof answerText>[0]));
      };
      const refused = tool.readOnly ? null : await approve(s, action, input, { own: { title: tool.name.replaceAll("_", " "), readOnly: false, appName: row.name, logo: mcpLogo(row.url) || undefined, run } });
      if (refused) return refused;
      const text = await run();
      if (text.length <= 4000) return text;
      const path = await park(action.replaceAll(".", "-"), text);
      return `Result is ${text.length} characters, saved in full to ${path}. Start:\n${text.slice(0, 1000)}`;
    }
    return USAGE;
  } catch (error) {
    if (error instanceof McpError) return `error: ${error.message}`;
    if (error instanceof NeedsSignIn) {
      const row = (await findRow(s.workspaceId, error.message))!;
      return {
        card: signInCard(row),
        text: `${row.name} needs ${s.user.name} to sign in to it first: a "Connect ${row.name}" button is now in the chat. Ask them to use it and tell you when they're done, then try again. Don't write a link.`,
      };
    }
    throw error;
  }
}

// `emplio apps` for an MCP server's tools, the server's name standing in for an app's: emplio apps actions <server> [words],
// emplio apps info <server>.<tool>, emplio apps run <server>.<tool> '<json>'. Null: not an MCP server (an app, for appsCommand).
export async function mcpViaApps(s: Session, args: string[], park: (name: string, text: string) => Promise<string>): Promise<Awaited<ReturnType<typeof mcpCommand>> | null> {
  const [sub, first = "", ...rest] = args;
  if (!["actions", "info", "run"].includes(sub ?? "")) return null;
  const server = first.split(".")[0]!.toLowerCase();
  if (!server || !(await findRow(s.workspaceId, server))) return null;
  if (sub === "actions") return mcpCommand(s, ["tools", server, ...rest], park);
  const tool = first.slice(server.length + 1);
  if (!tool) return `error: name the tool too, like ${server}.<tool> (emplio apps actions ${server})`;
  return mcpCommand(s, [sub === "info" ? "info" : "call", server, tool, ...rest], park);
}

// The servers, for the system prompt's list of what's connected.
export const mcpServerList = async (workspaceId: string) => (await listRows(workspaceId)).filter((r) => r.enabled).map((r) => r.name);

// --- Integrations → MCP ---------------------------------------------------------------------------

// An MCP server's icon (mcpLogo): the first real favicon for its host, or for its site without the "mcp."
// or "api." in front. Public: it's only ever a site's public icon. Remembered while the API runs.
// ponytail: unbounded past 1000 hosts it stops remembering; a table if icons ever need to outlive restarts
const icons = new Map<string, Promise<{ type: string; body: Buffer } | null>>();
async function iconOf(host: string) {
  const base = host.replace(/^(www|mcp|api|server)\./, "");
  const google = (h: string) => `https://www.google.com/s2/favicons?domain=${h}&sz=128`;
  const ddg = (h: string) => `https://icons.duckduckgo.com/ip3/${h}.ico`;
  // both answer a host without an icon with a stand-in globe and a 404, so only a 200 counts
  for (const u of [...new Set([google(host), google(base), ddg(host), ddg(base)])]) {
    const r = await fetch(u, { signal: AbortSignal.timeout(4000) }).catch(() => null);
    const type = r?.headers.get("content-type") ?? "";
    if (r?.ok && type.startsWith("image/")) return { type, body: Buffer.from(await r.arrayBuffer()) };
  }
  return null;
}

export async function mcpRoutes(app: FastifyInstance) {
  app.get<{ Querystring: { host?: string } }>("/favicon", async (req, reply) => {
    const host = (req.query.host ?? "").toLowerCase();
    if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host) || host.length > 253) return reply.code(400).send();
    let icon = icons.get(host);
    if (!icon) {
      icon = iconOf(host);
      if (icons.size < 1000) icons.set(host, icon);
    }
    const found = await icon;
    if (!found) return reply.code(404).header("cache-control", "public, max-age=86400").send();
    return reply.header("content-type", found.type).header("cache-control", "public, max-age=604800").send(found.body);
  });

  const handle = async <T>(reply: { code(n: number): { send(b: unknown): unknown } }, fn: () => Promise<T>) => {
    try {
      return await fn();
    } catch (error) {
      if (error instanceof McpError) return reply.code(400).send({ error: error.message[0]!.toUpperCase() + error.message.slice(1) + "." });
      throw error;
    }
  };
  const body = {
    type: "object",
    required: ["name", "url", "headers", "enabled"],
    properties: {
      name: { type: "string", maxLength: 40 },
      url: { type: "string", maxLength: 2000 },
      enabled: { type: "boolean" },
      headers: { type: "array", maxItems: 20, items: { type: "object", required: ["name", "value"], properties: { name: { type: "string" }, value: { type: "string" } } } },
    },
  };

  app.get("/mcp", async (req, reply) => {
    const ctx = await context(req, reply);
    if (!ctx) return;
    // a row is saved as soon as a sign-in starts (the server registers us); signed in only once it gave tokens
    const rows = await db.select().from(mcpAuth).where(eq(mcpAuth.userId, ctx.userId));
    const mine = new Set(rows.filter((r) => (JSON.parse(decrypt(r.data)) as AuthData).tokens).map((r) => r.serverId));
    return { servers: (await listRows(ctx.workspaceId)).map((r) => ({ ...toServer(r), signedIn: mine.has(r.id) })), canEdit: ctx.role !== "member" };
  });

  app.post<{ Body: McpServerInput }>("/mcp", { schema: { body } }, async (req, reply) => {
    const ctx = await context(req, reply);
    if (!ctx) return;
    if (ctx.role === "member") return reply.code(403).send({ error: "Only the owner or an admin can add MCP servers." });
    return handle(reply, () => save(ctx, req.body));
  });

  app.put<{ Params: { id: string }; Body: McpServerInput }>("/mcp/:id", { schema: { body } }, async (req, reply) => {
    const ctx = await context(req, reply);
    if (!ctx) return;
    if (ctx.role === "member") return reply.code(403).send({ error: "Only the owner or an admin can change MCP servers." });
    return handle(reply, () => save(ctx, req.body, req.params.id));
  });

  app.delete<{ Params: { id: string } }>("/mcp/:id", async (req, reply) => {
    const ctx = await context(req, reply);
    if (!ctx) return;
    if (ctx.role === "member") return reply.code(403).send({ error: "Only the owner or an admin can remove MCP servers." });
    return { ok: await remove(ctx, req.params.id) };
  });

  // connect and list its tools, as the person looking (their own {{NAME}} keys)
  app.get<{ Params: { id: string } }>("/mcp/:id/tools", async (req, reply) => {
    const ctx = await context(req, reply);
    if (!ctx) return;
    const row = (await db.select().from(mcpServers).where(and(eq(mcpServers.id, req.params.id), eq(mcpServers.workspaceId, ctx.workspaceId))))[0];
    if (!row) return reply.code(404).send({ error: "Not found" });
    tools.delete(row.id);
    return handle(reply, async () => {
      try {
        return { tools: ((await toolsOf(ctx, row)) as (McpTool & { schema?: unknown })[]).map(({ schema: _, ...t }) => t) };
      } catch (error) {
        if (error instanceof NeedsSignIn) return { signIn: signInCard(row) };
        throw error;
      }
    });
  });

  // A Connect button opened (or its link from a channel, ?t=): off to the server's own login page, as that person.
  app.get<{ Params: { name: string }; Querystring: { t?: string; popup?: string } }>("/mcp/:name/connect", async (req, reply) => {
    const page = (text: string) => reply.type("text/html").send(signInPage(text));
    const link = req.query.t ? fromLink(req.query.t) : null;
    if (req.query.t && !link) return page("This link has expired. Ask for a new one.");
    if (!link && !(await currentUser(req))) return reply.redirect(`${FRONTEND_URL()}/login`);
    const ctx = link ? { workspaceId: link.w, userId: link.u } : await context(req, reply);
    if (!ctx) return;
    const row = await findRow(ctx.workspaceId, req.params.name);
    if (!row) return page("That MCP server isn't set up any more.");
    const phone = !!link;
    const here = `${req.protocol}://${req.headers.host}`;
    const local = !phone && /^(localhost|127\.0\.0\.1)(:|$)/.test(req.headers.host ?? "");
    const base = process.env.PUBLIC_API_URL ?? (local ? here : (process.env.WEBHOOK_URL ?? here));
    const p = provider(row, ctx.userId, { base, state: toState({ w: ctx.workspaceId, u: ctx.userId, s: row.id, popup: req.query.popup === "1", base, phone }) });
    try {
      if ((await auth(p, { serverUrl: row.url })) === "AUTHORIZED" || !p.to) return page(`Already signed in to ${row.name}. You can close this window.`);
      return reply.redirect(p.to.href);
    } catch (error) {
      return page(`${row.name} didn't start a sign-in: ${error instanceof Error ? error.message : "something went wrong"}.`);
    }
  });

  // Back from the server's login page with a code: swapped for this person's tokens.
  app.get<{ Querystring: { code?: string; state?: string; error?: string } }>("/mcp/oauth/callback", async (req, reply) => {
    const page = (text: string, close = false) => reply.type("text/html").send(signInPage(text, close));
    const st = fromState(req.query.state ?? "");
    if (!st) return page("This sign-in has expired. Start it again from the chat.");
    const row = (await db.select().from(mcpServers).where(and(eq(mcpServers.id, st.s), eq(mcpServers.workspaceId, st.w))))[0];
    if (!row) return page("That MCP server isn't set up any more.");
    if (req.query.error || !req.query.code) return page(`Sign-in didn't finish (${req.query.error ?? "no code"}). Try again from the chat.`);
    try {
      await auth(provider(row, st.u, { base: st.base }), { serverUrl: row.url, authorizationCode: req.query.code });
    } catch (error) {
      return page(`Sign-in to ${row.name} failed: ${error instanceof Error ? error.message : "something went wrong"}.`);
    }
    tools.delete(row.id);
    record({ workspaceId: st.w, userId: st.u, kind: "connection", summary: `Signed in to MCP server ${row.name}` });
    if (st.popup || st.phone) return page(`Signed in to ${row.name}. You can close this window.`, true);
    return reply.redirect(`${FRONTEND_URL()}/chat`);
  });
}
