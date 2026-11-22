import { afterEach, beforeAll, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { AppFile, AppsError } from "../../types";
import { own } from "../index";
import { monday } from "./index";
import { triggers, wanted } from "./triggers";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});
beforeAll(() => {
  process.env.ENCRYPTION_KEY ??= "test-key";
  process.env.WEBHOOK_URL = "https://api.test";
});
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
type Call = { url: string; method: string; body: BodyInit | null | undefined; json: any; headers: Record<string, string> };
const stub = (answer: (c: Call) => Response) => {
  const calls: Call[] = [];
  globalThis.fetch = (async (url: string, init: RequestInit = {}) => {
    const body = init.body;
    const c = { url: String(url), method: init.method ?? "GET", body, json: typeof body === "string" ? JSON.parse(body) : undefined, headers: init.headers as Record<string, string> };
    calls.push(c);
    return answer(c);
  }) as typeof fetch;
  return calls;
};
const login = { externalId: "c1", secret: "tok" };
const flat = (s: string) => s.replace(/\s+/g, " ");

test("a token is checked and labelled, and a refused one is dead", async () => {
  const calls = stub(() => json({ data: { me: { id: "1", name: "Sarah", account: { name: "Northwind" } } } }));
  expect(await own.connectWithKey!("monday", " tok ")).toEqual({ secret: "tok", label: "Sarah, Northwind" });
  expect(calls[0]!.url).toBe("https://api.monday.com/v2");
  expect(calls[0]!.headers.Authorization).toBe("tok");
  expect(calls[0]!.headers["API-Version"]).toMatch(/^\d{4}-\d{2}$/);
  stub(() => json({ errors: [{ message: "Not Authenticated" }] }, 401));
  const refused = await own.connectWithKey!("monday", "nope").catch((e) => e);
  expect(refused).toBeInstanceOf(AppsError);
  expect(refused.expired).toBe(true);
});

test("reads run unasked, writes and secrets ask", async () => {
  for (const a of ["boards", "items", "me", "list_board_items", "search_items", "download_asset", "get_me"]) expect((await own.getAction(`monday.${a}`))?.readOnly).toBe(true);
  for (const a of ["create_item", "delete_board", "change_multiple_column_values", "service_user_tokens", "graphql", "update_item"]) expect((await own.getAction(`monday.${a}`))?.readOnly).not.toBe(true);
});

test("every query and mutation is an action, minus the few a personal token can't call", async () => {
  const names = (await own.listActions("monday")).map((a) => a.action);
  expect(names.length).toBeGreaterThan(300);
  for (const a of ["create_item", "create_webhook", "delete_webhook", "create_update", "move_item_to_group", "add_file_to_column", "workspaces", "docs", "notetaker_meetings"]) expect(names).toContain(`monday.${a}`);
  expect(names).not.toContain("monday.set_mock_app_subscription");
  // every input builds, and says what each field is
  for (const n of names) for (const f of (await own.getAction(n))!.input) expect(f.description || f.name === "fields").toBeTruthy();
});

test("an action sends typed variables, column values as JSON text, and answers with its own data", async () => {
  const calls = stub(() => json({ data: { create_item: { id: "7", name: "Call Sarah" } } }));
  const out = await own.run("monday.create_item", { board_id: 42, item_name: "Call Sarah", column_values: { status: { label: "Done" } } }, login, "o");
  expect(out).toEqual({ id: "7", name: "Call Sarah" });
  const { query, variables } = calls[0]!.json;
  expect(flat(query)).toStartWith("mutation($board_id: ID!, $column_values: JSON, $item_name: String!) { create_item(board_id: $board_id, column_values: $column_values, item_name: $item_name) { id name");
  expect(variables).toEqual({ board_id: "42", item_name: "Call Sarah", column_values: '{"status":{"label":"Done"}}' });
  // fields picks what comes back
  await own.run("monday.items", { ids: ["7"], fields: "id name" }, login, "o");
  expect(calls[1]!.json.query).toBe("query($ids: [ID!]) { items(ids: $ids) { id name } }");
});

test("monday's errors arrive as a 200 and show in its words", async () => {
  stub(() => json({ errors: [{ message: "Board not found", extensions: { code: "InvalidBoardIdException" } }] }));
  const e = (await own.run("monday.boards", { ids: ["1"] }, login, "o").catch((x: AppsError) => x)) as AppsError;
  expect(e).toBeInstanceOf(AppsError);
  expect(e.message).toBe("monday.com: Board not found (200)");
  expect(e.expired).toBe(false);
  stub(() => json({ error_message: "Complexity budget exhausted", error_code: "ComplexityException" }, 429));
  expect(((await own.run("monday.me", {}, login, "o").catch((x: AppsError) => x)) as AppsError).message).toContain("Complexity budget exhausted");
});

test("search's parts are actions of their own", async () => {
  const calls = stub(() => json({ data: { search: { items: { results: [{ id: "7" }] } } } }));
  expect(await own.run("monday.search_items", { query: "invoice", limit: 5 }, login, "o")).toEqual({ results: [{ id: "7" }] });
  expect(flat(calls[0]!.json.query)).toStartWith("query($query: String!, $limit: Int) { search { items(query: $query, limit: $limit) { results {");
});

test("a board's items come back with a cursor for the rest", async () => {
  const calls = stub(() => json({ data: { boards: [{ items_page: { cursor: "abc", items: [{ id: "7" }] } }] } }));
  expect(await own.run("monday.list_board_items", { board_id: "42" }, login, "o")).toEqual({ cursor: "abc", items: [{ id: "7" }] });
  expect(calls[0]!.json.variables).toEqual({ id: "42", limit: 100 });
  expect(calls[0]!.json.query).toStartWith("query($id: ID!, $limit: Int!) { boards(ids: [$id]) { items_page(limit: $limit) { cursor items { id name");
  stub(() => json({ data: { boards: [] } }));
  await expect(own.run("monday.list_columns", { board_id: "1" }, login, "o")).rejects.toThrow(/no board 1/);
});

test("a file goes up as multipart, and one comes back as a file", async () => {
  const calls = stub(() => json({ data: { add_file_to_column: { id: "99" } } }));
  const file = new AppFile("quote.pdf", "application/pdf", new Uint8Array([1, 2, 3]));
  await own.run("monday.add_file_to_column", { item_id: "7", column_id: "files", file }, login, "o");
  expect(calls[0]!.url).toBe("https://api.monday.com/v2/file");
  const form = calls[0]!.body as FormData;
  expect(flat(String(form.get("query")))).toStartWith('mutation($file: File!) { add_file_to_column(column_id: "files", file: $file, item_id: "7") {');
  expect((form.get("variables[file]") as File).name).toBe("quote.pdf");

  stub((c) => (c.url.startsWith("https://api.monday.com") ? json({ data: { assets: [{ id: "99", name: "quote.pdf", public_url: "https://files.test/q" }] } }) : new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "application/pdf" } })));
  const got = (await own.run("monday.download_asset", { asset_id: 99 }, login, "o")) as AppFile;
  expect(got).toBeInstanceOf(AppFile);
  expect(got.name).toBe("quote.pdf");
  expect(got.bytes.length).toBe(3);
});

test("the raw graphql action passes the query through", async () => {
  const calls = stub(() => json({ data: { boards: [] } }));
  expect(await own.run("monday.graphql", { query: "query { boards { id } }" }, login, "o")).toEqual({ boards: [] });
  expect(calls[0]!.json).toEqual({ query: "query { boards { id } }", variables: {} });
});

const token = (event: string) => createHmac("sha256", process.env.ENCRYPTION_KEY!).update(`monday-webhook:c1:42:${event}`).digest("hex").slice(0, 40);
const delivery = (body: unknown, event = "create_item", rest = `42/${event}/${token(event)}`) => ({ body: JSON.stringify(body), headers: {}, connection: "c1", rest });

test("a webhook is made once per board and event, and the last automation removes ours", async () => {
  let hooks: { id: string; event: string; config: string | null }[] = [];
  const calls = stub((c) => (c.json.query.includes("webhooks(") ? json({ data: { webhooks: hooks } }) : json({ data: { create_webhook: { id: "w1" }, delete_webhook: { id: "w1" } } })));
  expect(await own.startPush!("monday.item_created", login, { board_id: "42" })).toBe("monday:c1:42:create_item");
  expect(calls[1]!.json.variables).toEqual({ board: "42", event: "create_item", url: `https://api.test/webhooks/app/monday/c1/42/create_item/${token("create_item")}` });
  // already there: a second automation adds nothing
  hooks = [{ id: "w1", event: "create_item", config: null }];
  calls.length = 0;
  expect(await own.startPush!("monday.item_created", login, { board_id: "42" })).toBe("monday:c1:42:create_item");
  expect(calls).toHaveLength(1);
  // an update and a reply share one webhook
  expect(await own.startPush!("monday.item_update_reply_posted", login, { board_id: "42" })).toBe("monday:c1:42:create_update");
  await expect(own.startPush!("monday.item_created", login, { board_id: "4/../2" })).rejects.toThrow(/board_id/);

  hooks = [{ id: "w1", event: "create_item", config: null }, { id: "w2", event: "change_column_value", config: null }, { id: "w3", event: "create_item", config: '{"columnId":"x"}' }];
  calls.length = 0;
  await monday.push!.stop!("tok", "monday:c1:42:create_item");
  expect(calls.slice(1).map((c) => c.json.variables)).toEqual([{ id: "w1" }]);
});

test("the challenge is echoed, and a bad URL token is refused", async () => {
  const got = await monday.push!.receive!(delivery({ challenge: "abc" }), "tok");
  expect(got!.reply).toEqual({ challenge: "abc" });
  expect(await got!.events()).toEqual([]);
  expect(await monday.push!.receive!(delivery({ challenge: "abc" }, "create_item", "42/create_item/nope"), "tok")).toBeNull();
  expect(await monday.push!.receive!(delivery({}, "create_item", `43/create_item/${token("create_item")}`), "tok")).toBeNull();
  expect(await monday.push!.receive!(delivery({}, "create_item", `42/item_deleted/${token("create_item")}`), "tok")).toBeNull();
});

test("each event starts only the right triggers, under the webhook's id", async () => {
  const at = { boardId: 42, pulseId: 7, triggerTime: "2026-11-22T10:00:00.000Z", subscriptionId: 5, triggerUuid: "u", app: "monday" };
  const cases: [string, object, string[]][] = [
    ["create_item", { type: "create_pulse" }, ["item_created"]],
    ["change_column_value", { type: "update_column_value", columnId: "status" }, ["item_column_value_updated"]],
    ["create_update", { type: "create_update", updateId: 3, replyId: null }, ["item_update_posted"]],
    ["create_update", { type: "create_update", updateId: 3, replyId: 4 }, ["item_update_reply_posted"]],
    ["create_subitem", { type: "create_pulse", parentItemId: "7" }, ["subitem_created"]],
    ["item_moved_to_any_group", { type: "move_pulse_into_group", destGroupId: "done" }, ["item_moved_to_group"]],
  ];
  for (const [event, e, want] of cases) {
    const [out] = await (await monday.push!.receive!(delivery({ event: { ...at, ...e } }, event), "tok"))!.events();
    expect(out!.triggers).toEqual(want);
    expect(out!.watch).toBe(`monday:c1:42:${event}`);
    expect(out!.data).not.toHaveProperty("subscriptionId");
  }
  // a retry is the same event
  const once = async () => (await (await monday.push!.receive!(delivery({ event: at }), "tok"))!.events())[0]!.id;
  expect(await once()).toBe(await once());
});

test("filters narrow what runs", () => {
  const data = { columnId: "status", groupId: "topics" };
  expect(wanted({ board_id: "42" }, data)).toBe(true);
  expect(wanted({ column_id: "status" }, data)).toBe(true);
  expect(wanted({ column_id: "date4" }, data)).toBe(false);
  expect(wanted({ group_id: "topics" }, data)).toBe(true);
  expect(wanted({ group_id: "done" }, { destGroupId: "done", groupId: "topics" })).toBe(true);
  expect(wanted({ group_id: "done" }, data)).toBe(false);
});

test("every Composio trigger is here, and each needs a board", () => {
  const composio = ["column_created", "item_archived", "item_column_value_updated", "item_created", "item_deleted", "item_moved_to_group", "item_name_updated", "item_update_deleted", "item_update_edited", "item_update_posted", "item_update_reply_posted", "subitem_archived", "subitem_column_value_updated", "subitem_created", "subitem_deleted", "subitem_name_updated", "subitem_update_posted"];
  for (const t of composio) expect(triggers).toHaveProperty(t);
  for (const t of Object.values(triggers)) expect(t.config[0]).toMatchObject({ name: "board_id", required: true });
});
