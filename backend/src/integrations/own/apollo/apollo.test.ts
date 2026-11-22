import { afterEach, expect, test } from "bun:test";
import { AppsError } from "../../types";
import { own } from "../index";
import { pollTrigger } from "../../polls/index";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
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
const login = { externalId: "c1", secret: "key123" };

test("a key is checked and labelled with the user's name, and a bad one is refused as dead", async () => {
  const calls = stub(() => json({ first_name: "Sarah", last_name: "Lee", email: "sarah@northwind.test" }));
  expect(await own.connectWithKey!("apollo", " key123 ")).toEqual({ secret: "key123", label: "Sarah Lee" });
  expect(calls[0]!.url).toBe("https://api.apollo.io/api/v1/users/api_profile");
  expect(calls[0]!.headers["x-api-key"]).toBe("key123");
  stub(() => json({ error: "Invalid access credentials." }, 401));
  const refused = await own.connectWithKey!("apollo", "bad").catch((e) => e);
  expect(refused).toBeInstanceOf(AppsError);
  expect(refused.expired).toBe(true);
});

test("a key without the profile scope still connects when Apollo says it's logged in", async () => {
  stub((c) => (c.url.endsWith("/users/api_profile") ? json({ error: "api/v1/users/api_profile is not accessible with this api_key" }, 403) : json({ healthy: true, is_logged_in: true })));
  expect((await own.connectWithKey!("apollo", "key123")).label).toBeTruthy();
  stub((c) => (c.url.endsWith("/users/api_profile") ? json({ error: "nope" }, 403) : json({ healthy: true, is_logged_in: false })));
  await expect(own.connectWithKey!("apollo", "key123")).rejects.toThrow(/didn't accept/);
});

test("reads run unasked; writes and anything that spends credits ask", async () => {
  for (const a of ["search_contacts", "people_search", "get_contact", "list_deals", "search_outreach_emails", "get_auth_status"]) expect((await own.getAction(`apollo.${a}`))?.readOnly).toBe(true);
  for (const a of ["create_contact", "send_email_now", "add_contacts_to_sequence", "people_enrichment", "organization_enrichment", "get_organization", "organization_search", "search_news_articles"])
    expect((await own.getAction(`apollo.${a}`))?.readOnly).toBe(false);
});

test("calls go out the way Apollo takes them: arrays in the query repeat their key[], bodies as JSON", async () => {
  const calls = stub(() => json({ opportunities: [] }));
  await own.run("apollo.list_deals", { "opportunity_stage_ids[]": ["s1", "s2"], per_page: 5 }, login, "o");
  expect(calls[0]!.url).toBe("https://api.apollo.io/api/v1/opportunities/search?opportunity_stage_ids%5B%5D=s1&opportunity_stage_ids%5B%5D=s2&per_page=5");
  await own.run("apollo.create_contact", { first_name: "Sarah", email: "sarah@northwind.test" }, login, "o");
  expect(calls[1]!.method).toBe("POST");
  expect(JSON.parse(String(calls[1]!.body))).toMatchObject({ first_name: "Sarah", email: "sarah@northwind.test" });
  stub(() => json({ error: "Insufficient credits" }, 422));
  await expect(own.run("apollo.people_enrichment", { email: "a@b.test" }, login, "o")).rejects.toThrow(/Insufficient credits/);
});

test("polls report only what's new, and a change, a stage move, a win and a reply each count once", async () => {
  const now = new Date().toISOString();
  const old = "2020-01-01T00:00:00Z";
  const seen: { action: string; input: any }[] = [];
  const run = async (action: string, input: any) => {
    seen.push({ action, input });
    if (action === "apollo.search_contacts") return { contacts: [{ id: "c1", created_at: now, updated_at: now }, { id: "c2", created_at: old, updated_at: old }] };
    if (action === "apollo.list_deals")
      return { opportunities: [{ id: "d1", created_at: now, opportunity_stage_id: "s2", stage_updated_at: now, is_closed: true, is_won: true }, { id: "d2", created_at: old, stage_updated_at: old, is_closed: true, is_won: false }] };
    if (action === "apollo.search_outreach_emails") return { emailer_messages: [{ id: "e1" }] };
    if (action === "apollo.search_tasks") return { tasks: [{ id: "t1", created_at: old, completed_at: now }] };
    if (action === "apollo.list_notes") return { notes: [{ id: "n1", created_at: now }] };
    return {};
  };
  const ids = async (t: string, c = {}) => (await pollTrigger(`apollo.${t}`)!.poll(c, run)).map((i) => i.id);
  expect(await ids("new_contact", { contact_stage_id: "st1" })).toEqual(["c1"]);
  expect(seen.at(-1)!.input).toMatchObject({ sort_by_field: "contact_created_at", contact_stage_ids: ["st1"] });
  expect(await ids("contact_updated")).toEqual([`c1:${now}`]);
  expect(await ids("new_deal")).toEqual(["d1"]);
  expect(await ids("deal_stage_changed")).toEqual([`d1:s2:${now}`]);
  expect(await ids("deal_won", { owner_id: "u1" })).toEqual(["d1:won"]);
  expect(seen.at(-1)!.input).toMatchObject({ opportunity_is_closed: true, "opportunity_owner_ids[]": ["u1"] });
  // d2 closed long ago: editing it today isn't a loss today
  expect(await ids("deal_lost")).toEqual([]);
  expect(await ids("new_task")).toEqual([]);
  expect(await ids("task_completed")).toEqual(["t1:done"]);
  expect(await ids("new_note")).toEqual(["n1"]);
  expect(await ids("email_replied", { reply_class: "willing_to_meet" })).toEqual(["e1:replied"]);
  expect(seen.at(-1)!.input["emailer_message_reply_classes[]"]).toEqual(["willing_to_meet"]);
  expect(await ids("new_call")).toEqual([]);
});
