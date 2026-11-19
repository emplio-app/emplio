// Emplio's WhatsApp server: people link their own WhatsApp (or WhatsApp Business app) to Emplio the way they'd link
// WhatsApp on a computer, and Emplio reads, searches and answers their chats through the HTTP API below. Each linked
// account is a WhatsApp Web session (whatsmeow) with its login and messages in its own folder (account.go, store.go).
//
// Nobody stays connected around the clock. An account connects when Emplio reads or sends (and stays for a few minutes
// after), and every few hours on its own to catch up; WhatsApp keeps a linked device's missed messages for it. Emplio's
// new-message automations check /recent every hour or so, which connects it the same way. Sends only go to chats the
// account already has, and slowly, so the person's number isn't flagged.
//
// Settings: WHATSAPP_TOKEN (required, 32+ characters; Emplio sends it on every request), PORT (4200), HOST (0.0.0.0),
// DATA_DIR (./data), LOG_LEVEL (warn).
package main

import (
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"mime"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/google/uuid"
	qrcode "github.com/skip2/go-qrcode"
	"go.mau.fi/whatsmeow"
	"go.mau.fi/whatsmeow/proto/waE2E"
	"go.mau.fi/whatsmeow/store"
	"go.mau.fi/whatsmeow/types"
	"google.golang.org/protobuf/proto"
)

var idPattern = regexp.MustCompile(`^[0-9a-f-]{36}$`)

type Server struct {
	dataDir string
	token   string
	mu      sync.Mutex
	accts   map[string]*Account
}

func (s *Server) account(id string) (*Account, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if a := s.accts[id]; a != nil && idPattern.MatchString(id) {
		return a, nil
	}
	return nil, refuse(404, "no such account")
}

// Tick runs every minute: lets idle accounts go, catches quiet ones up, gives up on links never finished.
func (s *Server) Tick() {
	s.mu.Lock()
	all := make([]*Account, 0, len(s.accts))
	for _, a := range s.accts {
		all = append(all, a)
	}
	s.mu.Unlock()
	now := time.Now()
	for _, a := range all {
		a.mu.Lock()
		linked, unlinked, created, lastUse, status, caughtUp := a.meta.Linked, a.meta.Unlinked, time.UnixMilli(a.meta.Created), a.lastUse, a.status, time.UnixMilli(a.meta.CaughtUp)
		a.mu.Unlock()
		switch {
		case !linked:
			// never linked in time, or unlinked from the phone a week ago: forgotten (Emplio then asks to link again)
			if now.Sub(created) > LinkFor && (!unlinked || now.Sub(lastUse) > 7*24*time.Hour) {
				s.mu.Lock()
				delete(s.accts, a.ID)
				s.mu.Unlock()
				go a.Destroy()
			}
		case status == "open" && now.Sub(lastUse) > IdleFor:
			a.Stop()
		case status != "open" && status != "connecting" && now.Sub(caughtUp) > CatchUpEvery:
			// a short visit: connected long enough to take in what it missed, then idle again
			a.mu.Lock()
			a.lastUse = now.Add(-IdleFor + 90*time.Second)
			a.meta.CaughtUp = now.UnixMilli()
			a.saveMeta()
			a.mu.Unlock()
			go func() {
				if err := a.Start(); err != nil {
					a.logf("catch-up failed: %v", err)
				}
			}()
		}
	}
}

// --- HTTP ---

type handler func(a *Account, r *http.Request) (any, error)

// File is a download sent as itself rather than as JSON.
type File struct {
	Bytes []byte
	Type  string
	Name  string
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("content-type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(v)
}

func (s *Server) authorized(r *http.Request) bool {
	got := strings.TrimPrefix(r.Header.Get("authorization"), "Bearer ")
	return subtle.ConstantTimeCompare([]byte(got), []byte(s.token)) == 1
}

func (s *Server) wrap(fn func(r *http.Request) (any, error)) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !s.authorized(r) {
			writeJSON(w, 401, map[string]string{"error": "unauthorized"})
			return
		}
		r.Body = http.MaxBytesReader(w, r.Body, 100<<20)
		out, err := fn(r)
		var ref *Refused
		switch {
		case errors.As(err, &ref):
			writeJSON(w, ref.Status, map[string]string{"error": ref.Msg})
		case err != nil:
			log.Printf("error: %s %s: %v", r.Method, r.URL.Path, err)
			writeJSON(w, 500, map[string]string{"error": "something went wrong in the WhatsApp server"})
		default:
			if f, ok := out.(*File); ok {
				w.Header().Set("content-type", f.Type)
				w.Header().Set("x-filename", url.PathEscape(f.Name))
				w.Write(f.Bytes)
				return
			}
			writeJSON(w, 200, out)
		}
	}
}

// an account route: the account from the path
func (s *Server) acct(fn handler) http.HandlerFunc {
	return s.wrap(func(r *http.Request) (any, error) {
		a, err := s.account(r.PathValue("id"))
		if err != nil {
			return nil, err
		}
		return fn(a, r)
	})
}

func body(r *http.Request) (map[string]any, error) {
	b := map[string]any{}
	if r.ContentLength == 0 {
		return b, nil
	}
	if err := json.NewDecoder(r.Body).Decode(&b); err != nil {
		return nil, refuse(400, "not JSON")
	}
	return b, nil
}

// str is a required text field.
func str(v any, name string, max int) (string, error) {
	s, _ := v.(string)
	s = strings.TrimSpace(s)
	if s == "" || len(s) > max {
		return "", refuse(400, "%s is needed", name)
	}
	return s, nil
}

func num(v string, def, max int) int {
	n, err := strconv.Atoi(v)
	if err != nil || n < 1 {
		n = def
	}
	return min(n, max)
}

func timeMs(v string) int64 {
	if v == "" {
		return 0
	}
	t, err := time.Parse(time.RFC3339, v)
	if err != nil {
		return 0
	}
	return t.UnixMilli()
}

// readNote: reads still answer from what was saved when WhatsApp can't be reached, and say so.
func readNote(a *Account) string {
	if err := a.Ready(true); err != nil {
		return "showing what was saved: " + err.Error()
	}
	return ""
}

func withNote(out map[string]any, note string) map[string]any {
	if note != "" {
		out["note"] = note
	}
	return out
}

func (a *Account) presentAll(ms []Message) []map[string]any {
	out := make([]map[string]any, 0, len(ms))
	for _, m := range ms {
		out = append(out, a.Present(m))
	}
	return out
}

func (s *Server) Routes() *http.ServeMux {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /health", func(w http.ResponseWriter, r *http.Request) {
		s.mu.Lock()
		n, connected := len(s.accts), 0
		for _, a := range s.accts {
			if a.State().Status == "connected" {
				connected++
			}
		}
		s.mu.Unlock()
		writeJSON(w, 200, map[string]any{"ok": true, "accounts": n, "connected": connected})
	})

	// a new account, linking: its QR code (and a pairing code once asked) come from GET
	mux.HandleFunc("POST /accounts", s.wrap(func(r *http.Request) (any, error) {
		b, err := body(r)
		if err != nil {
			return nil, err
		}
		a, err := OpenAccount(s.dataDir, uuid.NewString())
		if err != nil {
			return nil, err
		}
		s.mu.Lock()
		s.accts[a.ID] = a
		s.mu.Unlock()
		a.logf("linking")
		if err := a.Start(); err != nil {
			return nil, err
		}
		if phone, _ := b["phone"].(string); phone != "" {
			go a.Pair(phone)
		}
		return a.State(), nil
	}))
	// link with a code typed on the phone instead of the QR code (when the phone is the screen showing it)
	mux.HandleFunc("POST /accounts/{id}/code", s.acct(func(a *Account, r *http.Request) (any, error) {
		b, err := body(r)
		if err != nil {
			return nil, err
		}
		phone, err := str(b["phone"], "phone", 30)
		if err != nil {
			return nil, err
		}
		phone = strings.TrimPrefix(nonDigits.ReplaceAllString(phone, ""), "00")
		if len(phone) < 8 {
			return nil, refuse(400, "the phone number, with its country code")
		}
		if _, err := a.Pair(phone); err != nil {
			return nil, err
		}
		return a.State(), nil
	}))
	mux.HandleFunc("GET /accounts/{id}", s.acct(func(a *Account, r *http.Request) (any, error) { return a.State(), nil }))
	mux.HandleFunc("DELETE /accounts/{id}", s.acct(func(a *Account, r *http.Request) (any, error) {
		s.mu.Lock()
		delete(s.accts, a.ID)
		s.mu.Unlock()
		a.Destroy()
		a.logf("removed")
		return map[string]bool{"ok": true}, nil
	}))

	mux.HandleFunc("GET /accounts/{id}/chats", s.acct(func(a *Account, r *http.Request) (any, error) {
		note := readNote(a)
		q := r.URL.Query()
		kind := q.Get("kind")
		if kind != "people" && kind != "groups" {
			kind = "all"
		}
		chats := []map[string]any{}
		for _, c := range a.store.Chats(q.Get("query"), kind, q.Get("unread") == "true", num(q.Get("limit"), 30, 200)) {
			var last any
			if c.LastTS > 0 {
				last = time.UnixMilli(c.LastTS).UTC().Format(time.RFC3339)
			}
			name := c.JID
			if c.Name != nil && *c.Name != "" {
				name = *c.Name
			} else if p := PhoneOf(c.JID); p != nil {
				name = *p
			}
			chats = append(chats, map[string]any{"chat": c.JID, "name": name, "phone": PhoneOf(c.JID), "is_group": c.IsGroup, "unread": c.Unread, "last_message": last})
		}
		return withNote(map[string]any{"chats": chats}, note), nil
	}))
	mux.HandleFunc("GET /accounts/{id}/messages", s.acct(func(a *Account, r *http.Request) (any, error) {
		note := readNote(a)
		q := r.URL.Query()
		raw, err := str(q.Get("chat"), "chat", 200)
		if err != nil {
			return nil, err
		}
		chat, err := a.ChatFor(raw)
		if err != nil {
			return nil, err
		}
		ms := a.store.Messages(chat, num(q.Get("limit"), 50, 500), timeMs(q.Get("before")), timeMs(q.Get("after")))
		return withNote(map[string]any{"chat": chat, "chat_name": a.ChatName(chat), "messages": a.presentAll(ms)}, note), nil
	}))
	// what came in lately across every chat, newest first: what Emplio's new-message automations check
	mux.HandleFunc("GET /accounts/{id}/recent", s.acct(func(a *Account, r *http.Request) (any, error) {
		note := readNote(a)
		q := r.URL.Query()
		after := timeMs(q.Get("after"))
		if after == 0 {
			after = time.Now().Add(-3 * time.Hour).UnixMilli()
		}
		return withNote(map[string]any{"messages": a.presentAll(a.store.Recent(after, num(q.Get("limit"), 200, 1000)))}, note), nil
	}))
	mux.HandleFunc("GET /accounts/{id}/search", s.acct(func(a *Account, r *http.Request) (any, error) {
		note := readNote(a)
		q := r.URL.Query()
		query, err := str(q.Get("query"), "query", 500)
		if err != nil {
			return nil, err
		}
		chat := ""
		if c := q.Get("chat"); c != "" {
			if chat, err = a.ChatFor(c); err != nil {
				return nil, err
			}
		}
		return withNote(map[string]any{"messages": a.presentAll(a.store.Search(query, chat, num(q.Get("limit"), 30, 200)))}, note), nil
	}))
	mux.HandleFunc("GET /accounts/{id}/contacts", s.acct(func(a *Account, r *http.Request) (any, error) {
		q := r.URL.Query()
		out := []map[string]any{}
		for _, c := range a.store.Contacts(q.Get("query"), num(q.Get("limit"), 50, 500)) {
			name := c.Name
			if name == nil || *name == "" {
				name = c.Notify
			}
			out = append(out, map[string]any{"chat": c.JID, "name": name, "phone": PhoneOf(c.JID)})
		}
		return map[string]any{"contacts": out}, nil
	}))
	mux.HandleFunc("GET /accounts/{id}/group", s.acct(func(a *Account, r *http.Request) (any, error) {
		raw, err := str(r.URL.Query().Get("chat"), "chat", 200)
		if err != nil {
			return nil, err
		}
		chat, err := a.ChatFor(raw)
		if err != nil {
			return nil, err
		}
		if !strings.HasSuffix(chat, "@g.us") {
			return nil, refuse(400, "that chat isn't a group")
		}
		if err := a.Ready(false); err != nil {
			return nil, err
		}
		jid, _ := types.ParseJID(chat)
		g, err := a.client().GetGroupInfo(bg, jid)
		if err != nil {
			return nil, refuse(502, "WhatsApp didn't give the group's details: %v", err)
		}
		a.store.Chat(chat, g.Name, 0, -1)
		people := []map[string]any{}
		for _, p := range g.Participants {
			j := a.canon(p.JID, p.PhoneNumber).String()
			var admin any
			if p.IsSuperAdmin {
				admin = "superadmin"
			} else if p.IsAdmin {
				admin = "admin"
			}
			people = append(people, map[string]any{"phone": PhoneOf(j), "name": strPtr(a.store.NameOf(j)), "admin": admin})
		}
		var created any
		if !g.GroupCreated.IsZero() {
			created = g.GroupCreated.UTC().Format(time.RFC3339)
		}
		return map[string]any{"chat": chat, "name": g.Name, "description": strPtr(g.Topic), "created": created, "participants": people}, nil
	}))
	mux.HandleFunc("GET /accounts/{id}/media", s.acct(func(a *Account, r *http.Request) (any, error) {
		q := r.URL.Query()
		raw, err := str(q.Get("chat"), "chat", 200)
		if err != nil {
			return nil, err
		}
		chat, err := a.ChatFor(raw)
		if err != nil {
			return nil, err
		}
		id, err := str(q.Get("message"), "message", 200)
		if err != nil {
			return nil, err
		}
		_, w, err := a.Raw(chat, id)
		if err != nil {
			return nil, err
		}
		m := unwrap(w)
		var file whatsmeow.DownloadableMessage
		mimetype, name := "", ""
		switch {
		case m.ImageMessage != nil:
			file, mimetype = m.ImageMessage, m.ImageMessage.GetMimetype()
		case m.VideoMessage != nil:
			file, mimetype = m.VideoMessage, m.VideoMessage.GetMimetype()
		case m.PtvMessage != nil:
			file, mimetype = m.PtvMessage, m.PtvMessage.GetMimetype()
		case m.AudioMessage != nil:
			file, mimetype = m.AudioMessage, m.AudioMessage.GetMimetype()
		case m.DocumentMessage != nil:
			file, mimetype, name = m.DocumentMessage, m.DocumentMessage.GetMimetype(), m.DocumentMessage.GetFileName()
		case m.StickerMessage != nil:
			file, mimetype = m.StickerMessage, m.StickerMessage.GetMimetype()
		default:
			return nil, refuse(400, "that message has no photo, video, voice note or file")
		}
		if err := a.Ready(false); err != nil {
			return nil, err
		}
		data, err := a.client().Download(bg, file)
		if err != nil {
			return nil, refuse(404, "couldn't download it; WhatsApp may no longer have it")
		}
		if mimetype == "" {
			mimetype = "application/octet-stream"
		}
		mimetype = strings.TrimSpace(strings.SplitN(mimetype, ";", 2)[0])
		if name == "" {
			ext := "bin"
			if parts := strings.SplitN(mimetype, "/", 2); len(parts) == 2 {
				ext = parts[1]
			}
			name = fmt.Sprintf("whatsapp-%s.%s", id, ext)
		}
		return &File{Bytes: data, Type: mimetype, Name: name}, nil
	}))

	mux.HandleFunc("POST /accounts/{id}/send", s.acct(func(a *Account, r *http.Request) (any, error) {
		b, err := body(r)
		if err != nil {
			return nil, err
		}
		to, err := str(b["to"], "to", 200)
		if err != nil {
			return nil, err
		}
		text, err := str(b["text"], "text", 65000)
		if err != nil {
			return nil, err
		}
		chat, err := a.ChatFor(to)
		if err != nil {
			return nil, err
		}
		msg := &waE2E.Message{Conversation: proto.String(text)}
		if reply, _ := b["reply_to"].(string); reply != "" {
			q, w, err := a.Raw(chat, reply)
			if err != nil {
				return nil, err
			}
			msg = a.replyTo(q, w, text)
		}
		return a.Send(chat, msg)
	}))
	mux.HandleFunc("POST /accounts/{id}/send-file", s.acct(func(a *Account, r *http.Request) (any, error) {
		b, err := body(r)
		if err != nil {
			return nil, err
		}
		to, err := str(b["to"], "to", 200)
		if err != nil {
			return nil, err
		}
		enc, err := str(b["data"], "data", 90<<20)
		if err != nil {
			return nil, err
		}
		data, err := base64.StdEncoding.DecodeString(enc)
		if err != nil {
			return nil, refuse(400, "data must be base64")
		}
		chat, err := a.ChatFor(to)
		if err != nil {
			return nil, err
		}
		typ, _ := b["type"].(string)
		if typ == "" {
			typ = "application/octet-stream"
		}
		name, _ := b["name"].(string)
		if name == "" {
			name = "file"
		}
		caption, _ := b["caption"].(string)
		// checked before the upload too, so a refused send costs nothing
		if err := a.CheckSend(chat); err != nil {
			return nil, err
		}
		if err := a.Ready(false); err != nil {
			return nil, err
		}
		kind := whatsmeow.MediaDocument
		switch {
		case strings.HasPrefix(typ, "image/") && !strings.Contains(typ, "svg"):
			kind = whatsmeow.MediaImage
		case strings.HasPrefix(typ, "video/"):
			kind = whatsmeow.MediaVideo
		case strings.HasPrefix(typ, "audio/"):
			kind = whatsmeow.MediaAudio
		}
		up, err := a.client().Upload(bg, data, kind)
		if err != nil {
			return nil, refuse(502, "couldn't upload the file to WhatsApp: %v", err)
		}
		return a.Send(chat, fileMessage(kind, up, typ, name, caption))
	}))
	mux.HandleFunc("POST /accounts/{id}/react", s.acct(func(a *Account, r *http.Request) (any, error) {
		b, err := body(r)
		if err != nil {
			return nil, err
		}
		raw, err := str(b["chat"], "chat", 200)
		if err != nil {
			return nil, err
		}
		id, err := str(b["message"], "message", 200)
		if err != nil {
			return nil, err
		}
		chat, err := a.ChatFor(raw)
		if err != nil {
			return nil, err
		}
		m, _, err := a.Raw(chat, id)
		if err != nil {
			return nil, err
		}
		emoji, _ := b["emoji"].(string)
		jid, _ := types.ParseJID(chat)
		if err := a.Ready(false); err != nil {
			return nil, err
		}
		return a.Send(chat, a.client().BuildReaction(jid, a.senderOf(m), m.ID, emoji))
	}))
	// blue ticks for what they've had: only when asked, never by reading
	mux.HandleFunc("POST /accounts/{id}/read", s.acct(func(a *Account, r *http.Request) (any, error) {
		b, err := body(r)
		if err != nil {
			return nil, err
		}
		raw, err := str(b["chat"], "chat", 200)
		if err != nil {
			return nil, err
		}
		chat, err := a.ChatFor(raw)
		if err != nil {
			return nil, err
		}
		if err := a.Ready(false); err != nil {
			return nil, err
		}
		jid, _ := types.ParseJID(chat)
		bySender := map[types.JID][]types.MessageID{}
		marked := 0
		for _, m := range a.store.Messages(chat, 50, 0, 0) {
			if !m.FromMe {
				s := a.senderOf(&m)
				bySender[s] = append(bySender[s], m.ID)
				marked++
			}
		}
		for sender, ids := range bySender {
			if err := a.client().MarkRead(bg, ids, time.Now(), jid, sender); err != nil {
				return nil, refuse(502, "WhatsApp didn't take the read receipts: %v", err)
			}
		}
		a.store.Chat(chat, "", 0, 0)
		return map[string]any{"ok": true, "marked": marked}, nil
	}))
	s.manageRoutes(mux)
	return mux
}

// fileMessage is an uploaded file as the kind of message it shows as.
func fileMessage(kind whatsmeow.MediaType, up whatsmeow.UploadResponse, typ, name, caption string) *waE2E.Message {
	c := proto.String(caption)
	if caption == "" {
		c = nil
	}
	switch kind {
	case whatsmeow.MediaImage:
		return &waE2E.Message{ImageMessage: &waE2E.ImageMessage{URL: &up.URL, DirectPath: &up.DirectPath, MediaKey: up.MediaKey, FileEncSHA256: up.FileEncSHA256, FileSHA256: up.FileSHA256, FileLength: &up.FileLength, Mimetype: &typ, Caption: c}}
	case whatsmeow.MediaVideo:
		return &waE2E.Message{VideoMessage: &waE2E.VideoMessage{URL: &up.URL, DirectPath: &up.DirectPath, MediaKey: up.MediaKey, FileEncSHA256: up.FileEncSHA256, FileSHA256: up.FileSHA256, FileLength: &up.FileLength, Mimetype: &typ, Caption: c}}
	case whatsmeow.MediaAudio:
		// .ogg (opus) goes as a voice note
		ptt := strings.Contains(typ, "ogg")
		if ptt {
			typ = "audio/ogg; codecs=opus"
		}
		return &waE2E.Message{AudioMessage: &waE2E.AudioMessage{URL: &up.URL, DirectPath: &up.DirectPath, MediaKey: up.MediaKey, FileEncSHA256: up.FileEncSHA256, FileSHA256: up.FileSHA256, FileLength: &up.FileLength, Mimetype: &typ, PTT: &ptt}}
	}
	if ext, _ := mime.ExtensionsByType(typ); len(ext) > 0 && !strings.Contains(name, ".") {
		name += ext[0]
	}
	return &waE2E.Message{DocumentMessage: &waE2E.DocumentMessage{URL: &up.URL, DirectPath: &up.DirectPath, MediaKey: up.MediaKey, FileEncSHA256: up.FileEncSHA256, FileSHA256: up.FileSHA256, FileLength: &up.FileLength, Mimetype: &typ, FileName: &name, Title: &name, Caption: c}}
}

// qrSVG draws WhatsApp's QR code for the link page.
func qrSVG(content string) string {
	q, err := qrcode.New(content, qrcode.Medium)
	if err != nil {
		return ""
	}
	q.DisableBorder = true
	bits := q.Bitmap()
	var path strings.Builder
	for y, row := range bits {
		for x, on := range row {
			if on {
				fmt.Fprintf(&path, "M%d %dh1v1h-1z", x, y)
			}
		}
	}
	n := len(bits)
	return fmt.Sprintf(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="-1 -1 %d %d" shape-rendering="crispEdges"><rect x="-1" y="-1" width="%d" height="%d" fill="#fff"/><path fill="#000" d="%s"/></svg>`, n+2, n+2, n+2, n+2, path.String())
}

func main() {
	token := os.Getenv("WHATSAPP_TOKEN")
	if len(token) < 32 {
		// an install from before WhatsApp: stays off quietly instead of restarting over and over
		log.Print("whatsapp: WHATSAPP_TOKEN isn't set (32+ characters), so WhatsApp stays off")
		select {}
	}
	dataDir := os.Getenv("DATA_DIR")
	if dataDir == "" {
		dataDir = "./data"
	}
	if err := os.MkdirAll(dataDir, 0o700); err != nil {
		log.Fatal(err)
	}
	// how the linked device shows on the phone (WhatsApp → Linked devices)
	store.SetOSInfo("Emplio", [3]uint32{1, 0, 0})
	s := &Server{dataDir: dataDir, token: token, accts: map[string]*Account{}}
	entries, _ := os.ReadDir(dataDir)
	for _, e := range entries {
		if !e.IsDir() || !idPattern.MatchString(e.Name()) {
			continue
		}
		a, err := OpenAccount(dataDir, e.Name())
		if err != nil {
			log.Printf("%s: can't open: %v", e.Name(), err)
			continue
		}
		s.accts[a.ID] = a
	}
	go func() {
		for range time.Tick(time.Minute) {
			s.Tick()
		}
	}()
	port := os.Getenv("PORT")
	if port == "" {
		port = "4200"
	}
	host := os.Getenv("HOST")
	if host == "" {
		host = "0.0.0.0"
	}
	srv := &http.Server{Addr: net.JoinHostPort(host, port), Handler: s.Routes(), ReadHeaderTimeout: 10 * time.Second}
	go func() {
		stop := make(chan os.Signal, 1)
		signal.Notify(stop, syscall.SIGTERM, syscall.SIGINT)
		<-stop
		s.mu.Lock()
		for _, a := range s.accts {
			a.Close()
		}
		os.Exit(0)
	}()
	log.Printf("whatsapp: %d accounts, listening on %s", len(s.accts), port)
	log.Fatal(srv.ListenAndServe())
}
