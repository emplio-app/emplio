import { afterEach, beforeAll, expect, spyOn, test } from "bun:test";
import { createHmac, randomBytes } from "node:crypto";
import Fastify from "fastify";
import { automationRoutes } from "../../../automations";
import { db } from "../../../db";
import { encrypt } from "../../../secrets";
import { AppFile, AppsError } from "../../types";
import { pollTrigger } from "../../polls/index";
import { own } from "../index";
import { karbon } from "./index";
import { triggers, wanted } from "./triggers";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});
beforeAll(() => {
  process.env.ENCRYPTION_KEY = randomBytes(32).toString("base64");
  process.env.WEBHOOK_URL = "https://api.test";
  process.env.KARBON_APP_KEY = "app-guid";
});
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
type Call = { url: string; method: string; body: string; headers: Record<string, string> };
const stub = (answer: (c: Call) => Response) => {
  const calls: Call[] = [];
  globalThis.fetch = (async (url: string, init: RequestInit = {}) => {
    const c = { url: decodeURIComponent(String(url)), method: init.method ?? "GET", body: init.body instanceof FormData ? "form" : String(init.body ?? ""), headers: init.headers as Record<string, string> };
    calls.push(c);
    return answer(c);
  }) as typeof fetch;
  return calls;
};
const login = { externalId: "c1", secret: "eyJaccess" };
const target = "https://api.test/webhooks/app/karbon/c1";
const MULTI = "https://api.karbonhq.com/v3/WebhookSubscriptions/Multi";
const signingKey = () => createHmac("sha256", process.env.ENCRYPTION_KEY!).update("karbon-webhook:c1").digest("hex").slice(0, 40);
const sign = (body: string, key = signingKey()) => createHmac("sha256", key).update(body).digest("hex");
const notice = (ResourceType: string, ActionType: string, extra: object = {}) => ({ ResourcePermaKey: "K1", ResourceType, ActionType, Timestamp: "2026-11-22T10:00:00Z", ...extra });
const delivery = (body: unknown, signature?: string) => {
  const text = JSON.stringify(body);
  return { body: text, headers: { signature: signature ?? sign(text) }, connection: "c1", rest: "" };
};
const fire = async (body: unknown) => {
  stub(() => json({ "@odata.context": "x", Title: "Payroll" }));
  return (await (await karbon.push!.receive!(delivery(body), "eyJaccess"))!.events()).map((e) => e.triggers);
};

test("the Access Key goes with our application key, and a refused one is dead", async () => {
  const calls = stub(() => json({ TenantKey: "T1", WorkTypes: [] }));
  expect(await own.connectWithKey!("karbon", " eyJaccess ")).toEqual({ secret: "eyJaccess", label: "Karbon" });
  expect(calls[0]!.url).toBe("https://api.karbonhq.com/v3/TenantSettings");
  expect(calls[0]!.headers.Authorization).toBe("Bearer app-guid");
  expect(calls[0]!.headers.AccessKey).toBe("eyJaccess");
  stub(() => json({ statusCode: 401, message: "Unauthorized. Auth token is missing or invalid." }, 401));
  const refused = await own.connectWithKey!("karbon", "nope").catch((e) => e);
  expect(refused).toBeInstanceOf(AppsError);
  expect(refused.expired).toBe(true);
});

test("without KARBON_APP_KEY the server says so instead of calling Karbon", async () => {
  delete process.env.KARBON_APP_KEY;
  try {
    const calls = stub(() => json({}));
    const err = await karbon.check("eyJaccess").catch((e) => e);
    expect(err).toBeInstanceOf(AppsError);
    expect(err.message).toContain("KARBON_APP_KEY");
    expect(calls).toHaveLength(0);
  } finally {
    process.env.KARBON_APP_KEY = "app-guid";
  }
});

test("OData lists, writes with a body, and Karbon's error messages come through", async () => {
  const calls = stub(() => json({ value: [] }));
  await own.run("karbon.list_contacts", { $filter: "contains(FullName, 'Sarah')", $top: 10 }, login, "o");
  expect(calls[0]!.url).toBe("https://api.karbonhq.com/v3/Contacts?$filter=contains(FullName,+'Sarah')&$top=10");
  await own.run("karbon.create_work_item", { Title: "2026 Tax Return", ClientKey: "C1", ClientType: "Contact", AssigneeEmailAddress: "sarah@northwind.com", StartDate: "2026-07-01" }, login, "o");
  expect(calls[1]!.method).toBe("POST");
  expect(JSON.parse(calls[1]!.body)).toMatchObject({ Title: "2026 Tax Return", ClientType: "Contact" });
  await own.run("karbon.get_comment", { Commentkey: "AB" }, login, "o");
  expect(calls[2]!.url).toBe("https://api.karbonhq.com/v3/Comments('AB')");
  stub(() => json({ error: { code: "4020", message: "The resource was modified by another request." } }, 409));
  await expect(own.run("karbon.patch_contact", { Contactkey: "C1", FirstName: "Sam" }, login, "o")).rejects.toThrow(/modified by another request/);
});

test("reads run unasked and writes ask", async () => {
  for (const a of ["list_work_items", "get_contact", "list_time_entries", "get_tenant_settings", "list_invoices"]) expect((await own.getAction(`karbon.${a}`))?.readOnly).toBe(true);
  for (const a of ["create_contact", "update_work_item", "patch_work_item", "create_note", "create_manual_payment", "delete_custom_field", "upload_file"]) expect((await own.getAction(`karbon.${a}`))?.readOnly).toBe(false);
  expect(await own.getAction("karbon.list_integration_tasks")).toBeNull();
});

test("a downloaded file comes back as a file", async () => {
  stub(() => new Response(new Uint8Array([37, 80, 68, 70]), { headers: { "content-type": "application/pdf" } }));
  const got = await own.run("karbon.download_file", { key: "F1" }, login, "o");
  expect(got).toBeInstanceOf(AppFile);
  expect((got as AppFile).mimetype).toBe("application/pdf");
});

test("the first automation subscribes with our signing key, the next adds its type, a stranger's subscription is replaced", async () => {
  const none = stub((c) => (c.method === "GET" ? json({ error: { message: "not found" } }, 404) : json({}, 201)));
  expect(await own.startPush!("karbon.new_work_item", login, {})).toBe("karbon:c1");
  expect(none.map((c) => c.method)).toEqual(["GET", "POST"]);
  expect(none[1]!.url).toBe("https://api.karbonhq.com/v3/WebhookSubscriptions");
  expect(JSON.parse(none[1]!.body)).toEqual({ TargetUrl: target, WebhookTypes: ["Work"], SigningKey: signingKey() });

  const more = stub((c) => (c.method === "GET" ? json({ TargetUrl: target, WebhookTypes: ["Work"] }) : json({})));
  await own.startPush!("karbon.new_contact", login, {});
  expect(more[1]!.method).toBe("PATCH");
  expect(more[1]!.url).toBe(MULTI);
  expect(JSON.parse(more[1]!.body)).toEqual({ WebhookTypes: ["Work", "Contact"] });

  const same = stub(() => json({ TargetUrl: target, WebhookTypes: ["Work", "Contact"] }));
  await own.startPush!("karbon.organization_updated", login, {});
  expect(same).toHaveLength(1);

  const other = stub((c) => (c.method === "GET" ? json({ TargetUrl: "https://old", WebhookTypes: ["Note"] }) : json({})));
  await own.startPush!("karbon.invoice_paid", login, {});
  expect(other.map((c) => c.method)).toEqual(["GET", "DELETE", "POST"]);
  expect(JSON.parse(other[2]!.body).WebhookTypes).toEqual(["Invoice"]);
});

test("the last automation removes our subscription, and leaves someone else's", async () => {
  const ours = stub((c) => (c.method === "GET" ? json({ TargetUrl: target, WebhookTypes: ["Work"] }) : new Response(null, { status: 204 })));
  await karbon.push!.stop!("eyJaccess", "karbon:c1");
  expect(ours.map((c) => `${c.method} ${c.url}`)).toEqual([`GET ${MULTI}`, `DELETE ${MULTI}`]);
  const theirs = stub(() => json({ TargetUrl: "https://old", WebhookTypes: ["Work"] }));
  await karbon.push!.stop!("eyJaccess", "karbon:c1");
  expect(theirs).toHaveLength(1);
  const gone = stub(() => json({ error: { message: "nope" } }, 404));
  await karbon.push!.stop!("eyJaccess", "karbon:c1");
  expect(gone).toHaveLength(1);
});

test("only Karbon's signature is accepted", async () => {
  const body = notice("WorkItem", "Inserted");
  expect(await karbon.push!.receive!(delivery(body, sign(JSON.stringify(body), "wrong-key-wrong-key")), "k")).toBeNull();
  expect(await karbon.push!.receive!(delivery(body, ""), "k")).toBeNull();
  expect(await karbon.push!.receive!(delivery(body, sign(JSON.stringify(body)).toUpperCase()), "k")).not.toBeNull();
});

test("each event starts only the right triggers", async () => {
  expect(await fire(notice("Contact", "Inserted"))).toEqual([["new_contact"]]);
  expect(await fire(notice("Organization", "Updated"))).toEqual([["organization_updated"]]);
  expect(await fire(notice("ClientGroup", "Deleted"))).toEqual([["client_group_deleted"]]);
  expect(await fire(notice("WorkItem", "Updated"))).toEqual([["work_item_updated"]]);
  expect(await fire(notice("Work", "Deleted"))).toEqual([["work_item_deleted"]]);
  expect(await fire(notice("Note", "Inserted"))).toEqual([["new_note"]]);
  expect(await fire(notice("NoteComment", "Inserted", { ParentEntityKey: "N1" }))).toEqual([["new_note_comment"]]);
  expect(await fire(notice("User", "InviteAccepted"))).toEqual([["user_joined"]]);
  expect(await fire(notice("Invoice", "Paid"))).toEqual([["invoice_status_changed", "invoice_paid"]]);
  expect(await fire(notice("Invoice", "Approved"))).toEqual([["invoice_status_changed"]]);
  expect(await fire(notice("Estimate", "Updated"))).toEqual([["work_item_budget_changed"]]);
  expect(await fire(notice("CustomFieldValue", "Updated", { ClientKey: "C1", ClientType: "Contact" }))).toEqual([["custom_field_value_changed"]]);
  expect(await fire(notice("IntegrationTask", "Inserted"))).toEqual([]);
  // a batched delivery carries several
  expect(await fire({ BatchId: "b", Count: 2, Events: [notice("WorkItem", "Inserted"), notice("Contact", "Updated")] })).toEqual([["new_work_item"], ["contact_updated"]]);
});

test("the event carries the item fetched from Karbon, a deleted one isn't fetched, and a retry has the same id", async () => {
  const calls = stub(() => json({ "@odata.context": "x", WorkItemKey: "K1", Title: "Payroll", PrimaryStatus: "In Progress" }));
  const body = notice("WorkItem", "Updated");
  const [a] = await (await karbon.push!.receive!(delivery(body), "eyJaccess"))!.events();
  const [b] = await (await karbon.push!.receive!(delivery(body), "eyJaccess"))!.events();
  expect(calls[0]!.url).toBe("https://api.karbonhq.com/v3/WorkItems/K1");
  expect(a!.id).toBe(b!.id!);
  expect(a!.id).toStartWith("c1:");
  expect(a!.data).toMatchObject({ action: "Updated", type: "WorkItem", key: "K1", data: { Title: "Payroll" } });
  expect((a!.data as { data: object }).data).not.toHaveProperty("@odata.context");
  const cf = stub(() => json({ EntityKey: "C1", CustomFieldValues: [] }));
  await (await karbon.push!.receive!(delivery(notice("CustomFieldValue", "Updated", { ClientKey: "C1" })), "k"))!.events();
  expect(cf[0]!.url).toBe("https://api.karbonhq.com/v3/CustomFieldValues/C1");
  const del = stub(() => json({}));
  const [d] = await (await karbon.push!.receive!(delivery(notice("Contact", "Deleted")), "k"))!.events();
  expect(del).toHaveLength(0);
  expect(d!.data).not.toHaveProperty("data");
  // a fetch that fails still tells
  stub(() => json({ error: { message: "gone" } }, 404));
  expect(await (await karbon.push!.receive!(delivery(notice("Note", "Updated")), "k"))!.events()).toHaveLength(1);
});

test("filters narrow what runs", () => {
  const work = { action: "Updated", type: "WorkItem", key: "K1", data: { AssigneeEmailAddress: "sarah@northwind.com", ClientKey: "C1", WorkType: "Payroll", PrimaryStatus: "In Progress" }, event: notice("WorkItem", "Updated") };
  expect(wanted({}, work)).toBe(true);
  expect(wanted({ key: "K1", assignee_email: "Sarah@Northwind.com", client_key: "C1", work_type: "payroll", primary_status: "InProgress" }, work)).toBe(true);
  expect(wanted({ key: "K2" }, work)).toBe(false);
  expect(wanted({ assignee_email: "a@x.com" }, work)).toBe(false);
  expect(wanted({ primary_status: "Completed" }, work)).toBe(false);
  expect(wanted({ work_type: "Tax" }, { ...work, data: undefined })).toBe(false);
  const invoice = { action: "Paid", type: "Invoice", key: "I1", event: notice("Invoice", "Paid") };
  expect(wanted({ status: "paid" }, invoice)).toBe(true);
  expect(wanted({ status: "Voided" }, invoice)).toBe(false);
  const comment = { action: "Inserted", type: "NoteComment", key: "X", event: notice("NoteComment", "Inserted", { ParentEntityKey: "N1" }) };
  expect(wanted({ note_key: "N1" }, comment)).toBe(true);
  expect(wanted({ note_key: "N2" }, comment)).toBe(false);
  const cf = { action: "Updated", type: "CustomFieldValue", key: "F1", event: notice("CustomFieldValue", "Updated", { ClientKey: "C1" }) };
  expect(wanted({ field_key: "F1", client_key: "C1" }, cf)).toBe(true);
  expect(wanted({ client_key: "C2" }, cf)).toBe(false);
});

test("every webhook object has new, updated and deleted triggers", () => {
  for (const o of ["contact", "organization", "client_group", "work_item", "note", "note_comment"])
    for (const t of [`new_${o}`, `${o}_updated`, `${o}_deleted`]) expect(triggers[t]).toBeDefined();
  for (const t of ["user_joined", "invoice_status_changed", "invoice_paid", "work_item_budget_changed", "custom_field_value_changed"]) expect(triggers[t]).toBeDefined();
});

test("polls list the newest time, payments and files, with filters", async () => {
  const asked: [string, any][] = [];
  const run = async (action: string, input: unknown) => {
    asked.push([action, input]);
    if (action === "karbon.list_files") return { Attachments: [{ FileContextKey: "F1" }] };
    if (action === "karbon.list_payments") return { value: [{ PaymentKey: "P1" }] };
    return { value: [{ IndividualTimeEntryKey: "E1" }] };
  };
  const poll = (t: string) => pollTrigger(`karbon.${t}`)!;
  expect((await poll("new_time_entry").poll({ user_key: "U1", work_item_key: "W'1" }, run)).map((i) => i.id)).toEqual(["E1"]);
  expect(asked[0]![1]).toEqual({ $orderby: "Date desc", $top: 100, $filter: "UserKey eq 'U1' and WorkItemKey eq 'W''1'" });
  expect((await poll("new_payment").poll({}, run)).map((i) => i.id)).toEqual(["P1"]);
  expect((await poll("new_file").poll({ entity_type: "WorkItem", entity_key: "W1", shared_only: true }, run)).map((i) => i.id)).toEqual(["F1"]);
  expect(asked[2]![1]).toMatchObject({ EntityType: "WorkItem", EntityKey: "W1", $filter: "IsShared eq true" });
  expect(await poll("new_payment").poll({}, async () => ({}))).toEqual([]);
});

test("the webhook route refuses a bad signature and takes a good one", async () => {
  const find = spyOn(db.query.connections, "findFirst");
  const app = Fastify();
  await automationRoutes(app);
  // an event no trigger wants, so a 200 needs no database
  const body = JSON.stringify(notice("IntegrationTask", "Inserted"));
  const post = (signature: string) => app.inject({ method: "POST", url: "/webhooks/app/karbon/c1", headers: { "content-type": "application/json", signature }, payload: body });
  try {
    find.mockResolvedValue({ id: "row", app: "karbon", secret: encrypt("eyJaccess"), refreshToken: null, expiresAt: null } as never);
    expect((await post(sign(body, "wrong-key-wrong-key"))).statusCode).toBe(401);
    expect((await post(sign(body))).statusCode).toBe(200);
  } finally {
    find.mockRestore();
    await app.close();
  }
});
