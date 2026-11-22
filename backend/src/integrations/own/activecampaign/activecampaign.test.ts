import { afterEach, beforeAll, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { pollOnce } from "../../polls";
import { AppsError } from "../../types";
import { own } from "../index";
import { parseKey } from "./api";
import { activecampaign } from "./index";
import { events, parseBody, triggers, wanted } from "./triggers";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});
beforeAll(() => {
  process.env.ENCRYPTION_KEY ??= "test-key";
  process.env.WEBHOOK_URL = "https://api.test";
});
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
type Call = { url: string; method: string; body: BodyInit | null | undefined; headers: Record<string, string> };
const stub = (answer: (c: Call) => Response) => {
  const calls: Call[] = [];
  globalThis.fetch = (async (url: string, init: RequestInit = {}) => {
    const c = { url: String(url), method: init.method ?? "GET", body: init.body, headers: (init.headers ?? {}) as Record<string, string> };
    calls.push(c);
    return answer(c);
  }) as typeof fetch;
  return calls;
};
const TOKEN = "0a1b2c3d4e5f0a1b2c3d4e5f0a1b2c3d4e5f0a1b2c3d4e5f0a1b2c3d4e5f0a1b2c3d4e5f";
const KEY = `https://acme.api-us1.com ${TOKEN}`;
const login = { externalId: "c1", secret: KEY };
const run = (a: string, i: unknown) => own.run(a, i as Record<string, unknown>, login, "o");
const urlToken = () => createHmac("sha256", process.env.ENCRYPTION_KEY!).update("activecampaign-webhook:c1").digest("hex");
const target = () => `https://api.test/webhooks/app/activecampaign/c1/${urlToken()}`;

test("the key is the API URL and key in either order; a host outside ActiveCampaign is refused", () => {
  const want = { origin: "https://acme.api-us1.com", token: TOKEN };
  expect(parseKey(KEY)).toEqual(want);
  expect(parseKey(` ${TOKEN}  acme.api-us1.com/api/3/ `)).toEqual(want);
  expect(parseKey(`https://acme.activehosted.com ${TOKEN}`).origin).toBe("https://acme.activehosted.com");
  expect(() => parseKey(`https://evil.com ${TOKEN}`)).toThrow(AppsError);
  expect(() => parseKey(`https://acme.api-us1.com.evil.com ${TOKEN}`)).toThrow(AppsError);
  expect(() => parseKey(TOKEN)).toThrow(/two things/);
});

test("a login is checked on the person's own host with Api-Token and labelled; a bad one is refused as dead", async () => {
  const calls = stub(() => json({ user: { firstName: "Sarah", lastName: "Lee", email: "sarah@northwind.com" } }));
  expect(await own.connectWithKey!("activecampaign", KEY)).toEqual({ secret: KEY, label: "Sarah Lee (acme)" });
  expect(calls[0]!.url).toBe("https://acme.api-us1.com/api/3/users/me");
  expect(calls[0]!.headers["Api-Token"]).toBe(TOKEN);
  stub(() => json({ message: "Forbidden" }, 403));
  const refused = await own.connectWithKey!("activecampaign", KEY).catch((e) => e);
  expect(refused).toBeInstanceOf(AppsError);
  expect(refused.expired).toBe(true);
});

test("reads run unasked, writes ask, the API key itself asks, and a looking-up POST is a read", async () => {
  for (const a of ["list_all_contacts", "find_contact", "retrieve_all_deals", "get_lists", "preview_campaign_message", "graphql_query", "get_api"])
    expect((await own.getAction(`activecampaign.${a}`))?.readOnly).toBe(true);
  for (const a of ["create_contact", "create_or_update_contact", "update_a_deal", "add_tag_to_contact", "create_webhook", "retrieve_api_credentials", "track_event", "graphql_mutation", "call_api"])
    expect((await own.getAction(`activecampaign.${a}`))?.readOnly).toBeFalsy();
});

test("a contact is created on the person's own host", async () => {
  const calls = stub(() => json({ contact: { id: "1" } }, 201));
  await run("activecampaign.create_contact", { contact: { email: "sarah@northwind.com", firstName: "Sarah" } });
  expect(calls[0]!.method).toBe("POST");
  expect(calls[0]!.url).toBe("https://acme.api-us1.com/api/3/contacts");
  expect(JSON.parse(String(calls[0]!.body))).toEqual({ contact: { email: "sarah@northwind.com", firstName: "Sarah" } });
});

test("other specs' calls go to the person's host too; event tracking goes to trackcmp.net as a form, without the API key", async () => {
  const calls = stub(() => json({ success: 1, message: "Event spawned" }));
  await run("activecampaign.create_shareable_campaign_template_link", { id: 3 });
  expect(calls[0]!.url).toStartWith("https://acme.api-us1.com/api/2/template/share");
  await run("activecampaign.track_event", { actid: "123", key: "ek", event: "Signed up", visit: '{"email":"sarah@northwind.com"}' });
  expect(calls[1]!.url).toBe("https://trackcmp.net/event");
  expect(calls[1]!.headers["Api-Token"]).toBeUndefined();
  expect(new URLSearchParams(String(calls[1]!.body)).get("event")).toBe("Signed up");
  stub(() => json({ success: 0, message: "Invalid key" }));
  await expect(run("activecampaign.track_event", { actid: "123", key: "x", event: "e", visit: "{}" })).rejects.toThrow(/Invalid key/);
});

test("GraphQL queries run, mutations go through the action that asks; a raw path can't leave the API", async () => {
  const calls = stub(() => json({ data: { products: [] } }));
  await run("activecampaign.graphql_query", { query: "query { products { id } }" });
  expect(calls[0]!.url).toBe("https://acme.api-us1.com/api/3/ecom/graphql");
  await expect(run("activecampaign.graphql_query", { query: "mutation { x }" })).rejects.toThrow(/graphql_mutation/);
  await run("activecampaign.get_api", { path: "/labels", query: { limit: 5 } });
  expect(calls[1]!.url).toBe("https://acme.api-us1.com/api/3/labels?limit=5");
  await run("activecampaign.call_api", { method: "POST", path: "/labels", body: { label: { name: "VIP" } } });
  expect(JSON.parse(String(calls[2]!.body))).toEqual({ label: { name: "VIP" } });
  await expect(run("activecampaign.get_api", { path: "/../../evil" })).rejects.toThrow(/inside the API/);
});

test("the first trigger makes one webhook for the connection, the next adds its event, and the last removes it", async () => {
  const none = stub((c) => (c.method === "GET" ? json({ webhooks: [] }) : json({ webhook: { id: "7" } }, 201)));
  expect(await own.startPush!("activecampaign.contact_subscribed", login, {})).toBe("activecampaign:c1");
  expect(new URL(none[0]!.url).searchParams.get("filters[url]")).toBe(target());
  expect(none[1]!.method).toBe("POST");
  const made = JSON.parse(String(none[1]!.body)).webhook;
  expect(made).toEqual({ name: "Emplio", url: target(), events: ["subscribe"], sources: ["public", "admin", "api", "system"] });
  const hooks = { webhooks: [{ id: "6", url: "https://other" }, { id: "7", url: target(), events: ["subscribe"] }] };
  const same = stub(() => json(hooks));
  await own.startPush!("activecampaign.contact_subscribed", login, {});
  expect(same).toHaveLength(1);
  const extend = stub((c) => (c.method === "GET" ? json(hooks) : json({})));
  await own.startPush!("activecampaign.deal_won", login, {});
  expect(extend[1]!.method).toBe("PUT");
  expect(extend[1]!.url).toBe("https://acme.api-us1.com/api/3/webhooks/7");
  expect(JSON.parse(String(extend[1]!.body)).webhook.events).toEqual(["subscribe", "deal_update"]);
  const gone = stub((c) => (c.method === "GET" ? json(hooks) : json({})));
  await activecampaign.push!.stop!(KEY, "activecampaign:c1");
  expect(gone.map((c) => `${c.method} ${c.url}`)).toEqual([`GET https://acme.api-us1.com/api/3/webhooks?filters%5Burl%5D=${encodeURIComponent(target())}`, "DELETE https://acme.api-us1.com/api/3/webhooks/7"]);
});

const form = (fields: Record<string, string>) => new URLSearchParams(fields).toString();
const delivery = (body: string, rest = urlToken()) => ({ body, headers: { "content-type": "application/x-www-form-urlencoded" }, connection: "c1", rest });
const start = async (body: string) => (await (await activecampaign.push!.receive!(delivery(body), KEY))!.events())[0];

test("the form body becomes nested objects, and can't reach the prototype", () => {
  expect(parseBody("type=update&contact[id]=5&contact[fields][3]=x&updated_fields[0]=title")).toEqual({ type: "update", contact: { id: "5", fields: { "3": "x" } }, updated_fields: { "0": "title" } });
  expect(({} as any).polluted).toBeUndefined();
  parseBody("__proto__[polluted]=1&constructor[prototype][polluted]=1");
  expect(({} as any).polluted).toBeUndefined();
});

test("a delivery needs our URL token; each event starts only its triggers, a retry keeps its id", async () => {
  const body = form({ type: "subscribe", date_time: "2026-11-22 10:00:00", initiated_by: "public", list: "2", "contact[id]": "5", "contact[email]": "sarah@northwind.com" });
  expect(await activecampaign.push!.receive!(delivery(body, "nope"), KEY)).toBeNull();
  const first = await start(body);
  expect(first!.triggers).toEqual(["contact_subscribed"]);
  expect(first!.watch).toBe("activecampaign:c1");
  expect((first!.data as any).contact.email).toBe("sarah@northwind.com");
  expect((await start(body))!.id).toBe(first!.id);
  const won = await start(form({ type: "deal_update", "deal[id]": "9", "deal[status]": "1", "updated_fields[0]": "status" }));
  expect(won!.triggers).toEqual(["deal_updated", "deal_won"]);
  const moved = await start(form({ type: "deal_update", "deal[id]": "9", "deal[status]": "0", "updated_fields[0]": "stage" }));
  expect(moved!.triggers).toEqual(["deal_updated", "deal_stage_changed"]);
  expect((await start(form({ type: "contact_tag_added", tag: "VIP" })))!.triggers).toEqual(["contact_tag_added"]);
  expect(await start(form({ type: "something_new" }))).toBeUndefined();
});

test("filters: who caused it, list, tag, campaign, pipeline, stage, owner and changed field", () => {
  const deal = { type: "deal_update", initiated_by: "admin", deal: { pipelineid: "1", stageid: "3", owner: "4" }, updated_fields: { "0": "value" } };
  expect(wanted({}, deal)).toBe(true);
  expect(wanted({ source: "admin", pipeline_id: "1", stage_id: "3", owner_id: "4", field: "value" }, deal)).toBe(true);
  expect(wanted({ source: "api" }, deal)).toBe(false);
  expect(wanted({ stage_id: "2" }, deal)).toBe(false);
  expect(wanted({ field: "title" }, deal)).toBe(false);
  expect(wanted({ list_id: "2" }, { list: "2" })).toBe(true);
  expect(wanted({ tag: "vip" }, { tag: "VIP" })).toBe(true);
  expect(wanted({ campaign_id: "8" }, { campaign: { id: "7" } })).toBe(false);
});

test("new contacts are polled newest first, and only recent ones count", async () => {
  const now = new Date().toISOString();
  const calls = stub(() => json({ contacts: [{ id: "1", cdate: now }, { id: "2", cdate: "2020-01-01T00:00:00-05:00" }] }));
  const made = await pollOnce("activecampaign.new_contact", {}, [], run);
  expect(new URL(calls[0]!.url).searchParams.get("orders[cdate]")).toBe("desc");
  expect(made.seen).toEqual(["1"]);
});

test("every trigger has an event, none shares a polled one's name", async () => {
  const polled = (await import("../../polls/activecampaign")).activecampaign;
  expect(Object.keys(triggers).sort()).toEqual(Object.keys(events).sort());
  for (const t of Object.keys(triggers)) expect(polled[t]).toBeUndefined();
});
