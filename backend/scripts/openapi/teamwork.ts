// Teamwork.com: what the generator (../openapi-actions.ts) can't tell from the specs. Teamwork publishes three Swagger 2
// files for its Projects API: v3 (most of it), v2 (a few calls v3 doesn't have) and v1 (the oldest, still the only one
// with messages, notebooks, links, invoices, expenses, webhooks and more). All three live on the person's own
// <site>.teamwork.com; own/teamwork/index.ts sends every call there. v3 is read first, so where two versions have a call
// with the same summary, v3's gets the plain name and the older one ends in _v2 or _v1.
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import type { AppConfig } from "../openapi-actions";
import { composioNames, namer } from "./composio-names";

type Schema = Record<string, any>;
const SPECS = "https://contento-assets.s3.eu-west-1.amazonaws.com/oas/teamwork_docs/projects/reference";
const VERSIONS = ["v3", "v2", "v1"];
const METHODS = ["get", "post", "put", "patch", "delete"];
const TYPES = new Set(["string", "integer", "number", "boolean", "array", "object"]);
const words = (s: string) =>
  s
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "");

// Swagger 2 → OpenAPI 3, as far as these files need: a body param becomes a requestBody, the rest get a schema, and
// path params the file forgot to declare (most of v1's) are added
function lift(s: Schema, version: string): Schema {
  s = JSON.parse(JSON.stringify(s).replaceAll('"#/definitions/', '"#/components/schemas/'));
  // types that aren't JSON Schema's (v3's "any", v1's "Custom SAML" in examples) are left open
  const open = (o: any): void => {
    if (!o || typeof o !== "object") return;
    if (typeof o.type === "string" && !TYPES.has(o.type)) delete o.type;
    for (const v of Object.values(o)) open(v);
  };
  open(s);
  // v3's schemas mark nearly every field required (dates, tags, custom fields...), which Teamwork doesn't: the API says
  // what's missing instead
  const loose = (o: any): void => {
    if (!o || typeof o !== "object") return;
    if (Array.isArray(o.required)) delete o.required;
    for (const v of Object.values(o)) loose(v);
  };
  loose(s.definitions);
  for (const [path, ops] of Object.entries<Schema>(s.paths)) {
    for (const [m, op] of Object.entries<Schema>(ops)) {
      if (!METHODS.includes(m)) continue;
      const params: Schema[] = (op.parameters ?? []).map((p: Schema) => {
        const { name, in: where, required, description, schema, ...rest } = p;
        // v1 lists two query flags as headers
        const at = where === "header" && name !== "If-None-Match" ? "query" : where;
        return { name, in: at, required, description, schema: schema ?? { type: rest.type, items: rest.items, enum: rest.enum, default: rest.default } };
      });
      for (const [, name] of path.matchAll(/\{(\w+)\}/g))
        if (!params.some((p) => p.in === "path" && p.name === name)) params.push({ name, in: "path", required: true, schema: {}, description: `The ${name.replace(/([A-Z])/g, " $1").toLowerCase()} in Teamwork` });
      const body = params.find((p) => p.in === "body");
      if (body) op.requestBody = { required: body.required, description: body.description, content: { "application/json": { schema: body.schema } } };
      op.parameters = params.filter((p) => p.in !== "body" && p.in !== "formData" && p.name !== "If-None-Match");
      // the same report as csv, html, pdf or xlsx: one action each
      const format = path.match(/\.(csv|html|pdf|xlsx)$/)?.[1];
      const summary = String(op.summary || `${m} ${path}`).trim();
      op.summary = format ? `${summary} as ${format}` : summary;
      op.operationId = `${words(op.summary)}_${version}`;
      op.tags = op.tags ?? [version];
    }
  }
  return { openapi: "3.0.0", paths: s.paths, components: { schemas: s.definitions ?? {} } };
}

const DIR = `${tmpdir()}/emplio-teamwork-specs`;
mkdirSync(DIR, { recursive: true });
const files: string[] = [];
for (const v of VERSIONS) {
  const res = await fetch(`${SPECS}/projects-api-${v}.oas2.yml`);
  if (!res.ok) throw new Error(`Teamwork ${v} spec: ${res.status}`);
  const file = `${DIR}/${v}.json`;
  await Bun.write(file, JSON.stringify(lift(Bun.YAML.parse(await res.text()) as Schema, v)));
  files.push(file);
}

const named = namer(await composioNames("teamwork"));
const used = new Set<string>();
// the summary's words (or Composio's name for the same call); taken already, the version goes on the end
const name: AppConfig["name"] = (id, method, path, op) => {
  let n = named(id, method, path, op);
  for (let i = 2; used.has(n); i++) n = `${id}_${i}`;
  used.add(n);
  return n;
};

export default {
  spec: files,
  out: "src/integrations/own/teamwork/actions.json",
  name,
  // Composio's names for the same calls, so skills and automations made with Composio's Teamwork keep working
  rename: {
    returns_list_of_projects: "list_projects",
    returns_list_of_people: "list_people",
    get_tasklists: "list_task_lists",
    get_tasks: "list_tasks",
    get_time_entries: "list_time_entries",
    create_time_entry_linked_to_specific_task: "log_time_entry",
    create_single_tag: "create_tag",
    search_items_in_installation: "search_resources",
    creates_task: "create_task",
    get_milestones: "list_milestones",
    get_tags: "list_tags",
    // v1's calls Composio's names matched first; v3's take the names above
    create_task: "create_task_v1",
    list_milestones: "list_milestones_v1",
    list_tags: "list_tags_v1",
  },
  // POSTs that only work something out
  reads: [
    "validate_syntax_of_formula_field",
    "validate_custom_item_formula_expression",
    "validate_request_without_scheduling_or_saving",
    "optimise_without_persisting_return_plan",
    "run_reporting_engine_query",
  ],
  // everyone's API keys, and webhooks with the token that signs them
  secrets: ["retrieve_api_keys_for_people_on_account", "get_webhooks", "get_specific_webhook"],
} satisfies AppConfig;
