// WhatsApp, linked, against a stand-in for Emplio's WhatsApp server: linking, reads and writes, files, the
// new-message trigger and its webhook through the real route. whatsapp/whatsapp.test.ts tests the server itself.
import { afterEach, beforeAll, expect, spyOn, test } from "bun:test";
import { createHmac, randomBytes } from "node:crypto";
import Fastify from "fastify";
import { automationRoutes } from "../../../automations";
import { db } from "../../../db";
import { encrypt } from "../../../secrets";
import { AppFile, AppsError } from "../../types";
import { own } from "../index";
import { whatsapp_linked, wanted, webhookSecret } from "./index";
import { linkedAccount } from "./link";

const ACCT = "6386a0fb-6ef1-404c-9934-88e548257ad3";
const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});
beforeAll(() => {
  process.env.ENCRYPTION_KEY = randomBytes(32).toString("base64");
  process.env.WEBHOOK_URL = "https://api.test";
  process.env.WHATSAPP_URL = "http://wa.test:4200";
  process.env.WHATSAPP_TOKEN = "t".repeat(40);
});
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
type Call = { url: string; method: string; body: string; headers: Record<string, string> };
const stub = (answer: (c: Call) => Response) => {
  const calls: Call[] = [];
  globalThis.fetch = (async (url: string | URL, init: RequestInit = {}) => {
    const c = { url: String(url), method: init.method ?? "GET", body: String(init.body ?? ""), headers: (init.headers ?? {}) as Record<string, string> };
    calls.push(c);
    return answer(c);
  }) as typeof fetch;
  return calls;
};
const login = { externalId: "c1", secret: ACCT };
const linked = { id: ACCT, status: "idle", linked: true, me: { jid: "15551234567@s.whatsapp.net", name: "Northwind", phone: "+15551234567" }, watching: false };

test("offered only where the WhatsApp server is set up, as a sign-in", async () => {
  expect((await own.readyApps()).has("whatsapp_linked")).toBe(true);
  expect((await own.getApp("whatsapp_linked"))?.signIn).toBe(true);
  const url = delete process.env.WHATSAPP_URL;
  try {
    expect((await own.readyApps()).has("whatsapp_linked")).toBe(false);
  } finally {
    if (url) process.env.WHATSAPP_URL = "http://wa.test:4200";
  }
});

test("a linked account is labelled with its number and name; an unlinked one has to be linked again", async () => {
  const calls = stub(() => json(linked));
  expect(await whatsapp_linked.check(ACCT)).toBe("+15551234567 (Northwind)");
  expect(calls[0]!.url).toBe(`http://wa.test:4200/accounts/${ACCT}`);
  expect(calls[0]!.headers.authorization).toBe(`Bearer ${"t".repeat(40)}`);
  stub(() => json({ ...linked, linked: false, status: "unlinked" }));
  const e = await whatsapp_linked.check(ACCT).catch((x) => x);
  expect(e).toBeInstanceOf(AppsError);
  expect(e.expired).toBe(true);
  stub(() => json({ error: "no such account" }, 404));
  expect((await whatsapp_linked.check(ACCT).catch((x) => x)).expired).toBe(true);
  await expect(whatsapp_linked.check("not-an-id")).rejects.toBeInstanceOf(AppsError);
});

test("the sign-in goes to our own QR page, and only a code that page made finishes it", async () => {
  const { url } = await own.startSignIn("whatsapp_linked", "o", "https://api.test/connections/x/done");
  const state = new URL(url).searchParams.get("state")!;
  expect(url.startsWith("https://api.test/whatsapp/link?state=")).toBe(true);
  expect(own.readSignIn!("whatsapp_linked", state)).not.toBeNull();
  stub(() => json(linked));
  const sig = createHmac("sha256", process.env.ENCRYPTION_KEY!).update(`wa-link:${ACCT}:${state}`).digest("base64url");
  expect(await linkedAccount(`${ACCT}.${sig}`, state)).toBe(ACCT);
  await expect(linkedAccount(`${ACCT}.forged`, state)).rejects.toBeInstanceOf(AppsError);
  await expect(linkedAccount(`${ACCT}.${sig}`, "another-state")).rejects.toBeInstanceOf(AppsError);
  stub(() => json({ ...linked, linked: false, status: "linking" }));
  await expect(linkedAccount(`${ACCT}.${sig}`, state)).rejects.toBeInstanceOf(AppsError);
});

test("reads run unasked, writes ask", async () => {
  for (const a of ["get_account", "list_chats", "get_messages", "search_messages", "list_contacts", "get_group", "download_media"]) expect((await own.getAction(`whatsapp_linked.${a}`))?.readOnly).toBe(true);
  for (const a of ["send_message", "send_file", "react_to_message", "mark_as_read"]) expect((await own.getAction(`whatsapp_linked.${a}`))?.readOnly).toBeFalsy();
});

test("reads and sends go to the account on the WhatsApp server", async () => {
  const calls = stub(() => json({ chats: [] }));
  await own.run("whatsapp_linked.list_chats", { query: "sarah", unread_only: true }, login, "o");
  expect(calls[0]!.url).toBe(`http://wa.test:4200/accounts/${ACCT}/chats?query=sarah&kind=all&unread=true&limit=30`);
  await own.run("whatsapp_linked.send_message", { to: "+1 555 000 1111", text: "On its way", reply_to: "ABC" }, login, "o");
  expect(calls[1]!.method).toBe("POST");
  expect(JSON.parse(calls[1]!.body)).toEqual({ to: "+1 555 000 1111", text: "On its way", reply_to: "ABC" });
  stub(() => json({ error: "WhatsApp messages only go to people and groups this WhatsApp already chats with." }, 400));
  await expect(own.run("whatsapp_linked.send_message", { to: "x", text: "hi" }, login, "o")).rejects.toThrow(/already chats with/);
});

test("files go out and come back as files", async () => {
  const calls = stub(() => json({ sent: true }));
  await own.run("whatsapp_linked.send_file", { to: "Sarah", file: new AppFile("quote.pdf", "application/pdf", new Uint8Array([1, 2, 3])), caption: "Here" }, login, "o");
  expect(JSON.parse(calls[0]!.body)).toEqual({ to: "Sarah", name: "quote.pdf", type: "application/pdf", data: "AQID", caption: "Here" });
  await expect(own.run("whatsapp_linked.send_file", { to: "Sarah", file: "/work/quote.pdf" }, login, "o")).rejects.toBeInstanceOf(AppsError);
  stub(() => new Response(new Uint8Array([9, 9]), { headers: { "content-type": "audio/ogg", "x-filename": "voice%20note.ogg" } }));
  const f = (await own.run("whatsapp_linked.download_media", { chat: "Sarah", message: "M1" }, login, "o")) as AppFile;
  expect(f).toBeInstanceOf(AppFile);
  expect([f.name, f.mimetype, f.bytes.length]).toEqual(["voice note.ogg", "audio/ogg", 2]);
});

test("the trigger asks the server to stay connected and tell our webhook, and stops", async () => {
  const calls = stub(() => json(linked));
  expect(await own.startPush!("whatsapp_linked.new_message", login, {})).toBe("whatsapp_linked:c1");
  expect(calls[0]!.method).toBe("PUT");
  expect(JSON.parse(calls[0]!.body)).toEqual({ url: "https://api.test/webhooks/app/whatsapp_linked/c1", secret: webhookSecret("c1") });
  await whatsapp_linked.push!.stop!(ACCT, "whatsapp_linked:c1");
  expect(calls[1]!.method).toBe("DELETE");
  expect(calls[1]!.url).toBe(`http://wa.test:4200/accounts/${ACCT}/watch`);
});

const msg = { id: "M1", chat: "15550001111@s.whatsapp.net", chat_name: "Sarah Lee", is_group: false, from_me: false, from: "+15550001111", from_name: "Sarah Lee", time: "2026-11-19T10:00:00Z", type: "conversation", text: "Is my order ready?", has_media: false };

test("settings pick the messages an automation wants", () => {
  expect(wanted({}, msg)).toBe(true);
  expect(wanted({}, { ...msg, from_me: true })).toBe(false);
  expect(wanted({ from_me: true }, { ...msg, from_me: true })).toBe(true);
  expect(wanted({ groups: "exclude" }, { ...msg, is_group: true })).toBe(false);
  expect(wanted({ groups: "only" }, msg)).toBe(false);
  expect(wanted({ chat: "sarah" }, msg)).toBe(true);
  expect(wanted({ chat: "+15550001111" }, msg)).toBe(true);
  expect(wanted({ chat: "Northwind team" }, msg)).toBe(false);
  expect(wanted({ contains: "ORDER" }, msg)).toBe(true);
  expect(wanted({ contains: "invoice" }, msg)).toBe(false);
});

test("the webhook: a forged message gets 401, a signed one 200", async () => {
  const find = spyOn(db.query.connections, "findFirst");
  const app = Fastify();
  await automationRoutes(app);
  const body = JSON.stringify({ id: `${msg.chat}:M1`, message: msg });
  const post = (signature: string) =>
    app.inject({ method: "POST", url: "/webhooks/app/whatsapp_linked/c1", headers: { "content-type": "application/json", "x-emplio-signature": signature }, payload: body });
  try {
    find.mockResolvedValue(undefined as never);
    expect((await post("x")).statusCode).toBe(401);
    find.mockResolvedValue({ id: "row", app: "whatsapp_linked", secret: encrypt(ACCT), refreshToken: null, expiresAt: null } as never);
    expect((await post("0".repeat(64))).statusCode).toBe(401);
    // an automation lookup follows in the background; none here
    const select = spyOn(db, "select").mockReturnValue({ from: () => ({ where: async () => [] }) } as never);
    try {
      expect((await post(createHmac("sha256", webhookSecret("c1")).update(body).digest("hex"))).statusCode).toBe(200);
    } finally {
      select.mockRestore();
    }
  } finally {
    find.mockRestore();
    await app.close();
  }
});
