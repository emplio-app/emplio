// WhatsApp, linked: a person links their own WhatsApp (or WhatsApp Business app) to Emplio the way they'd link it on a
// computer (WhatsApp → Linked devices), and Emplio reads, searches and answers their chats, groups included. Not
// Meta's WhatsApp Business API (the "whatsapp" app on Composio, MSG91, Plivo): this is the person's own number.
// The accounts live on Emplio's WhatsApp server (whatsapp/ at the top of the repo, client.ts); a connection's login is
// that server's id for the account. Linking runs through the sign-in plumbing every OAuth app uses: authorizeUrl is
// our own page with the QR code (link.ts), and the code it hands back says which account was linked.
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

// Each automation's webhook secret, worked out rather than stored.
export function webhookSecret(connection: string) {
  const key = process.env.ENCRYPTION_KEY;
  if (!key) throw new Error("ENCRYPTION_KEY isn't set");
  return createHmac("sha256", key).update(`whatsapp-webhook:${connection}`).digest("hex");
}

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
  push: {
    events: { new_message: "message" },
    triggers: {
      new_message: {
        description:
          "A new message arrives on the linked WhatsApp, in any chat, groups included (also messages that came in while it was offline). Messages sent from it, Emplio's own replies included, don't start it unless from_me is set.",
        config: [
          { name: "chat", type: "string", required: false, description: "Only this chat: part of its name, the phone number, or its id" },
          { name: "groups", type: "include|exclude|only", required: false, description: "Group chats: include (the default), exclude, or only groups" },
          { name: "contains", type: "string", required: false, description: "Only messages containing this text" },
          { name: "from_me", type: "boolean", required: false, description: "Also messages sent from this WhatsApp (by the person on their phone, or by Emplio)" },
        ],
        output: [
          { name: "id", type: "string", required: true, description: "The message's id" },
          { name: "chat", type: "string", required: true, description: "The chat's id, to answer it with send_message" },
          { name: "chat_name", type: "string", required: true, description: "The chat's name (the person, or the group)" },
          { name: "is_group", type: "boolean", required: true, description: "Whether it's a group chat" },
          { name: "from", type: "string", required: true, description: "Who sent it: their phone number" },
          { name: "from_name", type: "string", required: false, description: "Their name" },
          { name: "time", type: "string", required: true, description: "When it was sent" },
          { name: "type", type: "string", required: true, description: "conversation, image, audio (voice notes), document, video, location, contact..." },
          { name: "text", type: "string", required: true, description: "What it says; media as a label like [voice note] or [photo] with any caption" },
          { name: "replying_to", type: "string", required: false, description: "The message it replies to, when it's a reply" },
          { name: "has_media", type: "boolean", required: true, description: "Whether there's a file to fetch with download_media" },
        ],
      },
    },
    async start(key, connection) {
      if (!process.env.WEBHOOK_URL) throw new AppsError("this server can't receive WhatsApp's messages (WEBHOOK_URL isn't set)");
      await wa("PUT", `/accounts/${account(key)}/watch`, { url: `${process.env.WEBHOOK_URL}/webhooks/app/whatsapp_linked/${connection}`, secret: webhookSecret(connection) });
      return `whatsapp_linked:${connection}`;
    },
    stop: async (key) => void (await wa("DELETE", `/accounts/${account(key)}/watch`)),
    async receive(delivery) {
      const got = Buffer.from(String(delivery.headers["x-emplio-signature"] ?? ""));
      const want = Buffer.from(createHmac("sha256", webhookSecret(delivery.connection)).update(delivery.body).digest("hex"));
      if (got.length !== want.length || !timingSafeEqual(got, want)) return null;
      const p = JSON.parse(delivery.body) as { id: string; message: Msg };
      return { events: async () => [{ id: p.id, triggers: ["new_message"], data: p.message }] };
    },
    wanted: (config, data) => wanted(config, data as Msg),
  },
  actions: {
    get_account: {
      description: "Which WhatsApp is linked (number and name), whether it's connected right now, and whether an automation is waiting for its messages.",
      readOnly: true,
      input: z.object({}),
      run: async (_i, key) => {
        const s = await wa("GET", `/accounts/${account(key)}`);
        return { status: s.status, phone: s.me?.phone ?? null, name: s.me?.name ?? null, watched_by_an_automation: s.watching };
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
