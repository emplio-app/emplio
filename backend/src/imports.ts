// Bringing a person's memory over from another AI: Claude's or ChatGPT's data export, or an OpenClaw or Hermes
// home folder. The web app (/import) unzips or walks what they picked and sends only the files worth reading.
// What it knew (memory files, projects, skills, persona, schedules) is saved untouched to their own folder,
// me/imported/<source>/, in one commit; their old chats become archived chats of theirs (out of the sidebar,
// found by search and `emplio history`), once each however often it's imported. Then a task for the AI sorts
// the notes the way it sorts anything it learns: business facts to company/knowledge/, the person to their
// profile and preferences, procedures to their skills.
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { IMPORT_SOURCES, type ImportResult, type ImportSource } from "@emplio/shared";
import type { FastifyInstance } from "fastify";
import { record } from "./activity";
import { type Ctx, context, contextOf } from "./auth";
import { db } from "./db";
import { eq } from "drizzle-orm";
import { conversations, madeFiles, messages } from "./db/schema";
import { storeFile } from "./files";
import { recordMade } from "./made";
import { ensureRepo, writeFiles } from "./gitea";
import { addTask } from "./tasks";

// what the web app sends: text files as text, databases as base64
export type InFile = { path: string; text?: string; base64?: string };
type Msg = { role: "user" | "assistant"; text: string; at?: Date };
// what the AI made in the chat (Claude's artifacts and files), as it was at the end: they become Files (made.ts)
type Made = { name: string; type: string; content: string };
export type Chat = { key: string; title: string; messages: Msg[]; made?: Made[] };
export type Parsed = { notes: { path: string; content: string }[]; chats: Chat[] };

const MAX_BODY = 300 * 1024 * 1024;
// what an upload may grow to when opened: a tiny zip can otherwise expand until the server runs out of memory
const MAX_OPENED = 1024 ** 3;
export const readUpload = (zipped: Buffer, limit = MAX_OPENED) => JSON.parse(new TextDecoder().decode(gunzipSync(zipped, { maxOutputLength: limit })));

const when = (v: unknown) => {
  if (v == null || v === "") return undefined;
  const d = typeof v === "number" ? new Date(v < 1e12 ? v * 1000 : v) : new Date(String(v));
  return Number.isNaN(d.getTime()) ? undefined : d;
};
const role = (r: unknown) => (r === "user" || r === "human" ? "user" : r === "assistant" ? "assistant" : null);
// a message's words: a string, or the text parts of a list of content blocks
const words = (c: unknown): string =>
  typeof c === "string" ? c : Array.isArray(c) ? c.map((p) => (typeof p === "string" ? p : p?.type === "text" ? (p.text ?? "") : "")).join("\n") : "";
const msg = (r: unknown, text: string, at?: unknown): Msg[] => {
  const who = role(r);
  return who && text.trim() ? [{ role: who, text: text.trim(), at: when(at) }] : [];
};
// a safe file path inside the import folder
const clean = (p: string) =>
  p.split(/[\\/]+/).map((s) => s.replace(/[^\w .@()+-]/g, "_").trim()).filter((s) => s && !/^\.+$/.test(s)).join("/");

// Claude's export: memories/<account>.json, projects/<id>.json, conversations.json
function claudeJson(j: any, out: Parsed) {
  if (j?.memory_files || j?.conversations_memory) {
    if (j.conversations_memory) out.notes.push({ path: "summary.md", content: j.conversations_memory });
    for (const f of j.memory_files ?? []) if (f.content) out.notes.push({ path: clean(f.path), content: f.content });
  } else if (j?.docs && "prompt_template" in j) {
    if (j.is_starter_project) return;
    const dir = `projects/${clean(j.name || j.uuid)}`;
    out.notes.push({ path: `${dir}/README.md`, content: `# ${j.name}\n\n${j.description ?? ""}\n\n## Instructions\n\n${j.prompt_template || "(none)"}\n` });
    for (const d of j.docs) out.notes.push({ path: `${dir}/${clean(d.filename)}`, content: d.content ?? "" });
  } else if (Array.isArray(j) && j[0]?.chat_messages) {
    for (const c of j)
      out.chats.push({
        key: c.uuid,
        title: c.name || "Untitled",
        messages: c.chat_messages.flatMap((m: any) => msg(m.sender, m.text || words(m.content), m.created_at)),
        made: claudeMade(c.chat_messages),
      });
  }
  // ponytail: design chats (frames) skipped; they're design work, not memory
}

// artifact type → file extension (code by its language)
const EXT: Record<string, string> = { "text/markdown": "md", "text/html": "html", "image/svg+xml": "svg", "application/vnd.ant.react": "jsx", "application/vnd.ant.mermaid": "mmd" };
const CODE_EXT: Record<string, string> = { python: "py", javascript: "js", typescript: "ts", tsx: "tsx", jsx: "jsx", html: "html", css: "css", json: "json", sql: "sql", bash: "sh", shell: "sh", yaml: "yaml", markdown: "md", java: "java", go: "go", rust: "rs", ruby: "rb", php: "php", csharp: "cs", cpp: "cpp", c: "c", swift: "swift", kotlin: "kt" };
const TYPE: Record<string, string> = { md: "text/markdown", html: "text/html", svg: "image/svg+xml", json: "application/json", csv: "text/csv" };

// Claude's artifacts tool (create, then update with old_str/new_str, or rewrite) and its file tool (create_file),
// replayed to how each one ended
export function claudeMade(chatMessages: any[]): Made[] {
  const byId = new Map<string, { title: string; ext: string; content: string }>();
  for (const m of chatMessages)
    for (const b of Array.isArray(m?.content) ? m.content : []) {
      if (b?.type !== "tool_use") continue;
      const i = b.input ?? {};
      if (b.name === "artifacts" && i.id) {
        const had = byId.get(i.id);
        if (i.command === "update" && had && typeof i.old_str === "string") had.content = had.content.replace(i.old_str, i.new_str ?? "");
        else if (typeof i.content === "string")
          byId.set(i.id, {
            title: i.title || had?.title || i.id,
            ext: EXT[i.type] ?? (i.type === "application/vnd.ant.code" ? (CODE_EXT[String(i.language).toLowerCase()] ?? "txt") : had?.ext ?? "txt"),
            content: i.content,
          });
      } else if (b.name === "create_file" && typeof i.path === "string" && typeof i.file_text === "string") {
        const name = i.path.split("/").pop()!;
        byId.set(i.path, { title: name.replace(/\.[^.]+$/, ""), ext: name.includes(".") ? name.split(".").pop()! : "txt", content: i.file_text });
      }
    }
  return [...byId.values()].map((a) => ({
    name: `${clean(a.title).replace(/\//g, "-").slice(0, 80) || "file"}.${a.ext}`,
    type: TYPE[a.ext] ?? "text/plain",
    content: a.content,
  }));
}

// ChatGPT's export: conversations.json, each a tree of messages; the chat as last shown runs from current_node up
function chatgptJson(j: any, out: Parsed) {
  if (!Array.isArray(j) || !j[0]?.mapping) return;
  for (const c of j) {
    const line: Msg[] = [];
    for (let id = c.current_node; id && c.mapping[id]; id = c.mapping[id].parent) {
      const m = c.mapping[id].message;
      if (!m || m.metadata?.is_visually_hidden_from_conversation) continue;
      const text = (m.content?.parts ?? []).filter((p: unknown) => typeof p === "string").join("\n");
      line.unshift(...msg(m.author?.role, text, m.create_time));
    }
    out.chats.push({ key: c.conversation_id ?? c.id, title: c.title || "Untitled", messages: line });
  }
}

// OpenClaw's session transcripts: one event per line (old .jsonl files) or per row (openclaw-agent.sqlite)
const openclawEvent = (e: any): Msg[] => (e?.type === "message" ? msg(e.message?.role, words(e.message?.content), e.timestamp) : []);

function sqlite(path: string, bytes: Uint8Array, out: Parsed) {
  // an in-memory copy can't be in WAL mode: mark it a plain file (what's still only in the -wal file is missed,
  // so the app asks them to quit the agent first, which writes it back)
  if (bytes[18] === 2) bytes[18] = bytes[19] = 1;
  let d: Database;
  try {
    d = Database.deserialize(bytes, true);
  } catch (error) {
    return console.error(`import: couldn't open ${path}`, error);
  }
  try {
    const tables = new Set(d.query("select name from sqlite_master where type = 'table'").all().map((r: any) => r.name));
    // Hermes: state.db
    if (tables.has("sessions") && tables.has("messages")) {
      const byId = new Map<string, Chat>();
      for (const s of d.query("select id, title from sessions").all() as any[]) {
        const chat = { key: `hermes:${s.id}`, title: s.title || "Untitled", messages: [] };
        byId.set(s.id, chat);
        out.chats.push(chat);
      }
      for (const m of d.query("select session_id, role, content, timestamp from messages order by timestamp, id").all() as any[])
        byId.get(m.session_id)?.messages.push(...msg(m.role, words(m.content), m.timestamp));
    }
    // OpenClaw: agents/<agent>/agent/openclaw-agent.sqlite
    if (tables.has("transcript_events")) {
      const titles = new Map<string, string>();
      if (tables.has("session_nodes"))
        for (const n of d.query("select current_session_id, display_name from session_nodes").all() as any[]) titles.set(n.current_session_id, n.display_name);
      const byId = new Map<string, Chat>();
      for (const r of d.query("select session_id, event_json, event_zstd from transcript_events order by session_id, seq").all() as any[]) {
        let chat = byId.get(r.session_id);
        if (!chat) byId.set(r.session_id, (chat = { key: `openclaw:${r.session_id}`, title: titles.get(r.session_id) || "Untitled", messages: [] }));
        const json = r.event_json ?? (r.event_zstd ? new TextDecoder().decode(Bun.zstdDecompressSync(r.event_zstd)) : null);
        try {
          chat.messages.push(...openclawEvent(JSON.parse(json)));
        } catch {}
      }
      out.chats.push(...byId.values());
    }
    // OpenClaw: state/openclaw.sqlite's scheduled jobs, for the AI to suggest as automations
    if (tables.has("cron_jobs"))
      out.notes.push({ path: "cron-jobs.json", content: JSON.stringify(d.query("select name, description, enabled, job_json from cron_jobs").all(), null, 2) });
  } catch (error) {
    console.error(`import: couldn't read ${path}`, error);
  } finally {
    d.close();
  }
}

export function parse(source: ImportSource, files: InFile[]): Parsed {
  const out: Parsed = { notes: [], chats: [] };
  for (const f of files) {
    const name = f.path.split("/").pop()!.toLowerCase();
    if (f.base64 !== undefined) {
      sqlite(f.path, Buffer.from(f.base64, "base64"), out);
      continue;
    }
    const text = f.text ?? "";
    if (name.endsWith(".jsonl")) {
      const messages = text.split("\n").flatMap((l) => {
        try {
          return openclawEvent(JSON.parse(l));
        } catch {
          return [];
        }
      });
      out.chats.push({ key: `${source}:${f.path}`, title: name.replace(/\.jsonl$/, ""), messages });
    } else if (name.endsWith(".json")) {
      let j: unknown;
      try {
        j = JSON.parse(text);
      } catch {
        continue;
      }
      const before = out.notes.length + out.chats.length;
      if (source === "claude") claudeJson(j, out);
      else if (source === "chatgpt") chatgptJson(j, out);
      // anything else (OpenClaw's or Hermes's cron jobs, settings): kept as it is, for the AI to read
      if (out.notes.length + out.chats.length === before && source !== "claude" && source !== "chatgpt" && text.length < 200_000)
        out.notes.push({ path: clean(f.path), content: text });
    } else {
      // markdown, text, yaml: memory, persona, skills. Hermes separates memory entries with §.
      out.notes.push({ path: clean(f.path), content: source === "hermes" ? text.replace(/\n§\n/g, "\n\n") : text });
    }
  }
  out.chats = out.chats.filter((c) => c.messages.length);
  return out;
}

// the same chat imported again gets the same id, so it's saved once
const idFor = (userId: string, key: string) => {
  const h = createHash("sha256").update(`${userId}:${key}`).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
};

async function saveChats(ctx: Ctx, source: ImportSource, chats: Chat[]) {
  const now = new Date();
  let saved = 0;
  let count = 0;
  let made = 0;
  for (const c of chats) {
    const id = idFor(ctx.userId, `${source}:${c.key}`);
    const first = c.messages[0]!.at ?? now;
    const ids = c.messages.map((_, i) => `${id}-${i}`);
    const [row] = await db
      .insert(conversations)
      .values({
        id,
        workspaceId: ctx.workspaceId,
        userId: ctx.userId,
        title: `${c.title.slice(0, 150)} (${IMPORT_SOURCES[source]})`,
        headId: ids.at(-1)!,
        archivedAt: now,
        createdAt: first,
        updatedAt: c.messages.at(-1)!.at ?? first,
      })
      .onConflictDoNothing()
      .returning({ id: conversations.id });
    if (c.made?.length) made += await saveMade(ctx, id, c.made);
    if (!row) continue;
    const rows = c.messages.map((m, i) => ({
      id: ids[i]!,
      conversationId: id,
      role: m.role,
      parts: [{ type: "text", text: m.text }],
      parentId: i ? ids[i - 1]! : null,
      // undated messages keep their order: a microsecond apart after the chat's start
      createdAt: m.at ?? new Date(first.getTime() + i / 1000),
    }));
    for (let i = 0; i < rows.length; i += 500) await db.insert(messages).values(rows.slice(i, i + 500)).onConflictDoNothing();
    saved++;
    count += rows.length;
  }
  return { chats: saved, messages: count, made };
}

// a chat's artifacts into its Files, once: a chat imported again (or from before this) that already has some is left alone
async function saveMade(ctx: Ctx, conversationId: string, made: Made[]) {
  if (await db.query.madeFiles.findFirst({ where: eq(madeFiles.conversationId, conversationId), columns: { id: true } })) return 0;
  for (const f of made) {
    const body = new TextEncoder().encode(f.content);
    await recordMade(ctx, conversationId, await storeFile(ctx.workspaceId, f.name, f.type, body), body.length, f.content);
  }
  return made.length;
}

const sortingNotes = (ctx: Ctx, label: string, dir: string, chats: number) => `${ctx.userName} brought what ${label} knew about them. The original files are in me/${dir}/ (only ${ctx.userName} sees that folder; leave it as it is)${
  chats ? `, and ${chats} of their old ${label} chats are saved as their archived chats (\`emplio history search <words>\` finds them; skim them only for what the files don't already say)` : ""
}.
Sort it the way you sort anything you learn:
- The business's clients, their people, projects, services it sells and past meetings: records, not loose files. Look first (\`emplio clients list\`, \`emplio contacts list\` and the like; \`emplio search <name>\`), then add what's missing (\`emplio clients add "<name>"\`, \`emplio contacts add\`, \`emplio projects add\`, \`emplio services add\`, \`emplio meetings add\`; each one's help has the options) and put what was known about each in the notes file the command gives.
- Everything else about the business (people at work, suppliers, prices, decisions, how work is done): company/knowledge/, one file per person or topic.
- Either way: add to what's already there instead of making duplicates, and mark each line "(from ${label}, <date if known>)".
- About ${ctx.userName}: me/profile.md; how they like things done (including tone and rules from persona or instruction files like SOUL.md, AGENTS.md or custom instructions): me/preferences.md. Never company/AGENT.md.
- Their private life (family, health, personal money): me/notes/, never company files.
- Finance, HR or owner-only matters: restricted/ if you can see it, me/notes/ if not.
- Written procedures and skills: me/skillset/<name>/SKILL.md (frontmatter name and description), fixed up to work here.
- Scheduled jobs: don't make automations; list them for ${ctx.userName} as suggestions.
- Anything you're unsure about: me/notes/, marked unsure.
Old facts can be out of date: keep their dates; what the company files already say wins, and a real conflict goes to the owner.
When done, tell ${ctx.userName} in a few lines what you learned and where you put it.`;

export async function importMemory(ctx: Ctx, source: ImportSource, files: InFile[]): Promise<ImportResult | null> {
  const label = IMPORT_SOURCES[source];
  const { notes, chats } = parse(source, files);
  if (!notes.length && !chats.length) return null;
  const dir = `imported/${source}`;
  if (notes.length) {
    const repo = `me-${ctx.userId}`;
    await ensureRepo(ctx.workspaceId, repo, `${ctx.userName}'s own files`);
    await writeFiles(ctx.workspaceId, repo, notes.map((n) => ({ path: `${dir}/${n.path}`, content: n.content })), `Imported from ${label}`, {
      name: ctx.userName,
      email: ctx.userEmail,
    });
  }
  const saved = await saveChats(ctx, source, chats);
  const sorting = notes.length > 0 || saved.chats > 0;
  if (sorting) await addTask(ctx, { title: `Sort what ${ctx.userName} brought from ${label}`, notes: sortingNotes(ctx, label, dir, saved.chats) });
  record({
    workspaceId: ctx.workspaceId,
    userId: ctx.userId,
    kind: "files",
    summary: `Imported from ${label}: ${notes.length} files, ${saved.chats} chats`,
  });
  return { notes: notes.length, ...saved, sorting };
}

export async function importRoutes(app: FastifyInstance) {
  // gzipped JSON: { source, files }; Claude's chats alone are tens of megabytes before zipping. Kept zipped here: this
  // runs for any route, before anyone has signed in, so it's only opened below.
  app.addContentTypeParser("application/gzip", { parseAs: "buffer" }, (_req, body, done) => done(null, body));

  type Upload = { source: ImportSource; files: InFile[] };
  app.post<{ Body: Buffer | Upload }>(
    "/imports",
    {
      bodyLimit: MAX_BODY,
      // before the body is read: a stranger's upload never takes up memory
      onRequest: async (req) => {
        const ctx = await contextOf(req);
        if (typeof ctx === "string") throw Object.assign(new Error(ctx), { statusCode: ctx === "No workspace" ? 403 : 401 });
      },
    },
    async (req, reply) => {
      const ctx = await context(req, reply);
      if (!ctx) return;
      let body: Upload | null;
      try {
        body = Buffer.isBuffer(req.body) ? readUpload(req.body) : req.body;
      } catch {
        return reply.code(400).send({ error: "That upload couldn't be read, or it's too big." });
      }
      const { source, files } = body ?? ({} as Upload);
      if (!(source in IMPORT_SOURCES) || !Array.isArray(files)) return reply.code(400).send({ error: "Pick where it's coming from and the files." });
      const result = await importMemory(ctx, source, files);
      if (!result) return reply.code(400).send({ error: `Nothing from ${IMPORT_SOURCES[source]} found in those files. Check the steps above.` });
      return result;
    },
  );
}
