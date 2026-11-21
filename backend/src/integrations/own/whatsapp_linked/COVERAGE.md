# WhatsApp (linked) coverage

Checked 2026-11-20 against whatsmeow (the WhatsApp Web protocol library the WhatsApp server uses, in Go; every `Client` method and `appstate` patch builder), Periskope's
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

- Account: get_account, check_numbers, get_privacy_settings, update_privacy_setting*, update_profile* (about, name,
  photo, default disappearing messages), get_my_contact_link* (wa.me/qr link; reset makes a new one)
- Chats: list_chats, get_messages, get_message (reactions, ticks, poll votes, edited/deleted), list_recent_messages,
  list_events, search_messages, list_contacts, get_group, list_groups, download_media, load_older_messages* (asks the phone for
  history older than the link copy)
- Sending: send_message*, reply_to_message* (its own action: small models miss send_message's reply_to),
  reply_privately* (WhatsApp's "Reply privately": a group message answered in the sender's own chat, quoted),
  send_file* (stickers from .webp), send_location*, send_contact*, send_poll*, vote_in_poll*, forward_message*,
  react_to_message*, edit_message*, delete_message*, pin_message*, star_message*, mark_as_read*
- Chat list: mute_chat*, archive_chat*, pin_chat*, mark_as_unread*, delete_chat*, set_disappearing_messages*
- Labels (WhatsApp Business): list_labels, save_label*, delete_label*, label_chat*, label_message*. The server keeps
  labels as the phone reports them; accounts linked before labels were added fetch them in full once.
- Groups: create_group* (optionally inside a community), add_group_members*, remove_group_members*,
  make_group_admins*, remove_group_admins*, update_group_settings* (name, description, admins-only sending, editing
  and adding, join approval, disappearing messages), set_group_photo*, list_join_requests, approve_join_requests*,
  reject_join_requests*, get_group_invite_link*, preview_group_link, join_group*, leave_group*
- Communities: create_community*, list_community_groups, add_group_to_community*, remove_group_from_community*
- People: get_profile (about, photo link, business name, address, email, website, categories, hours), list_blocked,
  block_contact*, unblock_contact*
- Status: post_status* (text, photo or video)
- Channels: list_channels, get_channel, get_channel_messages, follow_channel*, unfollow_channel*, mute_channel*,
  react_to_channel_post*, create_channel*, post_to_channel*

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
- Calls (rejecting them as they ring) and presence (typing, online, last seen): both need the account connected the
  moment it happens, and showing as online stops the phone's own notifications. Accounts connect only when used.
- Reading other people's status updates: they'd fill the chats and set off new-message automations; status privacy
  decides who sees ours.
- Meta AI bots, business orders and catalogues, payments, passkeys, push-notification setup, joining with a private
  invite message (as opposed to a link): not things a business runs through a linked device, or the library only
  half-supports them.
- Editing captions on photos and files (text messages only), and poll votes cast before the account was linked.
- Full history: only what WhatsApp copies over when linking (recent months) and everything after.

## Limits (server-enforced)

Replies to chats where the other side wrote in the last day: 60 sends an hour and 300 a day per account. Anything
else (chats quiet for a day, new groups and adds, statuses, channel posts): 20 an hour and 150 a day. Reactions, edits,
deletes, pins, polls and forwards count as sends; only to chats it already has. The account stays connected for 10 minutes
after use, and catches up every 4 hours.
