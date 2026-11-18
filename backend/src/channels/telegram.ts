// Telegram: the product's one bot (TELEGRAM_BOT_TOKEN, made with @BotFather). Private chats only.
// Someone new shares their number with Telegram's own button (so it can't be typed in as someone else's)
// or opens the "Connect Telegram" link from the web app. /new starts a fresh thread, /switch changes business.
// ponytail: long polling from this one server; switch to a webhook (setWebhook to WEBHOOK_URL) when it runs on several
import type { Approval } from "@emplio/shared";
import type { UIMessage } from "ai";
import { decide, moveOn } from "../approvals";
import { personFor } from "../automations";
import { freshStart, steer } from "../chat";
import { storeFile, transcribe } from "../files";
import { connectLink } from "../integrations";
import { askText, converse, findLink, link, mainChat, membershipsOf, normalPhone, setLink, tokenUser, userByPhone, type Channel, type Link, type Out } from ".";

type Json = Record<string, any>;
const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const MAX_TEXT = 3500; // Telegram's limit is 4096 after formatting
const MAX_FILE = 20 * 1024 * 1024; // what bots may download

async function api(method: string, body: Json = {}, timeoutMs = 30_000): Promise<any> {
  const res = await fetch(`https://api.telegram.org/bot${TOKEN}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const data = (await res.json().catch(() => ({}))) as Json;
  if (!data.ok) throw new Error(`Telegram ${method}: ${data.description ?? `HTTP ${res.status}`}`);
  return data.result;
}

// " too: email (channels/index.ts noteEmail) uses this as HTML, where a quote in a link could end its href
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// The agent's Markdown as the little HTML Telegram understands.
export function toHtml(md: string) {
  return md
    .split(/```[^\n]*\n?/)
    .map((part, i) =>
      i % 2
        ? `<pre>${esc(part.trimEnd())}</pre>`
        : esc(part)
            .replace(/`([^`\n]+)`/g, "<code>$1</code>")
            .replace(/\*\*([^*\n]+)\*\*/g, "<b>$1</b>")
            .replace(/^#{1,6}\s+(.+)$/gm, "<b>$1</b>")
            .replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2">$1</a>')
            .replace(/^(\s*)[-*]\s+/gm, "$1• "),
    )
    .join("");
}

// Long text in pieces, split between paragraphs where it can.
function pieces(md: string) {
  const out: string[] = [];
  let rest = md;
  while (rest.length > MAX_TEXT) {
    const cut = rest.lastIndexOf("\n\n", MAX_TEXT) > MAX_TEXT / 2 ? rest.lastIndexOf("\n\n", MAX_TEXT) : MAX_TEXT;
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut).trimStart();
  }
  return [...out, rest];
}

// chats showing a keyboard of answers (ask, below). Telegram only takes it away when one is tapped, so the
// next message sent there takes it away instead: they typed their own answer or moved on.
// ponytail: in memory; after a restart an old keyboard stays until they tap it or a question replaces it
const keyboardUp = new Set<string>();

// the last message's id
async function say(chat: string, md: string, extra: Json = {}) {
  if (keyboardUp.delete(chat) && !extra.reply_markup) extra = { ...extra, reply_markup: { remove_keyboard: true } };
  let sent: Json | undefined;
  for (const piece of pieces(md))
    // formatting Telegram refuses (an unclosed tag after a split): plain text instead
    sent = await api("sendMessage", { chat_id: chat, text: toHtml(piece), parse_mode: "HTML", link_preview_options: { is_disabled: true }, ...extra }).catch(() =>
      api("sendMessage", { chat_id: chat, text: piece, ...extra }),
    );
  return sent?.message_id as number | undefined;
}

const EXPIRED = "Expired, not done";
const SKIPPED = "Skipped, you replied instead";
// approval card id → its message here, to take the buttons off when it's skipped or expires.
// ponytail: in memory; after a restart old buttons stay, and a tap says it expired
const cardMessages = new Map<string, number>();
const closeCard = (chat: string, cardId: string, note: string) => {
  const id = cardMessages.get(cardId);
  cardMessages.delete(cardId);
  if (id) void api("editMessageReplyMarkup", { chat_id: chat, message_id: id, reply_markup: { inline_keyboard: [[{ text: note, callback_data: "done" }]] } }).catch(() => {});
};

const askNumber = (chat: string, why: string) =>
  say(chat, `${why}\n\nTap **Share my number** below so I can see which team you're on. Or open Emplio → your menu → Channels → Connect Telegram.`, {
    reply_markup: { keyboard: [[{ text: "Share my number", request_contact: true }]], one_time_keyboard: true, resize_keyboard: true },
  });

const DECISIONS = { once: "Allowed", always: "Always allowed", deny: "Not allowed" } as const;

// An action's input as short "name: value" lines, for the OK message.
const readable = (input: unknown) =>
  Object.entries(input && typeof input === "object" ? input : { input })
    .map(([k, v]) => {
      const text = typeof v === "string" ? v : JSON.stringify(v);
      return `${k.replaceAll("_", " ")}: ${text.length > 300 ? `${text.slice(0, 300)}…` : text}`;
    })
    .join("\n");

// An action's OK as a message with buttons; the tap goes to approvals.ts decide() (onButton), whichever chat it's for.
async function askOk(chat: string, a: Approval) {
  const id = await say(chat, `**${a.appName}: ${a.title}**\n${readable(a.input)}\n\nOK to go ahead?`, {
    reply_markup: {
      inline_keyboard: [
        [
          { text: "Allow", callback_data: `ap:${a.id}:once` },
          { text: "Always allow", callback_data: `ap:${a.id}:always` },
          { text: "Deny", callback_data: `ap:${a.id}:deny` },
        ],
      ],
    },
  });
  if (!id) return;
  cardMessages.set(a.id, id);
  if (a.expiresAt) setTimeout(() => closeCard(chat, a.id, EXPIRED), Date.parse(a.expiresAt) - Date.now());
}

function out(chat: string, l: Link): Out {
  return {
    // one Telegram message per paragraph, like texting (code blocks stay whole)
    async text(md) {
      for (const p of md.split(/(```[\s\S]*?```)/).flatMap((x, i) => (i % 2 ? [x] : x.split(/\n\s*\n/))).map((x) => x.trim()).filter(Boolean)) await say(chat, p);
    },
    approval: (a) => askOk(chat, a),
    // a link that works on their phone: the app's sign-in, or a box to paste its key into
    async connect(card) {
      const url = connectLink(l, card.app, card.connection, card.mcp ? card.path : undefined);
      if (!url) return say(chat, `Connect **${card.name}** in the web app: your menu → Integrations.`);
      const ask = card.keyField ? `Add your ${card.keyField.label} for **${card.name}** so I can use it:` : `Sign in to **${card.name}** so I can use it:`;
      await say(chat, ask, { reply_markup: { inline_keyboard: [[{ text: `Connect ${card.name}`, url }]] } });
    },
    // a keyboard of answers that sends the tapped one as their message, then goes away; several can be
    // picked (multi): a keyboard sends only one, so they're listed to answer in words
    ask: async (card) => {
      if (card.multi) return say(chat, `${askText(card)}\n${card.options.map((o) => `• ${o}`).join("\n")}\n\nReply with all that apply.`);
      const id = await say(chat, askText(card), {
        reply_markup: card.options.length
          ? { keyboard: card.options.map((text) => [{ text }]), one_time_keyboard: true, resize_keyboard: true, input_field_placeholder: "Or type your own answer" }
          : { force_reply: true, input_field_placeholder: "Type your answer" },
      });
      if (card.options.length) keyboardUp.add(chat);
      return id;
    },
    async plan(steps, shown) {
      const done = steps.filter((x) => x.status === "done").length;
      const md = steps.length
        ? [`**${done === steps.length ? "All done" : "Working on it"}: ${done} of ${steps.length}**`, ...steps.map((x) => `${{ done: "✅", doing: "▶️", todo: "▫️" }[x.status]} ${x.text}`)].join("\n")
        : "Checklist cleared.";
      if (!shown) return steps.length ? say(chat, md) : undefined;
      // ponytail: an edit Telegram refuses (unchanged, too old) just leaves the last version showing
      await api("editMessageText", { chat_id: chat, message_id: shown, text: toHtml(md), parse_mode: "HTML" }).catch(() => {});
      return shown;
    },
    async file(name, mediaType, bytes) {
      const form = new FormData();
      form.set("chat_id", chat);
      form.set("document", new Blob([new Uint8Array(bytes)], { type: mediaType }), name);
      const res = await fetch(`https://api.telegram.org/bot${TOKEN}/sendDocument`, { method: "POST", body: form });
      if (!res.ok) await say(chat, `I made ${name} but couldn't send it here; it's in the web app.`);
    },
  };
}

// What they sent, as message parts: text (voice notes as their words), and photos and files stored like web uploads.
async function partsOf(msg: Json, workspaceId: string, userId: string): Promise<UIMessage["parts"] | string> {
  const parts: UIMessage["parts"] = [];
  const text = msg.text ?? msg.caption;
  // Telegram sends each photo in several sizes, smallest first: the biggest up to 1600px is plenty to read it
  // (the model gets at most 1568px anyway, files.ts) and spares a download of the full-size one
  const doc = msg.document ?? msg.photo?.findLast((p: Json) => Math.max(p.width, p.height) <= 1600) ?? msg.photo?.[0];
  const sound = msg.voice ?? msg.audio ?? msg.video_note;
  const download = async (id: string) =>
    new Uint8Array(await (await fetch(`https://api.telegram.org/file/bot${TOKEN}/${(await api("getFile", { file_id: id })).file_path}`)).arrayBuffer());
  // voice notes become their words; only Ogg ones (Telegram's own) can be cut into pieces past 30 seconds
  if (sound) {
    const type = sound.mime_type ?? (msg.video_note ? "video/mp4" : "audio/ogg");
    if (sound.file_size > MAX_FILE || (type !== "audio/ogg" && sound.duration > 30)) return "That recording is too long for me; send it as a voice note or type it.";
    const heard = await transcribe(await download(sound.file_id), type, { workspaceId, userId }, sound.duration ?? 30).catch((error) => (console.error("telegram voice", error), ""));
    if (!heard) return "I couldn't make out that voice note; please try again or type it.";
    parts.push({ type: "text", text: `(voice note) ${heard}` });
  }
  if (doc) {
    if (doc.file_size > MAX_FILE) return "That file is over 20 MB, too big for me to open here. Upload it in the web app instead.";
    const bytes = await download(doc.file_id);
    const name = msg.document?.file_name ?? `photo-${msg.message_id}.jpg`;
    const type = msg.document?.mime_type ?? "image/jpeg";
    parts.push({ type: "file", ...(await storeFile(workspaceId, name, type, bytes)) });
  }
  if (text) parts.push({ type: "text", text });
  // swiping to reply to one of mine: what they replied to (or the bit they picked) goes first as a quote,
  // the same as quoting in the web app
  const replied = (msg.quote?.text ?? msg.reply_to_message?.text ?? msg.reply_to_message?.caption ?? "").trim();
  if (replied && parts.length) {
    const quote = (replied.length > 600 ? `${replied.slice(0, 600)}…` : replied).replace(/^/gm, "> ");
    const first = parts.find((p) => p.type === "text");
    if (first) first.text = `${quote}\n\n${first.text}`;
    else parts.unshift({ type: "text", text: quote });
  }
  return parts.length ? parts : "I can only read text, voice notes, photos and files here for now.";
}

async function onMessage(msg: Json) {
  const chat = String(msg.chat.id);
  let l = await findLink("telegram", chat);
  const text: string = msg.text ?? "";

  // linking: the web app's link (/start <token>), or their own number from the button
  const token = /^\/start\s+(\S+)/.exec(text)?.[1];
  const shared = msg.contact && msg.contact.user_id === msg.from?.id ? normalPhone(msg.contact.phone_number, false) : null;
  if (token || shared) {
    const userId = token ? tokenUser(token) : (await userByPhone(shared!))?.id;
    const linked = userId ? await link("telegram", chat, userId) : null;
    if (!linked)
      return say(chat, token ? "That link didn't work. Open a fresh one from Emplio." : "That number isn't on any team. Add it in Emplio → your menu → Channels, then share it again.", {
        reply_markup: { remove_keyboard: true },
      });
    const ws = (await membershipsOf(linked.userId)).find((m) => m.workspaceId === linked.workspaceId);
    return say(chat, `You're connected to **${ws?.name}**. This is the same chat as in the web app. /new clears the slate (I keep notes)${(await membershipsOf(linked.userId)).length > 1 ? ", /switch changes business" : ""}.`, {
      reply_markup: { remove_keyboard: true },
    });
  }
  if (!l) return askNumber(chat, "Hi! I'm your team's AI employee.");

  // their main chat stays the same one; what was said so far is kept as notes
  if (/^\/new\b/.test(text)) {
    if (!(await personFor(l.workspaceId, l.userId))) return say(chat, "You're not on that team any more. Send /switch to pick another.");
    const kept = await freshStart(l.workspaceId, await mainChat(l.workspaceId, l.userId));
    return say(chat, kept ? "Starting fresh. I've kept notes on what we discussed. What's next?" : "Couldn't start fresh just now. Try again in a minute.");
  }
  if (/^\/switch\b/.test(text)) {
    const ms = await membershipsOf(l.userId);
    return say(chat, ms.length > 1 ? "Which business?" : `You're only on **${ms[0]?.name}**.`, {
      reply_markup: { inline_keyboard: ms.map((m) => [{ text: m.name + (m.workspaceId === l!.workspaceId ? " ✓" : ""), callback_data: `ws:${m.workspaceId}` }]) },
    });
  }
  if (/^\/start\b/.test(text)) return say(chat, "You're connected. Ask me anything.");

  const parts = await partsOf(msg, l.workspaceId, l.userId);
  if (typeof parts === "string") return say(chat, parts);
  // people send a thought as several messages (a file, then a line, then a typo fix): gather what comes
  // within a few seconds, and anything sent while a reply is being worked on, into one turn
  pending.set(chat, [...(pending.get(chat) ?? []), ...parts]);
  clearTimeout(timers.get(chat));
  timers.set(
    chat,
    setTimeout(() => inLine(chat, () => reply(chat)), GATHER_MS),
  );
}

const GATHER_MS = 2500;
const pending = new Map<string, UIMessage["parts"]>();
const timers = new Map<string, ReturnType<typeof setTimeout>>();

async function reply(chat: string) {
  const parts = pending.get(chat);
  pending.delete(chat);
  const l = await findLink("telegram", chat);
  if (!parts?.length || !l) return;
  // "typing…" lasts 5 seconds; keep it up while the reply is worked on
  const typing = setInterval(() => void api("sendChatAction", { chat_id: chat, action: "typing" }).catch(() => {}), 4500);
  void api("sendChatAction", { chat_id: chat, action: "typing" }).catch(() => {});
  try {
    await converse(l, parts, out(chat, l), { error: (obj, m) => console.error(`telegram ${chat}: ${m}`, obj) });
  } finally {
    clearInterval(typing);
  }
}

async function onButton(q: Json) {
  const chat = String(q.message?.chat.id);
  const l = await findLink("telegram", chat);
  const [kind, id, decision] = String(q.data).split(":");
  let note = "";
  if (l && kind === "ap") {
    const done = await decide(id!, l.workspaceId, l.userId, decision as keyof typeof DECISIONS);
    note = done ? DECISIONS[decision as keyof typeof DECISIONS] : EXPIRED;
    cardMessages.delete(id!);
    if (typeof done === "string") await say(chat, done);
  } else if (l && kind === "ws" && (await membershipsOf(l.userId)).some((m) => m.workspaceId === id)) {
    await setLink(l, { workspaceId: id });
    note = `Now talking to ${(await membershipsOf(l.userId)).find((m) => m.workspaceId === id)?.name}`;
  }
  await api("answerCallbackQuery", { callback_query_id: q.id, text: note || undefined }).catch(() => {});
  // the buttons go once used; the answer stays under the message
  if (note && q.message)
    await api("editMessageReplyMarkup", { chat_id: chat, message_id: q.message.message_id, reply_markup: { inline_keyboard: [[{ text: note, callback_data: "done" }]] } }).catch(() => {});
}

// one message at a time per chat, in order; buttons skip the line (a reply may be waiting on one)
const lines = new Map<string, Promise<unknown>>();
function inLine(chat: string, job: () => Promise<unknown>) {
  const next = (lines.get(chat) ?? Promise.resolve()).then(job).catch((error) => console.error(`telegram ${chat}`, error));
  lines.set(chat, next);
  void next.finally(() => lines.get(chat) === next && lines.delete(chat));
}

let bot: Promise<string | null> | null = null;

export const telegram: Channel & { username(): Promise<string | null>; start(): Promise<void> } = {
  async send(address: string, md: string) {
    if (!TOKEN) throw new Error("Telegram isn't set up on this server");
    await say(address, md);
  },
  approval: askOk,
  closeApproval: (address, id, decision) => closeCard(address, id, decision === "skipped" ? SKIPPED : DECISIONS[decision as keyof typeof DECISIONS] ?? EXPIRED),
  // the bot's @name, for "Connect Telegram" links; null when there's no bot
  username: () => (bot ??= TOKEN ? api("getMe").then((me: Json) => me.username as string, () => ((bot = null), null)) : Promise.resolve(null)),

  async start() {
    if (!TOKEN) return;
    await api("setMyCommands", {
      commands: [
        { command: "new", description: "Start a fresh chat" },
        { command: "switch", description: "Talk to another business you're on" },
      ],
    }).catch((error) => console.error("telegram: setMyCommands failed", error));
    void (async () => {
      let offset = 0;
      for (;;) {
        try {
          const updates: Json[] = await api("getUpdates", { offset, timeout: 30, allowed_updates: ["message", "callback_query"] }, 40_000);
          for (const u of updates) {
            offset = u.update_id + 1;
            if (u.callback_query) void onButton(u.callback_query).catch((error) => console.error("telegram button", error));
            else if (u.message?.chat.type === "private") {
              const chat = String(u.message.chat.id);
              const msg = u.message;
              // straight away, not in line: open OK cards in this chat are skipped, and a running reply wraps up
              // after its current command. Then the message waits in line and goes in as their own, and the
              // next reply picks up from there.
              void findLink("telegram", chat)
                .then(async (l) => {
                  if (!l) return;
                  const id = await mainChat(l.workspaceId, l.userId);
                  // photos and voice notes too, not just typed text
                  if (!String(msg.text ?? "").startsWith("/")) steer(id);
                  moveOn(id).ids.forEach((card) => closeCard(chat, card, SKIPPED));
                })
                .catch(() => {})
                .then(() => inLine(chat, () => onMessage(msg)));
            }
          }
        } catch (error) {
          console.error("telegram: polling failed", error);
          await Bun.sleep(5000);
        }
      }
    })();
  },
};

if (import.meta.main) {
  console.assert(toHtml("**hi** <b> & `x`") === "<b>hi</b> &lt;b&gt; &amp; <code>x</code>", toHtml("**hi** <b> & `x`"));
  console.assert(toHtml("## Title\n- one") === "<b>Title</b>\n• one");
  console.assert(toHtml("```py\na<b\n```") === "<pre>a&lt;b</pre>");
  console.assert(toHtml("[site](https://x.com/a?b=1&c=2)") === '<a href="https://x.com/a?b=1&amp;c=2">site</a>');
  console.assert(pieces("a".repeat(8000)).every((p) => p.length <= MAX_TEXT));
  console.log("telegram ok");
  process.exit(0);
}
