// The rest of what WhatsApp lets a linked device do, on top of main.go and manage.go: replying privately to someone
// in a group, locations and contact cards, poll votes, stars, older history, chat housekeeping (mute, archive, pin,
// unread, delete, disappearing, labels), group photos, join requests and communities, people's profiles and blocking,
// privacy and the account's own profile, status updates, and channels.
package main

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"image"
	_ "image/gif"
	"image/jpeg"
	_ "image/png"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"time"

	"go.mau.fi/whatsmeow"
	"go.mau.fi/whatsmeow/appstate"
	"go.mau.fi/whatsmeow/proto/waCommon"
	"go.mau.fi/whatsmeow/proto/waE2E"
	"go.mau.fi/whatsmeow/types"
	"go.mau.fi/whatsmeow/types/events"
	"google.golang.org/protobuf/proto"
)

// kindOf is what kind of WhatsApp message a file of this type goes as.
func kindOf(typ string) whatsmeow.MediaType {
	switch {
	case strings.HasPrefix(typ, "image/") && !strings.Contains(typ, "svg"):
		return whatsmeow.MediaImage
	case strings.HasPrefix(typ, "video/"):
		return whatsmeow.MediaVideo
	case strings.HasPrefix(typ, "audio/"):
		return whatsmeow.MediaAudio
	}
	return whatsmeow.MediaDocument
}

// fileOf is a file sent in a request (base64 data, its type and name); ok false when none was sent.
func fileOf(b map[string]any) (data []byte, typ, name string, ok bool, err error) {
	enc, _ := b["data"].(string)
	if enc == "" {
		return nil, "", "", false, nil
	}
	if data, err = base64.StdEncoding.DecodeString(enc); err != nil {
		return nil, "", "", false, refuse(400, "data must be base64")
	}
	typ, _ = b["type"].(string)
	if typ == "" {
		typ = "application/octet-stream"
	}
	name, _ = b["name"].(string)
	if name == "" {
		name = "file"
	}
	return data, typ, name, true, nil
}

// squareJPEG makes a photo what WhatsApp takes for a profile or group picture: a square JPEG, at most 640 pixels.
func squareJPEG(data []byte) ([]byte, error) {
	img, _, err := image.Decode(bytes.NewReader(data))
	if err != nil {
		return nil, refuse(400, "that isn't a photo WhatsApp can use (JPEG, PNG or GIF)")
	}
	r := img.Bounds()
	side := min(r.Dx(), r.Dy())
	x0, y0 := r.Min.X+(r.Dx()-side)/2, r.Min.Y+(r.Dy()-side)/2
	out := min(side, 640)
	// ponytail: nearest-neighbour scaling; fine for a 640px avatar, use x/image/draw if it ever looks rough
	dst := image.NewRGBA(image.Rect(0, 0, out, out))
	for y := range out {
		for x := range out {
			dst.Set(x, y, img.At(x0+x*side/out, y0+y*side/out))
		}
	}
	var buf bytes.Buffer
	if err := jpeg.Encode(&buf, dst, &jpeg.Options{Quality: 85}); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

// vcard is a contact card for one person.
func vcard(name, phone string) string {
	clean := strings.NewReplacer("\n", " ", "\r", " ", ";", " ").Replace(name)
	return fmt.Sprintf("BEGIN:VCARD\nVERSION:3.0\nFN:%s\nTEL;type=CELL;waid=%s:+%s\nEND:VCARD", clean, phone, phone)
}

// pollOptions is the choices of a saved poll.
func pollOptions(poll *waE2E.Message) []string {
	m := unwrap(poll)
	p := m.GetPollCreationMessage()
	if p == nil {
		p = m.GetPollCreationMessageV2()
	}
	if p == nil {
		p = m.GetPollCreationMessageV3()
	}
	out := []string{}
	for _, o := range p.GetOptions() {
		out = append(out, o.GetOptionName())
	}
	return out
}

// lastOf is a chat's latest saved message, as WhatsApp's chat-list changes (archive, delete, unread) want it.
func (a *Account) lastOf(chat string) (time.Time, *waCommon.MessageKey) {
	ms := a.store.Messages(chat, 1, 0, 0)
	cli := a.client()
	if len(ms) == 0 || cli == nil {
		return time.Time{}, nil
	}
	m := ms[0]
	j, _ := types.ParseJID(chat)
	return time.UnixMilli(m.TS), cli.BuildMessageKey(j, a.senderOf(&m), m.ID)
}

// patch changes something in the phone's chat list or settings (WhatsApp's "app state"), seen on every device.
func (a *Account) patch(what string, p appstate.PatchInfo) error {
	if err := a.client().SendAppState(bg, p); err != nil {
		return waRefused(what, err)
	}
	return nil
}

// readyChat is the chat a request names, with the account connected to act on it.
func (a *Account) readyChat(v any) (types.JID, error) {
	chat, err := a.chatOf(v)
	if err != nil {
		return types.EmptyJID, err
	}
	if err := a.Ready(false); err != nil {
		return types.EmptyJID, err
	}
	j, _ := types.ParseJID(chat)
	return j, nil
}

// --- labels (WhatsApp Business) ---

// Label is a WhatsApp Business label, with the chats that have it.
type Label struct {
	ID      string   `json:"id"`
	Name    string   `json:"name"`
	Color   int32    `json:"color"`
	Deleted bool     `json:"deleted,omitempty"`
	Chats   []string `json:"chats"`
}

func (a *Account) labels() map[string]*Label {
	out := map[string]*Label{}
	json.Unmarshal([]byte(a.store.Get("labels")), &out)
	return out
}

func (a *Account) saveLabels(ls map[string]*Label) {
	b, _ := json.Marshal(ls)
	a.store.Set("labels", string(b))
}

// onLabel keeps the labels and which chats have them as the phone reports them.
func (a *Account) onLabel(evt any) {
	a.labelMu.Lock()
	defer a.labelMu.Unlock()
	ls := a.labels()
	get := func(id string) *Label {
		if ls[id] == nil {
			ls[id] = &Label{ID: id, Chats: []string{}}
		}
		return ls[id]
	}
	switch e := evt.(type) {
	case *events.LabelEdit:
		l := get(e.LabelID)
		l.Name, l.Color, l.Deleted = e.Action.GetName(), e.Action.GetColor(), e.Action.GetDeleted()
	case *events.LabelAssociationChat:
		l := get(e.LabelID)
		chat := a.canon(e.JID, types.EmptyJID).String()
		kept := []string{}
		for _, c := range l.Chats {
			if c != chat {
				kept = append(kept, c)
			}
		}
		if e.Action.GetLabeled() {
			kept = append(kept, chat)
		}
		l.Chats = kept
	default:
		return
	}
	a.saveLabels(ls)
}

// labelFor is the label a request names, by id or name.
func (a *Account) labelFor(v any) (*Label, error) {
	want, err := str(v, "label", 100)
	if err != nil {
		return nil, err
	}
	for _, l := range a.labels() {
		if !l.Deleted && (l.ID == want || strings.EqualFold(l.Name, want)) {
			return l, nil
		}
	}
	return nil, refuse(404, "no label %q; list_labels shows them (labels are a WhatsApp Business feature)", want)
}

// --- channels ---

// channelOf is the channel a request names: its id (…@newsletter) or invite link (whatsapp.com/channel/…).
func (a *Account) channelOf(v any) (types.JID, error) {
	raw, err := str(v, "channel", 300)
	if err != nil {
		return types.EmptyJID, err
	}
	if err := a.Ready(false); err != nil {
		return types.EmptyJID, err
	}
	if i := strings.Index(raw, "/channel/"); i >= 0 {
		meta, err := a.client().GetNewsletterInfoWithInvite(bg, strings.Trim(raw[i+len("/channel/"):], "/ "))
		if err != nil {
			return types.EmptyJID, refuse(404, "couldn't find that channel: %v", err)
		}
		return meta.ID, nil
	}
	j, err := types.ParseJID(raw)
	if err != nil || j.Server != types.NewsletterServer {
		return types.EmptyJID, refuse(400, "channel: its id (ending @newsletter, from list_channels) or its link (whatsapp.com/channel/...)")
	}
	return j, nil
}

func presentChannel(m *types.NewsletterMetadata) map[string]any {
	t := m.ThreadMeta
	out := map[string]any{
		"channel": m.ID.String(), "name": t.Name.Text, "description": t.Description.Text, "followers": t.SubscriberCount,
		"verified": t.VerificationState == types.NewsletterVerificationStateVerified, "state": string(m.State.Type),
	}
	if t.InviteCode != "" {
		out["link"] = "https://whatsapp.com/channel/" + t.InviteCode
	}
	if m.ViewerMeta != nil {
		out["role"], out["muted"] = string(m.ViewerMeta.Role), m.ViewerMeta.Mute == types.NewsletterMuteOn
	}
	return out
}

var muteFor = map[string]time.Duration{"8h": 8 * time.Hour, "1w": 7 * 24 * time.Hour, "always": 0}

var privacyValues = map[string]struct {
	typ  types.PrivacySettingType
	vals []string
}{
	"last_seen":     {types.PrivacySettingTypeLastSeen, []string{"all", "contacts", "contact_blacklist", "none"}},
	"online":        {types.PrivacySettingTypeOnline, []string{"all", "match_last_seen"}},
	"profile_photo": {types.PrivacySettingTypeProfile, []string{"all", "contacts", "contact_blacklist", "none"}},
	"about":         {types.PrivacySettingTypeStatus, []string{"all", "contacts", "contact_blacklist", "none"}},
	"read_receipts": {types.PrivacySettingTypeReadReceipts, []string{"all", "none"}},
	"groups":        {types.PrivacySettingTypeGroupAdd, []string{"all", "contacts", "contact_blacklist", "none"}},
	"calls":         {types.PrivacySettingTypeCallAdd, []string{"all", "known"}},
	"messages":      {types.PrivacySettingTypeMessages, []string{"all", "contacts"}},
}

func presentPrivacy(p types.PrivacySettings) map[string]any {
	return map[string]any{
		"last_seen": p.LastSeen, "online": p.Online, "profile_photo": p.Profile, "about": p.Status, "read_receipts": p.ReadReceipts,
		"groups": p.GroupAdd, "calls": p.CallAdd, "messages": p.Messages,
	}
}

func (s *Server) moreRoutes(mux *http.ServeMux) {
	post := func(path string, fn func(a *Account, b map[string]any) (any, error)) {
		mux.HandleFunc("POST /accounts/{id}/"+path, s.acct(func(a *Account, r *http.Request) (any, error) {
			b, err := body(r)
			if err != nil {
				return nil, err
			}
			return fn(a, b)
		}))
	}
	get := func(path string, fn func(a *Account, q map[string]string) (any, error)) {
		mux.HandleFunc("GET /accounts/{id}/"+path, s.acct(func(a *Account, r *http.Request) (any, error) {
			q := map[string]string{}
			for k, v := range r.URL.Query() {
				q[k] = v[0]
			}
			return fn(a, q)
		}))
	}

	// --- messages ---

	// what WhatsApp's "Reply privately" does: the reply goes to the sender's own chat, quoting their group message
	post("reply-private", func(a *Account, b map[string]any) (any, error) {
		q, w, err := a.messageOf(b["chat"], b["message"])
		if err != nil {
			return nil, err
		}
		text, err := str(b["text"], "text", 65000)
		if err != nil {
			return nil, err
		}
		if !strings.HasSuffix(q.Chat, "@g.us") {
			return nil, refuse(400, "that message isn't in a group; use reply_to_message to answer it in its chat")
		}
		if q.FromMe || q.Sender == nil {
			return nil, refuse(400, "that's this WhatsApp's own message")
		}
		msg := a.replyTo(q, w, text)
		msg.ExtendedTextMessage.ContextInfo.RemoteJID = proto.String(q.Chat)
		return a.Send(*q.Sender, msg)
	})
	post("location", func(a *Account, b map[string]any) (any, error) {
		to, err := str(b["to"], "to", 200)
		if err != nil {
			return nil, err
		}
		lat, ok1 := b["latitude"].(float64)
		lng, ok2 := b["longitude"].(float64)
		if !ok1 || !ok2 || lat < -90 || lat > 90 || lng < -180 || lng > 180 {
			return nil, refuse(400, "latitude (-90 to 90) and longitude (-180 to 180) are needed")
		}
		chat, err := a.ChatFor(to)
		if err != nil {
			return nil, err
		}
		loc := &waE2E.LocationMessage{DegreesLatitude: proto.Float64(lat), DegreesLongitude: proto.Float64(lng)}
		if n, _ := b["name"].(string); n != "" {
			loc.Name = proto.String(n)
		}
		if ad, _ := b["address"].(string); ad != "" {
			loc.Address = proto.String(ad)
		}
		return a.Send(chat, &waE2E.Message{LocationMessage: loc})
	})
	post("contact-card", func(a *Account, b map[string]any) (any, error) {
		to, err := str(b["to"], "to", 200)
		if err != nil {
			return nil, err
		}
		name, err := str(b["name"], "name", 200)
		if err != nil {
			return nil, err
		}
		phone, err := str(b["phone"], "phone", 30)
		if err != nil {
			return nil, err
		}
		digits := strings.TrimPrefix(nonDigits.ReplaceAllString(phone, ""), "00")
		if len(digits) < 8 {
			return nil, refuse(400, "phone: the number with its country code")
		}
		chat, err := a.ChatFor(to)
		if err != nil {
			return nil, err
		}
		return a.Send(chat, &waE2E.Message{ContactMessage: &waE2E.ContactMessage{DisplayName: proto.String(name), Vcard: proto.String(vcard(name, digits))}})
	})
	post("vote", func(a *Account, b map[string]any) (any, error) {
		m, w, err := a.messageOf(b["chat"], b["message"])
		if err != nil {
			return nil, err
		}
		if m.Type != "pollCreation" {
			return nil, refuse(400, "that message isn't a poll")
		}
		picked := strs(b["options"])
		have := pollOptions(w)
		for _, p := range picked {
			found := false
			for _, o := range have {
				found = found || o == p
			}
			if !found {
				return nil, refuse(400, "%q isn't one of the poll's choices: %s", p, strings.Join(have, ", "))
			}
		}
		if err := a.Ready(false); err != nil {
			return nil, err
		}
		jid, _ := types.ParseJID(m.Chat)
		info := &types.MessageInfo{MessageSource: types.MessageSource{Chat: jid, Sender: a.senderOf(m), IsFromMe: m.FromMe, IsGroup: jid.Server == types.GroupServer}, ID: m.ID}
		vote, err := a.client().BuildPollVote(bg, info, picked)
		if err != nil {
			return nil, refuse(400, "can't vote in that poll (only polls that arrived after WhatsApp was linked): %v", err)
		}
		if _, err := a.Send(m.Chat, vote); err != nil {
			return nil, err
		}
		a.store.Vote(m.Chat, m.ID, a.senderOf(&Message{FromMe: true}).String(), strings.Join(picked, ", "), time.Now().UnixMilli())
		return map[string]any{"ok": true, "voted": picked}, nil
	})
	post("star", func(a *Account, b map[string]any) (any, error) {
		m, _, err := a.messageOf(b["chat"], b["message"])
		if err != nil {
			return nil, err
		}
		if err := a.Ready(false); err != nil {
			return nil, err
		}
		star := b["starred"] != false
		jid, _ := types.ParseJID(m.Chat)
		if err := a.patch("couldn't star it", appstate.BuildStar(jid, a.senderOf(m), m.ID, m.FromMe, star)); err != nil {
			return nil, err
		}
		return map[string]any{"ok": true, "starred": star}, nil
	})
	// older messages than were copied over when linking, asked of the phone (it has to be online)
	post("history", func(a *Account, b map[string]any) (any, error) {
		jid, err := a.readyChat(b["chat"])
		if err != nil {
			return nil, err
		}
		chat := jid.String()
		oldest := a.store.Oldest(chat)
		if oldest == nil {
			return nil, refuse(404, "nothing saved in that chat yet to go back from")
		}
		count := 50
		if n, ok := b["count"].(float64); ok && n >= 1 && n <= 200 {
			count = int(n)
		}
		info := &types.MessageInfo{MessageSource: types.MessageSource{Chat: jid, Sender: a.senderOf(oldest), IsFromMe: oldest.FromMe, IsGroup: jid.Server == types.GroupServer}, ID: oldest.ID, Timestamp: time.UnixMilli(oldest.TS)}
		if _, err := a.client().SendPeerMessage(bg, a.client().BuildHistorySyncRequest(info, count)); err != nil {
			return nil, refuse(502, "couldn't ask the phone for older messages: %v", err)
		}
		for until := time.Now().Add(20 * time.Second); time.Now().Before(until); time.Sleep(500 * time.Millisecond) {
			if o := a.store.Oldest(chat); o != nil && o.TS < oldest.TS {
				got := a.store.Messages(chat, 1000, oldest.TS, 0)
				return map[string]any{"loaded": len(got), "from": time.UnixMilli(o.TS).UTC().Format(time.RFC3339), "until": time.UnixMilli(oldest.TS).UTC().Format(time.RFC3339)}, nil
			}
		}
		return map[string]any{"loaded": 0, "note": "the phone didn't send older messages within 20 seconds: it may be offline, or there are none; try again later"}, nil
	})

	// --- chats ---
	post("chat/mute", func(a *Account, b map[string]any) (any, error) {
		jid, err := a.readyChat(b["chat"])
		if err != nil {
			return nil, err
		}
		mute := b["mute"] != false
		f, _ := b["for"].(string)
		if f == "" {
			f = "always"
		}
		d, ok := muteFor[f]
		if !ok {
			return nil, refuse(400, "for: 8h, 1w or always")
		}
		if err := a.patch("couldn't mute it", appstate.BuildMute(jid, mute, d)); err != nil {
			return nil, err
		}
		return map[string]any{"ok": true, "muted": mute}, nil
	})
	post("chat/archive", func(a *Account, b map[string]any) (any, error) {
		jid, err := a.readyChat(b["chat"])
		if err != nil {
			return nil, err
		}
		archive := b["archive"] != false
		ts, key := a.lastOf(jid.String())
		if err := a.patch("couldn't archive it", appstate.BuildArchive(jid, archive, ts, key)); err != nil {
			return nil, err
		}
		return map[string]any{"ok": true, "archived": archive}, nil
	})
	post("chat/pin", func(a *Account, b map[string]any) (any, error) {
		jid, err := a.readyChat(b["chat"])
		if err != nil {
			return nil, err
		}
		pin := b["pin"] != false
		if err := a.patch("couldn't pin it (WhatsApp allows 3 pinned chats)", appstate.BuildPin(jid, pin)); err != nil {
			return nil, err
		}
		return map[string]any{"ok": true, "pinned": pin}, nil
	})
	post("chat/unread", func(a *Account, b map[string]any) (any, error) {
		jid, err := a.readyChat(b["chat"])
		if err != nil {
			return nil, err
		}
		ts, key := a.lastOf(jid.String())
		if err := a.patch("couldn't mark it unread", appstate.BuildMarkChatAsRead(jid, false, ts, key)); err != nil {
			return nil, err
		}
		return map[string]any{"ok": true}, nil
	})
	post("chat/delete", func(a *Account, b map[string]any) (any, error) {
		jid, err := a.readyChat(b["chat"])
		if err != nil {
			return nil, err
		}
		ts, key := a.lastOf(jid.String())
		if err := a.patch("couldn't delete the chat", appstate.BuildDeleteChat(jid, ts, key, true)); err != nil {
			return nil, err
		}
		a.store.DeleteChat(jid.String())
		return map[string]any{"ok": true, "deleted": jid.String()}, nil
	})
	post("chat/disappearing", func(a *Account, b map[string]any) (any, error) {
		jid, err := a.readyChat(b["chat"])
		if err != nil {
			return nil, err
		}
		v, _ := b["disappearing"].(string)
		d, ok := timers[v]
		if !ok {
			return nil, refuse(400, "disappearing: off, 24h, 7d or 90d")
		}
		if err := a.client().SetDisappearingTimer(bg, jid, d, time.Now()); err != nil {
			return nil, waRefused("couldn't change disappearing messages", err)
		}
		return map[string]any{"ok": true, "disappearing": v}, nil
	})

	// --- labels ---
	get("labels", func(a *Account, q map[string]string) (any, error) {
		note := readNote(a)
		if note == "" && a.store.Get("labels_synced") == "" {
			// labels the phone had before this was added: fetched once in full
			if err := a.client().FetchAppState(bg, appstate.WAPatchRegular, true, false); err == nil {
				a.store.Set("labels_synced", "1")
			}
		}
		out := []map[string]any{}
		for _, l := range a.labels() {
			if l.Deleted {
				continue
			}
			chats := []map[string]any{}
			for _, c := range l.Chats {
				chats = append(chats, map[string]any{"chat": c, "name": a.ChatName(c)})
			}
			out = append(out, map[string]any{"id": l.ID, "name": l.Name, "color": l.Color, "chats": chats})
		}
		sort.Slice(out, func(i, j int) bool { return out[i]["name"].(string) < out[j]["name"].(string) })
		return withNote(map[string]any{"labels": out}, note), nil
	})
	post("label", func(a *Account, b map[string]any) (any, error) {
		if err := a.Ready(false); err != nil {
			return nil, err
		}
		color := int32(0)
		if c, ok := b["color"].(float64); ok && c >= 0 && c <= 19 {
			color = int32(c)
		}
		if b["delete"] == true {
			l, err := a.labelFor(b["label"])
			if err != nil {
				return nil, err
			}
			if err := a.patch("couldn't delete the label", appstate.BuildLabelEdit(l.ID, l.Name, l.Color, true)); err != nil {
				return nil, err
			}
			return map[string]any{"ok": true, "deleted": l.Name}, nil
		}
		name, err := str(b["name"], "name", 100)
		if err != nil {
			return nil, err
		}
		id := ""
		if b["label"] != nil {
			l, err := a.labelFor(b["label"])
			if err != nil {
				return nil, err
			}
			id = l.ID
			if _, ok := b["color"].(float64); !ok {
				color = l.Color
			}
		} else {
			next := 1
			for k := range a.labels() {
				if n, err := strconv.Atoi(k); err == nil && n >= next {
					next = n + 1
				}
			}
			id = strconv.Itoa(next)
		}
		if err := a.patch("couldn't save the label", appstate.BuildLabelEdit(id, name, color, false)); err != nil {
			return nil, err
		}
		return map[string]any{"ok": true, "id": id, "name": name}, nil
	})
	post("chat/label", func(a *Account, b map[string]any) (any, error) {
		jid, err := a.readyChat(b["chat"])
		if err != nil {
			return nil, err
		}
		l, err := a.labelFor(b["label"])
		if err != nil {
			return nil, err
		}
		on := b["on"] != false
		if err := a.patch("couldn't label the chat", appstate.BuildLabelChat(jid, l.ID, on)); err != nil {
			return nil, err
		}
		return map[string]any{"ok": true, "label": l.Name, "labeled": on}, nil
	})
	post("message/label", func(a *Account, b map[string]any) (any, error) {
		m, _, err := a.messageOf(b["chat"], b["message"])
		if err != nil {
			return nil, err
		}
		if err := a.Ready(false); err != nil {
			return nil, err
		}
		l, err := a.labelFor(b["label"])
		if err != nil {
			return nil, err
		}
		on := b["on"] != false
		jid, _ := types.ParseJID(m.Chat)
		if err := a.patch("couldn't label the message", appstate.BuildLabelMessage(jid, l.ID, m.ID, on)); err != nil {
			return nil, err
		}
		return map[string]any{"ok": true, "label": l.Name, "labeled": on}, nil
	})

	// --- groups and communities ---
	post("group/photo", func(a *Account, b map[string]any) (any, error) {
		jid, err := a.group(b["chat"])
		if err != nil {
			return nil, err
		}
		data, _, _, has, err := fileOf(b)
		if err != nil {
			return nil, err
		}
		var pic []byte
		if has {
			if pic, err = squareJPEG(data); err != nil {
				return nil, err
			}
		}
		if _, err := a.client().SetGroupPhoto(bg, jid, pic); err != nil {
			return nil, waRefused("couldn't change the group's photo", err)
		}
		return map[string]any{"ok": true, "removed": !has}, nil
	})
	get("group/requests", func(a *Account, q map[string]string) (any, error) {
		jid, err := a.group(q["chat"])
		if err != nil {
			return nil, err
		}
		reqs, err := a.client().GetGroupRequestParticipants(bg, jid)
		if err != nil {
			return nil, waRefused("couldn't get the requests to join", err)
		}
		out := []map[string]any{}
		for _, r := range reqs {
			j := a.canon(r.JID, types.EmptyJID).String()
			out = append(out, map[string]any{"phone": PhoneOf(j), "id": j, "name": strPtr(a.store.NameOf(j)), "requested": r.RequestedAt.UTC().Format(time.RFC3339)})
		}
		return map[string]any{"chat": jid.String(), "requests": out}, nil
	})
	post("group/requests", func(a *Account, b map[string]any) (any, error) {
		jid, err := a.group(b["chat"])
		if err != nil {
			return nil, err
		}
		action := whatsmeow.ParticipantChangeApprove
		if b["action"] == "reject" {
			action = whatsmeow.ParticipantChangeReject
		}
		people := []types.JID{}
		if b["all"] == true {
			reqs, err := a.client().GetGroupRequestParticipants(bg, jid)
			if err != nil {
				return nil, waRefused("couldn't get the requests to join", err)
			}
			for _, r := range reqs {
				people = append(people, r.JID)
			}
			if len(people) == 0 {
				return map[string]any{"chat": jid.String(), "members": []any{}}, nil
			}
		} else if people, err = a.people(b["phones"], false); err != nil {
			return nil, err
		}
		res, err := a.client().UpdateGroupRequestParticipants(bg, jid, people, action)
		if err != nil {
			return nil, waRefused("WhatsApp didn't make the change", err)
		}
		return map[string]any{"chat": jid.String(), "members": a.outcomes(res)}, nil
	})
	get("group/preview", func(a *Account, q map[string]string) (any, error) {
		link, err := str(q["link"], "link", 300)
		if err != nil {
			return nil, err
		}
		if err := a.Ready(false); err != nil {
			return nil, err
		}
		g, err := a.client().GetGroupInfoFromLink(bg, link[strings.LastIndex(link, "/")+1:])
		if err != nil {
			return nil, refuse(400, "couldn't read that link (it may be wrong, reset or expired): %v", err)
		}
		return map[string]any{"chat": g.JID.String(), "name": g.Name, "description": g.Topic, "members": g.ParticipantCount,
			"created": g.GroupCreated.UTC().Format(time.RFC3339), "is_community": g.IsParent, "needs_approval": g.IsJoinApprovalRequired}, nil
	})
	post("communities", func(a *Account, b map[string]any) (any, error) {
		name, err := str(b["name"], "name", 100)
		if err != nil {
			return nil, err
		}
		if err := a.Ready(false); err != nil {
			return nil, err
		}
		g, err := a.client().CreateGroup(bg, whatsmeow.ReqCreateGroup{Name: name, GroupParent: types.GroupParent{IsParent: true}})
		if err != nil {
			return nil, waRefused("couldn't make the community", err)
		}
		if d, _ := b["description"].(string); d != "" {
			a.client().SetGroupTopic(bg, g.JID, "", "", d)
		}
		a.store.Chat(g.JID.String(), g.Name, time.Now().UnixMilli(), -1)
		return map[string]any{"community": g.JID.String(), "name": g.Name}, nil
	})
	get("community/groups", func(a *Account, q map[string]string) (any, error) {
		jid, err := a.group(q["community"])
		if err != nil {
			return nil, err
		}
		subs, err := a.client().GetSubGroups(bg, jid)
		if err != nil {
			return nil, waRefused("couldn't list the community's groups", err)
		}
		out := []map[string]any{}
		for _, g := range subs {
			out = append(out, map[string]any{"chat": g.JID.String(), "name": g.Name, "announcements": g.IsDefaultSubGroup})
		}
		return map[string]any{"community": jid.String(), "groups": out}, nil
	})
	post("community/link", func(a *Account, b map[string]any) (any, error) {
		parent, err := a.group(b["community"])
		if err != nil {
			return nil, err
		}
		child, err := a.group(b["chat"])
		if err != nil {
			return nil, err
		}
		if b["link"] == false {
			err = a.client().UnlinkGroup(bg, parent, child)
		} else {
			err = a.client().LinkGroup(bg, parent, child)
		}
		if err != nil {
			return nil, waRefused("couldn't change the community's groups", err)
		}
		return map[string]any{"ok": true}, nil
	})

	// --- people ---
	get("profile", func(a *Account, q map[string]string) (any, error) {
		jid, err := a.readyChat(q["who"])
		if err != nil {
			return nil, err
		}
		cli := a.client()
		out := map[string]any{"id": jid.String(), "phone": PhoneOf(jid.String()), "name": strPtr(a.store.NameOf(jid.String()))}
		if jid.Server == types.DefaultUserServer {
			if info, err := cli.GetUserInfo(bg, []types.JID{jid}); err == nil {
				if u, ok := info[jid]; ok {
					out["about"] = strPtr(u.Status)
					if u.VerifiedName != nil && u.VerifiedName.Details != nil {
						out["business_name"] = u.VerifiedName.Details.GetVerifiedName()
					}
				}
			}
			if bp, err := cli.GetBusinessProfile(bg, jid); err == nil && bp != nil && (bp.Address != "" || bp.Email != "" || len(bp.Categories) > 0) {
				cats := []string{}
				for _, c := range bp.Categories {
					cats = append(cats, c.Name)
				}
				hours := []string{}
				for _, h := range bp.BusinessHours {
					hours = append(hours, strings.TrimSpace(h.DayOfWeek+" "+h.Mode+" "+h.OpenTime+"-"+h.CloseTime))
				}
				out["business"] = map[string]any{"address": bp.Address, "email": bp.Email, "categories": cats, "website": bp.ProfileOptions["website"], "hours": hours, "time_zone": bp.BusinessHoursTimeZone}
			}
		}
		if pic, err := cli.GetProfilePictureInfo(bg, jid, &whatsmeow.GetProfilePictureParams{}); err == nil && pic != nil {
			out["photo_url"] = pic.URL
		}
		return out, nil
	})
	get("blocked", func(a *Account, q map[string]string) (any, error) {
		if err := a.Ready(false); err != nil {
			return nil, err
		}
		bl, err := a.client().GetBlocklist(bg, "")
		if err != nil {
			return nil, refuse(502, "WhatsApp didn't answer: %v", err)
		}
		out := []map[string]any{}
		for _, it := range bl.Items {
			j := it.PN
			if j.IsEmpty() {
				j = a.canon(it.LID, types.EmptyJID)
			}
			out = append(out, map[string]any{"phone": PhoneOf(j.String()), "id": j.String(), "name": strPtr(a.store.NameOf(j.String()))})
		}
		return map[string]any{"blocked": out}, nil
	})
	post("block", func(a *Account, b map[string]any) (any, error) {
		who, err := str(b["who"], "who", 200)
		if err != nil {
			return nil, err
		}
		jid, _ := TargetOf(who)
		if jid == "" {
			if jid, err = a.ChatFor(who); err != nil {
				return nil, err
			}
		}
		j, err := types.ParseJID(jid)
		if err != nil || j.Server != types.DefaultUserServer {
			return nil, refuse(400, "who: a person's phone number with country code, or their chat")
		}
		if err := a.Ready(false); err != nil {
			return nil, err
		}
		action := events.BlocklistChangeActionBlock
		if b["block"] == false {
			action = events.BlocklistChangeActionUnblock
		}
		dhash := ""
		if bl, err := a.client().GetBlocklist(bg, ""); err == nil {
			dhash = bl.DHash
		}
		if _, err := a.client().UpdateBlocklist(bg, j, action, dhash); err != nil {
			return nil, waRefused("WhatsApp didn't make the change", err)
		}
		return map[string]any{"ok": true, "blocked": action == events.BlocklistChangeActionBlock, "phone": PhoneOf(j.String())}, nil
	})

	// --- the account itself ---
	get("privacy", func(a *Account, q map[string]string) (any, error) {
		if err := a.Ready(false); err != nil {
			return nil, err
		}
		p, err := a.client().TryFetchPrivacySettings(bg, true)
		if err != nil {
			return nil, refuse(502, "WhatsApp didn't answer: %v", err)
		}
		return presentPrivacy(*p), nil
	})
	post("privacy", func(a *Account, b map[string]any) (any, error) {
		setting, _ := b["setting"].(string)
		value, _ := b["value"].(string)
		p, ok := privacyValues[setting]
		if !ok {
			return nil, refuse(400, "setting: last_seen, online, profile_photo, about, read_receipts, groups, calls or messages")
		}
		valid := false
		for _, v := range p.vals {
			valid = valid || v == value
		}
		if !valid {
			return nil, refuse(400, "%s can be %s", setting, strings.Join(p.vals, ", "))
		}
		if err := a.Ready(false); err != nil {
			return nil, err
		}
		got, err := a.client().SetPrivacySetting(bg, p.typ, types.PrivacySetting(value))
		if err != nil {
			return nil, waRefused("couldn't change it", err)
		}
		return presentPrivacy(got), nil
	})
	post("me", func(a *Account, b map[string]any) (any, error) {
		if err := a.Ready(false); err != nil {
			return nil, err
		}
		cli, changed := a.client(), []string{}
		if about, ok := b["about"].(string); ok {
			if err := cli.SetStatusMessage(bg, types.SetStatusInput{Text: &about}); err != nil {
				return nil, waRefused("couldn't change the about text", err)
			}
			changed = append(changed, "about")
		}
		if name, _ := b["name"].(string); strings.TrimSpace(name) != "" {
			if err := a.patch("couldn't change the name", appstate.BuildSettingPushName(strings.TrimSpace(name))); err != nil {
				return nil, err
			}
			changed = append(changed, "name")
		}
		if v, ok := b["default_disappearing"].(string); ok {
			d, known := timers[v]
			if !known {
				return nil, refuse(400, "default_disappearing: off, 24h, 7d or 90d")
			}
			if err := cli.SetDefaultDisappearingTimer(bg, d); err != nil {
				return nil, waRefused("couldn't change disappearing messages", err)
			}
			changed = append(changed, "default_disappearing")
		}
		data, _, _, has, err := fileOf(b)
		if err != nil {
			return nil, err
		}
		if has || b["remove_photo"] == true {
			var pic []byte
			if has {
				if pic, err = squareJPEG(data); err != nil {
					return nil, err
				}
			}
			if _, err := cli.SetGroupPhoto(bg, cli.Store.ID.ToNonAD(), pic); err != nil {
				return nil, waRefused("couldn't change the profile photo", err)
			}
			changed = append(changed, "photo")
		}
		if len(changed) == 0 {
			return nil, refuse(400, "nothing to change: give about, name, default_disappearing or a photo")
		}
		return map[string]any{"ok": true, "changed": changed}, nil
	})
	get("contact-link", func(a *Account, q map[string]string) (any, error) {
		if err := a.Ready(false); err != nil {
			return nil, err
		}
		code, err := a.client().GetContactQRLink(bg, q["reset"] == "true")
		if err != nil {
			return nil, refuse(502, "WhatsApp didn't answer: %v", err)
		}
		return map[string]any{"link": "https://wa.me/qr/" + code}, nil
	})

	// --- status ---
	post("status", func(a *Account, b map[string]any) (any, error) {
		text, _ := b["text"].(string)
		data, typ, name, has, err := fileOf(b)
		if err != nil {
			return nil, err
		}
		if !has && strings.TrimSpace(text) == "" {
			return nil, refuse(400, "give text, or a photo or video")
		}
		if err := a.UnderLimit(); err != nil {
			return nil, err
		}
		if err := a.Ready(false); err != nil {
			return nil, err
		}
		var msg *waE2E.Message
		if has {
			kind := kindOf(typ)
			if kind != whatsmeow.MediaImage && kind != whatsmeow.MediaVideo {
				return nil, refuse(400, "a status can be text, a photo or a video")
			}
			up, err := a.client().Upload(bg, data, kind)
			if err != nil {
				return nil, refuse(502, "couldn't upload the file to WhatsApp: %v", err)
			}
			msg = fileMessage(kind, up, typ, name, text)
		} else {
			msg = &waE2E.Message{ExtendedTextMessage: &waE2E.ExtendedTextMessage{Text: proto.String(text), BackgroundArgb: proto.Uint32(0xFF128C7E), TextArgb: proto.Uint32(0xFFFFFFFF), Font: waE2E.ExtendedTextMessage_SYSTEM.Enum()}}
		}
		resp, err := a.client().SendMessage(bg, types.StatusBroadcastJID, msg)
		if err != nil {
			return nil, refuse(502, "WhatsApp didn't take the status: %v", err)
		}
		a.store.NoteSend(false)
		return map[string]any{"ok": true, "id": resp.ID}, nil
	})

	// --- channels ---
	get("channels", func(a *Account, q map[string]string) (any, error) {
		if err := a.Ready(false); err != nil {
			return nil, err
		}
		list, err := a.client().GetSubscribedNewsletters(bg)
		if err != nil {
			return nil, refuse(502, "WhatsApp didn't answer: %v", err)
		}
		out := []map[string]any{}
		for _, m := range list {
			out = append(out, presentChannel(m))
		}
		return map[string]any{"channels": out}, nil
	})
	get("channel", func(a *Account, q map[string]string) (any, error) {
		jid, err := a.channelOf(q["channel"])
		if err != nil {
			return nil, err
		}
		m, err := a.client().GetNewsletterInfo(bg, jid)
		if err != nil {
			return nil, refuse(404, "couldn't find that channel: %v", err)
		}
		return presentChannel(m), nil
	})
	get("channel/messages", func(a *Account, q map[string]string) (any, error) {
		jid, err := a.channelOf(q["channel"])
		if err != nil {
			return nil, err
		}
		before, _ := strconv.Atoi(q["before"])
		list, err := a.client().GetNewsletterMessages(bg, jid, &whatsmeow.GetNewsletterMessagesParams{Count: num(q["limit"], 20, 100), Before: before})
		if err != nil {
			return nil, refuse(502, "couldn't read the channel: %v", err)
		}
		out := []map[string]any{}
		for _, m := range list {
			_, text, _ := TextOf(m.Message)
			out = append(out, map[string]any{"id": m.MessageServerID, "time": m.Timestamp.UTC().Format(time.RFC3339), "text": text, "views": m.ViewsCount, "reactions": m.ReactionCounts})
		}
		return map[string]any{"channel": jid.String(), "messages": out}, nil
	})
	post("channel/follow", func(a *Account, b map[string]any) (any, error) {
		jid, err := a.channelOf(b["channel"])
		if err != nil {
			return nil, err
		}
		follow := b["follow"] != false
		if follow {
			err = a.client().FollowNewsletter(bg, jid)
		} else {
			err = a.client().UnfollowNewsletter(bg, jid)
		}
		if err != nil {
			return nil, waRefused("WhatsApp didn't make the change", err)
		}
		return map[string]any{"ok": true, "channel": jid.String(), "following": follow}, nil
	})
	post("channel/mute", func(a *Account, b map[string]any) (any, error) {
		jid, err := a.channelOf(b["channel"])
		if err != nil {
			return nil, err
		}
		mute := b["mute"] != false
		if err := a.client().NewsletterToggleMute(bg, jid, mute); err != nil {
			return nil, waRefused("WhatsApp didn't make the change", err)
		}
		return map[string]any{"ok": true, "muted": mute}, nil
	})
	post("channel/react", func(a *Account, b map[string]any) (any, error) {
		jid, err := a.channelOf(b["channel"])
		if err != nil {
			return nil, err
		}
		id, ok := b["message"].(float64)
		if !ok || id < 1 {
			return nil, refuse(400, "message: the post's id (a number) from get_channel_messages")
		}
		emoji, _ := b["emoji"].(string)
		if err := a.client().NewsletterSendReaction(bg, jid, int(id), emoji, ""); err != nil {
			return nil, waRefused("WhatsApp didn't take the reaction", err)
		}
		return map[string]any{"ok": true}, nil
	})
	post("channels", func(a *Account, b map[string]any) (any, error) {
		name, err := str(b["name"], "name", 100)
		if err != nil {
			return nil, err
		}
		if err := a.Ready(false); err != nil {
			return nil, err
		}
		desc, _ := b["description"].(string)
		m, err := a.client().CreateNewsletter(bg, whatsmeow.CreateNewsletterParams{Name: name, Description: desc})
		if err != nil {
			return nil, waRefused("couldn't make the channel", err)
		}
		return presentChannel(m), nil
	})
	post("channel/post", func(a *Account, b map[string]any) (any, error) {
		jid, err := a.channelOf(b["channel"])
		if err != nil {
			return nil, err
		}
		meta, err := a.client().GetNewsletterInfo(bg, jid)
		if err != nil {
			return nil, refuse(404, "couldn't find that channel: %v", err)
		}
		if meta.ViewerMeta == nil || (meta.ViewerMeta.Role != types.NewsletterRoleOwner && meta.ViewerMeta.Role != types.NewsletterRoleAdmin) {
			return nil, refuse(403, "only a channel's owner or admins can post in it")
		}
		text, _ := b["text"].(string)
		data, typ, name, has, err := fileOf(b)
		if err != nil {
			return nil, err
		}
		if !has && strings.TrimSpace(text) == "" {
			return nil, refuse(400, "give text, or a file")
		}
		if err := a.UnderLimit(); err != nil {
			return nil, err
		}
		msg, extra := &waE2E.Message{Conversation: proto.String(text)}, whatsmeow.SendRequestExtra{}
		if has {
			kind := kindOf(typ)
			up, err := a.client().UploadNewsletter(bg, data, kind)
			if err != nil {
				return nil, refuse(502, "couldn't upload the file to WhatsApp: %v", err)
			}
			msg, extra.MediaHandle = fileMessage(kind, up, typ, name, text), up.Handle
		}
		resp, err := a.client().SendMessage(bg, jid, msg, extra)
		if err != nil {
			return nil, refuse(502, "WhatsApp didn't take the post: %v", err)
		}
		a.store.NoteSend(false)
		return map[string]any{"ok": true, "id": resp.ServerID}, nil
	})
}
