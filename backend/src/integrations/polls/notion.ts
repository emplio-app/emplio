import { z } from "zod";
import { recent, type PollTrigger, type Run } from "./index";

// Notion's webhooks are made by hand in its integration screen, so a pasted secret can't register them: everything is polled.
// COVERAGE.md lists what each trigger can and can't tell apart.
// ponytail: newest 100 edited from search; more than 100 pages edited between two checks may miss some (raise the search pages if that bites)
const SORT = { timestamp: "last_edited_time", direction: "descending" };
const COMPUTED = new Set(["formula", "rollup", "last_edited_time", "last_edited_by"]);
const stamp = (v: unknown) => Bun.hash(JSON.stringify(v)).toString(36);
const norm = (id: unknown) => String(id ?? "").replaceAll("-", "");

const search = async (run: Run, value: "page" | "data_source", pages = 1) => {
  const out: any[] = [];
  let cursor: string | undefined;
  for (let i = 0; i < pages; i++) {
    const res = (await run("notion.search_notion_page", { filter: { property: "object", value }, sort: SORT, page_size: 100, ...(cursor && { start_cursor: cursor }) })) as { results?: any[]; next_cursor?: string | null };
    out.push(...(res.results ?? []));
    cursor = res.next_cursor ?? undefined;
    if (!cursor) break;
  }
  return out;
};

// only values people set, so a clock formula or an edit elsewhere on the page doesn't look like a property change
const storedProps = (page: any) => Object.entries<any>(page.properties ?? {}).filter(([, p]) => !COMPUTED.has(p?.type)).sort(([a], [b]) => a.localeCompare(b));

const PAGE_CONFIG = { parent_id: z.string().optional().describe("Only pages directly inside this page or database (its id, from the Notion link)") };
const inParent = (parent_id: string | undefined) => (p: any) =>
  !parent_id || [p.parent?.page_id, p.parent?.database_id, p.parent?.data_source_id].some((x) => norm(x) === norm(parent_id));
const output = (name: string, description: string): PollTrigger["output"] => [{ name, type: "object", required: true, description }];
const pageOut = output("page", "The Notion page: id, url, parent, created_time, last_edited_time, properties");
const sourceOut = output("data_source", "The data source (a table of a Notion database): id, title, parent, properties");

const dataSources = (run: Run) => search(run, "data_source", 5);

export const notion: Record<string, PollTrigger> = {
  page_created: {
    description: "A page is created in the Notion pages shared with Emplio (checked every 5 minutes by default). Includes new database rows.",
    config: z.object(PAGE_CONFIG),
    output: pageOut,
    every: 5,
    min: 5,
    async poll({ parent_id }, run) {
      const pages = (await search(run, "page")).filter((p) => recent(p.created_time)).filter(inParent(parent_id));
      return pages.map((page) => ({ id: page.id, item: { page } }));
    },
  },
  page_properties_updated: {
    description: "A page's properties change (title, status, a database row's values). The first change seen on a page that wasn't checked before is reported even if it was a content edit, since there's nothing to compare it with; a new page counts as well.",
    config: z.object(PAGE_CONFIG),
    output: pageOut,
    every: 5,
    min: 5,
    async poll({ parent_id }, run) {
      const pages = (await search(run, "page")).filter((p) => recent(p.last_edited_time)).filter(inParent(parent_id));
      return pages.map((page) => ({ id: `${page.id}:${stamp(storedProps(page))}`, item: { page } }));
    },
  },
  page_content_updated: {
    description: "A page is edited after it was made. Notion keeps one last-edited time per page, so a property change is reported here too.",
    config: z.object(PAGE_CONFIG),
    output: pageOut,
    every: 5,
    min: 5,
    async poll({ parent_id }, run) {
      const pages = (await search(run, "page")).filter((p) => recent(p.last_edited_time) && p.last_edited_time !== p.created_time).filter(inParent(parent_id));
      return pages.map((page) => ({ id: `${page.id}:${page.last_edited_time}`, item: { page } }));
    },
  },
  datasource_created: {
    description: "A data source (a table of a Notion database) is created.",
    config: z.object({}),
    output: sourceOut,
    every: 5,
    min: 5,
    async poll(_c, run) {
      return (await dataSources(run)).filter((s) => recent(s.created_time)).map((data_source) => ({ id: data_source.id, item: { data_source } }));
    },
  },
  database_created: {
    description: "A Notion database is created.",
    config: z.object({}),
    output: [
      { name: "database_id", type: "string", required: true, description: "The new database's id" },
      { name: "data_source", type: "object", required: true, description: "Its data source: id, title, parent, properties" },
    ],
    every: 5,
    min: 5,
    async poll(_c, run) {
      const fresh = new Map<string, any>();
      for (const s of (await dataSources(run)).filter((d) => recent(d.created_time) && d.parent?.database_id)) if (!fresh.has(s.parent.database_id)) fresh.set(s.parent.database_id, s);
      // a new table added to an old database isn't a new database
      const out: { id: string; item: unknown }[] = [];
      for (const [database_id, data_source] of fresh) {
        const db = (await run("notion.fetch_database", { database_id })) as { created_time?: string };
        if (recent(db.created_time)) out.push({ id: database_id, item: { database_id, data_source } });
      }
      return out;
    },
  },
  datasource_schema_updated: {
    description: "A data source's columns change (a property added, renamed or retyped). A brand-new data source counts as well.",
    config: z.object({}),
    output: sourceOut,
    every: 5,
    min: 5,
    async poll(_c, run) {
      return (await dataSources(run)).map((data_source) => ({ id: `${data_source.id}:${stamp(Object.entries(data_source.properties ?? {}).sort(([a], [b]) => a.localeCompare(b)))}`, item: { data_source } }));
    },
  },
  comment_created: {
    description: "A comment is added on a page or block.",
    config: z.object({ block_id: z.string().describe("The page or block to watch (its id, from the Notion link)") }),
    output: output("comment", "The Notion comment: id, parent, discussion_id, created_time, created_by, rich_text"),
    every: 5,
    min: 5,
    async poll({ block_id }, run) {
      const comments: any[] = [];
      let cursor: string | undefined;
      // ponytail: 10 pages of 100 comments; comments come oldest first, so a thread longer than that misses new ones
      for (let page = 0; page < 10; page++) {
        const res = (await run("notion.fetch_comments", { block_id, page_size: 100, ...(cursor && { start_cursor: cursor }) })) as { results?: any[]; next_cursor?: string | null };
        comments.push(...(res.results ?? []));
        cursor = res.next_cursor ?? undefined;
        if (!cursor) break;
      }
      return comments.filter((c) => recent(c.created_time)).map((comment) => ({ id: comment.id, item: { comment } }));
    },
  },
  view_created: {
    description: "A view (table, board, calendar...) is added to a Notion database. One database when database_id is set, otherwise the 25 most recently edited databases; each check is one Notion call per database.",
    config: z.object({ database_id: z.string().optional().describe("Only this database (its id, from the Notion link)") }),
    output: [
      { name: "view", type: "object", required: true, description: "The view's id; notion.retrieve_view gives its name and settings" },
      { name: "database_id", type: "string", required: true, description: "The database it belongs to" },
    ],
    every: 15,
    min: 5,
    async poll({ database_id }, run) {
      // ponytail: 25 databases a check without database_id, Notion's rate limit is 3 calls a second; set database_id past that
      const ids = database_id ? [database_id] : [...new Set((await dataSources(run)).map((s) => s.parent?.database_id).filter(Boolean))].slice(0, 25);
      const out: { id: string; item: unknown }[] = [];
      for (const id of ids) {
        const views = (await run("notion.list_views", { database_id: id, page_size: 100 })) as { results?: any[] };
        for (const view of views.results ?? []) out.push({ id: view.id, item: { view, database_id: id } });
      }
      return out;
    },
  },
};
