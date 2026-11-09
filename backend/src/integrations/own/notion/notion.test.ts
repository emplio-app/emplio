import { afterEach, expect, test } from "bun:test";
import { z } from "zod";
import { pollOnce } from "../../polls/index";
import { AppsError } from "../../types";
import { own } from "../index";
import { notion } from "./index";
import { version } from "./version.json";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
type Call = { url: string; method: string; body: any; headers: Record<string, string> };
const stub = (answer: (c: Call) => Response) => {
  const calls: Call[] = [];
  globalThis.fetch = (async (url: string, init: RequestInit = {}) => {
    const c = { url: String(url), method: init.method ?? "GET", body: init.body ? JSON.parse(String(init.body)) : undefined, headers: init.headers as Record<string, string> };
    calls.push(c);
    return answer(c);
  }) as typeof fetch;
  return calls;
};
const login = { externalId: "c1", secret: "ntn_x" };
const now = () => new Date().toISOString();

test("a secret is checked and labelled, a bad one is refused", async () => {
  const calls = stub(() => json({ name: "Emplio", bot: { workspace_name: "Acme" } }));
  expect(await own.connectWithKey!("notion", " ntn_x ")).toEqual({ secret: "ntn_x", label: "Acme" });
  expect(calls[0]!.url).toBe("https://api.notion.com/v1/users/me");
  expect(calls[0]!.headers.Authorization).toBe("Bearer ntn_x");
  stub(() => json({ message: "API token is invalid." }, 401));
  await expect(own.connectWithKey!("notion", "nope")).rejects.toBeInstanceOf(AppsError);
});

test("reads run unasked, writes ask, and every input is a usable schema", async () => {
  for (const read of ["retrieve_page", "search_notion_page", "query_data_source", "fetch_comments", "get_page_markdown"]) expect((await own.getAction(`notion.${read}`))?.readOnly).toBe(true);
  for (const write of ["create_notion_page", "update_page", "delete_block", "create_comment", "archive_notion_page", "duplicate_page", "upsert_row_database", "replace_page_content"]) expect((await own.getAction(`notion.${write}`))?.readOnly).toBeFalsy();
  for (const a of Object.values(notion.actions)) z.toJSONSchema(a.input, { io: "input" });
});

test("every call carries the Notion-Version the spec is written for, and it isn't an input", async () => {
  expect(version).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  const calls = stub(() => json({ id: "p1" }));
  await own.run("notion.retrieve_page", { page_id: "p1" }, login, "o");
  expect(calls[0]!.headers["Notion-Version"]).toBe(version);
  expect(calls[0]!.url).toBe("https://api.notion.com/v1/pages/p1");
  expect((await own.getAction("notion.retrieve_page"))?.input.some((f) => f.name === "notion_version")).toBe(false);
});

test("the shapes the generator can't flatten reach Notion whole", async () => {
  const calls = stub(() => json({ id: "x" }));
  await own.run("notion.create_comment", { parent: { page_id: "p1" }, markdown: "hello" }, login, "o");
  expect(calls[0]!.body).toEqual({ parent: { page_id: "p1" }, markdown: "hello" });
  await own.run("notion.update_page_markdown", { page_id: "p1", type: "replace_content", replace_content: { new_str: "# Hi" } }, login, "o");
  expect(calls[1]!.url).toBe("https://api.notion.com/v1/pages/p1/markdown");
  expect(calls[1]!.body).toEqual({ type: "replace_content", replace_content: { new_str: "# Hi" } });
});

test("archive puts a page in the trash, replace swaps its content", async () => {
  const calls = stub(() => json({ id: "p1" }));
  await own.run("notion.archive_notion_page", { page_id: "p1" }, login, "o");
  expect(calls[0]!.method).toBe("PATCH");
  expect(calls[0]!.body).toEqual({ in_trash: true });
  await own.run("notion.replace_page_content", { page_id: "p1", markdown: "new" }, login, "o");
  expect(calls[1]!.body).toEqual({ type: "replace_content", markdown_version: "v2", replace_content: { new_str: "new" } });
});

test("upsert updates the match, or adds a row when there is none", async () => {
  const hit = stub((c) => json(c.url.endsWith("/query") ? { results: [{ id: "row1" }] } : { id: "row1" }));
  await own.run("notion.upsert_row_database", { data_source_id: "ds1", filter: { property: "Email", email: { equals: "a@b.co" } }, properties: { Name: {} } }, login, "o");
  expect(hit[0]!.body.page_size).toBe(1);
  expect(hit[1]!.method).toBe("PATCH");
  expect(hit[1]!.url).toEndWith("/v1/pages/row1");
  const miss = stub((c) => json(c.url.endsWith("/query") ? { results: [] } : { id: "new" }));
  await own.run("notion.upsert_row_database", { data_source_id: "ds1", filter: {}, properties: { Name: {} } }, login, "o");
  expect(miss[1]!.method).toBe("POST");
  expect(miss[1]!.body.parent).toEqual({ data_source_id: "ds1" });
});

test("a copy keeps the title and content, under the same parent", async () => {
  const calls = stub((c) => {
    if (c.url.endsWith("/markdown")) return json({ markdown: "# body" });
    if (c.method === "GET") return json({ parent: { type: "page_id", page_id: "top" }, properties: { Name: { type: "title", title: [{ plain_text: "Plan" }] } } });
    return json({ id: "copy" });
  });
  await own.run("notion.duplicate_page", { page_id: "p1" }, login, "o");
  expect(calls[2]!.body).toEqual({ parent: { page_id: "top" }, properties: { Name: { title: [{ text: { content: "Plan (copy)" } }] } }, markdown: "# body" });
});

// ── polled triggers: `run` stands in for the connection
const run = (results: any[], name = "notion.search_notion_page") => async (action: string) => {
  if (action !== name) throw new Error(`unexpected ${action}`);
  return { results, next_cursor: null };
};
const page = (id: string, over: object = {}) => ({ object: "page", id, created_time: now(), last_edited_time: now(), parent: { page_id: "p-a" }, properties: { Name: { type: "title", title: [{ plain_text: id }] } }, ...over });

test("page_created: first poll only notes, later ones report new pages, the parent filter applies", async () => {
  const first = await pollOnce("notion.page_created", {}, null, run([page("a")]));
  expect(first.fresh).toEqual([]);
  const second = await pollOnce("notion.page_created", {}, first.seen, run([page("a"), page("b")]));
  expect(second.fresh.map((f: any) => f.page.id)).toEqual(["b"]);
  const filtered = await pollOnce("notion.page_created", { parent_id: "other" }, first.seen, run([page("c")]));
  expect(filtered.fresh).toEqual([]);
  const old = new Date(Date.now() - 3 * 86_400_000).toISOString();
  expect((await pollOnce("notion.page_created", {}, first.seen, run([page("d", { created_time: old })]))).fresh).toEqual([]);
});

test("page_properties_updated reports a property change but not an edit that leaves properties alone", async () => {
  const before = page("a", { last_edited_time: "2026-11-09T10:00:00.000Z" });
  const recent = (p: object) => ({ ...p, last_edited_time: now() });
  const first = await pollOnce("notion.page_properties_updated", {}, null, run([recent(before)]));
  const same = await pollOnce("notion.page_properties_updated", {}, first.seen, run([recent(before)]));
  expect(same.fresh).toEqual([]);
  const changed = await pollOnce("notion.page_properties_updated", {}, first.seen, run([recent({ ...before, properties: { Name: { type: "title", title: [{ plain_text: "new" }] } } })]));
  expect(changed.fresh).toHaveLength(1);
  // a computed value isn't an edit
  const clock = await pollOnce("notion.page_properties_updated", {}, first.seen, run([recent({ ...before, properties: { ...before.properties, At: { type: "last_edited_time", last_edited_time: now() } } })]));
  expect(clock.fresh).toEqual([]);
});

test("page_content_updated reports edits, not brand-new pages", async () => {
  const made = now();
  const first = await pollOnce("notion.page_content_updated", {}, null, run([page("a", { created_time: made, last_edited_time: made })]));
  expect(first.seen).toEqual([]);
  const edited = await pollOnce("notion.page_content_updated", {}, first.seen, run([page("a", { created_time: "2026-11-01T00:00:00.000Z", last_edited_time: now() })]));
  expect(edited.fresh).toHaveLength(1);
});

const source = (id: string, database_id: string, over: object = {}) => ({ object: "data_source", id, created_time: now(), parent: { type: "database_id", database_id }, properties: { Name: { id: "t", type: "title" } }, ...over });

test("datasource_created and datasource_schema_updated", async () => {
  const first = await pollOnce("notion.datasource_created", {}, null, run([source("s1", "d1")]));
  const second = await pollOnce("notion.datasource_created", {}, first.seen, run([source("s1", "d1"), source("s2", "d1")]));
  expect(second.fresh.map((f: any) => f.data_source.id)).toEqual(["s2"]);

  const a = await pollOnce("notion.datasource_schema_updated", {}, null, run([source("s1", "d1")]));
  expect((await pollOnce("notion.datasource_schema_updated", {}, a.seen, run([source("s1", "d1")]))).fresh).toEqual([]);
  const b = await pollOnce("notion.datasource_schema_updated", {}, a.seen, run([source("s1", "d1", { properties: { Name: { id: "t", type: "title" }, Due: { id: "d", type: "date" } } })]));
  expect(b.fresh).toHaveLength(1);
});

test("database_created ignores a new table in an old database", async () => {
  const old = "2020-01-01T00:00:00.000Z";
  const sources = (...s: any[]) => async (action: string, input: any) =>
    action === "notion.fetch_database" ? { created_time: input.database_id === "fresh" ? now() : old } : { results: s, next_cursor: null };
  const first = await pollOnce("notion.database_created", {}, null, sources());
  const second = await pollOnce("notion.database_created", {}, first.seen, sources(source("s1", "fresh"), source("s2", "fresh"), source("s3", "aged")));
  expect(second.fresh.map((f: any) => f.database_id)).toEqual(["fresh"]);
});

test("comment_created watches the given page", async () => {
  const comment = (id: string) => ({ object: "comment", id, created_time: now() });
  const c = async (action: string, input: any) => {
    expect(action).toBe("notion.fetch_comments");
    expect(input.block_id).toBe("p1");
    return { results: [comment("c1")], next_cursor: null };
  };
  const first = await pollOnce("notion.comment_created", { block_id: "p1" }, null, c);
  expect(first.fresh).toEqual([]);
  const later = async (action: string, input: any) => {
    await c(action, input);
    return { results: [comment("c1"), comment("c2")], next_cursor: null };
  };
  expect((await pollOnce("notion.comment_created", { block_id: "p1" }, first.seen, later)).fresh.map((f: any) => f.comment.id)).toEqual(["c2"]);
});

test("view_created asks one database when it's set, the recent ones otherwise", async () => {
  const calls: any[] = [];
  const r = async (action: string, input: any) => {
    calls.push([action, input]);
    if (action === "notion.list_views") return { results: [{ object: "view", id: `v-${input.database_id}` }] };
    return { results: [source("s1", "d1"), source("s2", "d2"), source("s3", "d2")], next_cursor: null };
  };
  const one = await pollOnce("notion.view_created", { database_id: "dx" }, null, r);
  expect(one.seen).toEqual(["v-dx"]);
  expect(calls).toEqual([["notion.list_views", { database_id: "dx", page_size: 100 }]]);
  const all = await pollOnce("notion.view_created", {}, ["v-d1"], r);
  expect(all.fresh.map((f: any) => f.view.id)).toEqual(["v-d2"]);
});

test("what the triggers send passes the real actions' input checks", async () => {
  stub(() => json({ results: [], next_cursor: null }));
  const real = (a: string, i: unknown) => own.run(a, i, login, "o");
  for (const [trigger, config] of [["page_created", {}], ["datasource_created", {}], ["comment_created", { block_id: "p1" }], ["view_created", { database_id: "d1" }]] as const) await pollOnce(`notion.${trigger}`, config, null, real);
});

test("every Composio trigger name is a trigger", () => {
  // listPolls is what `emplio automations triggers` shows
  return import("../../polls/index").then(({ listPolls }) => {
    const names = listPolls("notion").map((p) => p.action.split(".")[1]);
    for (const n of ["comment_created", "database_created", "datasource_created", "datasource_schema_updated", "page_content_updated", "page_created", "page_properties_updated", "view_created"]) expect(names).toContain(n);
  });
});
