// The WhatsApp server's own rules, without WhatsApp: what a message says, the saved chats and search, who sends may go
// to and how many, and that the API wants its token. Run: go test ./...
package main

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"go.mau.fi/whatsmeow/proto/waE2E"
	"go.mau.fi/whatsmeow/types"
	"google.golang.org/protobuf/proto"
)

func eq[T comparable](t *testing.T, got, want T) {
	t.Helper()
	if got != want {
		t.Fatalf("got %v, want %v", got, want)
	}
}

func text(m *waE2E.Message) string {
	_, s, _ := TextOf(m)
	return s
}

func TestWhatAMessageSays(t *testing.T) {
	typ, s, ok := TextOf(&waE2E.Message{Conversation: proto.String("hi")})
	eq(t, typ+"|"+s, "conversation|hi")
	eq(t, ok, true)
	eq(t, text(&waE2E.Message{ExtendedTextMessage: &waE2E.ExtendedTextMessage{Text: proto.String("see this")}}), "see this")
	eq(t, text(&waE2E.Message{ImageMessage: &waE2E.ImageMessage{Caption: proto.String("the invoice")}}), "[photo] the invoice")
	eq(t, text(&waE2E.Message{AudioMessage: &waE2E.AudioMessage{PTT: proto.Bool(true)}}), "[voice note]")
	eq(t, text(&waE2E.Message{DocumentMessage: &waE2E.DocumentMessage{FileName: proto.String("quote.pdf")}}), "[file: quote.pdf]")
	eq(t, text(&waE2E.Message{EphemeralMessage: &waE2E.FutureProofMessage{Message: &waE2E.Message{Conversation: proto.String("disappearing")}}}), "disappearing")
	// not something anyone said
	_, _, ok = TextOf(&waE2E.Message{ReactionMessage: &waE2E.ReactionMessage{Text: proto.String("👍")}})
	eq(t, ok, false)
	_, _, ok = TextOf(&waE2E.Message{ProtocolMessage: &waE2E.ProtocolMessage{}})
	eq(t, ok, false)
	eq(t, QuotedOf(&waE2E.Message{ExtendedTextMessage: &waE2E.ExtendedTextMessage{Text: proto.String("yes"), ContextInfo: &waE2E.ContextInfo{QuotedMessage: &waE2E.Message{Conversation: proto.String("can you deliver friday?")}}}}), "can you deliver friday?")
}

func TestPeopleByPhoneNumber(t *testing.T) {
	jid := func(s string) types.JID { j, _ := types.ParseJID(s); return j }
	eq(t, Canon(jid("15551234567:3@s.whatsapp.net"), types.EmptyJID, nil).String(), "15551234567@s.whatsapp.net")
	eq(t, Canon(jid("999@lid"), jid("15551234567@s.whatsapp.net"), nil).String(), "15551234567@s.whatsapp.net")
	known := func(l types.JID) types.JID {
		if l.String() == "999@lid" {
			return jid("15550000000@s.whatsapp.net")
		}
		return types.EmptyJID
	}
	eq(t, Canon(jid("999@lid"), types.EmptyJID, known).String(), "15550000000@s.whatsapp.net")
	eq(t, Canon(jid("999@lid"), types.EmptyJID, nil).String(), "999@lid")
	j, n := TargetOf("+1 (555) 123-4567")
	eq(t, j+n, "15551234567@s.whatsapp.net")
	j, n = TargetOf("Northwind team")
	eq(t, j+"|"+n, "|Northwind team")
	j, _ = TargetOf("123@g.us")
	eq(t, j, "123@g.us")
}

func TestChatsMessagesAndSearch(t *testing.T) {
	s, err := OpenStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	sarah := "15551234567@s.whatsapp.net"
	s.Contact(sarah, "Sarah Lee", "")
	msg := func(chat, id string, ts int64, text string) Message {
		return Message{Chat: chat, ID: id, Sender: &sarah, TS: ts, Type: "conversation", Text: text}
	}
	eq(t, s.SaveMessage(msg(sarah, "a", 1000, "Is the order shipped?")), true)
	eq(t, s.SaveMessage(msg(sarah, "a", 1000, "Is the order shipped?")), false)
	s.SaveMessage(msg("123@g.us", "b", 2000, "Team lunch on Friday"))
	s.Chat("123@g.us", "Northwind team", 0, -1)
	s.BumpUnread("123@g.us")
	chats := s.Chats("", "all", false, 10)
	eq(t, len(chats), 2)
	eq(t, *chats[0].Name+"|"+*chats[1].Name, "Northwind team|Sarah Lee")
	eq(t, chats[0].IsGroup && chats[0].Unread == 1 && !chats[1].IsGroup, true)
	eq(t, s.Chats("sarah", "all", false, 10)[0].JID, sarah)
	eq(t, len(s.Chats("", "groups", false, 10)), 1)
	eq(t, s.Chats("", "all", true, 10)[0].JID, "123@g.us")
	eq(t, s.Search("order", "", 10)[0].ID, "a")
	eq(t, s.Search(`friday "lunch`, "", 10)[0].ID, "b")
	eq(t, len(s.Search("order", "123@g.us", 10)), 0)
	recent := s.Recent(500, 10)
	eq(t, len(recent), 2)
	eq(t, recent[0].ID, "b")
	eq(t, len(s.Recent(1500, 10)), 1)
}

func TestSendsOnlyToKnownChatsAndNotTooMany(t *testing.T) {
	a, err := OpenAccount(t.TempDir(), "00000000-0000-4000-8000-000000000001")
	if err != nil {
		t.Fatal(err)
	}
	defer a.Close()
	sarah := "15551234567@s.whatsapp.net"
	a.store.Chat(sarah, "Sarah", 0, -1)
	if err := a.CheckSend("15550000000@s.whatsapp.net"); err == nil {
		t.Fatal("sent to a stranger")
	}
	if err := a.CheckSend(sarah); err != nil {
		t.Fatal(err)
	}
	for range LimitHour {
		a.store.NoteSend()
	}
	if err := a.CheckSend(sarah); err == nil || err.(*Refused).Status != 429 {
		t.Fatalf("hourly limit: %v", err)
	}
	c, err := a.ChatFor("Sarah")
	eq(t, c, sarah)
	if _, err = a.ChatFor("Nobody"); err == nil {
		t.Fatal("found nobody")
	}
	// not linked: reads and sends say so rather than connecting
	if err := a.Ready(true); err == nil || err.(*Refused).Status != 409 {
		t.Fatalf("ready: %v", err)
	}
}

func TestTheAPIWantsItsToken(t *testing.T) {
	s := &Server{dataDir: t.TempDir(), token: "t1234567890123456789012345678901", accts: map[string]*Account{}}
	srv := httptest.NewServer(s.Routes())
	defer srv.Close()
	get := func(path, token string) int {
		req, _ := http.NewRequest("GET", srv.URL+path, nil)
		if token != "" {
			req.Header.Set("authorization", "Bearer "+token)
		}
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		res.Body.Close()
		return res.StatusCode
	}
	eq(t, get("/health", ""), 200)
	eq(t, get("/accounts/x", ""), 401)
	eq(t, get("/accounts/x", "wrong"), 401)
	eq(t, get("/accounts/00000000-0000-4000-8000-000000000009", s.token), 404)
}

func TestQRCodeDraws(t *testing.T) {
	svg := qrSVG("2@abc,def,ghi")
	eq(t, len(svg) > 500 && svg[:4] == "<svg", true)
}
