import { afterEach, beforeAll, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { AppsError } from "../../types";
import { APPS, own } from "../index";
// load the poll registry first: polls/cloudflare and polls/index import each other
import "../../polls";
import { cloudflare as polls } from "../../polls/cloudflare";
import { events, triggers, wanted } from "./triggers";
import { cloudflare } from "./index";

// until it's listed in own/index.ts
APPS.cloudflare ??= cloudflare;

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});
beforeAll(() => {
  process.env.ENCRYPTION_KEY ??= "test-key";
  process.env.WEBHOOK_URL = "https://api.test";
});
type Call = { url: URL; method: string; body: any; headers: Record<string, string> };
const stub = (answer: (c: Call) => Response) => {
  const calls: Call[] = [];
  globalThis.fetch = (async (url: string, init: RequestInit = {}) => {
    const raw = init.body;
    let body: any = raw;
    try {
      body = typeof raw === "string" ? JSON.parse(raw) : raw;
    } catch {}
    const c = { url: new URL(String(url)), method: init.method ?? "GET", body, headers: init.headers as Record<string, string> };
    calls.push(c);
    return answer(c);
  }) as typeof fetch;
  return calls;
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const login = { externalId: "c1", secret: "tok" };
const run = (action: string, input: unknown) => own.run(`cloudflare.${action}`, input, login, "o");
const ACC = "0123456789abcdef0123456789abcdef";
const secret = () => createHmac("sha256", process.env.ENCRYPTION_KEY!).update(`cloudflare-webhook:c1:${ACC}`).digest("hex");

test("a user token is verified and labelled with its account", async () => {
  const calls = stub((c) => (c.url.pathname.endsWith("/user/tokens/verify") ? json({ result: { status: "active" } }) : json({ result: [{ name: "Acme" }] })));
  expect(await own.connectWithKey!("cloudflare", "tok")).toEqual({ secret: "tok", label: "Acme" });
  expect(calls[0]!.headers.Authorization).toBe("Bearer tok");
});

test("an account-owned token, which /user/tokens/verify refuses, still connects through its accounts", async () => {
  stub((c) => (c.url.pathname.endsWith("/user/tokens/verify") ? json({ success: false, errors: [{ code: 1000, message: "Invalid API Token" }] }, 401) : json({ result: [{ name: "Shop" }, { name: "Blog" }] })));
  expect((await own.connectWithKey!("cloudflare", "tok")).label).toBe("Shop and 1 more");
});

test("a bad token is refused", async () => {
  stub(() => json({ success: false, errors: [{ code: 1000, message: "Invalid API Token" }] }, 401));
  expect(await own.connectWithKey!("cloudflare", "nope").catch((e) => e)).toBeInstanceOf(AppsError);
});

test("a missing permission isn't a dead login, and Cloudflare's error is said plainly", async () => {
  stub(() => json({ success: false, errors: [{ code: 10000, message: "Authentication error" }] }, 403));
  const e = (await run("list_dns_records", { zone_id: "z1" }).catch((e) => e)) as AppsError;
  expect(e.expired).toBeFalsy();
  expect(e.message).toContain("Cloudflare: Authentication error (code 10000)");
  expect(e.message).toContain("lack the permission");
  stub(() => json({ success: false, errors: [{ code: 1000, message: "Invalid API Token" }] }, 400));
  expect(((await run("list_zones", {}).catch((e) => e)) as AppsError).expired).toBe(true);
});

test("path, query and body go to their places; a record of one of many kinds goes whole as body", async () => {
  const calls = stub(() => json({ result: { id: "r1" } }));
  await run("create_dns_record", { zone_id: "z1", body: { type: "A", name: "shop.example.com", content: "1.2.3.4", proxied: true } });
  expect(calls[0]!.method).toBe("POST");
  expect(calls[0]!.url.origin + calls[0]!.url.pathname).toBe("https://api.cloudflare.com/client/v4/zones/z1/dns_records");
  expect(calls[0]!.body).toMatchObject({ type: "A", name: "shop.example.com", content: "1.2.3.4", proxied: true });
});

test("reads run unasked, writes and credentials ask", () => {
  const a = cloudflare.actions;
  for (const n of ["list_zones", "list_dns_records", "get_kv_value", "query_graphql_analytics", "check_registrar_domains", "get_screenshot"]) expect(a[n]!.readOnly).toBe(true);
  for (const n of ["create_dns_record", "delete_zone", "deploy_worker_script", "execute_d1_query", "get_cloudflare_tunnel_token", "get_pages_upload_token", "insert_vectors"]) expect(a[n]!.readOnly).toBeFalsy();
});

test("SQL goes as plain text and vectors as NDJSON", async () => {
  const calls = stub(() => json({ data: [] }));
  await run("query_analytics_sql", { account_id: ACC, sql: "SELECT 1" });
  expect(calls[0]!.body).toBe("SELECT 1");
  expect(calls[0]!.headers["Content-Type"]).toBe("text/plain");
  await run("upsert_vectors", { account_id: ACC, index_name: "docs", vectors: [{ id: "a", values: [1, 2] }, { id: "b", values: [3, 4] }] });
  expect(calls[1]!.url.pathname).toBe(`/client/v4/accounts/${ACC}/vectorize/v2/indexes/docs/upsert`);
  expect(calls[1]!.body).toBe('{"id":"a","values":[1,2]}\n{"id":"b","values":[3,4]}');
});

test("sign-in always shows Cloudflare's consent screen, asks for a refresh token, and swaps codes with Basic auth", async () => {
  Object.assign(process.env, { CLOUDFLARE_CLIENT_ID: "cid", CLOUDFLARE_CLIENT_SECRET: "cs", CLOUDFLARE_OAUTH_SCOPES: "zone.read dns.write" });
  const url = new URL(await cloudflare.oauth!.authorizeUrl("https://api.test/oauth/cloudflare/callback", "st"));
  expect(url.origin + url.pathname).toBe("https://dash.cloudflare.com/oauth2/auth");
  expect(url.searchParams.get("prompt")).toBe("consent");
  expect(url.searchParams.get("scope")).toBe("zone.read dns.write offline_access");
  const calls = stub(() => json({ access_token: "at", refresh_token: "rt", expires_in: 3600 }));
  expect(await cloudflare.oauth!.exchange("code", "https://api.test/oauth/cloudflare/callback", {})).toEqual({ token: "at", refreshToken: "rt", expiresIn: 3600 });
  expect(calls[0]!.headers.Authorization).toBe(`Basic ${Buffer.from("cid:cs").toString("base64")}`);
  expect(new URLSearchParams(calls[0]!.body).get("grant_type")).toBe("authorization_code");
  stub(() => json({ error: "invalid_grant" }, 400));
  expect(((await cloudflare.oauth!.refresh!("old").catch((e) => e)) as AppsError).expired).toBe(true);
  delete process.env.CLOUDFLARE_OAUTH_SCOPES;
  expect(cloudflare.oauth!.ready()).toBe(false);
});

test("a webhook destination is made once, and a policy per alert type points at it", async () => {
  const dests: any[] = [];
  const policies: any[] = [];
  const calls = stub((c) => {
    const p = c.url.pathname;
    if (p.endsWith("/destinations/webhooks") && c.method === "GET") return json({ result: dests });
    if (p.endsWith("/destinations/webhooks") && c.method === "POST") return dests.push({ id: "d1", url: c.body.url }), json({ result: { id: "d1" } });
    if (p.endsWith("/policies") && c.method === "GET") return json({ result: policies });
    if (p.endsWith("/policies") && c.method === "POST") return policies.push({ id: `p${policies.length + 1}`, ...c.body }), json({ result: { id: "p" } });
    if (c.method === "DELETE") return json({ result: {} });
    throw new Error(`unexpected ${c.method} ${p}`);
  });
  const id = await cloudflare.push!.start("tok", "c1", "pages_event_alert", { account_id: ACC });
  expect(id).toBe(`cloudflare:c1:${ACC}`);
  const made = calls.find((c) => c.method === "POST" && c.url.pathname.endsWith("/destinations/webhooks"))!;
  expect(made.body).toEqual({ name: "Emplio", url: `https://api.test/webhooks/app/cloudflare/c1/${ACC}`, secret: secret() });
  expect(policies[0]).toMatchObject({ name: "Emplio: pages_event_alert", alert_type: "pages_event_alert", mechanisms: { webhooks: [{ id: "d1" }] } });
  // a second alert type reuses the destination; the same one again changes nothing
  await cloudflare.push!.start("tok", "c1", "universal_ssl_event_type", { account_id: ACC, filters: { zones: ["z1"] } });
  await cloudflare.push!.start("tok", "c1", "pages_event_alert", { account_id: ACC });
  expect(calls.filter((c) => c.method === "POST" && c.url.pathname.endsWith("/destinations/webhooks"))).toHaveLength(1);
  expect(policies).toHaveLength(2);
  expect(policies[1].filters).toEqual({ zones: ["z1"] });
  // the last automation gone: our policies and the destination go too
  await cloudflare.push!.stop!("tok", id);
  expect(calls.filter((c) => c.method === "DELETE").map((c) => c.url.pathname.split("/").slice(-2).join("/"))).toEqual(["policies/p1", "policies/p2", "webhooks/d1"]);
});

test("a bad account id is refused before any call", async () => {
  const calls = stub(() => json({}));
  expect(await cloudflare.push!.start("tok", "c1", "pages_event_alert", { account_id: "nope" }).catch((e) => e)).toBeInstanceOf(AppsError);
  expect(calls).toHaveLength(0);
});

test("a delivery starts only its alert's trigger, and only with Cloudflare's secret", async () => {
  const body = { alert_type: "pages_event_alert", policy_id: "p1", policy_name: "Emplio: pages_event_alert", ts: 1, text: "Deployment failed", data: { project_name: "site" } };
  const delivery = (auth: string, b: unknown = body) => ({ body: JSON.stringify(b), headers: { "cf-webhook-auth": auth }, connection: "c1", rest: ACC });
  expect(await cloudflare.push!.receive!(delivery("wrong"), "tok")).toBeNull();
  const [ev] = await (await cloudflare.push!.receive!(delivery(secret()), "tok"))!.events();
  expect(ev!.triggers).toEqual(["pages_event_alert"]);
  expect(ev!.id).toBe("c1:p1:::1");
  // Cloudflare's test message starts nothing
  const [test] = await (await cloudflare.push!.receive!(delivery(secret(), { text: "Hello World!" }), "tok"))!.events();
  expect(test!.triggers).toEqual([]);
});

test("an automation takes only its own policy's alerts", () => {
  const data = { alert_type: "universal_ssl_event_type", policy_name: "Emplio: universal_ssl_event_type" };
  expect(wanted({ account_id: ACC }, data)).toBe(true);
  expect(wanted({ account_id: ACC, filters: { zones: ["z1"] } }, data)).toBe(false);
});

test("enterprise-only alerts aren't offered; every trigger has settings", () => {
  expect(events.pages_event_alert).toBe("pages_event_alert");
  expect(events.magic_tunnel_health_check_event).toBeUndefined();
  expect(Object.values(triggers).every((t) => t.config[0]!.name === "account_id")).toBe(true);
});

test("polls: a finished Pages deployment once per outcome, a changed DNS record by its edit time", async () => {
  const now = new Date().toISOString();
  const runner = (out: unknown) => async () => out;
  const deps = { result: [
    { id: "d1", created_on: now, latest_stage: { name: "deploy", status: "success" } },
    { id: "d2", created_on: now, latest_stage: { name: "build", status: "active" } },
    { id: "d3", created_on: now, latest_stage: { name: "build", status: "failure" } },
  ] };
  expect((await polls.pages_deployment_finished!.poll({ account_id: ACC, project_name: "site" }, runner(deps))).map((x) => x.id)).toEqual(["d1:success", "d3:failure"]);
  expect((await polls.pages_deployment_finished!.poll({ account_id: ACC, project_name: "site", only_failed: true }, runner(deps))).map((x) => x.id)).toEqual(["d3:failure"]);
  expect((await polls.dns_record_changed!.poll({ zone_id: "z1" }, runner({ result: [{ id: "r1", modified_on: "t2" }] })))[0]!.id).toBe("r1:t2");
  const soon = new Date(Date.now() + 5 * 86_400_000).toISOString();
  const later = new Date(Date.now() + 90 * 86_400_000).toISOString();
  const regs = { result: [{ domain_name: "a.com", expires_at: soon }, { domain_name: "b.com", expires_at: later }] };
  expect((await polls.domain_expiring!.poll({ account_id: ACC }, runner(regs))).map((x) => x.id)).toEqual([`a.com:${soon}`]);
});
