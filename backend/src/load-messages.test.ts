import { afterAll, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { chatFiles, loadMessages } from "./chat";
import { db } from "./db";
import { conversations, messages, users, workspaces } from "./db/schema";

// against the local database: a throwaway business
const tag = crypto.randomUUID().slice(0, 8);
const [ws] = await db.insert(workspaces).values({ name: `load-messages-test-${tag}` }).returning();
const [user] = await db.insert(users).values({ email: `load-messages-test-${tag}@example.com` }).returning();
afterAll(async () => {
  await db.delete(workspaces).where(eq(workspaces.id, ws!.id));
  await db.delete(users).where(eq(users.id, user!.id));
});

test("a reply reads the chat from where its notes end; versions and old files still come through", async () => {
  const chat = crypto.randomUUID();
  await db.insert(conversations).values({ id: chat, workspaceId: ws!.id, userId: user!.id, title: "t", kind: "main" });
  const file = { type: "file" as const, url: `/files/${ws!.id}/${crypto.randomUUID()}/a.pdf`, filename: "a.pdf", mediaType: "application/pdf" };
  const text = (t: string) => [{ type: "text" as const, text: t }];
  // u1 a1 u2 a2, with u2 edited into u2b (same spot) and the chat going on from u2b
  const rows = [
    ["u1", "user", null, [file]],
    ["a1", "assistant", "u1", text("one")],
    ["u2", "user", "a1", text("two")],
    ["a2", "assistant", "u2", text("old")],
    ["u2b", "user", "a1", text("two again")],
    ["a2b", "assistant", "u2b", text("new")],
  ] as const;
  for (const [i, [id, role, parent, parts]] of rows.entries())
    await db.insert(messages).values({ id: `${chat}-${id}`, conversationId: chat, role, parentId: parent && `${chat}-${parent}`, parts, createdAt: new Date(Date.UTC(2026, 0, 1, 0, i)) });
  await db.update(conversations).set({ headId: `${chat}-a2b` }).where(eq(conversations.id, chat));
  const ids = (ms: { id: string }[]) => ms.map((m) => m.id.slice(chat.length + 1));

  const all = await loadMessages(chat);
  expect(ids(all)).toEqual(["u1", "a1", "u2b", "a2b"]);
  expect((all[2]!.metadata as { versions: string[] }).versions.map((v) => v.slice(chat.length + 1))).toEqual(["u2", "u2b"]);
  expect(all[0]!.parts).toEqual([file]);
  // notes up to a1: a1 on, parts and versions intact
  const recent = await loadMessages(chat, `${chat}-a1`);
  expect(ids(recent)).toEqual(["a1", "u2b", "a2b"]);
  expect(recent[2]!.parts).toEqual(text("new"));
  // notes from the other version: not on this path, so the whole chat
  expect(ids(await loadMessages(chat, `${chat}-a2`))).toEqual(["u1", "a1", "u2b", "a2b"]);
  // files attached before the notes still reach the computer
  expect(await chatFiles(chat, ws!.id)).toEqual([{ url: file.url, filename: "a.pdf" }]);
});
