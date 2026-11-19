import { afterEach, beforeAll, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { AppsError } from "../../types";
import { own } from "../index";
import { brevo } from "./index";
import { triggers, wanted } from "./triggers";

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
    const c = { url: String(url), method: init.method ?? "GET", body: String(init.body ?? ""), headers: (init.headers ?? {}) as Record<string, string> };
    calls.push(c);
    return answer(c);
  }) as typeof fetch;
  return calls;
};
const login = { externalId: "c1", secret: "xkeysib-k" };
const token = (segment: string) => createHmac("sha256", process.env.ENCRYPTION_KEY!).update(`brevo-webhook:c1:${segment}`).digest("hex");
const hook = (segment: string) => `https://api.test/webhooks/app/brevo/c1/${segment}/${token(segment)}`;

test("a key is checked with the api-key header and labelled, and a bad one is refused", async () => {
  const calls = stub(() => json({ email: "a@shop.in", companyName: "Asha Stores" }));
  expect(await own.connectWithKey!("brevo", " xkeysib-k ")).toEqual({ secret: "xkeysib-k", label: "Asha Stores" });
  expect(calls[0]!.url).toBe("https://api.brevo.com/v3/account");
  expect(calls[0]!.headers["api-key"]).toBe("xkeysib-k");
  stub(() => json({ code: "unauthorized", message: "Key not found" }, 401));
  const error = await own.connectWithKey!("brevo", "nope").catch((e) => e);
  expect(error).toBeInstanceOf(AppsError);
  expect(error.expired).toBe(true);
});

test("every operation is there; reads run unasked and sends ask", async () => {
  expect(Object.keys(brevo.actions).length).toBeGreaterThan(280);
  for (const a of ["get_contact_lists", "get_contact_details", "get_email_campaign_details", "list_transactional_email_events", "preview_email_template"])
    expect((await own.getAction(`brevo.${a}`))?.readOnly).toBe(true);
  for (const a of ["send_transactional_email", "send_email_campaign_now", "create_contact", "add_contacts_to_list", "create_email_campaign", "send_transactional_sms", "delete_contact"])
    expect((await own.getAction(`brevo.${a}`))?.readOnly).toBe(false);
});

test("adding a contact to a list sends the right call", async () => {
  const calls = stub(() => json({ contacts: { success: ["a@b.in"] } }, 201));
  await brevo.actions.add_contacts_to_list!.run({ listId: 7, emails: ["a@b.in"] }, "xkeysib-k");
  expect(calls[0]!.method).toBe("POST");
  expect(calls[0]!.url).toBe("https://api.brevo.com/v3/contacts/lists/7/contacts/add");
  expect(JSON.parse(calls[0]!.body)).toEqual({ emails: ["a@b.in"] });
});

test("a CRM file download comes back as a file", async () => {
  stub(() => new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "application/pdf" } }));
  const got = (await brevo.actions.download_file!.run({ id: "f1" }, "xkeysib-k")) as { mimetype: string; bytes: Uint8Array };
  expect(got.mimetype).toBe("application/pdf");
  expect([...got.bytes]).toEqual([1, 2, 3]);
});

type Hook = { id: number; url: string; events: string[]; type: string };
const account = (hooks: Hook[]) => stub((c) => (c.method === "GET" ? json({ webhooks: hooks }) : c.method === "POST" ? json({ id: 9 }, 201) : json({}, 204)));

test("the first automation makes one webhook of its type, at a URL with our token", async () => {
  const calls = account([]);
  expect(await own.startPush!("brevo.transactional_email_delivered", login, {})).toBe("brevo:c1:transactional");
  expect(calls[0]!.url).toBe("https://api.brevo.com/v3/webhooks?type=transactional");
  expect(JSON.parse(calls[1]!.body)).toEqual({ url: hook("transactional"), type: "transactional", events: ["delivered"], description: "Emplio automations" });
  const m = account([]);
  expect(await own.startPush!("brevo.contact_added_to_list", login, {})).toBe("brevo:c1:marketing");
  expect(JSON.parse(m[1]!.body)).toMatchObject({ type: "marketing", events: ["listAddition"] });
});

test("another event extends our webhook; the same event changes nothing; others' webhooks are left alone", async () => {
  const ours = { id: 5, url: hook("transactional"), events: ["delivered"], type: "transactional" };
  const theirs = { id: 6, url: "https://elsewhere.test/x", events: ["click"], type: "transactional" };
  const calls = account([theirs, ours]);
  await own.startPush!("brevo.transactional_email_clicked", login, {});
  expect(calls[1]!.method).toBe("PUT");
  expect(calls[1]!.url).toEndWith("/webhooks/5");
  expect(JSON.parse(calls[1]!.body)).toEqual({ events: ["delivered", "click"] });
  const same = account([ours]);
  await own.startPush!("brevo.transactional_email_delivered", login, {});
  expect(same.length).toBe(1);
});

test("inbound email needs a domain and gets a webhook per domain", async () => {
  account([]);
  await expect(own.startPush!("brevo.inbound_email_received", login, {})).rejects.toThrow(/domain/);
  const calls = account([]);
  expect(await own.startPush!("brevo.inbound_email_received", login, { domain: "Reply.Shop.in" })).toBe("brevo:c1:inbound-reply.shop.in");
  expect(JSON.parse(calls[1]!.body)).toMatchObject({ url: hook("inbound-reply.shop.in"), type: "inbound", events: ["inboundEmailProcessed"], domain: "reply.shop.in" });
});

test("the last automation removes the webhook", async () => {
  const calls = account([{ id: 5, url: hook("marketing"), events: ["opened"], type: "marketing" }]);
  await brevo.push!.stop!("xkeysib-k", "brevo:c1:marketing");
  expect(calls[0]!.url).toContain("type=marketing");
  expect(calls.at(-1)!.method).toBe("DELETE");
  expect(calls.at(-1)!.url).toEndWith("/webhooks/5");
});

const delivery = (segment: string, body: unknown, t = token(segment)) => ({ body: JSON.stringify(body), headers: {}, connection: "c1", rest: `${segment}/${t}` });

test("a wrong or missing token is refused", async () => {
  expect(await brevo.push!.receive!(delivery("transactional", { event: "delivered" }, "nope"), "k")).toBeNull();
  expect(await brevo.push!.receive!({ ...delivery("transactional", {}), rest: "transactional" }, "k")).toBeNull();
  expect(await brevo.push!.receive!(delivery("marketing", { event: "opened" }, token("transactional")), "k")).toBeNull();
});

test("each event starts only its own trigger", async () => {
  for (const [segment, event, trigger] of [
    ["transactional", "request", "transactional_email_sent"],
    ["transactional", "unique_opened", "transactional_email_first_opened"],
    ["transactional", "hard_bounce", "transactional_email_hard_bounced"],
    ["transactional", "invalid_email", "transactional_email_invalid"],
    ["marketing", "opened", "campaign_email_opened"],
    ["marketing", "unsubscribe", "campaign_unsubscribed"],
    ["marketing", "list_addition", "contact_added_to_list"],
    ["marketing", "contact_deleted", "contact_deleted"],
  ] as const) {
    const [e] = await (await brevo.push!.receive!(delivery(segment, { event, email: "a@b.in", mirror_link: "x" }), "k"))!.events();
    expect(e!.triggers).toEqual([trigger]);
    expect(e!.data).toEqual({ event, email: "a@b.in" });
    expect(e!.id).toBeTruthy();
  }
  const [unknown] = await (await brevo.push!.receive!(delivery("marketing", { event: "proxy_open" }), "k"))!.events();
  expect(unknown!.triggers).toEqual([]);
  const inbound = await (await brevo.push!.receive!(delivery("inbound-reply.shop.in", { items: [{ MessageId: "<1>", Subject: "Hi", RawHtmlBody: "<p>" }, { MessageId: "<2>" }] }), "k"))!.events();
  expect(inbound.map((e) => e.triggers)).toEqual([["inbound_email_received"], ["inbound_email_received"]]);
  expect(inbound[0]!.data).toEqual({ MessageId: "<1>", Subject: "Hi" });
});

test("tag, campaign and list settings narrow what runs", () => {
  expect(wanted({}, { tags: ["order"] })).toBe(true);
  expect(wanted({ tag: "order" }, { tags: ["order"] })).toBe(true);
  expect(wanted({ tag: "order" }, { tags: ["promo"] })).toBe(false);
  expect(wanted({ campaign_id: 12 }, { camp_id: 12 })).toBe(true);
  expect(wanted({ campaign_id: "12" }, { camp_id: 13 })).toBe(false);
  expect(wanted({ list_id: 34 }, { list_id: [34, 12] })).toBe(true);
  expect(wanted({ list_id: 5 }, { list_id: [34] })).toBe(false);
  expect(triggers.inbound_email_received!.config.map((c) => c.name)).toEqual(["domain"]);
});
