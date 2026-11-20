// What a WhatsApp message says, as one line of text for the agent, and the ids of who it's from.
package main

import (
	"fmt"
	"regexp"
	"strings"

	"go.mau.fi/whatsmeow/proto/waE2E"
	"go.mau.fi/whatsmeow/types"
)

// photos, videos, voice notes, stickers and files: the ones that can be downloaded later
var media = map[string]bool{"image": true, "video": true, "ptv": true, "audio": true, "document": true, "sticker": true}

// unwrap takes off the envelopes WhatsApp puts some messages in (disappearing, view once, a document with a caption).
func unwrap(m *waE2E.Message) *waE2E.Message {
	for m != nil {
		switch {
		case m.GetEphemeralMessage().GetMessage() != nil:
			m = m.GetEphemeralMessage().GetMessage()
		case m.GetViewOnceMessage().GetMessage() != nil:
			m = m.GetViewOnceMessage().GetMessage()
		case m.GetViewOnceMessageV2().GetMessage() != nil:
			m = m.GetViewOnceMessageV2().GetMessage()
		case m.GetViewOnceMessageV2Extension().GetMessage() != nil:
			m = m.GetViewOnceMessageV2Extension().GetMessage()
		case m.GetDocumentWithCaptionMessage().GetMessage() != nil:
			m = m.GetDocumentWithCaptionMessage().GetMessage()
		case m.GetDeviceSentMessage().GetMessage() != nil:
			m = m.GetDeviceSentMessage().GetMessage()
		default:
			return m
		}
	}
	return m
}

// TextOf is a message's content as text: what was typed, or a label for what it is ("[voice note]") with any caption
// after it. ok is false for what isn't something someone said (reactions, deletes, edits, key exchanges).
func TextOf(raw *waE2E.Message) (typ, text string, ok bool) {
	m := unwrap(raw)
	if m == nil {
		return "", "", false
	}
	label, caption := "", ""
	switch {
	case m.Conversation != nil:
		typ, caption = "conversation", m.GetConversation()
	case m.ExtendedTextMessage != nil:
		typ, caption = "extendedText", m.GetExtendedTextMessage().GetText()
	case m.ImageMessage != nil:
		typ, label, caption = "image", "[photo]", m.GetImageMessage().GetCaption()
	case m.PtvMessage != nil:
		typ, label, caption = "ptv", "[video]", m.GetPtvMessage().GetCaption()
	case m.VideoMessage != nil:
		typ, label, caption = "video", "[video]", m.GetVideoMessage().GetCaption()
	case m.AudioMessage != nil:
		typ, label = "audio", "[audio]"
		if m.GetAudioMessage().GetPTT() {
			label = "[voice note]"
		}
	case m.DocumentMessage != nil:
		d := m.GetDocumentMessage()
		name := d.GetFileName()
		if name == "" {
			name = "unnamed"
		}
		typ, label, caption = "document", "[file: "+name+"]", d.GetCaption()
	case m.StickerMessage != nil:
		typ, label = "sticker", "[sticker]"
	case m.LocationMessage != nil, m.LiveLocationMessage != nil:
		var lat, lng float64
		var name, address string
		if l := m.GetLocationMessage(); l != nil {
			typ, lat, lng, name, address = "location", l.GetDegreesLatitude(), l.GetDegreesLongitude(), l.GetName(), l.GetAddress()
		} else {
			l := m.GetLiveLocationMessage()
			typ, lat, lng = "liveLocation", l.GetDegreesLatitude(), l.GetDegreesLongitude()
		}
		label = fmt.Sprintf("[location: %v,%v", lat, lng)
		if name != "" {
			label += " " + name
		}
		if address != "" {
			label += ", " + address
		}
		label += "]"
	case m.ContactMessage != nil:
		typ, label = "contact", "[contact: "+m.GetContactMessage().GetDisplayName()+"]"
	case m.ContactsArrayMessage != nil:
		names := []string{}
		for _, c := range m.GetContactsArrayMessage().GetContacts() {
			names = append(names, c.GetDisplayName())
		}
		typ, label = "contactsArray", "[contacts: "+strings.Join(names, ", ")+"]"
	case m.PollCreationMessage != nil, m.PollCreationMessageV2 != nil, m.PollCreationMessageV3 != nil:
		p := m.GetPollCreationMessage()
		if p == nil {
			p = m.GetPollCreationMessageV2()
		}
		if p == nil {
			p = m.GetPollCreationMessageV3()
		}
		opts := []string{}
		for _, o := range p.GetOptions() {
			opts = append(opts, o.GetOptionName())
		}
		typ, label = "pollCreation", "[poll: "+p.GetName()+" ("+strings.Join(opts, " / ")+")]"
	case m.EventMessage != nil:
		typ, label = "event", "[event: "+m.GetEventMessage().GetName()+"]"
	default:
		return "", "", false
	}
	text = strings.TrimSpace(strings.TrimSpace(label + " " + caption))
	return typ, text, text != ""
}

// contextOf is the reply/mention details on whichever kind of message this is.
func contextOf(m *waE2E.Message) *waE2E.ContextInfo {
	m = unwrap(m)
	for _, c := range []*waE2E.ContextInfo{
		m.GetExtendedTextMessage().GetContextInfo(), m.GetImageMessage().GetContextInfo(), m.GetVideoMessage().GetContextInfo(),
		m.GetAudioMessage().GetContextInfo(), m.GetDocumentMessage().GetContextInfo(), m.GetStickerMessage().GetContextInfo(),
		m.GetPtvMessage().GetContextInfo(), m.GetLocationMessage().GetContextInfo(), m.GetContactMessage().GetContextInfo(),
	} {
		if c != nil {
			return c
		}
	}
	return nil
}

// QuotedOf is the message quoted in a reply, short.
func QuotedOf(m *waE2E.Message) string {
	_, t, ok := TextOf(contextOf(m).GetQuotedMessage())
	if !ok {
		return ""
	}
	if r := []rune(t); len(r) > 300 {
		return string(r[:300]) + "…"
	}
	return t
}

// Canon is someone's id, by phone number where WhatsApp told us one: it shows hidden ids (@lid) for some people now,
// with the number alongside (alt), or learnt earlier (known).
func Canon(jid, alt types.JID, known func(types.JID) types.JID) types.JID {
	if jid.IsEmpty() {
		return jid
	}
	j := jid.ToNonAD()
	if j.Server == types.HiddenUserServer {
		if alt.Server == types.DefaultUserServer {
			return alt.ToNonAD()
		}
		if known != nil {
			if pn := known(j); pn.Server == types.DefaultUserServer {
				return pn.ToNonAD()
			}
		}
	}
	return j
}

func PhoneOf(jid string) *string {
	if !strings.HasSuffix(jid, "@"+types.DefaultUserServer) {
		return nil
	}
	p := "+" + strings.SplitN(jid, "@", 2)[0]
	return &p
}

var phoneLike = regexp.MustCompile(`^\+?[\d\s()-]{8,}$`)
var nonDigits = regexp.MustCompile(`\D`)

// TargetOf is where a send goes, from what the agent wrote: an id, a phone number, or a chat's name.
func TargetOf(to string) (jid, name string) {
	s := strings.TrimSpace(to)
	if strings.Contains(s, "@") {
		return s, ""
	}
	if phoneLike.MatchString(s) {
		return strings.TrimPrefix(nonDigits.ReplaceAllString(s, ""), "00") + "@" + types.DefaultUserServer, ""
	}
	return "", s
}
