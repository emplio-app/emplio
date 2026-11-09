import { afterEach, beforeAll, expect, test } from "bun:test";
import { AppsError } from "../../types";
import { pollOnce } from "../../polls";
import { own } from "../index";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});
beforeAll(() => {
  process.env.ENCRYPTION_KEY ??= "test-key";
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
const login = { externalId: "c1", secret: "pat-na1-x" };

test("a token is checked and labelled, one without the scope is still good, a bad one is refused", async () => {
  const calls = stub(() => json({ portalId: 123 }));
  expect(await own.connectWithKey!("hubspot", " pat-na1-x ")).toEqual({ secret: "pat-na1-x", label: "HubSpot account 123" });
  expect(calls[0]!.url).toBe("https://api.hubapi.com/account-info/v3/details");
  expect(calls[0]!.headers.Authorization).toBe("Bearer pat-na1-x");
  stub(() => json({ message: "missing scopes", category: "MISSING_SCOPES" }, 403));
  expect(await own.connectWithKey!("hubspot", "pat-na1-x")).toEqual({ secret: "pat-na1-x" });
  stub(() => json({ message: "invalid token" }, 401));
  await expect(own.connectWithKey!("hubspot", "nope")).rejects.toBeInstanceOf(AppsError);
});

test("reads run unasked, writes ask, a search POST runs unasked", async () => {
  expect((await own.getAction("hubspot.list_contacts"))?.readOnly).toBe(true);
  expect((await own.getAction("hubspot.search_contacts_by_criteria"))?.readOnly).toBe(true);
  expect((await own.getAction("hubspot.read_contacts"))?.readOnly).toBe(true);
  expect((await own.getAction("hubspot.create_contact"))?.readOnly).toBe(false);
  expect((await own.getAction("hubspot.update_deal"))?.readOnly).toBe(false);
  expect((await own.getAction("hubspot.remove_deal"))?.readOnly).toBe(false);
});

test("Composio's names are kept, and the calls go where they should", async () => {
  const calls = stub(() => json({ id: "1" }));
  await own.run("hubspot.get_deal", { dealId: "9" }, login, "o");
  expect(calls[0]!.url).toStartWith("https://api.hubapi.com/crm/v3/objects/0-3/9");
  await own.run("hubspot.create_contact", { properties: { email: "a@b.co" } }, login, "o");
  expect(calls[1]!.method).toBe("POST");
  expect(JSON.parse(calls[1]!.body)).toEqual({ properties: { email: "a@b.co" } });
  await own.run("hubspot.enroll_contact_in_workflow", { workflowId: "5", email: "a@b.co" }, login, "o");
  expect(calls[2]!.url).toBe("https://api.hubapi.com/automation/v2/workflows/5/enrollments/contacts/a%40b.co");
});

const row = (id: string, properties: Record<string, string>) => ({ id, properties, updatedAt: "2026-11-09T00:00:00Z" });

test("a polled trigger's first check only notes what's there, then reports what's new", async () => {
  const results = [{ results: [row("1", {})] }, { results: [row("1", {}), row("2", {})] }];
  const run = async () => results.shift();
  const first = await pollOnce("hubspot.contact_created_trigger", {}, null, run);
  expect(first.fresh).toEqual([]);
  const second = await pollOnce("hubspot.contact_created_trigger", {}, first.seen, run);
  expect(second.fresh).toHaveLength(1);
  expect((second.fresh[0] as any).contact.id).toBe("2");
});

test("polled triggers search by the right property", async () => {
  const asked: any[] = [];
  const run = async (action: string, input: any) => (asked.push({ action, ...input }), { results: [] });
  await pollOnce("hubspot.contact_updated_trigger", {}, null, run);
  expect(asked[0]).toMatchObject({ action: "hubspot.search_contacts_by_criteria", sorts: [{ propertyName: "lastmodifieddate", direction: "DESCENDING" }] });
  await pollOnce("hubspot.company_created_trigger", {}, null, run);
  expect(asked[1].filterGroups[0].filters[0].propertyName).toBe("createdate");
  await pollOnce("hubspot.deal_updated_trigger", {}, null, run);
  expect(asked[2].sorts[0].propertyName).toBe("hs_lastmodifieddate");
});

test("a change counts when the record's edit time moves", async () => {
  const at = (t: string) => ({ results: [row("1", { lastmodifieddate: t })] });
  const results = [at("t1"), at("t1"), at("t2")];
  const run = async () => results.shift();
  let seen = (await pollOnce("hubspot.contact_updated_trigger", {}, null, run)).seen;
  const same = await pollOnce("hubspot.contact_updated_trigger", {}, seen, run);
  expect(same.fresh).toEqual([]);
  seen = same.seen;
  expect((await pollOnce("hubspot.contact_updated_trigger", {}, seen, run)).fresh).toHaveLength(1);
});

test("a deal moving stage fires; an edit in a stage it entered long ago doesn't; filters reach the search", async () => {
  const entered = new Date().toISOString();
  const old = new Date(Date.now() - 5 * 86_400_000).toISOString();
  const deal = (stage: string, at: string) => ({ results: [row("7", { dealstage: stage, hs_v2_date_entered_current_stage: at })] });
  let asked: any;
  const answer = (r: unknown) => async (_: string, input: unknown) => ((asked = input), r);
  const first = await pollOnce("hubspot.deal_stage_updated_trigger", {}, null, answer(deal("a", entered)));
  const moved = await pollOnce("hubspot.deal_stage_updated_trigger", {}, first.seen, answer(deal("b", entered)));
  expect(moved.fresh).toHaveLength(1);
  const edited = await pollOnce("hubspot.deal_stage_updated_trigger", {}, moved.seen, answer(deal("c", old)));
  expect(edited.fresh).toEqual([]);
  await pollOnce("hubspot.deal_stage_updated_trigger", { pipeline: "p", stage: "s" }, null, answer({ results: [] }));
  expect(asked.filterGroups[0].filters).toContainEqual({ propertyName: "pipeline", operator: "EQ", value: "p" });
  expect(asked.filterGroups[0].filters).toContainEqual({ propertyName: "dealstage", operator: "EQ", value: "s" });
});
