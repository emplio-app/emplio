// Shopify, on the store owner's own app: every query and mutation in the Admin GraphQL API (actions.json, made by
// generate.ts), a raw GraphQL call for anything else, file uploads, and every webhook topic as a trigger.
// The owner pastes their store's address with either a legacy custom app's access token or a Dev Dashboard app's
// Client ID and secret (client.ts). No public app, no install page. COVERAGE.md says what's where.
import { z } from "zod";
import { AppFile, AppsError } from "../../types";
import type { OwnAction, OwnApp } from "../index";
import { graphql, parseKey, userErrors } from "./client";
import { events, receive, triggers, unwatch, wanted, watch } from "./triggers";

type Generated = { name: string; kind: "query" | "mutation"; field: string; description: string; readOnly: boolean; args: [string, string][]; input: object; select: string; list?: true };

// a `fields` override may not close the operation and start another
function checkFields(fields: string) {
  let depth = 0;
  for (const c of fields.replace(/"(?:[^"\\]|\\.)*"/g, "")) {
    depth += c === "{" ? 1 : c === "}" ? -1 : 0;
    if (depth < 0) break;
  }
  if (depth !== 0) throw new AppsError("fields: the { and } don't match");
}

// the operation an action sends, with only the arguments given
export function operation(a: Pick<Generated, "kind" | "field" | "args" | "select">, input: Record<string, unknown>) {
  const given = a.args.filter(([n]) => input[n] !== undefined);
  const decl = given.map(([n, t]) => `$${n}: ${t}`).join(", ");
  const call = given.map(([n]) => `${n}: $${n}`).join(", ");
  const fields = typeof input.fields === "string" && input.fields.trim() ? input.fields : a.select;
  if (fields !== a.select) checkFields(fields);
  return `${a.kind} Emplio${decl ? `(${decl})` : ""} { ${a.field}${call ? `(${call})` : ""}${fields ? ` { ${fields} }` : ""} }`;
}

async function runGenerated(a: Generated, input: Record<string, unknown>, key: string) {
  const vars = Object.fromEntries(a.args.filter(([n]) => input[n] !== undefined).map(([n]) => [n, input[n]]));
  // Shopify needs a page size on every list
  if (a.list && vars.first === undefined && vars.last === undefined) vars.first = 10;
  const data = await graphql(key, operation(a, { ...input, ...vars }), vars);
  const out = data[a.field];
  const why = a.kind === "mutation" ? userErrors(out) : undefined;
  if (why) throw new AppsError(`Shopify: ${why}`);
  if (data._warnings && out && typeof out === "object" && !Array.isArray(out)) return { ...out, _warnings: data._warnings };
  return out;
}

async function generated(): Promise<Record<string, OwnAction>> {
  const { actions } = (await Bun.file(new URL("./actions.json", import.meta.url)).json()) as { actions: Generated[] };
  return Object.fromEntries(
    actions.map((a) => [
      a.name,
      {
        description: a.description,
        readOnly: a.readOnly,
        // built on first use: 750 zod schemas up front cost memory for nothing
        get input() {
          const input = z.fromJSONSchema(a.input as z.core.JSONSchema.JSONSchema) as z.ZodObject;
          Object.defineProperty(this, "input", { value: input });
          return input;
        },
        run: (i: Record<string, unknown>, key: string) => runGenerated(a, i, key),
      } satisfies OwnAction,
    ]),
  );
}

// a document that changes something; strings and comments don't count
export const mutates = (doc: string) => /\bmutation\b/.test(doc.replace(/"""[\s\S]*?"""|"(?:[^"\\]|\\.)*"|#[^\n]*/g, ""));

const gqlInput = z.object({
  query: z.string().min(1).describe("A GraphQL document for Shopify's Admin API (version 2026-10), e.g. query { shop { name } }. get_graphql_type shows what a type has"),
  variables: z.record(z.string(), z.any()).optional().describe('Values for the $variables it declares, e.g. {"id": "gid://shopify/Order/123"}'),
});

const hand: Record<string, OwnAction> = {
  graphql: {
    description: "Run any GraphQL query or mutation on the store's Admin API, for what the other Shopify actions don't cover. Asks first, because it can change things; use graphql_query to only read.",
    input: gqlInput,
    run: (i: { query: string; variables?: Record<string, unknown> }, key) => graphql(key, i.query, i.variables),
  },
  graphql_query: {
    description: "Run a read-only GraphQL query on the store's Admin API (no mutations), for reports and lookups the other Shopify actions don't cover. Runs without asking.",
    readOnly: true,
    input: gqlInput,
    run: (i: { query: string; variables?: Record<string, unknown> }, key) => {
      if (mutates(i.query)) throw new AppsError("graphql_query only reads; use shopify.graphql for a mutation");
      return graphql(key, i.query, i.variables);
    },
  },
  get_graphql_type: {
    description: "What a type in Shopify's Admin API has: its fields and their types, an input's fields, or an enum's values. Use it to write a fields list, an input object, or a graphql query.",
    readOnly: true,
    input: z.object({ name: z.string().min(1).describe("The type's name, e.g. Order, ProductInput, OrderSortKeys") }),
    run: async (i: { name: string }, key) => {
      const ref = "name kind ofType { name kind ofType { name kind ofType { name kind } } }";
      const data = await graphql(
        key,
        `query($name: String!) { __type(name: $name) { name kind description fields { name description type { ${ref} } args { name type { ${ref} } } } inputFields { name description type { ${ref} } } enumValues { name description } possibleTypes { name } } }`,
        { name: i.name },
      );
      if (!data.__type) throw new AppsError(`Shopify has no type called ${i.name}`);
      return data.__type;
    },
  },
  upload_file: {
    description: "Put a file from this computer into the store's Files (Content → Files): a picture, video, PDF or anything else. Answers the file's id and, once Shopify has processed it, its link. Use the id or link on products, pages and metafields.",
    input: z.object({
      file: z.any().describe('The file from this computer: {"file": "/work/banner.jpg"}'),
      alt: z.string().optional().describe("A description of a picture, for people who can't see it"),
    }),
    async run(i: { file: unknown; alt?: string }, key) {
      if (!(i.file instanceof AppFile)) throw new AppsError('file: give the file as {"file": "/work/banner.jpg"}');
      const f = i.file;
      const kind = f.mimetype.startsWith("image/") ? "IMAGE" : f.mimetype.startsWith("video/") ? "VIDEO" : "FILE";
      const staged = await graphql(
        key,
        "mutation($input: [StagedUploadInput!]!) { stagedUploadsCreate(input: $input) { stagedTargets { url resourceUrl parameters { name value } } userErrors { field message } } }",
        { input: [{ resource: kind, filename: f.name, mimeType: f.mimetype, fileSize: String(f.bytes.length), httpMethod: "POST" }] },
      );
      const why = userErrors(staged.stagedUploadsCreate);
      if (why) throw new AppsError(`Shopify: ${why}`);
      const target = staged.stagedUploadsCreate.stagedTargets[0] as { url: string; resourceUrl: string; parameters: { name: string; value: string }[] };
      const form = new FormData();
      for (const p of target.parameters) form.append(p.name, p.value);
      form.append("file", new Blob([f.bytes as Uint8Array<ArrayBuffer>], { type: f.mimetype }), f.name);
      const sent = await fetch(target.url, { method: "POST", body: form });
      if (!sent.ok) throw new AppsError(`Shopify's file storage turned the upload down (${sent.status})`);
      const made = await graphql(
        key,
        "mutation($files: [FileCreateInput!]!) { fileCreate(files: $files) { files { id alt fileStatus createdAt ... on MediaImage { image { url } } ... on GenericFile { url } ... on Video { sources { url } } } userErrors { field message } } }",
        { files: [{ originalSource: target.resourceUrl, contentType: kind, filename: f.name, ...(i.alt && { alt: i.alt }) }] },
      );
      const bad = userErrors(made.fileCreate);
      if (bad) throw new AppsError(`Shopify: ${bad}`);
      return made.fileCreate.files[0];
    },
  },
};

const MONEY = "shopMoney { amount currencyCode }";
export const SUGGESTED_REFUND = `query($id: ID!, $refundLineItems: [RefundLineItemInput!], $refundShipping: Boolean, $shippingAmount: Money, $suggestFullRefund: Boolean) {
  order(id: $id) { id name suggestedRefund(refundLineItems: $refundLineItems, refundShipping: $refundShipping, shippingAmount: $shippingAmount, suggestFullRefund: $suggestFullRefund) {
    amountSet { ${MONEY} } subtotalSet { ${MONEY} } totalTaxSet { ${MONEY} } maximumRefundableSet { ${MONEY} }
    shipping { amountSet { ${MONEY} } maximumRefundableSet { ${MONEY} } }
    refundLineItems { quantity restockType lineItem { id name sku } subtotalSet { ${MONEY} } totalTaxSet { ${MONEY} } }
    suggestedTransactions { kind gateway amountSet { ${MONEY} } maximumRefundableSet { ${MONEY} } parentTransaction { id } } } } }`;

hand.calculate_refund = {
  description:
    "Work out a refund before making it: how much goes back for these items (and shipping), with tax, and the payment it goes back to. Pass its suggestedTransactions (amount, gateway, kind REFUND, parentId) and refundLineItems to create_refund. Changes nothing.",
  readOnly: true,
  input: z.object({
    orderId: z.string().describe("The order's Shopify id, like gid://shopify/Order/123"),
    refundLineItems: z.array(z.object({ lineItemId: z.string(), quantity: z.number().int(), restockType: z.enum(["NO_RESTOCK", "CANCEL", "RETURN"]).optional(), locationId: z.string().optional() }).loose()).optional().describe("Which items and how many: lineItemId from get_order's lineItems"),
    refundShipping: z.boolean().optional().describe("Refund all the shipping too"),
    shippingAmount: z.string().optional().describe("Or refund this much of the shipping, e.g. \"50.00\""),
    suggestFullRefund: z.boolean().optional().describe("Work out a refund of everything that's left"),
  }),
  run: async (i: { orderId: string; [k: string]: unknown }, key) => {
    const { orderId, ...rest } = i;
    const data = await graphql(key, SUGGESTED_REFUND, { id: orderId, ...rest });
    if (!data.order) throw new AppsError(`Shopify has no order ${orderId}`);
    return data.order;
  },
};

const actions = { ...(await generated()), ...hand };

// Composio's names for the same things, so saved skills and automations keep working
const ALIASES: Record<string, string> = {
  get_shop_details: "get_shop",
  get_shop_info: "get_shop",
  query_shop: "get_shop",
  get_products: "list_products",
  retrieves_a_list_of_products: "list_products",
  search_products: "list_products",
  get_order_list: "list_orders",
  get_orders_with_filters: "list_orders",
  list_order: "list_orders",
  get_ordersby_id: "get_order",
  retrieves_a_single_product: "get_product",
  retrieves_an_order_count: "count_orders",
  get_customers_search: "list_customers",
  retrieves_a_single_location_by_its_id: "get_location",
  adjust_inventory_level: "inventory_adjust_quantities",
  set_inventory_level: "inventory_set_quantities",
  create_webhook: "create_webhook_subscription",
  delete_webhook: "delete_webhook_subscription",
  retrieves_a_list_of_webhooks: "list_webhook_subscriptions",
  run_bulk_operation_query: "bulk_operation_run_query",
  run_bulk_mutation_operation: "bulk_operation_run_mutation",
  graph_ql_query: "graphql_query",
  graph_ql_read_query: "graphql_query",
  graph_ql_mutation: "graphql",
  graph_ql_admin_execute: "graphql",
  graph_ql_schema: "get_graphql_type",
  retrieves_a_list_of_abandoned_checkouts: "list_abandoned_checkouts",
  run_analytics_query: "get_shopifyql_query",
  get_access_scopes: "get_current_app_installation",
  get_current_user: "get_current_staff_member",
  list_users: "list_staff_members",
  get_user: "get_staff_member",
  get_payments_balance: "get_shopify_payments_account",
  list_payment_disputes: "list_disputes",
  get_payment_dispute: "get_dispute",
  reopen_closed_order: "open_order",
  update_fulfillment_tracking: "update_fulfillment_tracking_info",
  submit_fulfillment_request: "fulfillment_order_submit_fulfillment_request",
  send_customer_invite: "customer_send_account_invite_email",
  set_default_customer_address: "customer_update_default_address",
  trigger_shopify_flow: "receive_flow_trigger",
  get_tender_transactions: "list_tender_transactions",
};
for (const [alias, name] of Object.entries(ALIASES)) if (actions[name]) actions[alias] = actions[name];

const SCOPES =
  "read_orders,write_orders,read_draft_orders,write_draft_orders,read_order_edits,write_order_edits,read_products,write_products,read_inventory,write_inventory,read_customers,write_customers,read_merchant_managed_fulfillment_orders,write_merchant_managed_fulfillment_orders,read_fulfillments,write_fulfillments,read_returns,write_returns,read_discounts,write_discounts,read_price_rules,write_price_rules,read_gift_cards,write_gift_cards,read_files,write_files,read_content,write_content,read_online_store_pages,write_online_store_pages,read_online_store_navigation,write_online_store_navigation,read_metaobjects,write_metaobjects,read_metaobject_definitions,write_metaobject_definitions,read_locations,write_locations,read_shipping,write_shipping,read_publications,write_publications,read_markets,write_markets,read_marketing_events,write_marketing_events,read_themes,write_themes,read_translations,write_translations,read_locales,write_locales,read_reports";

export const shopify: OwnApp = {
  app: "shopify",
  name: "Shopify",
  logo: "/logos/shopify.svg",
  keyField: {
    label: "Store address and app key",
    help:
      "Emplio connects through a private app you make for your own store. In your Shopify admin go to Settings → Apps → Develop apps. " +
      "If you already have a custom app there from before 2026, open it, make sure its Admin API permissions include what Emplio should do, and copy its Admin API access token (starts with shpat_). " +
      "Otherwise click Build apps in Dev Dashboard → Create app, name it Emplio and click Create. In the new version, leave the app URL as it is, pick the newest Webhooks API version, " +
      `and under Access paste these scopes: ${SCOPES} (add read_all_orders for orders older than 60 days). Click Release, then go to the app's Installs and install it on your store. ` +
      "Then open the app's Settings and copy its Client ID and Secret. " +
      "Paste on one line, separated by spaces: your store's .myshopify.com address, then either the access token, or the Client ID and the Secret.",
    placeholder: "mystore.myshopify.com shpat_xxxx   or   mystore.myshopify.com client-id client-secret",
  },
  async check(key) {
    const { shop } = parseKey(key);
    const data = await graphql(key, "{ shop { name myshopifyDomain } }");
    return data.shop?.name ? `${data.shop.name} (${data.shop.myshopifyDomain ?? shop})` : shop;
  },
  actions,
  push: {
    events,
    triggers,
    start: (key, connection, event) => watch(key, connection, event),
    stop: (key, id) => unwatch(key, id),
    receive: (delivery, key) => receive(delivery, key),
    wanted,
  },
};
