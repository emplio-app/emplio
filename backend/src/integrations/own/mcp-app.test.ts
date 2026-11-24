import { afterAll, expect, test } from "bun:test";
import { mcpApp } from "./mcp-app";

// a stand-in MCP server with its own sign-in: discovery, sign-up, tokens
const seen: { url: string; body: string }[] = [];
const real = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input instanceof Request ? input.url : input);
  const body = init?.body ? String(init.body) : "";
  seen.push({ url, body });
  const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });
  if (url.includes("oauth-protected-resource")) return json({ resource: "https://mcp.test/mcp", authorization_servers: ["https://auth.test/"], scopes_supported: ["read"] });
  if (url.includes("oauth-authorization-server"))
    return json({ issuer: "https://auth.test/", authorization_endpoint: "https://auth.test/authorize", token_endpoint: "https://auth.test/token", registration_endpoint: "https://auth.test/register", response_types_supported: ["code"], code_challenge_methods_supported: ["S256"], token_endpoint_auth_methods_supported: ["none"] });
  if (url === "https://auth.test/register") return json({ client_id: `client-${seen.filter((s) => s.url.endsWith("/register")).length}`, ...JSON.parse(body) }, 201);
  if (url === "https://auth.test/token") {
    const form = new URLSearchParams(body);
    if (form.get("refresh_token") === "dead") return json({ error: "invalid_grant" }, 400);
    return json({ access_token: `at-${form.get("grant_type")}`, refresh_token: "rt-2", expires_in: 3600, token_type: "Bearer" });
  }
  return new Response("not found", { status: 404 });
}) as typeof fetch;
afterAll(() => (globalThis.fetch = real));

const app = mcpApp({ app: "demo", name: "Demo", logo: "/logos/demo.png", url: "https://mcp.test/mcp" });
const redirect = "https://api.test/oauth/demo/callback";

test("signs itself up, sends PKCE, the scopes and the resource, and always shows the consent screen", async () => {
  const page = new URL(await app.oauth!.authorizeUrl(redirect, "st1"));
  expect(page.origin + page.pathname).toBe("https://auth.test/authorize");
  expect(page.searchParams.get("client_id")).toBe("client-1");
  expect(page.searchParams.get("code_challenge_method")).toBe("S256");
  expect(page.searchParams.get("scope")).toBe("read");
  expect(page.searchParams.get("resource")).toBe("https://mcp.test/mcp");
  expect(page.searchParams.get("prompt")).toBe("consent");
  const signUp = JSON.parse(seen.find((s) => s.url.endsWith("/register"))!.body);
  expect(signUp).toMatchObject({ client_name: "Emplio", redirect_uris: [redirect], token_endpoint_auth_method: "none" });
  // the same return address doesn't sign up again
  await app.oauth!.authorizeUrl(redirect, "st2");
  expect(seen.filter((s) => s.url.endsWith("/register"))).toHaveLength(1);
});

test("the code is swapped with its own verifier, once; the refresh token keeps its client", async () => {
  await app.oauth!.authorizeUrl(redirect, "st3");
  const t = (await app.oauth!.exchange("code", redirect, { state: "st3" })) as { token: string; refreshToken: string; expiresIn: number };
  expect(t.token).toBe("at-authorization_code");
  expect(t.expiresIn).toBe(3600);
  const form = new URLSearchParams([...seen].reverse().find((s) => s.url === "https://auth.test/token")!.body);
  expect(form.get("code_verifier")?.length).toBeGreaterThan(40);
  expect(form.get("client_id")).toBe("client-1");
  expect(JSON.parse(t.refreshToken)).toEqual({ c: "client-1", r: "rt-2" });
  // a second use of the same state, or one we never started, is refused
  await expect(app.oauth!.exchange("code", redirect, { state: "st3" })).rejects.toThrow(/run out/);
  await expect(app.oauth!.exchange("code", redirect, { state: "forged" })).rejects.toThrow(/run out/);
});

test("refresh uses the client the login was made with; a dead one means signing in again", async () => {
  const t = await app.oauth!.refresh!(JSON.stringify({ c: "old-client", r: "rt-1" }));
  expect(t.token).toBe("at-refresh_token");
  expect(new URLSearchParams([...seen].reverse().find((s) => s.url === "https://auth.test/token")!.body).get("client_id")).toBe("old-client");
  const dead = await app.oauth!.refresh!(JSON.stringify({ c: "old-client", r: "dead" })).catch((e) => e);
  expect(dead.expired).toBe(true);
});

test("a sign-in-only app: no key box, offered as soon as it's listed, its actions come from the server", () => {
  expect(app.keyField).toBeUndefined();
  expect(app.oauth!.ready()).toBe(true);
  expect(app.mcp).toBeDefined();
});
