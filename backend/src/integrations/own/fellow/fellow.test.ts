import { afterEach, beforeAll, expect, test } from "bun:test";
import { AppsError } from "../../types";
import { fellow as polls } from "../../polls/fellow";
import { fellow } from "./index";
import { hookToken } from "./triggers";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});
beforeAll(() => {
  process.env.ENCRYPTION_KEY ??= "test-key";
  process.env.WEBHOOK_URL = "https://api.test";
});
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
type Call = { url: string; method: string; body: string; headers: Record<string, string> };
const stub = (answer: (c: Call) => Response) => {
  const calls: Call[] = [];
  globalThis.fetch = (async (url: string, init: RequestInit = {}) => {
    const c = { url: String(url), method: init.method ?? "GET", body: String(init.body ?? ""), headers: init.headers as Record<string, string> };
    calls.push(c);
    return answer(c);
  }) as typeof fetch;
  return calls;
};
const KEY = "northwind:k123";
const run = (action: string, input: Record<string, unknown>) => {
  const a = fellow.actions[action]!;
  return a.run(a.input.parse(input), KEY);
};
const hook = (status = "active", enabled_events = ["ai_note.generated"]) => ({ id: "w1", url: `https://api.test/webhooks/app/fellow/c1/${hookToken("c1")}`, status, enabled_events });
const delivery = (body: unknown, token = hookToken("c1"), svix = "msg_1") => ({ body: JSON.stringify(body), headers: { "svix-id": svix }, connection: "c1", rest: token });

test("the key goes to the workspace's own host in X-API-KEY, and labels the connection; a bad one is dead", async () => {
  const calls = stub(() => json({ user: { id: "u", email: "sarah@northwind.com", full_name: "Sarah" }, workspace: { id: "w", name: "Northwind", subdomain: "northwind" } }));
  expect(await fellow.check(KEY)).toBe("Sarah (Northwind)");
  expect(calls[0]!.url).toBe("https://northwind.fellow.app/api/v1/me");
  expect(calls[0]!.headers["X-API-KEY"]).toBe("k123");
  await fellow.check("https://Northwind.fellow.app:k123");
  expect(calls[1]!.url).toBe("https://northwind.fellow.app/api/v1/me");
  expect(() => fellow.check("k123")).toThrow(/northwind:YOUR_API_KEY/);
  stub(() => json({ message: "Unauthorized" }, 401));
  const refused = await fellow.check(KEY).catch((e) => e);
  expect(refused).toBeInstanceOf(AppsError);
  expect(refused.expired).toBe(true);
});

test("lists are POSTs with pagination and filters in the body; agenda edits send Fellow Markdown", async () => {
  const calls = stub(() => json({ notes: { page_info: { cursor: null }, data: [] } }));
  await run("list_notes", { pagination: { page_size: 10 }, filters: { title: "Weekly" }, include: { content_markdown: true } });
  expect(`${calls[0]!.method} ${calls[0]!.url}`).toBe("POST https://northwind.fellow.app/api/v1/notes");
  expect(JSON.parse(calls[0]!.body)).toMatchObject({ pagination: { page_size: 10 }, include: { content_markdown: true }, filters: { title: "Weekly" } });
  await run("append_note_agenda", { note_id: "n1", content_fellow_markdown: "- Pricing" });
  expect(`${calls[1]!.method} ${calls[1]!.url}`).toBe("POST https://northwind.fellow.app/api/v1/note/n1/agenda/append");
  expect(JSON.parse(calls[1]!.body)).toEqual({ content_fellow_markdown: "- Pricing" });
  stub(() => json({ message: "find must match exactly once" }, 422));
  await expect(run("find_replace_note_agenda", { note_id: "n1", find: "x", content_fellow_markdown: "y" })).rejects.toThrow(/exactly once/);
});

test("reads run unasked, writes ask", () => {
  for (const a of ["get_me", "list_notes", "get_note", "list_recordings", "get_recording", "list_action_items", "list_uploads", "get_upload", "list_webhooks"]) expect(fellow.actions[a]?.readOnly).toBe(true);
  for (const a of ["delete_note", "delete_recording", "upload_recording", "append_note_agenda", "replace_note_agenda", "mark_action_item_complete", "archive_action_item", "create_webhook", "delete_webhook"])
    expect(fellow.actions[a]?.readOnly).toBeFalsy();
});

test("the first automation makes the webhook, the next event joins it, the last removes it", async () => {
  const made = stub((c) => (c.method === "GET" ? json({ webhooks: { page_info: { cursor: null }, data: [{ id: "x", url: "https://other", status: "active", enabled_events: [] }] } }) : json({ webhook: { id: "w1" } })));
  expect(await fellow.push!.start(KEY, "c1", "ai_note.generated", {})).toBe("fellow:c1");
  expect(made[0]!.url).toBe("https://northwind.fellow.app/api/v1/webhooks?page_size=50");
  expect(`${made[1]!.method} ${made[1]!.url}`).toBe("POST https://northwind.fellow.app/api/v1/webhook");
  expect(JSON.parse(made[1]!.body)).toEqual({ url: `https://api.test/webhooks/app/fellow/c1/${hookToken("c1")}`, enabled_events: ["ai_note.generated"], description: "Emplio automations" });
  const same = stub(() => json({ webhooks: { page_info: { cursor: null }, data: [hook()] } }));
  await fellow.push!.start(KEY, "c1", "ai_note.generated", {});
  expect(same).toHaveLength(1);
  const more = stub((c) => (c.method === "GET" ? json({ webhooks: { page_info: { cursor: null }, data: [hook("failed")] } }) : json({})));
  await fellow.push!.start(KEY, "c1", "action_item.completed", {});
  expect(`${more[1]!.method} ${more[1]!.url}`).toBe("PATCH https://northwind.fellow.app/api/v1/webhook/w1");
  expect(JSON.parse(more[1]!.body)).toEqual({ enabled_events: ["ai_note.generated", "action_item.completed"], status: "active" });
  const gone = stub((c) => (c.method === "GET" ? json({ webhooks: { page_info: { cursor: null }, data: [hook()] } }) : json({ deleted: true })));
  await fellow.push!.stop!(KEY, "fellow:c1");
  expect(`${gone[1]!.method} ${gone[1]!.url}`).toBe("DELETE https://northwind.fellow.app/api/v1/webhook/w1");
});

test("a wrong token is refused; Fellow's address check gets its challenge back as text", async () => {
  expect(await fellow.push!.receive!(delivery({ event_type: "ai_note.generated" }, "wrong"), KEY)).toBeNull();
  expect(await fellow.push!.receive!(delivery({ event_type: "ai_note.generated" }, ""), KEY)).toBeNull();
  const check = await fellow.push!.receive!(delivery({ type: "url_verification", challenge: "abc" }), KEY);
  expect(check!.reply).toBe("abc");
  expect(check!.headers).toEqual({ "content-type": "text/plain" });
  expect(await check!.events()).toEqual([]);
});

test("each event starts only its trigger, the transcript goes last, and a channel filter applies", async () => {
  const fire = async (body: unknown) => (await (await fellow.push!.receive!(delivery(body), KEY))!.events())[0];
  const notes = await fire({ event_type: "ai_note.generated", id: "n1", transcript: "Sarah: hi", event_title: "Sync", ai_notes: "# Summary" });
  expect(notes!.triggers).toEqual(["ai_notes_ready"]);
  expect(notes!.id).toBe("fellow:c1:msg_1");
  expect(Object.keys(notes!.data as object)).toEqual(["id", "event_title", "ai_notes", "transcript"]);
  expect((await fire({ event_type: "action_item.completed", id: "a1" }))!.triggers).toEqual(["action_item_completed"]);
  expect((await fire({ event_type: "action_item.assigned", id: "a1" }))!.triggers).toEqual(["action_item_assigned"]);
  const shared = await fire({ event_type: "ai_note.shared_to_channel", id: "n1", channel_id: "ch1" });
  expect(shared!.triggers).toEqual(["ai_notes_shared_to_channel"]);
  expect(fellow.push!.wanted!({ channel_id: "ch1" }, shared!.data)).toBe(true);
  expect(fellow.push!.wanted!({ channel_id: "ch2" }, shared!.data)).toBe(false);
  expect(await fire({ event_type: "something.new", id: "x" })).toBeUndefined();
});

test("polls report notes, recordings and action items from the last day", async () => {
  const now = new Date().toISOString();
  const asked: [string, any][] = [];
  const run = async (action: string, input: any) => {
    asked.push([action, input]);
    const field = { "fellow.list_notes": "notes", "fellow.list_recordings": "recordings", "fellow.list_action_items": "action_items" }[action]!;
    return { [field]: { data: [{ id: "new", created_at: now }, { id: "old", created_at: "2020-01-01T00:00:00Z" }] } };
  };
  expect((await polls.new_note!.poll({ channel_id: "ch1" }, run)).map((i) => i.id)).toEqual(["new"]);
  expect(asked[0]![1].filters.channel_id).toBe("ch1");
  expect((await polls.new_recording!.poll({}, run)).map((i) => i.id)).toEqual(["new"]);
  expect((await polls.new_action_item!.poll({ scope: "all" }, run)).map((i) => i.id)).toEqual(["new"]);
  expect(asked[2]![1]).toMatchObject({ order_by: "created_at_desc", filters: { scope: "all" } });
});
