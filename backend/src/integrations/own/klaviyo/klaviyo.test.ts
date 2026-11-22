import { afterEach, expect, test } from "bun:test";
import { AppsError } from "../../types";
// the app and its polls straight, not through own/ and polls/ index, which load every other app too
import { klaviyo as polls } from "../../polls/klaviyo";
import { klaviyo, REVISION } from "./index";

const pollTrigger = (name: string) => polls[name.split(".")[1]!];
const action = (name: string) => klaviyo.actions[name]!;
// as own.run does: the input checked against the action's schema, then sent
const run = (name: string, input: Record<string, unknown>) => action(name).run(action(name).input.parse(input), "pk_test");

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/vnd.api+json" } });
type Call = { url: string; method: string; body: BodyInit | null | undefined; headers: Record<string, string> };
const stub = (answer: (c: Call) => Response) => {
  const calls: Call[] = [];
  globalThis.fetch = (async (url: string, init: RequestInit = {}) => {
    const c = { url: String(url), method: init.method ?? "GET", body: init.body, headers: init.headers as Record<string, string> };
    calls.push(c);
    return answer(c);
  }) as typeof fetch;
  return calls;
};

test("a private key is checked and labelled with the company, and a bad one is refused as dead", async () => {
  const calls = stub(() => json({ data: [{ id: "AbC123", attributes: { contact_information: { organization_name: "Northwind" } } }] }));
  expect(await klaviyo.check("pk_test")).toBe("Northwind");
  expect(calls[0]!.url).toBe("https://a.klaviyo.com/api/accounts");
  expect(calls[0]!.headers.Authorization).toBe("Klaviyo-API-Key pk_test");
  expect(calls[0]!.headers.revision).toBe(REVISION);
  stub(() => json({ errors: [{ status: 401, code: "authentication_failed", detail: "Incorrect authentication credentials." }] }, 401));
  const refused = await klaviyo.check("pk_bad").catch((e) => e);
  expect(refused).toBeInstanceOf(AppsError);
  expect(refused.expired).toBe(true);
});

test("every operation is an action; reads run unasked, writes and reports ask as they should", () => {
  expect(Object.keys(klaviyo.actions).length).toBeGreaterThan(400);
  expect(action("get_profiles").readOnly).toBe(true);
  expect(action("query_campaign_values").readOnly).toBe(true);
  expect(action("create_template_render").readOnly).toBe(true);
  expect(action("create_profile").readOnly).toBe(false);
  expect(action("create_campaign_send_job").readOnly).toBe(false);
  expect(action("delete_list").readOnly).toBe(false);
});

test("a write sends a JSON:API body with the key and version; a client call sends no private key", async () => {
  const calls = stub(() => json({ data: { id: "p1", type: "profile" } }, 201));
  const data = { type: "profile", attributes: { email: "sarah@northwind.example" } };
  await run("create_profile", { data });
  expect(calls[0]!.method).toBe("POST");
  expect(calls[0]!.url).toBe("https://a.klaviyo.com/api/profiles");
  expect(JSON.parse(String(calls[0]!.body))).toEqual({ data });
  expect(calls[0]!.headers.Authorization).toBe("Klaviyo-API-Key pk_test");
  await run("create_client_subscription", { company_id: "AbC123", data: { type: "subscription", attributes: { profile: { data: { type: "profile", attributes: { email: "sarah@northwind.example" } } } }, relationships: { list: { data: { type: "list", id: "L1" } } } } });
  expect(calls[1]!.url).toBe("https://a.klaviyo.com/client/subscriptions?company_id=AbC123");
  expect(calls[1]!.headers.Authorization).toBeUndefined();
  expect(calls[1]!.headers.revision).toBe(REVISION);
});

test("an order trigger finds the Placed Order metric by name and reports each event with its person", async () => {
  const asked: [string, any][] = [];
  const run = async (action: string, input: any) => {
    asked.push([action, input]);
    if (action === "klaviyo.get_metrics")
      return input["page[cursor]"]
        ? { data: [{ id: "M2", type: "metric", attributes: { name: "placed order" } }], links: { next: null } }
        : { data: [{ id: "M1", type: "metric", attributes: { name: "Placed Order" } }, { id: "X", type: "metric", attributes: { name: "Opened Email" } }], links: { next: "https://a.klaviyo.com/api/metrics?page%5Bcursor%5D=abc" } };
    return {
      data: [{ id: `E-${input.filter.match(/"(\w+)"/)[1]}`, type: "event", attributes: { datetime: "2026-11-22T10:00:00+00:00", event_properties: { value: 42 } }, relationships: { metric: { data: { id: "M1", type: "metric" } }, profile: { data: { id: "P1", type: "profile" } } } }],
      included: [{ id: "M1", type: "metric", attributes: { name: "Placed Order" } }, { id: "P1", type: "profile", attributes: { email: "sarah@northwind.example", first_name: "Sarah", location: {} } }],
    };
  };
  const items = await pollTrigger("klaviyo.new_order")!.poll({}, run);
  expect(items.map((i) => i.id)).toEqual(["E-M1", "E-M2"]);
  expect(items[0]!.item).toEqual({ event: { id: "E-M1", metric: "Placed Order", datetime: "2026-11-22T10:00:00+00:00", properties: { value: 42 }, profile: { id: "P1", email: "sarah@northwind.example", first_name: "Sarah" } } });
  const ev = asked.find(([a]) => a === "klaviyo.get_events")![1];
  expect(ev.filter).toMatch(/^equals\(metric_id,"M1"\),greater-than\(datetime,\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ\)$/);
  expect(asked[1]![1]).toEqual({ "page[cursor]": "abc" });
  // new_event takes any metrics by name, and none found means nothing to report
  expect(await pollTrigger("klaviyo.new_event")!.poll({ metric: "Nothing Like This" }, run)).toEqual([]);
});

test("profile changes are new again, campaigns only once sent, and settings narrow the call", async () => {
  const asked: [string, any][] = [];
  const run = async (action: string, input: any) => {
    asked.push([action, input]);
    if (action === "klaviyo.get_campaigns") return { data: [{ id: "C1", type: "campaign", attributes: { status: "Sent" } }, { id: "C2", type: "campaign", attributes: { status: "Draft" } }] };
    return { data: [{ id: "P1", type: "profile", attributes: { email: "sarah@northwind.example", updated: "2026-11-22T10:00:00+00:00" } }] };
  };
  expect((await pollTrigger("klaviyo.profile_updated")!.poll({}, run))[0]!.id).toBe("P1:2026-11-22T10:00:00+00:00");
  expect((await pollTrigger("klaviyo.campaign_sent")!.poll({}, run)).map((i) => i.id)).toEqual(["C1"]);
  await pollTrigger("klaviyo.new_list_member")!.poll({ list_id: "L1" }, run);
  expect(asked.at(-1)).toEqual(["klaviyo.get_list_profiles", expect.objectContaining({ id: "L1", sort: "-joined_group_at" })]);
  await pollTrigger("klaviyo.new_review")!.poll({ max_rating: 2 }, run);
  expect(asked.at(-1)![1].filter).toEndWith(",less-or-equal(rating,2)");
});
