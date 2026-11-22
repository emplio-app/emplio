import { afterEach, expect, test } from "bun:test";
import { AppsError } from "../../types";
import { own } from "../index";
import { pollOnce } from "../../polls/index";

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
const login = { externalId: "c1", secret: "pit-abc LOC1" };
const agency = { externalId: "c2", secret: "pit-agency" };
const now = () => new Date().toISOString();

test("a sub-account token and Location ID are checked and labelled with the business's name", async () => {
  const calls = stub(() => json({ location: { id: "LOC1", name: "Northwind Dental" } }));
  expect(await own.connectWithKey!("gohighlevel", " pit-abc   LOC1 ")).toEqual({ secret: "pit-abc   LOC1", label: "Northwind Dental" });
  expect(calls[0]!.url).toBe("https://services.leadconnectorhq.com/locations/LOC1");
  expect(calls[0]!.headers.Authorization).toBe("Bearer pit-abc");
  expect(calls[0]!.headers.Version).toBeTruthy();
});

test("a bad token is refused as dead, a missing scope is not", async () => {
  stub(() => json({ statusCode: 401, message: "Invalid JWT" }, 401));
  const dead = await own.connectWithKey!("gohighlevel", "nope LOC1").catch((e) => e);
  expect(dead).toBeInstanceOf(AppsError);
  expect(dead.expired).toBe(true);
  stub(() => json({ statusCode: 401, message: "The token is not authorized for this scope." }, 401));
  const scope: any = await own.run("gohighlevel.get_contact", { contactId: "k1" }, login, "o").catch((e) => e);
  expect(scope).toBeInstanceOf(AppsError);
  expect(scope.expired).toBeFalsy();
});

test("an agency token alone is checked by listing its sub-accounts", async () => {
  const calls = stub(() => json({ locations: [{ id: "L9" }] }));
  expect((await own.connectWithKey!("gohighlevel", "pit-agency")).label).toBe("HighLevel agency");
  expect(calls[0]!.url).toContain("/locations/search");
});

test("reads run unasked, writes ask", async () => {
  for (const a of ["get_contact", "search_contacts", "search_opportunities", "get_calendar_events", "list_invoices"]) expect((await own.getAction(`gohighlevel.${a}`))?.readOnly).toBe(true);
  for (const a of ["create_contact", "delete_contact", "send_message", "create_opportunity", "send_invoice"]) expect((await own.getAction(`gohighlevel.${a}`))?.readOnly).toBe(false);
});

test("the sub-account and API version are filled in, not asked of the agent", async () => {
  const fields = (await own.getAction("gohighlevel.create_contact"))!.input;
  expect(fields.map((f) => f.name)).not.toContain("version");
  expect(fields.find((f) => f.name === "locationId")?.required).toBe(false);

  const calls = stub(() => json({ contact: { id: "k1" } }));
  await own.run("gohighlevel.create_contact", { firstName: "Sarah", email: "sarah@example.com" }, login, "o");
  expect(calls[0]!.method).toBe("POST");
  expect(JSON.parse(calls[0]!.body)).toEqual({ firstName: "Sarah", email: "sarah@example.com", locationId: "LOC1" });
  expect(calls[0]!.headers.Version).toBeTruthy();

  await own.run("gohighlevel.list_invoices", { limit: "10", offset: "0" }, login, "o");
  expect(calls[1]!.url).toContain("altId=LOC1");
  expect(calls[1]!.url).toContain("altType=location");

  await own.run("gohighlevel.get_calendars", { locationId: "OTHER" }, login, "o");
  expect(calls[2]!.url).toContain("locationId=OTHER");
});

test("an agency token sends only the locationId the agent gives", async () => {
  const calls = stub(() => json({ calendars: [] }));
  await own.run("gohighlevel.get_calendars", {}, agency, "o");
  expect(calls[0]!.url).not.toContain("locationId");
  expect(calls[0]!.headers.Authorization).toBe("Bearer pit-agency");
});

test("contact search sends its filters and sort", async () => {
  const calls = stub(() => json({ contacts: [] }));
  await own.run("gohighlevel.search_contacts", { query: "sarah", pageLimit: 5, sort: [{ field: "dateAdded", direction: "desc" }] }, login, "o");
  expect(JSON.parse(calls[0]!.body)).toEqual({ query: "sarah", pageLimit: 5, sort: [{ field: "dateAdded", direction: "desc" }], locationId: "LOC1" });
});

// polls: the first check only notes what's there, the next starts on what's new
const poll = async (trigger: string, config: object, first: unknown, second: unknown) => {
  const run = (answer: unknown) => async () => answer;
  const one = await pollOnce(`gohighlevel.${trigger}`, config, null, run(first));
  return (await pollOnce(`gohighlevel.${trigger}`, config, one.seen, run(second))).fresh as any[];
};

test("a new contact starts new_contact once", async () => {
  const a = { id: "a", dateAdded: now(), dateUpdated: now() };
  const b = { id: "b", dateAdded: now(), dateUpdated: now() };
  const fresh = await poll("new_contact", {}, { contacts: [a] }, { contacts: [b, a] });
  expect(fresh.map((f) => f.contact.id)).toEqual(["b"]);
});

test("a changed contact starts contact_updated each time it changes", async () => {
  const added = "2026-01-01T00:00:00.000Z";
  const before = { id: "a", dateAdded: added, dateUpdated: new Date(Date.now() - 60_000).toISOString() };
  const after = { ...before, dateUpdated: now() };
  expect((await poll("contact_updated", {}, { contacts: [before] }, { contacts: [after] })).length).toBe(1);
  expect((await poll("contact_updated", {}, { contacts: [after] }, { contacts: [after] })).length).toBe(0);
});

test("a deal moving stage starts opportunity_stage_changed, a new deal does not", async () => {
  const created = "2026-01-01T00:00:00.000Z";
  const moved = { id: "o1", createdAt: created, pipelineStageId: "s2", lastStageChangeAt: now() };
  const fresh = await poll("opportunity_stage_changed", {}, { opportunities: [] }, { opportunities: [moved, { id: "o2", createdAt: moved.lastStageChangeAt, lastStageChangeAt: moved.lastStageChangeAt }] });
  expect(fresh.map((f) => f.opportunity.id)).toEqual(["o1"]);
});

test("an inbound message with a time in milliseconds starts new_inbound_message", async () => {
  const c = (t: number) => ({ id: "cv1", lastMessageDate: t, lastMessageBody: "Hi" });
  expect((await poll("new_inbound_message", {}, { conversations: [c(Date.now() - 5000)] }, { conversations: [c(Date.now())] })).length).toBe(1);
});

test("new_appointment looks through every calendar", async () => {
  const asked: string[] = [];
  const run = async (action: string, input: any) => {
    asked.push(action);
    if (action === "gohighlevel.get_calendars") return { calendars: [{ id: "c1" }, { id: "c2" }] };
    return { events: input.calendarId === "c2" && asked.length > 3 ? [{ id: "e1", dateAdded: now() }] : [] };
  };
  const one = await pollOnce("gohighlevel.new_appointment", {}, null, run);
  const two = await pollOnce("gohighlevel.new_appointment", {}, one.seen, run);
  expect(two.fresh).toEqual([{ appointment: { id: "e1", dateAdded: expect.any(String) } }]);
  expect(asked.filter((a) => a === "gohighlevel.get_calendar_events").length).toBe(4);
});

test("invoice_paid asks only for paid invoices", async () => {
  let asked: any;
  await pollOnce("gohighlevel.invoice_paid", {}, null, async (_a, input) => ((asked = input), { invoices: [] }));
  expect(asked.status).toBe("paid");
});
