// One linked account's saved chats, contacts and messages (data.db in its folder), with a full-text index for search.
// The WhatsApp login itself sits next to it in whatsmeow.db. Deleting the folder forgets the account entirely.
package main

import (
	"context"
	"database/sql"
	"fmt"
	"path/filepath"
	"strings"
	"time"

	_ "modernc.org/sqlite"
)

type Chat struct {
	JID     string
	Name    *string
	IsGroup bool
	LastTS  int64
	Unread  int
}

type Message struct {
	Chat       string
	ID         string
	FromMe     bool
	Sender     *string // by phone number where known
	SenderName *string
	TS         int64 // milliseconds
	Type       string
	Text       string
	Quoted     *string
	// who sent it as WhatsApp addressed them (maybe a hidden @lid id), for reactions, replies and read receipts
	SenderJID *string
	// the message as WhatsApp sent it (protobuf), for media downloads, replies and reactions
	Raw []byte
}

// what Store's queries run on: the database, or a transaction
type querier interface {
	ExecContext(ctx context.Context, query string, args ...any) (sql.Result, error)
	QueryContext(ctx context.Context, query string, args ...any) (*sql.Rows, error)
	QueryRowContext(ctx context.Context, query string, args ...any) *sql.Row
}

type Store struct {
	db *sql.DB
	q  querier
}

var bg = context.Background()

const schema = `
pragma journal_mode = wal;
pragma synchronous = normal;
create table if not exists kv (k text primary key, v text not null);
create table if not exists chats (jid text primary key, name text, is_group integer not null default 0, last_ts integer not null default 0, unread integer not null default 0);
create table if not exists contacts (jid text primary key, name text, notify text);
create table if not exists messages (
  chat text not null, id text not null, from_me integer not null, sender text, sender_name text, ts integer not null,
  type text not null, text text not null, quoted text, sender_jid text, raw blob, primary key (chat, id));
create index if not exists messages_ts on messages (chat, ts);
create index if not exists messages_all_ts on messages (ts);
create virtual table if not exists messages_fts using fts5 (text, content = 'messages', content_rowid = 'rowid');
create trigger if not exists messages_ai after insert on messages begin insert into messages_fts (rowid, text) values (new.rowid, new.text); end;
create trigger if not exists messages_ad after delete on messages begin insert into messages_fts (messages_fts, rowid, text) values ('delete', old.rowid, old.text); end;
create trigger if not exists messages_au after update of text on messages begin
  insert into messages_fts (messages_fts, rowid, text) values ('delete', old.rowid, old.text);
  insert into messages_fts (rowid, text) values (new.rowid, new.text);
end;
create table if not exists sends (ts integer not null);
`

func OpenStore(dir string) (*Store, error) {
	db, err := sql.Open("sqlite", "file:"+filepath.Join(dir, "data.db")+"?_pragma=busy_timeout(5000)")
	if err != nil {
		return nil, err
	}
	// ponytail: one connection, so writes never race; reads are small and fast
	db.SetMaxOpenConns(1)
	if _, err := db.Exec(schema); err != nil {
		db.Close()
		return nil, fmt.Errorf("data.db: %w", err)
	}
	return &Store{db: db, q: db}, nil
}

func (s *Store) Close() error { return s.db.Close() }

// Tx runs fn with every write in one transaction (a history copy is thousands of rows).
func (s *Store) Tx(fn func(t *Store) error) error {
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	if err := fn(&Store{db: s.db, q: tx}); err != nil {
		tx.Rollback()
		return err
	}
	return tx.Commit()
}

func (s *Store) Get(k string) string {
	var v string
	s.q.QueryRowContext(bg, "select v from kv where k = ?", k).Scan(&v)
	return v
}

func (s *Store) Set(k, v string) {
	s.q.ExecContext(bg, "insert into kv (k, v) values (?, ?) on conflict (k) do update set v = excluded.v", k, v)
}

// A chat seen: its name only replaces a known one when given, its time only moves forward, unread only when given.
func (s *Store) Chat(jid string, name string, ts int64, unread int) {
	setUnread := unread >= 0
	if unread < 0 {
		unread = 0
	}
	s.q.ExecContext(bg, `insert into chats (jid, name, is_group, last_ts, unread) values (?, ?, ?, ?, ?)
		on conflict (jid) do update set name = coalesce(excluded.name, chats.name), last_ts = max(chats.last_ts, excluded.last_ts),
		unread = case when ? then excluded.unread else chats.unread end`,
		jid, nullable(name), strings.HasSuffix(jid, "@g.us"), ts, unread, setUnread)
}

func (s *Store) Contact(jid, name, notify string) {
	s.q.ExecContext(bg, `insert into contacts (jid, name, notify) values (?, ?, ?)
		on conflict (jid) do update set name = coalesce(excluded.name, contacts.name), notify = coalesce(excluded.notify, contacts.notify)`,
		jid, nullable(name), nullable(notify))
}

// SaveMessage keeps a message; true when it's new.
func (s *Store) SaveMessage(m Message) bool {
	fresh := !s.HasMessage(m.Chat, m.ID)
	s.q.ExecContext(bg, `insert into messages (chat, id, from_me, sender, sender_name, ts, type, text, quoted, sender_jid, raw) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		on conflict (chat, id) do update set text = case when excluded.text != '' then excluded.text else messages.text end, raw = coalesce(excluded.raw, messages.raw)`,
		m.Chat, m.ID, m.FromMe, m.Sender, m.SenderName, m.TS, m.Type, m.Text, m.Quoted, m.SenderJID, m.Raw)
	s.Chat(m.Chat, "", m.TS, -1)
	return fresh
}

func (s *Store) HasMessage(chat, id string) bool {
	var one int
	return s.q.QueryRowContext(bg, "select 1 from messages where chat = ? and id = ?", chat, id).Scan(&one) == nil
}

const msgCols = "chat, id, from_me, sender, sender_name, ts, type, text, quoted, sender_jid, raw"

func scanMessages(rows *sql.Rows, err error) []Message {
	out := []Message{}
	if err != nil {
		return out
	}
	defer rows.Close()
	for rows.Next() {
		var m Message
		if rows.Scan(&m.Chat, &m.ID, &m.FromMe, &m.Sender, &m.SenderName, &m.TS, &m.Type, &m.Text, &m.Quoted, &m.SenderJID, &m.Raw) == nil {
			out = append(out, m)
		}
	}
	return out
}

func (s *Store) GetMessage(chat, id string) *Message {
	ms := scanMessages(s.q.QueryContext(bg, "select "+msgCols+" from messages where chat = ? and id = ?", chat, id))
	if len(ms) == 0 {
		return nil
	}
	return &ms[0]
}

func (s *Store) FindMessage(id string) *Message {
	ms := scanMessages(s.q.QueryContext(bg, "select "+msgCols+" from messages where id = ? limit 1", id))
	if len(ms) == 0 {
		return nil
	}
	return &ms[0]
}

func (s *Store) NameOf(jid string) string {
	var name, notify sql.NullString
	if s.q.QueryRowContext(bg, "select name, notify from contacts where jid = ?", jid).Scan(&name, &notify) == nil {
		if name.String != "" {
			return name.String
		}
		if notify.String != "" {
			return notify.String
		}
	}
	var chat sql.NullString
	s.q.QueryRowContext(bg, "select name from chats where jid = ?", jid).Scan(&chat)
	return chat.String
}

func (s *Store) Chats(query, kind string, unread bool, limit int) []Chat {
	where := []string{}
	args := []any{}
	switch kind {
	case "people":
		where = append(where, "c.is_group = 0")
	case "groups":
		where = append(where, "c.is_group = 1")
	}
	if unread {
		where = append(where, "c.unread > 0")
	}
	if query != "" {
		where = append(where, "(lower(coalesce(c.name, '') || ' ' || coalesce(k.name, '') || ' ' || coalesce(k.notify, '') || ' ' || c.jid) like ?)")
		args = append(args, "%"+strings.TrimPrefix(strings.ToLower(query), "+")+"%")
	}
	w := ""
	if len(where) > 0 {
		w = "where " + strings.Join(where, " and ")
	}
	rows, err := s.q.QueryContext(bg, `select c.jid, coalesce(c.name, k.name, k.notify), c.is_group, c.last_ts, c.unread
		from chats c left join contacts k on k.jid = c.jid `+w+` order by c.last_ts desc limit ?`, append(args, limit)...)
	out := []Chat{}
	if err != nil {
		return out
	}
	defer rows.Close()
	for rows.Next() {
		var c Chat
		if rows.Scan(&c.JID, &c.Name, &c.IsGroup, &c.LastTS, &c.Unread) == nil {
			out = append(out, c)
		}
	}
	return out
}

func (s *Store) BumpUnread(jid string) {
	s.q.ExecContext(bg, "update chats set unread = unread + 1 where jid = ?", jid)
}

func (s *Store) HasChat(jid string) bool {
	var one int
	return s.q.QueryRowContext(bg, "select 1 from chats where jid = ?", jid).Scan(&one) == nil
}

// Messages in one chat, oldest first: the latest `limit` of them between after and before (milliseconds, 0 for none).
func (s *Store) Messages(chat string, limit int, before, after int64) []Message {
	if before == 0 {
		before = 9e12
	}
	ms := scanMessages(s.q.QueryContext(bg, "select "+msgCols+" from messages where chat = ? and ts < ? and ts > ? order by ts desc limit ?", chat, before, after, limit))
	for i, j := 0, len(ms)-1; i < j; i, j = i+1, j-1 {
		ms[i], ms[j] = ms[j], ms[i]
	}
	return ms
}

// Recent messages across every chat, newest first: what a new-message check looks through.
func (s *Store) Recent(after int64, limit int) []Message {
	return scanMessages(s.q.QueryContext(bg, "select "+msgCols+" from messages where ts > ? order by ts desc limit ?", after, limit))
}

func (s *Store) Search(q, chat string, limit int) []Message {
	// each word as a phrase, so punctuation in what was typed can't break the query
	words := []string{}
	for _, w := range strings.Fields(q) {
		words = append(words, `"`+strings.ReplaceAll(w, `"`, `""`)+`"`)
	}
	if len(words) == 0 {
		return []Message{}
	}
	cols := "m." + strings.ReplaceAll(msgCols, ", ", ", m.")
	if chat != "" {
		return scanMessages(s.q.QueryContext(bg, "select "+cols+" from messages_fts f join messages m on m.rowid = f.rowid where messages_fts match ? and m.chat = ? order by m.ts desc limit ?", strings.Join(words, " "), chat, limit))
	}
	return scanMessages(s.q.QueryContext(bg, "select "+cols+" from messages_fts f join messages m on m.rowid = f.rowid where messages_fts match ? order by m.ts desc limit ?", strings.Join(words, " "), limit))
}

type Contact struct {
	JID          string
	Name, Notify *string
}

func (s *Store) Contacts(query string, limit int) []Contact {
	rows, err := s.q.QueryContext(bg, `select jid, name, notify from contacts where jid like '%@s.whatsapp.net'
		and lower(coalesce(name, '') || ' ' || coalesce(notify, '') || ' ' || jid) like ? order by coalesce(name, notify, jid) limit ?`,
		"%"+strings.TrimPrefix(strings.ToLower(query), "+")+"%", limit)
	out := []Contact{}
	if err != nil {
		return out
	}
	defer rows.Close()
	for rows.Next() {
		var c Contact
		if rows.Scan(&c.JID, &c.Name, &c.Notify) == nil {
			out = append(out, c)
		}
	}
	return out
}

// Sent counts the sends in the last d.
func (s *Store) Sent(d time.Duration) int {
	var n int
	s.q.QueryRowContext(bg, "select count(*) from sends where ts > ?", time.Now().Add(-d).UnixMilli()).Scan(&n)
	return n
}

func (s *Store) NoteSend() {
	now := time.Now()
	s.q.ExecContext(bg, "insert into sends (ts) values (?)", now.UnixMilli())
	s.q.ExecContext(bg, "delete from sends where ts < ?", now.Add(-24*time.Hour).UnixMilli())
}

func nullable(s string) any {
	if s == "" {
		return nil
	}
	return s
}
