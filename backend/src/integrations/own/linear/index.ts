// Linear on a personal API key: every query and mutation of Linear's GraphQL API as an action. actions.json is generated
// by `bun scripts/openapi/linear.ts` from Linear's schema; two raw GraphQL actions reach anything else. Issues, comments,
// projects and the rest start automations by webhook (triggers.ts), or by polling without admin rights (polls/linear.ts).
import { z } from "zod";
import { AppFile, AppsError } from "../../types";
import type { OwnAction, OwnApp } from "../index";
import { gql, KEY_HELP } from "./api";
import { events, receive, triggers, unwatch, wanted, watch } from "./triggers";

// one field's answer; a partial answer keeps Linear's complaints alongside
async function field(key: string, query: string, variables: Record<string, unknown>, name: string) {
  const { data, errors } = await gql(key, query, variables);
  const out = data[name];
  if (errors.length && out == null) throw new AppsError(`Linear: ${errors.join("; ")}`);
  return errors.length && out && typeof out === "object" && !Array.isArray(out) ? { ...out, errors } : out;
}

// a selection someone wrote must stay inside its field: no closing it to start another operation
const balanced = (s: string) => {
  let depth = 0;
  for (const c of s.replace(/"(?:\\.|[^"\\])*"/g, "")) if ((depth += c === "{" ? 1 : c === "}" ? -1 : 0) < 0) return false;
  return depth === 0;
};

type Generated = { name: string; field: string; kind: "query" | "mutation"; description: string; readOnly: boolean; input: object; lift?: string[]; liftType?: string; vars: string; args: string; select: string };
const spec = (await Bun.file(new URL("./actions.json", import.meta.url)).json()) as { actions: Generated[] };

const generated: Record<string, OwnAction> = Object.fromEntries(
  spec.actions.map((a) => [
    a.name,
    {
      description: a.description,
      readOnly: a.readOnly,
      // built on first use: hundreds of zod schemas up front cost memory
      get input() {
        const input = z.fromJSONSchema(a.input as z.core.JSONSchema.JSONSchema) as z.ZodObject;
        Object.defineProperty(this, "input", { value: input });
        return input;
      },
      run: (i: Record<string, unknown>, key: string) => {
        const { select, ...rest } = i as { select?: string } & Record<string, unknown>;
        if (select !== undefined && (typeof select !== "string" || !select.trim() || !balanced(select))) throw new AppsError("select: give fields like \"id title state { name }\", with every { closed");
        let vars: Record<string, unknown> = rest;
        // the input object's fields were offered on their own; they go back inside it here
        if (a.lift) {
          const input: Record<string, unknown> = {};
          vars = {};
          for (const [k, v] of Object.entries(rest)) (a.lift.includes(k) ? input : vars)[k] = v;
          vars.input = input;
        }
        const call = `${a.field}${a.args ? `(${a.args})` : ""}${a.select ? ` { ${select ?? a.select} }` : ""}`;
        return field(key, `${a.kind} ${a.name}${a.vars ? `(${a.vars})` : ""} { ${call} }`, vars, a.field);
      },
    },
  ]),
);

const raw = (description: string, readOnly: boolean): OwnAction => ({
  description,
  readOnly,
  input: z.object({
    query: z.string().describe("A whole GraphQL document, e.g. query { issue(id: \"ENG-12\") { title comments { nodes { body } } } }"),
    variables: z.record(z.string(), z.any()).optional().describe("Values for the document's $variables"),
  }),
  run: async (i: { query: string; variables?: Record<string, unknown> }, key: string) => {
    if (readOnly && /\b(mutation|subscription)\b/.test(i.query)) throw new AppsError("this one only reads; use run_query_or_mutation to change things");
    const { data, errors } = await gql(key, i.query, i.variables);
    return errors.length ? { data, errors } : data;
  },
});

const extras: Record<string, OwnAction> = {
  run_graphql_query: raw("Run any read-only GraphQL query against Linear's API (api.linear.app/graphql), for nested reads no single action gives, like an issue with its comments and sub-issues in one go.", true),
  run_query_or_mutation: raw("Run any GraphQL query or mutation against Linear's API. For anything the other actions don't cover; prefer them when they do.", false),
  upload_file: {
    description: "Upload a file from the computer to Linear. Answers its assetUrl: put it in an issue or comment's Markdown (![name](assetUrl)) or attach it with attachment_create.",
    input: z.object({ file: z.any().describe('The file: {"file": "/work/..."}') }),
    run: async (i: { file: unknown }, key: string) => {
      const file = i.file;
      if (!(file instanceof AppFile)) throw new AppsError('file: give the file as {"file": "/work/..."}');
      const got = (await field(
        key,
        "mutation upload($contentType: String!, $filename: String!, $size: Int!) { fileUpload(contentType: $contentType, filename: $filename, size: $size) { uploadFile { uploadUrl assetUrl headers { key value } } } }",
        { contentType: file.mimetype, filename: file.name, size: file.bytes.length },
        "fileUpload",
      )) as { uploadFile: { uploadUrl: string; assetUrl: string; headers: { key: string; value: string }[] } };
      const up = got.uploadFile;
      const headers = { "Content-Type": file.mimetype, "Cache-Control": "public, max-age=31536000", ...Object.fromEntries(up.headers.map((h) => [h.key, h.value])) };
      const put = await fetch(up.uploadUrl, { method: "PUT", headers, body: file.bytes as Uint8Array<ArrayBuffer> });
      if (!put.ok) throw new AppsError(`Linear didn't take the file (${put.status})`);
      return { assetUrl: up.assetUrl, name: file.name };
    },
  },
  download_file: {
    description: "Download a file uploaded to Linear (an uploads.linear.app link from an issue, comment or attachment) to the computer.",
    readOnly: true,
    input: z.object({ url: z.string().describe("The file's link, starting https://uploads.linear.app/") }),
    run: async (i: { url: string }, key: string) => {
      // the key goes only to Linear's own file host
      if (!/^https:\/\/uploads\.linear\.app\//.test(i.url)) throw new AppsError("url: only uploads.linear.app links can be downloaded with the Linear key");
      const res = await fetch(i.url, { headers: { Authorization: key }, signal: AbortSignal.timeout(60_000) });
      if (!res.ok) throw new AppsError(`Linear: couldn't download the file (${res.status})`);
      const name = decodeURIComponent(new URL(i.url).pathname.split("/").pop() || "download");
      return new AppFile(name, res.headers.get("content-type")?.split(";")[0] || "application/octet-stream", new Uint8Array(await res.arrayBuffer()));
    },
  },
};

// Composio's names for the same calls, so skills and automations written for them keep working
const ALIASES: Record<string, string> = {
  archive_issue: "issue_archive",
  archive_project: "project_delete",
  archive_project_update: "project_update_archive",
  create_attachment: "attachment_create",
  create_comment_reaction: "reaction_create",
  create_linear_comment: "comment_create",
  create_linear_issue: "issue_create",
  create_linear_issue_relation: "issue_relation_create",
  create_linear_label: "issue_label_create",
  create_linear_project: "project_create",
  create_project_milestone: "project_milestone_create",
  create_project_update: "project_update_create",
  create_team: "team_create",
  delete_linear_issue: "issue_delete",
  get_all_linear_teams: "list_teams",
  get_current_user: "get_viewer",
  get_cycles_by_team_id: "list_cycles",
  get_issue_defaults: "get_team",
  get_linear_issue: "get_issue",
  get_linear_project: "get_project",
  list_issues_by_team_id: "list_issues",
  list_linear_cycles: "list_cycles",
  list_linear_issues: "list_issues",
  list_linear_labels: "list_issue_labels",
  list_linear_projects: "list_projects",
  list_linear_states: "list_workflow_states",
  list_linear_teams: "list_teams",
  list_linear_users: "list_users",
  remove_issue_label: "issue_remove_label",
  remove_reaction: "reaction_delete",
  resolve_comment: "comment_resolve",
  search_issues: "list_search_issues",
  unarchive_project_update: "project_update_unarchive",
  unresolve_comment: "comment_unresolve",
  update_issue: "issue_update",
  update_linear_comment: "comment_update",
  update_linear_project: "project_update",
  update_project_update: "project_update_update",
  update_team: "team_update",
  validate_credential: "get_viewer",
  who_am_i: "get_viewer",
};

export const actions: Record<string, OwnAction> = { ...generated, ...extras };
for (const [alias, to] of Object.entries(ALIASES)) actions[alias] = actions[to]!;

export const linear: OwnApp = {
  app: "linear",
  name: "Linear",
  logo: "/logos/linear.svg",
  keyField: {
    label: "Personal API key",
    help: "linear.app/settings/account/security → Personal API keys → New API key, name it Emplio and keep Full access. For automations that start the moment something happens in Linear, the key must belong to a Linear admin.",
    placeholder: "lin_api_...",
  },
  async check(key) {
    const { data } = await gql(key, "query { viewer { name email organization { name } } }");
    const me = data.viewer as { name?: string; email?: string; organization?: { name?: string } } | null;
    if (!me) throw new AppsError(`Linear didn't accept the key; make a new one (${KEY_HELP})`);
    const who = me.name || me.email || "";
    return me.organization?.name ? `${who} (${me.organization.name})` : who;
  },
  push: {
    events,
    triggers,
    start: (key, connection, event, config) => watch(key, connection, event, config),
    stop: (key, id) => unwatch(key, id),
    receive: (delivery) => receive(delivery),
    wanted,
  },
  actions,
};
