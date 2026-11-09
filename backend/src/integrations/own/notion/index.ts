// Notion on an internal integration secret the business pastes: every operation of Notion's API, from its OpenAPI spec.
// actions.json comes from `bun scripts/openapi-actions.ts notion`; triggers are polled (polls/notion.ts), COVERAGE.md says why.
import { z } from "zod";
import { AppsError } from "../../types";
import type { OwnAction, OwnApp } from "../index";
import { type Api, call, rest, specActions } from "../openapi";
import { version } from "./version.json";

export const api: Api = {
  name: "Notion",
  base: "https://api.notion.com",
  tokenHelp: "notion.so/profile/integrations",
  auth: (key) => ({ Authorization: `Bearer ${key}`, "Notion-Version": version }),
};

const GET = (path: string) => ({ method: "GET", path, query: [], headers: [] });
const body = (method: string, path: string, ...fields: string[]) => ({ method, path, query: [], headers: [], body: { kind: "fields" as const, fields: fields.map((f): [string, string] => [f, f]) } });
const open = z.record(z.string(), z.any());
const pageId = z.string().describe("The page's id, from its Notion link or notion.search_notion_page");
const markdownVersion = z.enum(["v1", "v2"]).optional().describe("The Markdown syntax: v2 is Notion's current one and the better choice");
const richText = z.array(z.any()).optional().describe('The text as Notion rich text, e.g. [{"text": {"content": "Looks good"}}]. Give this or markdown');
const markdown = z.string().optional().describe("The text as Markdown. Give this or rich_text");

// The spec's four bodies with one-of-several shapes, which the generator flattens away; everything else is in actions.json.
const overrides: Record<string, OwnAction> = {
  update_page_markdown: rest(api, "PATCH", "/v1/pages/{page_id}/markdown", "Change a page's content with Markdown: replace all of it, or search and replace parts.", z.object({
    page_id: pageId,
    type: z.enum(["replace_content", "update_content", "insert_content", "replace_content_range"]).describe("replace_content swaps the whole page; update_content does searches and replaces. The other two are older and Notion is retiring them"),
    replace_content: z.object({ new_str: z.string().describe("The page's new content, as Markdown"), allow_deleting_content: z.boolean().optional().describe("true also allows removing child pages and databases") }).optional().describe("With type replace_content"),
    update_content: z.object({
      content_updates: z.array(z.object({ old_str: z.string().describe("Text to find, exactly as it is on the page"), new_str: z.string().describe("What to put there"), replace_all_matches: z.boolean().optional() })).describe("The searches and replaces"),
      allow_deleting_content: z.boolean().optional(),
    }).optional().describe("With type update_content"),
    insert_content: open.optional().describe("With type insert_content: {content, after?, position?}"),
    replace_content_range: open.optional().describe("With type replace_content_range: {content, content_range}"),
    markdown_version: markdownVersion,
    allow_async: z.boolean().optional().describe("true lets a big change finish in the background; the answer is then an async task to check with notion.retrieve_async_task"),
  })),
  create_comment: rest(api, "POST", "/v1/comments", "Add a comment to a page or block, or reply in a discussion.", z.object({
    parent: z.object({ page_id: z.string().optional(), block_id: z.string().optional() }).optional().describe("Where a new comment goes: {page_id} or {block_id}. Leave out when replying with discussion_id"),
    discussion_id: z.string().optional().describe("The discussion to reply in, from notion.fetch_comments"),
    rich_text: richText,
    markdown,
    attachments: z.array(open).max(3).optional().describe('Up to 3 files already uploaded: [{"file_upload_id": "..."}]'),
    display_name: open.optional().describe('Who the comment shows as: {"type": "integration"}, {"type": "user"} or {"type": "custom", "custom": {"name": "..."}}'),
    markdown_version: markdownVersion,
  })),
  update_comment: rest(api, "PATCH", "/v1/comments/{comment_id}", "Change the text of a comment.", z.object({
    comment_id: z.string().describe("The comment's id, from notion.fetch_comments"),
    rich_text: richText,
    markdown,
    markdown_version: markdownVersion,
  })),
  create_meeting_note: rest(api, "POST", "/v1/blocks/meeting_notes", "Make a meeting note from an audio or video recording already in Notion.", z.object({
    source: open.describe('The recording: {"type": "file_upload", "file_upload_id": "..."} (needs parent) or {"type": "block", "block_id": "..."}'),
    parent: open.optional().describe('For an uploaded recording, the page it goes under: {"type": "page_id", "page_id": "..."}'),
    title: z.string().optional().describe("The note's title"),
    language: z.string().optional().describe('The language spoken, e.g. "en", or "auto" to detect it'),
    options: z.object({ kickoff_summary: z.boolean().optional().describe("true starts a summary once the transcript is done") }).optional(),
  })),
};

// Easier ways to do common things, on top of the raw API.
const helpers: Record<string, OwnAction> = {
  archive_notion_page: rest(api, "PATCH", "/v1/pages/{page_id}", "Move a page to Notion's trash, or bring it back.", z.object({
    page_id: pageId,
    in_trash: z.boolean().default(true).describe("true moves it to the trash (default), false restores it"),
  })),
  replace_page_content: {
    description: "Replace everything on a page with new Markdown content. Child pages and databases on it are kept unless allow_deleting_content is true.",
    input: z.object({ page_id: pageId, markdown: z.string().describe("The page's new content, as Markdown"), allow_deleting_content: z.boolean().optional().describe("true also removes child pages and databases") }),
    run: (i: { page_id: string; markdown: string; allow_deleting_content?: boolean }, key: string) =>
      call(api, key, body("PATCH", "/v1/pages/{page_id}/markdown", "type", "markdown_version", "replace_content"), {
        page_id: i.page_id,
        type: "replace_content",
        markdown_version: "v2",
        replace_content: { new_str: i.markdown, allow_deleting_content: i.allow_deleting_content },
      }),
  },
  duplicate_page: {
    description: "Make a copy of a page: its title and content, under the same parent or another page. Child pages and databases aren't copied, and a database row's other properties stay behind.",
    input: z.object({
      page_id: pageId,
      parent_page_id: z.string().optional().describe("The page to put the copy under (default: where the original is)"),
      title: z.string().optional().describe('The copy\'s title (default: the original\'s plus " (copy)")'),
    }),
    async run(i: { page_id: string; parent_page_id?: string; title?: string }, key: string) {
      const page = (await call(api, key, GET("/v1/pages/{page_id}"), i)) as { parent: Record<string, any>; properties: Record<string, any> };
      const md = (await call(api, key, GET("/v1/pages/{page_id}/markdown"), i)) as { markdown?: string; truncated?: boolean };
      const [prop, value] = Object.entries(page.properties).find(([, v]) => v.type === "title") ?? ["title", { title: [] }];
      const title = i.title ?? `${value.title.map((t: { plain_text?: string }) => t.plain_text ?? "").join("")} (copy)`;
      const from = page.parent;
      const parent = i.parent_page_id ? { page_id: i.parent_page_id } : from.page_id ? { page_id: from.page_id } : from.data_source_id ? { data_source_id: from.data_source_id } : from.database_id ? { database_id: from.database_id } : null;
      if (!parent) throw new AppsError("this page sits at the top of the workspace; give parent_page_id, a page to put the copy under");
      const made = (await call(api, key, body("POST", "/v1/pages", "parent", "properties", "markdown"), { parent, properties: { [prop]: { title: [{ text: { content: title } }] } }, markdown: md.markdown })) as Record<string, unknown>;
      return md.truncated ? { ...made, note: "the original was too long to copy in one go, so the copy may be cut short" } : made;
    },
  },
  upsert_row_database: {
    description: "Update the first row of a database that matches a filter, or add a new row if none matches.",
    input: z.object({
      data_source_id: z.string().describe("The data source's id, from notion.fetch_database"),
      filter: open.describe('Which row counts as the same one, in Notion\'s filter format, e.g. {"property": "Email", "email": {"equals": "a@b.com"}}'),
      properties: open.describe("The row's values, in Notion's property format"),
    }),
    async run(i: { data_source_id: string; filter: unknown; properties: unknown }, key: string) {
      const found = (await call(api, key, body("POST", "/v1/data_sources/{data_source_id}/query", "filter", "page_size"), { ...i, page_size: 1 })) as { results?: { id: string }[] };
      const hit = found.results?.[0];
      if (hit) return call(api, key, body("PATCH", "/v1/pages/{page_id}", "properties"), { page_id: hit.id, properties: i.properties });
      return call(api, key, body("POST", "/v1/pages", "parent", "properties"), { parent: { data_source_id: i.data_source_id }, properties: i.properties });
    },
  },
};

export const notion: OwnApp = {
  app: "notion",
  name: "Notion",
  logo: "/logos/notion.svg",
  keyField: {
    label: "Internal integration secret",
    help: "notion.so/profile/integrations → New integration (Internal) for your workspace → copy the Internal Integration Secret. Then share with it the pages and databases Emplio should work on: open the page → ••• → Connections → add your integration.",
    placeholder: "ntn_...",
  },
  async check(key) {
    const me = (await call(api, key, GET("/v1/users/me"), {})) as { name?: string; bot?: { workspace_name?: string } };
    return me.bot?.workspace_name || me.name;
  },
  actions: { ...(await specActions(new URL("./actions.json", import.meta.url), api)), ...overrides, ...helpers },
};
