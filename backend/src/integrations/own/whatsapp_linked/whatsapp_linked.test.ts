// WhatsApp, linked, against a stand-in for Emplio's WhatsApp server: linking, reads and writes, files, and the hourly
// new-message check. whatsapp/whatsapp_test.go tests the server itself.
import { afterEach, beforeAll, expect, test } from "bun:test";
import { createHmac, randomBytes } from "node:crypto";
import { AppFile, AppsError } from "../../types";
import { own } from "../index";
import { pollConfig, pollDetail, pollOnce } from "../../polls";
import { whatsapp_linked, wanted } from "./index";
import { linkedAccount } from "./link";

const ACCT = "6386a0fb-6ef1-404c-9934-88e548257ad3";
const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});
beforeAll(() => {
  process.env.ENCRYPTION_KEY = randomBytes(32).toString("base64");
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
const linked = { id: ACCT, status: "idle", linked: true, me: { jid: "15551234567@s.whatsapp.net", name: "Northwind", phone: "+15551234567" } };

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
  for (const a of ["get_account", "list_chats", "get_messages", "list_recent_messages", "search_messages", "list_contacts", "get_group", "download_media", "get_message", "check_numbers", "list_events"])
    expect((await own.getAction(`whatsapp_linked.${a}`))?.readOnly).toBe(true);
  const writes = ["send_message", "send_file", "react_to_message", "mark_as_read", "reply_to_message", "edit_message", "delete_message", "forward_message", "pin_message", "send_poll"];
  const groups = ["create_group", "add_group_members", "remove_group_members", "make_group_admins", "remove_group_admins", "update_group_settings", "get_group_invite_link", "join_group", "leave_group"];
  for (const a of [...writes, ...groups]) expect((await own.getAction(`whatsapp_linked.${a}`))?.readOnly).toBeFalsy();
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

test("replies, edits, polls and group changes go to their own routes", async () => {
  const calls = stub(() => json({ ok: true }));
  await own.run("whatsapp_linked.reply_to_message", { chat: "Sarah", message: "M1", text: "Yes, ready" }, login, "o");
  expect([calls[0]!.method, calls[0]!.url]).toEqual(["POST", `http://wa.test:4200/accounts/${ACCT}/reply`]);
  expect(JSON.parse(calls[0]!.body)).toEqual({ chat: "Sarah", message: "M1", text: "Yes, ready" });
  await own.run("whatsapp_linked.send_poll", { to: "Northwind team", question: "Lunch?", options: ["Pizza", "Sushi"] }, login, "o");
  expect(JSON.parse(calls[1]!.body)).toEqual({ to: "Northwind team", question: "Lunch?", options: ["Pizza", "Sushi"], multiple: false });
  await own.run("whatsapp_linked.make_group_admins", { chat: "Northwind team", phones: ["+15550001111"] }, login, "o");
  expect([calls[2]!.url, JSON.parse(calls[2]!.body).action]).toEqual([`http://wa.test:4200/accounts/${ACCT}/group/members`, "promote"]);
  await own.run("whatsapp_linked.list_events", { kinds: ["edited", "deleted"] }, login, "o");
  expect(calls[3]!.url).toBe(`http://wa.test:4200/accounts/${ACCT}/events?kinds=edited%2Cdeleted&limit=200`);
  await expect(own.run("whatsapp_linked.send_poll", { to: "x", question: "?", options: ["only one"] }, login, "o")).rejects.toThrow();
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

test("new messages are checked every hour, not pushed", async () => {
  expect(whatsapp_linked.push).toBeUndefined();
  expect(pollDetail("whatsapp_linked.new_message")?.input[0]?.description).toContain("default 60, at least 60");
  expect(() => pollConfig("whatsapp_linked.new_message", { every: 15 })).toThrow(/at least 60/);
  const run = (messages: unknown[]) => {
    const calls: { action: string; input: any }[] = [];
    return { calls, run: async (action: string, input: unknown) => (calls.push({ action, input }), { messages }) };
  };
  const first = run([msg]);
  const noted = await pollOnce("whatsapp_linked.new_message", {}, null, first.run);
  expect(first.calls[0]!.action).toBe("whatsapp_linked.list_recent_messages");
  expect(Date.now() - Date.parse(first.calls[0]!.input.after)).toBeGreaterThan(2 * 3600_000);
  // the first check only notes what's there
  expect(noted.fresh).toEqual([]);
  const mine = { ...msg, id: "M2", from_me: true, text: "On its way" };
  const group = { ...msg, id: "M3", chat: "123@g.us", chat_name: "Northwind team", is_group: true, text: "Order for Friday" };
  const later = await pollOnce("whatsapp_linked.new_message", { groups: "include" }, noted.seen, run([group, mine, msg]).run);
  expect(later.fresh).toEqual([{ message: group }]);
  expect((await pollOnce("whatsapp_linked.new_message", { groups: "exclude" }, noted.seen, run([group]).run)).fresh).toEqual([]);
});

test("a check reads recent messages from the server", async () => {
  const calls = stub(() => json({ messages: [] }));
  await own.run("whatsapp_linked.list_recent_messages", { after: "2026-11-19T10:00:00Z" }, login, "o");
  expect(calls[0]!.url).toBe(`http://wa.test:4200/accounts/${ACCT}/recent?after=2026-11-19T10%3A00%3A00Z&limit=200`);
});

test("edits, deletes, reactions and group changes are their own hourly triggers", async () => {
  const ev = { event: 7, kind: "reaction", time: "2026-11-19T10:00:00Z", chat: msg.chat, chat_name: "Sarah Lee", is_group: false, message: "M1", from: "+15550001111", from_name: "Sarah Lee", from_me: false, text: "👍" };
  const calls: { action: string; input: any }[] = [];
  const run = (events: unknown[]) => async (action: string, input: unknown) => (calls.push({ action, input }), { events });
  const noted = await pollOnce("whatsapp_linked.new_reaction", {}, null, run([]));
  expect([calls[0]!.action, calls[0]!.input.kinds]).toEqual(["whatsapp_linked.list_events", ["reaction"]]);
  const mine = { ...ev, event: 8, from: "me", from_me: true };
  expect((await pollOnce("whatsapp_linked.new_reaction", {}, noted.seen, run([ev, mine]))).fresh).toEqual([{ event: ev }]);
  expect((await pollOnce("whatsapp_linked.new_reaction", { chat: "Northwind" }, noted.seen, run([ev]))).fresh).toEqual([]);
  await pollOnce("whatsapp_linked.group_members_changed", {}, null, run([]));
  expect(calls.at(-1)!.input.kinds).toEqual(["joined", "left", "promoted", "demoted"]);
  expect(() => pollConfig("whatsapp_linked.message_deleted", { every: 15 })).toThrow(/at least 60/);
});
