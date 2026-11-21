// The WhatsApp server's own rules, without WhatsApp: what a message says, the saved chats and search, who sends may go
// to and how many, and that the API wants its token. Run: go test ./...
package main

import (
	"bytes"
	"errors"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"image"
	"image/png"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"go.mau.fi/whatsmeow"
	"go.mau.fi/whatsmeow/proto/waCommon"
	"go.mau.fi/whatsmeow/proto/waE2E"
	"go.mau.fi/whatsmeow/proto/waSyncAction"
	"go.mau.fi/whatsmeow/types"
	"go.mau.fi/whatsmeow/types/events"
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
		a.store.NoteSend(false)
	}
	if err := a.CheckSend(sarah); err == nil || err.(*Refused).Status != 429 {
		t.Fatalf("hourly limit: %v", err)
	}
	// Sarah wrote today: replying to her gets the higher limit, counting every send
	a.store.SaveMessage(Message{Chat: sarah, ID: "in1", Sender: &sarah, TS: time.Now().UnixMilli(), Type: "conversation", Text: "hi"})
	if err := a.CheckSend(sarah); err != nil {
		t.Fatalf("reply: %v", err)
	}
	for range ReplyHour - LimitHour {
		a.store.NoteSend(true)
	}
	if err := a.CheckSend(sarah); err == nil || err.(*Refused).Status != 429 {
		t.Fatalf("reply limit: %v", err)
	}
	if err := a.UnderLimit(); err == nil {
		t.Fatal("non-reply limit forgot its own sends")
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

func TestEditsDeletesReactionsAndTicks(t *testing.T) {
	a, err := OpenAccount(t.TempDir(), "00000000-0000-4000-8000-000000000002")
	if err != nil {
		t.Fatal(err)
	}
	defer a.Close()
	sarah := types.NewJID("15551234567", types.DefaultUserServer)
	from := func(id string, m *waE2E.Message) *events.Message {
		return &events.Message{Info: types.MessageInfo{MessageSource: types.MessageSource{Chat: sarah, Sender: sarah}, ID: id, Timestamp: time.Now()}, Message: m}
	}
	a.on(from("m1", &waE2E.Message{Conversation: proto.String("meet at 5")}))
	// a chat first heard of now is a new chat
	evs := a.store.Events(0, []string{"new_chat"}, 10)
	eq(t, len(evs), 1)
	eq(t, evs[0].Who, sarah.String())

	key := &waCommon.MessageKey{ID: proto.String("m1"), RemoteJID: proto.String(sarah.String())}
	a.on(from("m2", &waE2E.Message{ProtocolMessage: &waE2E.ProtocolMessage{Type: waE2E.ProtocolMessage_MESSAGE_EDIT.Enum(), Key: key, EditedMessage: &waE2E.Message{Conversation: proto.String("meet at 6")}}}))
	m := a.store.GetMessage(sarah.String(), "m1")
	eq(t, m.Text, "meet at 6")
	eq(t, a.Present(*m)["edited"], any(true))
	a.on(from("m3", &waE2E.Message{ReactionMessage: &waE2E.ReactionMessage{Key: key, Text: proto.String("👍")}}))
	eq(t, a.store.Marks("reactions", sarah.String(), "m1")[0][1], "👍")
	a.on(from("m4", &waE2E.Message{ProtocolMessage: &waE2E.ProtocolMessage{Type: waE2E.ProtocolMessage_REVOKE.Enum(), Key: key}}))
	eq(t, a.Present(*a.store.GetMessage(sarah.String(), "m1"))["deleted"], any(true))
	// none of those are messages of their own
	eq(t, len(a.store.Messages(sarah.String(), 10, 0, 0)), 1)
	kinds := ""
	for _, e := range a.store.Events(0, nil, 10) {
		kinds += e.Kind + " "
	}
	eq(t, kinds, "deleted reaction edited new_chat ")
	eq(t, a.store.Events(0, []string{"deleted"}, 10)[0].Text, "meet at 6")

	// ticks on what this account sent only move forward
	a.store.SaveMessage(Message{Chat: sarah.String(), ID: "s1", FromMe: true, TS: time.Now().UnixMilli(), Type: "conversation", Text: "ok", Ack: 1})
	a.on(&events.Receipt{MessageSource: types.MessageSource{Chat: sarah, Sender: sarah}, MessageIDs: []types.MessageID{"s1"}, Type: types.ReceiptTypeRead})
	a.on(&events.Receipt{MessageSource: types.MessageSource{Chat: sarah, Sender: sarah}, MessageIDs: []types.MessageID{"s1"}, Type: types.ReceiptTypeDelivered})
	eq(t, a.Present(*a.store.GetMessage(sarah.String(), "s1"))["status"], any("read"))
}

func TestAWatchedAccountPostsWhatHappens(t *testing.T) {
	got := make(chan *http.Request, 4)
	bodies := make(chan []byte, 4)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		got <- r
		bodies <- b
	}))
	defer srv.Close()
	a, err := OpenAccount(t.TempDir(), "00000000-0000-4000-8000-000000000003")
	if err != nil {
		t.Fatal(err)
	}
	defer a.Close()
	secret := strings.Repeat("s", 40)
	a.SetWatch(&Watch{URL: srv.URL, Secret: secret})
	eq(t, a.State().Watching, true)
	sarah := types.NewJID("15551234567", types.DefaultUserServer)
	a.on(&events.Message{Info: types.MessageInfo{MessageSource: types.MessageSource{Chat: sarah, Sender: sarah}, ID: "m1", Timestamp: time.Now()}, Message: &waE2E.Message{Conversation: proto.String("hello")}})
	// a new chat (an event) and the message itself, each signed
	kinds := map[string]bool{}
	for range 2 {
		select {
		case r := <-got:
			b := <-bodies
			mac := hmac.New(sha256.New, []byte(secret))
			mac.Write(b)
			eq(t, r.Header.Get("x-emplio-signature"), hex.EncodeToString(mac.Sum(nil)))
			var p struct{ Kind string }
			json.Unmarshal(b, &p)
			kinds[p.Kind] = true
		case <-time.After(5 * time.Second):
			t.Fatal("nothing posted")
		}
	}
	eq(t, kinds["message"] && kinds["new_chat"], true)
	a.SetWatch(nil)
	eq(t, a.State().Watching, false)
}

func TestPollVotesAndForwards(t *testing.T) {
	poll := &waE2E.Message{PollCreationMessageV3: &waE2E.PollCreationMessage{Name: proto.String("Lunch?"), Options: []*waE2E.PollCreationMessage_Option{{OptionName: proto.String("Pizza")}, {OptionName: proto.String("Sushi")}}}}
	h := sha256.Sum256([]byte("Sushi"))
	eq(t, strings.Join(pollChoices(poll, [][]byte{h[:]}), ","), "Sushi")
	f := withContext(&waE2E.Message{Conversation: proto.String("fyi")}, &waE2E.ContextInfo{IsForwarded: proto.Bool(true)})
	eq(t, f.GetExtendedTextMessage().GetText(), "fyi")
	eq(t, f.GetExtendedTextMessage().GetContextInfo().GetIsForwarded(), true)
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

func TestPhotosCardsAndPollChoices(t *testing.T) {
	// any photo becomes a square JPEG of at most 640 pixels
	img := image.NewRGBA(image.Rect(0, 0, 1200, 800))
	var png1 bytes.Buffer
	png.Encode(&png1, img)
	out, err := squareJPEG(png1.Bytes())
	if err != nil {
		t.Fatal(err)
	}
	cfg, format, err := image.DecodeConfig(bytes.NewReader(out))
	eq(t, err == nil && format == "jpeg" && cfg.Width == 640 && cfg.Height == 640, true)
	if _, err := squareJPEG([]byte("not a photo")); err == nil {
		t.Fatal("took a non-photo")
	}
	eq(t, vcard("Sarah; Lee\n", "15551234567"), "BEGIN:VCARD\nVERSION:3.0\nFN:Sarah  Lee \nTEL;type=CELL;waid=15551234567:+15551234567\nEND:VCARD")
	poll := &waE2E.Message{PollCreationMessageV3: &waE2E.PollCreationMessage{Name: proto.String("Lunch?"), Options: []*waE2E.PollCreationMessage_Option{{OptionName: proto.String("Pizza")}, {OptionName: proto.String("Sushi")}}}}
	eq(t, strings.Join(pollOptions(poll), ","), "Pizza,Sushi")
	eq(t, kindOf("image/png"), whatsmeow.MediaImage)
	eq(t, kindOf("image/svg+xml"), whatsmeow.MediaDocument)
}

func TestLabelsOldestAndDeletingAChat(t *testing.T) {
	a, err := OpenAccount(t.TempDir(), "00000000-0000-4000-8000-000000000004")
	if err != nil {
		t.Fatal(err)
	}
	defer a.Close()
	sarah := types.NewJID("15551234567", types.DefaultUserServer)
	a.on(&events.LabelEdit{LabelID: "3", Action: &waSyncAction.LabelEditAction{Name: proto.String("New customer"), Color: proto.Int32(2)}})
	a.on(&events.LabelAssociationChat{JID: sarah, LabelID: "3", Action: &waSyncAction.LabelAssociationAction{Labeled: proto.Bool(true)}})
	l, err := a.labelFor("new CUSTOMER")
	if err != nil {
		t.Fatal(err)
	}
	eq(t, l.ID+"|"+strings.Join(l.Chats, ","), "3|"+sarah.String())
	a.on(&events.LabelAssociationChat{JID: sarah, LabelID: "3", Action: &waSyncAction.LabelAssociationAction{Labeled: proto.Bool(false)}})
	l, _ = a.labelFor("3")
	eq(t, len(l.Chats), 0)
	a.on(&events.LabelEdit{LabelID: "3", Action: &waSyncAction.LabelEditAction{Name: proto.String("New customer"), Deleted: proto.Bool(true)}})
	if _, err := a.labelFor("3"); err == nil {
		t.Fatal("found a deleted label")
	}

	for i, id := range []string{"b", "a", "c"} {
		a.store.SaveMessage(Message{Chat: sarah.String(), ID: id, TS: int64(1000 * (3 - i)), Type: "conversation", Text: "hi " + id})
	}
	eq(t, a.store.Oldest(sarah.String()).ID, "c")
	a.store.DeleteChat(sarah.String())
	eq(t, a.store.Oldest(sarah.String()) == nil && !a.store.HasChat(sarah.String()) && len(a.store.Search("hi", "", 10)) == 0, true)
}

func TestReplyingPrivatelyNeedsAGroupMessage(t *testing.T) {
	s := &Server{dataDir: t.TempDir(), token: "t1234567890123456789012345678901", accts: map[string]*Account{}}
	a, err := OpenAccount(s.dataDir, "00000000-0000-4000-8000-000000000005")
	if err != nil {
		t.Fatal(err)
	}
	defer a.Close()
	s.accts[a.ID] = a
	sarah := "15551234567@s.whatsapp.net"
	raw, _ := proto.Marshal(&waE2E.Message{Conversation: proto.String("hi")})
	a.store.SaveMessage(Message{Chat: sarah, ID: "m1", Sender: &sarah, TS: 1000, Type: "conversation", Text: "hi", Raw: raw})
	a.store.SaveMessage(Message{Chat: "123@g.us", ID: "g1", Sender: &sarah, TS: 1000, Type: "conversation", Text: "hi", Raw: raw})
	srv := httptest.NewServer(s.Routes())
	defer srv.Close()
	post := func(body string) (int, string) {
		req, _ := http.NewRequest("POST", srv.URL+"/accounts/"+a.ID+"/reply-private", strings.NewReader(body))
		req.Header.Set("authorization", "Bearer "+s.token)
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer res.Body.Close()
		b, _ := io.ReadAll(res.Body)
		return res.StatusCode, string(b)
	}
	code, msg := post(`{"chat":"15551234567@s.whatsapp.net","message":"m1","text":"ok"}`)
	eq(t, code == 400 && strings.Contains(msg, "isn't in a group"), true)
	// a group message goes to the sender's own chat: here that's a known chat, and the account isn't linked
	code, msg = post(`{"chat":"123@g.us","message":"g1","text":"ok"}`)
	eq(t, code == 409 && strings.Contains(msg, "not linked"), true)
}

func TestFullQuoteFromRaw(t *testing.T) {
	long := strings.Repeat("a", 500)
	raw, _ := proto.Marshal(&waE2E.Message{ExtendedTextMessage: &waE2E.ExtendedTextMessage{Text: proto.String("This one"),
		ContextInfo: &waE2E.ContextInfo{QuotedMessage: &waE2E.Message{Conversation: proto.String(long)}}}})
	cut := long[:300] + "…"
	eq(t, fullQuote(&Message{Quoted: &cut, Raw: raw}), long)
	short := "hi"
	eq(t, fullQuote(&Message{Quoted: &short, Raw: raw}), "hi")
}

func TestPacing(t *testing.T) {
	a, err := OpenAccount(t.TempDir(), "00000000-0000-4000-8000-000000000010")
	if err != nil {
		t.Fatal(err)
	}
	defer a.Close()
	for range AskMinute {
		if err := a.paced("GET /accounts/{id}/profile"); err != nil {
			t.Fatal(err)
		}
	}
	if a.paced("GET /accounts/{id}/profile") == nil {
		t.Fatal("lookups past the minute's limit went through")
	}
	eq(t, a.paced("GET /accounts/{id}/messages"), nil) // saved chats aren't counted
	for range ChangeHour {
		if err := a.paced("POST /accounts/{id}/group/members"); err != nil {
			t.Fatal(err)
		}
	}
	if a.paced("POST /accounts/{id}/group/members") == nil {
		t.Fatal("group changes past the hour's limit went through")
	}
	// WhatsApp says too much: nothing reaches it, saved chats still read, sends wait too
	if a.overlimit(errors.New("info query returned status 429: rate-overlimit")) == nil {
		t.Fatal("rate-overlimit not caught")
	}
	if a.paced("POST /accounts/{id}/send") == nil || a.UnderLimit() == nil {
		t.Fatal("sent while WhatsApp said too much")
	}
	eq(t, a.paced("GET /accounts/{id}/search"), nil)
	// a change drops kept group details
	a.keepGroups(true, &types.GroupInfo{JID: types.NewJID("123", types.GroupServer)})
	a.p.changes, a.p.coolUntil = nil, time.Time{}
	if err := a.change(); err != nil || a.p.groups != nil {
		t.Fatal("kept group details survived a change", err)
	}
}
