import { afterEach, beforeAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import Fastify from "fastify";
import { automationRoutes } from "../../../automations";
import { AppsError } from "../../types";
import { own } from "../index";
import { formObject, hookUrl, receive, wanted } from "./triggers";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});
beforeAll(() => {
  process.env.ENCRYPTION_KEY ??= "test-key";
  process.env.WEBHOOK_URL = "https://api.test";
});
const KEY = "abc123-us21";
const login = { externalId: "c1", secret: KEY };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
type Call = { url: string; method: string; auth: string; body: any };
const stub = (answer: (c: Call) => Response) => {
  const calls: Call[] = [];
  globalThis.fetch = (async (url: string, init: RequestInit = {}) => {
    const c = { url: String(url), method: init.method ?? "GET", auth: (init.headers as Record<string, string>).Authorization!, body: init.body ? JSON.parse(String(init.body)) : undefined };
    calls.push(c);
    return answer(c);
  }) as typeof fetch;
  return calls;
};

test("a key is checked on its own data centre, and labelled with the account", async () => {
  const calls = stub(() => json({ account_name: "Acme Bakery" }));
  expect(await own.connectWithKey!("mailchimp", ` ${KEY} `)).toEqual({ secret: KEY, label: "Acme Bakery" });
  expect(calls[0]!.url).toBe("https://us21.api.mailchimp.com/3.0/?fields=account_name%2Cemail");
  expect(calls[0]!.auth).toBe(`Basic ${Buffer.from(`emplio:${KEY}`).toString("base64")}`);
});

test("a bad key is refused, and one without a data centre never leaves the server", async () => {
  stub(() => json({ title: "API Key Invalid", status: 401 }, 401));
  await expect(own.connectWithKey!("mailchimp", KEY)).rejects.toBeInstanceOf(AppsError);
  const calls = stub(() => json({}));
  await expect(own.connectWithKey!("mailchimp", "abc123")).rejects.toThrow(/data centre/);
  await expect(own.connectWithKey!("mailchimp", "abc-evil.com/x")).rejects.toThrow(/data centre/);
  expect(calls).toHaveLength(0);
});

test("reads run unasked, writes ask, and a contact can be named by email", async () => {
  expect((await own.getAction("mailchimp.get_lists_info"))?.readOnly).toBe(true);
  expect((await own.getAction("mailchimp.verify_connected_site_script"))?.readOnly).toBe(true);
  expect((await own.getAction("mailchimp.send_campaign"))?.readOnly).toBe(false);
  expect((await own.getAction("mailchimp.add_or_update_list_member"))?.readOnly).toBe(false);
  const calls = stub(() => json({ id: "x" }));
  await own.run("mailchimp.get_member_info", { list_id: "L1", subscriber_hash: " Ann@Example.com " }, login, "o");
  expect(calls[0]!.url).toBe(`https://us21.api.mailchimp.com/3.0/lists/L1/members/${createHash("md5").update("ann@example.com").digest("hex")}`);
  await own.run("mailchimp.get_lists_info", { fields: ["lists.id", "lists.name"], count: 5 }, login, "o");
  expect(calls[1]!.url).toBe("https://us21.api.mailchimp.com/3.0/lists?fields=lists.id%2Clists.name&count=5&offset=0");
});

test("saving an automation puts one webhook on the audience, extends it, and takes it off at the end", async () => {
  const url = hookUrl("c1", "L1");
  const add = stub((c) => json(c.method === "GET" ? { webhooks: [] } : { id: "w1" }));
  expect(await own.startPush!("mailchimp.subscribe_trigger", login, { list_id: "L1" })).toBe("mailchimp:c1:L1");
  expect(add[1]).toMatchObject({ method: "POST", url: "https://us21.api.mailchimp.com/3.0/lists/L1/webhooks" });
  expect(add[1]!.body).toEqual({ url, events: { subscribe: true }, sources: { user: true, admin: true, api: true } });

  const hook = { id: "w1", url, events: { subscribe: true, unsubscribe: false } };
  const extend = stub(() => json({ webhooks: [hook] }));
  await own.startPush!("mailchimp.unsubscribe_trigger", login, { list_id: "L1" });
  expect(extend[1]).toMatchObject({ method: "PATCH", url: "https://us21.api.mailchimp.com/3.0/lists/L1/webhooks/w1" });
  expect(extend[1]!.body.events).toEqual({ subscribe: true, unsubscribe: true });
  const none = stub(() => json({ webhooks: [hook] }));
  await own.startPush!("mailchimp.subscribe_trigger", login, { list_id: "L1" });
  expect(none).toHaveLength(1);

  await expect(own.startPush!("mailchimp.subscribe_trigger", login, {})).rejects.toBeInstanceOf(AppsError);
  const { mailchimp } = await import("./index");
  const gone = stub(() => json({ webhooks: [hook] }));
  await mailchimp.push!.stop!(KEY, "mailchimp:c1:L1");
  expect(gone[1]).toMatchObject({ method: "DELETE", url: "https://us21.api.mailchimp.com/3.0/lists/L1/webhooks/w1" });
});

test("a delivery is read from its form, starts only its own trigger, and needs the address's token", async () => {
  const token = hookUrl("c1", "L1").split("/").pop()!;
  const body = "type=subscribe&fired_at=2026-11-19+10%3A00%3A00&data%5Bid%5D=8a&data%5Blist_id%5D=L1&data%5Bemail%5D=ann%40example.com&data%5Bmerges%5D%5BFNAME%5D=Ann";
  const got = await receive({ body, headers: {}, connection: "c1", rest: `L1/${token}` });
  const [event] = await got!.events();
  expect(event!.triggers).toEqual(["subscribe_trigger"]);
  expect(event!.data).toEqual({ event: "subscribe", fired_at: "2026-11-19 10:00:00", id: "8a", list_id: "L1", email: "ann@example.com", merges: { FNAME: "Ann" } });
  expect(event!.id).toBeString();
  expect(await receive({ body, headers: {}, connection: "c1", rest: `L1/${"0".repeat(64)}` })).toBeNull();
  expect(await receive({ body, headers: {}, connection: "c2", rest: `L1/${token}` })).toBeNull();
  const [campaign] = await (await receive({ body: "type=campaign&data[id]=cmp&data[status]=sent", headers: {}, connection: "c1", rest: `L1/${token}` }))!.events();
  expect(campaign!.triggers).toEqual(["campaign_trigger"]);
});

test("filters, and a form can't reach the object prototype", () => {
  expect(wanted({ list_id: "L1" }, { email: "a@b.c" })).toBe(true);
  expect(wanted({ email: "A@B.c" }, { email: "a@b.c" })).toBe(true);
  expect(wanted({ email: "x@b.c" }, { email: "a@b.c" })).toBe(false);
  expect(wanted({ email: "new@b.c" }, { old_email: "a@b.c", new_email: "new@b.c" })).toBe(true);
  formObject("__proto__[polluted]=1&data[constructor][prototype][x]=1");
  expect(({} as Record<string, unknown>).polluted).toBeUndefined();
});

test("the shared route answers Mailchimp's address check and takes form bodies", async () => {
  const app = Fastify();
  await automationRoutes(app);
  expect((await app.inject({ method: "GET", url: "/webhooks/app/mailchimp/c1/L1/tok" })).statusCode).toBe(200);
  expect((await app.inject({ method: "GET", url: "/webhooks/app/nope/c1/L1/tok" })).statusCode).toBe(404);
  const post = await app.inject({ method: "POST", url: "/webhooks/app/nope/c1/L1", headers: { "content-type": "application/x-www-form-urlencoded" }, payload: "type=subscribe" });
  expect(post.statusCode).toBe(401);
  await app.close();
});
