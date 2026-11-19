// WhatsApp, linked: a person links their own WhatsApp (or WhatsApp Business app) to Emplio the way they'd link it on a
// computer (WhatsApp → Linked devices), and Emplio reads, searches and answers their chats, groups included. Not
// Meta's WhatsApp Business API (the "whatsapp" app on Composio, MSG91, Plivo): this is the person's own number.
// The accounts live on Emplio's WhatsApp server (whatsapp/ at the top of the repo, client.ts); a connection's login is
// that server's id for the account. Linking runs through the sign-in plumbing every OAuth app uses: authorizeUrl is
// our own page with the QR code (link.ts), and the code it hands back says which account was linked. Its new-message
// trigger is polled every hour (polls/whatsapp_linked.ts), so no one's WhatsApp stays connected around the clock.
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
const RULES = "Only to people and groups this WhatsApp already chats with, and at most 20 an hour and 150 a day (shared with every send), so the number isn't flagged.";

// a change to a group's members
const members = (action: string, description: string, known = false) => ({
  description,
  input: z.object({ chat: group, phones: known ? phones.describe("Phone numbers with country code, like +15551234567; only people this WhatsApp already chats with") : phones }),
  run: async (i: { chat: string; phones: string[] }, key: string) => wa("POST", `/accounts/${account(key)}/group/members`, { ...i, action }),
});

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
        "The WhatsApp's chats, newest activity first, groups included, with unread counts. Use query to find a person or group by name or number. Only messages from about when it was linked (plus the recent history WhatsApp copied over then) are there.",
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
      description: "Messages in one chat, oldest first (the latest `limit` of them, or those in a time range). Voice notes, photos and files show as labels; fetch them with download_media.",
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
      description: "Search every chat's messages (or one chat's) for words, newest first. Each word must appear.",
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
        "Send a text message from this WhatsApp, as the person. Only to people and groups it already chats with, and at most 20 an hour and 150 a day, so the number isn't flagged; for new numbers or bulk messages use the WhatsApp Business API instead. WhatsApp formatting: *bold*, _italic_.",
      input: z.object({
        to: chat.describe("Who to send it to: a chat id from list_chats, a phone number with country code, or the chat's exact name"),
        text: z.string().min(1).max(65_000).describe("The message"),
        reply_to: message.optional().describe("Reply to this message (it's quoted above yours)"),
      }),
      run: async (i: { to: string; text: string; reply_to?: string }, key) => wa("POST", `/accounts/${account(key)}/send`, i),
    },
    send_file: {
      description: "Send a file from the computer on WhatsApp: photos and videos show as such, audio as audio (.ogg as a voice note), anything else as a document. Same rules as send_message.",
      input: z.object({
        to: chat.describe("Who to send it to: a chat id, a phone number with country code, or the chat's exact name"),
        file: z.any().describe('The file: {"file": "/work/..."}'),
        caption: z.string().max(4000).optional().describe("Text under it"),
      }),
      run: async (i: { to: string; file: unknown; caption?: string }, key) => {
        if (!(i.file instanceof AppFile)) throw new AppsError('file: give the file as {"file": "/work/..."}');
        return wa("POST", `/accounts/${account(key)}/send-file`, { to: i.to, name: i.file.name, type: i.file.mimetype, data: Buffer.from(i.file.bytes).toString("base64"), caption: i.caption });
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
      input: z.object({ name: z.string().min(1).max(100).describe("The group's name"), phones: phones.describe("Who to put in: phone numbers with country code, people this WhatsApp already chats with") }),
      run: async (i: { name: string; phones: string[] }, key) => wa("POST", `/accounts/${account(key)}/groups`, i),
    },
    add_group_members: members("add", "Add people to a group (this WhatsApp must be an admin). Only people it already chats with; for anyone else, send them the invite link.", true),
    remove_group_members: members("remove", "Remove people from a group (this WhatsApp must be an admin)."),
    make_group_admins: members("promote", "Make group members admins (this WhatsApp must be an admin)."),
    remove_group_admins: members("demote", "Make group admins regular members again (this WhatsApp must be an admin)."),
    update_group_settings: {
      description: "Change a group's name, description, who can send messages, who can edit its details, or disappearing messages. Give only what should change. Usually needs admin.",
      input: z.object({
        chat: group,
        name: z.string().min(1).max(100).optional().describe("New name"),
        description: z.string().max(2048).optional().describe("New description; empty to remove it"),
        only_admins_send: z.boolean().optional().describe("true: only admins can send messages; false: everyone"),
        only_admins_edit: z.boolean().optional().describe("true: only admins can change the name, picture and description; false: everyone"),
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
  },
};
