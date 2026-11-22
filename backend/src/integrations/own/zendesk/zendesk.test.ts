import { afterEach, beforeAll, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { pollConfig, pollOnce } from "../../polls";
import { AppFile, AppsError } from "../../types";
import { own } from "../index";
import { parseKey } from "./api";
import { zendesk } from "./index";
import { events, triggers, wanted } from "./triggers";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});
beforeAll(() => {
  process.env.ENCRYPTION_KEY ??= "test-key";
  process.env.WEBHOOK_URL = "https://api.test";
});
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
type Call = { url: string; method: string; body: BodyInit | null | undefined; headers: Record<string, string> };
const stub = (answer: (c: Call) => Response) => {
  const calls: Call[] = [];
  globalThis.fetch = (async (url: string, init: RequestInit = {}) => {
    const c = { url: String(url), method: init.method ?? "GET", body: init.body, headers: (init.headers ?? {}) as Record<string, string> };
    calls.push(c);
    return answer(c);
  }) as typeof fetch;
  return calls;
};
const TOKEN = "0a1b2c3d4e5f0a1b2c3d4e5f0a1b2c3d4e5f0a1b";
const KEY = `acme sarah@northwind.com ${TOKEN}`;
const login = { externalId: "c1", secret: KEY };
const run = (a: string, i: unknown) => own.run(a, i as Record<string, unknown>, login, "o");
const urlToken = () => createHmac("sha256", process.env.ENCRYPTION_KEY!).update("zendesk-webhook:c1").digest("hex");
const target = () => `https://api.test/webhooks/app/zendesk/c1/${urlToken()}`;

test("the key is the subdomain, email and token, in any order; a host outside Zendesk is refused", () => {
  const want = { host: "acme.zendesk.com", email: "sarah@northwind.com", token: TOKEN };
  expect(parseKey(KEY)).toEqual(want);
  expect(parseKey(` ${TOKEN}  https://acme.zendesk.com/agent/tickets/1 sarah@northwind.com `)).toEqual(want);
  expect(parseKey(`sarah@northwind.com acme.zendesk.com ${TOKEN}`)).toEqual(want);
  expect(() => parseKey(`evil.com sarah@northwind.com ${TOKEN}`)).toThrow(AppsError);
  expect(() => parseKey("acme sarah@northwind.com")).toThrow(/three things/);
});

test("a login is checked with basic auth on email/token and labelled; a bad one is refused as dead", async () => {
  const calls = stub(() => json({ user: { id: 7, name: "Sarah" } }));
  expect(await own.connectWithKey!("zendesk", KEY)).toEqual({ secret: KEY, label: "Sarah (acme.zendesk.com)" });
  expect(calls[0]!.url).toBe("https://acme.zendesk.com/api/v2/users/me");
  expect(calls[0]!.headers.Authorization).toBe(`Basic ${btoa(`sarah@northwind.com/token:${TOKEN}`)}`);
  stub(() => json({ error: "Couldn't authenticate you" }, 401));
  const refused = await own.connectWithKey!("zendesk", KEY).catch((e) => e);
  expect(refused).toBeInstanceOf(AppsError);
  expect(refused.expired).toBe(true);
  // the anonymous visitor comes back with a 200 and no id
  stub(() => json({ user: { id: null, name: "Anonymous user" } }));
  expect((await own.connectWithKey!("zendesk", KEY).catch((e) => e)).expired).toBe(true);
});

test("reads run unasked, writes ask, searching by POST is a read, and the signing secret asks", async () => {
  for (const a of ["get_zendesk_ticket_by_id", "search_zendesk", "list_webhooks", "list_ticket_side_conversations", "download_attachment", "create_views_preview", "autocomplete_users"])
    expect((await own.getAction(`zendesk.${a}`))?.readOnly).toBe(true);
  for (const a of ["create_zendesk_ticket", "update_zendesk_ticket", "delete_zendesk_ticket", "reply_zendesk_ticket", "create_webhook", "show_webhook_signing_secret", "create_side_conversation"])
    expect((await own.getAction(`zendesk.${a}`))?.readOnly).toBeFalsy();
});

test("a ticket is created on the person's own Zendesk, under Composio's name", async () => {
  const calls = stub(() => json({ ticket: { id: 1 } }, 201));
  await run("zendesk.create_zendesk_ticket", { ticket: { subject: "Refund", comment: { body: "Hi" } } });
  expect(calls[0]!.method).toBe("POST");
  expect(calls[0]!.url).toBe("https://acme.zendesk.com/api/v2/tickets");
  expect(JSON.parse(String(calls[0]!.body))).toEqual({ ticket: { subject: "Refund", comment: { body: "Hi" } } });
});

test("a reply is a comment on the ticket, public unless asked, with a status change alongside", async () => {
  const calls = stub(() => json({ ticket: { id: 5 } }));
  await run("zendesk.reply_zendesk_ticket", { ticket_id: "5", body: "Sorted", status: "solved" });
  expect(calls[0]!.method).toBe("PUT");
  expect(calls[0]!.url).toBe("https://acme.zendesk.com/api/v2/tickets/5");
  expect(JSON.parse(String(calls[0]!.body))).toEqual({ ticket: { comment: { body: "Sorted", public: true }, status: "solved" } });
  await run("zendesk.reply_zendesk_ticket", { ticket_id: "5", body: "note", public: false });
  expect(JSON.parse(String(calls[1]!.body)).ticket.comment.public).toBe(false);
});

test("a write the spec gives no body passes one through whole", async () => {
  const calls = stub(() => json({ custom_role: { id: 3 } }));
  await run("zendesk.create_custom_role", { body: { custom_role: { name: "Team lead" } } });
  expect(JSON.parse(String(calls[0]!.body))).toEqual({ custom_role: { name: "Team lead" } });
});

test("a file goes up as itself with its type; an attachment comes back as a file", async () => {
  const calls = stub((c) =>
    c.url.includes("/uploads")
      ? json({ upload: { token: "t1" } }, 201)
      : c.url.includes("/api/v2/attachments/")
        ? json({ attachment: { file_name: "a.pdf", content_type: "application/pdf", content_url: "https://acme.zendesk.com/attachments/token/x/?name=a.pdf" } })
        : new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "application/pdf" } }),
  );
  await run("zendesk.create_zendesk_attachments", { filename: "a.pdf", file: new AppFile("a.pdf", "application/pdf", new Uint8Array([1])) });
  expect(calls[0]!.url).toBe("https://acme.zendesk.com/api/v2/uploads?filename=a.pdf");
  expect(calls[0]!.headers["Content-Type"]).toBe("application/pdf");
  const file = (await run("zendesk.download_attachment", { attachment_id: "9" })) as AppFile;
  expect(file).toBeInstanceOf(AppFile);
  expect(file.name).toBe("a.pdf");
  expect(calls[2]!.headers.Authorization).toStartWith("Basic ");
});

test("article attachments go up as a form under 'file'", async () => {
  const calls = stub(() => json({ article_attachment: { id: 1 } }));
  await run("zendesk.create_article_attachment", { article_id: 4, inline: true, file: new AppFile("p.png", "image/png", new Uint8Array([1])) });
  const form = calls[0]!.body as FormData;
  expect((form.get("file") as File).name).toBe("p.png");
  expect(form.get("inline")).toBe("true");
});

test("the first webhook trigger makes one webhook for the connection, the next adds its event, and the last removes it", async () => {
  const none = stub((c) => (c.method === "GET" ? json({ webhooks: [] }) : json({ webhook: { id: "W1" } }, 201)));
  expect(await own.startPush!("zendesk.ticket_created", login, {})).toBe("zendesk:c1");
  expect(new URL(none[0]!.url).searchParams.get("filter[name_contains]")).toBe("Emplio");
  expect(none[1]!.method).toBe("POST");
  const made = JSON.parse(String(none[1]!.body)).webhook;
  expect(made.endpoint).toBe(target());
  expect(made.subscriptions).toEqual(["zen:event-type:ticket.created"]);
  expect(made.request_format).toBe("json");
  const hooks = { webhooks: [{ id: "W0", endpoint: "https://other" }, { id: "W1", endpoint: target(), subscriptions: ["zen:event-type:ticket.created"] }] };
  const same = stub(() => json(hooks));
  await own.startPush!("zendesk.ticket_created", login, {});
  expect(same).toHaveLength(1);
  const extend = stub((c) => (c.method === "GET" ? json(hooks) : json({})));
  await own.startPush!("zendesk.ticket_comment_added", login, {});
  expect(extend[1]!.method).toBe("PATCH");
  expect(extend[1]!.url).toBe("https://acme.zendesk.com/api/v2/webhooks/W1");
  expect(JSON.parse(String(extend[1]!.body)).webhook.subscriptions).toEqual(["zen:event-type:ticket.created", "zen:event-type:ticket.comment_added"]);
  const gone = stub((c) => (c.method === "GET" ? json(hooks) : new Response(null, { status: 204 })));
  await zendesk.push!.stop!(KEY, "zendesk:c1");
  expect(gone[1]!.method).toBe("DELETE");
  expect(gone[1]!.url).toBe("https://acme.zendesk.com/api/v2/webhooks/W1");
});

test("someone who isn't a Zendesk admin is told so", async () => {
  stub(() => json({ error: "Forbidden" }, 403));
  await expect(own.startPush!("zendesk.ticket_created", login, {})).rejects.toThrow(/admin/);
});

const SECRET = "dGhlLXNlY3JldA";
const signed = (body: string, secret = SECRET, ts = "2026-11-22T10:00:00Z") => ({
  "x-zendesk-webhook-id": "W1",
  "x-zendesk-webhook-signature-timestamp": ts,
  "x-zendesk-webhook-signature": createHmac("sha256", secret).update(ts + body).digest("base64"),
});
const event = (type: string, detail: object = {}) => JSON.stringify({ id: `e-${type}`, type: `zen:event-type:${type}`, subject: "zen:ticket:5", time: "2026-11-22T10:00:00Z", detail, event: {} });
const delivery = (body: string, headers: Record<string, string> = signed(body), rest = urlToken()) => ({ body, headers, connection: "c1", rest });

test("a delivery needs our URL token and Zendesk's signature; the secret is fetched once", async () => {
  const calls = stub(() => json({ signing_secret: { algorithm: "SHA256", secret: SECRET } }));
  const body = event("ticket.created");
  expect(await zendesk.push!.receive!(delivery(body, signed(body), "nope"), KEY)).toBeNull();
  expect(await zendesk.push!.receive!(delivery(body, signed(body, "wrong")), KEY)).toBeNull();
  expect(await zendesk.push!.receive!(delivery(body, {}), KEY)).toBeNull();
  const ok = await zendesk.push!.receive!(delivery(body), KEY);
  expect(ok).not.toBeNull();
  expect(calls.every((c) => c.url === "https://acme.zendesk.com/api/v2/webhooks/W1/signing_secret")).toBe(true);
  const before = calls.length;
  await zendesk.push!.receive!(delivery(body), KEY);
  expect(calls.length).toBe(before);
});

test("each Zendesk event starts only its trigger, with the event's id for retries", async () => {
  stub(() => json({ signing_secret: { secret: SECRET } }));
  for (const [type, want] of [
    ["ticket.created", "ticket_created"],
    ["ticket.comment_added", "ticket_comment_added"],
    ["user.created", "user_created"],
    ["organization.deleted", "organization_deleted"],
    ["article.published", "article_published"],
    ["community_post.comment_created", "community_post_comment_created"],
    ["agent.state_changed", "agent_state_changed"],
  ]) {
    const [out] = await (await zendesk.push!.receive!(delivery(event(type!)), KEY))!.events();
    expect(out!.triggers).toEqual([want!]);
    expect(out!.id).toBe(`c1:e-${type}`);
  }
  expect(await (await zendesk.push!.receive!(delivery(event("ticket.something_new")), KEY))!.events()).toEqual([]);
});

test("ticket filters match status, group, brand and tag", () => {
  const data = { detail: { status: "OPEN", group_id: "10", brand_id: "20", tags: ["vip", "refund"] } };
  expect(wanted({}, data)).toBe(true);
  expect(wanted({ status: "open", group_id: "10", brand_id: "20", tag: "VIP" }, data)).toBe(true);
  expect(wanted({ status: "solved" }, data)).toBe(false);
  expect(wanted({ group_id: "11" }, data)).toBe(false);
  expect(wanted({ tag: "billing" }, { detail: { tags: null } })).toBe(false);
});

const now = new Date().toISOString();
test("new tickets are polled by search, and an update is a new event", async () => {
  const calls = stub(() => json({ results: [{ id: 1, created_at: now, updated_at: now }, { id: 2, created_at: "2020-01-01T00:00:00Z", updated_at: now }] }));
  const { config } = pollConfig("zendesk.new_zendesk_ticket_trigger", { query: "tags:vip" });
  const made = await pollOnce("zendesk.new_zendesk_ticket_trigger", config, [], run);
  const q = new URL(calls[0]!.url).searchParams;
  expect(q.get("query")).toBe("type:ticket created>24hours tags:vip");
  expect(q.get("sort_by")).toBe("created_at");
  expect(made.fresh.map((i: any) => i.ticket.id)).toEqual([1]);
  const changed = await pollOnce("zendesk.zendesk_ticket_updated", {}, [], run);
  expect(changed.seen).toEqual([`1:${now}`, `2:${now}`]);
});

test("every Zendesk event type has a trigger, none shares a polled one's name, and Composio's are there", async () => {
  const polled = (await import("../../polls/zendesk")).zendesk;
  expect(Object.keys(triggers)).toHaveLength(Object.keys(events).length);
  for (const t of Object.keys(triggers)) expect(polled[t]).toBeUndefined();
  expect(Object.keys(polled)).toContain("new_zendesk_ticket_trigger");
  expect(Object.keys(polled)).toContain("new_user_trigger");
});
