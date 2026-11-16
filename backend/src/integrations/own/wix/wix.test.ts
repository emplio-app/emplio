import { afterEach, expect, test } from "bun:test";
import { AppsError } from "../../types";
// load the poll registry first: polls/wix and polls/index import each other
import "../../polls";
import { wix as polls } from "../../polls/wix";
import { wix } from "./index";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
type Sent = { url: string; method?: string; headers: Record<string, string>; body?: any };
const fake = (reply: (s: Sent) => Response) => {
  const sent: Sent[] = [];
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    const s = { url, method: init.method, headers: init.headers as Record<string, string>, body: init.body ? JSON.parse(init.body as string) : undefined };
    sent.push(s);
    return reply(s);
  }) as typeof fetch;
  return sent;
};
const KEY = "IST.key site-1";

test("a key with its site id is checked against that site, and labelled with its name", async () => {
  const sent = fake(() => json({ properties: { siteDisplayName: "Bloom Bakery" } }));
  expect(await wix.check(` ${KEY} `)).toBe("Bloom Bakery");
  expect(sent[0]!.url).toBe("https://www.wixapis.com/site-properties/v4/properties");
  expect(sent[0]!.headers).toMatchObject({ Authorization: "IST.key", "wix-site-id": "site-1" });
  expect(sent[0]!.headers["wix-account-id"]).toBeUndefined();
});

test("a key without a site id, or one Wix refuses, is turned away", async () => {
  await expect(wix.check("IST.key")).rejects.toBeInstanceOf(AppsError);
  fake(() => json({ message: "unauthorized" }, 401));
  await expect(wix.check(KEY)).rejects.toThrow("rejected the token");
});

test("lookups run unasked, changes and secrets ask first", () => {
  expect(Object.keys(wix.actions).length).toBeGreaterThan(2000);
  expect(wix.actions.query_contacts!.readOnly).toBe(true); // a POST that only reads
  expect(wix.actions.query_e_commerce_orders!.readOnly).toBe(true);
  expect(wix.actions.create_contact!.readOnly).toBe(false);
  expect(wix.actions.get_secret_value!.readOnly).toBe(false);
  expect(wix.actions.create_contacts_labels!.readOnly).toBe(false); // "find or create"
});

test("a site call sends the site id; an account call the account id, or the site's when there is none", async () => {
  const sent = fake(() => json({ sites: [] }));
  await wix.actions.query_sites!.run({ query: {} }, `${KEY} acct-9`);
  expect(sent[0]!.headers["wix-account-id"]).toBe("acct-9");
  expect(sent[0]!.headers["wix-site-id"]).toBeUndefined();
  await wix.actions.query_sites!.run({ query: {} }, KEY);
  expect(sent[1]!.headers["wix-site-id"]).toBe("site-1");
  await wix.actions.query_contacts!.run({ query: { paging: { limit: 1 } } }, `${KEY} acct-9`);
  expect(sent[2]!.headers["wix-site-id"]).toBe("site-1");
  expect(sent[2]!.headers["wix-account-id"]).toBeUndefined();
  expect(sent[2]!.body).toEqual({ query: { paging: { limit: 1 } } });
});

test("calls go to the public address the docs' examples use, with nested query params dotted", async () => {
  const sent = fake(() => json({ posts: [] }));
  await wix.actions.list_posts!.run({ "paging.limit": 5, sort: "PUBLISHED_DATE_DESC" }, KEY);
  expect(sent[0]!.url).toBe("https://www.wixapis.com/blog/v3/posts?paging.limit=5&sort=PUBLISHED_DATE_DESC");
  await wix.actions.get_contact!.run({ id: "c 1" }, KEY);
  expect(sent[1]!.url).toBe("https://www.wixapis.com/contacts/v4/contacts/c%201");
});

const now = new Date().toISOString();
const old = "2020-01-01T00:00:00Z";

test("orders: paid and changed each count once, filtered by Wix", async () => {
  const calls: [string, any][] = [];
  const run = async (action: string, input: any) => (calls.push([action, input]), { orders: [{ id: "o1", updatedDate: now }] });
  expect(await polls.order_paid!.poll({}, run)).toEqual([{ id: "o1:paid", item: { order: { id: "o1", updatedDate: now } } }]);
  expect(calls[0]![0]).toBe("wix.query_e_commerce_orders");
  expect(calls[0]![1].search.filter.paymentStatus).toBe("PAID");
  expect(calls[0]![1].search.filter.updatedDate.$gte).toBeString();
  expect((await polls.order_updated!.poll({}, run))[0]!.id).toBe(`o1:${now}`);
});

test("form submissions: one form, only the last day's", async () => {
  let input: any;
  const run = async (_a: string, i: any) => ((input = i), { submissions: [{ id: "s1", createdDate: now }, { id: "s0", createdDate: old }] });
  const got = await polls.form_submission_created!.poll(polls.form_submission_created!.config.parse({ formId: "f1" }), run);
  expect(got.map((g) => g.id)).toEqual(["s1"]);
  expect(input.query.filter).toEqual({ namespace: "wix.form_app.form", formId: "f1" });
});

test("low stock: the v3 catalog, or the v1 one where v3 isn't there", async () => {
  const v3 = async () => ({ inventoryItems: [{ id: "i1", quantity: 2, trackQuantity: true, updatedDate: now }, { id: "i2", quantity: 50, trackQuantity: true, updatedDate: now }] });
  expect((await polls.low_stock!.poll({ threshold: 5 }, v3)).map((g) => g.id)).toEqual(["i1:2"]);
  const v1 = async (action: string) => {
    if (action === "wix.query_inventory_items") throw new AppsError("Wix: catalog v1 site (428)");
    return { inventoryItems: [{ id: "p1", trackQuantity: true, variants: [{ variantId: "v1", quantity: 1 }, { variantId: "v2", quantity: 9 }] }] };
  };
  expect((await polls.low_stock!.poll({ threshold: 5 }, v1)).map((g) => g.id)).toEqual(["p1:v1:1"]);
});

test("bookings: canceled ones only, from the extended booking", async () => {
  const run = async () => ({ extendedBookings: [{ booking: { id: "b1", status: "CANCELED", updatedDate: now } }, { booking: { id: "b2", status: "CONFIRMED", updatedDate: now } }] });
  expect((await polls.booking_canceled!.poll({}, run)).map((g) => g.id)).toEqual(["b1:canceled"]);
});
