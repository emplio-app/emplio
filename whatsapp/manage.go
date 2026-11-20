// More of the HTTP API: replying, editing, deleting, forwarding and pinning messages, polls, checking numbers, what
// happened lately (edits, deletes, reactions, votes, group members), and running groups.
package main

import (
	"net/http"
	"strings"
	"time"

	"go.mau.fi/whatsmeow"
	"go.mau.fi/whatsmeow/proto/waE2E"
	"go.mau.fi/whatsmeow/types"
	"google.golang.org/protobuf/proto"
)

// chatOf is the chat a request names.
func (a *Account) chatOf(v any) (string, error) {
	raw, err := str(v, "chat", 200)
	if err != nil {
		return "", err
	}
	return a.ChatFor(raw)
}

// messageOf is the saved message a request names (chat and message).
func (a *Account) messageOf(chatV, idV any) (*Message, *waE2E.Message, error) {
	chat, err := a.chatOf(chatV)
	if err != nil {
		return nil, nil, err
	}
	id, err := str(idV, "message", 200)
	if err != nil {
		return nil, nil, err
	}
	return a.Raw(chat, id)
}

func strs(v any) []string {
	out := []string{}
	list, _ := v.([]any)
	for _, x := range list {
		if s, ok := x.(string); ok && strings.TrimSpace(s) != "" {
			out = append(out, strings.TrimSpace(s))
		}
	}
	return out
}

// people is phone numbers (or chat ids) as WhatsApp ids; known: only people this account already chats with.
func (a *Account) people(v any, known bool) ([]types.JID, error) {
	list := strs(v)
	if len(list) == 0 || len(list) > 50 {
		return nil, refuse(400, "phones is needed: 1 to 50 phone numbers with country code")
	}
	out := []types.JID{}
	for _, p := range list {
		jid, _ := TargetOf(p)
		j, err := types.ParseJID(jid)
		if jid == "" || err != nil || j.Server != types.DefaultUserServer {
			return nil, refuse(400, "%q isn't a phone number with country code", p)
		}
		if known && !a.Knows(j.String()) {
			return nil, refuse(400, "%s doesn't chat with this WhatsApp yet. Only people it already chats with can be added, so the number isn't flagged; send them the group's invite link instead", p)
		}
		out = append(out, j)
	}
	return out, nil
}

// group is a group chat a request names, with the account connected to act on it.
func (a *Account) group(v any) (types.JID, error) {
	chat, err := a.chatOf(v)
	if err != nil {
		return types.EmptyJID, err
	}
	if !strings.HasSuffix(chat, "@g.us") {
		return types.EmptyJID, refuse(400, "that chat isn't a group")
	}
	if err := a.Ready(false); err != nil {
		return types.EmptyJID, err
	}
	j, _ := types.ParseJID(chat)
	return j, nil
}

func waRefused(what string, err error) error {
	if strings.Contains(err.Error(), "403") || strings.Contains(err.Error(), "forbidden") {
		return refuse(403, "%s: WhatsApp says this account isn't allowed (it may need to be a group admin)", what)
	}
	return refuse(502, "%s: %v", what, err)
}

// withContext puts reply or forward details on a message of any kind.
func withContext(m *waE2E.Message, ci *waE2E.ContextInfo) *waE2E.Message {
	switch {
	case m.Conversation != nil:
		return &waE2E.Message{ExtendedTextMessage: &waE2E.ExtendedTextMessage{Text: m.Conversation, ContextInfo: ci}}
	case m.ExtendedTextMessage != nil:
		m.ExtendedTextMessage.ContextInfo = ci
	case m.ImageMessage != nil:
		m.ImageMessage.ContextInfo = ci
	case m.VideoMessage != nil:
		m.VideoMessage.ContextInfo = ci
	case m.PtvMessage != nil:
		m.PtvMessage.ContextInfo = ci
	case m.AudioMessage != nil:
		m.AudioMessage.ContextInfo = ci
	case m.DocumentMessage != nil:
		m.DocumentMessage.ContextInfo = ci
	case m.StickerMessage != nil:
		m.StickerMessage.ContextInfo = ci
	case m.LocationMessage != nil:
		m.LocationMessage.ContextInfo = ci
	case m.ContactMessage != nil:
		m.ContactMessage.ContextInfo = ci
	}
	return m
}

// replyTo is text sent as a reply to a saved message (it shows quoted above).
func (a *Account) replyTo(q *Message, w *waE2E.Message, text string) *waE2E.Message {
	return &waE2E.Message{ExtendedTextMessage: &waE2E.ExtendedTextMessage{Text: proto.String(text), ContextInfo: &waE2E.ContextInfo{
		StanzaID: proto.String(q.ID), Participant: proto.String(a.senderOf(q).String()), QuotedMessage: unwrap(w),
	}}}
}

// PresentEvent is an event as Emplio sees it.
func (a *Account) PresentEvent(e Event) map[string]any {
	from, fromName := any(nil), any(nil)
	if e.FromMe {
		from, fromName = "me", "me"
	} else if e.Who != "" {
		from = e.Who
		if p := PhoneOf(e.Who); p != nil {
			from = *p
		}
		fromName = strPtr(a.store.NameOf(e.Who))
	}
	out := map[string]any{
		"event": e.ID, "kind": e.Kind, "time": time.UnixMilli(e.TS).UTC().Format(time.RFC3339), "chat": e.Chat, "chat_name": a.ChatName(e.Chat),
		"is_group": strings.HasSuffix(e.Chat, "@g.us"), "from": from, "from_name": fromName, "from_me": e.FromMe, "text": e.Text,
	}
	if e.Message != "" {
		out["message"] = e.Message
	}
	if strings.HasPrefix(e.Text, "by ") {
		if p := PhoneOf(strings.TrimPrefix(e.Text, "by ")); p != nil {
			out["text"] = "by " + *p
		}
	}
	return out
}

var timers = map[string]time.Duration{"off": 0, "24h": whatsmeow.DisappearingTimer24Hours, "7d": whatsmeow.DisappearingTimer7Days, "90d": whatsmeow.DisappearingTimer90Days}

func (s *Server) manageRoutes(mux *http.ServeMux) {
	post := func(path string, fn func(a *Account, b map[string]any) (any, error)) {
		mux.HandleFunc("POST /accounts/{id}/"+path, s.acct(func(a *Account, r *http.Request) (any, error) {
			b, err := body(r)
			if err != nil {
				return nil, err
			}
			return fn(a, b)
		}))
	}

	post("reply", func(a *Account, b map[string]any) (any, error) {
		q, w, err := a.messageOf(b["chat"], b["message"])
		if err != nil {
			return nil, err
		}
		text, err := str(b["text"], "text", 65000)
		if err != nil {
			return nil, err
		}
		return a.Send(q.Chat, a.replyTo(q, w, text))
	})
	mux.HandleFunc("GET /accounts/{id}/message", s.acct(func(a *Account, r *http.Request) (any, error) {
		q := r.URL.Query()
		m, _, err := a.messageOf(q.Get("chat"), q.Get("message"))
		if err != nil {
			return nil, err
		}
		out := a.Present(*m)
		named := func(pairs [][2]string, key string) []map[string]any {
			list := []map[string]any{}
			for _, p := range pairs {
				who := any(p[0])
				if ph := PhoneOf(p[0]); ph != nil {
					who = *ph
				}
				list = append(list, map[string]any{"from": who, "from_name": strPtr(a.store.NameOf(p[0])), key: p[1]})
			}
			return list
		}
		out["reactions"] = named(a.store.Marks("reactions", m.Chat, m.ID), "emoji")
		if m.Type == "pollCreation" {
			out["votes"] = named(a.store.Marks("votes", m.Chat, m.ID), "options")
		}
		return out, nil
	}))
	post("edit", func(a *Account, b map[string]any) (any, error) {
		m, _, err := a.messageOf(b["chat"], b["message"])
		if err != nil {
			return nil, err
		}
		text, err := str(b["text"], "text", 65000)
		if err != nil {
			return nil, err
		}
		if !m.FromMe {
			return nil, refuse(400, "only messages sent from this WhatsApp can be edited")
		}
		if m.Type != "conversation" && m.Type != "extendedText" {
			// ponytail: text only; captions on photos and files could be edited too, add when asked
			return nil, refuse(400, "only text messages can be edited")
		}
		if time.Since(time.UnixMilli(m.TS)) > whatsmeow.EditWindow {
			return nil, refuse(400, "WhatsApp only lets a message be edited for 20 minutes after it was sent")
		}
		if err := a.Ready(false); err != nil {
			return nil, err
		}
		jid, _ := types.ParseJID(m.Chat)
		if _, err := a.Send(m.Chat, a.client().BuildEdit(jid, m.ID, &waE2E.Message{Conversation: proto.String(text)})); err != nil {
			return nil, err
		}
		return a.Present(*a.store.GetMessage(m.Chat, m.ID)), nil
	})
	post("delete", func(a *Account, b map[string]any) (any, error) {
		m, _, err := a.messageOf(b["chat"], b["message"])
		if err != nil {
			return nil, err
		}
		if !m.FromMe && !strings.HasSuffix(m.Chat, "@g.us") {
			return nil, refuse(400, "only messages sent from this WhatsApp can be deleted for everyone (or anyone's, in a group where it's an admin)")
		}
		if err := a.Ready(false); err != nil {
			return nil, err
		}
		jid, _ := types.ParseJID(m.Chat)
		sender := types.EmptyJID
		if !m.FromMe {
			sender = a.senderOf(m)
		}
		if _, err := a.Send(m.Chat, a.client().BuildRevoke(jid, sender, m.ID)); err != nil {
			return nil, err
		}
		return map[string]any{"ok": true, "deleted": m.ID}, nil
	})
	post("forward", func(a *Account, b map[string]any) (any, error) {
		_, w, err := a.messageOf(b["chat"], b["message"])
		if err != nil {
			return nil, err
		}
		to, err := str(b["to"], "to", 200)
		if err != nil {
			return nil, err
		}
		dest, err := a.ChatFor(to)
		if err != nil {
			return nil, err
		}
		if _, _, ok := TextOf(w); !ok {
			return nil, refuse(400, "that message can't be forwarded")
		}
		fwd := proto.Clone(unwrap(w)).(*waE2E.Message)
		fwd.MessageContextInfo = nil
		return a.Send(dest, withContext(fwd, &waE2E.ContextInfo{IsForwarded: proto.Bool(true), ForwardingScore: proto.Uint32(1)}))
	})
	post("pin", func(a *Account, b map[string]any) (any, error) {
		m, _, err := a.messageOf(b["chat"], b["message"])
		if err != nil {
			return nil, err
		}
		pin := b["pin"] != false
		days, _ := b["days"].(float64)
		if days != 1 && days != 7 {
			days = 30
		}
		if err := a.Ready(false); err != nil {
			return nil, err
		}
		jid, _ := types.ParseJID(m.Chat)
		typ := waE2E.PinInChatMessage_PIN_FOR_ALL
		if !pin {
			typ = waE2E.PinInChatMessage_UNPIN_FOR_ALL
		}
		msg := &waE2E.Message{
			PinInChatMessage:   &waE2E.PinInChatMessage{Key: a.client().BuildMessageKey(jid, a.senderOf(m), m.ID), Type: typ.Enum(), SenderTimestampMS: proto.Int64(time.Now().UnixMilli())},
			MessageContextInfo: &waE2E.MessageContextInfo{MessageAddOnDurationInSecs: proto.Uint32(uint32(days) * 86400)},
		}
		if _, err := a.Send(m.Chat, msg); err != nil {
			return nil, err
		}
		return map[string]any{"ok": true, "pinned": pin}, nil
	})
	post("poll", func(a *Account, b map[string]any) (any, error) {
		to, err := str(b["to"], "to", 200)
		if err != nil {
			return nil, err
		}
		question, err := str(b["question"], "question", 255)
		if err != nil {
			return nil, err
		}
		options := strs(b["options"])
		if len(options) < 2 || len(options) > 12 {
			return nil, refuse(400, "options: 2 to 12 choices")
		}
		chat, err := a.ChatFor(to)
		if err != nil {
			return nil, err
		}
		pick := 1
		if b["multiple"] == true {
			pick = 0
		}
		if err := a.CheckSend(chat); err != nil {
			return nil, err
		}
		if err := a.Ready(false); err != nil {
			return nil, err
		}
		return a.Send(chat, a.client().BuildPollCreation(question, options, pick))
	})
	post("check", func(a *Account, b map[string]any) (any, error) {
		jids, err := a.people(b["phones"], false)
		if err != nil {
			return nil, err
		}
		if err := a.Ready(false); err != nil {
			return nil, err
		}
		phones := []string{}
		for _, j := range jids {
			phones = append(phones, "+"+j.User)
		}
		res, err := a.client().IsOnWhatsApp(bg, phones)
		if err != nil {
			return nil, refuse(502, "WhatsApp didn't answer: %v", err)
		}
		out := []map[string]any{}
		for _, r := range res {
			row := map[string]any{"phone": r.Query, "on_whatsapp": r.IsIn}
			if r.IsIn {
				// by number, like every other chat id here (WhatsApp answers with a hidden @lid id now)
				row["chat"] = types.NewJID(strings.TrimPrefix(r.Query, "+"), types.DefaultUserServer).String()
				if r.VerifiedName != nil && r.VerifiedName.Details != nil {
					row["business_name"] = r.VerifiedName.Details.GetVerifiedName()
				}
			}
			out = append(out, row)
		}
		return map[string]any{"numbers": out}, nil
	})
	mux.HandleFunc("GET /accounts/{id}/events", s.acct(func(a *Account, r *http.Request) (any, error) {
		note := readNote(a)
		q := r.URL.Query()
		after := timeMs(q.Get("after"))
		if after == 0 {
			after = time.Now().Add(-3 * time.Hour).UnixMilli()
		}
		kinds := []string{}
		for _, k := range strings.Split(q.Get("kinds"), ",") {
			if k = strings.TrimSpace(k); k != "" {
				kinds = append(kinds, k)
			}
		}
		out := []map[string]any{}
		for _, e := range a.store.Events(after, kinds, num(q.Get("limit"), 200, 1000)) {
			out = append(out, a.PresentEvent(e))
		}
		return withNote(map[string]any{"events": out}, note), nil
	}))

	// --- groups ---
	post("groups", func(a *Account, b map[string]any) (any, error) {
		name, err := str(b["name"], "name", 100)
		if err != nil {
			return nil, err
		}
		people, err := a.people(b["phones"], true)
		if err != nil {
			return nil, err
		}
		if err := a.UnderLimit(); err != nil {
			return nil, err
		}
		if err := a.Ready(false); err != nil {
			return nil, err
		}
		g, err := a.client().CreateGroup(bg, whatsmeow.ReqCreateGroup{Name: name, Participants: people})
		if err != nil {
			return nil, waRefused("couldn't make the group", err)
		}
		a.store.NoteSend()
		a.store.Chat(g.JID.String(), g.Name, time.Now().UnixMilli(), -1)
		return map[string]any{"chat": g.JID.String(), "name": g.Name, "members": a.outcomes(g.Participants)}, nil
	})
	post("group/members", func(a *Account, b map[string]any) (any, error) {
		action, _ := b["action"].(string)
		change := map[string]whatsmeow.ParticipantChange{"add": whatsmeow.ParticipantChangeAdd, "remove": whatsmeow.ParticipantChangeRemove, "promote": whatsmeow.ParticipantChangePromote, "demote": whatsmeow.ParticipantChangeDemote}[action]
		if change == "" {
			return nil, refuse(400, "action: add, remove, promote or demote")
		}
		people, err := a.people(b["phones"], change == whatsmeow.ParticipantChangeAdd)
		if err != nil {
			return nil, err
		}
		if change == whatsmeow.ParticipantChangeAdd {
			if err := a.UnderLimit(); err != nil {
				return nil, err
			}
		}
		jid, err := a.group(b["chat"])
		if err != nil {
			return nil, err
		}
		res, err := a.client().UpdateGroupParticipants(bg, jid, people, change)
		if err != nil {
			return nil, waRefused("WhatsApp didn't make the change", err)
		}
		if change == whatsmeow.ParticipantChangeAdd {
			a.store.NoteSend()
		}
		return map[string]any{"chat": jid.String(), "members": a.outcomes(res)}, nil
	})
	post("group/settings", func(a *Account, b map[string]any) (any, error) {
		jid, err := a.group(b["chat"])
		if err != nil {
			return nil, err
		}
		cli, changed := a.client(), []string{}
		if name, _ := b["name"].(string); strings.TrimSpace(name) != "" {
			if err := cli.SetGroupName(bg, jid, strings.TrimSpace(name)); err != nil {
				return nil, waRefused("couldn't rename the group", err)
			}
			a.store.Chat(jid.String(), strings.TrimSpace(name), 0, -1)
			changed = append(changed, "name")
		}
		if d, ok := b["description"].(string); ok {
			if err := cli.SetGroupTopic(bg, jid, "", "", d); err != nil {
				return nil, waRefused("couldn't change the description", err)
			}
			changed = append(changed, "description")
		}
		if v, ok := b["only_admins_send"].(bool); ok {
			if err := cli.SetGroupAnnounce(bg, jid, v); err != nil {
				return nil, waRefused("couldn't change who can send", err)
			}
			changed = append(changed, "only_admins_send")
		}
		if v, ok := b["only_admins_edit"].(bool); ok {
			if err := cli.SetGroupLocked(bg, jid, v); err != nil {
				return nil, waRefused("couldn't change who can edit the group's details", err)
			}
			changed = append(changed, "only_admins_edit")
		}
		if v, ok := b["disappearing"].(string); ok {
			d, known := timers[v]
			if !known {
				return nil, refuse(400, "disappearing: off, 24h, 7d or 90d")
			}
			if err := cli.SetDisappearingTimer(bg, jid, d, time.Now()); err != nil {
				return nil, waRefused("couldn't change disappearing messages", err)
			}
			changed = append(changed, "disappearing")
		}
		if len(changed) == 0 {
			return nil, refuse(400, "nothing to change: give name, description, only_admins_send, only_admins_edit or disappearing")
		}
		return map[string]any{"ok": true, "changed": changed}, nil
	})
	mux.HandleFunc("GET /accounts/{id}/group/invite", s.acct(func(a *Account, r *http.Request) (any, error) {
		q := r.URL.Query()
		jid, err := a.group(q.Get("chat"))
		if err != nil {
			return nil, err
		}
		link, err := a.client().GetGroupInviteLink(bg, jid, q.Get("reset") == "true")
		if err != nil {
			return nil, waRefused("couldn't get the invite link", err)
		}
		return map[string]any{"chat": jid.String(), "link": link}, nil
	}))
	post("group/join", func(a *Account, b map[string]any) (any, error) {
		link, err := str(b["link"], "link", 300)
		if err != nil {
			return nil, err
		}
		code := link[strings.LastIndex(link, "/")+1:]
		if err := a.Ready(false); err != nil {
			return nil, err
		}
		jid, err := a.client().JoinGroupWithLink(bg, code)
		if err != nil {
			return nil, refuse(400, "couldn't join with that link (it may be wrong, reset or expired): %v", err)
		}
		name := ""
		if g, err := a.client().GetGroupInfo(bg, jid); err == nil {
			name = g.Name
		}
		a.store.Chat(jid.String(), name, time.Now().UnixMilli(), -1)
		return map[string]any{"chat": jid.String(), "name": name}, nil
	})
	post("group/leave", func(a *Account, b map[string]any) (any, error) {
		jid, err := a.group(b["chat"])
		if err != nil {
			return nil, err
		}
		if err := a.client().LeaveGroup(bg, jid); err != nil {
			return nil, waRefused("couldn't leave the group", err)
		}
		return map[string]any{"ok": true, "left": jid.String()}, nil
	})
}

// outcomes is how a change went for each person in it.
func (a *Account) outcomes(ps []types.GroupParticipant) []map[string]any {
	out := []map[string]any{}
	for _, p := range ps {
		j := a.canon(p.JID, p.PhoneNumber).String()
		row := map[string]any{"phone": PhoneOf(j), "name": strPtr(a.store.NameOf(j)), "ok": p.Error == 0}
		if p.Error != 0 {
			row["problem"] = "WhatsApp didn't make the change for them"
			if p.AddRequest != nil || p.Error == 403 {
				row["problem"] = "their privacy settings don't let others add them; send them the group's invite link"
			}
		}
		out = append(out, row)
	}
	return out
}
