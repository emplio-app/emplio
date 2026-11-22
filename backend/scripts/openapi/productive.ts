// Productive: what the generator (../openapi-actions.ts) can't tell from the spec. Productive's API is JSON:API, so
// before generating, every body {"data": {"type", "attributes", "relationships"}} is flattened into plain fields
// (attributes as they are, each relationship as <name>_id), and own/productive/index.ts builds the JSON:API body
// back from `jsonapi` in actions.json. Filters get a plain object with their keys listed, not the spec's
// recursive schema.
import type { AppConfig } from "../openapi-actions";

const SPEC = "https://developer.productive.io/openapi.json";
const OUT = "src/integrations/own/productive/actions.json";
const LOCAL = `${Bun.env.TMPDIR ?? "/tmp"}/productive-openapi.json`;

type Schema = Record<string, any>;
type Meta = { type?: string; attrs?: string[]; rels?: Record<string, [name: string, type: string, many: boolean]>; bulk?: boolean };

// relationship names whose resource type isn't simply their plural
const TYPES: Record<string, string> = {
  approver: "people", approvers: "people", assignee: "people", designated_approver: "people", manager: "people", person: "people",
  project_manager: "people", responsible: "people", subscribers: "people", contact: "people", contacts: "people", issuer: "people",
  budget: "deals", origin_deal: "deals", parent_company: "companies", vendor: "companies", dependent_task: "tasks", parent_task: "tasks",
  parent_invoice: "invoices", default_bank_account: "bank_accounts", default_document_type: "document_types", proposal_document_type: "document_types",
  default_payment_reminder_sequence: "payment_reminder_sequences", default_subsidiary: "subsidiaries", default_tax_rate: "tax_rates",
  custom_role: "roles", origin_field: "custom_fields", meeting: "calendar_events", template: "projects", attachments: "attachments",
};
const plural = (n: string) => (n.endsWith("y") ? `${n.slice(0, -1)}ies` : /(s|x)$/.test(n) ? `${n}es` : `${n}s`);

const spec: Schema = await (await fetch(SPEC)).json();
const ref = (s: Schema): Schema => (s?.$ref ? ref((s.$ref as string).slice(2).split("/").reduce((o: Schema, k) => o[k], spec)) : s);
const meta: Record<string, Meta> = {};

// sort of "people" → singular, for action names
const single = (n: string) =>
  n === "people" ? "person" : /statuses$|addresses$/.test(n) ? n.slice(0, -2) : n.endsWith("ies") ? `${n.slice(0, -3)}y` : /(x|ss)es$/.test(n) ? n.slice(0, -2) : n.endsWith("s") && !n.endsWith("ss") ? n.slice(0, -1) : n;

for (const [path, ops] of Object.entries<Schema>(spec.paths)) {
  for (const [method, op] of Object.entries<Schema>(ops)) {
    if (!op?.requestBody) continue;
    const body = ref(op.requestBody);
    const one = body.content?.["application/vnd.api+json"]?.schema;
    const bulk = body.content?.["application/vnd.api+json; ext=bulk"]?.schema;
    const key = `${method.toUpperCase()} ${path}`;
    const schema = ref(one ?? bulk ?? {});
    const data = ref(schema.properties?.data ?? {});
    let flat: Schema = schema;
    if (one && data.properties?.attributes) {
      const attrs = ref(data.properties.attributes);
      const relSchema = data.properties.relationships ? ref(data.properties.relationships.allOf?.[0] ?? data.properties.relationships) : {};
      const properties: Schema = { ...(attrs.properties ?? {}) };
      const rels: Meta["rels"] = {};
      for (const [r, s] of Object.entries<Schema>(relSchema.properties ?? {})) {
        const many = ref(s).title === "Collection linkage" || ref(ref(s).properties?.data ?? {}).type === "array";
        const field = many ? `${single(r)}_ids` : `${r}_id`;
        if (field in properties) continue; // the attribute sets the same thing
        const type = TYPES[r] ?? plural(r);
        const id = { anyOf: [{ type: "string" }, { type: "integer" }] };
        properties[field] = many
          ? { type: "array", items: id, description: `The ${r.replace(/_/g, " ")} to link: their ids (${type})` }
          : { ...id, description: `The ${r.replace(/_/g, " ")} to link: its id (${type})` };
        rels[field] = [r, type, many];
      }
      flat = { type: "object", properties, ...(attrs.required?.length && { required: attrs.required }) };
      meta[key] = { type: ref(data.properties.type ?? {}).enum?.[0], attrs: Object.keys(attrs.properties ?? {}), rels };
    } else if (one && data.properties) {
      // an action with no attributes (approve, archive...): the body is {"data": {...}} as the spec says
      meta[key] = {};
    } else if (bulk) meta[key] = { bulk: true };
    op.requestBody = { required: body.required, content: { "application/json": { schema: flat } } };
  }
  // a filter's own schema nests itself without end: a plain object, its keys listed instead
  for (const op of Object.values<Schema>(ops)) {
    for (const [i, p] of (op?.parameters ?? []).entries()) {
      const param = ref(p);
      if (param.name !== "filter" || param.style !== "deepObject") continue;
      const root = ref(param.schema ?? {});
      const plain = ref((root.oneOf ?? []).find((o: Schema) => !ref(o).properties?.$op) ?? root);
      const keys = Object.keys(plain.properties ?? {});
      op.parameters[i] = {
        in: "query",
        name: "filter",
        schema: { type: "object", additionalProperties: {} },
        description:
          'Only items matching these, like {"project_id": "123"} or {"due_date": {"lt": "2026-12-01"}}; several ids comma separated ("1,2"); operators eq, not_eq, lt, gt, contains.' +
          (keys.length ? ` Filters: ${keys.join(", ")}` : ""),
      };
    }
  }
}
await Bun.write(LOCAL, JSON.stringify(spec));

const VERB: Record<string, (one: string, many: string) => string> = {
  index: (_o, m) => `list_${m}`,
  show: (o) => `get_${o}`,
  create: (o) => `create_${o}`,
  update: (o) => `update_${o}`,
  destroy: (o) => `delete_${o}`,
};

export default {
  spec: LOCAL,
  out: OUT,
  // tasks-create → create_task, tasks-index → list_tasks, boards-archive-archive → archive_board, …-bulk → bulk_…
  name: (id, _method, path) => {
    const [res = "", sub = ""] = path.replace("/api/v2/", "").split("/");
    // reports/task_reports → get_task_reports
    if (res === "reports" && sub.endsWith("_reports")) return `get_${sub}`;
    const parts = [...new Set(id.slice(res.length + 1).split("_"))].filter(Boolean).map((p) => (p === "destroy" ? "delete" : p));
    const one = single(res);
    if (parts.includes("bulk")) return `bulk_${parts.filter((p) => p !== "bulk").join("_") || "update"}_${res}`;
    const verb = parts.join("_");
    return VERB[verb]?.(one, res) ?? `${verb}_${one}`;
  },
  skip: (_method, path) =>
    /^\/api\/v2\/public\//.test(path) ? "public pages for the business's clients (a shared doc, a proposal to sign), opened with their link, not the account's login"
    : /^\/api\/v2\/(sessions|signups|passwords|two_factor_authentications)/.test(path) ? "signing in, signing up and passwords: done by a person in Productive, not with an API token"
    : /update_password$/.test(path) ? "changing a person's password needs their current one"
    : /create_setup_intent$/.test(path) ? "adds a payment card through Stripe in the browser"
    : undefined,
  rename: {
    harvest_import_import: "import_from_harvest",
    import_import: "process_import",
    flatfile_import: "create_flatfile_import",
    send_pulse_pulse: "send_pulse",
    regenerate_signing_secret_webhook: "regenerate_webhook_signing_secret",
    countries_holiday_calendar: "list_holiday_calendar_countries",
    test_payload_webhook: "send_webhook_test",
  },
  // answers carry webhooks' signing secrets
  secrets: ["list_webhooks", "get_webhook", "regenerate_webhook_signing_secret"],
  // PATCHes that only check on something
  reads: ["check_export_status_expense", "check_export_status_invoice", "check_dependencies_integration"],
  // a total count of every list, which only makes lists slower
  drop: { "*": ["X-Count", "X-No-Count"] },
  after: async () => {
    const file = new URL(`../../${OUT}`, import.meta.url).pathname;
    const out = await Bun.file(file).json();
    for (const a of out.actions) {
      const m = meta[`${a.send.method} ${a.send.path}`];
      if (m) a.jsonapi = m;
    }
    await Bun.write(file, JSON.stringify(out));
  },
} satisfies AppConfig;
