// Searching a person's old chats: the words, the commands run and what they printed (messages.search,
// a full-text index). People search their own chats only (what the whole business should know belongs in
// company files), except the background agent (heartbeat.ts), which reads everyone's: `everyone`. The sidebar's search box and the agent's `emplio history` share these functions.
import { and, asc, desc, eq, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { SearchHit } from "@emplio/shared";
import { context } from "./auth";
import { db } from "./db";
import { query as activityRows, record } from "./activity";
import { listTasks } from "./tasks";
import { conversations, messageText, messages, users } from "./db/schema";
import { dayIn, timezoneOf } from "./time";
import { stopBrowser } from "./browser";

// repos: the file repos this chat may see, for similarWords
type Who = { workspaceId: string; userId: string; everyone?: boolean; repos?: string[] };

// "invoice acme" → every word, each as a prefix (invoice:* & acme:*); null when there's nothing to search
export const toQuery = (words: string) => {
  const terms = words.toLowerCase().match(/[\p{L}\p{N}]+/gu)?.slice(0, 10) ?? [];
  return terms.length ? terms.map((t) => `${t}:*`).join(" & ") : null;
};

const mine = (who: Who) => and(who.everyone ? undefined : eq(conversations.userId, who.userId), eq(conversations.workspaceId, who.workspaceId));
// whose chat it is, when it may be anyone's
const whose = (who: Who, name: string | null) => (who.everyone && name ? ` (${name})` : "");

// Messages matching every word, newest first, with the matches in **bold**. `chat`: only that chat (its
// id or the first 8 characters of it).
export async function searchMessages(who: Who, words: string, chat?: string, limit = 20): Promise<SearchHit[]> {
  const query = toQuery(words);
  if (!query) return [];
  const rows = await db
    .select({
      conversationId: messages.conversationId,
      title: conversations.title,
      messageId: messages.id,
      role: messages.role,
      createdAt: messages.createdAt,
      snippet: sql<string>`ts_headline('simple', ${messageText(sql`${messages.parts}`)}, to_tsquery('simple', ${query}), 'MaxFragments=2, MaxWords=24, MinWords=8, StartSel=**, StopSel=**')`,
      // its place in the chat, for `emplio history show <chat> <n>`
      // every match, not just the ones shown
      total: sql<number>`(count(*) over ())::int`,
      n: sql<number>`(select count(*) from ${messages} m2 where m2.conversation_id = ${messages.conversationId} and m2.created_at <= ${messages.createdAt})::int`,
    })
    .from(messages)
    .innerJoin(conversations, eq(conversations.id, messages.conversationId))
    .where(
      and(
        mine(who),
        sql`${messages.search} @@ to_tsquery('simple', ${query})`,
        chat ? sql`${conversations.id}::text like ${`${chat.toLowerCase().replace(/[^0-9a-f-]/g, "")}%`}` : undefined,
      ),
    )
    .orderBy(desc(messages.createdAt))
    .limit(Math.min(limit, 50));
  return rows.map((r) => ({ ...r, role: r.role as SearchHit["role"], createdAt: r.createdAt.toISOString() }));
}

// The sidebar's search box: chats whose title matches come first (no message, empty snippet), then
// matching messages from the other chats.
export async function searchChats(who: Who, words: string): Promise<SearchHit[]> {
  const query = toQuery(words);
  if (!query) return [];
  const [titled, found] = await Promise.all([
    db
      .select({ conversationId: conversations.id, title: conversations.title, updatedAt: conversations.updatedAt })
      .from(conversations)
      .where(and(mine(who), sql`to_tsvector('simple', ${conversations.title}) @@ to_tsquery('simple', ${query})`))
      .orderBy(desc(conversations.updatedAt))
      .limit(10),
    searchMessages(who, words),
  ]);
  const ids = new Set(titled.map((c) => c.conversationId));
  return [
    ...titled.map((c) => ({ conversationId: c.conversationId, title: c.title, messageId: "", role: "user" as const, createdAt: c.updatedAt.toISOString(), snippet: "", n: 0 })),
    ...found.filter((h) => !ids.has(h.conversationId)),
  ];
}

// Words spelled close to these (Athavale → aathavale) in what the person wrote in their chats and in the file repos they may see, for
// when a name is written differently than searched. Trigram similarity (pg_trgm) over the words of messages.search
// and file_index.search.
// people's own words only: tool output would make it ~10x the words and slow (0.7s for the busiest person, Nov 2026).
// ponytail: ts_stat reads every tsvector in scope per call (~0.1s at most today); keep a words table if it gets slow
export async function similarWords(who: Who, repos: string[], words: string) {
  const terms = [...new Set(words.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])].filter((t) => t.length >= 4).slice(0, 5);
  if (!terms.length) return [];
  // ts_stat takes its query as text; only ids we made (uuids) and our repo names go into it
  const q = (s: string) => `'${s.replace(/'/g, "''")}'`;
  const chats = `select m.search from messages m join conversations c on c.id = m.conversation_id where m.role = 'user' and c.workspace_id = ${q(who.workspaceId)}${who.everyone ? "" : ` and c.user_id = ${q(who.userId)}`}`;
  const files = `select search from file_index where workspace_id = ${q(who.workspaceId)} and repo in (${repos.map(q).join(",") || "''"})`;
  const rows = await db.execute<{ term: string; word: string }>(sql`
    with w as materialized (select word from ts_stat(${chats}) union select word from ts_stat(${files}))
    select t.term, v.word from unnest(string_to_array(${terms.join(" ")}, ' ')) t(term)
    cross join lateral (
      select word from w where word <> t.term and word ~ '^[[:alnum:]]+$' and similarity(word, t.term) > 0.45
      order by similarity(word, t.term) desc limit 3
    ) v`);
  return rows.rows.map((r) => `${r.term} → ${r.word}`);
}

// One of this person's chats, by id or the first 8 characters of it.
async function findChat(who: Who, chat: string) {
  const prefix = chat.toLowerCase().replace(/[^0-9a-f-]/g, "");
  if (prefix.length < 4) return null;
  const found = await db
    .select()
    .from(conversations)
    .where(and(mine(who), sql`${conversations.id}::text like ${`${prefix}%`}`))
    .limit(2);
  return found.length === 1 ? found[0]! : null;
}

const clip = (text: string, max: number) => (text.length <= max ? text : `${text.slice(0, max)} ... (${text.length - max} more characters)`);

// A message as plain text: what was written, and each command with what it printed.
function plain(parts: Record<string, any>[]) {
  return parts
    .flatMap((p): string[] => {
      if (p.type === "text") return [p.text];
      if (p.type === "file") return [`[attached: ${p.filename ?? "file"}]`];
      if (p.type === "tool-bash")
        return [`$ ${p.input?.command ?? ""}`, clip(String(p.output?.output ?? p.errorText ?? ""), 800)];
      return [];
    })
    .join("\n")
    .trim();
}

// `emplio export`: everything of one kind this person may see, one JSON object a line, for grep, jq and pipes on
// their computer (search output comes back only after a command ends, so it can't be piped).
// ponytail: newest EXPORT_MAX of each; page by date if a business outgrows that
const EXPORT_MAX = 20_000;
export async function exportRows(who: Who & { role: "owner" | "admin" | "member" }, kind: string) {
  if (kind === "chats") {
    const rows = await db
      .select({ chat: conversations.id, title: conversations.title, at: messages.createdAt, role: messages.role, parts: messages.parts })
      .from(messages)
      .innerJoin(conversations, eq(conversations.id, messages.conversationId))
      .where(mine(who))
      .orderBy(desc(messages.createdAt))
      .limit(EXPORT_MAX);
    return rows.map(({ parts, chat, ...r }) => ({ chat: chat.slice(0, 8), ...r, text: plain(parts as Record<string, any>[]) }));
  }
  if (kind === "activity") {
    const rows = await activityRows({ ...who, admin: who.role !== "member" }, [], EXPORT_MAX);
    return rows.map(({ total, id, conversationId, ...r }) => ({ id: id.slice(0, 8), ...r, chat: conversationId?.slice(0, 8) ?? null }));
  }
  if (kind === "tasks") return listTasks(who, {});
  return null;
}

const SHOW = 6;

// Messages of one chat, numbered: the SHOW around number n, or the last SHOW.
async function showChat(who: Who, chat: string, n?: number) {
  const c = await findChat(who, chat);
  if (!c) return `error: no chat of yours starts with ${chat}; find it with emplio history list or search`;
  const owner = who.everyone ? await db.query.users.findFirst({ where: eq(users.id, c.userId), columns: { name: true } }) : null;
  const rows = await db
    .select({ role: messages.role, parts: messages.parts, createdAt: messages.createdAt })
    .from(messages)
    .where(eq(messages.conversationId, c.id))
    .orderBy(asc(messages.createdAt));
  const from = n ? Math.max(0, n - 1 - Math.floor(SHOW / 2)) : Math.max(0, rows.length - SHOW);
  const shown = rows.slice(from, from + SHOW).map((m, i) => {
    const when = m.createdAt.toISOString().slice(0, 16).replace("T", " ");
    return `#${from + i + 1} ${m.role} ${when}\n${plain(m.parts as Record<string, any>[]) || "(nothing written)"}`;
  });
  return [`"${c.title}" (${c.id.slice(0, 8)})${whose(who, owner?.name ?? null)}, messages ${from + 1}-${from + shown.length} of ${rows.length}:`, "", shown.join("\n\n")].join("\n");
}

const HISTORY_USAGE = `usage: emplio history list                          your recent chats
       emplio history search <words> [--chat <id>]    find messages in your chats, newest first (every word must match)
       emplio history show <chat> [n]                 a chat's messages around number n (default: the latest)
       emplio history rename <chat> <title>           rename a chat
       emplio history remove <chat>                   delete a chat (not this one)
<chat> is the 8-character id the other commands print.`;

// `emplio history ...` from a chat, as text for the agent. Only the person's own chats.
export async function historyCommand(who: Who, conversationId: string, args: string[]) {
  const [sub, ...rest] = args;
  switch (sub) {
    case undefined:
    case "list": {
      const rows = await db
        .select({ id: conversations.id, title: conversations.title, updatedAt: conversations.updatedAt, name: users.name })
        .from(conversations)
        .innerJoin(users, eq(users.id, conversations.userId))
        .where(mine(who))
        .orderBy(desc(conversations.updatedAt))
        .limit(who.everyone ? 100 : 30);
      const tz = await timezoneOf(who.userId);
      return rows
        .map((r) => `${r.id.slice(0, 8)}\t${dayIn(r.updatedAt, tz)}\t${r.title}${whose(who, r.name)}${r.id === conversationId ? " (this chat)" : ""}`)
        .join("\n");
    }
    case "search": {
      const at = rest.indexOf("--chat");
      const chat = at >= 0 ? rest[at + 1] : undefined;
      const words = (at >= 0 ? [...rest.slice(0, at), ...rest.slice(at + 2)] : rest).join(" ");
      if (!words.trim()) break;
      const hits = await searchMessages(who, words, chat);
      if (!hits.length) return `Nothing matches "${words}"${chat ? ` in chat ${chat}` : ""}. Try fewer or other words.`;
      const more = (hits[0] as { total?: number }).total! - hits.length;
      return [
        ...hits.map(
          (h) =>
            `${h.conversationId.slice(0, 8)} #${h.n}\t${h.createdAt.slice(0, 10)}\t"${h.title}"${h.conversationId === conversationId ? " (this chat)" : ""}\t${h.role}: ${h.snippet.replace(/\s+/g, " ")}`,
        ),
        "",
        ...(more > 0 ? [`${more} more not shown: add words, or one chat with --chat <id>.`] : []),
        "Read one in full with emplio history show <chat> <n>.",
      ].join("\n");
    }
    case "similar": {
      const close = await similarWords(who, who.repos ?? [], rest.join(" "));
      return close.length ? `${close.join(", ")}  (spelled like that in your files or chats; search those too)` : "(none)";
    }
    case "show":
      if (!rest[0]) break;
      return showChat(who, rest[0], Number(rest[1]?.replace("#", "")) || undefined);
    case "rename": {
      const c = rest[0] ? await findChat({ ...who, everyone: false }, rest[0]) : null;
      const title = rest.slice(1).join(" ").trim().slice(0, 80);
      if (!c || !title) break;
      await db.update(conversations).set({ title }).where(eq(conversations.id, c.id));
      record({ ...who, conversationId: c.id, kind: "chat", summary: `Renamed chat "${c.title}" to "${title}"` });
      return `Renamed ${c.id.slice(0, 8)} to "${title}".`;
    }
    case "remove": {
      const c = rest[0] ? await findChat({ ...who, everyone: false }, rest[0]) : null;
      if (!c) break;
      if (c.id === conversationId) return "error: that's this chat; delete it from the chat list instead.";
      await stopBrowser(c.id);
      await db.delete(conversations).where(eq(conversations.id, c.id));
      record({ ...who, conversationId: c.id, kind: "chat", summary: `Deleted chat "${c.title}"` });
      return `Deleted "${c.title}".`;
    }
  }
  return HISTORY_USAGE;
}

export async function searchRoutes(app: FastifyInstance) {
  app.get<{ Querystring: { q?: string } }>("/search", async (req, reply) => {
    const ctx = await context(req, reply);
    if (!ctx) return;
    return searchChats(ctx, (req.query.q ?? "").slice(0, 200));
  });
}
