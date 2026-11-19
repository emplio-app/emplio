# WhatsApp server: what's decided and what's next (Nov 19, 2026)

Branch `ashish141199/whatsapp-baileys`, PR #294. Everything in this PR works end to end locally: a real phone linked
through the QR page, the history copy landed (about 400 chats), and reads came back.

## Decided, not built yet

1. **Rewrite this server in Go with whatsmeow**, instead of Baileys (Node).
   - Why: steadier, a full stable release, maintained by Beeper (uses it in production), much less memory.
   - Measured on Baileys, locally: about 126 MB for the server with nothing connected; one connected account adds
     about 13 MB once settled, peaking at about 45 MB while it catches up.
   - Keep the **same HTTP API** (see server.ts: /accounts, /code, chats, messages, search, contacts, group, media,
     send, send-file, react, read), the same token auth, the same rules (known chats only, 20 sends/hour, 150/day),
     and one database per account with full-text search. Then the backend (`backend/src/integrations/own/whatsapp_linked`)
     doesn't change. whatsmeow brings its own SQL store for the login; messages can go in SQLite with FTS5.
   - The Dockerfile, docker-compose service, CI step and the Mumbai box's systemd unit change to the Go binary.
2. **The new-message trigger becomes hourly polling, not instant.** Nobody stays connected around the clock.
   - Remove the watch/webhook path: server `PUT/DELETE /watch`, `deliver()`, keeping watched accounts connected,
     and `push` in whatsapp_linked/index.ts.
   - Add a server endpoint for recent messages across all chats (after a time, newest first, with a limit) and a
     read action on it, then `backend/src/integrations/polls/whatsapp_linked.ts` (pattern: polls/swipe.ts), every 60
     minutes by default and at least 60, with the same filters as `wanted()` (chat, groups, contains, from_me). List it
     in APPS in polls/index.ts.
   - Each check connects, takes in what arrived while offline (WhatsApp queues it; old history is not copied again),
     then disconnects after the idle time. Spread accounts' checks across the hour so they don't all connect at once.

## Loose ends

- The link page: Emplio's fonts, a short spam / own-risk warning, and an "I understand the risk" button before the
  QR code shows.
- A "transaction failed, rolling back" error showed once in Baileys' log right after linking (harmless so far); it goes
  away with the rewrite.
- The pairing code (linking by typing a code on the phone), sends and the trigger haven't been tried live.
- The cloud server runs on the Mumbai box `emplio-whatsapp` (systemd `emplio-whatsapp`, port 4200, reachable only
  from production; token in /etc/emplio-whatsapp.env). Production doesn't use it yet: going live needs WHATSAPP_URL
  and WHATSAPP_TOKEN in production's backend/.env, after merge, with a changelog version.
