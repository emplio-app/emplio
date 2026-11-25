// Chargebee: what the generator (../openapi-actions.ts) can't tell from the specs. Two specs make the app: Product
// Catalog 2.0 (items and item prices, what every site made since 2021 runs on) first, then Product Catalog 1.0 for the
// calls only older sites (plans and addons) have. Every call goes to the person's own <site>.chargebee.com/api/v2;
// own/chargebee/api.ts sends it there.
import type { AppConfig } from "../openapi-actions";

const PC2 = "https://raw.githubusercontent.com/chargebee/openapi/main/spec/chargebee_api_v2_pc_v2_spec.json";
const PC1 = "https://raw.githubusercontent.com/chargebee/openapi/main/spec/chargebee_api_v2_pc_v1_spec.json";
const OUT = new URL("../../src/integrations/own/chargebee/actions.json", import.meta.url).pathname;
const METHODS = ["get", "post", "put", "patch", "delete"];
const pc2Spec = await (await fetch(PC2)).json();
const pc2 = new Set(Object.entries<Record<string, unknown>>(pc2Spec.paths).flatMap(([path, ops]) => Object.keys(ops).filter((m) => METHODS.includes(m)).map((m) => `${m.toUpperCase()} ${path}`)));
const seen = new Set<string>();
// actions only a Product Catalog 1.0 site can use, marked as such once written
const old = new Set<string>();
const used = new Set<string>();

type Schema = Record<string, any>;
const EVENTS = new URL("../../src/integrations/own/chargebee/events.json", import.meta.url).pathname;
// POSTs that only work something out (estimates, a PDF's download link), so they run without asking
const READS = [
  "retrieve_invoice_as_pdf", "retrieve_credit_note_as_pdf", "retrieve_quote_as_pdf", "retrieve_usages_for_an_invoice_as_pdf", "retrieve_direct_debit_agreement_pdf",
  "retrieve_store_subscription", "list_personalized_offers",
  "create_an_estimate_for_unbilled_charges", "estimate_for_creating_a_customer_and_subscription", "estimates_for_payment_schedules",
  "cancel_subscription_for_items_estimate", "resume_subscription_estimate", "create_invoice_for_items_estimate", "gift_subscription_estimate_for_items",
  "estimate_for_updating_a_subscription", "regenerate_invoice_estimate", "estimate_for_creating_a_subscription", "subscription_change_term_end_estimate",
  "pause_subscription_estimate", "advance_invoice_estimate", "estimates_for_purchase",
  "update_subscription_estimate", "gift_subscription_estimate", "create_subscription_estimate", "create_invoice_estimate", "cancel_subscription_estimate",
];
// GETs that hand back a way in: a customer's signed-in portal link, a payment gateway's card tokens
const SECRETS = ["retrieve_a_portal_session", "list_gateway_payment_method_tokens_for_a_payment_source"];
const LIST = (what: string) => ({ type: "array", items: { type: "string" }, description: what });

export default {
  spec: [PC2, PC1],
  // the specs' server is a template ({site}.chargebee.com); the person's own site is put in at call time
  server: () => "",
  out: "src/integrations/own/chargebee/actions.json",
  name: (id, method, path) => {
    let n = id;
    if (!pc2.has(`${method} ${path}`)) {
      if (used.has(n)) n = `${id}_plans_addons`;
      old.add(n);
    }
    used.add(n);
    return n;
  },
  // PC 2.0 is read first, so a call both specs have is PC 1.0's the second time it's seen
  skip: (method, path) => {
    const call = `${method} ${path}`;
    const again = seen.has(call);
    seen.add(call);
    if (again) return "the Product Catalog 2.0 spec has the same call";
  },
  // where the person's customer is, for fraud checks; Emplio is the one calling, so they say nothing
  drop: { "*": ["chargebee-request-origin-device", "chargebee-request-origin-user", "chargebee-request-origin-user-encoded", "chargebee-request-origin-ip"] },
  reads: READS,
  secrets: SECRETS,
  // Chargebee's list filters are deepObject (created_at[after]=…, status[in]=[a,b]); own/openapi.ts sends a query object
  // as JSON, so each filter's parts become their own query keys here and own/chargebee/index.ts flattens the input to match
  after: async () => {
    // every event Chargebee can send, with what it means, for triggers.ts
    const said: string = pc2Spec.paths["/events"].get.parameters.find((p: Schema) => p.name === "event_type").schema.properties.is.description;
    await Bun.write(EVENTS, JSON.stringify(Object.fromEntries([...said.matchAll(/`([a-z0-9_]+)` - ([^\n]*)/g)].filter((m) => !/deprecated/i.test(m[2]!)).map((m) => [m[1], m[2]!.trim().replace(/\.?$/, ".")])), null, 1));

    const out = await Bun.file(OUT).json();
    for (const a of out.actions as Schema[]) {
      if (old.has(a.name)) a.description = `Only for sites still on Product Catalog 1.0 (plans and addons). ${a.description}`;
      // JSON fields (meta_data and the like) go up as one JSON string, not as meta_data[key]=…
      const json = Object.entries<Schema>(a.input.properties).filter(([k, v]) => a.send.body?.fields?.some(([f]: string[]) => f === k) && v.type === "object" && !v.properties).map(([k]) => k);
      if (json.length) a.json = json;
      // path params are named like {customer-id}; own/openapi.ts fills in only {word} ones, so they become customer_id
      a.send.path = (a.send.path as string).replace(/\{([\w-]+)\}/g, (_: string, p: string) => {
        let field = p.replace(/-/g, "_");
        if (field === p) return `{${p}}`;
        // a filter or field of the same name (list_attached_items' item_id filter): the one in the path says so
        if (a.input.properties[field]) field = `path_${field}`;
        a.input.properties[field] = a.input.properties[p];
        delete a.input.properties[p];
        a.input.required = a.input.required?.map((r: string) => (r === p ? field : r));
        return `{${field}}`;
      });
      a.send.query = (a.send.query as string[]).flatMap((q) => {
        const s = a.input.properties[q];
        if (s?.type !== "object" || !s.properties) return [q];
        for (const op of ["in", "not_in"]) if (s.properties[op]) s.properties[op] = LIST(op === "in" ? "Any of these values" : "None of these values");
        return Object.keys(s.properties).map((p) => `${q}[${p}]`);
      });
    }
    await Bun.write(OUT, JSON.stringify(out));
  },
} satisfies AppConfig;
