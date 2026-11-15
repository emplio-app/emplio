import { afterAll, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { addMessage } from "./chat";
import { db } from "./db";
import { conversations, messages, users, workspaces } from "./db/schema";

// against the local database: a throwaway business
const tag = crypto.randomUUID().slice(0, 8);
const [ws] = await db.insert(workspaces).values({ name: `add-message-test-${tag}` }).returning();
const [user] = await db.insert(users).values({ email: `add-message-test-${tag}@example.com` }).returning();
afterAll(async () => {
  await db.delete(workspaces).where(eq(workspaces.id, ws!.id));
  await db.delete(users).where(eq(users.id, user!.id));
});

test("a reply with a binary file's NUL in a command's output is still saved", async () => {
  const chat = crypto.randomUUID();
  await db.insert(conversations).values({ id: chat, workspaceId: ws!.id, userId: user!.id, title: "t", kind: "main" });
  const id = `${chat}-a`;
  const part = (text: string) => ({ type: "tool-bash", output: { output: `PK\0\0${text}` } });
  await addMessage(chat, { id, role: "assistant", parts: [part("first")] });
  await addMessage(chat, { id, role: "assistant", parts: [part("final"), { type: "text", text: "Done." }] });
  const saved = await db.query.messages.findFirst({ where: eq(messages.id, id) });
  expect(saved!.parts).toEqual([{ type: "tool-bash", output: { output: "PKfinal" } }, { type: "text", text: "Done." }]);
});

test("a reply's late save doesn't push the message after it out of the chat", async () => {
  const chat = crypto.randomUUID();
  await db.insert(conversations).values({ id: chat, workspaceId: ws!.id, userId: user!.id, title: "t", kind: "main" });
  const reply = { id: `${chat}-r`, role: "assistant" as const, parts: [{ type: "text", text: "Working" }] };
  await addMessage(chat, reply);
  await addMessage(chat, { id: `${chat}-m`, role: "user", parts: [{ type: "text", text: "Also this" }] });
  await addMessage(chat, { ...reply, parts: [{ type: "text", text: "Done." }] });
  const c = await db.query.conversations.findFirst({ where: eq(conversations.id, chat) });
  expect(c!.headId).toBe(`${chat}-m`);
});
