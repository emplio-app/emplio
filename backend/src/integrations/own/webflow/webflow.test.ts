import { afterEach, beforeAll, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { AppFile, AppsError } from "../../types";
import { own } from "../index";
import { pollTrigger } from "../../polls/index";
import { triggers, wanted } from "./triggers";
import { webflow } from "./index";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});
beforeAll(() => {
  process.env.ENCRYPTION_KEY ??= "test-key";
  process.env.WEBHOOK_URL = "https://api.test";
});
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
type Call = { url: string; method: string; body: unknown; headers: Record<string, string> };
const stub = (answer: (c: Call) => Response) => {
  const calls: Call[] = [];
  globalThis.fetch = (async (url: string, init: RequestInit = {}) => {
    const c = { url: String(url), method: init.method ?? "GET", body: init.body instanceof FormData ? init.body : String(init.body ?? ""), headers: init.headers as Record<string, string> };
    calls.push(c);
    return answer(c);
  }) as typeof fetch;
  return calls;
};
const login = { externalId: "c1", secret: "tok" };
const token = () => createHmac("sha256", process.env.ENCRYPTION_KEY!).update("webflow-webhook:c1").digest("hex");
const target = () => `https://api.test/webhooks/app/webflow/c1/${token()}`;
const delivery = (body: unknown, rest = token()) => ({ body: JSON.stringify(body), headers: {}, connection: "c1", rest });
const fire = async (triggerType: string, payload: unknown = {}) => (await (await webflow.push!.receive!(delivery({ triggerType, payload }), "k"))!.events())[0]?.triggers ?? [];

test("a site token is checked with Bearer and labelled with its site, and a bad one is refused as dead", async () => {
  const calls = stub(() => json({ sites: [{ id: "s1", displayName: "Northwind" }] }));
  expect(await own.connectWithKey!("webflow", " tok ")).toEqual({ secret: "tok", label: "Northwind" });
  expect(calls[0]!.url).toBe("https://api.webflow.com/v2/sites");
  expect(calls[0]!.headers.Authorization).toBe("Bearer tok");
  stub(() => json({ code: "not_authorized", message: "Request not authorized" }, 401));
  const refused = await own.connectWithKey!("webflow", "nope").catch((e) => e);
  expect(refused).toBeInstanceOf(AppsError);
  expect(refused.expired).toBe(true);
});

test("calls go to the Data API, ids aren't filled with null, and bracket params are spread out", async () => {
  const calls = stub(() => json({ items: [] }));
  await own.run("webflow.create_collection_item", { collection_id: "col1", body: { fieldData: { name: "Hello", slug: "hello" } } }, login, "o");
  expect(calls[0]!.url).toStartWith("https://api.webflow.com/v2/collections/col1/items");
  expect(JSON.parse(calls[0]!.body as string)).toMatchObject({ fieldData: { name: "Hello", slug: "hello" } });
  await expect(own.run("webflow.get_site_info", {}, login, "o")).rejects.toThrow();
  await own.run("webflow.list_collection_items", { collection_id: "col1", limit: 5, lastUpdated: { gte: "2026-01-01" }, sort: { price: "desc" } }, login, "o");
  const url = new URL(calls[1]!.url);
  expect(url.pathname).toBe("/v2/collections/col1/items");
  expect(url.searchParams.get("limit")).toBe("5");
  expect(url.searchParams.get("lastUpdated[gte]")).toBe("2026-01-01");
  expect(url.searchParams.get("sort[price]")).toBe("desc");
  expect(url.searchParams.has("lastUpdated")).toBe(false);
});

test("reads run unasked, writes ask, and webhooks (which carry signing keys) ask first", async () => {
  for (const a of ["list_webflow_sites", "list_collection_items", "list_form_submissions", "get_order"]) expect((await own.getAction(`webflow.${a}`))?.readOnly).toBe(true);
  for (const a of ["publish_site", "create_collection_item", "refund_order", "upload_asset", "list_webhooks"]) expect((await own.getAction(`webflow.${a}`))?.readOnly).toBeFalsy();
});

test("upload_asset tells Webflow, then sends the file to its storage with the details it gave", async () => {
  const calls = stub((c) =>
    c.url.includes("api.webflow.com")
      ? json({ id: "a1", hostedUrl: "https://cdn/a1.png", uploadUrl: "https://s3.test/up", uploadDetails: { key: "k1", policy: "p" } })
      : new Response(null, { status: 201 }),
  );
  const file = new AppFile("logo.png", "image/png", new Uint8Array([1, 2, 3]));
  expect(await own.run("webflow.upload_asset", { site_id: "s1", file }, login, "o")).toEqual({ id: "a1", hostedUrl: "https://cdn/a1.png" });
  expect(JSON.parse(calls[0]!.body as string)).toEqual({ fileName: "logo.png", fileHash: "5289df737df57326fcdd22597afb1fac" });
  const form = calls[1]!.body as FormData;
  expect(calls[1]!.url).toBe("https://s3.test/up");
  expect(form.get("key")).toBe("k1");
  expect((form.get("file") as File).name).toBe("logo.png");
});

test("the first automation of a kind makes its webhook on the token's site, the next reuses it", async () => {
  const made = stub((c) => (c.url.endsWith("/sites") ? json({ sites: [{ id: "s1" }] }) : c.method === "GET" ? json({ webhooks: [] }) : json({ id: "w1" })));
  expect(await own.startPush!("webflow.new_form_submission", login, {})).toBe("webflow:c1:s1:form_submission");
  expect(made.map((c) => `${c.method} ${c.url}`)).toEqual(["GET https://api.webflow.com/v2/sites", "GET https://api.webflow.com/v2/sites/s1/webhooks", "POST https://api.webflow.com/v2/sites/s1/webhooks"]);
  expect(JSON.parse(made[2]!.body as string)).toEqual({ triggerType: "form_submission", url: target() });
  const reused = stub(() => json({ webhooks: [{ id: "w1", triggerType: "collection_item_changed", url: target() }] }));
  expect(await own.startPush!("webflow.collection_item_updated", login, { site_id: "s2" })).toBe("webflow:c1:s2:collection_item_changed");
  expect(reused).toHaveLength(1);
});

test("the last automation removes only our webhook of that kind", async () => {
  const calls = stub((c) =>
    c.method === "GET"
      ? json({ webhooks: [{ id: "w1", triggerType: "form_submission", url: target() }, { id: "w2", triggerType: "site_publish", url: target() }, { id: "w3", triggerType: "form_submission", url: "https://other" }] })
      : json({}),
  );
  await webflow.push!.stop!("k", "webflow:c1:s1:form_submission");
  expect(calls.slice(1).map((c) => `${c.method} ${c.url}`)).toEqual(["DELETE https://api.webflow.com/v2/webhooks/w1"]);
});

test("a wrong or missing token in the address is refused", async () => {
  expect(await webflow.push!.receive!(delivery({ triggerType: "form_submission" }, "nope"), "k")).toBeNull();
  expect(await webflow.push!.receive!(delivery({ triggerType: "form_submission" }, ""), "k")).toBeNull();
});

test("each event starts only the right triggers, and a retry has the same id", async () => {
  expect(await fire("form_submission")).toEqual(["new_form_submission"]);
  expect(await fire("collection_item_changed")).toEqual(["collection_item_updated"]);
  expect(await fire("ecomm_order_changed")).toEqual(["order_updated"]);
  expect(await fire("page_metadata_updated")).toEqual(["page_updated"]);
  expect(await fire("comment_created")).toEqual(["new_comment"]);
  expect(await fire("mystery")).toEqual([]);
  const body = { triggerType: "site_publish", payload: { siteId: "s1" } };
  const [a] = await (await webflow.push!.receive!(delivery(body), "k"))!.events();
  const [b] = await (await webflow.push!.receive!(delivery(body), "k"))!.events();
  expect(a!.id).toBe(b!.id!);
  expect(a!.data).toEqual({ event: "site_publish", payload: { siteId: "s1" } });
});

test("filters narrow what runs", () => {
  const form = { event: "form_submission", payload: { name: "Contact", formId: "f1" } };
  expect(wanted({}, form)).toBe(true);
  expect(wanted({ form_name: "Contact", form_id: "f1" }, form)).toBe(true);
  expect(wanted({ form_name: "Quote" }, form)).toBe(false);
  expect(wanted({ collection_id: "c1" }, { event: "collection_item_created", payload: { collectionId: "c1" } })).toBe(true);
  expect(wanted({ collection_id: "c2" }, { event: "collection_item_created", payload: { collectionId: "c1" } })).toBe(false);
  expect(wanted({ collection_id: "c1" }, { event: "collection_item_published", payload: { items: [{ collectionId: "c1" }] } })).toBe(true);
  expect(wanted({ status: "refunded" }, { event: "ecomm_order_changed", payload: { status: "fulfilled" } })).toBe(false);
});

test("every Webflow webhook type has a trigger", () => {
  const types = ["form_submission", "site_publish", "page_created", "page_metadata_updated", "page_deleted", "ecomm_new_order", "ecomm_order_changed", "ecomm_inventory_changed", "collection_item_created", "collection_item_changed", "collection_item_deleted", "collection_item_published", "collection_item_unpublished", "comment_created"];
  expect(Object.values(webflow.push!.events).sort()).toEqual(types.sort());
  expect(Object.keys(triggers)).toHaveLength(types.length);
});

test("polls report only recent products and assets, on the token's site", async () => {
  const now = new Date().toISOString();
  const run = async (action: string, input: any) => {
    if (action === "webflow.list_webflow_sites") return { sites: [{ id: "s1" }] };
    expect(input.site_id).toBe("s1");
    return action === "webflow.list_products_skus"
      ? { items: [{ product: { id: "p1", createdOn: now } }, { product: { id: "p2", createdOn: "2020-01-01T00:00:00Z" } }] }
      : { assets: [{ id: "a1", createdOn: now }, { id: "a2", createdOn: "2020-01-01T00:00:00Z" }] };
  };
  expect((await pollTrigger("webflow.new_product")!.poll({}, run)).map((i) => i.id)).toEqual(["p1"]);
  expect((await pollTrigger("webflow.new_asset")!.poll({}, run)).map((i) => i.id)).toEqual(["a1"]);
});
