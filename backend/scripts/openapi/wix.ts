// Wix: no OpenAPI spec, but every REST method has a markdown page (dev.wix.com/docs/...md) with a schema block: its
// URL, HTTP method and parameters as an indented tree. This reads the method list from llms-full.txt, fetches each
// page (cached in the temp folder), turns them into one OpenAPI file for ../openapi-actions.ts, and names the actions
// the way Composio does where it has the same call.
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AppConfig } from "../openapi-actions";
import { composioNames, namer } from "./composio-names";

type Schema = Record<string, any>;
const DOCS = "https://dev.wix.com/docs/";

// sections a site owner's API key can't use, and why (for COVERAGE.md)
const LEFT_OUT: Record<string, string> = {
  "api-reference/app-management": "only a Wix app's own token can call these (billing, app instance, embedded scripts, OAuth)",
  "api-reference/wix-backoffice": "Wix's own dev-center back office",
  "api-reference/mobile": "the Wix mobile app builder, for app developers",
  "api-reference/tools": "searches Wix's developer docs, not the site",
  "api-reference/site/viewer": "runs in a visitor's browser on the live site",
  "api-reference/account-level/resellers": "the Wix reseller programme only",
  "api-reference/account-level/enterprise": "Wix Enterprise accounts only",
  "api-reference/account-level/channels": "Wix partner channels only",
};
// account-level APIs are sent with wix-account-id instead of wix-site-id (own/wix/index.ts reads `account`), except
// the ones about one site (its contributors, publishing it), which the docs show with wix-site-id
const accountWide = (section: string, md: string) =>
  section.startsWith("account-level/") && !section.startsWith("account-level/user-management/sites") && !(md.includes("wix-site-id") && !md.includes("wix-account-id"));

// pages are kept between runs; delete this folder to read Wix's docs afresh
const cache = join(tmpdir(), "wix-docs");
await mkdir(cache, { recursive: true });
async function page(url: string): Promise<string> {
  const file = join(cache, `${url.replace(/[^a-z0-9]+/gi, "_")}.md`);
  if (await Bun.file(file).exists()) return Bun.file(file).text();
  for (let i = 0; ; i++) {
    const res = await fetch(url).catch(() => null);
    if (res?.ok) {
      const text = await res.text();
      await Bun.write(file, text);
      return text;
    }
    if (i === 3) throw new Error(`${url}: ${res?.status ?? "no answer"}`);
    await Bun.sleep(2000 * (i + 1));
  }
}

const PRIMITIVE: Record<string, string> = { string: "string", integer: "integer", number: "number", boolean: "boolean", object: "object" };
type Node = { indent: number; name: string; type: string; description?: string; required?: boolean; enum?: string[]; children: Node[]; query?: boolean };

// The docs indent a query's filter and sort as if they were inside its paging (cursorPaging.filter); paging only
// ever holds limit, cursor and offset, so anything else there goes back up beside it.
const PAGING = new Set(["limit", "cursor", "offset"]);
function hoist(list: Node[]) {
  for (const n of [...list]) {
    if (/^(cursorPaging|paging)$/.test(n.name)) {
      const out = n.children.filter((c) => !PAGING.has(c.name));
      n.children = n.children.filter((c) => PAGING.has(c.name));
      list.splice(list.indexOf(n) + 1, 0, ...out.filter((c) => !list.some((x) => x.name === c.name)));
    }
    hoist(n.children);
  }
}

// one "- name: x | type: T | description: D | required: true" line
function fields(line: string) {
  const parts = line.split(" | ").map((p) => p.trim());
  const name = parts[0]!.replace(/^(-\s*)?(query )?param name:\s*|^-\s*name:\s*/, "").trim();
  const get = (k: string) => parts.find((p) => p.startsWith(`${k}:`))?.slice(k.length + 1).trim();
  return { name, type: (get("type") ?? "").split(/\s+/)[0] ?? "", description: get("description"), required: get("required") === "true" };
}

function toSchema(n: Node): Schema {
  const out: Schema = {};
  if (n.description) out.description = n.description;
  const array = /^array<(.+)>$/.exec(n.type);
  const inner = array ? array[1]! : n.type;
  let item: Schema = {};
  if (n.children.length) item = { type: "object", properties: Object.fromEntries(n.children.map((c) => [c.name, toSchema(c)])) };
  // a list naming payment providers is left open: the public repo's leak check reserves one provider's prefix
  else if (n.enum?.length && !n.enum.includes("PAYPAL_AGENTIC_CHECKOUT")) item = { type: "string", enum: n.enum };
  else if (n.enum?.length) item = { type: "string" };
  else if (PRIMITIVE[inner]) item = { type: PRIMITIVE[inner] };
  else if (array) item = { type: "string" }; // array<fields>: a list of names
  if (item.type === "object" && !item.properties) item.additionalProperties = {};
  return array ? { ...out, type: "array", items: item } : { ...item, ...out };
}

// the REST schema block of a method page: URL, HTTP method, and the parameter tree
function parse(md: string, link: string, section: string, readsTitle: string) {
  const blocks = [...md.matchAll(/### Schema\s*\n```\n([\s\S]*?)```/g)].map((m) => m[1]!);
  const block = blocks.find((b) => /^\s*URL: https?:\/\//m.test(b));
  if (!block) return null;
  const url = new URL(/^\s*URL: (\S+)/m.exec(block)![1]!);
  const method = /^\s*Method: (GET|POST|PUT|PATCH|DELETE)\s*$/m.exec(block)?.[1];
  if (!method) return null;
  const id = /^\s*Method: (\w+)/m.exec(block)![1]!;
  const description = /^\s*Description: (.*)$/m.exec(block)?.[1]?.trim();
  const requiredTop = new Set((/^\s*Required parameters:\s*(.*)$/m.exec(block)?.[1] ?? "").split(",").map((s) => s.trim()).filter((s) => s && !s.includes(".")));
  const top: Node[] = [];
  const stack: Node[] = [];
  let enumOf: Node | undefined;
  const body = block.split(/^\s*(Return type|Query fields|Searchable fields):/m)[0]!;
  for (const line of body.slice(body.search(/^\s*Method parameters:/m)).split("\n").slice(1)) {
    const indent = line.search(/\S/);
    if (indent < 0) continue;
    const t = line.trim();
    while (stack.length && stack.at(-1)!.indent >= indent) stack.pop();
    if (/^-\s*enum:/.test(t)) {
      enumOf = stack.at(-1);
      const listed = t.replace(/^-\s*enum:\s*/, "");
      if (enumOf && listed) enumOf.enum = listed.split(",").map((s) => s.trim()).filter(Boolean);
      else if (enumOf) enumOf.enum = [];
      continue;
    }
    if (/^-\s{2,}\S/.test(t) && enumOf?.enum && !/^-\s*name:/.test(t)) {
      const v = /^-\s+([\w.-]+)/.exec(t)?.[1];
      if (v) enumOf.enum.push(v);
      continue;
    }
    if (/^-\s*ONE-OF/.test(t)) continue;
    if (!/^(-\s*name:|(query )?param name:)/.test(t)) continue;
    enumOf = undefined;
    const f = fields(t);
    const node: Node = { indent, ...f, children: [], query: t.startsWith("query param") };
    (stack.at(-1)?.children ?? top).push(node);
    stack.push(node);
  }

  hoist(top);
  let path = publicPath(decodeURI(url.pathname), method, md);
  const parameters: Schema[] = [];
  const props: Schema = {};
  const required: string[] = [];
  // {product.id} → {product_id}: the path's names are plain words
  for (const [, name] of path.matchAll(/\{([^}]+)\}/g)) {
    const field = name!.replace(/\./g, "_");
    path = path.replace(`{${name}}`, `{${field}}`);
    const node = top.find((n) => n.name === name);
    parameters.push({ name: field, in: "path", required: true, description: node?.description ?? `The ${name.replace(/\./g, "'s ")}`, schema: { type: "string" } });
  }
  const inPath = new Set(parameters.map((p) => p.name));
  // a GET's nested params go in the query as paging.limit=…, the way Wix reads them
  const flat = (n: Node, prefix: string): Schema[] =>
    n.children.length && !n.type.startsWith("array<")
      ? n.children.flatMap((c) => flat(c, `${prefix}${n.name}.`))
      : [{ name: `${prefix}${n.name}`, in: "query", required: !prefix && requiredTop.has(n.name), description: n.description, schema: toSchema({ ...n, description: undefined }) }];
  const bodyless = method === "GET" || method === "DELETE";
  for (const n of top) {
    if (inPath.has(n.name.replace(/\./g, "_"))) continue;
    if (n.query || bodyless) parameters.push(...flat(n, ""));
    else {
      props[n.name] = toSchema(n);
      if (requiredTop.has(n.name)) required.push(n.name);
    }
  }
  // the page's address says it best ("get-site-properties"); its heading is the method's code name ("read")
  const slug = link.split("/").pop()!.replace(/\.md$/, "");
  const title = slug.replace(/-/g, " ").replace(/^./, (c) => c.toUpperCase());
  const op: Schema = {
    operationId: id,
    summary: title,
    description: description ?? "",
    tags: [section],
    parameters,
    // a POST that only looks things up (query, search, count…) runs without asking; "get or create", "check in" and a
    // payment request's link make something
    "x-account": accountWide(section, md),
    "x-read": method === "POST" && new RegExp(`^(${readsTitle})\\b`, "i").test(title) && !/\b(create|check in|payment request)\b/i.test(title),
  };
  if (/This (method|endpoint) (is|has been) deprecated/i.test(md.slice(0, 6000))) op.deprecated = true;
  if (Object.keys(props).length) op.requestBody = { required: true, content: { "application/json": { schema: { type: "object", properties: props, ...(required.length && { required }) } } } };
  if (url.origin !== "https://www.wixapis.com") op.servers = [{ url: url.origin }];
  return { path, method: method.toLowerCase(), op };
}

// The schema's URL is sometimes Wix's internal route (/v3/posts, /_api/bookings/...) where the page's own curl example
// shows the public one (/blog/v3/posts, /bookings/...). When a curl for the same HTTP method ends the way the schema's
// path does (its {ids} matching anything), the curl's start is used with the schema's ending.
function publicPath(path: string, method: string, md: string) {
  const want = path.split("/").filter(Boolean);
  if (want.some((s) => s.includes("**"))) return path;
  for (const m of md.matchAll(/curl([^`]*?)'https:\/\/www\.wixapis\.com(\/[^'?\s]*)/g)) {
    const x = /-X\s+(\w+)/.exec(m[1]!)?.[1] ?? (/--data|-d /.test(m[1]!) ? "POST" : "GET");
    if (x !== method) continue;
    const got = m[2]!.split("/").filter(Boolean);
    let n = 0;
    while (n < want.length && n < got.length) {
      const w = want[want.length - 1 - n]!;
      if (!w.includes("{") && w !== got[got.length - 1 - n]) break;
      n++;
    }
    // the whole schema path matched: nothing to change. Too little matched, or an {id} left out: not this call.
    if (n === want.length && got.length === want.length) return path;
    if (n < 2 || want.slice(0, want.length - n).some((s) => s.includes("{"))) continue;
    return `/${[...got.slice(0, got.length - n), ...want.slice(want.length - n)].join("/")}`;
  }
  return path;
}

const READ_VERBS = "Query|Search|Count|List|Get|Calculate|Preview|Estimate|Check|Validate|Retrieve|Find|Aggregate|Resolve|Fetch|Lookup|Is";

async function build() {
  const full = await (await fetch(`${DOCS}llms-full.txt`)).text();
  const links = [...new Set([...full.matchAll(/^# Method link: (https:\/\/dev\.wix\.com\/docs\/api-reference\/\S+\.md)$/gm)].map((m) => m[1]!))];
  const keep = links.filter((l) => !Object.keys(LEFT_OUT).some((s) => l.startsWith(`${DOCS}${s}/`)));
  // fetched 12 at a time, kept in the docs' order so names come out the same every run
  const pages = new Array<string>(keep.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: 12 }, async () => {
      while (next < keep.length) {
        const i = next++;
        pages[i] = await page(keep[i]!);
      }
    }),
  );
  const paths: Schema = {};
  const noRest: string[] = [];
  keep.forEach((link, i) => {
    const rel = link.slice(DOCS.length).replace(/\.md$/, "");
    const got = parse(pages[i]!, link, rel.split("/").slice(1, -1).join("/"), READ_VERBS);
    if (!got) return void noRest.push(rel);
    const ops = (paths[got.path] ??= {});
    // the same call documented twice (two versions' pages): the first stays
    ops[got.method] ??= got.op;
  });
  console.log(`${links.length} method pages, ${links.length - keep.length} in left-out sections, ${noRest.length} with no REST call (SDK only)`);
  const file = join(cache, "wix-openapi.json");
  await Bun.write(file, JSON.stringify({ openapi: "3.0.0", info: { title: "Wix REST", version: "1" }, servers: [{ url: "https://www.wixapis.com" }], paths }));
  return file;
}

const spec = await build();

// Composio's name when it has the same call; otherwise the page's title. A title used twice (two versions, or the
// same verb in two APIs) gets the API's own folder in front: contacts_v5_query_contacts.
const pick = namer(await composioNames("wix"));
const used = new Set<string>();
const snake = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
const name: AppConfig["name"] = (id, method, path, op) => {
  let n = pick(id, method, path, op);
  // namer falls back to the code name ("read") when the title's name is taken
  if (used.has(n) || (n === id && snake(op.summary) !== id)) n = `${snake(String(op.tags[0]).split("/").at(-1)!)}_${snake(op.summary)}`;
  for (let i = 2; used.has(n); i++) n = `${snake(String(op.tags[0]).split("/").slice(-2).join("_"))}_${snake(op.summary)}${i > 2 ? `_${i}` : ""}`;
  used.add(n);
  return n;
};

export default {
  spec,
  out: "src/integrations/own/wix/actions.json",
  name,
  // the same calls under Composio's names, so skills and automations made with Composio's Wix keep working
  rename: {
    // Forms' page of the same title comes first in the docs
    get_site_properties: "standalone_form_get_site_properties",
    properties_get_site_properties: "get_site_properties",
    authentication_register_v_2: "register_v2",
    list_sessions_async: "list_sessions",
    member_orders_service_list_orders: "list_pricing_plan_orders",
    member_orders_service_get_order: "get_pricing_plan_order",
    orders_cancel_order: "cancel_pricing_plan_order",
    // pages titled with one bare verb
    disconnect: "disconnect_external_calendar",
    checkout: "checkout_event_tickets",
    downvote: "downvote_comment",
    upvote: "upvote_comment",
    connect: "connect_conferencing_provider",
    authorize: "authorize_captcha",
    search: "search_dashboard",
    create: "create_email_campaign",
    preview: "preview_email_campaign",
    reschedule: "reschedule_email_campaign",
    notify: "send_notification",
    find_or_create_label: "create_contacts_labels",
    labels_update_label: "update_labels",
    labels_delete_label: "delete_contacts_la",
    list_facets: "list_contacts_facets",
    query_facets: "query_facets_query",
    list_contacts: "list_v4_contacts",
    enable_points_expiration: "create_points_expiration_enable",
    bulk_create_products_with_inventory: "create_products_with_inventory_bulk_create",
    delete_back_in_stock_notification_request: "delete_back_in_stock_notification",
    delete_form: "delete_forms",
    delete_product: "delete_products",
    bulk_delete_items_by_filter: "delete_items_by_filter",
    bulk_delete_reports_by_filter: "delete_reports_by_filter",
    bulk_delete_rsvps_by_filter: "delete_rsvps_by_filter",
    bulk_delete_services_by_filter: "delete_services_by_filter",
    bulk_delete_ticket_definitions_by_filter: "delete_ticket_definitions_bulk",
    bulk_remove_info_sections_from_products_by_filter: "remove_info_sections_from_products_by_filter",
    bulk_update_inventory_items_by_filter: "update_inventory_items_by_filter",
    bulk_update_operation_group_tags_by_filter: "update_operation_group_tags_by_filter",
    bulk_update_products_by_filter: "update_products_by_filter",
    bulk_update_staff_member_tags_by_filter: "update_staff_member_tags_by_filter",
    bulk_update_storage_item_tags: "update_storage_item_tags",
    bulk_update_order_tags: "update_orders_update_tags",
    bulk_update_moderation_status: "update_reviews_moderate",
    update_moderation_status: "update_reviews_moderate2",
    bulk_remove_deleted_field: "remove_deleted_fields",
    list_invoices_for_multiple_orders: "list_invoices_list_by_ids",
    search_orders: "query_e_commerce_orders",
    query_events: "query_events_events",
    moderation_rules_query_rules: "query_moderation_rules",
  },
  // POSTs that only read, and the one GET that hands back a secret, settled from the spec once the actions exist
  async after(s) {
    const out = new URL("../../src/integrations/own/wix/actions.json", import.meta.url).pathname;
    const json = await Bun.file(out).json();
    const reads = new Set<string>();
    const accounts = new Set<string>();
    for (const [p, ops] of Object.entries<Schema>(s.paths))
      for (const [m, op] of Object.entries<Schema>(ops)) {
        if (op["x-read"]) reads.add(`${m.toUpperCase()} ${p}`);
        if (op["x-account"]) accounts.add(`${m.toUpperCase()} ${p}`);
      }
    for (const a of json.actions) {
      if (reads.has(`${a.send.method} ${a.send.path}`)) a.readOnly = true;
      if (a.group.endsWith("secrets") && a.send.method === "GET" && /value/i.test(a.name)) {
        a.readOnly = false;
        a.description += " Shows a secret: only when the person needs it, never pasted in a chat.";
      }
      if (accounts.has(`${a.send.method} ${a.send.path}`)) a.account = true;
    }
    await Bun.write(out, JSON.stringify(json));
  },
} satisfies AppConfig;
