import { afterEach, beforeAll, expect, spyOn, test } from "bun:test";
import { createHmac, randomBytes } from "node:crypto";
import Fastify from "fastify";
import { automationRoutes } from "../../../automations";
import { db } from "../../../db";
import { encrypt } from "../../../secrets";
import { AppFile, AppsError } from "../../types";
import { own } from "../index";
import { parseKey, storeDomain } from "./client";
import { mutates, operation, shopify } from "./index";
import { events, receive, wanted } from "./triggers";

beforeAll(() => {
  process.env.ENCRYPTION_KEY = randomBytes(32).toString("base64");
  process.env.WEBHOOK_URL = "https://api.test";
});
const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

type Call = { url: string; method: string; headers: Record<string, string>; body: any };
function stub(reply: (c: Call) => Response | undefined) {
  const calls: Call[] = [];
  globalThis.fetch = (async (url: string, init: RequestInit = {}) => {
    const raw = init.body;
    const body = raw instanceof FormData ? raw : typeof raw === "string" && raw.startsWith("{") ? JSON.parse(raw) : raw;
    const c = { url: String(url), method: init.method ?? "GET", headers: (init.headers ?? {}) as Record<string, string>, body };
    calls.push(c);
    const r = reply(c);
    if (!r) throw new Error(`unexpected ${c.method} ${c.url}`);
    return r;
  }) as typeof fetch;
  return calls;
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const GQL = "https://acme.myshopify.com/admin/api/2026-10/graphql.json";
const TOKEN = "acme.myshopify.com shpat_abc";
const run = (action: string, input: unknown, secret = TOKEN, externalId = "c1") => own.run(`shopify.${action}`, input, { externalId, secret }, "owner");

test("a store address is read however it's pasted, and a shop's own domain is refused", () => {
  for (const s of ["acme", "acme.myshopify.com", "https://acme.myshopify.com/admin/orders", "admin.shopify.com/store/acme/orders", " ACME.myshopify.com "])
    expect(storeDomain(s)).toBe("acme.myshopify.com");
  expect(() => storeDomain("www.acme.com")).toThrow(AppsError);
  expect(parseKey("acme shpat_x")).toEqual({ shop: "acme.myshopify.com", token: "shpat_x" });
  expect(parseKey("acme id123 sec456")).toEqual({ shop: "acme.myshopify.com", clientId: "id123", clientSecret: "sec456" });
  expect(() => parseKey("acme id123")).toThrow("Client secret");
});

test("an access token is checked and labelled, and a refused one is a dead login", async () => {
  const calls = stub(() => json({ data: { shop: { name: "Acme Tea", myshopifyDomain: "acme.myshopify.com" } } }));
  expect(await own.connectWithKey!("shopify", ` ${TOKEN} `)).toEqual({ secret: TOKEN, label: "Acme Tea (acme.myshopify.com)" });
  expect(calls[0]!.url).toBe(GQL);
  expect(calls[0]!.headers["X-Shopify-Access-Token"]).toBe("shpat_abc");
  stub(() => json({ errors: "[API] Invalid API key or access token" }, 401));
  const refused = await own.connectWithKey!("shopify", TOKEN).catch((e) => e);
  expect(refused).toBeInstanceOf(AppsError);
  expect(refused.expired).toBe(true);
});

test("a Client ID and secret are swapped for a token once, kept, and swapped again when Shopify drops it", async () => {
  const key = "acme.myshopify.com cid-1 csecret-1";
  let issued = 0;
  const calls = stub((c) => {
    if (c.url.endsWith("/admin/oauth/access_token")) return json({ access_token: `tok${++issued}`, scope: "read_orders", expires_in: 86399 });
    if (c.headers["X-Shopify-Access-Token"] === "tok1" && issued === 1 && calls.filter((x) => x.url === GQL).length > 2) return json({ errors: "expired" }, 401);
    return json({ data: { shop: { name: "Acme" } } });
  });
  await run("get_shop", {}, key);
  await run("get_shop", {}, key);
  const grants = calls.filter((c) => c.url.endsWith("/admin/oauth/access_token"));
  expect(grants).toHaveLength(1);
  expect(Object.fromEntries(new URLSearchParams(grants[0]!.body))).toEqual({ grant_type: "client_credentials", client_id: "cid-1", client_secret: "csecret-1" });
  // Shopify turns the cached one down: a new one is fetched and the call goes through
  await run("get_shop", {}, key);
  expect(issued).toBe(2);
  expect(calls.at(-1)!.headers["X-Shopify-Access-Token"]).toBe("tok2");
});

test("a Client ID from another Shopify account is explained, and is a dead login", async () => {
  stub(() => json({ error: "shop_not_permitted", error_description: "Client credentials cannot be performed on this shop." }, 400));
  const refused = (await own.connectWithKey!("shopify", "acme other-id other-secret").catch((e) => e)) as AppsError;
  expect(refused.message).toContain("same Shopify account");
  expect(refused.expired).toBe(true);
});

test("reads run unasked, writes and raw GraphQL ask", async () => {
  for (const a of ["get_order", "list_orders", "list_customers", "list_abandoned_checkouts", "get_inventory_level", "count_orders", "graphql_query", "get_graphql_type", "calculate_draft_order", "calculate_refund", "run_analytics_query"])
    expect((await own.getAction(`shopify.${a}`))?.readOnly).toBe(true);
  for (const a of ["cancel_order", "create_refund", "create_draft_order", "update_order", "create_fulfillment", "inventory_adjust_quantities", "graphql", "upload_file"])
    expect((await own.getAction(`shopify.${a}`))?.readOnly).toBeFalsy();
  expect(Object.keys(shopify.actions).length).toBeGreaterThan(700);
});

test("a list asks for 10 unless told, sends only the arguments given, and can return chosen fields", async () => {
  const calls = stub(() => json({ data: { orders: { nodes: [{ id: "gid://shopify/Order/1" }], pageInfo: { hasNextPage: false } } } }));
  const out = (await run("list_orders", { query: "financial_status:paid", fields: "nodes { id name }" })) as { nodes: unknown[] };
  expect(out.nodes).toHaveLength(1);
  expect(calls[0]!.body.variables).toEqual({ query: "financial_status:paid", first: 10 });
  expect(calls[0]!.body.query).toBe("query Emplio($first: Int, $query: String) { orders(first: $first, query: $query) { nodes { id name } } }");
  await expect(run("list_orders", { fields: "id } } mutation { x {" })).rejects.toThrow("don't match");
});

test("a mutation's user errors are a failure; fields Shopify withholds come back as warnings", async () => {
  stub(() => json({ data: { orderCancel: { job: null, orderCancelUserErrors: [{ field: ["orderId"], message: "Order is already cancelled" }], userErrors: [] } } }));
  await expect(run("cancel_order", { orderId: "gid://shopify/Order/1", reason: "CUSTOMER", restock: true, refund: false })).rejects.toThrow("orderId: Order is already cancelled");
  stub(() => json({ data: { order: { id: "1", customer: null } }, errors: [{ message: "Access denied for customer field.", path: ["order", "customer"], extensions: { code: "ACCESS_DENIED" } }] }));
  expect(await run("get_order", { id: "gid://shopify/Order/1" })).toEqual({ id: "1", customer: null, _warnings: ["order.customer: Access denied for customer field."] });
  stub(() => json({ data: { order: null }, errors: [{ message: "Access denied for order field.", extensions: { code: "ACCESS_DENIED" } }] }));
  await expect(run("get_order", { id: "gid://shopify/Order/1" })).rejects.toThrow("Access denied");
});

test("graphql_query refuses a mutation; graphql sends anything", async () => {
  expect(mutates('mutation { tagsAdd(id: "x", tags: ["a"]) { node { id } } }')).toBe(true);
  expect(mutates('query { orders(first: 1, query: "note:mutation") { nodes { id } } } # mutation')).toBe(false);
  stub(() => json({ data: { shop: { name: "Acme" } } }));
  await expect(run("graphql_query", { query: "mutation { x }" })).rejects.toThrow("only reads");
  expect(await run("graphql", { query: "{ shop { name } }" })).toEqual({ shop: { name: "Acme" } });
});

test("every generated operation is built the same way", () => {
  expect(operation({ kind: "mutation", field: "tagsAdd", args: [["id", "ID!"], ["tags", "[String!]!"]], select: "userErrors { message }" }, { id: "x", tags: ["vip"] })).toBe(
    "mutation Emplio($id: ID!, $tags: [String!]!) { tagsAdd(id: $id, tags: $tags) { userErrors { message } } }",
  );
});

test("a file is uploaded to Shopify's storage, then added to Files", async () => {
  const calls = stub((c) => {
    if (c.url === "https://storage.test/up") return new Response("", { status: 204 });
    if (c.body.query.includes("stagedUploadsCreate"))
      return json({ data: { stagedUploadsCreate: { stagedTargets: [{ url: "https://storage.test/up", resourceUrl: "https://storage.test/r/1", parameters: [{ name: "key", value: "k1" }] }], userErrors: [] } } });
    return json({ data: { fileCreate: { files: [{ id: "gid://shopify/MediaImage/9", fileStatus: "UPLOADED" }], userErrors: [] } } });
  });
  const out = await run("upload_file", { file: new AppFile("banner.png", "image/png", new Uint8Array([1, 2, 3])), alt: "Sale" });
  expect(out).toEqual({ id: "gid://shopify/MediaImage/9", fileStatus: "UPLOADED" });
  expect(calls[0]!.body.variables.input[0]).toMatchObject({ resource: "IMAGE", filename: "banner.png", fileSize: "3" });
  const form = calls[1]!.body as FormData;
  expect(form.get("key")).toBe("k1");
  expect(form.get("file")).toBeInstanceOf(Blob);
  expect(calls[2]!.body.variables.files[0]).toEqual({ originalSource: "https://storage.test/r/1", contentType: "IMAGE", filename: "banner.png", alt: "Sale" });
});

// --- webhooks ---

const hookToken = () => createHmac("sha256", process.env.ENCRYPTION_KEY!).update("shopify-webhook:c1").digest("hex");
const hookUrl = () => `https://api.test/webhooks/app/shopify/c1/${hookToken()}`;

test("a topic's subscription is made once, found by our address after that, and removed on stop", async () => {
  const subs: { id: string; topic: string; uri: string }[] = [{ id: "s0", topic: "ORDERS_CREATE", uri: "https://someone-else.test/h" }];
  const calls = stub((c) => {
    const q = c.body.query as string;
    if (q.includes("webhookSubscriptions")) return json({ data: { webhookSubscriptions: { nodes: subs.filter((s) => !c.body.variables.uri || s.uri === c.body.variables.uri) } } });
    if (q.includes("webhookSubscriptionCreate")) {
      subs.push({ id: `s${subs.length}`, topic: c.body.variables.topic, uri: c.body.variables.sub.uri });
      return json({ data: { webhookSubscriptionCreate: { webhookSubscription: { id: "x" }, userErrors: [] } } });
    }
    if (q.includes("webhookSubscriptionDelete")) {
      subs.splice(subs.findIndex((s) => s.id === c.body.variables.id), 1);
      return json({ data: { webhookSubscriptionDelete: { deletedWebhookSubscriptionId: "x", userErrors: [] } } });
    }
  });
  const login = { externalId: "c1", secret: TOKEN };
  expect(await own.startPush!("shopify.orders_create", login, {})).toBe("shopify:c1:ORDERS_CREATE");
  expect(await own.startPush!("shopify.orders_create", login, {})).toBe("shopify:c1:ORDERS_CREATE");
  expect(await own.startPush!("shopify.product_created", login, {})).toBe("shopify:c1:PRODUCTS_CREATE");
  expect(subs.filter((s) => s.uri === hookUrl()).map((s) => s.topic)).toEqual(["ORDERS_CREATE", "PRODUCTS_CREATE"]);
  expect(calls.filter((c) => c.body.query.includes("webhookSubscriptionCreate"))).toHaveLength(2);
  expect(calls.find((c) => c.body.query.includes("webhookSubscriptionCreate"))!.body.variables.sub).toEqual({ uri: hookUrl(), format: "JSON" });
  await shopify.push!.stop!(TOKEN, "shopify:c1:ORDERS_CREATE");
  expect(subs.map((s) => s.topic)).toEqual(["ORDERS_CREATE", "PRODUCTS_CREATE"]);
  expect(subs.map((s) => s.uri)).toEqual(["https://someone-else.test/h", hookUrl()]);
});

const delivery = (topic: string, body: object, headers: Record<string, string> = {}, rest = hookToken()) => ({
  body: JSON.stringify(body),
  headers: { "x-shopify-topic": topic, "x-shopify-webhook-id": "w1", ...headers },
  connection: "c1",
  rest,
});

test("an event starts the triggers for its topic, under Shopify's and Composio's names, once per delivery", async () => {
  const got = await receive(delivery("products/create", { id: 7, title: "Tea" }), TOKEN);
  const [e] = await got!.events();
  expect(e!.triggers.sort()).toEqual(["product_created", "products_create"]);
  expect(e).toMatchObject({ id: "c1:w1", watch: "shopify:c1:PRODUCTS_CREATE", data: { topic: "products/create", id: 7, title: "Tea" } });
  const [order] = await (await receive(delivery("orders/paid", { id: 1 }), TOKEN))!.events();
  expect(order!.triggers).toEqual(["orders_paid"]);
  expect(events.refunds_create).toBe("REFUNDS_CREATE");
  expect(await receive(delivery("orders/paid", {}, {}, "forged"), TOKEN)).toBeNull();
});

test("a Dev Dashboard app's events must carry Shopify's signature", async () => {
  const key = "acme cid csecret";
  const body = { id: 1 };
  const sig = createHmac("sha256", "csecret").update(JSON.stringify(body)).digest("base64");
  expect(await receive(delivery("orders/create", body, { "x-shopify-hmac-sha256": sig }), key)).not.toBeNull();
  expect(await receive(delivery("orders/create", body, { "x-shopify-hmac-sha256": "bm9wZQ==" }), key)).toBeNull();
  expect(await receive(delivery("orders/create", body), key)).toBeNull();
});

test("low stock starts only below the level, and only at the chosen location", () => {
  const level = { inventory_item_id: 5, location_id: 9, available: 3 };
  expect(wanted({ below: 5 }, level)).toBe(true);
  expect(wanted({ below: 3 }, level)).toBe(false);
  expect(wanted({ below: 5, location_id: 8 }, level)).toBe(false);
  expect(wanted({ below: 5, location_id: "9" }, level)).toBe(true);
  expect(wanted({}, level)).toBe(true);
  expect(wanted({ below: 5 }, { ...level, available: null })).toBe(false);
});

test("the real route: a forged address is 401, ours is 200", async () => {
  const find = spyOn(db.query.connections, "findFirst");
  const app = Fastify();
  await automationRoutes(app);
  // a topic with no trigger needs no database after the check
  const post = (token: string) =>
    app.inject({ method: "POST", url: `/webhooks/app/shopify/c1/${token}`, headers: { "content-type": "application/json", "x-shopify-topic": "nothing/here" }, payload: "{}" });
  try {
    find.mockResolvedValue({ id: "row", app: "shopify", secret: encrypt(TOKEN), refreshToken: null, expiresAt: null } as never);
    expect((await post("forged")).statusCode).toBe(401);
    expect((await post(hookToken())).statusCode).toBe(200);
  } finally {
    find.mockRestore();
    await app.close();
  }
});
