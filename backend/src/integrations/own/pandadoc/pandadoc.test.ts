import { afterEach, beforeAll, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { AppFile, AppsError } from "../../types";
import { own } from "../index";
import { triggers, wanted } from "./triggers";
import { pandadoc } from "./index";

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
    const c = { url: String(url), method: init.method ?? "GET", body: init.body, headers: init.headers as Record<string, string> };
    calls.push(c);
    return answer(c);
  }) as typeof fetch;
  return calls;
};
const login = { externalId: "c1", secret: "key" };
const token = () => createHmac("sha256", process.env.ENCRYPTION_KEY!).update("pandadoc-webhook:c1").digest("hex");
const target = () => `https://api.test/webhooks/app/pandadoc/c1/events/${token()}`;
const HOOKS = "https://api.pandadoc.com/public/v1/webhook-subscriptions";
const hooks = (items: unknown[]) => (c: Call) => (c.method === "GET" ? json({ items }) : json({}));
const delivery = (body: unknown, rest = `events/${token()}`, headers: Record<string, string> = { "x-pandadoc-webhook-event-id": "d1" }) => ({ body: JSON.stringify(body), headers, connection: "c1", rest });
const doc = { id: "D1", name: "Northwind contract", status: "document.completed", template: { id: "T1" } };

test("a key is sent as API-Key and labelled, and a bad one is refused as dead", async () => {
  const calls = stub(() => json({ email: "sarah@northwind.test", workspace_name: "Northwind" }));
  expect(await own.connectWithKey!("pandadoc", " key ")).toEqual({ secret: "key", label: "sarah@northwind.test (Northwind)" });
  expect(calls[0]!.url).toBe("https://api.pandadoc.com/public/v1/members/current");
  expect(calls[0]!.headers.Authorization).toBe("API-Key key");
  stub(() => json({ type: "authentication_error", detail: "Authentication credentials were not provided." }, 401));
  const refused = await own.connectWithKey!("pandadoc", "nope").catch((e) => e);
  expect(refused).toBeInstanceOf(AppsError);
  expect(refused.expired).toBe(true);
});

test("reads run unasked; writes and calls that show a shared key ask", async () => {
  for (const a of ["list_documents", "get_document_details", "list_templates", "get_documents_ai_metadata"]) expect((await own.getAction(`pandadoc.${a}`))?.readOnly).toBe(true);
  for (const a of ["send_document", "create_document", "delete_document", "create_webhook", "list_webhook_subscriptions", "get_webhook_subscription_details"])
    expect((await own.getAction(`pandadoc.${a}`))?.readOnly).toBe(false);
});

test("an upload keeps PandaDoc's ?upload flag next to its other query fields", async () => {
  const calls = stub(() => json({ id: "D1" }));
  const pdf = new AppFile("deal.pdf", "application/pdf", new Uint8Array([1, 2]));
  await own.run("pandadoc.create_document_from_file", { file: pdf, data: { name: "Deal" }, editor_ver: "ev1" }, login, "o");
  expect(calls[0]!.url).toBe("https://api.pandadoc.com/public/v1/documents?editor_ver=ev1&upload=");
  const form = calls[0]!.body as FormData;
  expect((form.get("file") as File).name).toBe("deal.pdf");
  expect(JSON.parse(String(form.get("data")))).toMatchObject({ name: "Deal" });
  await own.run("pandadoc.create_document_attachment_from_upload", { id: "D1", file: pdf, name: "Terms" }, login, "o");
  expect(calls[1]!.url).toBe("https://api.pandadoc.com/public/v1/documents/D1/attachments?upload=");
  expect((calls[1]!.body as FormData).get("name")).toBe("Terms");
});

test("a download comes back as a file named after the document", async () => {
  stub(() => new Response(new Uint8Array([37, 80, 68, 70]), { headers: { "content-type": "application/pdf" } }));
  const got = (await own.run("pandadoc.download_document", { id: "D1" }, login, "o")) as AppFile;
  expect(got).toBeInstanceOf(AppFile);
  expect(got.name).toBe("D1.pdf");
});

test("the first automation makes the webhook, the next adds its event, and a switched-off one is switched back on", async () => {
  const none = stub(hooks([{ uuid: "other", url: "https://x", active: true, triggers: [] }]));
  expect(await own.startPush!("pandadoc.document_state_changed", login, {})).toBe("pandadoc:c1:events");
  expect(none[1]!.method).toBe("POST");
  expect(none[1]!.url).toBe(HOOKS);
  expect(JSON.parse(String(none[1]!.body))).toEqual({ name: "Emplio", url: target(), active: true, payload: ["metadata", "fields", "products", "tokens", "pricing"], triggers: ["document_state_changed"] });
  const more = stub(hooks([{ uuid: "w1", url: target(), active: true, triggers: ["document_state_changed"] }]));
  await own.startPush!("pandadoc.recipient_completed", login, {});
  expect(more[1]!.method).toBe("PATCH");
  expect(more[1]!.url).toBe(`${HOOKS}/w1`);
  expect(JSON.parse(String(more[1]!.body))).toEqual({ active: true, triggers: ["document_state_changed", "recipient_completed"] });
  const same = stub(hooks([{ uuid: "w1", url: target(), active: true, triggers: ["recipient_completed"] }]));
  await own.startPush!("pandadoc.recipient_completed", login, {});
  expect(same).toHaveLength(1);
  const off = stub(hooks([{ uuid: "w1", url: target(), active: false, triggers: ["recipient_completed"] }]));
  await own.startPush!("pandadoc.recipient_completed", login, {});
  expect(JSON.parse(String(off[1]!.body))).toEqual({ active: true, triggers: ["recipient_completed"] });
});

test("the last automation removes the webhook, found by its URL", async () => {
  const calls = stub(hooks([{ uuid: "other", url: "https://x", active: true }, { uuid: "w1", url: target(), active: true }]));
  await pandadoc.push!.stop!("key", "pandadoc:c1:events");
  expect(calls[1]!.method).toBe("DELETE");
  expect(calls[1]!.url).toBe(`${HOOKS}/w1`);
});

test("a bad token in the URL is refused", async () => {
  expect(await pandadoc.push!.receive!(delivery([], "events/nope"), "k")).toBeNull();
  expect(await pandadoc.push!.receive!(delivery([], ""), "k")).toBeNull();
  expect(await pandadoc.push!.receive!({ ...delivery([]), connection: "c2" }, "k")).toBeNull();
});

test("each event starts only its own trigger, with the delivery id for retries", async () => {
  for (const name of Object.keys(triggers)) {
    const out = await (await pandadoc.push!.receive!(delivery([{ event: name, data: doc }]), "k"))!.events();
    expect(out.map((e) => e.triggers)).toEqual([[name]]);
  }
  const out = await (await pandadoc.push!.receive!(delivery([{ event: "document_state_changed", data: doc }, { event: "something_new", data: doc }, { event: "recipient_completed", data: doc }]), "k"))!.events();
  expect(out.map((e) => e.id)).toEqual(["pandadoc:c1:d1:0", "pandadoc:c1:d1:2"]);
  expect(out[0]!.data).toMatchObject({ event: "document_state_changed", id: "D1", name: "Northwind contract" });
  // without PandaDoc's delivery id, a retry still has the same id
  const a = await (await pandadoc.push!.receive!(delivery([{ event: "document_state_changed", data: doc }], undefined, {}), "k"))!.events();
  const b = await (await pandadoc.push!.receive!(delivery([{ event: "document_state_changed", data: doc }], undefined, {}), "k"))!.events();
  expect(a[0]!.id).toBe(b[0]!.id!);
});

test("filters narrow what runs", () => {
  const d = { event: "recipient_completed", ...doc, action_by: { email: "Sarah@Northwind.test" } };
  expect(wanted({}, d)).toBe(true);
  expect(wanted({ status: "document.completed" }, d)).toBe(true);
  expect(wanted({ status: "completed" }, d)).toBe(true);
  expect(wanted({ status: "document.sent" }, d)).toBe(false);
  expect(wanted({ template_id: "T1" }, d)).toBe(true);
  expect(wanted({ template_id: "T2" }, d)).toBe(false);
  expect(wanted({ document_id: "D2" }, d)).toBe(false);
  expect(wanted({ recipient_email: "sarah@northwind.test" }, d)).toBe(true);
  expect(wanted({ recipient_email: "tom@northwind.test" }, d)).toBe(false);
  expect(wanted({ template_id: "T1" }, { event: "template_updated", id: "T1" })).toBe(true);
});

test("every PandaDoc event is a trigger", () => {
  expect(Object.keys(triggers).sort()).toEqual(
    [
      "content_library_item_created", "content_library_item_creation_failed", "document_completed_pdf_ready", "document_creation_failed", "document_deleted",
      "document_section_added", "document_state_changed", "document_updated", "quote_updated", "recipient_completed", "recipient_qes_verified",
      "template_created", "template_deleted", "template_updated",
    ],
  );
});
