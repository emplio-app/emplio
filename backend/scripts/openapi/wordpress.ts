// WordPress: what the generator (../openapi-actions.ts) can't tell from the spec.
//
// WordPress has no OpenAPI spec, but every site describes its own REST API at /wp-json/ (each route, its methods
// and their arguments). Running this file turns that index into an OpenAPI document the generator reads:
//
//   bun scripts/openapi/wordpress.ts http://127.0.0.1:9400/wp-json/   # a fresh install (npx @wp-playground/cli server)
//   bun scripts/openapi-actions.ts wordpress
//
// Use a standard install with no plugins, so the actions are what every WordPress site has.
import { tmpdir } from "node:os";
import type { AppConfig } from "../openapi-actions";

const SPEC = `${tmpdir()}/wordpress-openapi.json`;

type Arg = Record<string, any>;
type Endpoint = { methods: string[]; args: Record<string, Arg> };

// "categories" → "category", "statuses" → "status", "media" stays
const singular = (w: string) =>
  /(ss|us)es$/.test(w) ? w.slice(0, -2) : /ies$/.test(w) ? `${w.slice(0, -3)}y` : /(ss|media|settings|status|export|lookup|search|me|navigation|config|fallback)$/.test(w) ? w : w.replace(/s$/, "");
const snake = (s: string) => s.replace(/[^a-zA-Z0-9]+/g, "_").replace(/^_|_$/g, "").toLowerCase();
// the namespace's prefix on an action's name: none for core content (wp/v2)
const PREFIX: Record<string, string> = { "wp/v2": "", "oembed/1.0": "oembed", "wp-site-health/v1": "site_health", "wp-block-editor/v1": "block_editor", "wp-abilities/v1": "ability", "batch/v1": "batch" };

// "(?P<id>[\d]+)" → "{id}", noting which params are numbers
const PARAM = /\(\?P<(\w+)>((?:[^()]|\((?:[^()]|\([^()]*\))*\))*)\)/g;
const toPath = (route: string) => route.replace(PARAM, "{$1}");
const numeric = (route: string) => new Set([...route.matchAll(PARAM)].filter((m) => m[2] === "[\\d]+").map((m) => m[1]!));

// title, content, excerpt, caption...: WordPress takes a plain string as well as {"raw": "..."}; a string is simpler
function arg(a: Arg): Arg {
  const { required: _r, context: _c, arg_options: _o, title: _t, readonly: _ro, default: dflt, ...rest } = a;
  // WordPress fills in its own defaults; sending them would overwrite on an update, so they're only said
  const said = dflt === undefined || (Array.isArray(dflt) && !dflt.length) ? "" : ` (default ${JSON.stringify(dflt)})`;
  if (said && rest.description) rest.description = `${rest.description}${said}`;
  if (rest.type === "object" && rest.properties?.raw) return { type: "string", description: `${rest.description ?? ""} Plain text or HTML.`.trim() };
  // PHP sends a list with gaps as an object
  if (rest.enum && !Array.isArray(rest.enum)) rest.enum = Object.values(rest.enum);
  if (rest.properties) rest.properties = Object.fromEntries(Object.entries(rest.properties as Record<string, Arg>).filter(([, p]) => !p.readonly).map(([k, p]) => [k, arg(p)]));
  if (rest.items && typeof rest.items === "object") rest.items = arg(rest.items);
  return rest;
}

// GET /wp/v2/posts → list_posts, POST /wp/v2/posts/{id} → update_post, GET /wp/v2/posts/{parent}/revisions → list_post_revisions
function name(path: string, method: string) {
  const ns = Object.keys(PREFIX).find((n) => path.startsWith(`/${n}`)) ?? "";
  const words = path.slice(ns.length + 1).split("/").filter((s) => s && !s.startsWith("{")).map(snake);
  const isItem = /\}$/.test(path) || /\/me$/.test(path);
  const noun = [PREFIX[ns], ...words].filter(Boolean);
  const last = noun.pop() ?? "index";
  const one = [...noun.map(singular), singular(last)].join("_");
  const many = [...noun.map(singular), last].join("_");
  if (method === "GET") return isItem ? `get_${one}` : `list_${many}`;
  if (method === "DELETE") return isItem ? `delete_${one}` : `delete_all_${many}`;
  return isItem ? `update_${one}` : `create_${one}`;
}

// where the pattern gives a poor or repeated name
const NAMES: Record<string, string> = {
  "GET /": "get_api_index",
  "GET /wp/v2/block-types/{namespace}": "list_namespace_block_types",
  "GET /wp/v2/icons/{collection}": "list_collection_icons",
  "GET /wp-abilities/v1/abilities": "list_abilities",
  "GET /wp-abilities/v1/abilities/{name}": "get_ability",
  "POST /wp-abilities/v1/abilities/{name}/run": "run_ability",
  "GET /wp/v2/search": "search_content",
  "GET /wp/v2/settings": "get_site_settings",
  "POST /wp/v2/settings": "update_site_settings",
  "GET /wp/v2/templates/lookup": "lookup_template",
  "GET /wp/v2/template-parts/lookup": "lookup_template_part",
  "GET /wp/v2/users/me": "get_current_user",
  "POST /wp/v2/users/me": "update_current_user",
  "DELETE /wp/v2/users/me": "delete_current_user",
  "POST /wp/v2/media/{id}/post-process": "post_process_media",
  "POST /wp/v2/media/{id}/edit": "edit_media_image",
  "POST /wp/v2/widget-types/{id}/encode": "encode_widget_form",
  "POST /wp/v2/widget-types/{id}/render": "render_widget_preview",
  "POST /batch/v1": "batch_requests",
  "GET /wp/v2/block-renderer/{name}": "render_block",
  "GET /oembed/1.0/embed": "get_oembed",
  "GET /oembed/1.0/proxy": "get_oembed_proxy",
  "GET /wp-block-editor/v1/url-details": "get_url_details",
  "GET /wp-block-editor/v1/export": "export_theme",
  "GET /wp-block-editor/v1/navigation-fallback": "get_navigation_fallback",
  "GET /wp/v2/view-config": "get_view_config",
  "GET /wp-site-health/v1/directory-sizes": "get_site_health_directory_sizes",
  "GET /wp/v2/block-directory/search": "search_block_directory",
  "GET /wp/v2/pattern-directory/patterns": "search_pattern_directory",
  "GET /wp/v2/block-patterns/patterns": "list_block_patterns",
  "GET /wp/v2/users/{user_id}/application-passwords/introspect": "get_current_application_password",
  ...Object.fromEntries(
    ["background-updates", "loopback-requests", "https-status", "dotorg-communication", "authorization-header", "page-cache"].map((t) => [
      `GET /wp-site-health/v1/tests/${t}`,
      `run_site_health_test_${snake(t)}`,
    ]),
  ),
};

// what an agent needs to know beyond the route, by action
const NOTES: Record<string, string> = {
  get_api_index: "Every route this site's REST API has, with its arguments, including the ones plugins add (WooCommerce, Yoast, Jetpack...). Call those with call_api_get or call_api.",
  batch_requests: "Run up to 25 write requests in one go. requests: [{\"method\": \"POST\", \"path\": \"/wp/v2/posts/1\", \"body\": {...}}].",
  create_post: "A new blog post. status: draft (the default), publish, future (with date), pending or private. content is HTML or block markup; categories and tags are lists of their ids (list_categories, list_tags).",
  update_post: "Change any field of a post: title, content, status (publish it), categories, tags, featured_media...",
  delete_post: "Moves the post to the trash; force: true deletes it for good.",
  create_page: "A new page of the website. status: draft (the default) or publish. parent: the page it sits under.",
  update_page: "Change any field of a page: title, content, status, parent, menu_order...",
  delete_page: "Moves the page to the trash; force: true deletes it for good.",
  create_media: "Upload an image, video, audio or document to the media library. The answer's id is what featured_media takes; source_url is its address.",
  delete_media: "Media has no trash: force must be true, and it is deleted for good.",
  list_comments: "Approved comments by default; status: hold for the ones waiting for moderation, spam or trash for those.",
  update_comment: "Approve (status: approved), hold, spam or trash a comment, or edit its content.",
  create_comment: "Post a comment, or reply to one with parent. As the connected user.",
  delete_comment: "Moves the comment to the trash; force: true deletes it for good.",
  delete_user: "Deletes a user; reassign: the user id who gets their posts, and force must be true.",
  search_content: "Search posts, pages and other content of the site by words, across types.",
  get_site_settings: "The site's title, tagline, address, admin email, timezone, date format, language, front page and posts per page.",
  update_site_settings: "Change the site's title, tagline, admin email, timezone, date and time formats, language, front page (show_on_front, page_on_front, page_for_posts)...",
  list_plugins: "Installed plugins and whether each is active. plugin ids look like akismet/akismet.",
  create_plugin: "Install a plugin from the WordPress.org directory by its slug (the last part of its wordpress.org/plugins/ address); status: active to switch it on too.",
  update_plugin: "Switch a plugin on (status: active) or off (inactive). plugin: its id, like akismet/akismet.",
  delete_plugin: "Uninstall a plugin. It must be switched off first.",
  list_themes: "Installed themes; status: active for the one in use.",
  list_menus: "The site's classic menus. Block themes keep their menus as navigation (list_navigation).",
  create_menu_item: "Add a link to a classic menu: menus (the menu id), title, and type custom with url, or type post_type with object (page, post) and object_id.",
  list_navigation: "Block themes' menus (the Navigation block), each a post of block markup.",
  run_ability: "Run an ability a plugin registered (list_abilities). input: what the ability takes.",
  export_theme: "Download the active block theme, with the site's template changes, as a zip file.",
  create_user_application_password: "Makes a new application password, for signing another tool in to the site.",
  delete_all_user_application_passwords: "Deletes every application password of the user, including the one Emplio connects with, which disconnects Emplio.",
  delete_user_application_password: "Deletes one application password. If it is the one Emplio connects with, Emplio is disconnected.",
};

export function toOpenApi(index: { routes: Record<string, { namespace: string; endpoints: Endpoint[] }> }) {
  const paths: Record<string, any> = {};
  for (const [route, r] of Object.entries(index.routes)) {
    // a namespace's own index repeats the root index for that namespace
    if (r.namespace && route === `/${r.namespace}`) continue;
    const path = toPath(route);
    const numbers = numeric(route);
    const inPath = [...path.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!);
    for (const e of r.endpoints) {
      // PUT and PATCH are the same as POST. An endpoint taking GET and POST is a read sent as GET (the block renderer),
      // except running an ability, which may change things
      const method = e.methods.includes("GET") && !e.methods.includes("DELETE") ? "GET" : e.methods.includes("POST") ? "POST" : e.methods[0]!;
      if (paths[path]?.[method.toLowerCase()]) continue;
      const id = NAMES[`${method} ${path}`] ?? name(path, method);
      const params: any[] = inPath.map((p) => ({ name: p, in: "path", required: true, schema: { type: numbers.has(p) ? "integer" : "string" }, description: e.args[p]?.description ?? `The ${p.replace(/_/g, " ")}` }));
      const body: Record<string, Arg> = {};
      const required: string[] = [];
      for (const [k, a] of Object.entries(e.args)) {
        if (inPath.includes(k)) continue;
        if (method === "GET" || method === "DELETE") {
          // a list in the query goes comma-separated (WordPress reads it so); the advanced object form of a term filter can't go there
          const list = [a.type].flat().includes("array");
          const schema = list ? { ...(a.oneOf?.find((o: Arg) => o.type === "array") ?? { type: "array", items: a.items ?? {} }), description: a.description } : a;
          const cleaned = arg(schema);
          params.push({ name: k, in: "query", required: Boolean(a.required), schema: cleaned, description: cleaned.description, ...(list && { explode: false }) });
        } else {
          body[k] = arg(a);
          if (a.required) required.push(k);
        }
      }
      const said = id.replace(/_/g, " ");
      const op: Record<string, any> = { operationId: id, summary: `${said[0]!.toUpperCase()}${said.slice(1)} (${method} ${path})`, tags: [r.namespace || "index"], parameters: params, ...(NOTES[id] && { description: NOTES[id] }) };
      if (method !== "GET" && method !== "DELETE") {
        const schema = { type: "object", properties: body, ...(required.length && { required }) };
        // a new media item is the file itself; the other fields come with it in the same form
        op.requestBody =
          route === "/wp/v2/media"
            ? { required: true, content: { "multipart/form-data": { schema: { ...schema, properties: { file: { type: "string", format: "binary", description: "The image, video, audio or document to upload" }, ...body }, required: ["file"] } } } }
            : { content: { "application/json": { schema } } };
      }
      (paths[path] ??= {})[method.toLowerCase()] = op;
    }
  }
  return { openapi: "3.0.0", info: { title: "WordPress REST API", version: "wp/v2" }, paths };
}

export default {
  spec: SPEC,
  out: "src/integrations/own/wordpress/actions.json",
  // POSTs that only work something out and change nothing
  reads: ["encode_widget_form", "render_widget_preview"],
  // answers with a new application password, shown once
  secrets: ["create_user_application_password"],
} satisfies AppConfig;

if (import.meta.main) {
  const src = process.argv[2];
  if (!src) throw new Error("usage: bun scripts/openapi/wordpress.ts <site>/wp-json/ | index.json");
  const index = /^https?:/.test(src) ? await (await fetch(src)).json() : await Bun.file(src).json();
  await Bun.write(SPEC, JSON.stringify(toOpenApi(index as any)));
  console.log(`${Object.keys((index as any).routes).length} routes → ${SPEC}`);
}
