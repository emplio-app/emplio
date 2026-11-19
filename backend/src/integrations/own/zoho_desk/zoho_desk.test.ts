import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { createHmac } from "node:crypto";
import Fastify from "fastify";
import { automationRoutes } from "../../../automations";
import { db } from "../../../db";
import { encrypt } from "../../../secrets";
import { pollOnce } from "../../polls";
import { AppFile, AppsError } from "../../types";
import { own } from "../index";
import { BACK, clearZohoEnv, fakeZoho, zohoEnv } from "../zoho-fake";
import { SCOPES, zoho_desk } from "./index";
import { events, triggers, wanted } from "./triggers";

const exec = (action: string, input: unknown, secret: string) => own.run(action, input, { externalId: "c", secret }, "o") as Promise<any>;
beforeEach(() => {
  zohoEnv();
  process.env.WEBHOOK_URL = "https://api.test";
});
afterEach(clearZohoEnv);
const orgs = (...list: [string, string][]) => ({ data: list.map(([id, companyName]) => ({ id, companyName })) });
let n = 0;
const fresh = (dc = "in") => `${dc}:t${n++}`;
const route = (url: URL, more: unknown) => (url.pathname === "/api/v1/organizations" ? orgs(["111", "Acme"]) : more);
const token = (connection: string, org: string) => createHmac("sha256", process.env.ENCRYPTION_KEY!).update(`zoho_desk-webhook:${connection}:${org}`).digest("base64url").slice(0, 16);

test("not offered without the client id and secret", async () => {
  clearZohoEnv();
  expect((await own.readyApps()).has("zoho_desk")).toBe(false);
  zohoEnv();
  expect((await own.getApp("zoho_desk"))?.signIn).toBe(true);
});

test("a sign-in round trip asks for the Desk scopes and can't be forged; the login stays in its data centre", async () => {
  const { url } = await own.startSignIn("zoho_desk", "o", BACK);
  const page = new URL(url);
  expect(page.searchParams.get("scope")).toBe(SCOPES);
  expect(SCOPES).toContain("Desk.tickets.ALL");
  expect(page.searchParams.get("redirect_uri")).toBe("https://api.test/oauth/zoho_desk/callback");
  const state = page.searchParams.get("state")!;
  expect(own.readSignIn!("zoho_desk", `${state.split(".")[0]}.forged`)).toBeNull();
  const sent = fakeZoho((u) => (u.pathname.endsWith("/token") ? { access_token: "a1", refresh_token: "r1", expires_in: 3600 } : orgs(["111", "Acme Support"])));
  const out = await own.finishSignIn!("zoho_desk", "code1", BACK, { location: "eu" });
  expect(out).toMatchObject({ secret: "eu:a1", label: "Acme Support", refreshToken: "eu:r1" });
  expect(sent[1]!.url).toBe("https://desk.zoho.eu/api/v1/organizations");
  expect(sent[1]!.headers.Authorization).toBe("Zoho-oauthtoken a1");
});

test("the wire format: Desk's host for the data centre, orgId in a header, a JSON body", async () => {
  let sent = fakeZoho((u) => route(u, { id: "9" }));
  await exec("zoho_desk.create_ticket", { subject: "Broken tap", departmentId: "5", contactId: "7" }, fresh("in"));
  const call = sent.find((s) => s.method === "POST")!;
  expect(call.url).toBe("https://desk.zoho.in/api/v1/tickets");
  expect(call.headers.orgId).toBe("111");
  expect(call.body).toEqual({ subject: "Broken tap", departmentId: "5", contactId: "7" });
  sent = fakeZoho((u) => route(u, { data: [] }));
  await exec("zoho_desk.list_tickets", {}, fresh("ca"));
  expect(sent.at(-1)!.url).toBe("https://desk.zohocloud.ca/api/v1/tickets");
  await exec("zoho_desk.list_tickets", {}, fresh("au"));
  expect(sent.at(-1)!.url).toBe("https://desk.zoho.com.au/api/v1/tickets");
});

test("the only organisation fills itself in; several ask which; listing organisations needs none", async () => {
  let sent = fakeZoho((u) => (u.pathname === "/api/v1/organizations" ? orgs(["1", "A Co"], ["2", "B Co"]) : { data: [] }));
  await expect(exec("zoho_desk.list_tickets", {}, fresh())).rejects.toThrow(/1 \(A Co\), 2 \(B Co\)/);
  await exec("zoho_desk.list_tickets", { org_id: "2" }, fresh());
  expect(sent.at(-1)!.headers.orgId).toBe("2");
  sent = fakeZoho((u) => route(u, {}));
  await exec("zoho_desk.list_organizations", {}, fresh());
  expect(sent).toHaveLength(1);
  expect(sent[0]!.headers.orgId).toBeUndefined();
});

test("reads run unasked; writes, replies to customers and the JWT secret ask first", async () => {
  for (const a of ["list_tickets", "get_ticket", "list_ticket_threads", "list_departments", "list_agents", "search_tickets", "preview_article", "download_ticket_attachment"])
    expect((await own.getAction(`zoho_desk.${a}`))?.readOnly).toBe(true);
  for (const a of ["create_ticket", "update_ticket", "send_email_reply", "add_ticket_comment", "get_jwt_secret_key"]) expect((await own.getAction(`zoho_desk.${a}`))?.readOnly).toBe(false);
  expect(Object.keys(zoho_desk.actions).length).toBeGreaterThan(1000);
});

test("an attachment comes back as a file", async () => {
  globalThis.fetch = (async (input: string) =>
    String(input).endsWith("/api/v1/organizations") ? Response.json(orgs(["111", "Acme"])) : new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "application/pdf" } })) as typeof fetch;
  const out = await exec("zoho_desk.download_ticket_attachment", { ticketId: "1", attachmentId: "2" }, fresh());
  expect(out).toBeInstanceOf(AppFile);
  expect(out.mimetype).toBe("application/pdf");
});

test("a dead token marks the connection expired; a missing scope doesn't", async () => {
  fakeZoho((u) => route(u, { $status: 401, body: { errorCode: "INVALID_OAUTH", message: "The OAuth Token you provided is invalid." } }));
  const err = await exec("zoho_desk.list_tickets", {}, fresh()).catch((e) => e);
  expect(err).toBeInstanceOf(AppsError);
  expect(err.expired).toBe(true);
  fakeZoho((u) => route(u, { $status: 401, body: { errorCode: "SCOPE_MISMATCH", message: "no scope" } }));
  expect((await exec("zoho_desk.list_tickets", {}, fresh()).catch((e) => e)).expired).toBe(false);
});

test("every Desk webhook event is a trigger", () => {
  expect(Object.keys(triggers)).toHaveLength(56);
  expect(events.ticket_added).toBe("Ticket_Add");
  expect(events.ticket_thread_added).toBe("Ticket_Thread_Add");
  expect(events.contact_updated).toBe("Contact_Update");
  expect(events.ticket_attachment_trashed).toBe("Ticket_Attachment_Trashed");
  expect(events.im_session_status_changed).toBe("IM_Session_Status");
  expect(triggers.ticket_thread_added!.config!.map((c) => c.name)).toEqual(["org_id", "department_id", "ticket_id", "direction"]);
  expect(triggers.ticket_updated!.config!.map((c) => c.name)).toContain("field");
});

test("webhook: made once per organisation, extended with a new event, removed at the end", async () => {
  const url = `https://api.test/webhooks/app/zoho_desk/c1/${token("c1", "111")}`;
  let hooks: any[] = [];
  const sent = fakeZoho((u, method) => {
    if (u.pathname === "/api/v1/organizations") return orgs(["111", "Acme"]);
    if (u.pathname === "/api/v1/webhooks" && method === "GET") return { data: hooks };
    if (u.pathname === "/api/v1/webhooks" && method === "POST") return (hooks = [{ id: "h1", url, isEnabled: true, subscriptions: { Ticket_Add: null } }])[0];
    return {};
  });
  const key = fresh();
  const id = await zoho_desk.push!.start(key, "c1", "Ticket_Add", {});
  expect(id).toBe(`zoho_desk:c1:${token("c1", "111")}`);
  const made = sent.find((s) => s.method === "POST")!;
  expect(made.headers.orgId).toBe("111");
  expect(made.body).toMatchObject({ url, subscriptions: { Ticket_Add: null }, isEnabled: true });
  // already carried: nothing changes
  const before = sent.length;
  await zoho_desk.push!.start(key, "c1", "Ticket_Add", {});
  expect(sent.slice(before).filter((s) => s.method !== "GET")).toHaveLength(0);
  await zoho_desk.push!.start(key, "c1", "Ticket_Update", {});
  const patch = sent.find((s) => s.method === "PATCH")!;
  expect(patch.url).toBe("https://desk.zoho.in/api/v1/webhooks/h1");
  expect(patch.body).toMatchObject({ subscriptions: { Ticket_Add: null, Ticket_Update: { includePrevState: true } } });
  await zoho_desk.push!.stop!(key, id);
  expect(sent.at(-1)).toMatchObject({ method: "DELETE", url: "https://desk.zoho.in/api/v1/webhooks/h1" });
});

test("a webhook address longer than Desk takes is refused with the reason", async () => {
  process.env.WEBHOOK_URL = `https://${"x".repeat(80)}.test`;
  fakeZoho((u) => route(u, { data: [] }));
  await expect(zoho_desk.push!.start(fresh(), "c1", "Ticket_Add", {})).rejects.toThrow(/100 characters/);
});

const delivery = (body: unknown, connection = "c1", org = "111") => ({ body: JSON.stringify(body), headers: {}, connection, rest: token(connection, org) });

test("events start only their triggers; a forged token or another organisation's event is refused", async () => {
  const body = [
    { eventType: "Ticket_Thread_Add", orgId: "111", eventTime: "1", payload: { id: "th1", ticketId: "t1", direction: "in", departmentId: "5" } },
    { eventType: "Ticket_Add", orgId: "111", eventTime: "2", payload: { id: "t2", departmentId: "6" } },
  ];
  const got = await zoho_desk.push!.receive!(delivery(body), "k");
  const out = await got!.events();
  expect(out.map((e) => e.triggers)).toEqual([["ticket_thread_added"], ["ticket_added"]]);
  expect(out[0]!.data).toMatchObject({ event_type: "Ticket_Thread_Add", org_id: "111", payload: { ticketId: "t1" } });
  expect(out[0]!.id).not.toBe(out[1]!.id);
  expect(await zoho_desk.push!.receive!({ ...delivery(body), rest: "forgedforgedforg" }, "k")).toBeNull();
  expect(await zoho_desk.push!.receive!(delivery([{ ...body[0], orgId: "222" }]), "k")).toBeNull();
  // Desk checking the address while the webhook is made
  expect(await (await zoho_desk.push!.receive!({ ...delivery({}), rest: "anything" }, "k"))!.events()).toEqual([]);
});

test("filters: department, ticket, direction and the changed field", () => {
  const thread = { event_type: "Ticket_Thread_Add", org_id: "111", payload: { id: "th1", ticketId: "t1", direction: "in", departmentId: "5" } };
  expect(wanted({}, thread)).toBe(true);
  expect(wanted({ department_id: "5", ticket_id: "t1", direction: "in" }, thread)).toBe(true);
  expect(wanted({ direction: "out" }, thread)).toBe(false);
  expect(wanted({ department_id: "6" }, thread)).toBe(false);
  expect(wanted({ org_id: "222" }, thread)).toBe(false);
  const update = { event_type: "Ticket_Update", org_id: "111", payload: { id: "t1", status: "Closed", priority: "High" }, prev_state: { id: "t1", status: "Open", priority: "High" } };
  expect(wanted({ ticket_id: "t1", field: "status" }, update)).toBe(true);
  expect(wanted({ field: "priority" }, update)).toBe(false);
  expect(wanted({ ticket_id: "t9" }, update)).toBe(false);
});

test("the shared webhook route: a forged token gets 401, a real one 200", async () => {
  const find = spyOn(db.query.connections, "findFirst");
  const app = Fastify();
  await automationRoutes(app);
  const body = JSON.stringify([{ eventType: "Ticket_Add", orgId: "111", eventTime: "1", payload: { id: "t1" } }]);
  const post = (rest: string) => app.inject({ method: "POST", url: `/webhooks/app/zoho_desk/c1/${rest}`, headers: { "content-type": "application/json" }, payload: body });
  try {
    find.mockResolvedValue({ id: "row", app: "zoho_desk", secret: encrypt("in:tok"), refreshToken: null, expiresAt: null } as never);
    expect((await post("forgedforgedforg")).statusCode).toBe(401);
    // a found event looks for automations in the background; there are none here
    spyOn(db, "select").mockReturnValue({ from: () => ({ where: async () => [] }) } as never);
    expect((await post(token("c1", "111"))).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: `/webhooks/app/zoho_desk/c1/${token("c1", "111")}` })).statusCode).toBe(200);
  } finally {
    find.mockRestore();
    await app.close();
  }
});

test("polled: an overdue ticket once per due date, new products and contracts", async () => {
  const key = fresh();
  const past = new Date(Date.now() - 3_600_000).toISOString();
  let tickets: any[] = [{ id: "1", dueDate: past, statusType: "Open" }, { id: "2", dueDate: past, statusType: "Closed" }];
  const sent = fakeZoho((u) => route(u, u.pathname.endsWith("/search") ? { data: tickets } : u.pathname.endsWith("/products") ? { data: [{ id: "p1" }] } : { data: [{ id: "k1" }] }));
  const run = (a: string, i: unknown) => exec(a, i, key);
  const first = await pollOnce("zoho_desk.ticket_overdue", {}, null, run);
  expect(first.seen).toEqual([`1:${past}`]);
  expect(sent.at(-1)!.query.get("dueDateRange")).toContain(",");
  tickets = [...tickets, { id: "3", dueDate: past, statusType: "On Hold" }];
  const next = await pollOnce("zoho_desk.ticket_overdue", {}, first.seen, run);
  expect(next.fresh).toEqual([{ ticket: { id: "3", dueDate: past, statusType: "On Hold" } }]);
  expect((await pollOnce("zoho_desk.product_added", {}, null, run)).seen).toEqual(["p1"]);
  expect(sent.at(-1)!.query.get("sortBy")).toBe("-createdTime");
  expect((await pollOnce("zoho_desk.contract_added", {}, null, run)).seen).toEqual(["k1"]);
  expect(sent.at(-1)!.query.get("sortBy")).toBe("-createdTime");
});
