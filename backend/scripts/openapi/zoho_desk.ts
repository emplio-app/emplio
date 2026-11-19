// Zoho Desk: Zoho publishes its OpenAPI files on GitHub (zoho/zohodesk-oas), one per resource, which point into each
// other ("./Common.json#/..."). The generator reads one file's own refs, so this joins them into one spec first.
import { mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AppConfig } from "../openapi-actions";
import { composioNames } from "./composio-names";
import { zohoNamer } from "./zoho-spec";

type Json = Record<string, any>;
const dir = await mkdtemp(join(tmpdir(), "zoho-desk-"));
await Bun.write(join(dir, "oas.tgz"), await (await fetch("https://codeload.github.com/zoho/zohodesk-oas/tar.gz/refs/heads/master")).arrayBuffer());
await Bun.$`tar -xzf ${join(dir, "oas.tgz")} -C ${dir}`;
const specDir = join(dir, "zohodesk-oas-master", "v1.0");
const files = Object.fromEntries(
  await Promise.all((await readdir(specDir)).filter((f) => f.endsWith(".json") && !f.startsWith("._")).map(async (f) => [f.replace(/\.json$/, ""), await Bun.file(join(specDir, f)).json()] as const)),
) as Record<string, Json>;

// every component gets its file's name in front (Ticket__ticketResponse), and every ref, local or not, points at that.
// Examples (in a folder of their own) are dropped: the generator doesn't read them.
const rename = (v: unknown, file: string): unknown => {
  if (Array.isArray(v)) return v.map((x) => rename(x, file));
  if (!v || typeof v !== "object") return v;
  return Object.fromEntries(
    Object.entries(v).filter(([k]) => k !== "examples" && k !== "example").map(([k, x]) => {
      if (k !== "$ref" || typeof x !== "string") return [k, rename(x, file)];
      const m = x.match(/^(?:(?:\.\/)?([\w-]+)\.json)?#\/components\/(\w+)\/(.+)$/);
      if (!m) throw new Error(`can't follow ${x} in ${file}`);
      return [k, `#/components/${m[2]}/${m[1] ?? file}__${m[3]}`];
    }),
  );
};

const spec: Json = { openapi: "3.1.0", info: { title: "Zoho Desk", version: "1.0" }, paths: {}, components: {} };
for (const [file, doc] of Object.entries(files)) {
  for (const [kind, items] of Object.entries<Json>(doc.components ?? {}).filter(([kind]) => kind !== "examples"))
    for (const [name, item] of Object.entries(items)) (spec.components[kind] ??= {})[`${file}__${name}`] = rename(item, file);
  for (const [path, ops] of Object.entries<Json>(doc.paths ?? {})) {
    const at = (spec.paths[path] ??= {});
    // one call (a direct assignment rule's target) is in two files; the first is kept
    for (const [method, op] of Object.entries<Json>(ops)) if (!(method in at)) at[method] = rename(op, file);
  }
}
// Desk's orgId goes in a header (its docs say so; the spec lists it in the query)
spec.components.parameters.Common__orgId = { ...spec.components.parameters.Common__orgId, in: "header" };
// the generator reads request bodies in place. Every call but the list of organisations takes orgId, though a few
// in the spec (the dashboard counts, logos) forgot it.
const ORG = "#/components/parameters/Common__orgId";
const follow = (ref: string) => ref.replace("#/components/", "").split("/").reduce((o: Json, k) => o[k], spec.components);
for (const [path, ops] of Object.entries<Json>(spec.paths))
  for (const op of Object.values<Json>(ops)) {
    if (op?.requestBody?.$ref) op.requestBody = follow(op.requestBody.$ref);
    if (op?.operationId && path !== "/api/v1/organizations" && !(op.parameters ?? []).some((p: Json) => p.$ref === ORG)) (op.parameters ??= []).push({ $ref: ORG });
  }

// sortBy's enum leaves out the descending ones its own description and pattern allow ("-createdTime")
for (const p of spec.paths["/api/v1/contracts"].get.parameters) if (p.name === "sortBy") p.schema.enum = p.schema.enum.flatMap((v: string) => [v, `-${v}`]);

const out = join(dir, "zoho-desk.json");
await Bun.write(out, JSON.stringify(spec));

export default {
  spec: out,
  out: "src/integrations/own/zoho_desk/actions.json",
  name: zohoNamer(await composioNames("zoho_desk")),
  skip: (method, path) => {
    const op = spec.paths[path]?.[method.toLowerCase()];
    if ((op?.security ?? []).every((s: Json) => "cookie-auth" in s)) return "works only from Zoho's own web pages (a browser cookie), not with a sign-in";
  },
  // Composio's names for the same calls
  rename: {
    associate_tag: "associate_ticket_tags",
    draft_email_reply: "create_ticket_email_reply_draft",
    get_thread_attachment_content: "download_thread_attachment",
    get_latest_thread: "get_ticket_latest_thread",
    get_thread: "get_ticket_thread",
    get_agents: "list_agents",
    get_departments: "list_departments",
    get_organizations: "list_organizations",
    get_roles: "list_roles",
    get_roles_by_role_ids: "list_roles_by_ids",
    get_teams_in_department: "list_teams_in_department",
    get_ticket_history: "list_ticket_history",
    get_tickets: "list_tickets",
    list_threads: "list_ticket_threads",
    get_views: "list_views",
    search_across_modules: "search",
    update_department_logo: "upload_department_logo",
    create_ticket_attachment: "upload_ticket_attachment",
    get_contracts_contracts: "list_contracts",
  },
  // POSTs that only look things up
  reads: ["validate_transition_field_updates", "get_count_of_resources_related_to_request", "list_subject_access_request_entities", "get_import_mappings", "list_whats_app_template_supported_languages", "validate_permalink", "preview_article", "get_session_last_messages"],
  secrets: ["get_jwt_secret_key"],
  params: { orgId: "Which Zoho Desk organisation to act on (its orgId). Leave out when the login has just one; Emplio fills it in." },
} satisfies AppConfig;
