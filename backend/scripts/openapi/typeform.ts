// Typeform: what the generator (../openapi-actions.ts) can't tell from the docs. Typeform publishes no OpenAPI spec,
// but every page of its API reference (typeform.com/developers/.../reference/...) carries its operation: the method,
// path and request body as JSON in the page's data, and the parameters in the page itself. This reads them all into one
// spec and hands that to the generator.
import { tmpdir } from "node:os";
import type { AppConfig } from "../openapi-actions";

type Schema = Record<string, any>;
const DOCS = "https://www.typeform.com/developers";

// Composio's names where it has the call, so skills and automations written for it carry over
const NAMES: Record<string, string> = {
  "GET /me": "get_about_me",
  "GET /forms": "list_forms",
  "POST /forms": "create_form",
  "GET /forms/{form_id}": "get_form",
  "PUT /forms/{form_id}": "update_form",
  "PATCH /forms/{form_id}": "patch_form",
  "DELETE /forms/{form_id}": "delete_form",
  "GET /forms/{form_id}/messages": "get_form_messages",
  "PUT /forms/{form_id}/messages": "update_form_messages",
  "GET /forms/{form_id}/translations/main": "get_translation_payload",
  "GET /forms/{form_id}/translations/status": "get_translation_statuses",
  "GET /forms/{form_id}/translations/{language}": "get_form_translation",
  "PUT /forms/{form_id}/translations/{language}": "update_form_translation",
  "DELETE /forms/{form_id}/translations/{language}": "delete_form_translation",
  "POST /forms/{form_id}/translations/{language}/auto": "auto_translate_form",
  "GET /forms/{form_id}/responses": "get_form_responses",
  "DELETE /forms/{form_id}/responses": "delete_responses",
  "POST /forms/{form_id}/responses/search": "search_responses",
  "GET /forms/{form_id}/responses/files": "get_all_response_files",
  "GET /forms/{form_id}/responses/{response_id}/fields/{field_id}/files/{filename}": "get_response_file",
  "GET /forms/{form_id}/webhooks": "list_webhooks",
  "GET /forms/{form_id}/webhooks/{tag}": "get_webhook",
  "PUT /forms/{form_id}/webhooks/{tag}": "create_or_update_webhook",
  "DELETE /forms/{form_id}/webhooks/{tag}": "delete_webhook",
  "GET /insights/{form_id}/summary": "get_form_insights",
  "GET /images": "list_images",
  "POST /images": "create_image",
  "GET /images/{image_id}": "get_image",
  "DELETE /images/{image_id}": "delete_image",
  "GET /images/{image_id}/image/{size}": "get_image_by_size",
  "GET /images/{image_id}/background/{size}": "get_background_by_size",
  "GET /images/{image_id}/choice/{size}": "get_choice_image_by_size",
  "POST /media/videos": "create_video_upload",
  "POST /media/videos/list": "batch_fetch_videos",
  "GET /media/videos/{id}/master": "get_video_master_file",
  "POST /media/videos/{id}/master": "request_video_master_file",
  "GET /media/audios/{id}/master": "get_audio_master_file",
  "POST /media/audios/{id}/master": "request_audio_master_file",
  "GET /themes": "list_themes",
  "POST /themes": "create_theme",
  "GET /themes/{theme_id}": "get_theme",
  "PUT /themes/{theme_id}": "update_theme",
  "PATCH /themes/{theme_id}": "patch_theme",
  "DELETE /themes/{theme_id}": "delete_theme",
  "GET /workspaces": "list_workspaces",
  "POST /workspaces": "create_workspace",
  "GET /workspaces/{workspace_id}": "get_workspace",
  "PATCH /workspaces/{workspace_id}": "update_workspace",
  "DELETE /workspaces/{workspace_id}": "delete_workspace",
  "GET /accounts/{account_id}/workspaces": "list_account_workspaces",
  "POST /accounts/{account_id}/workspaces": "create_account_workspace",
};

// in the docs' navigation but not on a reference page of its own
const EXTRA: Schema = {
  "/me": { get: { summary: "Get the connected Typeform account", description: "Who the token belongs to: alias, email, language and account id.", parameters: [] } },
  // in Typeform's own JS client (insights.summary), not in the reference
  "/insights/{form_id}/summary": {
    get: {
      summary: "Get form insights",
      description: "A form's summary statistics: views, starts, submissions, completion rate and average time, overall and per question.",
      parameters: [{ name: "form_id", in: "path", required: true, schema: { type: "string" }, description: "The form's id, as in its link (https://mysite.typeform.com/to/u6nXL7 → u6nXL7)" }],
    },
  },
};

const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, "")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
const IN: Record<string, string> = { "Path Parameters": "path", "Query Parameters": "query", Headers: "header" };
const TYPES = new Set(["string", "integer", "number", "boolean", "array", "object"]);

// the "Request" part of a reference page: parameter tables under Path / Query Parameters and Headers
function params(html: string) {
  const start = html.indexOf(">Request</h2>");
  if (start < 0) return [];
  const end = html.indexOf("<h2", start);
  const out: Schema[] = [];
  for (const part of html.slice(start, end < 0 ? undefined : end).split("<h4").slice(1)) {
    const where = IN[text(part.slice(part.indexOf(">") + 1, part.indexOf("</h4>")))];
    if (!where) continue;
    const rows = part.matchAll(/<span level="0" class="[^"]*ParameterName[^"]*">([^<]+)<\/span><div class="[^"]*ParameterValue[^"]*"><div>(.*?)<\/div>(?:<div class="[^"]*ParameterDetails[^"]*">(.*?)<\/div>)?/g);
    for (const [, name, kind = "", details = ""] of rows) {
      if (out.some((p) => p.name === name && p.in === where)) continue;
      const type = text(kind).split(",")[0]!.trim().split(" ")[0]!;
      const description = text(details);
      const values = /Valid values: (.+?) (?:Default|$)/.exec(description)?.[1]?.split(" ");
      out.push({
        name,
        in: where,
        required: where === "path" || /required/.test(kind),
        description,
        schema: { type: TYPES.has(type) ? type : "string", ...(values && { enum: values }) },
      });
    }
  }
  return out;
}

async function build() {
  const sitemap = await (await fetch(`${DOCS}/sitemap-0.xml`)).text();
  const pages = [...sitemap.matchAll(/<loc>([^<]+\/reference\/[^<]+)<\/loc>/g)].map((m) => m[1]!);
  const paths: Schema = structuredClone(EXTRA);
  // ponytail: one page at a time is gentle on their site (about 50 pages); parallel if it ever matters
  for (const page of pages) {
    const data = await (await fetch(page.replace(`${DOCS}/`, `${DOCS}/page-data/`) + "page-data.json")).json();
    const c = data.result.data.content;
    const html = await (await fetch(page)).text();
    const op: Schema = { summary: c.title, description: c.operation.description ?? "", parameters: params(html) };
    // every {name} in the path is a parameter, even where the page forgot it
    for (const [, name] of (c.path as string).matchAll(/\{(\w+)\}/g))
      if (!op.parameters.some((p: Schema) => p.name === name && p.in === "path")) op.parameters.push({ name, in: "path", required: true, schema: { type: "string" } });
    op.parameters = op.parameters.filter((p: Schema) => p.in !== "path" || c.path.includes(`{${p.name}}`));
    if (c.operation.body) {
      const body = JSON.parse(c.operation.body);
      delete body.example;
      // JSON Patch bodies (forms, themes, workspaces) say type array and repeat the item's properties beside it
      if (body.type === "array") delete body.properties;
      op.requestBody = { required: true, content: { "application/json": { schema: body } } };
    }
    (paths[c.path] ??= {})[c.method] = op;
  }
  for (const [path, ops] of Object.entries<Schema>(paths))
    for (const [method, op] of Object.entries<Schema>(ops)) {
      const call = `${method.toUpperCase()} ${path}`;
      if (!NAMES[call]) throw new Error(`Typeform has a new call, ${call}: give it a name in NAMES`);
      op.operationId = NAMES[call];
    }
  // Typeform takes the ids to delete in the query or the body; the query alone is enough
  delete paths["/forms/{form_id}/responses"].delete.requestBody;
  return { openapi: "3.0.0", info: { title: "Typeform", version: "1" }, servers: [{ url: "https://api.typeform.com" }], paths };
}

const SPEC = `${tmpdir()}/typeform-openapi.json`;
await Bun.write(SPEC, JSON.stringify(await build()));

export default {
  spec: SPEC,
  out: "src/integrations/own/typeform/actions.json",
  // POSTs that only look things up
  reads: ["search_responses", "batch_fetch_videos"],
  // a webhook's details include its signing secret
  secrets: ["list_webhooks", "get_webhook"],
  params: {
    form_id: "The form's id, as in its link (https://mysite.typeform.com/to/u6nXL7 → u6nXL7); list_forms lists them",
    workspace_id: "The workspace's id; list_workspaces lists them",
    theme_id: "The theme's id; list_themes lists them",
    image_id: "The image's id; list_images lists them",
    account_id: "The account's id; get_about_me gives it (account_id)",
  },
} satisfies AppConfig;
