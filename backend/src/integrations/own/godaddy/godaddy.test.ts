import { afterEach, expect, test } from "bun:test";
import { AppsError } from "../../types";
// load the poll registry first: polls/godaddy and polls/index import each other
import "../../polls";
import { godaddy as polls } from "../../polls/godaddy";
import { godaddy } from "./index";

type Call = { method: string; url: URL; headers: Record<string, string>; body: any };
const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

// records every request and answers with reply(call); anything unanswered is a test bug, not a trip to GoDaddy
function stub(reply: (c: Call) => Response | undefined) {
  const calls: Call[] = [];
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    const c = { method: init.method!, url: new URL(url), headers: init.headers as Record<string, string>, body: init.body ? JSON.parse(String(init.body)) : undefined };
    calls.push(c);
    const r = reply(c);
    if (!r) throw new Error(`unexpected ${c.method} ${c.url}`);
    return r;
  }) as typeof fetch;
  return calls;
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const PAT = "gd_pat_abc";
const SSO = "KEY:SECRET";
// the way own.run calls it: input checked against the action's schema first
const run = (action: string, input: unknown, key = PAT) => {
  const a = godaddy.actions[action]!;
  return a.run(a.input.parse(input), key);
};
const fails = (p: Promise<unknown>) =>
  p.then(
    () => {
      throw new Error("expected it to fail");
    },
    (e: AppsError) => e,
  );

test("a token is accepted and names the account; a refused one is refused", async () => {
  const calls = stub(() => json({ shopperId: "123", nameFirst: "Ada", nameLast: "Lovelace", email: "a@x.com" }));
  expect(await godaddy.check(PAT)).toBe("Ada Lovelace");
  expect(calls[0]!.url.href).toBe("https://api.godaddy.com/v1/shoppers/MY");
  expect(calls[0]!.headers.Authorization).toBe(`Bearer ${PAT}`);

  stub(() => json({ code: "UNABLE_TO_AUTHENTICATE", message: "Could not authenticate" }, 401));
  expect((await fails(godaddy.check(SSO))).expired).toBe(true);
  expect(await fails(godaddy.check("   "))).toBeInstanceOf(AppsError);

  // a working token without the shopper scope still connects
  stub(() => json({ code: "ACCESS_DENIED", message: "missing scope" }, 403));
  expect(await godaddy.check(PAT)).toBeUndefined();
});

test("each API gets the login it takes: PAT for v3, the classic key for certificates, either for v1", async () => {
  const calls = stub(() => json({ items: [] }));
  const both = `${PAT} ${SSO}`;
  await run("list_dns_records", { zone: "example.com" }, both);
  await run("certificate_get", { certificateId: "c1" }, both);
  await run("v1_list_domains", {}, both);
  await run("v1_list_domains", {}, SSO);
  expect(calls.map((c) => c.headers.Authorization)).toEqual([`Bearer ${PAT}`, `sso-key ${SSO}`, `Bearer ${PAT}`, `sso-key ${SSO}`]);
  expect(calls[0]!.url.origin + calls[0]!.url.pathname).toBe("https://api.godaddy.com/v3/domains/zones/example.com/dns-records");
  expect(calls[1]!.url.pathname).toBe("/v1/certificates/c1");
});

test("a token refused by a classic-key API says to add the key, without marking the login dead", async () => {
  stub(() => json({ code: "UNABLE_TO_AUTHENTICATE", message: "Could not authenticate API key/secret" }, 401));
  const e = await fails(run("auctions_get_payment_profiles", { customerId: "MY" }));
  expect(e.expired).toBe(false);
  expect(e.message).toContain("add KEY:SECRET");
  // the same 401 on an API the token is for means the token is dead
  expect((await fails(run("list_domains", {}))).expired).toBe(true);
});

test("body fields go in the body, and the de-duplication key is filled in", async () => {
  const calls = stub(() => json({ recordId: "r1" }));
  await run("create_dns_record", { zone: "example.com", name: "www", type: "CNAME", data: "example.com", ttl: 600 });
  expect(calls[0]!.method).toBe("POST");
  expect(calls[0]!.body).toEqual({ name: "www", type: "CNAME", data: "example.com", ttl: 600 });
  await run("set_auto_renew", { domain_name: "example.com", body: true });
  expect(calls[1]!.url.pathname).toBe("/v3/domains/domain-names/example.com/auto-renew");
  expect(calls[1]!.headers["Idempotency-Key"]).toMatch(/^[0-9a-f-]{36}$/);
});

test("hosting's partial updates go as JSON Patch, orders carry the app key", async () => {
  const calls = stub(() => json({ ok: true }));
  await run("hosting_update_app", { appId: "a1", body: [{ op: "replace", path: "/name", value: "Shop" }] });
  expect(calls[0]!.method).toBe("PATCH");
  expect(calls[0]!.url.href).toBe("https://api.godaddy.com/v1/hosting/apps/a1");
  expect(calls[0]!.headers["Content-Type"]).toBe("application/json-patch+json");
  expect(calls[0]!.body).toEqual([{ op: "replace", path: "/name", value: "Shop" }]);
  await run("list_orders", {}, SSO);
  expect(calls[1]!.headers["X-App-Key"]).toBe("emplio");
});

test("a domain's transfer code is hidden from reads and given only by the action that asks", async () => {
  stub(() => json({ domain: "example.com", status: "ACTIVE", authCode: "s3cret" }));
  expect(((await run("v1_get_domain", { domain: "example.com" })) as any).authCode).not.toBe("s3cret");
  expect(((await run("get_domain_auth_code", { domain: "example.com" })) as any).authCode).toBe("s3cret");
  expect(godaddy.actions.get_domain_auth_code!.readOnly).toBeFalsy();
});

test("reads run unasked, writes and secrets ask", () => {
  const a = godaddy.actions;
  for (const n of ["list_domains", "v1_list_domains", "check_availability", "quote_domain_registration", "shopping_search_catalog", "list_subscriptions"]) expect(a[n]!.readOnly).toBe(true);
  for (const n of ["register_domain", "v1_purchase_domain", "delete_dns_record", "certificate_revoke", "cancel_subscription", "certificate_get_acme_external_account_binding", "commerce_orders_graphql"])
    expect(a[n]!.readOnly).toBe(false);
});

test("GraphQL errors that come back as a 200 fail", async () => {
  stub(() => json({ data: null, errors: [{ message: "UNAUTHENTICATED" }] }));
  expect((await fails(run("commerce_orders_graphql", { x_store_id: "s1", query: "{ orders { edges { node { id } } } }" }))).message).toBe("GoDaddy: UNAUTHENTICATED");
});

test("polls: new and expiring domains, changed DNS, filters", async () => {
  const now = Date.now();
  const iso = (ms: number) => new Date(ms).toISOString();
  const list = [
    { domain: "new.com", status: "ACTIVE", createdAt: iso(now - 3600_000), expires: iso(now + 400 * 86_400_000), renewAuto: true },
    { domain: "old.com", status: "ACTIVE", createdAt: iso(now - 90 * 86_400_000), expires: iso(now + 10 * 86_400_000), renewAuto: false },
    { domain: "auto.com", status: "ACTIVE", createdAt: iso(now - 90 * 86_400_000), expires: iso(now + 5 * 86_400_000), renewAuto: true },
  ];
  const run = async (action: string, input: any) => {
    if (action === "godaddy.v1_list_domains") return list;
    if (action === "godaddy.list_dns_records") return { items: input.page === 1 ? [{ recordId: "r1", name: "@", type: "A", data: "1.2.3.4", ttl: 600 }] : [] };
    throw new Error(action);
  };
  expect((await polls.new_domain!.poll({}, run)).map((i) => i.id)).toEqual(["new.com"]);
  expect((await polls.domain_expiring_soon!.poll({ days: 30 }, run)).map((i) => i.id)).toEqual([`old.com:${list[1]!.expires}`, `auto.com:${list[2]!.expires}`]);
  expect((await polls.domain_expiring_soon!.poll({ days: 30, only_manual_renewal: true }, run)).map((i) => i.id)).toEqual([`old.com:${list[1]!.expires}`]);
  expect((await polls.domain_status_changed!.poll({ domain: "old.com" }, run)).map((i) => i.id)).toEqual(["old.com:ACTIVE"]);
  expect((await polls.dns_record_changed!.poll({ domain: "x.com" }, run)).map((i) => i.id)).toEqual(["r1:1.2.3.4:600:"]);
});
