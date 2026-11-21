// WhatsApp, linked: a person links their own WhatsApp (or WhatsApp Business app) to Emplio the way they'd link it on a
// computer (WhatsApp → Linked devices), and Emplio reads, searches and answers their chats, groups included. Not
// Meta's WhatsApp Business API (the "whatsapp" app on Composio, MSG91, Plivo): this is the person's own number.
// The accounts live on Emplio's WhatsApp server (whatsapp/ at the top of the repo, client.ts); a connection's login is
// that server's id for the account. Linking runs through the sign-in plumbing every OAuth app uses: authorizeUrl is
// our own page with the QR code (link.ts), and the code it hands back says which account was linked. Its new-message
// trigger is polled every hour (polls/whatsapp_linked.ts), so no one's WhatsApp stays connected around the clock.
import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { AppFile, AppsError } from "../../types";
import type { OwnApp } from "../index";
import { account, wa, waRaw, whatsappReady } from "./client";
import { linkedAccount } from "./link";

const UNLINKED = "WhatsApp was unlinked from the phone. Link it again in Integrations.";

// how the connection is named: the number and the name on it
const label = (me: { phone?: string | null; name?: string | null } | null) => [me?.phone, me?.name && `(${me.name})`].filter(Boolean).join(" ") || "WhatsApp";

const q = (o: Record<string, unknown>) => new URLSearchParams(Object.entries(o).filter(([, v]) => v !== undefined && v !== "").map(([k, v]) => [k, String(v)])).toString();

const chat = z.string().min(1).max(200).describe("The chat: its id from list_chats (like 15551234567@s.whatsapp.net, or ...@g.us for a group), a phone number with country code, or the chat's exact name");
const message = z.string().min(1).max(200).describe("The message's id, from get_messages or search_messages");
const phones = z.array(z.string().min(1).max(30)).min(1).max(50).describe("Phone numbers with country code, like +15551234567");
const group = z.string().min(1).max(200).describe("The group: its id from list_chats (ending @g.us) or its exact name");
const channel = z.string().min(1).max(300).describe("The channel: its id from list_channels (ending @newsletter) or its link (whatsapp.com/channel/...)");
const RULES = "Only to people and groups this WhatsApp already chats with, and at most 60 an hour and 300 a day when replying to a chat that wrote in the last day, otherwise 20 an hour and 150 a day (shared with every send), so the number isn't flagged.";

// a file from the computer, as the WhatsApp server takes it (nothing when there's none)
function fileBody(f: unknown) {
  if (f === undefined || f === null) return {};
  if (!(f instanceof AppFile)) throw new AppsError('file: give the file as {"file": "/work/..."}');
  return { name: f.name, type: f.mimetype, data: Buffer.from(f.bytes).toString("base64") };
}

// a change to a group's members
const members = (action: string, description: string, known = false) => ({
  description,
  input: z.object({ chat: group, phones: known ? phones.describe("Phone numbers with country code, like +15551234567; only people this WhatsApp already chats with") : phones }),
  run: async (i: { chat: string; phones: string[] }, key: string) => wa("POST", `/accounts/${account(key)}/group/members`, { ...i, action }),
});

// Each connection's webhook secret, worked out rather than stored.
export function webhookSecret(connection: string) {
  const key = process.env.ENCRYPTION_KEY;
  if (!key) throw new Error("ENCRYPTION_KEY isn't set");
  return createHmac("sha256", key).update(`whatsapp-webhook:${connection}`).digest("hex");
}

// each trigger and the kinds of what the WhatsApp server sends that start it (a message, or an event's kind)
export const KINDS: Record<string, string[]> = {
  new_message: ["message"],
  message_edited: ["edited"],
  message_deleted: ["deleted"],
  new_reaction: ["reaction"],
  new_poll_vote: ["poll_vote"],
  group_members_changed: ["joined", "left", "promoted", "demoted"],
  new_chat: ["new_chat"],
  added_to_group: ["added_to_group"],
};

type Msg = { chat: string; chat_name: string; is_group: boolean; from_me: boolean; from: string; from_name: string | null; text: string };
const contains = (hay: unknown, needle: unknown) => String(hay ?? "").toLowerCase().includes(String(needle).toLowerCase());

// whether this automation's settings want the message
export function wanted(config: unknown, m: Msg) {
  const c = (config ?? {}) as Record<string, unknown>;
  if (m.from_me && c.from_me !== true) return false;
  if (c.groups === "exclude" && m.is_group) return false;
  if (c.groups === "only" && !m.is_group) return false;
  if (c.chat && !(contains(m.chat_name, c.chat) || contains(m.chat, String(c.chat).replace(/^\+/, "")) || contains(m.from, c.chat))) return false;
  if (c.contains && !contains(m.text, c.contains)) return false;
  return true;
}

export const whatsapp_linked: OwnApp = {
  app: "whatsapp_linked",
  name: "WhatsApp",
  logo: "/logos/whatsapp_linked.svg",
  async check(key) {
    const s = await wa("GET", `/accounts/${account(key)}`);
    if (!s.linked) throw new AppsError(s.status === "unlinked" ? UNLINKED : "WhatsApp isn't linked yet", true);
    return label(s.me);
  },
  oauth: {
    ready: whatsappReady,
    // our own page, on this server, with the QR code; it comes back to the callback like any sign-in
    authorizeUrl: (redirect, state) => `${new URL(redirect).origin}/whatsapp/link?${new URLSearchParams({ state })}`,
    exchange: async (code, _redirect, callback) => linkedAccount(code, String(callback.state ?? "")),
    // a link someone was sent can't attach their WhatsApp to the sender's Emplio
    noConsentScreen: true,
    // disconnecting in Emplio unlinks it from the phone and forgets its messages
    revoke: async (key) => void (await wa("DELETE", `/accounts/${account(key)}`)),
  },
  // Its triggers keep someone's WhatsApp connected, so they're for paying businesses: checked every hour on Starter and
  // Growth, the moment it happens on Pro (the WhatsApp server keeps the account connected and posts to us).
  plans: { triggers: ["starter", "growth", "pro"], instant: ["pro"] },
  push: {
    // every trigger is polled too (polls/whatsapp_linked.ts); one watch per account carries them all
    events: Object.fromEntries(Object.keys(KINDS).map((t) => [t, t])),
    triggers: {},
    async start(key, connection) {
      if (!process.env.WEBHOOK_URL) throw new AppsError("this server can't be told about WhatsApp messages (WEBHOOK_URL isn't set)");
      await wa("PUT", `/accounts/${account(key)}/watch`, { url: `${process.env.WEBHOOK_URL}/webhooks/app/whatsapp_linked/${connection}`, secret: webhookSecret(connection) });
      return `whatsapp_linked:${connection}`;
    },
    // the last instant automation on this account is gone: it goes back to connecting only when used
    stop: async (key) => void (await wa("DELETE", `/accounts/${account(key)}/watch`)),
    async receive(delivery) {
      const got = Buffer.from(String(delivery.headers["x-emplio-signature"] ?? ""));
      const want = Buffer.from(createHmac("sha256", webhookSecret(delivery.connection)).update(delivery.body).digest("hex"));
      if (got.length !== want.length || !timingSafeEqual(got, want)) return null;
      const p = JSON.parse(delivery.body) as { id: string; kind: string; message?: Msg; event?: Msg };
      const triggers = Object.keys(KINDS).filter((t) => KINDS[t]!.includes(p.kind));
      // the same shape the hourly checks give, so an automation's prompt reads it the same either way
      return { events: async () => [{ id: p.id, triggers, data: p.message ? { message: p.message } : { event: p.event } }] };
    },
    wanted: (config, data) => {
      const d = data as { message?: Msg; event?: Msg };
      return d.message ? wanted(config, d.message) : wanted(config, { ...d.event!, text: "" });
    },
  },
  actions: {
    get_account: {
      description: "Which WhatsApp is linked (number and name), and whether it's connected right now (it connects when used, and stays idle otherwise).",
      readOnly: true,
      input: z.object({}),
      run: async (_i, key) => {
        const s = await wa("GET", `/accounts/${account(key)}`);
        return { status: s.status, phone: s.me?.phone ?? null, name: s.me?.name ?? null };
      },
    },
    list_chats: {
      description:
        "The WhatsApp's chats, newest activity first, groups included, with unread counts. Use query to find a person or group by name or number. Only messages from about when it was linked (plus the recent history WhatsApp copied over then) are there; load_older_messages fetches earlier ones.",
      readOnly: true,
      input: z.object({
        query: z.string().max(200).optional().describe("Part of a name or phone number to look for"),
        kind: z.enum(["all", "people", "groups"]).default("all").describe("all (the default), people (one-to-one chats) or groups"),
        unread_only: z.boolean().default(false).describe("Only chats with unread messages"),
        limit: z.number().int().min(1).max(200).default(30).describe("How many chats (default 30)"),
      }),
      run: async (i: { query?: string; kind: string; unread_only: boolean; limit: number }, key) =>
        wa("GET", `/accounts/${account(key)}/chats?${q({ query: i.query, kind: i.kind, unread: i.unread_only || undefined, limit: i.limit })}`),
    },
    get_messages: {
      description: "Messages in one chat, oldest first (the latest `limit` of them, or those in a time range). Voice notes, photos and files show as labels; fetch them with download_media. Older messages: load_older_messages first.",
      readOnly: true,
      input: z.object({
        chat,
        limit: z.number().int().min(1).max(500).default(50).describe("How many messages (default 50, the latest)"),
        before: z.string().optional().describe("Only messages before this time (ISO 8601, like 2026-11-19T10:00:00Z), to page back"),
        after: z.string().optional().describe("Only messages after this time (ISO 8601)"),
      }),
      run: async (i: { chat: string; limit: number; before?: string; after?: string }, key) => wa("GET", `/accounts/${account(key)}/messages?${q(i)}`),
    },
    list_recent_messages: {
      description: "What came in lately across every chat, groups included, newest first: catches up with WhatsApp first, so it also has what arrived while it was idle.",
      readOnly: true,
      input: z.object({
        after: z.string().optional().describe("Only messages after this time (ISO 8601, like 2026-11-19T10:00:00Z); default the last 3 hours"),
        limit: z.number().int().min(1).max(1000).default(200).describe("How many messages (default 200)"),
      }),
      run: async (i: { after?: string; limit: number }, key) => wa("GET", `/accounts/${account(key)}/recent?${q(i)}`),
    },
    search_messages: {
      description: "Search every chat's messages (or one chat's) for words, newest first. Each word must appear. Only saved messages are searched; load_older_messages fetches earlier ones in a chat.",
      readOnly: true,
      input: z.object({
        query: z.string().min(1).max(500).describe("Words to find"),
        chat: chat.optional(),
        limit: z.number().int().min(1).max(200).default(30).describe("How many messages (default 30)"),
      }),
      run: async (i: { query: string; chat?: string; limit: number }, key) => wa("GET", `/accounts/${account(key)}/search?${q(i)}`),
    },
    list_contacts: {
      description: "People saved in the WhatsApp's contacts or seen in its chats, with their numbers.",
      readOnly: true,
      input: z.object({
        query: z.string().max(200).optional().describe("Part of a name or number to look for"),
        limit: z.number().int().min(1).max(500).default(50).describe("How many (default 50)"),
      }),
      run: async (i: { query?: string; limit: number }, key) => wa("GET", `/accounts/${account(key)}/contacts?${q(i)}`),
    },
    get_group: {
      description: "A group's name, description and members (numbers, names, who's admin).",
      readOnly: true,
      input: z.object({ chat }),
      run: async (i: { chat: string }, key) => wa("GET", `/accounts/${account(key)}/group?${q(i)}`),
    },
    download_media: {
      description: "A photo, video, voice note, sticker or file from a message, onto the computer. Voice notes come as .ogg audio.",
      readOnly: true,
      input: z.object({ chat, message }),
      run: async (i: { chat: string; message: string }, key) => {
        const res = await waRaw("GET", `/accounts/${account(key)}/media?${q(i)}`);
        if (!res.ok) throw new AppsError(((await res.json().catch(() => ({}))) as { error?: string }).error ?? "couldn't download it");
        const name = decodeURIComponent(res.headers.get("x-filename") ?? "whatsapp-file");
        return new AppFile(name, res.headers.get("content-type") ?? "application/octet-stream", new Uint8Array(await res.arrayBuffer()));
      },
    },
    send_message: {
      description:
        "Send a text message from this WhatsApp, as the person. Only to people and groups it already chats with, and at most 60 an hour (300 a day) for chats that wrote in the last day, 20 an hour (150 a day) otherwise, so the number isn't flagged; for new numbers or bulk messages use the WhatsApp Business API instead. WhatsApp formatting: *bold*, _italic_.",
      input: z.object({
        to: chat.describe("Who to send it to: a chat id from list_chats, a phone number with country code, or the chat's exact name"),
        text: z.string().min(1).max(65_000).describe("The message"),
        reply_to: message.optional().describe("Reply to this message (it's quoted above yours)"),
      }),
      run: async (i: { to: string; text: string; reply_to?: string }, key) => wa("POST", `/accounts/${account(key)}/send`, i),
    },
    send_file: {
      description: "Send a file from the computer on WhatsApp: photos and videos show as such, audio as audio (.ogg as a voice note), a .webp image as a sticker if asked, anything else as a document. Same rules as send_message.",
      input: z.object({
        to: chat.describe("Who to send it to: a chat id, a phone number with country code, or the chat's exact name"),
        file: z.any().describe('The file: {"file": "/work/..."}'),
        caption: z.string().max(4000).optional().describe("Text under it"),
        sticker: z.boolean().optional().describe("Send a .webp image as a sticker"),
      }),
      run: async (i: { to: string; file: unknown; caption?: string; sticker?: boolean }, key) => {
        if (!(i.file instanceof AppFile)) throw new AppsError('file: give the file as {"file": "/work/..."}');
        return wa("POST", `/accounts/${account(key)}/send-file`, { to: i.to, ...fileBody(i.file), caption: i.caption, ...(i.sticker ? { sticker: true } : {}) });
      },
    },
    reply_to_message: {
      description: `Reply to one message: your text is sent in the same chat with their message quoted above it. ${RULES}`,
      input: z.object({
        chat: chat.describe("The chat the message is in (its chat id from get_messages or the trigger)"),
        message: message.describe("The id of the message to reply to"),
        text: z.string().min(1).max(65_000).describe("Your reply. WhatsApp formatting: *bold*, _italic_"),
      }),
      run: async (i: { chat: string; message: string; text: string }, key) => wa("POST", `/accounts/${account(key)}/reply`, i),
    },
    get_message: {
      description: "One message with its reactions, whether it was edited or deleted, its ticks (sent, delivered, read, played) if this WhatsApp sent it, and the votes if it's a poll.",
      readOnly: true,
      input: z.object({ chat, message }),
      run: async (i: { chat: string; message: string }, key) => wa("GET", `/accounts/${account(key)}/message?${q(i)}`),
    },
    edit_message: {
      description: "Change the text of a text message this WhatsApp sent, within 20 minutes of sending it. Everyone sees it marked edited.",
      input: z.object({ chat, message, text: z.string().min(1).max(65_000).describe("The new text") }),
      run: async (i: { chat: string; message: string; text: string }, key) => wa("POST", `/accounts/${account(key)}/edit`, i),
    },
    delete_message: {
      description: "Delete a message for everyone: one this WhatsApp sent, or anyone's in a group where it's an admin. WhatsApp only allows this for about two days after sending. Can't be undone.",
      input: z.object({ chat, message }),
      run: async (i: { chat: string; message: string }, key) => wa("POST", `/accounts/${account(key)}/delete`, i),
    },
    forward_message: {
      description: `Forward a message (text, photo, file, voice note...) to another chat; it shows as forwarded. ${RULES}`,
      input: z.object({ chat: chat.describe("The chat the message is in"), message, to: chat.describe("The chat to forward it to: a chat id, a phone number with country code, or the chat's exact name") }),
      run: async (i: { chat: string; message: string; to: string }, key) => wa("POST", `/accounts/${account(key)}/forward`, i),
    },
    pin_message: {
      description: "Pin a message at the top of its chat for everyone (or unpin it). In groups this may need admin.",
      input: z.object({
        chat,
        message,
        pin: z.boolean().default(true).describe("true to pin (the default), false to unpin"),
        days: z.union([z.literal(1), z.literal(7), z.literal(30)]).default(30).describe("How long it stays pinned: 1, 7 or 30 days (default 30)"),
      }),
      run: async (i: { chat: string; message: string; pin: boolean; days: number }, key) => wa("POST", `/accounts/${account(key)}/pin`, i),
    },
    send_poll: {
      description: `Send a poll people answer by tapping a choice. Votes show in get_message and start the new poll vote trigger. ${RULES}`,
      input: z.object({
        to: chat.describe("Who to send it to: a chat id, a phone number with country code, or the chat's exact name"),
        question: z.string().min(1).max(255).describe("The question"),
        options: z.array(z.string().min(1).max(100)).min(2).max(12).describe("The choices, 2 to 12"),
        multiple: z.boolean().default(false).describe("Let people pick more than one choice"),
      }),
      run: async (i: { to: string; question: string; options: string[]; multiple: boolean }, key) => wa("POST", `/accounts/${account(key)}/poll`, i),
    },
    check_numbers: {
      description: "Whether phone numbers have WhatsApp (and the business name, for verified businesses). Doesn't message them.",
      readOnly: true,
      input: z.object({ phones }),
      run: async (i: { phones: string[] }, key) => wa("POST", `/accounts/${account(key)}/check`, i),
    },
    list_events: {
      description:
        "What happened lately besides new messages, newest first: messages edited or deleted, reactions, poll votes, people joining, leaving, made or no longer admin in groups, new chats, and this WhatsApp being added to groups.",
      readOnly: true,
      input: z.object({
        kinds: z.array(z.enum(["edited", "deleted", "reaction", "poll_vote", "joined", "left", "promoted", "demoted", "new_chat", "added_to_group"])).optional().describe("Only these kinds (default all)"),
        after: z.string().optional().describe("Only after this time (ISO 8601); default the last 3 hours"),
        limit: z.number().int().min(1).max(1000).default(200).describe("How many (default 200)"),
      }),
      run: async (i: { kinds?: string[]; after?: string; limit: number }, key) => wa("GET", `/accounts/${account(key)}/events?${q({ ...i, kinds: i.kinds?.join(",") })}`),
    },
    create_group: {
      description: "Make a new WhatsApp group with this WhatsApp as admin. Only people it already chats with can be put in; anyone whose privacy settings block it gets left out (send them get_group_invite_link).",
      input: z.object({
        name: z.string().min(1).max(100).describe("The group's name"),
        phones: phones.describe("Who to put in: phone numbers with country code, people this WhatsApp already chats with"),
        community: group.optional().describe("Make it inside this community (its id or exact name); this WhatsApp must be its admin"),
      }),
      run: async (i: { name: string; phones: string[]; community?: string }, key) => wa("POST", `/accounts/${account(key)}/groups`, i),
    },
    add_group_members: members("add", "Add people to a group (this WhatsApp must be an admin). Only people it already chats with; for anyone else, send them the invite link.", true),
    remove_group_members: members("remove", "Remove people from a group (this WhatsApp must be an admin)."),
    make_group_admins: members("promote", "Make group members admins (this WhatsApp must be an admin)."),
    remove_group_admins: members("demote", "Make group admins regular members again (this WhatsApp must be an admin)."),
    update_group_settings: {
      description: "Change a group's name, description, who can send messages, who can edit its details, who can add people, whether joining needs admin approval, or disappearing messages. Give only what should change. Usually needs admin.",
      input: z.object({
        chat: group,
        name: z.string().min(1).max(100).optional().describe("New name"),
        description: z.string().max(2048).optional().describe("New description; empty to remove it"),
        only_admins_send: z.boolean().optional().describe("true: only admins can send messages; false: everyone"),
        only_admins_edit: z.boolean().optional().describe("true: only admins can change the name, picture and description; false: everyone"),
        only_admins_add: z.boolean().optional().describe("true: only admins can add people; false: everyone"),
        join_approval: z.boolean().optional().describe("true: people joining by link need an admin's approval; false: they join straight away"),
        disappearing: z.enum(["off", "24h", "7d", "90d"]).optional().describe("Disappearing messages: off, 24h, 7d or 90d"),
      }),
      run: async (i: Record<string, unknown>, key) => wa("POST", `/accounts/${account(key)}/group/settings`, i),
    },
    get_group_invite_link: {
      description: "A group's invite link (chat.whatsapp.com/...), to send people who should join. reset makes a new one and stops the old one working.",
      input: z.object({ chat: group, reset: z.boolean().default(false).describe("Make a new link; the old one stops working") }),
      run: async (i: { chat: string; reset: boolean }, key) => wa("GET", `/accounts/${account(key)}/group/invite?${q({ chat: i.chat, reset: i.reset || undefined })}`),
    },
    join_group: {
      description: "Join a group with its invite link (chat.whatsapp.com/...).",
      input: z.object({ link: z.string().min(1).max(300).describe("The invite link, like https://chat.whatsapp.com/AbCdEf123") }),
      run: async (i: { link: string }, key) => wa("POST", `/accounts/${account(key)}/group/join`, i),
    },
    leave_group: {
      description: "Leave a group. Getting back in needs an invite.",
      input: z.object({ chat: group }),
      run: async (i: { chat: string }, key) => wa("POST", `/accounts/${account(key)}/group/leave`, i),
    },
    react_to_message: {
      description: "React to a message with an emoji, or take a reaction back with an empty emoji.",
      input: z.object({ chat, message, emoji: z.string().max(16).describe("One emoji, like 👍; empty to remove the reaction") }),
      run: async (i: { chat: string; message: string; emoji: string }, key) => wa("POST", `/accounts/${account(key)}/react`, i),
    },
    mark_as_read: {
      description: "Mark a chat's messages as read (the sender sees blue ticks). Reading them in Emplio doesn't do this by itself.",
      input: z.object({ chat }),
      run: async (i: { chat: string }, key) => wa("POST", `/accounts/${account(key)}/read`, i),
    },
    reply_privately: {
      description: `Reply to someone's group message in their own one-to-one chat, with their group message quoted above (WhatsApp's "Reply privately"). ${RULES}`,
      input: z.object({
        chat: group.describe("The group the message is in (its chat id from get_messages or the trigger)"),
        message: message.describe("The id of their message in the group"),
        text: z.string().min(1).max(65_000).describe("Your reply. WhatsApp formatting: *bold*, _italic_"),
      }),
      run: async (i: { chat: string; message: string; text: string }, key) => wa("POST", `/accounts/${account(key)}/reply-private`, i),
    },
    send_location: {
      description: `Send a location pin (a map people can open). ${RULES}`,
      input: z.object({
        to: chat.describe("Who to send it to: a chat id, a phone number with country code, or the chat's exact name"),
        latitude: z.number().min(-90).max(90).describe("Latitude, like 51.5072"),
        longitude: z.number().min(-180).max(180).describe("Longitude, like -0.1276"),
        name: z.string().max(200).optional().describe("The place's name, like Northwind Warehouse"),
        address: z.string().max(500).optional().describe("Its address"),
      }),
      run: async (i: Record<string, unknown>, key) => wa("POST", `/accounts/${account(key)}/location`, i),
    },
    send_contact: {
      description: `Send someone's contact card, so the person can save or message them with a tap. ${RULES}`,
      input: z.object({
        to: chat.describe("Who to send it to: a chat id, a phone number with country code, or the chat's exact name"),
        name: z.string().min(1).max(200).describe("The contact's name as it should show"),
        phone: z.string().min(1).max(30).describe("The contact's phone number with country code, like +15551234567"),
      }),
      run: async (i: { to: string; name: string; phone: string }, key) => wa("POST", `/accounts/${account(key)}/contact-card`, i),
    },
    vote_in_poll: {
      description: "Vote in a poll someone sent (only polls that arrived after WhatsApp was linked). A new vote replaces this WhatsApp's earlier one; an empty list takes it back.",
      input: z.object({ chat, message: message.describe("The poll's message id"), options: z.array(z.string().min(1).max(100)).max(12).describe("The choices to pick, exactly as the poll writes them") }),
      run: async (i: { chat: string; message: string; options: string[] }, key) => wa("POST", `/accounts/${account(key)}/vote`, i),
    },
    star_message: {
      description: "Star a message (or unstar it), so it shows under Starred messages on the phone.",
      input: z.object({ chat, message, starred: z.boolean().default(true).describe("true to star (the default), false to unstar") }),
      run: async (i: { chat: string; message: string; starred: boolean }, key) => wa("POST", `/accounts/${account(key)}/star`, i),
    },
    load_older_messages: {
      description: "Ask the phone for messages older than the ones saved in a chat (only recent months are copied over when WhatsApp is linked). The phone has to be online; then read them with get_messages and before.",
      input: z.object({ chat, count: z.number().int().min(1).max(200).default(50).describe("How many older messages to ask for (default 50)") }),
      run: async (i: { chat: string; count: number }, key) => wa("POST", `/accounts/${account(key)}/history`, i),
    },
    mute_chat: {
      description: "Mute a chat's notifications on the phone (or unmute it).",
      input: z.object({
        chat,
        mute: z.boolean().default(true).describe("true to mute (the default), false to unmute"),
        for: z.enum(["8h", "1w", "always"]).default("always").describe("How long: 8h, 1w or always (the default)"),
      }),
      run: async (i: { chat: string; mute: boolean; for: string }, key) => wa("POST", `/accounts/${account(key)}/chat/mute`, i),
    },
    archive_chat: {
      description: "Archive a chat (it leaves the main chat list on the phone) or bring it back.",
      input: z.object({ chat, archive: z.boolean().default(true).describe("true to archive (the default), false to unarchive") }),
      run: async (i: { chat: string; archive: boolean }, key) => wa("POST", `/accounts/${account(key)}/chat/archive`, i),
    },
    pin_chat: {
      description: "Pin a chat to the top of the phone's chat list (WhatsApp allows 3), or unpin it.",
      input: z.object({ chat, pin: z.boolean().default(true).describe("true to pin (the default), false to unpin") }),
      run: async (i: { chat: string; pin: boolean }, key) => wa("POST", `/accounts/${account(key)}/chat/pin`, i),
    },
    mark_as_unread: {
      description: "Mark a chat unread on the phone (the green dot), as a reminder to come back to it. The sender sees nothing.",
      input: z.object({ chat }),
      run: async (i: { chat: string }, key) => wa("POST", `/accounts/${account(key)}/chat/unread`, i),
    },
    delete_chat: {
      description: "Delete a whole chat from this WhatsApp (phone included) and from what Emplio saved of it. Others still have their copy. Can't be undone.",
      input: z.object({ chat }),
      run: async (i: { chat: string }, key) => wa("POST", `/accounts/${account(key)}/chat/delete`, i),
    },
    set_disappearing_messages: {
      description: "Turn disappearing messages on or off in a one-to-one chat or group (in groups this may need admin).",
      input: z.object({ chat, disappearing: z.enum(["off", "24h", "7d", "90d"]).describe("off, 24h, 7d or 90d") }),
      run: async (i: { chat: string; disappearing: string }, key) => wa("POST", `/accounts/${account(key)}/chat/disappearing`, i),
    },
    list_labels: {
      description: "The WhatsApp Business labels (like New customer, Pending payment, Paid) and which chats have each.",
      readOnly: true,
      input: z.object({}),
      run: async (_i, key) => wa("GET", `/accounts/${account(key)}/labels`),
    },
    save_label: {
      description: "Make a new WhatsApp Business label, or rename or recolour one (give label for an existing one).",
      input: z.object({
        name: z.string().min(1).max(100).describe("The label's name"),
        label: z.string().max(100).optional().describe("To change an existing label: its id or current name from list_labels"),
        color: z.number().int().min(0).max(19).optional().describe("Colour number, 0 to 19"),
      }),
      run: async (i: Record<string, unknown>, key) => wa("POST", `/accounts/${account(key)}/label`, i),
    },
    delete_label: {
      description: "Delete a WhatsApp Business label (chats keep everything else).",
      input: z.object({ label: z.string().min(1).max(100).describe("The label's id or name from list_labels") }),
      run: async (i: { label: string }, key) => wa("POST", `/accounts/${account(key)}/label`, { ...i, delete: true }),
    },
    label_chat: {
      description: "Put a WhatsApp Business label on a chat, or take it off.",
      input: z.object({ chat, label: z.string().min(1).max(100).describe("The label's id or name from list_labels"), on: z.boolean().default(true).describe("true to add (the default), false to remove") }),
      run: async (i: { chat: string; label: string; on: boolean }, key) => wa("POST", `/accounts/${account(key)}/chat/label`, i),
    },
    label_message: {
      description: "Put a WhatsApp Business label on one message, or take it off.",
      input: z.object({ chat, message, label: z.string().min(1).max(100).describe("The label's id or name from list_labels"), on: z.boolean().default(true).describe("true to add (the default), false to remove") }),
      run: async (i: Record<string, unknown>, key) => wa("POST", `/accounts/${account(key)}/message/label`, i),
    },
    set_group_photo: {
      description: "Change a group's photo (cropped to a square), or remove it by leaving out the file. Usually needs admin.",
      input: z.object({ chat: group, file: z.any().describe('The photo (JPEG, PNG or GIF); leave out to remove the photo: {"file": "/work/..."}').optional() }),
      run: async (i: { chat: string; file?: unknown }, key) => wa("POST", `/accounts/${account(key)}/group/photo`, { chat: i.chat, ...fileBody(i.file) }),
    },
    list_join_requests: {
      description: "People asking to join a group that needs admin approval (this WhatsApp must be an admin).",
      readOnly: true,
      input: z.object({ chat: group }),
      run: async (i: { chat: string }, key) => wa("GET", `/accounts/${account(key)}/group/requests?${q(i)}`),
    },
    approve_join_requests: {
      description: "Let people in who asked to join a group (this WhatsApp must be an admin). Give phones, or all for everyone waiting.",
      input: z.object({ chat: group, phones: phones.optional(), all: z.boolean().default(false).describe("Approve everyone waiting") }),
      run: async (i: { chat: string; phones?: string[]; all: boolean }, key) => wa("POST", `/accounts/${account(key)}/group/requests`, { ...i, action: "approve" }),
    },
    reject_join_requests: {
      description: "Turn down people who asked to join a group (this WhatsApp must be an admin). Give phones, or all for everyone waiting.",
      input: z.object({ chat: group, phones: phones.optional(), all: z.boolean().default(false).describe("Reject everyone waiting") }),
      run: async (i: { chat: string; phones?: string[]; all: boolean }, key) => wa("POST", `/accounts/${account(key)}/group/requests`, { ...i, action: "reject" }),
    },
    preview_group_link: {
      description: "What group an invite link (chat.whatsapp.com/...) is for, before joining: its name, description and how many members.",
      readOnly: true,
      input: z.object({ link: z.string().min(1).max(300).describe("The invite link") }),
      run: async (i: { link: string }, key) => wa("GET", `/accounts/${account(key)}/group/preview?${q(i)}`),
    },
    create_community: {
      description: "Make a WhatsApp community (groups under one roof, with an announcements group made with it). Add groups with add_group_to_community or create_group's community.",
      input: z.object({ name: z.string().min(1).max(100).describe("The community's name"), description: z.string().max(2048).optional().describe("What it's for") }),
      run: async (i: { name: string; description?: string }, key) => wa("POST", `/accounts/${account(key)}/communities`, i),
    },
    list_community_groups: {
      description: "The groups in a community, its announcements group included.",
      readOnly: true,
      input: z.object({ community: group.describe("The community: its id or exact name") }),
      run: async (i: { community: string }, key) => wa("GET", `/accounts/${account(key)}/community/groups?${q(i)}`),
    },
    add_group_to_community: {
      description: "Move an existing group into a community (this WhatsApp must be admin of both).",
      input: z.object({ community: group.describe("The community: its id or exact name"), chat: group }),
      run: async (i: { community: string; chat: string }, key) => wa("POST", `/accounts/${account(key)}/community/link`, { ...i, link: true }),
    },
    remove_group_from_community: {
      description: "Take a group out of a community; the group itself stays.",
      input: z.object({ community: group.describe("The community: its id or exact name"), chat: group }),
      run: async (i: { community: string; chat: string }, key) => wa("POST", `/accounts/${account(key)}/community/link`, { ...i, link: false }),
    },
    get_profile: {
      description: "A person's or group's WhatsApp profile: about text, profile photo link, and for businesses their verified name, address, email, website, categories and opening hours.",
      readOnly: true,
      input: z.object({ who: chat.describe("A phone number with country code, a chat id, or the chat's exact name") }),
      run: async (i: { who: string }, key) => wa("GET", `/accounts/${account(key)}/profile?${q(i)}`),
    },
    list_blocked: {
      description: "The people this WhatsApp has blocked.",
      readOnly: true,
      input: z.object({}),
      run: async (_i, key) => wa("GET", `/accounts/${account(key)}/blocked`),
    },
    block_contact: {
      description: "Block someone: they can't message or call this WhatsApp any more.",
      input: z.object({ who: chat.describe("Their phone number with country code, or their chat") }),
      run: async (i: { who: string }, key) => wa("POST", `/accounts/${account(key)}/block`, { ...i, block: true }),
    },
    unblock_contact: {
      description: "Unblock someone.",
      input: z.object({ who: chat.describe("Their phone number with country code, or their chat") }),
      run: async (i: { who: string }, key) => wa("POST", `/accounts/${account(key)}/block`, { ...i, block: false }),
    },
    get_privacy_settings: {
      description: "Who can see this WhatsApp's last seen, online, profile photo and about, whether it sends read receipts, and who can add it to groups, call it and message it.",
      readOnly: true,
      input: z.object({}),
      run: async (_i, key) => wa("GET", `/accounts/${account(key)}/privacy`),
    },
    update_privacy_setting: {
      description:
        "Change one privacy setting. Values: last_seen, profile_photo, about, groups: all, contacts, contact_blacklist (contacts except some) or none; online: all or match_last_seen; read_receipts: all or none; calls: all or known; messages: all or contacts.",
      input: z.object({
        setting: z.enum(["last_seen", "online", "profile_photo", "about", "read_receipts", "groups", "calls", "messages"]).describe("Which setting"),
        value: z.enum(["all", "contacts", "contact_blacklist", "none", "match_last_seen", "known"]).describe("The new value (see the description for which fit which setting)"),
      }),
      run: async (i: { setting: string; value: string }, key) => wa("POST", `/accounts/${account(key)}/privacy`, i),
    },
    update_profile: {
      description: "Change this WhatsApp's own about text, display name, profile photo (or remove it), or default disappearing messages for new chats. Give only what should change.",
      input: z.object({
        about: z.string().max(139).optional().describe("New about text"),
        name: z.string().min(1).max(25).optional().describe("New display name"),
        photo: z.any().describe('New profile photo (JPEG, PNG or GIF), cropped to a square: {"file": "/work/..."}').optional(),
        remove_photo: z.boolean().optional().describe("true to remove the profile photo"),
        default_disappearing: z.enum(["off", "24h", "7d", "90d"]).optional().describe("Disappearing messages for new chats: off, 24h, 7d or 90d"),
      }),
      run: async (i: { about?: string; name?: string; photo?: unknown; remove_photo?: boolean; default_disappearing?: string }, key) => {
        const { photo, ...rest } = i;
        return wa("POST", `/accounts/${account(key)}/me`, { ...rest, ...fileBody(photo) });
      },
    },
    get_my_contact_link: {
      description: "A link (wa.me/qr/...) that opens a chat with this WhatsApp, to share on a website, card or email. reset makes a new one and stops the old one working.",
      input: z.object({ reset: z.boolean().default(false).describe("Make a new link; the old one stops working") }),
      run: async (i: { reset: boolean }, key) => wa("GET", `/accounts/${account(key)}/contact-link?${q({ reset: i.reset || undefined })}`),
    },
    post_status: {
      description: "Post a status update (text, a photo or a video, gone after 24 hours), seen by contacts as the phone's status privacy allows. Counts towards the send limit.",
      input: z.object({
        text: z.string().max(700).optional().describe("The status text, or the caption under a photo or video"),
        file: z.any().describe('A photo or video: {"file": "/work/..."}').optional(),
      }),
      run: async (i: { text?: string; file?: unknown }, key) => wa("POST", `/accounts/${account(key)}/status`, { text: i.text, ...fileBody(i.file) }),
    },
    list_channels: {
      description: "The WhatsApp channels this WhatsApp follows or runs, with followers and its role.",
      readOnly: true,
      input: z.object({}),
      run: async (_i, key) => wa("GET", `/accounts/${account(key)}/channels`),
    },
    get_channel: {
      description: "A WhatsApp channel's name, description, followers and link, by its id or link.",
      readOnly: true,
      input: z.object({ channel }),
      run: async (i: { channel: string }, key) => wa("GET", `/accounts/${account(key)}/channel?${q(i)}`),
    },
    get_channel_messages: {
      description: "A channel's latest posts, newest first, with views and reaction counts.",
      readOnly: true,
      input: z.object({
        channel,
        limit: z.number().int().min(1).max(100).default(20).describe("How many posts (default 20)"),
        before: z.number().int().optional().describe("Only posts before this post id, to page back"),
      }),
      run: async (i: { channel: string; limit: number; before?: number }, key) => wa("GET", `/accounts/${account(key)}/channel/messages?${q(i)}`),
    },
    follow_channel: {
      description: "Follow a WhatsApp channel by its id or link.",
      input: z.object({ channel }),
      run: async (i: { channel: string }, key) => wa("POST", `/accounts/${account(key)}/channel/follow`, { ...i, follow: true }),
    },
    unfollow_channel: {
      description: "Stop following a WhatsApp channel.",
      input: z.object({ channel }),
      run: async (i: { channel: string }, key) => wa("POST", `/accounts/${account(key)}/channel/follow`, { ...i, follow: false }),
    },
    mute_channel: {
      description: "Mute a followed channel's notifications, or unmute them.",
      input: z.object({ channel, mute: z.boolean().default(true).describe("true to mute (the default), false to unmute") }),
      run: async (i: { channel: string; mute: boolean }, key) => wa("POST", `/accounts/${account(key)}/channel/mute`, i),
    },
    react_to_channel_post: {
      description: "React to a channel post with an emoji, or take the reaction back with an empty emoji.",
      input: z.object({ channel, message: z.number().int().min(1).describe("The post's id from get_channel_messages"), emoji: z.string().max(16).describe("One emoji, like 👍; empty to remove") }),
      run: async (i: { channel: string; message: number; emoji: string }, key) => wa("POST", `/accounts/${account(key)}/channel/react`, i),
    },
    create_channel: {
      description: "Make a new WhatsApp channel run by this WhatsApp, for one-way updates to followers.",
      input: z.object({ name: z.string().min(1).max(100).describe("The channel's name"), description: z.string().max(2048).optional().describe("What it's about") }),
      run: async (i: { name: string; description?: string }, key) => wa("POST", `/accounts/${account(key)}/channels`, i),
    },
    post_to_channel: {
      description: "Post an update in a channel this WhatsApp owns or is admin of: text, or a photo, video or file with an optional caption. Counts towards the send limit.",
      input: z.object({ channel, text: z.string().max(65_000).optional().describe("The post, or the caption under a file"), file: z.any().describe('A photo, video or file: {"file": "/work/..."}').optional() }),
      run: async (i: { channel: string; text?: string; file?: unknown }, key) => wa("POST", `/accounts/${account(key)}/channel/post`, { channel: i.channel, text: i.text, ...fileBody(i.file) }),
    },
  },
};
