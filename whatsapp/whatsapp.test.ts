// The WhatsApp program's own rules, without WhatsApp: what a message says, the saved chats and search, who sends may
// go to and how many, and that the API wants its token. Run: npm test
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const dir = mkdtempSync(join(tmpdir(), "wa-test-"));
process.env.DATA_DIR = dir;
after(() => rmSync(dir, { recursive: true, force: true }));
const { Store } = await import("./store.ts");
const { canon, targetOf, textOf, quotedOf } = await import("./text.ts");
const { Account, LIMITS, serve } = await import("./server.ts");

test("what a message says", () => {
  assert.deepEqual(textOf({ conversation: "hi" }), { type: "conversation", text: "hi" });
  assert.deepEqual(textOf({ extendedTextMessage: { text: "see this" } }), { type: "extendedText", text: "see this" });
  assert.equal(textOf({ imageMessage: { caption: "the invoice" } })?.text, "[photo] the invoice");
  assert.equal(textOf({ audioMessage: { ptt: true } })?.text, "[voice note]");
  assert.equal(textOf({ documentMessage: { fileName: "quote.pdf" } })?.text, "[file: quote.pdf]");
  assert.equal(textOf({ ephemeralMessage: { message: { conversation: "disappearing" } } })?.text, "disappearing");
  // not something anyone said
  assert.equal(textOf({ reactionMessage: { text: "👍" } }), null);
  assert.equal(textOf({ protocolMessage: { type: 0 } }), null);
  assert.equal(quotedOf({ extendedTextMessage: { text: "yes", contextInfo: { quotedMessage: { conversation: "can you deliver friday?" } } } }), "can you deliver friday?");
});

test("people by phone number where WhatsApp gives one", () => {
  assert.equal(canon("15551234567:3@s.whatsapp.net"), "15551234567@s.whatsapp.net");
  assert.equal(canon("999@lid", "15551234567@s.whatsapp.net"), "15551234567@s.whatsapp.net");
  assert.equal(canon("999@lid", null, (lid) => (lid === "999@lid" ? "15550000000@s.whatsapp.net" : null)), "15550000000@s.whatsapp.net");
  assert.equal(canon("999@lid"), "999@lid");
  assert.deepEqual(targetOf("+1 (555) 123-4567"), { jid: "15551234567@s.whatsapp.net" });
  assert.deepEqual(targetOf("Northwind team"), { name: "Northwind team" });
  assert.deepEqual(targetOf("123@g.us"), { jid: "123@g.us" });
});

test("chats, messages and search are kept and found", () => {
  const s = new Store(join(dir, "store"));
  s.contact("15551234567@s.whatsapp.net", "Sarah Lee", null);
  const base = { from_me: 0, sender: "15551234567@s.whatsapp.net", sender_name: "Sarah", type: "conversation", quoted: null, raw: null };
  assert.equal(s.message({ ...base, chat: "15551234567@s.whatsapp.net", id: "a", ts: 1000, text: "Is the order shipped?" }), true);
  assert.equal(s.message({ ...base, chat: "15551234567@s.whatsapp.net", id: "a", ts: 1000, text: "Is the order shipped?" }), false);
  s.message({ ...base, chat: "123@g.us", id: "b", ts: 2000, text: "Team lunch on Friday" });
  s.chat("123@g.us", { name: "Northwind team" });
  s.bumpUnread("123@g.us");
  assert.deepEqual(s.chats({ limit: 10 }).map((c) => [c.name, c.is_group, c.unread]), [["Northwind team", 1, 1], ["Sarah Lee", 0, 0]]);
  assert.deepEqual(s.chats({ query: "sarah", limit: 10 }).map((c) => c.jid), ["15551234567@s.whatsapp.net"]);
  assert.deepEqual(s.chats({ kind: "groups", limit: 10 }).map((c) => c.jid), ["123@g.us"]);
  assert.deepEqual(s.chats({ unread: true, limit: 10 }).map((c) => c.jid), ["123@g.us"]);
  assert.deepEqual(s.search("order", { limit: 10 }).map((m) => m.id), ["a"]);
  assert.deepEqual(s.search('friday "lunch', { limit: 10 }).map((m) => m.id), ["b"]);
  assert.deepEqual(s.search("order", { chat: "123@g.us", limit: 10 }), []);
  s.close();
});

test("sends only to known chats, and not too many", () => {
  const a = new Account("00000000-0000-4000-8000-000000000001");
  a.store.chat("15551234567@s.whatsapp.net", { name: "Sarah" });
  assert.throws(() => a.checkSend("15550000000@s.whatsapp.net"), /already chats with/);
  a.checkSend("15551234567@s.whatsapp.net");
  for (let i = 0; i < LIMITS.hour; i++) a.store.noteSend();
  assert.throws(() => a.checkSend("15551234567@s.whatsapp.net"), /last hour/);
  assert.equal(a.chatFor("Sarah"), "15551234567@s.whatsapp.net");
  assert.throws(() => a.chatFor("Nobody"), /no chat called/);
  a.store.close();
});

test("the API wants its token", async () => {
  const server = serve("t".repeat(32)).listen(0);
  const port = (server.address() as { port: number }).port;
  try {
    assert.equal((await fetch(`http://127.0.0.1:${port}/health`)).status, 200);
    assert.equal((await fetch(`http://127.0.0.1:${port}/accounts/x`)).status, 401);
    const wrong = await fetch(`http://127.0.0.1:${port}/accounts/00000000-0000-4000-8000-000000000009`, { headers: { authorization: `Bearer ${"t".repeat(32)}` } });
    assert.equal(wrong.status, 404);
  } finally {
    server.close();
  }
});
