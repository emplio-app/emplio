// Apps whose maker offers no API of its own, only a hosted MCP server with its own sign-in (Plaud, NeoSapien).
// They connect like any own OAuth app (Connect card, connection, refresh), but the sign-in is the MCP kind: we sign
// ourselves up with the server (no client id to set up, so self-hosting works too) and use PKCE; and the actions
// are the server's tools, read from it live, so new ones show up without a change here.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { discoverOAuthServerInfo, exchangeAuthorization, refreshAuthorization, registerClient, startAuthorization } from "@modelcontextprotocol/sdk/client/auth.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { OAuthClientInformationMixed } from "@modelcontextprotocol/sdk/shared/auth.js";
import type { ActionDetail } from "@emplio/shared";
import { and, eq } from "drizzle-orm";
import { db } from "../../db";
import { connections } from "../../db/schema";
import { AppsError } from "../types";
import type { OAuthTokens, OwnApp } from "./index";

export type McpTool = { name: string; description: string; readOnly: boolean; input: ActionDetail["input"] };

// the server's sign-in details, looked up once per process
// ponytail: cached forever; a server that moves its sign-in needs a restart
const servers = new Map<string, ReturnType<typeof discoverOAuthServerInfo>>();
const serverOf = (url: string) => {
  if (!servers.has(url)) servers.set(url, discoverOAuthServerInfo(url).catch((e) => (servers.delete(url), Promise.reject(e))));
  return servers.get(url)!;
};

// Signed up once per return address. The client id also travels with each connection's refresh token, so a restart
// (a new sign-up) doesn't strand logins made under the old one.
const clients = new Map<string, Promise<OAuthClientInformationMixed>>();
const clientFor = async (url: string, redirect: string) => {
  const key = `${url} ${redirect}`;
  if (!clients.has(key)) {
    const info = await serverOf(url);
    clients.set(
      key,
      registerClient(info.authorizationServerUrl, {
        metadata: info.authorizationServerMetadata,
        clientMetadata: { client_name: "Emplio", client_uri: "https://emplio.app", redirect_uris: [redirect], grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none" },
      }).catch((e) => (clients.delete(key), Promise.reject(e))),
    );
  }
  return clients.get(key)!;
};

// a sign-in's PKCE verifier and client, by its state, until it comes back
// ponytail: in memory, so a restart in the middle of someone's sign-in makes them start again
const waiting = new Map<string, { verifier: string; client: OAuthClientInformationMixed; at: number }>();
const WAIT_MS = 15 * 60_000;

// the refresh token as we keep it: the server's, with the client it belongs to
const packRefresh = (client: OAuthClientInformationMixed, token?: string) => (token ? JSON.stringify({ c: client.client_id, r: token }) : undefined);
const toOwn = (t: { access_token: string; refresh_token?: string; expires_in?: number }, client: OAuthClientInformationMixed): OAuthTokens => ({
  token: t.access_token,
  refreshToken: packRefresh(client, t.refresh_token),
  expiresIn: t.expires_in,
});
const signInError = (name: string, e: unknown) => new AppsError(`${name}: ${(e instanceof Error && e.message) || "the sign-in didn't finish"}. Sign in again.`, true);

// one call to the server as this person, then closed
async function session<T>(name: string, url: string, token: string, job: (c: Client) => Promise<T>) {
  const client = new Client({ name: "Emplio", version: "1.0.0" });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
    return await job(client);
  } catch (e) {
    if (e instanceof AppsError) throw e;
    const reason = (e instanceof Error && e.message) || String(e);
    if (/\b401\b|unauthori[sz]ed|invalid_token/i.test(reason)) throw new AppsError(`${name} signed Emplio out; connect it again`, true);
    throw new AppsError(`couldn't reach ${name}: ${reason}`);
  } finally {
    void client.close().catch(() => {});
  }
}

const fields = (schema: unknown): ActionDetail["input"] => {
  const s = (schema ?? {}) as { properties?: Record<string, { type?: string | string[]; enum?: unknown[]; description?: string }>; required?: string[] };
  return Object.entries(s.properties ?? {}).map(([name, p]) => ({
    name,
    type: p.enum ? p.enum.join("|") : [p.type ?? "any"].flat().join("|"),
    required: s.required?.includes(name) ?? false,
    description: p.description ?? "",
  }));
};

// a tool's answer as text: its text parts, else its structured result
function answer(result: { content?: unknown; structuredContent?: unknown; isError?: unknown }) {
  const parts = Array.isArray(result.content) ? (result.content as { type: string; text?: string }[]) : [];
  const text = parts.map((p) => (p.type === "text" ? p.text : `(${p.type})`)).join("\n");
  const out = text.trim() ? text : result.structuredContent ? JSON.stringify(result.structuredContent) : "done";
  if (result.isError) throw new AppsError(out);
  return out;
}

// The tools are the same for everyone, so they're read with any working login of the app, then kept 10 minutes.
// Before anyone has connected it there's nothing to read them with: an empty list, and the Connect card.
// ponytail: borrows some person's login just to list tool names; a stored list if a server ever shows people different tools
const toolCache = new Map<string, { at: number; list: Promise<McpTool[]> }>();

export function mcpApp(o: { app: string; name: string; logo: string; url: string; whoami?: string }) {
  const listTools = (token: string) =>
    session(o.name, o.url, token, async (c) => {
      const all: McpTool[] = [];
      let cursor: string | undefined;
      do {
        const page = await c.listTools(cursor ? { cursor } : undefined);
        for (const t of page.tools) all.push({ name: t.name, description: (t.description ?? "").trim(), readOnly: !!t.annotations?.readOnlyHint, input: fields(t.inputSchema) });
        cursor = page.nextCursor;
      } while (cursor && all.length < 500);
      return all;
    });

  const def: OwnApp & { mcp: { tools(): Promise<McpTool[]>; call(tool: string, input: unknown, token: string): Promise<string> } } = {
    app: o.app,
    name: o.name,
    logo: o.logo,
    actions: {},
    async check(token) {
      if (!o.whoami) return;
      const text = await session(o.name, o.url, token, (c) => c.callTool({ name: o.whoami!, arguments: {} })).then((r) => answer(r as Parameters<typeof answer>[0]));
      try {
        const me = JSON.parse(text) as Record<string, unknown>;
        const who = me.email ?? me.name ?? (me.user as Record<string, unknown> | undefined)?.email;
        return typeof who === "string" ? who : undefined;
      } catch {
        return /[\w.+-]+@[\w-]+\.[\w.-]+/.exec(text)?.[0];
      }
    },
    oauth: {
      ready: () => true,
      async authorizeUrl(redirect, state) {
        const info = await serverOf(o.url);
        const client = await clientFor(o.url, redirect);
        const scope = info.resourceMetadata?.scopes_supported?.join(" ");
        const { authorizationUrl, codeVerifier } = await startAuthorization(info.authorizationServerUrl, {
          metadata: info.authorizationServerMetadata,
          clientInformation: client,
          redirectUrl: redirect,
          state,
          resource: info.resourceMetadata?.resource ?? o.url,
          ...(scope && { scope }),
        });
        for (const [k, w] of waiting) if (w.at < Date.now() - WAIT_MS) waiting.delete(k);
        waiting.set(state, { verifier: codeVerifier, client, at: Date.now() });
        // every sign-in shows the consent screen, so a link someone was sent can't finish by itself
        authorizationUrl.searchParams.set("prompt", "consent");
        return authorizationUrl.href;
      },
      async exchange(code, redirect, callback) {
        const w = waiting.get(String(callback.state ?? ""));
        if (!w) throw new AppsError(`This ${o.name} sign-in has run out. Connect again from the chat.`);
        waiting.delete(String(callback.state));
        const info = await serverOf(o.url);
        const t = await exchangeAuthorization(info.authorizationServerUrl, {
          metadata: info.authorizationServerMetadata,
          clientInformation: w.client,
          authorizationCode: code,
          codeVerifier: w.verifier,
          redirectUri: redirect,
          resource: info.resourceMetadata?.resource ?? o.url,
        }).catch((e) => Promise.reject(signInError(o.name, e)));
        return toOwn(t, w.client);
      },
      async refresh(kept) {
        const { c, r } = JSON.parse(kept) as { c: string; r: string };
        const info = await serverOf(o.url);
        const client = { client_id: c };
        const t = await refreshAuthorization(info.authorizationServerUrl, {
          metadata: info.authorizationServerMetadata,
          clientInformation: client,
          refreshToken: r,
          resource: info.resourceMetadata?.resource ?? o.url,
        }).catch((e) => Promise.reject(signInError(o.name, e)));
        return toOwn(t, client);
      },
    },
    mcp: {
      async tools() {
        const hit = toolCache.get(o.app);
        if (hit && Date.now() - hit.at < 10 * 60_000) return hit.list;
        const row = await db.query.connections.findFirst({ where: and(eq(connections.app, o.app), eq(connections.status, "active")) });
        if (!row) return [];
        const { freshSecret } = await import("./index");
        const token = await freshSecret(row).catch(() => null);
        if (!token) return [];
        const list = listTools(token);
        toolCache.set(o.app, { at: Date.now(), list });
        list.catch(() => toolCache.delete(o.app));
        return list.catch(() => []);
      },
      call: (tool, input, token) => session(o.name, o.url, token, (c) => c.callTool({ name: tool, arguments: (input ?? {}) as Record<string, unknown> })).then((r) => answer(r as Parameters<typeof answer>[0])),
    },
  };
  return def;
}
