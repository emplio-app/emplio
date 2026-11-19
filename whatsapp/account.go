// One linked WhatsApp: its whatsmeow session, connected only while something needs it, and what it has saved.
package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"go.mau.fi/whatsmeow"
	"go.mau.fi/whatsmeow/proto/waE2E"
	"go.mau.fi/whatsmeow/store/sqlstore"
	"go.mau.fi/whatsmeow/types"
	"go.mau.fi/whatsmeow/types/events"
	waLog "go.mau.fi/whatsmeow/util/log"
	"google.golang.org/protobuf/proto"
)

var (
	// connected this long after it was last used
	IdleFor = 10 * time.Minute
	// a quiet account connects this often to catch up (WhatsApp keeps a linked device's missed messages for it)
	CatchUpEvery = 4 * time.Hour
	// a link that isn't finished in this time is given up
	LinkFor = 15 * time.Minute
	// sends per account: WhatsApp flags numbers that send a lot, fast
	LimitHour, LimitDay = 20, 150
)

type Me struct {
	JID   string  `json:"jid"`
	Name  *string `json:"name"`
	Phone *string `json:"phone"`
}

type Meta struct {
	Created  int64 `json:"created"`
	Linked   bool  `json:"linked"`
	Unlinked bool  `json:"unlinked,omitempty"`
	Me       *Me   `json:"me,omitempty"`
	CaughtUp int64 `json:"caughtUp,omitempty"`
}

// Refused is an answer for Emplio (shown to the agent), with its HTTP status.
type Refused struct {
	Status int
	Msg    string
}

func (r *Refused) Error() string { return r.Msg }
func refuse(status int, format string, a ...any) error {
	return &Refused{status, fmt.Sprintf(format, a...)}
}

type Account struct {
	ID    string
	dir   string
	store *Store
	wadb  *sql.DB
	waLog waLog.Logger

	mu       sync.Mutex
	meta     Meta
	cli      *whatsmeow.Client
	status   string // linking, open, closed, logged_out
	qr, code string
	lastUse  time.Time
	openedAt time.Time
	// closed once WhatsApp has handed over what came in while it was away
	caughtUp chan struct{}
	stopLink context.CancelFunc
}

func OpenAccount(dataDir, id string) (*Account, error) {
	dir := filepath.Join(dataDir, id)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, err
	}
	s, err := OpenStore(dir)
	if err != nil {
		return nil, err
	}
	wadb, err := sql.Open("sqlite", "file:"+filepath.Join(dir, "whatsmeow.db")+"?_pragma=foreign_keys(1)&_pragma=busy_timeout(5000)&_pragma=journal_mode(wal)")
	if err != nil {
		s.Close()
		return nil, err
	}
	a := &Account{ID: id, dir: dir, store: s, wadb: wadb, status: "closed", lastUse: time.Now(), waLog: waLog.Stdout(id[:8], logLevel(), false)}
	if raw := s.Get("meta"); raw != "" {
		json.Unmarshal([]byte(raw), &a.meta)
	} else {
		a.meta.Created = time.Now().UnixMilli()
		a.saveMeta()
	}
	return a, nil
}

func logLevel() string {
	if l := os.Getenv("LOG_LEVEL"); l != "" {
		return strings.ToUpper(l)
	}
	return "WARN"
}

func (a *Account) logf(format string, v ...any) {
	log.Printf("%s "+format, append([]any{a.ID[:8]}, v...)...)
}

// saveMeta: call with mu held, or before anyone else can see the account.
func (a *Account) saveMeta() {
	b, _ := json.Marshal(a.meta)
	a.store.Set("meta", string(b))
}

func (a *Account) touch() {
	a.mu.Lock()
	a.lastUse = time.Now()
	a.mu.Unlock()
}

type State struct {
	ID     string  `json:"id"`
	Status string  `json:"status"`
	Linked bool    `json:"linked"`
	QR     *string `json:"qr"`
	Code   *string `json:"code"`
	Me     *Me     `json:"me"`
}

func (a *Account) State() State {
	a.mu.Lock()
	defer a.mu.Unlock()
	// connected / idle (linked, not connected right now) / linking / unlinked (from the phone: link again)
	status := "linking"
	if a.meta.Linked {
		status = "idle"
		if a.status == "open" {
			status = "connected"
		}
	} else if a.meta.Unlinked {
		status = "unlinked"
	}
	return State{ID: a.ID, Status: status, Linked: a.meta.Linked, QR: strPtr(a.qr), Code: strPtr(a.code), Me: a.meta.Me}
}

func strPtr(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}

// Start connects (a new account: starts linking). Safe to call again while it's on its way.
func (a *Account) Start() error {
	cli, err := a.prepare()
	if err != nil || cli == nil {
		return err
	}
	// outside the lock: whatsmeow's events (which take it) can start before Connect returns
	return cli.Connect()
}

// prepare makes the client and, for a new account, starts the QR codes. nil: already connected.
func (a *Account) prepare() (*whatsmeow.Client, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.cli != nil && a.cli.IsConnected() {
		return nil, nil
	}
	if a.meta.Unlinked {
		return nil, refuse(409, "WhatsApp was unlinked from the phone; link it again")
	}
	if a.cli == nil {
		container := sqlstore.NewWithDB(a.wadb, "sqlite", a.waLog.Sub("db"))
		if err := container.Upgrade(bg); err != nil {
			return nil, fmt.Errorf("whatsmeow.db: %w", err)
		}
		device, err := container.GetFirstDevice(bg)
		if err != nil {
			return nil, err
		}
		cli := whatsmeow.NewClient(device, a.waLog)
		cli.AddEventHandler(a.on)
		cli.GetMessageForRetry = func(_, _ types.JID, id types.MessageID) *waE2E.Message {
			if m := a.store.FindMessage(id); m != nil && m.Raw != nil {
				var w waE2E.Message
				if proto.Unmarshal(m.Raw, &w) == nil {
					return &w
				}
			}
			return nil
		}
		a.cli = cli
	}
	a.caughtUp = make(chan struct{})
	a.status = "connecting"
	if a.cli.Store.ID == nil {
		ctx, cancel := context.WithTimeout(bg, LinkFor)
		qrs, err := a.cli.GetQRChannel(ctx)
		if err != nil {
			cancel()
			return nil, err
		}
		a.stopLink = cancel
		a.status = "linking"
		go a.watchQR(qrs)
	}
	return a.cli, nil
}

// watchQR keeps the QR code shown on the link page fresh until the phone scans one.
func (a *Account) watchQR(qrs <-chan whatsmeow.QRChannelItem) {
	for item := range qrs {
		a.mu.Lock()
		switch item.Event {
		case "code":
			a.qr = qrSVG(item.Code)
		case "success":
			a.qr, a.code = "", ""
			a.logf("linked")
		default:
			// timed out, or the phone turned it down: the link page asks for a fresh one
			a.qr, a.code = "", ""
			a.logf("link ended: %s %v", item.Event, item.Error)
			if a.cli != nil && a.cli.Store.ID == nil {
				go a.cli.Disconnect()
			}
		}
		a.mu.Unlock()
	}
}

// Pair asks WhatsApp for a code to type on the phone instead of scanning the QR code (when the phone is the screen).
func (a *Account) Pair(phone string) (string, error) {
	a.mu.Lock()
	linked := a.meta.Linked
	a.mu.Unlock()
	if linked {
		return "", refuse(400, "already linked")
	}
	if err := a.Start(); err != nil {
		return "", err
	}
	// the code needs the connection that is showing QR codes
	for until := time.Now().Add(20 * time.Second); time.Now().Before(until); time.Sleep(250 * time.Millisecond) {
		a.mu.Lock()
		cli, ready := a.cli, a.qr != ""
		a.mu.Unlock()
		if ready {
			code, err := cli.PairPhone(bg, phone, true, whatsmeow.PairClientChrome, "Chrome (Linux)")
			if err != nil {
				a.logf("pairing code failed: %v", err)
				return "", refuse(503, "couldn't get a code from WhatsApp; try the QR code, or again in a minute")
			}
			a.mu.Lock()
			a.code = code
			a.mu.Unlock()
			return code, nil
		}
	}
	return "", refuse(503, "couldn't get a code from WhatsApp; try the QR code, or again in a minute")
}

// known looks up the phone number behind a hidden @lid id.
func (a *Account) known(lid types.JID) types.JID {
	a.mu.Lock()
	cli := a.cli
	a.mu.Unlock()
	if cli == nil {
		return types.EmptyJID
	}
	pn, _ := cli.Store.LIDs.GetPNForLID(bg, lid)
	return pn
}

func (a *Account) canon(jid, alt types.JID) types.JID { return Canon(jid, alt, a.known) }

func skipChat(j types.JID) bool {
	return j.IsEmpty() || j.Server == types.BroadcastServer || j.Server == types.NewsletterServer
}

// on handles what whatsmeow tells us. It runs on whatsmeow's own goroutine, one event at a time.
func (a *Account) on(evt any) {
	switch e := evt.(type) {
	case *events.Connected:
		a.mu.Lock()
		first := !a.meta.Linked
		a.status = "open"
		a.qr, a.code = "", ""
		a.openedAt = time.Now()
		if id := a.cli.Store.ID; id != nil {
			jid := id.ToNonAD().String()
			name := a.cli.Store.PushName
			if a.cli.Store.BusinessName != "" {
				name = a.cli.Store.BusinessName
			}
			a.meta.Me = &Me{JID: jid, Name: strPtr(name), Phone: PhoneOf(jid)}
		}
		a.meta.Linked = true
		a.meta.CaughtUp = time.Now().UnixMilli()
		a.saveMeta()
		cli := a.cli
		a.mu.Unlock()
		if first {
			// group names, once: messages only say a group's id
			go func() {
				groups, err := cli.GetJoinedGroups(bg)
				if err != nil {
					return
				}
				for _, g := range groups {
					a.store.Chat(g.JID.String(), g.Name, 0, -1)
				}
			}()
		}
	case *events.OfflineSyncCompleted:
		a.mu.Lock()
		select {
		case <-a.caughtUp:
		default:
			close(a.caughtUp)
		}
		a.mu.Unlock()
	case *events.Disconnected, *events.StreamReplaced, *events.KeepAliveTimeout:
		a.mu.Lock()
		if a.status == "open" || a.status == "connecting" {
			a.status = "closed"
		}
		a.mu.Unlock()
	case *events.LoggedOut:
		// unlinked from the phone (or the number was blocked): the login is no good any more
		a.logf("logged out (%d)", e.Reason)
		a.mu.Lock()
		a.status = "logged_out"
		a.qr, a.code = "", ""
		a.meta.Linked = false
		a.meta.Unlinked = true
		a.saveMeta()
		a.cli = nil
		a.mu.Unlock()
	case *events.TemporaryBan:
		a.logf("temporarily banned: %s", e.String())
	case *events.ConnectFailure:
		a.logf("connect failed: %d %s", e.Reason, e.Message)
	case *events.HistorySync:
		a.history(e)
	case *events.Message:
		m, fresh, ok := a.keep(e)
		if !ok || !fresh {
			return
		}
		if !m.FromMe {
			a.store.BumpUnread(m.Chat)
		}
		if strings.HasSuffix(m.Chat, "@g.us") && a.store.NameOf(m.Chat) == "" {
			go func() {
				cli := a.client()
				if cli == nil {
					return
				}
				if g, err := cli.GetGroupInfo(bg, e.Info.Chat); err == nil {
					a.store.Chat(m.Chat, g.Name, 0, -1)
				}
			}()
		}
	case *events.PushName:
		if j := a.canon(e.JID, e.JIDAlt); !j.IsEmpty() {
			a.store.Contact(j.String(), "", e.NewPushName)
		}
	case *events.Contact:
		if e.Action != nil {
			name := e.Action.GetFullName()
			if name == "" {
				name = e.Action.GetFirstName()
			}
			if j := a.canon(e.JID, types.EmptyJID); !j.IsEmpty() {
				a.store.Contact(j.String(), name, "")
			}
		}
	case *events.AppStateSyncComplete:
		// the phone's address book arrives as app state; copy the names over
		cli := a.client()
		if cli == nil {
			return
		}
		all, err := cli.Store.Contacts.GetAllContacts(bg)
		if err != nil {
			return
		}
		a.store.Tx(func(t *Store) error {
			for jid, c := range all {
				name := c.FullName
				if name == "" {
					name = c.FirstName
				}
				if name == "" {
					name = c.BusinessName
				}
				if j := a.canon(jid, types.EmptyJID); !j.IsEmpty() && (name != "" || c.PushName != "") {
					t.Contact(j.String(), name, c.PushName)
				}
			}
			return nil
		})
	case *events.GroupInfo:
		if e.Name != nil {
			a.store.Chat(e.JID.String(), e.Name.Name, 0, -1)
		}
	case *events.JoinedGroup:
		a.store.Chat(e.JID.String(), e.Name, 0, -1)
	}
}

func (a *Account) client() *whatsmeow.Client {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.cli
}

// history saves what the phone copies over when linking: recent months of chats and messages.
func (a *Account) history(e *events.HistorySync) {
	cli := a.client()
	if cli == nil {
		return
	}
	chats, msgs := 0, 0
	err := a.store.Tx(func(t *Store) error {
		for _, c := range e.Data.GetConversations() {
			raw, err := types.ParseJID(c.GetID())
			if err != nil || skipChat(raw) {
				continue
			}
			alt, _ := types.ParseJID(c.GetPnJID())
			jid := a.canon(raw, alt)
			name := c.GetName()
			if name == "" {
				name = c.GetDisplayName()
			}
			t.Chat(jid.String(), name, int64(c.GetConversationTimestamp())*1000, int(c.GetUnreadCount()))
			chats++
			for _, h := range c.GetMessages() {
				evt, err := cli.ParseWebMessage(raw, h.GetMessage())
				if err != nil {
					continue
				}
				if _, _, ok := a.keepIn(t, evt); ok {
					msgs++
				}
			}
		}
		return nil
	})
	if err != nil {
		a.logf("saving history failed: %v", err)
	}
	if chats > 0 || msgs > 0 {
		a.logf("history: %d chats, %d messages", chats, msgs)
	}
}

func (a *Account) keep(e *events.Message) (Message, bool, bool) { return a.keepIn(a.store, e) }

// keepIn saves a message from WhatsApp. ok is false for what isn't something anyone said (a reaction, a delete, a
// status update).
func (a *Account) keepIn(s *Store, e *events.Message) (m Message, fresh, ok bool) {
	info := e.Info
	if skipChat(info.Chat) {
		return m, false, false
	}
	typ, text, said := TextOf(e.Message)
	if !said {
		return m, false, false
	}
	// in a one-to-one chat, the other side's number comes alongside a hidden id as the sender's (theirs) or the
	// recipient's (ours)
	alt := info.SenderAlt
	if info.IsFromMe {
		alt = info.RecipientAlt
	}
	chat := info.Chat
	if !info.IsGroup {
		chat = a.canon(info.Chat, alt)
	}
	var sender, senderName *string
	if info.IsFromMe {
		a.mu.Lock()
		if a.meta.Me != nil {
			sender = &a.meta.Me.JID
		}
		a.mu.Unlock()
		me := "me"
		senderName = &me
	} else {
		j := chat
		if info.IsGroup {
			j = a.canon(info.Sender, info.SenderAlt)
		}
		js := j.String()
		sender = &js
		if info.PushName != "" {
			senderName = &info.PushName
			s.Contact(js, "", info.PushName)
		}
	}
	senderJID := info.Sender.ToNonAD().String()
	raw, _ := proto.Marshal(e.Message)
	ts := info.Timestamp.UnixMilli()
	if info.Timestamp.IsZero() {
		ts = time.Now().UnixMilli()
	}
	m = Message{Chat: chat.String(), ID: info.ID, FromMe: info.IsFromMe, Sender: sender, SenderName: senderName, TS: ts, Type: typ, Text: text, Quoted: strPtr(QuotedOf(e.Message)), SenderJID: &senderJID, Raw: raw}
	return m, s.SaveMessage(m), true
}

// Ready gets it connected and up to date, for a read or a send. fresh: wait for what it missed while away.
func (a *Account) Ready(fresh bool) error {
	a.mu.Lock()
	a.lastUse = time.Now()
	linked, unlinked, open := a.meta.Linked, a.meta.Unlinked, a.status == "open" && a.cli != nil && a.cli.IsConnected()
	a.mu.Unlock()
	if !linked {
		if unlinked {
			return refuse(409, "WhatsApp was unlinked from the phone; link it again")
		}
		return refuse(409, "not linked yet")
	}
	if !open {
		if err := a.Start(); err != nil {
			if r, ok := err.(*Refused); ok {
				return r
			}
			a.logf("connect failed: %v", err)
			return refuse(503, "couldn't reach WhatsApp just now; try again in a minute")
		}
		for until := time.Now().Add(30 * time.Second); ; time.Sleep(200 * time.Millisecond) {
			a.mu.Lock()
			status, unlinked := a.status, a.meta.Unlinked
			a.mu.Unlock()
			if unlinked {
				return refuse(409, "WhatsApp was unlinked from the phone; link it again")
			}
			if status == "open" {
				break
			}
			if time.Now().After(until) {
				return refuse(503, "couldn't reach WhatsApp just now; try again in a minute")
			}
		}
	}
	if fresh {
		// just reconnected: what it missed arrives first (OfflineSyncCompleted), or give it a few seconds
		a.mu.Lock()
		wait, done := 8*time.Second-time.Since(a.openedAt), a.caughtUp
		a.mu.Unlock()
		if wait > 0 {
			select {
			case <-done:
			case <-time.After(wait):
			}
		}
	}
	return nil
}

// Stop disconnects, keeping the login.
func (a *Account) Stop() {
	a.mu.Lock()
	cli := a.cli
	if a.stopLink != nil {
		a.stopLink()
		a.stopLink = nil
	}
	if a.status != "logged_out" {
		a.status = "closed"
	}
	a.mu.Unlock()
	if cli != nil {
		cli.Disconnect()
	}
}

func (a *Account) Close() {
	a.Stop()
	a.store.Close()
	a.wadb.Close()
}

// Destroy unlinks it from the phone (when it can) and forgets everything.
func (a *Account) Destroy() {
	if cli := a.client(); cli != nil && cli.IsLoggedIn() {
		ctx, cancel := context.WithTimeout(bg, 10*time.Second)
		cli.Logout(ctx)
		cancel()
	}
	a.Close()
	os.RemoveAll(a.dir)
}

func (a *Account) ChatName(jid string) string {
	if n := a.store.NameOf(jid); n != "" {
		return n
	}
	if p := PhoneOf(jid); p != nil {
		return *p
	}
	return jid
}

// Present is a message as Emplio sees it.
func (a *Account) Present(m Message) map[string]any {
	from, fromName := "me", any("me")
	if !m.FromMe {
		from, fromName = "", nil
		if m.Sender != nil {
			from = *m.Sender
			if p := PhoneOf(*m.Sender); p != nil {
				from = *p
			}
			if n := a.store.NameOf(*m.Sender); n != "" {
				fromName = n
			}
		}
		if fromName == nil && m.SenderName != nil {
			fromName = *m.SenderName
		}
	}
	out := map[string]any{
		"id": m.ID, "chat": m.Chat, "chat_name": a.ChatName(m.Chat), "is_group": strings.HasSuffix(m.Chat, "@g.us"),
		"from_me": m.FromMe, "from": from, "from_name": fromName, "time": time.UnixMilli(m.TS).UTC().Format(time.RFC3339),
		"type": m.Type, "text": m.Text, "has_media": media[m.Type],
	}
	if m.Quoted != nil {
		out["replying_to"] = *m.Quoted
	}
	return out
}

// ChatFor is a chat to send to or read, from what the agent wrote: an id, a phone number, or a chat's name.
func (a *Account) ChatFor(to string) (string, error) {
	jid, name := TargetOf(to)
	if jid != "" {
		j, err := types.ParseJID(jid)
		if err != nil {
			return "", refuse(400, "%q isn't a WhatsApp chat id", jid)
		}
		return a.canon(j, types.EmptyJID).String(), nil
	}
	found := a.store.Chats(name, "all", false, 10)
	exact := []Chat{}
	for _, c := range found {
		if c.Name != nil && strings.EqualFold(*c.Name, name) {
			exact = append(exact, c)
		}
	}
	pick := found
	if len(exact) == 1 {
		pick = exact
	}
	switch len(pick) {
	case 1:
		return pick[0].JID, nil
	case 0:
		return "", refuse(400, "no chat called %q; list_chats shows them", name)
	}
	names := []string{}
	for _, c := range pick {
		n := ""
		if c.Name != nil {
			n = *c.Name
		}
		names = append(names, fmt.Sprintf("%s (%s)", n, c.JID))
	}
	return "", refuse(400, "several chats match %q: %s; use the chat id", name, strings.Join(names, ", "))
}

// CheckSend: sends go only to people and groups this account already chats with, and not too many. Cold messages
// and bulk sending get numbers banned.
func (a *Account) CheckSend(jid string) error {
	if !a.store.HasChat(jid) && a.store.NameOf(jid) == "" {
		return refuse(400, "WhatsApp messages only go to people and groups this WhatsApp already chats with. For new numbers or bulk messages, use the WhatsApp Business API instead")
	}
	if a.store.Sent(time.Hour) >= LimitHour {
		return refuse(429, "already sent %d messages from this WhatsApp in the last hour; wait before sending more, so the number isn't flagged", LimitHour)
	}
	if a.store.Sent(24*time.Hour) >= LimitDay {
		return refuse(429, "already sent %d messages from this WhatsApp today; wait until tomorrow, so the number isn't flagged", LimitDay)
	}
	return nil
}

// Send sends a message (text, a file, a reaction) to a chat this account has, and saves it.
func (a *Account) Send(chat string, msg *waE2E.Message) (any, error) {
	if err := a.CheckSend(chat); err != nil {
		return nil, err
	}
	if err := a.Ready(false); err != nil {
		return nil, err
	}
	to, err := types.ParseJID(chat)
	if err != nil {
		return nil, refuse(400, "%q isn't a WhatsApp chat id", chat)
	}
	cli := a.client()
	if cli == nil {
		return nil, refuse(503, "couldn't reach WhatsApp just now; try again in a minute")
	}
	resp, err := cli.SendMessage(bg, to, msg)
	if err != nil {
		a.logf("send failed: %v", err)
		return nil, refuse(502, "WhatsApp didn't take the message: %v", err)
	}
	a.store.NoteSend()
	own := types.EmptyJID
	if cli.Store.ID != nil {
		own = cli.Store.ID.ToNonAD()
	}
	kept, _, ok := a.keep(&events.Message{Info: types.MessageInfo{MessageSource: types.MessageSource{Chat: to, Sender: own, IsFromMe: true, IsGroup: to.Server == types.GroupServer}, ID: resp.ID, Timestamp: resp.Timestamp}, Message: msg})
	if !ok {
		return map[string]any{"sent": true}, nil
	}
	return a.Present(kept), nil
}

// Raw is a saved message as WhatsApp sent it.
func (a *Account) Raw(chat, id string) (*Message, *waE2E.Message, error) {
	m := a.store.GetMessage(chat, id)
	if m == nil || m.Raw == nil {
		return nil, nil, refuse(404, "no message %s in that chat", id)
	}
	var w waE2E.Message
	if err := proto.Unmarshal(m.Raw, &w); err != nil {
		return nil, nil, refuse(404, "no message %s in that chat", id)
	}
	return m, &w, nil
}

// senderOf is who sent a saved message, as WhatsApp addresses them (for quoting, reacting and read receipts).
func (a *Account) senderOf(m *Message) types.JID {
	if m.FromMe {
		if cli := a.client(); cli != nil && cli.Store.ID != nil {
			return cli.Store.ID.ToNonAD()
		}
	}
	if m.SenderJID != nil {
		if j, err := types.ParseJID(*m.SenderJID); err == nil {
			return j
		}
	}
	j, _ := types.ParseJID(m.Chat)
	return j
}
