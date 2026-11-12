// Files: what the AI employee made, and what people attached to chats. Everything it puts in /work/out lands
// here (sandbox.ts collectOut) as well as in the chat; made again under the same name in the same chat, it's the
// next version of that file, not a new one. Attachments land here when they're sent (recordUploads), each its
// own file, and get their words once Emplio's computer has opened them (uploadRead). The Files page, `emplio files` and the share links all go through these functions.
// The person whose chat made it sees it; the owner and admins see everyone's (like chats).
// Share links (/s/<token>) open the file for anyone, signed in or not, until it's unshared. They redirect to
// our storage's own short-lived link, so an HTML page made here runs on storage's address, never on ours.
import type { MadeFile, Role } from "@emplio/shared";
import { and, desc, eq, inArray, sql, type SQL } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { record } from "./activity";
import { context } from "./auth";
import { db } from "./db";
import { conversations, madeFiles } from "./db/schema";
import { isOwnFile, removeStored, storedLink, storedSize } from "./files";
import { toQuery } from "./search";
import { listTeam } from "./team";
import { cloud } from "./cloud";

type Who = { workspaceId: string; userId: string; role: Role };
type Row = typeof madeFiles.$inferSelect;
export type Saved = { url: string; filename: string; mediaType: string; id?: string };

const MAX_TEXT = 200_000;
const isAdmin = (w: Who) => w.role !== "member";
// reachable from outside: a client opens it on their phone
const apiUrl = () => process.env.PUBLIC_API_URL ?? process.env.WEBHOOK_URL ?? `http://localhost:${process.env.PORT ?? 4000}`;
const shareUrl = (token: string | null) => (token ? `${apiUrl()}/s/${token}` : null);

async function toMade(rows: Row[], workspaceId: string): Promise<MadeFile[]> {
  if (!rows.length) return [];
  const names = new Map((await listTeam(workspaceId)).map((m) => [m.id, m.name ?? m.email]));
  const ids = [...new Set(rows.map((r) => r.conversationId).filter((x): x is string => !!x))];
  const titles = new Map(
    ids.length
      ? (await db.select({ id: conversations.id, title: conversations.title }).from(conversations).where(inArray(conversations.id, ids))).map((c) => [c.id, c.title])
      : [],
  );
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    mediaType: r.mediaType,
    url: r.url,
    size: r.size,
    version: r.version,
    conversationId: r.conversationId,
    conversationTitle: (r.conversationId && titles.get(r.conversationId)) || null,
    userName: r.userId ? (names.get(r.userId) ?? "(left the team)") : null,
    previewUrl: r.previewUrl,
    source: r.source,
    shareUrl: shareUrl(r.shareToken),
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  }));
}

const visible = (w: Who): SQL | undefined => and(eq(madeFiles.workspaceId, w.workspaceId), isAdmin(w) ? undefined : eq(madeFiles.userId, w.userId));

// newest first; `words`: in the name or the document's words (every word, any case, word starts count)
export async function listMade(w: Who, words?: string, limit = 200, source?: Row["source"]) {
  const query = words ? toQuery(words) : null;
  if (words && !query) return [];
  const rows = await db
    .select()
    .from(madeFiles)
    .where(and(visible(w), source && eq(madeFiles.source, source), query ? sql`${madeFiles.search} @@ to_tsquery('simple', ${query})` : undefined))
    .orderBy(desc(madeFiles.updatedAt))
    .limit(limit);
  return toMade(rows, w.workspaceId);
}

// by its id or the first 8 characters of it
const find = (w: Who, id: string) => db.query.madeFiles.findFirst({ where: and(visible(w), sql`${madeFiles.id}::text like ${`${id.toLowerCase()}%`}`) });

export async function getMade(w: Who, id: string) {
  const row = await find(w, id);
  return row ? { ...(await toMade([row], w.workspaceId))[0]!, text: row.text } : null;
}

// A file from out/, already stored: a new file, or the next version of the one this chat made under that name.
// `preview`: a Word or PowerPoint file's PDF copy, already stored
export async function recordMade(w: Who, conversationId: string, f: Saved, size: number, text: string, preview?: string) {
  const values = { url: f.url, mediaType: f.mediaType, size, text: text.slice(0, MAX_TEXT), previewUrl: preview ?? null, updatedAt: new Date() };
  const same = await db.query.madeFiles.findFirst({
    where: and(eq(madeFiles.workspaceId, w.workspaceId), eq(madeFiles.conversationId, conversationId), eq(madeFiles.name, f.filename), eq(madeFiles.source, "made")),
  });
  if (same) {
    await db.update(madeFiles).set({ ...values, version: same.version + 1 }).where(eq(madeFiles.id, same.id));
    return same.id;
  }
  const [row] = await db.insert(madeFiles).values({ ...values, workspaceId: w.workspaceId, userId: w.userId, conversationId, name: f.filename }).returning({ id: madeFiles.id });
  cloud.onWork(w.workspaceId, w.userId, "file");
  return row!.id;
}

// Files attached to a message, as they're sent: each one its own file (same name twice is two files), seen by
// whoever sees the chat. Their words come later, from Emplio's computer (uploadRead).
export async function recordUploads(w: Who, conversationId: string, files: { url: string; filename?: string; mediaType: string }[]) {
  for (const f of files) {
    const size = await storedSize(f.url).catch(() => null);
    if (size === null) continue;
    await db
      .insert(madeFiles)
      .values({ workspaceId: w.workspaceId, userId: w.userId, conversationId, source: "upload", name: (f.filename || f.url.split("/").pop() || "file").slice(0, 200), mediaType: f.mediaType, url: f.url, size })
      .onConflictDoNothing();
  }
}

// An attachment's words and Word/PowerPoint preview, once its copy on Emplio's computer has been read
export async function uploadRead(workspaceId: string, url: string, text: string, preview?: string) {
  await db
    .update(madeFiles)
    .set({ text: text.slice(0, MAX_TEXT), ...(preview && { previewUrl: preview }) })
    .where(and(eq(madeFiles.workspaceId, workspaceId), eq(madeFiles.url, url), eq(madeFiles.source, "upload")));
}

// an attachment not read yet: its words still to fetch
export const uploadUnread = async (workspaceId: string, url: string) =>
  !!(await db.query.madeFiles.findFirst({
    columns: { id: true },
    where: and(eq(madeFiles.workspaceId, workspaceId), eq(madeFiles.url, url), eq(madeFiles.source, "upload"), eq(madeFiles.text, ""), sql`${madeFiles.previewUrl} is null`),
  }));

export async function renameMade(w: Who, id: string, name: string) {
  const row = await find(w, id);
  if (!row) return `no file ${id}`;
  if (!name.trim() || name.includes("/")) return "a name can't be empty or have a /";
  await db.update(madeFiles).set({ name: name.trim().slice(0, 200), updatedAt: new Date() }).where(eq(madeFiles.id, row.id));
  return null;
}

export async function removeMade(w: Who, id: string, conversationId?: string) {
  const row = await find(w, id);
  if (!row) return `no file ${id}`;
  await db.delete(madeFiles).where(eq(madeFiles.id, row.id));
  // ponytail: only the newest version's bytes go; older ones stay where earlier chat messages show them
  await removeStored(row.url).catch(() => {});
  if (row.previewUrl) await removeStored(row.previewUrl).catch(() => {});
  record({ workspaceId: w.workspaceId, userId: w.userId, conversationId, kind: "files", summary: `Removed file ${row.name}` });
  return null;
}

// on: the link (the same one again if it's already shared); off: the old link stops working
export async function shareMade(w: Who, id: string, on: boolean, conversationId?: string) {
  const row = await find(w, id);
  if (!row) return { error: `no file ${id}` };
  const token = on ? (row.shareToken ?? crypto.randomUUID().replaceAll("-", "")) : null;
  if (token !== row.shareToken) {
    await db.update(madeFiles).set({ shareToken: token }).where(eq(madeFiles.id, row.id));
    record({ workspaceId: w.workspaceId, userId: w.userId, conversationId, kind: "files", summary: `${on ? "Shared" : "Stopped sharing"} file ${row.name}` });
  }
  return { url: shareUrl(token) };
}

const USAGE = `usage: emplio files list                       what you've made, newest first (with each one's id)
       emplio files search <words>             by name or the words inside
       emplio files show <id>                  put it in this chat again, to see or download
       emplio files get <id>                   a copy in /work/tmp/files/ to read, edit or attach
       emplio files rename <id> <new name>
       emplio files share <id>                 a link anyone can open, no sign-in (for clients); unshare <id> stops it
       emplio files remove <id>
Files you put in /work/out/ are added here on their own; the same name again in the same chat is its next version.`;

const size = (n: number) => (n < 1024 ? `${n} B` : n < 1024 ** 2 ? `${Math.round(n / 1024)} KB` : `${(n / 1024 ** 2).toFixed(1)} MB`);
const line = (f: MadeFile) =>
  [f.id.slice(0, 8), f.name, size(f.size), f.version > 1 ? `v${f.version}` : "", f.updatedAt.slice(0, 10), f.conversationTitle ? `from "${f.conversationTitle}"` : "", f.shareUrl ? "shared" : ""]
    .filter(Boolean)
    .join("\t");

// `get`: copies the file into the box and says where
export async function filesCommand(
  w: Who,
  conversationId: string,
  args: string[],
  get: (f: MadeFile) => Promise<string>,
): Promise<string | { text: string; shown: Saved }> {
  const [sub, ...rest] = args;
  if (sub === "list" || (sub === "search" && rest.length)) {
    const list = await listMade(w, sub === "search" ? rest.join(" ") : undefined, 30);
    return list.length ? list.map(line).join("\n") : sub === "search" ? "No files match." : "Nothing made yet.";
  }
  const id = rest[0];
  if (!id) return USAGE;
  const f = await getMade(w, id);
  if (!f) return `error: no file ${id} (emplio files list)`;
  if (sub === "show") return { text: `Shown in the chat: ${f.name}. Don't write a link or path to it.`, shown: { id: f.id, url: f.url, filename: f.name, mediaType: f.mediaType } };
  if (sub === "get") return get(f);
  if (sub === "rename" && rest.length > 1) {
    const error = await renameMade(w, f.id, rest.slice(1).join(" "));
    return error ? `error: ${error}` : "renamed";
  }
  if (sub === "share" || sub === "unshare") {
    const r = await shareMade(w, f.id, sub === "share", conversationId);
    return "error" in r ? `error: ${r.error}` : r.url ? `Anyone with this link can open ${f.name}: ${r.url}` : `${f.name} isn't shared any more; the old link stops working.`;
  }
  if (sub === "remove") {
    const error = await removeMade(w, f.id, conversationId);
    return error ? `error: ${error}` : "removed";
  }
  return USAGE;
}

export async function madeRoutes(app: FastifyInstance) {
  app.get<{ Querystring: { q?: string; from?: string } }>("/made", async (req, reply) => {
    const ctx = await context(req, reply);
    if (!ctx) return;
    const from = req.query.from;
    return listMade(ctx, req.query.q?.trim() || undefined, 200, from === "made" || from === "upload" ? from : undefined);
  });

  // A file shown in a chat from before Files existed: recorded the first time it's opened, so it can be shared
  // too. Its words weren't kept, so it has no text preview.
  app.post<{ Body: { url: string; name: string; mediaType: string; conversationId: string } }>(
    "/made/adopt",
    {
      schema: {
        body: {
          type: "object",
          required: ["url", "name", "mediaType", "conversationId"],
          properties: { url: { type: "string", maxLength: 500 }, name: { type: "string", minLength: 1, maxLength: 200 }, mediaType: { type: "string", maxLength: 200 }, conversationId: { type: "string", format: "uuid" } },
        },
      },
    },
    async (req, reply) => {
      const ctx = await context(req, reply);
      if (!ctx) return;
      const { url, name, mediaType, conversationId } = req.body;
      if (!isOwnFile(url, ctx.workspaceId)) return reply.code(404).send({ error: "Not found" });
      const known = await db.query.madeFiles.findFirst({ where: and(eq(madeFiles.workspaceId, ctx.workspaceId), eq(madeFiles.url, url)) });
      if (known) return (await getMade(ctx, known.id)) ?? reply.code(404).send({ error: "Not found" });
      // whose chat it was decides who sees it, as for files made now
      const chat = await db.query.conversations.findFirst({ where: and(eq(conversations.id, conversationId), eq(conversations.workspaceId, ctx.workspaceId)) });
      if (!chat || (!isAdmin(ctx) && chat.userId !== ctx.userId)) return reply.code(404).send({ error: "Not found" });
      const size = await storedSize(url).catch(() => null);
      if (size === null) return reply.code(404).send({ error: "That file is gone" });
      const [row] = await db
        .insert(madeFiles)
        .values({ workspaceId: ctx.workspaceId, userId: chat.userId, conversationId, name, mediaType, url, size })
        .returning({ id: madeFiles.id });
      return getMade(ctx, row!.id);
    },
  );

  // with its words, for the text preview of Word, Excel and PowerPoint files
  app.get<{ Params: { id: string } }>("/made/:id", async (req, reply) => {
    const ctx = await context(req, reply);
    if (!ctx) return;
    return (await getMade(ctx, req.params.id)) ?? reply.code(404).send({ error: "Not found" });
  });

  app.patch<{ Params: { id: string }; Body: { name: string } }>(
    "/made/:id",
    { schema: { body: { type: "object", required: ["name"], properties: { name: { type: "string", minLength: 1, maxLength: 200 } } } } },
    async (req, reply) => {
      const ctx = await context(req, reply);
      if (!ctx) return;
      const error = await renameMade(ctx, req.params.id, req.body.name);
      return error ? reply.code(400).send({ error }) : { ok: true };
    },
  );

  app.delete<{ Params: { id: string } }>("/made/:id", async (req, reply) => {
    const ctx = await context(req, reply);
    if (!ctx) return;
    const error = await removeMade(ctx, req.params.id);
    return error ? reply.code(404).send({ error }) : { ok: true };
  });

  app.post<{ Params: { id: string } }>("/made/:id/share", async (req, reply) => {
    const ctx = await context(req, reply);
    if (!ctx) return;
    const r = await shareMade(ctx, req.params.id, true);
    return "error" in r ? reply.code(404).send(r) : r;
  });

  app.delete<{ Params: { id: string } }>("/made/:id/share", async (req, reply) => {
    const ctx = await context(req, reply);
    if (!ctx) return;
    const r = await shareMade(ctx, req.params.id, false);
    return "error" in r ? reply.code(404).send(r) : r;
  });

  // public: no sign-in, the token is the key
  app.get<{ Params: { token: string }; Querystring: { download?: string } }>("/s/:token", async (req, reply) => {
    if (!/^[0-9a-f]{32}$/.test(req.params.token)) return reply.code(404).send({ error: "Not found" });
    const row = await db.query.madeFiles.findFirst({ where: eq(madeFiles.shareToken, req.params.token) });
    if (!row) return reply.code(404).type("text/plain").send("This link doesn't work any more.");
    return reply.header("cache-control", "no-store").redirect(storedLink(row.url, req.query.download !== undefined ? row.name : undefined));
  });
}
