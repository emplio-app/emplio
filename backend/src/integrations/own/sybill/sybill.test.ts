import { afterEach, expect, test } from "bun:test";
import { AppsError } from "../../types";
import { sybill as polls } from "../../polls/sybill";
import { sybill } from "./index";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
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
const run = (action: string, input: unknown) => {
  const a = sybill.actions[action]!;
  return a.run(a.input.parse(input), "sk_live_k");
};

test("a key is checked against health and labelled with its permissions; a revoked one is refused as dead", async () => {
  const calls = stub(() => json({ status: "ok", org_id: "o1", scopes: ["read", "ask_sybill"] }));
  expect(await sybill.check("sk_live_k")).toBe("Sybill (read, ask_sybill)");
  expect(calls[0]!.url).toBe("https://api.sybill.ai/v1/health");
  expect(calls[0]!.headers.Authorization).toBe("Bearer sk_live_k");
  stub(() => json({ detail: "Invalid API key" }, 401));
  const e = (await sybill.check("nope").catch((x) => x)) as AppsError;
  expect(e).toBeInstanceOf(AppsError);
  expect(e.expired).toBe(true);
});

test("a missing permission says which, without asking to reconnect", async () => {
  stub(() => json({ detail: "API key missing required scope: read" }, 403));
  const e = (await run("list_deals", {}).catch((x) => x)) as AppsError;
  expect(e.message).toContain("missing required scope: read");
  expect(e.expired).toBeFalsy();
});

test("reading and asking run unasked; importing and deleting ask first", () => {
  const a = sybill.actions;
  for (const n of ["list_conversations", "get_conversation", "list_deals", "get_account", "list_messages", "ask_sybill", "get_ask_sybill_result", "check_key"]) expect(a[n]!.readOnly).toBe(true);
  for (const n of ["import_conversation", "delete_imported_conversation", "import_document", "update_imported_row", "create_source", "delete_object_type"]) expect(a[n]!.readOnly).toBe(false);
  expect(Object.keys(a)).toHaveLength(35);
});

test("filters go in the query, and a question goes in the body", async () => {
  const calls = stub(() => json({ conversations: [], pagination: { nextCursor: null, hasMore: false } }));
  await run("list_conversations", { attendees: "@northwind.com", startedAfter: "2026-11-01T00:00:00Z", limit: 10 });
  const url = new URL(calls[0]!.url);
  expect(url.pathname).toBe("/v1/conversations");
  expect(Object.fromEntries(url.searchParams)).toMatchObject({ attendees: "@northwind.com", startedAfter: "2026-11-01T00:00:00Z", limit: "10" });
  await run("ask_sybill", { message: "Which Northwind deals are at risk?" });
  expect(calls[1]!.method).toBe("POST");
  expect(JSON.parse(calls[1]!.body)).toMatchObject({ message: "Which Northwind deals are at risk?" });
});

// polls/sybill.ts: the poller hands it a way to run actions
const runner = (pages: Record<string, unknown[]>) => {
  const seen: [string, any][] = [];
  const run = async (action: string, input: any) => {
    seen.push([action, input]);
    const list = pages[action]!;
    return list[input.cursor ? Number(input.cursor) : 0];
  };
  return { seen, run };
};

test("new calls: recent ones, every page, with the automation's filters", async () => {
  const { seen, run } = runner({
    "sybill.list_conversations": [
      { conversations: [{ conversationId: "c1" }], pagination: { nextCursor: "1", hasMore: true } },
      { conversations: [{ conversationId: "c2" }], pagination: { nextCursor: null, hasMore: false } },
    ],
  });
  const items = await polls.new_conversation!.poll({ attendees: "sarah@northwind.test" }, run);
  expect(items.map((i) => i.id)).toEqual(["c1", "c2"]);
  expect(seen[0]![1]).toMatchObject({ attendees: "sarah@northwind.test", limit: 50 });
  expect(Date.now() - Date.parse(seen[0]![1].startedAfter)).toBeLessThan(86_400_000 + 1000);
  expect(seen[0]![1]).not.toHaveProperty("title");
  expect(seen[1]![1].cursor).toBe("1");
});

test("a deal's stage is part of its id, so a move is new; the stage filter keeps only moves into it", async () => {
  const { run } = runner({ "sybill.list_deals": [{ deals: [{ dealId: "d1", stage: "Negotiation" }, { dealId: "d2", stage: "Discovery" }], pagination: { nextCursor: null } }] });
  expect((await polls.deal_stage_changed!.poll({}, run)).map((i) => i.id)).toEqual(["d1:Negotiation", "d2:Discovery"]);
  expect((await polls.deal_stage_changed!.poll({ stage: "negotiation" }, run)).map((i) => i.id)).toEqual(["d1:Negotiation"]);
});

test("new deals are only those created in the last day", async () => {
  const now = new Date().toISOString();
  const { run } = runner({ "sybill.list_deals": [{ deals: [{ dealId: "d1", createdDate: now }, { dealId: "d2", createdDate: "2025-01-01T00:00:00Z" }], pagination: {} }] });
  expect((await polls.new_deal!.poll({}, run)).map((i) => i.id)).toEqual(["d1"]);
});
