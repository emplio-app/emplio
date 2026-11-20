# WhatsApp (linked) coverage

Checked 2026-11-20 against whatsmeow (the WhatsApp Web protocol library the WhatsApp server uses, in Go), Periskope's
API and workflow triggers (docs.periskope.app, the closest product: linked WhatsApp numbers for teams), and Composio's
WhatsApp toolkit, which is Meta's WhatsApp Business API, a different product (the `whatsapp` app).

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

- Account: get_account, check_numbers
- Chats: list_chats, get_messages, get_message (reactions, ticks, poll votes, edited/deleted), list_recent_messages,
  list_events, search_messages, list_contacts, get_group, download_media
- Sending: send_message*, reply_to_message* (its own action: small models miss send_message's reply_to), send_file*,
  send_poll*, forward_message*, react_to_message*, edit_message*, delete_message*, pin_message*, mark_as_read*
- Groups: create_group*, add_group_members*, remove_group_members*, make_group_admins*, remove_group_admins*,
  update_group_settings* (name, description, admins-only sending and editing, disappearing messages),
  get_group_invite_link*, join_group*, leave_group*

## Triggers

Plans (`plans` on the app, checked by the automation engine): no WhatsApp automations on the free trial; Starter and
Growth are polled hourly as below; Pro is told the moment it happens (the WhatsApp server keeps a watched account
connected and posts to `/webhooks/app/whatsapp_linked/<connection>`). Self-hosted servers get instant for everyone.

- new_message (polled, `polls/whatsapp_linked.ts`): new messages in any chat, groups included, checked every 60
  minutes (at least 60); filters chat, groups (include/exclude/only), contains, from_me. Each check connects the
  account, takes in what WhatsApp queued while it was idle, and reads the last 3 hours. Not instant, on purpose: an
  instant trigger would keep the person's WhatsApp connected around the clock.
- message_edited, message_deleted, new_reaction, new_poll_vote, group_members_changed (joined, left, promoted,
  demoted), new_chat (someone's first message), added_to_group: same hourly checks over `list_events`; filters chat,
  groups, from_me. The server keeps events 30 days.

## Left out, and why

- Starting chats with new numbers and bulk sends (Periskope's broadcasts): what gets numbers banned. Groups can only be
  made with, and added to by, people the account already chats with; anyone else gets the invite link. The WhatsApp
  Business API (Composio `whatsapp`, MSG91, Plivo) does cold and bulk messaging properly.
- Periskope's own CRM (tickets, tasks, labels, private notes, custom properties, scheduled messages, team access,
  AI agent, knowledge base): Emplio has its own automations, tasks and memory for these.
- Status updates, channels (newsletters), calls, group pictures, profile name and picture, archiving and muting chats:
  not asked for yet.
- Editing captions on photos and files (text messages only), and poll votes cast before the account was linked.
- Full history: only what WhatsApp copies over when linking (recent months) and everything after.

## Limits (server-enforced)

20 sends an hour and 150 a day per account (replies, reactions, edits, deletes, pins, polls, forwards, new groups and
adds all count); only to chats it already has. The account stays connected for 10 minutes
after use, and catches up every 4 hours.
