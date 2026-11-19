// One linked account's folder on disk: a SQLite file holding its WhatsApp login (the keys WhatsApp's encryption needs)
// and the chats, contacts and messages it has seen, with a full-text index for search. Deleting the folder forgets
// the account entirely.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

export type Chat = { jid: string; name: string | null; is_group: number; last_ts: number; unread: number };
export type Message = {
  chat: string;
  id: string;
  from_me: number;
  sender: string | null;
  sender_name: string | null;
  ts: number;
  type: string;
  text: string;
  quoted: string | null;
  // the whole message as WhatsApp sent it (JSON), kept for media (to download it later) and for our own sends
  raw: string | null;
};

export class Store {
  db: DatabaseSync;
  constructor(dir: string) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(join(dir, "data.db"));
    this.db.exec(`
      pragma journal_mode = wal;
      pragma synchronous = normal;
      create table if not exists kv (k text primary key, v text not null);
      create table if not exists chats (jid text primary key, name text, is_group integer not null default 0, last_ts integer not null default 0, unread integer not null default 0);
      create table if not exists contacts (jid text primary key, name text, notify text);
      create table if not exists messages (
        chat text not null, id text not null, from_me integer not null, sender text, sender_name text, ts integer not null,
        type text not null, text text not null, quoted text, raw text, primary key (chat, id));
      create index if not exists messages_ts on messages (chat, ts);
      create virtual table if not exists messages_fts using fts5 (text, content = 'messages', content_rowid = 'rowid');
      create trigger if not exists messages_ai after insert on messages begin insert into messages_fts (rowid, text) values (new.rowid, new.text); end;
      create trigger if not exists messages_ad after delete on messages begin insert into messages_fts (messages_fts, rowid, text) values ('delete', old.rowid, old.text); end;
      create trigger if not exists messages_au after update of text on messages begin
        insert into messages_fts (messages_fts, rowid, text) values ('delete', old.rowid, old.text);
        insert into messages_fts (rowid, text) values (new.rowid, new.text);
      end;
      create table if not exists sends (ts integer not null);
    `);
  }

  get(k: string): string | null {
    return (this.db.prepare("select v from kv where k = ?").get(k) as { v: string } | undefined)?.v ?? null;
  }
  set(k: string, v: string | null) {
    if (v === null) this.db.prepare("delete from kv where k = ?").run(k);
    else this.db.prepare("insert into kv (k, v) values (?, ?) on conflict (k) do update set v = excluded.v").run(k, v);
  }
  // removes every key starting with prefix (the login, on unlinking)
  clear(prefix: string) {
    this.db.prepare("delete from kv where k >= ? and k < ?").run(prefix, prefix + "\uffff");
  }

  // a chat seen: its name only replaces a known one when given, its time only moves forward
  chat(jid: string, o: { name?: string | null; ts?: number; unread?: number } = {}) {
    this.db
      .prepare(
        `insert into chats (jid, name, is_group, last_ts, unread) values (?, ?, ?, ?, ?)
         on conflict (jid) do update set name = coalesce(excluded.name, chats.name), last_ts = max(chats.last_ts, excluded.last_ts),
         unread = case when ? then excluded.unread else chats.unread end`,
      )
      .run(jid, o.name ?? null, jid.endsWith("@g.us") ? 1 : 0, o.ts ?? 0, o.unread ?? 0, o.unread === undefined ? 0 : 1);
  }
  contact(jid: string, name?: string | null, notify?: string | null) {
    this.db
      .prepare("insert into contacts (jid, name, notify) values (?, ?, ?) on conflict (jid) do update set name = coalesce(excluded.name, contacts.name), notify = coalesce(excluded.notify, contacts.notify)")
      .run(jid, name ?? null, notify ?? null);
  }
  // true when it's new
  message(m: Message) {
    const fresh = !this.hasMessage(m.chat, m.id);
    this.db
      .prepare(
        `insert into messages (chat, id, from_me, sender, sender_name, ts, type, text, quoted, raw) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         on conflict (chat, id) do update set text = case when excluded.text != '' then excluded.text else messages.text end, raw = coalesce(excluded.raw, messages.raw)`,
      )
      .run(m.chat, m.id, m.from_me, m.sender, m.sender_name, m.ts, m.type, m.text, m.quoted, m.raw);
    this.chat(m.chat, { ts: m.ts });
    return fresh;
  }
  hasMessage(chat: string, id: string) {
    return !!this.db.prepare("select 1 from messages where chat = ? and id = ?").get(chat, id);
  }
  getMessage(chat: string, id: string) {
    return this.db.prepare("select * from messages where chat = ? and id = ?").get(chat, id) as Message | undefined;
  }
  findMessage(id: string) {
    return this.db.prepare("select * from messages where id = ? limit 1").get(id) as Message | undefined;
  }

  nameOf(jid: string): string | null {
    const c = this.db.prepare("select name, notify from contacts where jid = ?").get(jid) as { name: string | null; notify: string | null } | undefined;
    if (c?.name || c?.notify) return c.name || c.notify;
    return (this.db.prepare("select name from chats where jid = ?").get(jid) as { name: string | null } | undefined)?.name ?? null;
  }

  chats(o: { query?: string; kind?: "all" | "people" | "groups"; unread?: boolean; limit: number }) {
    const where: string[] = [];
    const args: (string | number)[] = [];
    if (o.kind === "people") where.push("c.is_group = 0");
    if (o.kind === "groups") where.push("c.is_group = 1");
    if (o.unread) where.push("c.unread > 0");
    if (o.query) {
      where.push("(lower(coalesce(c.name, '') || ' ' || coalesce(k.name, '') || ' ' || coalesce(k.notify, '') || ' ' || c.jid) like ?)");
      args.push(`%${o.query.toLowerCase().replace(/^\+/, "")}%`);
    }
    return this.db
      .prepare(
        `select c.jid, coalesce(c.name, k.name, k.notify) as name, c.is_group, c.last_ts, c.unread from chats c left join contacts k on k.jid = c.jid
         ${where.length ? "where " + where.join(" and ") : ""} order by c.last_ts desc limit ?`,
      )
      .all(...args, o.limit) as Chat[];
  }
  bumpUnread(jid: string) {
    this.db.prepare("update chats set unread = unread + 1 where jid = ?").run(jid);
  }
  hasChat(jid: string) {
    return !!this.db.prepare("select 1 from chats where jid = ?").get(jid);
  }

  messages(chat: string, o: { limit: number; before?: number; after?: number }) {
    const rows = this.db
      .prepare("select * from messages where chat = ? and ts < ? and ts > ? order by ts desc limit ?")
      .all(chat, o.before ?? 9e12, o.after ?? 0, o.limit) as Message[];
    return rows.reverse();
  }

  search(q: string, o: { chat?: string; limit: number }) {
    // each word as a phrase, so punctuation in what was typed can't break the query
    const match = q
      .split(/\s+/)
      .filter(Boolean)
      .map((w) => `"${w.replaceAll('"', '""')}"`)
      .join(" ");
    if (!match) return [];
    return this.db
      .prepare(
        `select m.* from messages_fts f join messages m on m.rowid = f.rowid where messages_fts match ? ${o.chat ? "and m.chat = ?" : ""} order by m.ts desc limit ?`,
      )
      .all(...(o.chat ? [match, o.chat, o.limit] : [match, o.limit])) as Message[];
  }

  contacts(query: string | undefined, limit: number) {
    const q = `%${(query ?? "").toLowerCase().replace(/^\+/, "")}%`;
    return this.db
      .prepare("select jid, name, notify from contacts where jid like '%@s.whatsapp.net' and lower(coalesce(name, '') || ' ' || coalesce(notify, '') || ' ' || jid) like ? order by coalesce(name, notify, jid) limit ?")
      .all(q, limit) as { jid: string; name: string | null; notify: string | null }[];
  }

  // sends in the last `ms`, and one more noted
  sent(ms: number) {
    return (this.db.prepare("select count(*) as n from sends where ts > ?").get(Date.now() - ms) as { n: number }).n;
  }
  noteSend() {
    this.db.prepare("insert into sends (ts) values (?)").run(Date.now());
    this.db.prepare("delete from sends where ts < ?").run(Date.now() - 86_400_000);
  }

  close() {
    this.db.close();
  }
}
