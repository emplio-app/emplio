// Emplio's WhatsApp program: people link their own WhatsApp (or WhatsApp Business app) to Emplio the way they'd link
// WhatsApp on a computer, and Emplio reads, searches and answers their chats through the HTTP API below. Each linked
// account is a WhatsApp Web session (Baileys) with its login and messages in its own folder (store.ts).
//
// An account stays connected only while something needs it: an automation waiting for new messages (watch), or for a
// few minutes after a read or send. Otherwise it disconnects, and every few hours it connects briefly to catch up on
// what came in (WhatsApp keeps a linked device's missed messages for it). Sends only go to chats the account already
// has, and slowly, so the person's number isn't flagged.
//
// Runs on Node 22.18+ (it runs .ts directly). Settings: WHATSAPP_TOKEN (required, 32+ characters; Emplio sends it on
// every request), PORT (4200), HOST (0.0.0.0), DATA_DIR (./data).
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { existsSync, readdirSync, rmSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import makeWASocket, { BufferJSON, DisconnectReason, downloadMediaMessage, fetchLatestBaileysVersion, initAuthCreds, makeCacheableSignalKeyStore, proto } from "baileys";
import type { AnyMessageContent, AuthenticationCreds, SignalDataSet, WAMessage, WASocket } from "baileys";
import pino from "pino";
import QRCode from "qrcode";
import { type Message, Store } from "./store.ts";
import { canon, MEDIA, phoneOf, quotedOf, targetOf, textOf, tsOf } from "./text.ts";

const DATA_DIR = process.env.DATA_DIR ?? "./data";
// connected this long after it was last used, unless an automation watches it
const IDLE_MS = 10 * 60_000;
// a quiet account connects this often to catch up
const CATCH_UP_MS = 4 * 3600_000;
// a link that isn't finished in this time is given up
const LINK_MS = 15 * 60_000;
// sends per account: WhatsApp flags numbers that send a lot, fast
export const LIMITS = { hour: 20, day: 150 };
const ID = /^[0-9a-f-]{36}$/;

const logger = pino({ level: process.env.LOG_LEVEL ?? "warn" });
const log = (id: string, ...what: unknown[]) => console.log(new Date().toISOString(), id.slice(0, 8), ...what);

class Refused extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

// The login, in the account's own database.
function authState(store: Store) {
  const read = (k: string) => {
    const v = store.get(k);
    return v ? JSON.parse(v, BufferJSON.reviver) : null;
  };
  const creds: AuthenticationCreds = read("auth:creds") ?? initAuthCreds();
  return {
    creds,
    keys: {
      get: async (type: string, ids: string[]) => {
        const out: Record<string, unknown> = {};
        for (const id of ids) {
          let v = read(`auth:${type}:${id}`);
          if (type === "app-state-sync-key" && v) v = proto.Message.AppStateSyncKeyData.fromObject(v);
          out[id] = v;
        }
        return out;
      },
      set: async (data: SignalDataSet) => {
        store.db.exec("begin");
        try {
          for (const type in data)
            for (const [id, v] of Object.entries((data as Record<string, Record<string, unknown>>)[type]!))
              store.set(`auth:${type}:${id}`, v ? JSON.stringify(v, BufferJSON.replacer) : null);
          store.db.exec("commit");
        } catch (error) {
          store.db.exec("rollback");
          throw error;
        }
      },
    },
    save: () => store.set("auth:creds", JSON.stringify(creds, BufferJSON.replacer)),
  };
}

let version: { at: number; v: Promise<[number, number, number] | undefined> } | null = null;
const waVersion = () => {
  if (!version || Date.now() - version.at > 12 * 3600_000)
    version = { at: Date.now(), v: fetchLatestBaileysVersion().then((r) => r.version as [number, number, number], () => undefined) };
  return version.v;
};

type Meta = { created: number; linked: boolean; unlinked?: boolean; me?: { jid: string; name: string | null; phone: string | null }; watch?: { url: string; secret: string }; caughtUp?: number };
type Status = "linking" | "open" | "closed" | "logged_out";

export class Account {
  id: string;
  store: Store;
  meta: Meta;
  sock: WASocket | null = null;
  status: Status = "closed";
  qr: string | null = null;
  code: string | null = null;
  wantCode: string | null = null;
  lastUse = Date.now();
  stopping = false;
  retries = 0;
  // set when it connected after being away: messages it missed arrive in the first seconds
  openedAt = 0;

  constructor(id: string) {
    this.id = id;
    this.store = new Store(join(DATA_DIR, id));
    this.meta = JSON.parse(this.store.get("meta") ?? "null") ?? { created: Date.now(), linked: false };
    if (!this.store.get("meta")) this.saveMeta();
  }
  saveMeta() {
    this.store.set("meta", JSON.stringify(this.meta));
  }

  known = (lid: string) => this.store.get(`lid:${lid}`);
  noteLid(lid?: string | null, pn?: string | null) {
    if (lid && pn) this.store.set(`lid:${lid.split("@")[0]!.split(":")[0]}@lid`, pn.replace(/:\d+@/, "@"));
  }

  state() {
    // connected / idle (linked, not connected right now) / linking / unlinked (from the phone: link again)
    const status = this.meta.linked ? (this.status === "open" ? "connected" : "idle") : this.meta.unlinked ? "unlinked" : "linking";
    return { id: this.id, status, linked: this.meta.linked, qr: this.qr, code: this.code, me: this.meta.me ?? null, watching: !!this.meta.watch };
  }

  // Connects (a new account: starts linking). Safe to call again while it's on its way.
  start() {
    if (this.sock) return;
    this.stopping = false;
    const auth = authState(this.store);
    void waVersion().then((v) => {
      if (this.sock || this.stopping) return;
      const sock = makeWASocket({
        ...(v && { version: v }),
        auth: { creds: auth.creds, keys: makeCacheableSignalKeyStore(auth.keys as never, logger) },
        logger,
        browser: ["Emplio", "Chrome", "1.0"],
        printQRInTerminal: false,
        // the person's phone keeps getting notifications, and their customers don't see blue ticks from us
        markOnlineOnConnect: false,
        syncFullHistory: false,
        getMessage: async (key) => {
          const raw = key.id ? this.store.findMessage(key.id)?.raw : null;
          return raw ? (JSON.parse(raw, BufferJSON.reviver) as WAMessage).message ?? undefined : undefined;
        },
      });
      this.sock = sock;
      sock.ev.on("creds.update", auth.save);
      sock.ev.on("connection.update", (u) => void this.onConnection(sock, u).catch((error) => log(this.id, "connection update failed", error)));
      sock.ev.on("messaging-history.set", (h) => {
        this.store.db.exec("begin");
        try {
          for (const m of h.lidPnMappings ?? []) this.noteLid(m.lid, m.pn);
          for (const c of h.contacts) {
            this.noteLid(c.lid, c.phoneNumber ?? (c.id.endsWith("@s.whatsapp.net") ? c.id : null));
            const jid = canon(c.id, c.phoneNumber, this.known);
            if (jid) this.store.contact(jid, c.name ?? c.verifiedName, c.notify);
          }
          for (const c of h.chats) {
            const jid = canon(c.id, (c as { pnJid?: string }).pnJid, this.known);
            if (jid && !jid.endsWith("@broadcast") && !jid.endsWith("@newsletter"))
              this.store.chat(jid, { name: c.name ?? null, ts: Number(c.conversationTimestamp?.toString() ?? 0) * 1000, unread: c.unreadCount ?? 0 });
          }
          for (const m of h.messages) this.keep(m);
          this.store.db.exec("commit");
        } catch (error) {
          this.store.db.exec("rollback");
          log(this.id, "saving history failed", error);
        }
        log(this.id, `history: ${h.chats.length} chats, ${h.messages.length} messages`);
      });
      sock.ev.on("messages.upsert", ({ messages, type }) => {
        for (const m of messages) {
          const kept = this.keep(m);
          if (!kept || !kept.fresh) continue;
          if (type === "notify" && !kept.m.from_me) this.store.bumpUnread(kept.m.chat);
          // new while connected, or missed while away and arriving now: both are news to an automation
          if (type === "notify" || Date.now() - this.openedAt < 60_000) void this.deliver(kept.m);
          if (kept.m.chat.endsWith("@g.us") && !this.store.nameOf(kept.m.chat))
            void sock.groupMetadata(kept.m.chat).then((g) => this.store.chat(kept.m.chat, { name: g.subject }), () => {});
        }
      });
      sock.ev.on("chats.upsert", (cs) => cs.forEach((c) => this.chatSeen(c)));
      sock.ev.on("chats.update", (cs) => cs.forEach((c) => this.chatSeen(c)));
      sock.ev.on("contacts.upsert", (cs) => cs.forEach((c) => this.contactSeen(c)));
      sock.ev.on("contacts.update", (cs) => cs.forEach((c) => this.contactSeen(c)));
      sock.ev.on("groups.upsert", (gs) => gs.forEach((g) => g.id && this.store.chat(g.id, { name: g.subject })));
      sock.ev.on("groups.update", (gs) => gs.forEach((g) => g.id && g.subject && this.store.chat(g.id, { name: g.subject })));
      sock.ev.on("lid-mapping.update", (m) => this.noteLid(m.lid, m.pn));
    });
  }

  chatSeen(c: { id?: string | null; name?: string | null; unreadCount?: number | null; conversationTimestamp?: unknown }) {
    const jid = canon(c.id, null, this.known);
    if (!jid || jid.endsWith("@broadcast") || jid.endsWith("@newsletter")) return;
    this.store.chat(jid, { name: c.name ?? null, ...(typeof c.unreadCount === "number" && { unread: Math.max(0, c.unreadCount) }) });
  }
  contactSeen(c: { id?: string | null; lid?: string | null; phoneNumber?: string | null; name?: string | null; notify?: string | null; verifiedName?: string | null }) {
    this.noteLid(c.lid, c.phoneNumber);
    const jid = canon(c.id, c.phoneNumber, this.known);
    if (jid) this.store.contact(jid, c.name ?? c.verifiedName ?? null, c.notify ?? null);
  }

  // A message from WhatsApp, saved. Null: not something anyone said (a reaction, a delete, a status).
  keep(w: WAMessage): { m: Message; fresh: boolean } | null {
    const key = w.key;
    if (!key?.remoteJid || !key.id || key.remoteJid.endsWith("@broadcast") || key.remoteJid.endsWith("@newsletter")) return null;
    const said = textOf(w.message);
    if (!said) return null;
    this.noteLid(key.remoteJid.endsWith("@lid") ? key.remoteJid : null, key.remoteJidAlt);
    this.noteLid(key.participant?.endsWith("@lid") ? key.participant : null, key.participantAlt);
    const chat = canon(key.remoteJid, key.remoteJidAlt, this.known)!;
    const group = chat.endsWith("@g.us");
    const fromMe = !!key.fromMe;
    const sender = fromMe ? (this.meta.me?.jid ?? null) : group ? canon(key.participant, key.participantAlt, this.known) : chat;
    if (!fromMe && sender && w.pushName) this.store.contact(sender, null, w.pushName);
    const m: Message = {
      chat,
      id: key.id,
      from_me: fromMe ? 1 : 0,
      sender,
      sender_name: fromMe ? "me" : (w.pushName ?? null),
      ts: tsOf(w),
      type: said.type,
      text: said.text,
      quoted: quotedOf(w.message),
      raw: JSON.stringify(w, BufferJSON.replacer),
    };
    return { m, fresh: this.store.message(m) };
  }

  async onConnection(sock: WASocket, u: Partial<{ connection: string; lastDisconnect: { error?: any }; qr: string }>) {
    if (u.qr) {
      this.status = "linking";
      this.qr = await QRCode.toString(u.qr, { type: "svg", margin: 1 });
      if (this.wantCode && !this.code)
        this.code = await sock.requestPairingCode(this.wantCode).catch((error) => (log(this.id, "pairing code failed", String(error)), null));
    }
    if (u.connection === "open") {
      this.status = "open";
      this.qr = this.code = this.wantCode = null;
      this.retries = 0;
      this.openedAt = Date.now();
      const user = sock.user;
      if (user) {
        const jid = user.id.replace(/:\d+@/, "@");
        this.meta.me = { jid, name: user.name ?? user.verifiedName ?? user.notify ?? null, phone: phoneOf(jid) };
        this.noteLid(user.lid, jid);
      }
      if (!this.meta.linked) log(this.id, "linked");
      this.meta.linked = true;
      this.meta.caughtUp = Date.now();
      this.saveMeta();
    }
    if (u.connection === "close") {
      if (this.sock === sock) this.sock = null;
      const code = u.lastDisconnect?.error?.output?.statusCode as number | undefined;
      if (code === DisconnectReason.loggedOut || code === DisconnectReason.forbidden) {
        // unlinked from the phone (or the number was blocked): the login is no good any more
        log(this.id, "logged out", code);
        this.status = "logged_out";
        this.qr = this.code = null;
        this.store.clear("auth:");
        this.meta.linked = false;
        this.meta.unlinked = true;
        delete this.meta.watch;
        this.saveMeta();
        return;
      }
      this.status = "closed";
      if (this.stopping || code === DisconnectReason.connectionReplaced) return;
      // 515: WhatsApp asks for a fresh connection, normal right after linking
      const wanted = code === DisconnectReason.restartRequired || !this.meta.linked || !!this.meta.watch || Date.now() - this.lastUse < IDLE_MS;
      if (!wanted) return;
      if (!this.meta.linked && Date.now() - this.meta.created > LINK_MS) return;
      const wait = code === DisconnectReason.restartRequired ? 0 : Math.min(60_000, 1000 * 2 ** this.retries++);
      setTimeout(() => this.start(), wait);
    }
  }

  // Connected and up to date, for a read or a send.
  async ready(fresh = true) {
    this.lastUse = Date.now();
    if (!this.meta.linked) throw new Refused(this.meta.unlinked ? "WhatsApp was unlinked from the phone; link it again" : "not linked yet", 409);
    if (this.status !== "open") {
      this.start();
      const until = Date.now() + 30_000;
      while ((this.status as Status) !== "open" && Date.now() < until) {
        await sleep(200);
        if (!this.meta.linked) throw new Refused("WhatsApp was unlinked from the phone; link it again", 409);
      }
      if ((this.status as Status) !== "open") throw new Refused("couldn't reach WhatsApp just now; try again in a minute", 503);
    }
    // just reconnected: give what it missed a moment to arrive
    const since = Date.now() - this.openedAt;
    if (fresh && since < 4000) await sleep(4000 - since);
  }

  stop() {
    this.stopping = true;
    this.sock?.end(undefined);
    this.sock = null;
    if (this.status === "open" || this.status === "linking") this.status = "closed";
  }

  // Unlinks it from the phone (when it can) and forgets everything.
  async destroy() {
    if (this.sock && this.status === "open") await this.sock.logout().catch(() => {});
    this.stop();
    this.store.close();
    rmSync(join(DATA_DIR, this.id), { recursive: true, force: true });
  }

  chatName(jid: string) {
    return this.store.nameOf(jid) ?? phoneOf(jid) ?? jid;
  }

  present(m: Message) {
    return {
      id: m.id,
      chat: m.chat,
      chat_name: this.chatName(m.chat),
      is_group: m.chat.endsWith("@g.us"),
      from_me: !!m.from_me,
      from: m.from_me ? "me" : (phoneOf(m.sender) ?? m.sender),
      from_name: m.from_me ? "me" : (m.sender ? (this.store.nameOf(m.sender) ?? m.sender_name) : m.sender_name),
      time: new Date(m.ts).toISOString(),
      type: m.type,
      text: m.text,
      ...(m.quoted && { replying_to: m.quoted }),
      has_media: MEDIA.has(`${m.type}Message`),
    };
  }

  // An automation's webhook hears of a new message. Retries a few times; Emplio drops repeats.
  async deliver(m: Message) {
    const w = this.meta.watch;
    if (!w) return;
    const body = JSON.stringify({ id: `${m.chat}:${m.id}`, message: this.present(m) });
    const signature = createHmac("sha256", w.secret).update(body).digest("hex");
    for (let i = 0; i < 4; i++) {
      try {
        const res = await fetch(w.url, { method: "POST", headers: { "content-type": "application/json", "x-emplio-signature": signature }, body, signal: AbortSignal.timeout(15_000) });
        if (res.ok || res.status === 401 || res.status === 404) return;
      } catch {}
      await sleep(2000 * 4 ** i);
    }
    log(this.id, "a webhook delivery failed");
  }

  // A chat to send to or read, from what the agent wrote: an id, a phone number, or a chat's name.
  chatFor(to: string) {
    const t = targetOf(to);
    if ("jid" in t) return canon(t.jid, null, this.known)!;
    const found = this.store.chats({ query: t.name, limit: 10 });
    const exact = found.filter((c) => c.name?.toLowerCase() === t.name.toLowerCase());
    const pick = exact.length === 1 ? exact : found;
    if (pick.length === 1) return pick[0]!.jid;
    if (!pick.length) throw new Refused(`no chat called "${t.name}"; list_chats shows them`);
    throw new Refused(`several chats match "${t.name}": ${pick.map((c) => `${c.name} (${c.jid})`).join(", ")}; use the chat id`);
  }

  // Sends go only to people and groups this account already chats with, and not too many: cold messages and bulk
  // sending get numbers banned.
  checkSend(jid: string) {
    if (!this.store.hasChat(jid) && !this.store.nameOf(jid))
      throw new Refused("WhatsApp messages only go to people and groups this WhatsApp already chats with. For new numbers or bulk messages, use the WhatsApp Business API instead");
    if (this.store.sent(3600_000) >= LIMITS.hour) throw new Refused(`already sent ${LIMITS.hour} messages from this WhatsApp in the last hour; wait before sending more, so the number isn't flagged`, 429);
    if (this.store.sent(86_400_000) >= LIMITS.day) throw new Refused(`already sent ${LIMITS.day} messages from this WhatsApp today; wait until tomorrow, so the number isn't flagged`, 429);
  }

  async send(jid: string, content: AnyMessageContent, quote?: string) {
    this.checkSend(jid);
    await this.ready(false);
    const q = quote ? this.store.getMessage(jid, quote) : undefined;
    if (quote && !q?.raw) throw new Refused(`no message ${quote} in that chat`);
    const sent = await this.sock!.sendMessage(jid, content, q?.raw ? { quoted: JSON.parse(q.raw, BufferJSON.reviver) } : {});
    this.store.noteSend();
    const kept = sent ? this.keep(sent) : null;
    return kept ? this.present(kept.m) : { sent: true };
  }

  rawOf(chat: string, id: string): WAMessage {
    const m = this.store.getMessage(chat, id);
    if (!m?.raw) throw new Refused(`no message ${id} in that chat`, 404);
    return JSON.parse(m.raw, BufferJSON.reviver);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// --- the accounts this server holds ---

const accounts = new Map<string, Account>();
const accountOf = (id: string) => {
  const a = ID.test(id) ? accounts.get(id) : undefined;
  if (!a) throw new Refused("no such account", 404);
  return a;
};

// every minute: let idle ones go, catch quiet ones up, give up on links never finished
function tick() {
  for (const a of accounts.values()) {
    if (!a.meta.linked) {
      // never linked in time, or unlinked from the phone a while ago: forgotten (Emplio then shows it needs linking again)
      if (Date.now() - a.meta.created > LINK_MS && (!a.meta.unlinked || Date.now() - a.lastUse > 7 * 86_400_000)) {
        accounts.delete(a.id);
        void a.destroy();
      }
      continue;
    }
    if (a.meta.watch) {
      if (!a.sock) a.start();
      continue;
    }
    if (a.status === "open" && Date.now() - a.lastUse > IDLE_MS) a.stop();
    else if (a.status !== "open" && !a.sock && Date.now() - (a.meta.caughtUp ?? 0) > CATCH_UP_MS) {
      // a short visit: connected long enough to take in what it missed, then idle again
      a.lastUse = Date.now() - IDLE_MS + 90_000;
      a.start();
    }
  }
}

// --- HTTP ---

async function body(req: IncomingMessage): Promise<Record<string, any>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > 100 * 1024 * 1024) throw new Refused("too big", 413);
    chunks.push(c);
  }
  if (!size) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString());
  } catch {
    throw new Refused("not JSON");
  }
}

const str = (v: unknown, name: string, max = 4096) => {
  if (typeof v !== "string" || !v.trim() || v.length > max) throw new Refused(`${name} is needed`);
  return v.trim();
};
const num = (v: string | null, def: number, max: number) => Math.min(max, Math.max(1, Number(v) || def));

type Route = [string, RegExp, (a: { params: string[]; q: URLSearchParams; req: IncomingMessage }) => Promise<unknown>];
const routes: Route[] = [
  ["GET", /^\/health$/, async () => ({ ok: true, accounts: accounts.size, connected: [...accounts.values()].filter((a) => a.status === "open").length })],

  // a new account, linking: its QR code (and a pairing code once asked) come from GET
  ["POST", /^\/accounts$/, async ({ req }) => {
    const b = await body(req);
    const a = new Account(randomUUID());
    accounts.set(a.id, a);
    if (b.phone) a.wantCode = String(b.phone).replace(/\D/g, "");
    a.start();
    log(a.id, "linking");
    return a.state();
  }],
  // link with a code typed on the phone instead of the QR code (when the phone is the screen showing it)
  ["POST", /^\/accounts\/([^/]+)\/code$/, async ({ params, req }) => {
    const a = accountOf(params[0]!);
    const phone = str((await body(req)).phone, "phone", 30).replace(/\D/g, "");
    if (a.meta.linked) throw new Refused("already linked");
    if (phone.length < 8) throw new Refused("the phone number, with its country code");
    a.wantCode = phone;
    a.code = null;
    // a code needs a fresh connection that hasn't shown a QR code yet
    a.stop();
    a.start();
    const until = Date.now() + 20_000;
    while (!a.code && Date.now() < until) await sleep(250);
    if (!a.code) throw new Refused("couldn't get a code from WhatsApp; try the QR code, or again in a minute", 503);
    return a.state();
  }],
  ["GET", /^\/accounts\/([^/]+)$/, async ({ params }) => accountOf(params[0]!).state()],
  ["DELETE", /^\/accounts\/([^/]+)$/, async ({ params }) => {
    const a = accountOf(params[0]!);
    accounts.delete(a.id);
    await a.destroy();
    log(a.id, "removed");
    return { ok: true };
  }],

  ["GET", /^\/accounts\/([^/]+)\/chats$/, async ({ params, q }) => {
    const a = accountOf(params[0]!);
    const note = await a.ready().then(() => undefined, (e: Error) => `showing what was saved: ${e.message}`);
    const kind = (["people", "groups"] as const).find((k) => k === q.get("kind")) ?? "all";
    const chats = a.store.chats({ query: q.get("query") ?? undefined, kind, unread: q.get("unread") === "true", limit: num(q.get("limit"), 30, 200) });
    return { chats: chats.map((c) => ({ chat: c.jid, name: c.name ?? phoneOf(c.jid) ?? c.jid, phone: phoneOf(c.jid), is_group: !!c.is_group, unread: c.unread, last_message: c.last_ts ? new Date(c.last_ts).toISOString() : null })), ...(note && { note }) };
  }],
  ["GET", /^\/accounts\/([^/]+)\/messages$/, async ({ params, q }) => {
    const a = accountOf(params[0]!);
    const note = await a.ready().then(() => undefined, (e: Error) => `showing what was saved: ${e.message}`);
    const chat = a.chatFor(str(q.get("chat"), "chat"));
    const time = (v: string | null) => (v ? Date.parse(v) || undefined : undefined);
    const messages = a.store.messages(chat, { limit: num(q.get("limit"), 50, 500), before: time(q.get("before")), after: time(q.get("after")) });
    return { chat, chat_name: a.chatName(chat), messages: messages.map((m) => a.present(m)), ...(note && { note }) };
  }],
  ["GET", /^\/accounts\/([^/]+)\/search$/, async ({ params, q }) => {
    const a = accountOf(params[0]!);
    const note = await a.ready().then(() => undefined, (e: Error) => `showing what was saved: ${e.message}`);
    const chat = q.get("chat") ? a.chatFor(q.get("chat")!) : undefined;
    return { messages: a.store.search(str(q.get("query"), "query", 500), { chat, limit: num(q.get("limit"), 30, 200) }).map((m) => a.present(m)), ...(note && { note }) };
  }],
  ["GET", /^\/accounts\/([^/]+)\/contacts$/, async ({ params, q }) => {
    const a = accountOf(params[0]!);
    return { contacts: a.store.contacts(q.get("query") ?? undefined, num(q.get("limit"), 50, 500)).map((c) => ({ chat: c.jid, name: c.name ?? c.notify, phone: phoneOf(c.jid) })) };
  }],
  ["GET", /^\/accounts\/([^/]+)\/group$/, async ({ params, q }) => {
    const a = accountOf(params[0]!);
    const chat = a.chatFor(str(q.get("chat"), "chat"));
    if (!chat.endsWith("@g.us")) throw new Refused("that chat isn't a group");
    await a.ready(false);
    const g = await a.sock!.groupMetadata(chat);
    a.store.chat(chat, { name: g.subject });
    return {
      chat,
      name: g.subject,
      description: g.desc ?? null,
      created: g.creation ? new Date(g.creation * 1000).toISOString() : null,
      participants: g.participants.map((p) => {
        const jid = canon(p.id, p.phoneNumber, a.known);
        return { phone: phoneOf(jid), name: jid ? a.store.nameOf(jid) : null, admin: p.admin ?? null };
      }),
    };
  }],
  ["GET", /^\/accounts\/([^/]+)\/media$/, async ({ params, q }) => {
    const a = accountOf(params[0]!);
    const chat = a.chatFor(str(q.get("chat"), "chat"));
    const raw = a.rawOf(chat, str(q.get("message"), "message"));
    await a.ready(false);
    const bytes = await downloadMediaMessage(raw, "buffer", {}, { logger, reuploadRequest: a.sock!.updateMediaMessage }).catch(() => {
      throw new Refused("couldn't download it; WhatsApp may no longer have it", 404);
    });
    const m = raw.message ?? {};
    const inner = (m.documentWithCaptionMessage?.message ?? m.viewOnceMessage?.message ?? m.ephemeralMessage?.message ?? m) as Record<string, any>;
    const media = inner.imageMessage ?? inner.videoMessage ?? inner.audioMessage ?? inner.documentMessage ?? inner.stickerMessage ?? inner.ptvMessage ?? {};
    const type: string = media.mimetype ?? "application/octet-stream";
    const ext = type.split("/")[1]?.split(";")[0] ?? "bin";
    return { file: true, bytes, type: type.split(";")[0], name: media.fileName ?? `whatsapp-${raw.key.id}.${ext === "ogg" ? "ogg" : ext}` };
  }],

  ["POST", /^\/accounts\/([^/]+)\/send$/, async ({ params, req }) => {
    const a = accountOf(params[0]!);
    const b = await body(req);
    return a.send(a.chatFor(str(b.to, "to", 200)), { text: str(b.text, "text", 65_000) }, b.reply_to ? String(b.reply_to) : undefined);
  }],
  ["POST", /^\/accounts\/([^/]+)\/send-file$/, async ({ params, req }) => {
    const a = accountOf(params[0]!);
    const b = await body(req);
    const data = Buffer.from(str(b.data, "data", 90 * 1024 * 1024), "base64");
    const type = typeof b.type === "string" && b.type ? b.type : "application/octet-stream";
    const name = typeof b.name === "string" && b.name ? b.name : "file";
    const caption = typeof b.caption === "string" && b.caption ? b.caption : undefined;
    const content: AnyMessageContent = type.startsWith("image/") && !type.includes("svg")
      ? { image: data, mimetype: type, caption }
      : type.startsWith("video/")
        ? { video: data, mimetype: type, caption }
        : type.startsWith("audio/")
          ? { audio: data, mimetype: type, ptt: type.includes("ogg") }
          : { document: data, mimetype: type, fileName: name, caption };
    return a.send(a.chatFor(str(b.to, "to", 200)), content);
  }],
  ["POST", /^\/accounts\/([^/]+)\/react$/, async ({ params, req }) => {
    const a = accountOf(params[0]!);
    const b = await body(req);
    const chat = a.chatFor(str(b.chat, "chat", 200));
    const raw = a.rawOf(chat, str(b.message, "message"));
    return a.send(chat, { react: { text: typeof b.emoji === "string" ? b.emoji : "", key: raw.key } });
  }],
  // blue ticks for what they've had: only when asked, never by reading
  ["POST", /^\/accounts\/([^/]+)\/read$/, async ({ params, req }) => {
    const a = accountOf(params[0]!);
    const chat = a.chatFor(str((await body(req)).chat, "chat", 200));
    await a.ready(false);
    const keys = a.store
      .messages(chat, { limit: 50 })
      .filter((m) => !m.from_me && m.raw)
      .map((m) => (JSON.parse(m.raw!, BufferJSON.reviver) as WAMessage).key);
    if (keys.length) await a.sock!.readMessages(keys);
    a.store.chat(chat, { unread: 0 });
    return { ok: true, marked: keys.length };
  }],

  // an automation waits for new messages: stay connected and tell this address, signed with this secret
  ["PUT", /^\/accounts\/([^/]+)\/watch$/, async ({ params, req }) => {
    const a = accountOf(params[0]!);
    const b = await body(req);
    const url = str(b.url, "url", 2000);
    if (!/^https?:\/\//.test(url)) throw new Refused("url must be http(s)");
    if (!a.meta.linked) throw new Refused("not linked", 409);
    a.meta.watch = { url, secret: str(b.secret, "secret", 200) };
    a.saveMeta();
    a.start();
    return a.state();
  }],
  ["DELETE", /^\/accounts\/([^/]+)\/watch$/, async ({ params }) => {
    const a = accountOf(params[0]!);
    delete a.meta.watch;
    a.saveMeta();
    return a.state();
  }],
];

function authorized(req: IncomingMessage, token: string) {
  const got = Buffer.from(String(req.headers.authorization ?? "").replace(/^Bearer /, ""));
  const want = Buffer.from(token);
  return got.length === want.length && timingSafeEqual(got, want);
}

export function serve(token: string) {
  return createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const send = (status: number, v: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(v));
    };
    try {
      const url = new URL(req.url ?? "/", "http://x");
      if (url.pathname !== "/health" && !authorized(req, token)) return send(401, { error: "unauthorized" });
      for (const [method, path, fn] of routes) {
        const m = path.exec(url.pathname);
        if (!m || method !== req.method) continue;
        const out = (await fn({ params: m.slice(1), q: url.searchParams, req })) as any;
        if (out?.file) {
          res.writeHead(200, { "content-type": out.type, "x-filename": encodeURIComponent(out.name) });
          return res.end(out.bytes);
        }
        return send(200, out);
      }
      send(404, { error: "not found" });
    } catch (error) {
      if (error instanceof Refused) return send(error.status, { error: error.message });
      console.error(error);
      send(500, { error: "something went wrong in the WhatsApp server" });
    }
  });
}

// --- start ---

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const token = process.env.WHATSAPP_TOKEN ?? "";
  if (token.length < 32) {
    // an install from before WhatsApp: stays off quietly instead of restarting over and over
    console.log("whatsapp: WHATSAPP_TOKEN isn't set (32+ characters), so WhatsApp stays off");
    setInterval(() => {}, 3600_000);
  } else start(token);
}

function start(token: string) {
  // one account's trouble (a WhatsApp hiccup mid-call) mustn't take the others down
  process.on("unhandledRejection", (error) => console.error("whatsapp: unhandled", error));
  if (existsSync(DATA_DIR))
    for (const id of readdirSync(DATA_DIR)) {
      if (!ID.test(id)) continue;
      const a = new Account(id);
      accounts.set(id, a);
      if (a.meta.linked && a.meta.watch) a.start();
    }
  setInterval(tick, 60_000);
  const port = Number(process.env.PORT ?? 4200);
  serve(token).listen(port, process.env.HOST ?? "0.0.0.0", () => console.log(`whatsapp: ${accounts.size} accounts, listening on ${port}`));
  const shutdown = () => {
    for (const a of accounts.values()) {
      a.stop();
      a.store.close();
    }
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}
