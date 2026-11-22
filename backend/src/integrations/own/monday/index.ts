// monday.com on a personal API token: every query and mutation of its GraphQL API is an action. actions.json is
// generated from monday's published schema by `bun scripts/openapi/monday.ts`; items, updates and subitems on a board
// start automations by webhook (triggers.ts).
import { z } from "zod";
import { AppFile, AppsError } from "../../types";
import type { OwnAction, OwnApp } from "../index";
import { events, receive, triggers, unwatch, wanted, watch } from "./triggers";

const API = "https://api.monday.com/v2";
const HELP = "monday.com → your picture → Developers → My access tokens → Copy";

type Arg = { name: string; gql: string; type: string; list?: number; values?: string[]; required: boolean; description: string };
type Spec = { name: string; kind: "query" | "mutation"; parent?: string; field?: string; description: string; readOnly: boolean; returns: string; select: string; args: Arg[] };
const spec = (await Bun.file(new URL("./actions.json", import.meta.url)).json()) as { version: string; actions: Spec[] };

type Answer = { data?: Record<string, unknown> | null; errors?: { message: string; extensions?: { code?: string } }[]; error_message?: string; error_code?: string };

// One GraphQL call. Files go to monday's /v2/file as multipart, the file as variables[<name>] and the rest written into
// the query (monday's upload takes no other variables).
export async function graphql(key: string, query: string, variables: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const headers: Record<string, string> = { Authorization: key, "API-Version": spec.version };
  const files = Object.entries(variables).filter(([, v]) => v instanceof AppFile) as [string, AppFile][];
  let res: Response;
  if (files.length) {
    const form = new FormData();
    form.append("query", query);
    for (const [k, f] of files) form.append(`variables[${k}]`, new Blob([f.bytes as Uint8Array<ArrayBuffer>], { type: f.mimetype }), f.name);
    res = await fetch(`${API}/file`, { method: "POST", headers, body: form });
  } else res = await fetch(API, { method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify({ query, variables }) });
  const text = await res.text();
  let out: Answer;
  try {
    out = JSON.parse(text);
  } catch {
    out = { error_message: text || res.statusText };
  }
  const why = [...(out.errors ?? []).map((e) => e.message), out.error_message].filter(Boolean).join("; ");
  if (res.status === 401 || out.errors?.some((e) => e.extensions?.code === "UNAUTHENTICATED"))
    throw new AppsError(`monday.com rejected the API token; copy it again (${HELP}) and reconnect`, true, why || undefined);
  // monday answers most failures with a 200 and {"errors": [...]}, and rate limits with a 429 saying when to retry
  if (why || !res.ok) throw new AppsError(`monday.com: ${why || res.statusText} (${res.status})`);
  return out.data ?? {};
}

// a value as GraphQL source, for the query an upload sends
const literal = (v: unknown, a: Arg): string =>
  Array.isArray(v) ? `[${v.map((x) => literal(x, a)).join(", ")}]` : a.type === "enum" ? String(v) : a.type === "json" && typeof v !== "string" ? JSON.stringify(JSON.stringify(v)) : a.type === "object" ? objectLiteral(v) : JSON.stringify(v);
const objectLiteral = (v: unknown): string =>
  Array.isArray(v) ? `[${v.map(objectLiteral).join(", ")}]` : v && typeof v === "object" ? `{${Object.entries(v).map(([k, x]) => `${k}: ${objectLiteral(x)}`).join(", ")}}` : JSON.stringify(v);

const zodOf = (a: Arg) => {
  let t: z.ZodType =
    a.type === "id" ? z.coerce.string() : a.type === "int" ? z.number().int() : a.type === "number" ? z.number() : a.type === "boolean" ? z.boolean() : a.type === "string" ? z.string()
    : a.type === "enum" ? z.enum(a.values as [string, ...string[]]) : a.type === "object" ? z.record(z.string(), z.any()) : z.any();
  for (let i = 0; i < (a.list ?? 0); i++) t = z.array(t);
  t = t.describe(a.description);
  return a.required ? t : t.optional();
};

const FIELDS = "Which fields to get back, in GraphQL, instead of the usual ones: like \"id name column_values { id text }\". Leave out for the usual.";

function action(s: Spec): OwnAction {
  return {
    description: `${s.description} Returns ${s.returns}.`,
    readOnly: s.readOnly,
    // built on first use, as specActions does: hundreds of zod schemas up front cost memory for nothing
    get input() {
      const shape = Object.fromEntries(s.args.map((a) => [a.name, zodOf(a)]));
      const input = z.object(s.select ? { ...shape, fields: z.string().optional().describe(FIELDS) } : shape);
      Object.defineProperty(this, "input", { value: input });
      return input;
    },
    async run(i: Record<string, unknown>, key: string) {
      const given = s.args.filter((a) => i[a.name] !== undefined);
      // monday's JSON arguments (column_values…) take a JSON string; an agent naturally gives the object
      const value = (a: Arg) => (a.type === "json" && typeof i[a.name] !== "string" && !a.list ? JSON.stringify(i[a.name]) : i[a.name]);
      const upload = given.some((a) => a.type === "file");
      const vars = upload ? given.filter((a) => a.type === "file") : given;
      const args = given.map((a) => `${a.name}: ${upload && a.type !== "file" ? literal(i[a.name], a) : `$${a.name}`}`).join(", ");
      const field = s.field ?? s.name;
      const select = (i.fields as string | undefined)?.trim() || s.select;
      let body = `${field}${args ? `(${args})` : ""}${select ? ` { ${select} }` : ""}`;
      if (s.parent) body = `${s.parent} { ${body} }`;
      const decl = vars.map((a) => `$${a.name}: ${a.gql}`).join(", ");
      const data = await graphql(key, `${s.kind}${decl ? `(${decl})` : ""} { ${body} }`, Object.fromEntries(vars.map((a) => [a.name, value(a)])));
      const top = data[s.parent ?? s.name];
      return s.parent ? (top as Record<string, unknown> | null)?.[field] : top;
    },
  };
}

const generated: Record<string, OwnAction> = Object.fromEntries(spec.actions.map((s) => [s.name, action(s)]));

// One part of one board, item, doc or team (its columns, its subitems…): what the generated actions only reach through `fields`.
type Sub = { gql: string; schema: z.ZodType };
function part(description: string, root: string, id: [name: string, about: string], field: string, select: string, args: Record<string, Sub> = {}): OwnAction {
  return {
    description,
    readOnly: true,
    input: z.object({ [id[0]]: z.coerce.string().describe(id[1]), ...Object.fromEntries(Object.entries(args).map(([k, s]) => [k, s.schema])), fields: z.string().optional().describe(FIELDS) }),
    async run(i: Record<string, unknown>, key: string) {
      const given = Object.keys(args).filter((k) => i[k] !== undefined);
      const decl = ["$id: ID!", ...given.map((k) => `$${k}: ${args[k]!.gql}`)].join(", ");
      const call = given.length ? `${field}(${given.map((k) => `${k}: $${k}`).join(", ")})` : field;
      const query = `query(${decl}) { ${root}(ids: [$id]) { ${call} { ${(i.fields as string | undefined)?.trim() || select} } } }`;
      const data = await graphql(key, query, { id: i[id[0]], ...Object.fromEntries(given.map((k) => [k, i[k]])) });
      const found = (data[root] as Record<string, unknown>[] | null)?.[0];
      if (!found) throw new AppsError(`monday.com has no ${root.replace(/s$/, "")} ${i[id[0]]} that this account can see`);
      return found[field];
    },
  };
}
const ITEM = spec.actions.find((a) => a.name === "items")!.select;
const BOARD_ID: [string, string] = ["board_id", "The board's id: the long number in its link (the boards action lists them)"];
const hand: Record<string, OwnAction> = {
  list_board_items: part(
    "The items on a monday.com board with their column values, up to 500 at a time. Returns a cursor while there are more: pass it to next_items_page for the rest.",
    "boards",
    BOARD_ID,
    "items_page",
    `cursor items { ${ITEM} }`,
    {
      limit: { gql: "Int!", schema: z.number().int().min(1).max(500).default(100).describe("How many items, up to 500 (default 100)") },
      query_params: {
        gql: "ItemsQuery",
        schema: z
          .record(z.string(), z.any())
          .optional()
          .describe('Only some items, as monday\'s ItemsQuery: {"rules": [{"column_id": "status", "compare_value": [1]}], "operator": "and", "order_by": [{"column_id": "date4", "direction": "desc"}]}'),
      },
    },
  ),
  list_columns: part("The columns of a monday.com board: id, title, type and settings (a status column's labels).", "boards", BOARD_ID, "columns", "id title type description archived width settings_str"),
  list_groups: part("The groups of a monday.com board: id, title, colour and position.", "boards", BOARD_ID, "groups", "id title color position archived deleted"),
  get_board_views: part("The views of a monday.com board (table, kanban, calendar…) and their settings.", "boards", BOARD_ID, "views", "id name type settings_str view_specific_data_str"),
  get_activity_logs: part("The activity log of a monday.com board: who changed what, when, newest first.", "boards", BOARD_ID, "activity_logs", "id event entity data created_at user_id", {
    limit: { gql: "Int", schema: z.number().int().optional().describe("How many entries (default 25)") },
    page: { gql: "Int", schema: z.number().int().optional().describe("Which page, from 1") },
    from: { gql: "ISO8601DateTime", schema: z.string().optional().describe("From this time, like 2026-11-01T00:00:00Z") },
    to: { gql: "ISO8601DateTime", schema: z.string().optional().describe("Up to this time") },
    item_ids: { gql: "[ID!]", schema: z.array(z.coerce.string()).optional().describe("Only these items") },
    user_ids: { gql: "[ID!]", schema: z.array(z.coerce.string()).optional().describe("Only what these people did") },
  }),
  list_subitems_by_parent: part("The subitems under one monday.com item, with their column values.", "items", ["item_id", "The parent item's id"], "subitems", ITEM),
  list_team_members: part("The people in a monday.com team.", "teams", ["team_id", "The team's id (the teams action lists them)"], "users", "id name email title kind status"),
  blocks: part("The content blocks of a monday.com doc, in order: text, headings, lists, tables…", "docs", ["doc_id", "The doc's id (the docs action lists them)"], "blocks", "id type content parent_block_id position created_at updated_at", {
    limit: { gql: "Int", schema: z.number().int().optional().describe("How many blocks (default 25)") },
    page: { gql: "Int", schema: z.number().int().optional().describe("Which page, from 1") },
  }),
};
// Composio's names for the same calls, so saved automations and skills carry over
const ALIASES: Record<string, string> = {
  add_subscribers_to_board: "add_users_to_board",
  aggregate_data: "aggregate",
  create_tag: "create_or_get_tag",
  create_user: "invite_users",
  get_account_info: "account",
  get_api_version: "version",
  get_assets: "assets",
  get_favorites: "favorites",
  get_folders: "folders",
  get_form: "form",
  get_items: "items",
  get_me: "me",
  who_am_i: "me",
  get_query_complexity: "complexity",
  get_mutation_complexity: "complexity",
  get_tags: "tags",
  get_teams: "teams",
  get_update_replies: "replies",
  get_updates: "updates",
  get_versions: "versions",
  get_webhooks: "webhooks",
  get_workspaces: "workspaces",
  list_boards: "boards",
  list_users: "users",
  list_items_by_column_values: "items_page_by_column_values",
  query_sprints: "sprints",
  remove_users_from_workspace: "delete_users_from_workspace",
  update_item: "change_multiple_column_values",
  upload_asset: "add_file_to_column",
  items_page: "list_board_items",
  list_items: "list_board_items",
  columns: "list_columns",
};
const own = { ...generated, ...hand };
const aliases = Object.fromEntries(Object.entries(ALIASES).map(([alias, real]) => [alias, own[real]!]));
const ME = "id name email account { id name slug }";

export const monday: OwnApp = {
  app: "monday",
  name: "monday.com",
  logo: "/logos/monday.svg",
  keyField: {
    label: "API token",
    help: `${HELP}. Emplio can then do whatever your monday.com account can, on every board you can see.`,
    placeholder: "eyJhbGciOiJIUzI1NiJ9...",
  },
  async check(key) {
    const { me } = (await graphql(key, `query { me { ${ME} } }`)) as { me: { id: string; name?: string; email?: string; account?: { name?: string } } };
    return [me.name || me.email || me.id, me.account?.name].filter(Boolean).join(", ");
  },
  push: {
    events,
    triggers,
    start: (key, connection, event, config) => watch(graphql, key, connection, event, config),
    stop: (key, id) => unwatch(graphql, key, id),
    receive: (delivery) => receive(delivery),
    wanted,
  },
  actions: {
    ...own,
    ...aliases,
    graphql: {
      description:
        "Send any query or mutation to monday.com's GraphQL API (api.monday.com/v2), for what the other monday actions don't shape the way you need. Returns its data.",
      input: z.object({
        query: z.string().min(1).describe("The GraphQL document, like: query { boards(limit: 5) { id name } }"),
        variables: z.record(z.string(), z.any()).optional().describe("Values for the $variables the query declares"),
      }),
      run: (i: { query: string; variables?: Record<string, unknown> }, key: string) => graphql(key, i.query, i.variables),
    },
    download_asset: {
      description: "Download a file uploaded to monday.com (a file column or an update's attachment) by its asset id, into the chat's computer.",
      readOnly: true,
      input: z.object({ asset_id: z.coerce.string().describe("The file's asset id: from the assets action, an item's file column value, or an update's assets") }),
      async run(i: { asset_id: string }, key: string) {
        const { assets } = (await graphql(key, "query($ids: [ID!]!) { assets(ids: $ids) { id name public_url } }", { ids: [i.asset_id] })) as { assets: { name: string; public_url: string }[] };
        const a = assets?.[0];
        if (!a?.public_url) throw new AppsError(`monday.com has no file ${i.asset_id} that this account can see`);
        const res = await fetch(a.public_url);
        if (!res.ok) throw new AppsError(`monday.com: the file didn't download (${res.status})`);
        return new AppFile(a.name, (res.headers.get("content-type") ?? "application/octet-stream").split(";")[0]!, new Uint8Array(await res.arrayBuffer()));
      },
    },
  },
};
