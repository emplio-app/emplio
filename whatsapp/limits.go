// How often this server asks WhatsApp's own servers for things for one number. WhatsApp answers "rate-overlimit" to a
// number that asks too much, and flags numbers that keep at it: on Nov 21 2026 a job looked up groups one by one
// about 1,500 times in an hour and was refused 922 times.
package main

import (
	"fmt"
	"strings"
	"sync"
	"time"

	"go.mau.fi/whatsmeow/types"
)

const (
	// lookups that ask WhatsApp live (a group's members, a profile, whether numbers are on WhatsApp)
	AskMinute, AskHour = 30, 300
	// group changes: making, joining and leaving groups, adding and removing people, changing settings
	ChangeHour, ChangeDay = 30, 100
	// after WhatsApp says too much, nothing more is asked of it for this long
	CoolFor = 15 * time.Minute
	// group details are kept this long before WhatsApp is asked again
	GroupsFresh = 10 * time.Minute
)

// ponytail: counts live in memory, so a restart forgets them; keep them in the store if restarts get frequent
type pace struct {
	mu        sync.Mutex
	asks      []time.Time
	changes   []time.Time
	coolUntil time.Time
	groups    map[string]*types.GroupInfo
	groupsAt  map[string]time.Time
	allAt     time.Time
}

// What only reads what's saved here, so it goes on while WhatsApp is being left alone.
var local = map[string]bool{
	"GET /accounts/{id}/chats": true, "GET /accounts/{id}/messages": true, "GET /accounts/{id}/recent": true,
	"GET /accounts/{id}/search": true, "GET /accounts/{id}/contacts": true, "GET /accounts/{id}/message": true,
	"GET /accounts/{id}/events": true, "GET /accounts/{id}/media": true, "GET /accounts/{id}": true,
	"POST /accounts/{id}/code": true, "PUT /accounts/{id}/watch": true, "DELETE /accounts/{id}/watch": true,
	"DELETE /accounts/{id}": true,
}

// Lookups counted once per request (group details and the group list count themselves, only when not kept).
var asks = map[string]bool{
	"POST /accounts/{id}/check": true, "GET /accounts/{id}/group/invite": true, "GET /accounts/{id}/group/requests": true,
	"GET /accounts/{id}/group/preview": true, "GET /accounts/{id}/community/groups": true, "GET /accounts/{id}/profile": true,
	"GET /accounts/{id}/blocked": true, "GET /accounts/{id}/privacy": true, "GET /accounts/{id}/contact-link": true,
	"GET /accounts/{id}/channels": true, "GET /accounts/{id}/channel": true, "GET /accounts/{id}/channel/messages": true,
	"POST /accounts/{id}/history": true,
}

var changes = map[string]bool{
	"POST /accounts/{id}/groups": true, "POST /accounts/{id}/group/members": true, "POST /accounts/{id}/group/settings": true,
	"POST /accounts/{id}/group/join": true, "POST /accounts/{id}/group/leave": true, "POST /accounts/{id}/group/photo": true,
	"POST /accounts/{id}/group/requests": true, "POST /accounts/{id}/communities": true, "POST /accounts/{id}/community/link": true,
}

// paced is what a request may do now, by its route: nothing that reaches WhatsApp while it's being left alone, and
// not too many lookups or group changes.
func (a *Account) paced(route string) error {
	if local[route] {
		return nil
	}
	if err := a.cooling(); err != nil {
		return err
	}
	switch {
	case asks[route]:
		return a.ask()
	case changes[route]:
		return a.change()
	}
	return nil
}

// overlimit: WhatsApp said this number asks too much. Everything that reaches WhatsApp stops for CoolFor.
func (a *Account) overlimit(err error) error {
	if err == nil || !strings.Contains(err.Error(), "rate-overlimit") {
		return err
	}
	a.p.mu.Lock()
	a.p.coolUntil = time.Now().Add(CoolFor)
	a.p.mu.Unlock()
	return a.cooling()
}

func (a *Account) cooling() error {
	a.p.mu.Lock()
	until := a.p.coolUntil
	a.p.mu.Unlock()
	if time.Now().Before(until) {
		return refuse(429, "WhatsApp said this number is asking too much, so nothing more goes to WhatsApp from it until %s UTC (saved chats can still be read). Stop here and report what's done; don't try again before then", until.UTC().Format("15:04"))
	}
	return nil
}

// within keeps the times in the last window and says how many there are.
func within(ts *[]time.Time, window time.Duration) int {
	n, cut := 0, time.Now().Add(-window)
	for _, t := range *ts {
		if t.After(cut) {
			n++
		}
	}
	return n
}

func prune(ts []time.Time, window time.Duration) []time.Time {
	cut, kept := time.Now().Add(-window), ts[:0]
	for _, t := range ts {
		if t.After(cut) {
			kept = append(kept, t)
		}
	}
	return kept
}

// ask counts one live lookup, or says to wait.
func (a *Account) ask() error {
	a.p.mu.Lock()
	defer a.p.mu.Unlock()
	a.p.asks = prune(a.p.asks, time.Hour)
	if within(&a.p.asks, time.Minute) >= AskMinute {
		return refuse(429, "asked WhatsApp %d times in the last minute from this number; wait a minute. For many groups at once use list_groups, one request", AskMinute)
	}
	if len(a.p.asks) >= AskHour {
		return refuse(429, "asked WhatsApp %d times in the last hour from this number; wait %s, so the number isn't flagged. For many groups at once use list_groups, one request", AskHour, wait(a.p.asks[0], time.Hour))
	}
	a.p.asks = append(a.p.asks, time.Now())
	return nil
}

// change counts one group change, or says to wait. Kept group details are dropped: they may be out of date now.
func (a *Account) change() error {
	a.p.mu.Lock()
	defer a.p.mu.Unlock()
	a.p.changes = prune(a.p.changes, 24*time.Hour)
	if within(&a.p.changes, time.Hour) >= ChangeHour {
		return refuse(429, "made %d group changes from this number in the last hour; wait before making more, so the number isn't flagged", ChangeHour)
	}
	if len(a.p.changes) >= ChangeDay {
		return refuse(429, "made %d group changes from this number today; wait %s, so the number isn't flagged", ChangeDay, wait(a.p.changes[0], 24*time.Hour))
	}
	a.p.changes = append(a.p.changes, time.Now())
	a.p.groups, a.p.groupsAt, a.p.allAt = nil, nil, time.Time{}
	return nil
}

func wait(oldest time.Time, window time.Duration) string {
	m := int(time.Until(oldest.Add(window)).Minutes()) + 1
	if m >= 120 {
		return fmt.Sprintf("about %d hours", m/60)
	}
	return fmt.Sprintf("%d minutes", m)
}

// groupInfo is a group's details, kept for GroupsFresh.
func (a *Account) groupInfo(jid types.JID) (*types.GroupInfo, error) {
	key := jid.String()
	a.p.mu.Lock()
	g, at := a.p.groups[key], a.p.groupsAt[key]
	a.p.mu.Unlock()
	if g != nil && time.Since(at) < GroupsFresh {
		return g, nil
	}
	if err := a.ask(); err != nil {
		return nil, err
	}
	g, err := a.client().GetGroupInfo(bg, jid)
	if err != nil {
		return nil, a.overlimit(err)
	}
	a.keepGroups(false, g)
	return g, nil
}

// joinedGroups is every group this number is in, with members: one request to WhatsApp, kept for GroupsFresh.
func (a *Account) joinedGroups() ([]*types.GroupInfo, error) {
	a.p.mu.Lock()
	fresh := time.Since(a.p.allAt) < GroupsFresh
	all := []*types.GroupInfo{}
	if fresh {
		for _, g := range a.p.groups {
			all = append(all, g)
		}
	}
	a.p.mu.Unlock()
	if fresh {
		return all, nil
	}
	if err := a.ask(); err != nil {
		return nil, err
	}
	all, err := a.client().GetJoinedGroups(bg)
	if err != nil {
		return nil, a.overlimit(err)
	}
	a.keepGroups(true, all...)
	return all, nil
}

func (a *Account) keepGroups(whole bool, gs ...*types.GroupInfo) {
	a.p.mu.Lock()
	defer a.p.mu.Unlock()
	if whole || a.p.groups == nil {
		a.p.groups, a.p.groupsAt = map[string]*types.GroupInfo{}, map[string]time.Time{}
	}
	now := time.Now()
	for _, g := range gs {
		a.p.groups[g.JID.String()], a.p.groupsAt[g.JID.String()] = g, now
	}
	if whole {
		a.p.allAt = now
	}
}
