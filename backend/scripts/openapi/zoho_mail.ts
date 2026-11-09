// Zoho Mail has no OpenAPI spec, so this builds one from its API docs: the method and path from the index's table, the
// parameters from each call's page, one small spec per page (several pages share a path, told apart by their mode field).
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AppConfig } from "../openapi-actions";
import { composioNames } from "./composio-names";
import { zohoNamer } from "./zoho-spec";

const ROOT = "https://www.zoho.com/mail/help/api/";
const strip = (h: string) => h.replace(/\u200b/g, "").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/\s+/g, " ").trim();
const clip = (s: string) => (s.length > 500 ? `${s.slice(0, 497)}...` : s);

// partner calls need a Zoho reseller account; "Generic" pages aren't calls
const SKIP = /partner|child-org/i;
const TYPES: Record<string, object> = { boolean: { type: "boolean" }, int: { type: "integer" }, integer: { type: "integer" }, long: { type: "string" }, string: { type: "string" } };
const schemaOf = (type: string) => TYPES[type.toLowerCase()] ?? (/array|list/i.test(type) ? { type: "array", items: {} } : /json|object/i.test(type) ? { type: "object" } : { type: "string" });

export type Page = { name: string; method: string; path: string; href: string; scope?: string; title: string; params: { name: string; in: string; required: boolean; type: string; description: string }[]; file?: string };

export async function pages(): Promise<Page[]> {
  const index = await (await fetch(ROOT)).text();
  const hrefsIn = (h: string) => [...h.matchAll(/href="\/mail\/help\/api\/([a-z0-9-]+)\.html"/g)].map((m) => m[1]!).filter((x) => !SKIP.test(x));
  // the index leaves a few calls out (upload an attachment); the pages link to them
  const seen = new Set(hrefsIn(index));
  const queue = [...seen];
  const out: Page[] = [];
  while (queue.length) {
    await Promise.all(queue.splice(0, 12).map(async (href) => {
      const res = await fetch(`${ROOT}${href}.html`);
      if (!res.ok) { console.log(`skip ${href}: ${res.status}`); return; }
      const html = await res.text();
      out.push(...parse(href, html));
      for (const h of hrefsIn(html)) if (!seen.has(h)) (seen.add(h), queue.push(h));
    }));
  }
  return out.sort((a, b) => a.href.localeCompare(b.href) || a.path.localeCompare(b.path));
}

export function parse(href: string, html: string): Page[] {
  const title = strip(html.match(/<title>(.*?)<\/title>/s)?.[1] ?? href).replace(/^[A-Z]+\s*-\s*/, "").replace(/\s*\|\s*Zoho Mail$/, "");
  // the page title's verb first: a few pages' "Method:" line is wrong or says CREATE
  const stated = strip(html.match(/<title>(.*?)<\/title>/s)?.[1] ?? "").match(/^(GET|POST|PUT|PATCH|DELETE)\b/)?.[1] ?? strip(html).match(/Method\s*:\s*([A-Z]+)/)?.[1] ?? "";
  const method = /^(GET|POST|PUT|PATCH|DELETE)$/.test(stated) ? stated : undefined;
  // the addresses under "Request URL" (the page may name it earlier too), <zoid> and {zoid} alike, up to the first parameter list
  const urls = html.split(/Request URL/i).slice(1).map((part) => part.split(/<section|data-list-title|Response Codes|Sample Request/)[0]!.replace(/&lt;/g, "{").replace(/&gt;/g, "}").replace(/&nbsp;/g, " ").replace(/<[^>]+>/g, "")).find((part) => /mail\.zoho\.com\/api/.test(part)) ?? "";
  const paths = [...new Set([...urls.replace(/\{\s+/g, "{").replace(/\s+\}/g, "}").replace(/\u200b/g, " ").replace(/(or\s*)?(?<=[a-z}])(Group|Personal)[^/]*?(?=https|$)/g, " ").replace(/\b(Group|Personal)\s+tasks?\s*:?/gi, " ").replace(/https:/g, " https:").replace(/\(or\)|\bor(?=\s*https)/gi, " ").matchAll(/mail\.zoho\.com(\/api[^?\s"*]*)/g)].map((m) => m[1]!.replace(/\}\}/g, "}").replace(/\}[A-Z][^/]*$/, "}").replace(/(?:or)?For$/, "").replace(/\/$/, "")))];
  if (!method || !paths.length) { console.log(`no call on ${href}`); return []; }
  return paths.map((path) => {
    const inUrl = new Set([...path.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!));
    const params: Page["params"] = [];
    let file: string | undefined;
    for (const m of html.matchAll(/<h2 class="data-list-title">(.*?)<\/h2>(.*?)(?=<h2 class="data-list-title">|Response Codes|$)/gs)) {
      const section = strip(m[1]!);
      for (const it of m[2]!.matchAll(/data-label">(.*?)<\/div>\s*<div class="data-description">(.*?)<\/div>/gs)) {
        const label = it[1]!;
        const raw = strip(label.match(/data-name">(.*?)<\/span>/s)?.[1] ?? label.match(/<strong>(.*?)<\/strong>/s)?.[1] ?? label);
        const name = raw.replace(/\*/g, "").trim();
        const type = strip(label.match(/data-type">(.*?)<\/span>/s)?.[1] ?? label.replace(/<strong>.*?<\/strong>/s, "")) || "string";
        const description = clip(strip(it[2]!));
        if (!name || /\s/.test(name) || params.some((p) => p.name === name)) continue;
        if (/file/i.test(type)) file = name;
        params.push({ name, in: inUrl.has(name) ? "path" : /query/i.test(section) ? "query" : /request body/i.test(section) ? "body" : /path/i.test(section) ? "query" : "body", required: raw.includes("*"), type, description });
      }
    }
    // a page may cover a group's and a person's address for the same call
    const tag = paths.length > 1 ? (path.includes("/me") ? "_personal" : path.includes("/groups/") ? "_group" : `_${paths.indexOf(path)}`) : "";
    return { name: `${href.replace(/-/g, "_")}${tag}`, method, path, href, title, params, file, scope: html.match(/ZohoMail\.[\w.]+/)?.[0] };
  });
}

function specOf(p: Page) {
  const params = p.params.filter((x) => x.in !== "body");
  const body = p.params.filter((x) => x.in === "body" && x.name !== p.file);
  const props = Object.fromEntries(body.map((x) => {
    // "Provide the value as moveToSpam." makes it the only choice, already filled in
    const fixed = x.name === "mode" && x.description.match(/value as "?(\w+)"?\.?/)?.[1];
    return [x.name, { ...schemaOf(x.type), description: x.description, ...(fixed && { enum: [fixed], default: fixed }) }];
  }));
  const required = body.filter((x) => x.required && x.name !== "mode").map((x) => x.name);
  const requestBody = p.file
    ? { required: true, content: { "multipart/form-data": { schema: { type: "object", properties: { ...props, [p.file]: { type: "string", format: "binary", description: p.params.find((x) => x.name === p.file)!.description } }, required: [p.file] } } } }
    : body.length
      ? { required: true, content: { "application/json": { schema: { type: "object", properties: props, required } } } }
      : undefined;
  const parameters = params.filter((x) => x.name !== p.file).map((x) => ({ name: x.name, in: x.in, required: x.required || x.in === "path", description: x.description, schema: schemaOf(x.type) }));
  const group = p.path.split("/").filter((s) => s && !s.startsWith("{") && s !== "api" && s !== "organization" && s !== "accounts")[0] ?? "accounts";
  return { paths: { [p.path]: { [p.method.toLowerCase()]: { operationId: p.name, summary: p.title, tags: [group], parameters, requestBody } } } };
}

const dir = await mkdtemp(join(tmpdir(), "zoho-mail-"));
const found = import.meta.main ? [] : await pages();
await Bun.write(join(dir, "scopes.txt"), found.map((p) => `${p.scope ?? "?"} ${p.method} ${p.path} ${p.href}`).join("\n"));
const spec = await Promise.all(found.map(async (p, i) => {
  const f = join(dir, `${i}.json`);
  await Bun.write(f, JSON.stringify(specOf(p)));
  return f;
}));
console.log(`${found.length} pages → ${dir}`);

export default {
  spec,
  out: "src/integrations/own/zoho_mail/actions.json",
  name: zohoNamer(await composioNames("zoho_mail")),
  rename: {
    add_user_signature: "accounts_create_signature",
    get_user_signature: "accounts_get_signatures",
    get_accounts_of_user: "accounts_list_accounts",
    update_display_name_for_user: "accounts_update_display_name",
    create_new_folder: "folders_create_folder",
    delete_folder: "folders_delete_folder",
    get_specific_folder: "folders_get_folder",
    get_folders: "folders_list_folders",
    rename_folder: "folders_update_folder",
    delete_groups: "groups_delete_group_bulk",
    delete_group_group: "groups_delete_group_by_zgid",
    get_specific_group_details: "groups_get_group",
    get_list_of_emails_held_for_moderation: "groups_list_moderation_emails",
    moderate_emails_of_group: "groups_moderate_messages",
    create_new_label: "labels_create_label",
    get_label_details: "labels_list_labels",
    get_all_bookmarks_personal: "list_bookmarks",
    fetch_organization_users_details: "list_organization_accounts",
    fetch_domains: "list_organization_domains",
    save_draft_or_template: "messages_create_draft",
    delete_email: "messages_delete_email",
    getting_email_attachment_content: "messages_download_attachment",
    get_email_attachment_info: "messages_get_attachment_info",
    get_email_content_of_email: "messages_get_message_content",
    get_message_headers_of_email: "messages_get_message_headers",
    get_meta_data_of_email: "messages_get_message_metadata",
    list_emails: "messages_list_emails",
    send_reply_to_email: "messages_reply_to_email",
    send_email: "messages_send_email",
    get_user_storage_details: "organization_get_user_storage_details",
    update_org_spam_processing_type: "organization_update_spam_process_type",
    update_user_storage: "organization_update_user_storage",
    list_emails_based_on_search_parameters: "search_messages",
    add_new_group_personal_task: "tasks_create_group_task",
    post_add_new_task_personal: "tasks_create_personal_task",
    get_all_group_or_personal_tasks_personal: "tasks_list_personal_tasks",
    change_task_status: "tasks_update_group_task",
    update_advanced_settings: "update_group_settings",
    upload_attachment: "messages_upload_attachment",
  },
  params: { accountId: "The mailbox to act on (its accountId). Leave out when the login has just one mailbox; Emplio fills it in.", zoid: "The organisation's id (zoid). Leave out; Emplio fills it in." },
} satisfies AppConfig;
