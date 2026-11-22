import { afterEach, expect, test } from "bun:test";
import { z } from "zod";
import { AppFile, AppsError } from "../../types";
// the poll registry first: it loads every app's polls, ours included (polls/<app>.ts import it back)
import { pollOnce } from "../../polls/index";
import { freshdesk as polls } from "../../polls/freshdesk";
import { freshdesk } from "./index";
import { adminActions } from "./admin";
import { contactActions } from "./contacts";
import { knowledgeActions } from "./knowledge";
import { teamActions } from "./team";
import { ticketActions } from "./tickets";

type Call = { method: string; url: URL; headers: Record<string, string>; body: any };
const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

// records every request and answers with reply(call); anything unanswered is a test bug, not a trip to Freshdesk
function stub(reply: (c: Call) => { status?: number; body?: unknown } | undefined = () => ({ body: {} })) {
  const calls: Call[] = [];
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    const raw = init.body;
    const c = { method: init.method!, url: new URL(url), headers: init.headers as Record<string, string>, body: typeof raw === "string" ? JSON.parse(raw) : raw };
    calls.push(c);
    const r = reply(c);
    if (!r) throw new Error(`unexpected ${c.method} ${c.url}`);
    return new Response(r.body === undefined ? "" : JSON.stringify(r.body), { status: r.status ?? 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return calls;
}

const KEY = "northwind.freshdesk.com:abcKEY123";
const BASIC = `Basic ${Buffer.from("abcKEY123:X").toString("base64")}`;
const BASE = "https://northwind.freshdesk.com/api/v2";
const run = (action: string, input: unknown, key = KEY) => {
  const a = freshdesk.actions[action];
  if (!a) throw new Error(`no action ${action}`);
  return a.run(a.input.parse(input), key);
};
const fails = (p: Promise<unknown>) =>
  p.then(
    () => {
      throw new Error("expected it to fail");
    },
    (e: AppsError) => e,
  );

test("no two groups name an action the same, and every input turns into a JSON schema", () => {
  const groups = [ticketActions, contactActions, teamActions, knowledgeActions, adminActions];
  expect(Object.keys(freshdesk.actions)).toHaveLength(groups.reduce((n, g) => n + Object.keys(g).length, 0));
  for (const [name, a] of Object.entries(freshdesk.actions)) {
    expect(name).toMatch(/^[a-z0-9_]+$/);
    expect(() => z.toJSONSchema(a.input, { io: "input" })).not.toThrow();
  }
});

test("reads run unasked and writes ask", () => {
  for (const name of ["get_tickets", "view_ticket", "search_tickets", "get_contacts", "list_custom_object_records", "list_all_ticket_conversations"]) expect(freshdesk.actions[name]!.readOnly).toBe(true);
  for (const name of ["create_ticket", "reply_to_ticket", "delete_contact", "bulk_update_tickets", "hard_delete_contact", "create_api_key"]) expect(freshdesk.actions[name]!.readOnly).toBe(false);
});

test("check accepts the key in any usual shape, sends Basic KEY:X, and names the agent", async () => {
  const calls = stub(() => ({ body: { id: 1, contact: { name: "Sarah Lee", email: "sarah@northwind.com" } } }));
  expect(await freshdesk.check(KEY)).toBe("Sarah Lee (northwind.freshdesk.com)");
  expect(await freshdesk.check("https://northwind.freshdesk.com/:abcKEY123")).toBe("Sarah Lee (northwind.freshdesk.com)");
  expect(await freshdesk.check("northwind:abcKEY123")).toBe("Sarah Lee (northwind.freshdesk.com)");
  expect(calls.map((c) => c.url.href)).toEqual(Array(3).fill(`${BASE}/agents/me`));
  expect(calls[0]!.headers.Authorization).toBe(BASIC);
});

test("a key without the address, or for another host, is refused before calling anyone", async () => {
  const calls = stub();
  for (const bad of ["abcKEY123", "evil.example.com:abcKEY123", "northwind.freshdesk.com.evil.io:abcKEY123", "northwind.freshdesk.com:"]) {
    expect(await fails(freshdesk.check(bad))).toBeInstanceOf(AppsError);
  }
  expect(calls).toHaveLength(0);
});

test("a refused key asks for reconnecting; other failures carry Freshdesk's words", async () => {
  stub(() => ({ status: 401, body: { code: "invalid_credentials", message: "You have to be logged in to perform this action." } }));
  expect((await fails(run("get_tickets", {}))).expired).toBe(true);
  stub(() => ({ status: 400, body: { description: "Validation failed", errors: [{ field: "email", message: "It should be a valid email address", code: "invalid_value" }] } }));
  const e = await fails(run("create_contact", { name: "x", email: "nope" }));
  expect(e.expired).toBe(false);
  expect(e.message).toContain("valid email");
});

test("a ticket is made as JSON with exactly the fields given; lists put filters in the query", async () => {
  const calls = stub(() => ({ body: { id: 7 } }));
  await run("create_ticket", { email: "sarah@northwind.com", subject: "Broken", description: "<p>Help</p>", status: 2, priority: 3, custom_fields: { cf_order: "A1" } });
  expect(calls[0]!.method).toBe("POST");
  expect(calls[0]!.url.href).toBe(`${BASE}/tickets`);
  expect(calls[0]!.headers["Content-Type"]).toBe("application/json");
  expect(calls[0]!.body).toEqual({ email: "sarah@northwind.com", subject: "Broken", description: "<p>Help</p>", status: 2, priority: 3, custom_fields: { cf_order: "A1" } });
  await run("get_tickets", { updated_since: "2026-11-01T00:00:00Z", include: "stats", per_page: 100 });
  expect(calls[1]!.url.href).toBe(`${BASE}/tickets?updated_since=2026-11-01T00%3A00%3A00Z&include=stats&per_page=100`);
  await run("update_ticket", { id: 7, status: 4 });
  expect([calls[2]!.method, calls[2]!.url.pathname, calls[2]!.body]).toEqual(["PUT", "/api/v2/tickets/7", { status: 4 }]);
});

test("a reply with a file goes as multipart: attachments[], cc_emails[] and nested fields Freshdesk's way", async () => {
  const calls = stub(() => ({ body: { id: 9 } }));
  const pdf = new AppFile("invoice.pdf", "application/pdf", new Uint8Array([1, 2, 3]));
  await run("reply_to_ticket", { id: 7, body: "See attached", cc_emails: ["a@x.com", "b@x.com"], attachments: [pdf] });
  const form = calls[0]!.body as FormData;
  expect(calls[0]!.url.href).toBe(`${BASE}/tickets/7/reply`);
  expect(form.get("body")).toBe("See attached");
  expect(form.getAll("cc_emails[]")).toEqual(["a@x.com", "b@x.com"]);
  expect((form.get("attachments[]") as File).name).toBe("invoice.pdf");
  expect(form.has("id")).toBe(false);
  await run("create_ticket", { email: "s@x.com", subject: "s", description: "d", status: 2, priority: 1, custom_fields: { cf_a: "1" }, attachments: [pdf] });
  expect((calls[1]!.body as FormData).get("custom_fields[cf_a]")).toBe("1");
});

test("searches wrap the query in quotes; bulk calls nest under bulk_action", async () => {
  const calls = stub(() => ({ body: { results: [], total: 0 } }));
  await run("search_tickets", { query: "priority:4 AND status:2" });
  expect(calls[0]!.url.searchParams.get("query")).toBe('"priority:4 AND status:2"');
  await run("search_contacts", { query: '"email:\'s@x.com\'"', page: 2 });
  expect(calls[1]!.url.searchParams.get("query")).toBe('"email:\'s@x.com\'"');
  await run("bulk_update_tickets", { ids: [1, 2], properties: { status: 4 } });
  expect(calls[2]!.url.pathname).toBe("/api/v2/tickets/bulk_update");
  expect(calls[2]!.body).toEqual({ bulk_action: { ids: [1, 2], properties: { status: 4 } } });
});

test("custom object records take field[operator] filters in the query", async () => {
  const calls = stub(() => ({ body: { records: [] } }));
  await run("list_custom_object_records", { schema_id: "30", filters: { "age[gte]": 35 }, page_size: 2 });
  expect(calls[0]!.url.pathname).toBe("/api/v2/custom_objects/schemas/30/records");
  expect(calls[0]!.url.searchParams.get("age[gte]")).toBe("35");
  expect(calls[0]!.url.searchParams.get("page_size")).toBe("2");
});

// polled triggers, through the shared pollOnce with a fake "run"
const now = () => new Date().toISOString();
const old = "2020-01-01T00:00:00Z";

test("new_ticket fires once for a new ticket, honouring filters", async () => {
  let list: any[] = [{ id: 1, created_at: now(), updated_at: now(), priority: 1 }];
  const fake = async (action: string, input: any) => {
    expect(action).toBe("freshdesk.get_tickets");
    expect(input.order_by).toBe("created_at");
    return list;
  };
  const first = await pollOnce("freshdesk.new_ticket", {}, null, fake);
  expect(first.fresh).toHaveLength(0);
  list = [...list, { id: 2, created_at: now(), updated_at: now(), priority: 4 }, { id: 3, created_at: now(), updated_at: now(), priority: 1 }];
  const second = await pollOnce("freshdesk.new_ticket", { priority: [4] }, first.seen, fake);
  expect(second.fresh.map((x: any) => x.ticket.id)).toEqual([2]);
});

test("ticket_status_changed fires on a new status, only for the statuses asked", async () => {
  const t = (status: number, at: string) => ({ id: 5, status, created_at: old, updated_at: at, stats: { status_updated_at: at } });
  let list = [t(2, now())];
  const fake = async () => list;
  const first = await pollOnce("freshdesk.ticket_status_changed", { status: [4] }, null, fake);
  list = [t(4, new Date(Date.now() + 1000).toISOString())];
  const second = await pollOnce("freshdesk.ticket_status_changed", { status: [4] }, first.seen, fake);
  expect(second.fresh.map((x: any) => x.ticket.status)).toEqual([4]);
  list = [t(3, new Date(Date.now() + 2000).toISOString())];
  expect((await pollOnce("freshdesk.ticket_status_changed", { status: [4] }, second.seen, fake)).fresh).toHaveLength(0);
});

test("new_reply fires on a customer reply and brings the latest messages; agent replies wait for from: agent", async () => {
  const at = now();
  const list = [{ id: 8, created_at: old, updated_at: at, stats: { requester_responded_at: null, agent_responded_at: at } }];
  const asked: string[] = [];
  const fake = async (action: string) => {
    asked.push(action);
    return action === "freshdesk.get_tickets" ? list : [{ id: 1, body_text: "Thanks!" }];
  };
  expect(await polls.new_reply!.poll({}, fake)).toHaveLength(0);
  const got = await polls.new_reply!.poll({ from: "agent" }, fake);
  expect(got[0]!.id).toBe(`8:${at}`);
  expect((got[0]!.item as any).conversations).toEqual([{ id: 1, body_text: "Thanks!" }]);
  expect(asked).toContain("freshdesk.list_all_ticket_conversations");
});

test("new_contact keeps only contacts made in the last day", async () => {
  const got = await polls.new_contact!.poll({}, async () => [{ id: 1, created_at: now() }, { id: 2, created_at: old }]);
  expect(got.map((x) => x.id)).toEqual(["1"]);
});

test("every polled trigger calls an action that exists", () => {
  for (const a of ["get_tickets", "get_contacts", "get_companies", "list_satisfaction_ratings", "list_all_ticket_conversations"]) expect(freshdesk.actions[a]).toBeDefined();
});
