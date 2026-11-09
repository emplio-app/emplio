import { afterEach, beforeEach, expect, test } from "bun:test";
import { AppsError } from "../types";
import { APPS, own, type OwnApp } from "./index";
import { codeFlow } from "./oauth";
import { zohoApi, zohoAuth, zohoMail, zohoOAuth } from "./zoho-login";

const realFetch = globalThis.fetch;
type Sent = { url: string; form: URLSearchParams; headers: Record<string, string> };
const stub = (answer: unknown) => {
  const sent: Sent[] = [];
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    sent.push({ url: String(url), form: new URLSearchParams(String(init.body)), headers: init.headers as Record<string, string> });
    return new Response(JSON.stringify(answer), { headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return sent;
};
beforeEach(() => {
  process.env.ZOHO_CLIENT_ID = "zid";
  process.env.ZOHO_CLIENT_SECRET = "zsec";
  process.env.ZOHO_ACCOUNTS_URL = "https://accounts.zoho.in";
  process.env.DEMO_ID = "did";
  process.env.DEMO_SECRET = "dsec";
});
afterEach(() => {
  globalThis.fetch = realFetch;
  delete APPS.signinonly;
  for (const v of ["ZOHO_CLIENT_ID", "ZOHO_CLIENT_SECRET", "ZOHO_ACCOUNTS_URL", "DEMO_ID", "DEMO_SECRET"]) delete process.env[v];
});

const demo = (over: Partial<Parameters<typeof codeFlow>[0]> = {}) =>
  codeFlow({ name: "Demo", idVar: "DEMO_ID", secretVar: "DEMO_SECRET", authorize: "https://demo.test/auth", token: "https://demo.test/token", scope: "a b", params: { prompt: "consent" }, ...over });

test("a sign-in-only app is offered only where its OAuth app is set up, and takes no key", async () => {
  APPS.signinonly = { app: "signinonly", name: "S", logo: "", check: async () => "x", oauth: demo(), actions: {} } satisfies OwnApp;
  expect((await own.readyApps()).has("signinonly")).toBe(true);
  expect(await own.getApp("signinonly")).toMatchObject({ signIn: true, keyField: undefined });
  await expect(own.connectWithKey!("signinonly", "k")).rejects.toThrow(/signing in/);
  delete process.env.DEMO_SECRET;
  expect((await own.readyApps()).has("signinonly")).toBe(false);
  // an app with a key stays offered without its OAuth app
  expect((await own.readyApps()).has("github")).toBe(true);
});

test("the code flow asks for the scopes and sends the client in the form", async () => {
  const o = demo();
  const page = new URL(o.authorizeUrl("https://api.test/oauth/x/callback", "st"));
  expect(Object.fromEntries(page.searchParams)).toEqual({ response_type: "code", client_id: "did", redirect_uri: "https://api.test/oauth/x/callback", state: "st", scope: "a b", prompt: "consent" });
  const sent = stub({ access_token: "a", refresh_token: "r", expires_in: 3600 });
  expect(await o.exchange("c", "https://r", {})).toEqual({ token: "a", refreshToken: "r", expiresIn: 3600 });
  expect(Object.fromEntries(sent[0]!.form)).toEqual({ grant_type: "authorization_code", code: "c", redirect_uri: "https://r", client_id: "did", client_secret: "dsec" });
});

test("Basic auth keeps the secret out of the form, and scopes can stay on the app's site", async () => {
  const o = demo({ basic: true, scope: undefined });
  expect(new URL(o.authorizeUrl("https://r", "s")).searchParams.has("scope")).toBe(false);
  const sent = stub({ access_token: "a", expires_in: 3600 });
  await o.refresh!("r1");
  expect(sent[0]!.headers.Authorization).toBe(`Basic ${Buffer.from("did:dsec").toString("base64")}`);
  expect(Object.fromEntries(sent[0]!.form)).toEqual({ grant_type: "refresh_token", refresh_token: "r1" });
});

test("a revoked refresh token means signing in again; any other failure doesn't", async () => {
  stub({ error: "invalid_grant", error_description: "Token has been revoked." });
  const gone = await demo().refresh!("r").catch((e) => e);
  expect(gone).toBeInstanceOf(AppsError);
  expect(gone.expired).toBe(true);
  stub({ error: "server_error" });
  expect((await demo().refresh!("r").catch((e) => e)).expired).toBe(false);
});

test("Zoho: signs in at the client's data centre and carries on at the person's", async () => {
  const o = zohoOAuth("Zoho", "ZohoMail.messages.ALL");
  const page = new URL(o.authorizeUrl("https://r", "s"));
  expect(page.origin).toBe("https://accounts.zoho.in");
  expect(page.searchParams.get("access_type")).toBe("offline");
  expect(page.searchParams.get("prompt")).toBe("consent");
  const sent = stub({ access_token: "a1", refresh_token: "r1", expires_in: 3600, api_domain: "https://www.zohoapis.eu" });
  const t = (await o.exchange("c", "https://r", { location: "eu", "accounts-server": "https://accounts.zoho.eu" })) as { token: string; refreshToken: string };
  expect(sent[0]!.url).toBe("https://accounts.zoho.eu/oauth/v2/token");
  expect(t.token).toBe("eu:a1");
  expect(t.refreshToken).toBe("eu:r1");
  expect(zohoAuth(t.token).Authorization).toBe("Zoho-oauthtoken a1");
  expect(zohoApi(t.token)).toBe("https://www.zohoapis.eu");
  expect(zohoMail(t.token)).toBe("https://mail.zoho.eu");
  expect(zohoMail("ca:x")).toBe("https://mail.zohocloud.ca");
});

test("Zoho: a forged callback can't send our secret elsewhere", async () => {
  const sent = stub({ access_token: "a" });
  const o = zohoOAuth("Zoho", "s");
  await expect(o.exchange("c", "https://r", { location: "evil", "accounts-server": "https://evil.test" })).rejects.toBeInstanceOf(AppsError);
  await o.exchange("c", "https://r", { location: "in", "accounts-server": "https://evil.test" });
  expect(sent.map((s) => s.url)).toEqual(["https://accounts.zoho.in/oauth/v2/token"]);
});

test("Zoho: a refresh goes to the login's own data centre and keeps it on the new login", async () => {
  const sent = stub({ access_token: "a2", expires_in: 3600 });
  const t = await zohoOAuth("Zoho", "s").refresh!("au:r1");
  expect(sent[0]!.url).toBe("https://accounts.zoho.com.au/oauth/v2/token");
  expect(sent[0]!.form.get("refresh_token")).toBe("r1");
  expect(t.token).toBe("au:a2");
});

test("Zoho: an unknown start address means sign-in isn't offered", () => {
  process.env.ZOHO_ACCOUNTS_URL = "https://accounts.example.test";
  expect(zohoOAuth("Zoho", "s").ready()).toBe(false);
});
