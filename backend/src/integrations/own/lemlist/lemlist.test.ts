import { afterEach, beforeAll, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { AppsError } from "../../types";
import { own } from "../index";
import { pollTrigger } from "../../polls/index";
import { triggers, wanted } from "./triggers";
import { lemlist } from "./index";

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
const login = { externalId: "c1", secret: "key" };
const target = "https://api.test/webhooks/app/lemlist/c1";
const secret = () => createHmac("sha256", process.env.ENCRYPTION_KEY!).update("lemlist-webhook:c1").digest("hex").slice(0, 32);
const delivery = (body: unknown) => ({ body: JSON.stringify(body), headers: {}, connection: "c1", rest: "" });
const event = (type: string, extra: object = {}) => ({ _id: "act_1", type, campaignId: "cam_1", sendUserId: "usr_1", createdAt: "2026-11-22T10:00:00Z", secret: secret(), ...extra });
const fire = async (body: unknown) => (await (await lemlist.push!.receive!(delivery(body), "k"))!.events())[0]?.triggers ?? [];

test("a key is checked with basic auth (empty login) and labelled with the team, and a bad one is refused as dead", async () => {
  const calls = stub(() => json({ _id: "tea_1", name: "Northwind" }));
  expect(await own.connectWithKey!("lemlist", " key ")).toEqual({ secret: "key", label: "Northwind" });
  expect(calls[0]!.url).toBe("https://api.lemlist.com/api/team");
  expect(calls[0]!.headers.Authorization).toBe(`Basic ${Buffer.from(":key").toString("base64")}`);
  stub(() => new Response("Unauthorized", { status: 401 }));
  const refused = await own.connectWithKey!("lemlist", "nope").catch((e) => e);
  expect(refused).toBeInstanceOf(AppsError);
  expect(refused.expired).toBe(true);
});

test("actions send the path, query and body lemlist expects", async () => {
  const calls = stub(() => json({ _id: "lea_1" }));
  await own.run("lemlist.create_lead_in_campaign", { campaignId: "cam_1", email: "sarah@northwind.com", firstName: "Sarah" }, login, "o");
  expect(calls[0]!.method).toBe("POST");
  expect(calls[0]!.url).toStartWith("https://api.lemlist.com/api/campaigns/cam_1/leads/");
  expect(JSON.parse(calls[0]!.body)).toMatchObject({ email: "sarah@northwind.com", firstName: "Sarah" });
  await own.run("lemlist.get_campaign_by_id", { campaignId: "cam_1" }, login, "o");
  expect(calls[1]!.url).toBe("https://api.lemlist.com/api/campaigns/cam_1");
});

test("reads run unasked, writes ask, and the team (with its Slack address) asks first", async () => {
  for (const a of ["get_campaign_by_id", "list_contacts", "get_campaign_stats", "search_people_database", "search_companies_database", "get_batch_campaign_stats"])
    expect((await own.getAction(`lemlist.${a}`))?.readOnly).toBe(true);
  for (const a of ["create_lead_in_campaign", "send_inbox_email", "start_campaign", "delete_contact", "enrich_data", "purchase_domain", "get_team_info"])
    expect((await own.getAction(`lemlist.${a}`))?.readOnly).toBe(false);
});

test("the first automation makes one all-events webhook with our secret, the next reuses it, a disabled one is replaced", async () => {
  const none = stub((c) => (c.method === "GET" ? json([]) : json({ _id: "hoo_1" })));
  expect(await own.startPush!("lemlist.email_replied", login, {})).toBe("lemlist:c1");
  expect(none[0]!.url).toBe("https://api.lemlist.com/api/hooks");
  expect(none[1]!.method).toBe("POST");
  expect(JSON.parse(none[1]!.body)).toEqual({ targetUrl: target, secret: secret() });
  const live = { _id: "hoo_1", targetUrl: target };
  const same = stub(() => json([live, { _id: "hoo_2", targetUrl: "https://other" }]));
  await own.startPush!("lemlist.linkedin_invite_accepted", login, {});
  expect(same).toHaveLength(1);
  const off = stub((c) => (c.method === "GET" ? json([{ ...live, disabled: true }]) : json({ _id: "hoo_3" })));
  await own.startPush!("lemlist.email_opened", login, {});
  expect(off.slice(1).map((c) => `${c.method} ${c.url}`)).toEqual(["DELETE https://api.lemlist.com/api/hooks/hoo_1", "POST https://api.lemlist.com/api/hooks"]);
});

test("the last automation removes only our webhook", async () => {
  const calls = stub((c) => (c.method === "GET" ? json([{ _id: "hoo_2", targetUrl: "https://other" }, { _id: "hoo_1", targetUrl: target }]) : json({})));
  await lemlist.push!.stop!("k", "lemlist:c1");
  expect(calls.slice(1).map((c) => `${c.method} ${c.url}`)).toEqual(["DELETE https://api.lemlist.com/api/hooks/hoo_1"]);
});

test("a wrong or missing secret is refused", async () => {
  expect(await lemlist.push!.receive!(delivery(event("emailsReplied", { secret: "nope" })), "k")).toBeNull();
  const { secret: _, ...bare } = event("emailsReplied");
  expect(await lemlist.push!.receive!(delivery(bare), "k")).toBeNull();
  expect(await lemlist.push!.receive!({ ...delivery({}), body: "not json" }, "k")).toBeNull();
});

test("each event starts only its trigger, without the secret, and a retry has the same id", async () => {
  expect(await fire(event("emailsReplied"))).toEqual(["email_replied"]);
  expect(await fire(event("warmed"))).toEqual(["lead_replied"]);
  expect(await fire(event("linkedinInviteAccepted"))).toEqual(["linkedin_invite_accepted"]);
  expect(await fire(event("entityUnsubscribed"))).toEqual(["contact_unsubscribed"]);
  expect(await fire(event("mystery"))).toEqual([]);
  const [a] = await (await lemlist.push!.receive!(delivery(event("emailsOpened")), "k"))!.events();
  const [b] = await (await lemlist.push!.receive!(delivery(event("emailsOpened")), "k"))!.events();
  expect(a!.id).toBe(b!.id!);
  expect(a!.id).toStartWith("c1:");
  expect(a!.data).not.toHaveProperty("secret");
  // a re-found signal is news again; enrichment events have no _id
  const [s1] = await (await lemlist.push!.receive!(delivery(event("signalRegistered", { receivedAt: "1" })), "k"))!.events();
  const [s2] = await (await lemlist.push!.receive!(delivery(event("signalRegistered", { receivedAt: "2" })), "k"))!.events();
  expect(s1!.id).not.toBe(s2!.id!);
  expect(await fire({ type: "enrichmentDone", data: [{ id: "enr_1" }], secret: secret() })).toEqual(["enrichment_done"]);
});

test("filters narrow what runs", () => {
  const data = { type: "emailsReplied", campaignId: "cam_1", sendUserId: "usr_1" };
  expect(wanted({}, data)).toBe(true);
  expect(wanted({ campaign_id: "cam_1", sender_id: "usr_1" }, data)).toBe(true);
  expect(wanted({ campaign_id: "cam_2" }, data)).toBe(false);
  expect(wanted({ sender_id: "usr_2" }, data)).toBe(false);
});

test("every lemlist webhook event has a trigger", () => {
  for (const t of ["email_sent", "email_opened", "email_clicked", "email_replied", "email_bounced", "linkedin_replied", "whatsapp_replied", "sms_replied", "lead_interested", "campaign_completed", "new_signal"])
    expect(triggers[t]).toBeDefined();
  expect(Object.keys(triggers).length).toBeGreaterThanOrEqual(79);
});

test("polls report only recent campaigns and companies", async () => {
  const now = new Date().toISOString();
  const seen: [string, unknown][] = [];
  const run = async (action: string, input: unknown) => {
    seen.push([action, input]);
    const rows = [{ _id: "a", createdAt: now }, { _id: "b", createdAt: "2020-01-01T00:00:00Z" }];
    return action === "lemlist.get_many_campaigns" ? rows : { data: rows, total: 2 };
  };
  expect((await pollTrigger("lemlist.new_campaign")!.poll({}, run)).map((i) => i.id)).toEqual(["a"]);
  expect((await pollTrigger("lemlist.new_company")!.poll({ list_id: "clt_1" }, run)).map((i) => i.id)).toEqual(["a"]);
  expect(seen[1]).toEqual(["lemlist.list_companies", { sortBy: "createdAt", sortOrder: "desc", limit: 500, listId: "clt_1" }]);
});
