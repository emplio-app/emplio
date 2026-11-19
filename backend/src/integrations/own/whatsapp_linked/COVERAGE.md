# WhatsApp (linked) coverage

Checked 2026-11-19 against whatsmeow (the WhatsApp Web protocol library the WhatsApp server uses, in Go) and
Composio's WhatsApp toolkit, which is Meta's WhatsApp Business API, a different product (the `whatsapp` app).

## What it is

The person's own WhatsApp or WhatsApp Business app, linked as a device like WhatsApp Web. The accounts live on
Emplio's WhatsApp server (`whatsapp/` at the top of the repo); Emplio calls it with `WHATSAPP_URL` and
`WHATSAPP_TOKEN`. It's offered only where both are set.

## Sign-in

Linking only: a QR code scanned from the phone, or a pairing code typed on it (when the page is open on that phone).
It runs through the OAuth plumbing (`oauth.authorizeUrl` is our own page, `link.ts`). Disconnecting unlinks the
device and deletes its messages. WhatsApp unlinks devices whose phone is unused for about 14 days; the connection then
shows as needing a reconnect.

## Actions (* asks first)

- Account: get_account
- Chats: list_chats, get_messages, list_recent_messages, search_messages, list_contacts, get_group, download_media
- Sending: send_message*, send_file*, react_to_message*, mark_as_read*

## Triggers

- new_message (polled, `polls/whatsapp_linked.ts`): new messages in any chat, groups included, checked every 60
  minutes (at least 60); filters chat, groups (include/exclude/only), contains, from_me. Each check connects the
  account, takes in what WhatsApp queued while it was idle, and reads the last 3 hours. Not instant, on purpose: an
  instant trigger would keep the person's WhatsApp connected around the clock.

## Left out, and why

- Starting chats with new numbers, bulk sends, creating groups and adding people: what gets numbers banned. The WhatsApp
  Business API (Composio `whatsapp`, MSG91, Plivo) does those properly.
- Status updates, channels (newsletters), calls, polls and editing or deleting sent messages: not asked for by
  business owners yet, and each is more traffic of the kind WhatsApp watches.
- Full history: only what WhatsApp copies over when linking (recent months) and everything after.
- Message edits and deletions made later on the phone aren't reflected in what's saved.

## Limits (server-enforced)

20 sends an hour and 150 a day per account; only to chats it already has. The account stays connected for 10 minutes
after use, and catches up every 4 hours.
