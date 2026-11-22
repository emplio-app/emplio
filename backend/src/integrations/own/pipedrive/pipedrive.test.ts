import { afterEach, beforeAll, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { AppsError } from "../../types";
import { own } from "../index";
import { pollTrigger } from "../../polls/index";
import { triggers, wanted } from "./triggers";
import { pipedrive } from "./index";

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
    const c = { url: String(url), method: init.method ?? "GET", body: init.body instanceof FormData ? "form" : String(init.body ?? ""), headers: init.headers as Record<string, string> };
    calls.push(c);
    return answer(c);
  }) as typeof fetch;
  return calls;
};
const login = { externalId: "c1", secret: "tok" };
const target = "https://api.test/webhooks/app/pipedrive/c1";
const password = () => createHmac("sha256", process.env.ENCRYPTION_KEY!).update("pipedrive-webhook:c1").digest("hex").slice(0, 32);
const basic = (pass = password()) => `Basic ${Buffer.from(`emplio:${pass}`).toString("base64")}`;
const delivery = (body: unknown, authorization = basic()) => ({ body: JSON.stringify(body), headers: { authorization }, connection: "c1", rest: "" });
const event = (entity: string, action: string, data: unknown, previous?: unknown) => ({ meta: { id: "m1", action, entity, entity_id: "7", timestamp: "2026-11-22T10:00:00Z", permitted_user_ids: [1, 2] }, data, previous });
const fire = async (body: unknown) => (await (await pipedrive.push!.receive!(delivery(body), "k"))!.events())[0]?.triggers ?? [];

test("a token is checked with x-api-token and labelled, and a bad one is refused as dead", async () => {
  const calls = stub(() => json({ success: true, data: { id: 1, name: "Sarah", company_name: "Northwind" } }));
  expect(await own.connectWithKey!("pipedrive", " tok ")).toEqual({ secret: "tok", label: "Sarah (Northwind)" });
  expect(calls[0]!.url).toBe("https://api.pipedrive.com/v1/users/me");
  expect(calls[0]!.headers["x-api-token"]).toBe("tok");
  expect(calls[0]!.headers.Authorization).toBeUndefined();
  stub(() => json({ success: false, error: "unauthorized access" }, 401));
  const refused = await own.connectWithKey!("pipedrive", "nope").catch((e) => e);
  expect(refused).toBeInstanceOf(AppsError);
  expect(refused.expired).toBe(true);
});

test("v2 calls go to /api/v2, v1-only calls to /v1, and an error with a 200 still fails", async () => {
  const calls = stub(() => json({ success: true, data: {} }));
  await own.run("pipedrive.add_a_deal", { title: "Big order", value: 5000 }, login, "o");
  expect(calls[0]!.url).toBe("https://api.pipedrive.com/api/v2/deals");
  expect(JSON.parse(calls[0]!.body)).toEqual({ title: "Big order", value: 5000 });
  await own.run("pipedrive.add_note", { content: "Called", deal_id: 3 }, login, "o");
  expect(calls[1]!.url).toBe("https://api.pipedrive.com/v1/notes");
  stub(() => json({ success: false, error: "Deal not found" }));
  await expect(own.run("pipedrive.get_deal", { id: 9 }, login, "o")).rejects.toThrow(/Deal not found/);
});

test("reads run unasked, writes ask, and webhook passwords ask first", async () => {
  expect((await own.getAction("pipedrive.get_deal"))?.readOnly).toBe(true);
  expect((await own.getAction("pipedrive.search_persons"))?.readOnly).toBe(true);
  expect((await own.getAction("pipedrive.add_a_deal"))?.readOnly).toBe(false);
  expect((await own.getAction("pipedrive.delete_deal"))?.readOnly).toBe(false);
  expect((await own.getAction("pipedrive.get_all_webhooks"))?.readOnly).toBe(false);
});

test("a downloaded file comes back as a file", async () => {
  stub(() => new Response(new Uint8Array([37, 80, 68, 70]), { headers: { "content-type": "application/pdf" } }));
  const got = (await own.run("pipedrive.download_file", { id: 5 }, login, "o")) as { mimetype?: string };
  expect(got.mimetype).toBe("application/pdf");
});

test("the first automation makes the webhook with our basic auth, the next reuses it, a switched-off one is replaced", async () => {
  const none = stub((c) => (c.method === "GET" ? json({ success: true, data: [] }) : json({ success: true, data: { id: 3 } })));
  expect(await own.startPush!("pipedrive.new_deal", login, {})).toBe("pipedrive:c1");
  expect(none[0]!.url).toBe("https://api.pipedrive.com/v1/webhooks");
  expect(none[1]!.method).toBe("POST");
  expect(JSON.parse(none[1]!.body)).toEqual({ subscription_url: target, event_action: "*", event_object: "*", name: "Emplio", http_auth_user: "emplio", http_auth_password: password(), version: "2.0" });
  const live = { id: 3, subscription_url: target, event_action: "*", event_object: "*", is_active: 1 };
  const same = stub(() => json({ success: true, data: [live, { ...live, id: 4, subscription_url: "https://other" }] }));
  await own.startPush!("pipedrive.deal_won", login, {});
  expect(same).toHaveLength(1);
  const off = stub((c) => (c.method === "GET" ? json({ success: true, data: [{ ...live, is_active: 0 }] }) : json({ success: true, data: {} })));
  await own.startPush!("pipedrive.deal_won", login, {});
  expect(off.slice(1).map((c) => `${c.method} ${c.url}`)).toEqual(["DELETE https://api.pipedrive.com/v1/webhooks/3", "POST https://api.pipedrive.com/v1/webhooks"]);
});

test("the last automation removes only our webhook", async () => {
  const calls = stub((c) => (c.method === "GET" ? json({ success: true, data: [{ id: 4, subscription_url: "https://other" }, { id: 3, subscription_url: target }] }) : json({ success: true })));
  await pipedrive.push!.stop!("k", "pipedrive:c1");
  expect(calls.slice(1).map((c) => `${c.method} ${c.url}`)).toEqual(["DELETE https://api.pipedrive.com/v1/webhooks/3"]);
});

test("a wrong or missing password is refused", async () => {
  expect(await pipedrive.push!.receive!(delivery(event("deal", "create", { id: 7 }), basic("nope")), "k")).toBeNull();
  expect(await pipedrive.push!.receive!(delivery(event("deal", "create", { id: 7 }), ""), "k")).toBeNull();
});

test("each event starts only the right triggers", async () => {
  expect((await fire(event("deal", "create", { id: 7 }))).sort()).toEqual(["new_deal", "new_deal_trigger"]);
  expect(await fire(event("deal", "change", { id: 7, stage_id: 3, status: "open" }, { stage_id: 2 }))).toEqual(["deal_updated", "deal_stage_changed"]);
  expect(await fire(event("deal", "change", { id: 7, status: "won" }, { status: "open" }))).toEqual(["deal_updated", "deal_won"]);
  expect(await fire(event("deal", "change", { id: 7, status: "lost" }, { status: "open" }))).toEqual(["deal_updated", "deal_lost"]);
  expect(await fire(event("deal", "delete", null, { id: 7 }))).toEqual(["deal_deleted"]);
  expect(await fire(event("person", "create", { id: 7 }))).toEqual(["new_person"]);
  expect(await fire(event("activity", "change", { id: 7, done: true }, { done: false }))).toEqual(["activity_updated", "activity_done"]);
  expect((await fire(event("note", "create", { id: 7 }))).sort()).toEqual(["new_note", "new_note_trigger"]);
  // webhooks v1's words still work
  expect(await fire({ meta: { action: "updated", object: "organization", id: 7 }, current: { id: 7 }, previous: { name: "a" } })).toEqual(["organization_updated"]);
  expect(await fire(event("mystery", "create", { id: 7 }))).toEqual([]);
});

test("the event keeps the item, the changes and who did it, and a retry has the same id", async () => {
  const body = event("deal", "change", { id: 7, value: 10 }, { value: 5 });
  const [a] = await (await pipedrive.push!.receive!(delivery(body), "k"))!.events();
  const [b] = await (await pipedrive.push!.receive!(delivery(body), "k"))!.events();
  expect(a!.id).toBe(b!.id!);
  expect(a!.id).toStartWith("c1:");
  expect(a!.data).toMatchObject({ action: "change", entity: "deal", id: "7", data: { value: 10 }, previous: { value: 5 } });
  expect((a!.data as { meta: object }).meta).not.toHaveProperty("permitted_user_ids");
});

test("filters narrow what runs", () => {
  const data = { action: "change", entity: "deal", id: "7", data: { owner_id: 1, pipeline_id: 2, stage_id: 3, value: 10 }, previous: { value: 5 }, meta: {} };
  expect(wanted({}, data)).toBe(true);
  expect(wanted({ owner_id: 1, pipeline_id: 2, stage_id: 3, field: "value" }, data)).toBe(true);
  expect(wanted({ owner_id: 2 }, data)).toBe(false);
  expect(wanted({ pipeline_id: 9 }, data)).toBe(false);
  expect(wanted({ stage_id: 9 }, data)).toBe(false);
  expect(wanted({ field: "title" }, data)).toBe(false);
  // v1 hands owners back as objects
  expect(wanted({ owner_id: 1 }, { ...data, data: { user_id: { id: 1 } } })).toBe(true);
});

test("every webhook object has new, updated and deleted triggers, plus Composio's names", () => {
  for (const o of ["deal", "person", "organization", "activity", "lead", "note", "product", "pipeline", "stage", "user"])
    for (const t of [`new_${o}`, `${o}_updated`, `${o}_deleted`]) expect(triggers[t]).toBeDefined();
  for (const t of ["new_deal_trigger", "new_note_trigger", "new_organization_trigger"]) expect(triggers[t]).toBeDefined();
});

test("polls report only recent items, and a reply to an email is new again", async () => {
  const now = new Date().toISOString().replace("T", " ").slice(0, 19);
  const run = async (action: string) =>
    action === "pipedrive.get_mail_threads"
      ? { data: [{ id: 1, last_message_timestamp: new Date().toISOString() }] }
      : { data: [{ id: 1, add_time: now }, { id: 2, add_time: "2020-01-01 00:00:00" }] };
  const poll = (t: string) => pollTrigger(`pipedrive.${t}`)!;
  expect((await poll("new_file").poll({}, run)).map((i) => i.id)).toEqual(["1"]);
  expect((await poll("new_project").poll({}, run)).map((i) => i.id)).toEqual(["1"]);
  expect((await poll("new_email").poll({}, run))[0]!.id).toStartWith("1:");
  expect(await poll("new_call_log").poll({}, async () => ({ data: null }))).toEqual([]);
});
