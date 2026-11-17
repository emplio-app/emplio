// GoDaddy: what the generator (../openapi-actions.ts) can't tell from the specs.
//
// GoDaddy publishes OpenAPI 3 specs for Domains v1/v2/v3, Hosting, Shoppers and Commerce (developer.godaddy.com/openapi/*).
// Certificates, Abuse, Aftermarket, Agreements, Countries, Orders and Subscriptions still answer but their specs
// (the old Swagger 2 files) were taken down in the 2026 portal rewrite: we read the last archived copy and lift it to
// OpenAPI 3. ANS, Auctions, Email, Shopping, Parking, Domain value and the newer Certificates v2 calls have no published
// spec at all, only reference pages: we build one from each page's markdown (params exact, body fields top level).
// Every spec is tidied here (names, groups, one server each) and written to a temp folder the generator then reads.
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import type { AppConfig } from "../openapi-actions";

type Schema = Record<string, any>;
const API = "https://api.godaddy.com";
const DOCS = "https://developer.godaddy.com";
const METHODS = ["get", "post", "put", "patch", "delete"];
const snake = (s: string) =>
  s
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .replace(/^_|_$/g, "")
    .toLowerCase();

// archived copies (and gzip, as the archive hands them back)
async function fetchJson(url: string): Promise<Schema> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  const text = bytes[0] === 0x1f && bytes[1] === 0x8b ? new TextDecoder().decode(Bun.gunzipSync(bytes)) : new TextDecoder().decode(bytes);
  return JSON.parse(text);
}
const archived = (name: string, at: string) => `https://web.archive.org/web/${at}id_/https://developer.godaddy.com/swagger/swagger_${name}.json`;

// Swagger 2 → OpenAPI 3, as far as these files need: body/formData params become a requestBody, the rest get a schema
function lift(s: Schema): Schema {
  s = JSON.parse(JSON.stringify(s).replaceAll('"#/definitions/', '"#/components/schemas/'));
  const param = (p: Schema): Schema => {
    if (p.$ref) p = s.parameters[p.$ref.split("/").pop()];
    const { name, in: where, required, description, schema, ...rest } = p;
    // header defaults here are prose ("Default locale for shopper account"), which would be sent as the value
    const fallback = where === "header" ? undefined : rest.default;
    return { name, in: where, required, description, schema: schema ?? { type: rest.type, items: rest.items, enum: rest.enum, default: fallback, minimum: rest.minimum, maximum: rest.maximum } };
  };
  for (const ops of Object.values<Schema>(s.paths)) {
    for (const [m, op] of Object.entries<Schema>(ops)) {
      if (!METHODS.includes(m)) continue;
      const params = (op.parameters ?? []).map(param);
      const body = params.find((p: Schema) => p.in === "body");
      const form = params.filter((p: Schema) => p.in === "formData");
      if (body) op.requestBody = { required: body.required, description: body.description, content: { "application/json": { schema: body.schema } } };
      if (form.length)
        op.requestBody = {
          content: {
            "application/x-www-form-urlencoded": {
              schema: { type: "object", properties: Object.fromEntries(form.map((p: Schema) => [p.name, { ...p.schema, description: p.description }])), required: form.filter((p: Schema) => p.required).map((p: Schema) => p.name) },
            },
          },
        };
      op.parameters = params.filter((p: Schema) => p.in !== "body" && p.in !== "formData");
    }
  }
  return { openapi: "3.0.0", paths: s.paths, components: { schemas: s.definitions ?? {} } };
}

// A reference page's markdown → OpenAPI 3: one operation per "## METHOD /path" section
const TYPES = new Set(["string", "integer", "number", "boolean", "array", "object"]);
const typeOf = (t: string) => {
  const w = t.trim().split(/[\s<[]/)[0]!.toLowerCase();
  return TYPES.has(w) ? { type: w, ...(w === "array" && { items: {} }) } : {};
};
function fromMarkdown(md: string, page: string, spec: Schema) {
  const parts = md.split(/^## (GET|POST|PUT|PATCH|DELETE) (\S+)\s*$/m);
  for (let i = 1; i < parts.length; i += 3) {
    const method = parts[i]!.toLowerCase();
    const path = parts[i + 1]!;
    const text = parts[i + 2]!;
    const [head = "", ...sections] = text.split(/^### /m);
    const lines = head.trim().split("\n").filter((l) => l.trim());
    const op: Schema = { operationId: "", summary: lines[0] ?? "", description: lines.slice(1).join(" ").trim(), parameters: [], "x-page": page };
    for (const sec of sections) {
      const title = sec.split("\n")[0]!;
      const where = title.match(/^(Path|Query|Header) parameters/)?.[1]?.toLowerCase();
      if (where) {
        for (const row of sec.matchAll(/^\| `([^`]+)` \| ([^|]*) \| (yes|no) \| (.*) \|$/gm))
          op.parameters.push({ name: row[1], in: where, required: row[3] === "yes", description: row[4]!.trim(), schema: typeOf(row[2]!) });
      }
      if (title.startsWith("Request body")) {
        const desc = sec.split("Content-Type")[0]!.split("\n").slice(1).join(" ").trim();
        const example = sec.match(/```json\n([\s\S]*?)```/)?.[1]?.trim();
        const tree = sec.split("Schema:")[1] ?? "";
        const props: Schema = {};
        const required: string[] = [];
        if (/^\s*- object\s*$/m.test(tree)) {
          // top-level fields sit two spaces in; anything deeper is folded into the field's description
          let last: string | undefined;
          for (const line of tree.split("\n")) {
            const f = line.match(/^ {2}- `([^`]+)`( \(required\))?: ([^—]*?)(?: — (.*))?$/);
            if (f) {
              last = f[1]!;
              props[last] = { ...typeOf(f[3]!), description: (f[4] ?? "").trim() || undefined };
              if (f[2]) required.push(last);
            } else if (last && /^ {4,}- /.test(line)) {
              const extra = line.trim().replace(/^- /, "").replace(/`/g, "");
              if (extra && extra !== "items:") props[last].description = `${props[last].description ?? ""} [${extra}]`.trim();
            }
          }
        }
        const more = `${desc}${example ? ` Example: ${example.replace(/\s+/g, " ")}` : ""} Full shape: ${DOCS}/docs/references/rest/${page}`.trim();
        op.requestBody = {
          required: /\(required\)/.test(title),
          content: {
            "application/json": {
              schema: Object.keys(props).length
                ? { type: "object", description: more, properties: props, required }
                : /^\s*- array\s*$/m.test(tree)
                  ? { type: "array", items: {}, description: more }
                  : { type: "object", description: more },
            },
          },
        };
        // fields alone lose the example and the link; keep them on the operation
        if (Object.keys(props).length) op.description = `${op.description} ${example ? `Example body: ${example.replace(/\s+/g, " ")}` : ""}`.trim();
      }
    }
    // the generator takes the action's name from here
    (spec.paths[path] ??= {})[method] = op;
  }
}

async function fromPages(pages: string[], keep?: (method: string, path: string) => boolean): Promise<Schema> {
  const spec: Schema = { openapi: "3.0.0", paths: {}, components: { schemas: {} } };
  for (const page of pages) {
    const md = await (await fetch(`${DOCS}/docs/references/rest/${page}.md`)).text();
    fromMarkdown(md, page, spec);
  }
  if (keep)
    for (const [path, ops] of Object.entries<Schema>(spec.paths)) {
      for (const m of Object.keys(ops)) if (!keep(m.toUpperCase(), path)) delete ops[m];
      if (!Object.keys(ops).length) delete spec.paths[path];
    }
  return spec;
}

// Names by "METHOD path" for the operations whose ids are missing (Domains v2) or too bare (Domains v1's "list", "get")
const NAMES: Record<string, string> = {
  "GET /v1/domains": "v1_list_domains",
  "GET /v1/domains/agreements": "v1_get_domain_agreements",
  "GET /v1/domains/available": "v1_check_availability",
  "POST /v1/domains/available": "v1_check_availability_bulk",
  "POST /v1/domains/contacts/validate": "v1_validate_contacts",
  "POST /v1/domains/purchase": "v1_purchase_domain",
  "GET /v1/domains/purchase/schema/{tld}": "v1_get_purchase_schema",
  "POST /v1/domains/purchase/validate": "v1_validate_purchase",
  "GET /v1/domains/suggest": "v1_suggest_domains",
  "GET /v1/domains/tlds": "v1_list_tlds",
  "DELETE /v1/domains/{domain}": "v1_cancel_domain",
  "GET /v1/domains/{domain}": "v1_get_domain",
  "PATCH /v1/domains/{domain}": "v1_update_domain",
  "PATCH /v1/domains/{domain}/contacts": "v1_update_contacts",
  "PATCH /v1/domains/{domain}/records": "v1_add_dns_records",
  "PUT /v1/domains/{domain}/records": "v1_replace_all_dns_records",
  "GET /v1/domains/{domain}/records/{type}/{name}": "v1_get_dns_records",
  "PUT /v1/domains/{domain}/records/{type}/{name}": "v1_replace_dns_records_by_type_and_name",
  "DELETE /v1/domains/{domain}/records/{type}/{name}": "v1_delete_dns_records_by_type_and_name",
  "PUT /v1/domains/{domain}/records/{type}": "v1_replace_dns_records_by_type",
  "POST /v1/domains/{domain}/renew": "v1_renew_domain",
  "POST /v1/domains/{domain}/transfer": "v1_transfer_in_domain",
  "POST /v1/domains/{domain}/verifyRegistrantEmail": "v1_resend_registrant_verification_email",
  "DELETE /v2/customers/{customerId}/domains/{domain}/changeOfRegistrant": "v2_cancel_change_of_registrant",
  "GET /v2/customers/{customerId}/domains/{domain}/changeOfRegistrant": "v2_get_change_of_registrant",
  "PUT /v2/customers/{customerId}/domains/{domain}/nameServers": "v2_update_nameservers",
  "POST /v2/customers/{customerId}/domains/{domain}/transfer": "v2_transfer_in_domain",
  "POST /v2/customers/{customerId}/domains/{domain}/transferInAccept": "v2_accept_transfer_in",
  "POST /v2/customers/{customerId}/domains/{domain}/transferInCancel": "v2_cancel_transfer_in",
  "POST /v2/customers/{customerId}/domains/{domain}/transferInRestart": "v2_restart_transfer_in",
  "POST /v2/customers/{customerId}/domains/{domain}/transferInRetry": "v2_retry_transfer_in",
  "GET /v2/customers/{customerId}/domains/{domain}": "v2_get_domain",
  "GET /v2/customers/{customerId}/domains/{domain}/privacy/forwarding": "v2_get_privacy_forwarding",
  "PATCH /v2/customers/{customerId}/domains/{domain}/privacy/forwarding": "v2_update_privacy_forwarding",
  "POST /v2/customers/{customerId}/domains/{domain}/transferOut": "v2_transfer_out_domain",
  "POST /v2/customers/{customerId}/domains/{domain}/transferOutAccept": "v2_accept_transfer_out",
  "POST /v2/customers/{customerId}/domains/{domain}/transferOutReject": "v2_reject_transfer_out",
  "GET /v2/customers/{customerId}/domains/{domain}/actions": "v2_list_domain_actions",
  "DELETE /v2/customers/{customerId}/domains/{domain}/actions/{type}": "v2_cancel_domain_action",
  "GET /v2/customers/{customerId}/domains/{domain}/actions/{type}": "v2_get_domain_action",
  "DELETE /v2/customers/{customerId}/domains/forwards/{fqdn}": "v2_delete_forwarding",
  "GET /v2/customers/{customerId}/domains/forwards/{fqdn}": "v2_get_forwarding",
  "PUT /v2/customers/{customerId}/domains/forwards/{fqdn}": "v2_update_forwarding",
  "POST /v2/customers/{customerId}/domains/forwards/{fqdn}": "v2_create_forwarding",
  "GET /v2/customers/{customerId}/domains/notifications": "v2_get_next_notification",
  "GET /v2/customers/{customerId}/domains/notifications/optIn": "v2_list_notification_opt_ins",
  "PUT /v2/customers/{customerId}/domains/notifications/optIn": "v2_opt_in_notifications",
  "GET /v2/customers/{customerId}/domains/notifications/schemas/{type}": "v2_get_notification_schema",
  "POST /v2/customers/{customerId}/domains/notifications/{notificationId}/acknowledge": "v2_acknowledge_notification",
  "POST /v2/customers/{customerId}/domains/register": "v2_register_domain",
  "GET /v2/customers/{customerId}/domains/register/schema/{tld}": "v2_get_register_schema",
  "POST /v2/customers/{customerId}/domains/register/validate": "v2_validate_register",
  "GET /v2/domains/usage/{yyyymm}": "v2_get_api_usage",
  // ids that would read badly with their prefix
  "GET /v1/agreements": "get_legal_agreements",
  "GET /v1/orders": "list_orders",
  "GET /v1/orders/{orderId}": "get_order",
  "GET /v1/subscriptions": "list_subscriptions",
  "GET /v1/subscriptions/productGroups": "list_subscription_product_groups",
  "DELETE /v1/subscriptions/{subscriptionId}": "cancel_subscription",
  "GET /v1/subscriptions/{subscriptionId}": "get_subscription",
  "PATCH /v1/subscriptions/{subscriptionId}": "update_subscription",
  "GET /v1/countries": "get_countries",
  "GET /v1/countries/{countryKey}": "get_country",
  "GET /v1/domains/govalues": "get_domain_value",
  "GET /v2/customers/{customerId}/certificates/{certificateId}": "certificate_get_v2",
  "GET /v2/customers/{customerId}/certificates/{certificateId}/domainVerifications": "certificate_list_domain_verifications",
  "GET /v2/customers/{customerId}/certificates/{certificateId}/domainVerifications/{domain}": "certificate_get_domain_verification",
  "GET /v2/customers/{customerId}/certificates/acme/externalAccountBinding": "certificate_get_acme_external_account_binding",
  "GET /v2/customers/{customerId}/certificates/credits/search": "certificate_search_credits",
  "GET /v2/customers/{customerId}/certificates/credits/available": "certificate_list_unused_credits",
  "GET /v2/customers/{customerId}/certificates/subscriptions/stats": "certificate_get_subscriptions_stats",
  "GET /v2/customers/{customerId}/certificates/subscription/{guid}/search": "certificate_search_subscription_certificates",
  "GET /v2/customers/{customerId}/certificates/subscription/{guid}/stats": "certificate_get_subscription_stats",
  "GET /v2/customers/{customerId}/certificates/subscriptions": "certificate_list_subscriptions",
  "POST /v2/customers/{customerId}/certificates/visibility": "certificate_set_visibility_bulk",
  "GET /v2/customers/{customerId}/certificate/{certificateId}/visibility": "certificate_get_visibility",
  "POST /v2/customers/{customerId}/certificate/{certificateId}/visibility": "certificate_set_visibility",
  "GET /v2/customers/{customerId}/certificate/{certificateId}/checklist": "certificate_get_checklist",
  "POST /v1/commerce/order-subgraph": "commerce_orders_graphql",
  "POST /stores/{storeId}/catalog-subgraph": "commerce_catalog_graphql",
  "POST /stores/{storeId}/tax-subgraph": "commerce_taxes_graphql",
};

// Certificates v2 calls in the current reference but not in the archived spec
const CERT_V2_NEW = /\/(credits|visibility|checklist|stats)|\/certificates\/subscriptions$|\/subscription\/\{guid\}\/search/;

type Source = { group: string; base: string; prefix: string; load: () => Promise<Schema>; keep?: (method: string, path: string) => boolean };
const SOURCES: Source[] = [
  // the first one's base is the app's (own/godaddy/index.ts); the others' go with each action
  { group: "Domains v1", base: API, prefix: "", load: () => fetchJson(`${DOCS}/openapi/domains-v1.json`) },
  { group: "Domains v2", base: API, prefix: "", load: () => fetchJson(`${DOCS}/openapi/domains-v2.json`) },
  { group: "Domains", base: `${API}/v3/domains`, prefix: "", load: () => fetchJson(`${DOCS}/openapi/domains-v3.json`) },
  { group: "Hosting", base: `${API}/v1/hosting`, prefix: "hosting_", load: () => fetchJson(`${DOCS}/openapi/hosting.json`) },
  { group: "Shoppers", base: API, prefix: "shopper_", load: () => fetchJson(`${DOCS}/openapi/shoppers.json`) },
  { group: "Commerce", base: `${API}/v1/commerce`, prefix: "commerce_", load: () => fetchJson(`${DOCS}/openapi/stores.json`) },
  { group: "Commerce", base: `${API}/v1/commerce`, prefix: "commerce_", load: () => fetchJson(`${DOCS}/openapi/channels.json`) },
  { group: "Commerce", base: `${API}/v1/commerce`, prefix: "commerce_", load: () => fetchJson(`${DOCS}/openapi/customers.json`) },
  { group: "Commerce", base: `${API}/v1/commerce`, prefix: "commerce_", load: () => fetchJson(`${DOCS}/openapi/transactions.json`) },
  { group: "Commerce", base: `${API}/v2/commerce`, prefix: "commerce_", load: () => fetchJson(`${DOCS}/openapi/catalog-graphql.json`) },
  { group: "Commerce", base: API, prefix: "commerce_", load: () => fetchJson(`${DOCS}/openapi/orders.json`) },
  { group: "Commerce", base: `${API}/v2/commerce`, prefix: "commerce_", load: () => fetchJson(`${DOCS}/openapi/commerce-taxes.json`) },
  // the last archived Swagger 2 files (June 2026); five old Certificates v2 calls the current reference dropped stay out
  {
    group: "Certificates",
    base: API,
    prefix: "",
    load: async () => lift(await fetchJson(archived("certificates", "20260608002153"))),
    keep: (_m, p) => !/^\/v2\/certificates(\/download|\/subscription|$)|^\/v2\/customers\/\{customerId\}\/certificates$/.test(p),
  },
  { group: "Certificates", base: API, prefix: "", load: () => fromPages(["certificates/v2"]), keep: (_m, p) => CERT_V2_NEW.test(p) },
  { group: "Abuse", base: API, prefix: "abuse_", load: async () => lift(await fetchJson(archived("abuse", "20260608002404"))) },
  { group: "Aftermarket", base: API, prefix: "aftermarket_", load: async () => lift(await fetchJson(archived("aftermarket", "20260608003539"))) },
  { group: "Agreements", base: API, prefix: "", load: async () => lift(await fetchJson(archived("agreements", "20260608003846"))) },
  { group: "Countries", base: API, prefix: "", load: async () => lift(await fetchJson(archived("countries", "20260608001612"))) },
  { group: "Orders", base: API, prefix: "", load: async () => lift(await fetchJson(archived("orders", "20260608002144"))) },
  { group: "Subscriptions", base: API, prefix: "", load: async () => lift(await fetchJson(archived("subscriptions", "20260608002412"))) },
  // reference pages only
  {
    group: "Auctions",
    base: API,
    prefix: "auctions_",
    load: () => fromPages(["check-listing-availability", "create-purchase", "get-payment-profiles", "place-bids", "preview-purchase"].map((p) => `auctions/${p}`)),
  },
  { group: "Parking", base: API, prefix: "parking_", load: () => fromPages(["parking/get-metrics", "parking/get-metrics-by-domain"]) },
  { group: "Domain value", base: API, prefix: "", load: () => fromPages(["domain-valuation/get-go-value"]) },
  {
    group: "Email",
    base: `${API}/v1/email`,
    prefix: "email_",
    load: () => fromPages(["check-mailbox-eligibility", "create-mailbox", "get-mailbox", "list-mailboxes"].map((p) => `email/${p}`)),
  },
  {
    group: "Shopping",
    base: `${API}/v1/shopping`,
    prefix: "shopping_",
    load: () =>
      fromPages(["search-catalog", "lookup-catalog", "get-product", "create-checkout", "get-checkout", "update-checkout", "complete-checkout", "get-order"].map((p) => `shopping/${p}`)),
  },
  {
    group: "Agent Name Service",
    base: API,
    prefix: "ans_",
    load: () =>
      fromPages(
        [
          "register-agent", "get-agent", "search-ans-name", "resolve-ans-name", "revoke-agent", "get-agent-events",
          "validate-registration", "verify-dns-records", "get-agent-csr-status-by-agent-id", "submit-agent-identity-csr-by-agent-id",
          "get-agent-identity-certificate-by-agent-id", "get-agent-server-certificate-by-agent-id", "submit-server-certificate-renewal",
          "get-server-certificate-renewal-status", "cancel-server-certificate-renewal", "verify-acme-challenges",
          "list-registered-agents", "get-registered-agent", "search-registered-agents",
        ].map((p) => `ans/${p}`),
      ),
  },
];

// tidy every spec: final names as operation ids, one group per source, one server, generated headers not required
const DIR = `${tmpdir()}/emplio-godaddy-specs`;
mkdirSync(DIR, { recursive: true });
const used = new Set<string>();
const files: string[] = [];
for (const [i, src] of SOURCES.entries()) {
  const spec = await src.load();
  spec.servers = [{ url: src.base }];
  // own/openapi.ts fills {word} path params only: {domain-name} → {domain_name}
  const word = (n: string) => n.replace(/\W/g, "_");
  spec.paths = Object.fromEntries(Object.entries<Schema>(spec.paths).map(([p, ops]) => [p.replace(/\{([^}]+)\}/g, (_, n) => `{${word(n)}}`), ops]));
  const deref = (ref: Schema) => (ref.$ref ? ref.$ref.replace(/^#\//, "").split("/").reduce((o: Schema, k: string) => o?.[k], spec) : ref);
  for (const ops of Object.values<Schema>(spec.paths))
    for (const op of [ops, ...Object.values<Schema>(ops)])
      for (const p of (op?.parameters ?? []).map(deref)) if (p?.in === "path") p.name = word(p.name);
  for (const [path, ops] of Object.entries<Schema>(spec.paths)) {
    for (const [m, op] of Object.entries<Schema>(ops)) {
      if (!METHODS.includes(m)) continue;
      const call = `${m.toUpperCase()} ${path}`;
      if (src.keep && !src.keep(m.toUpperCase(), path)) {
        delete ops[m];
        continue;
      }
      const page = op["x-page"] as string | undefined;
      let name = NAMES[call] ?? `${src.prefix}${snake(page && !/\/v[12]$/.test(page) ? page.split("/").pop()! : (op.operationId || op.summary))}`;
      name = name.replace(/^(\w+?)_\1_/, "$1_").replace(/^commerce_commerce_/, "commerce_");
      if (used.has(name)) name = `${name}_${path.match(/^\/(v\d)\//)?.[1] ?? m}`;
      used.add(name);
      // Hosting's JSON Patch bodies: sent as they are, own/godaddy sets their content type
      const patch = op.requestBody?.content?.["application/json-patch+json"];
      if (patch) op.requestBody.content = { "application/json": patch };
      op.operationId = name;
      op.tags = [src.group];
      // ids the server only uses to trace or de-duplicate: own/godaddy fills them in
      for (const ref of op.parameters ?? []) {
        const p = deref(ref);
        if (/^(Idempotency-Key|Request-Id|X-Request-Id)$/i.test(p?.name ?? "")) p.required = false;
      }
    }
  }
  const file = `${DIR}/${i}.json`;
  await Bun.write(file, JSON.stringify(spec));
  files.push(file);
}

export default {
  spec: files,
  out: "src/integrations/own/godaddy/actions.json",
  // ids are already the final names
  name: (id) => id,
  reads: [
    "v1_check_availability_bulk",
    "v1_validate_contacts",
    "v1_validate_purchase",
    "v2_validate_register",
    "check_availability",
    "quote_domain_registration",
    "certificate_validate",
    "auctions_check_listing_availability",
    "auctions_preview_purchase",
    "shopping_search_catalog",
    "shopping_lookup_catalog",
    "shopping_get_product",
    "ans_resolve_ans_name",
    "ans_search_registered_agents",
  ],
  // the ACME account key that lets anyone issue certificates on the account
  secrets: ["certificate_get_acme_external_account_binding"],
  // a fixed app key Orders and Subscriptions want for tracking: own/godaddy sends it
  drop: { "*": ["X-App-Key"] },
  params: {
    customerId:
      "The account's customer id (a UUID, not the account number). shopper_get with shopperId \"MY\" and includes [\"customerId\"] gives it; \"MY\" also works on Auctions and Parking.",
    "X-Shopper-Id": "Only for resellers acting on a customer's account: that customer's shopper id. Leave out for your own account.",
    storeId: "The GoDaddy store's id (a UUID), from the store's Commerce settings.",
  },
} satisfies AppConfig;
