import { expect, test } from "bun:test";
import { parseNextStep, promises } from "./next-step";

const card = { summary: "Invoice sent to Acme, payment pending.", question: "Should I remind them on Friday?", buttons: ["Yes, remind them", "Not yet"] };

test("a well-formed card is read, even wrapped in a code fence", () => {
  expect(parseNextStep(JSON.stringify(card))).toEqual(card);
  expect(parseNextStep("```json\n" + JSON.stringify(card) + "\n```")).toEqual(card);
});

test("silence or a broken card shows nothing", () => {
  expect(parseNextStep("[SILENT]")).toBeNull();
  expect(parseNextStep('{"summary": "cut off')).toBeNull();
  expect(parseNextStep(JSON.stringify({ ...card, buttons: ["Only one"] }))).toBeNull();
  expect(parseNextStep(JSON.stringify({ ...card, question: "" }))).toBeNull();
});

test("a button that only promises an answer drops the card; a real go-ahead doesn't", () => {
  for (const b of ["Send the repo", "I'll share it", "I’ll type it", "Yes, I'll send them", "Share the link", "Tell you later", "Send my logo", "Name the repository"]) expect(promises(b)).toBe(true);
  for (const b of ["Yes, send it", "Send it", "Send the email", "Not yet", "Daily", "Weekly", "Yes, share it", "Yes, send them", "I'll decide later", "Let me think"]) expect(promises(b)).toBe(false);
  expect(parseNextStep(JSON.stringify({ ...card, buttons: ["Send the repo", "Not yet"] }))).toBeNull();
});

test("a reply's card is kept on its row: opening the chat later shows it, and closing it keeps it closed", async () => {
  const { db } = await import("./db");
  const { conversations, messages, users, workspaces } = await import("./db/schema");
  const { closeNextStep, nextStep } = await import("./chat");
  const { eq } = await import("drizzle-orm");
  const tag = crypto.randomUUID().slice(0, 8);
  const [ws] = await db.insert(workspaces).values({ name: `next-step-test-${tag}` }).returning();
  const [user] = await db.insert(users).values({ email: `next-step-test-${tag}@example.com` }).returning();
  try {
    const chat = crypto.randomUUID();
    await db.insert(conversations).values({ id: chat, workspaceId: ws!.id, userId: user!.id, title: "t", kind: "main" });
    const card = { summary: "The email to Sarah is drafted.", question: "Send it now?", buttons: ["Yes, send it", "Not yet"] };
    await db.insert(messages).values([
      { id: `u-${tag}`, conversationId: chat, role: "user", parts: [{ type: "text", text: "draft it" }] },
      { id: `a-${tag}`, conversationId: chat, role: "assistant", parts: [{ type: "text", text: "Drafted. Send it?" }], parentId: `u-${tag}`, nextStep: { card } },
    ]);
    await db.update(conversations).set({ headId: `a-${tag}` }).where(eq(conversations.id, chat));
    const bill = { workspaceId: ws!.id, userId: user!.id, conversationId: chat };
    expect(await nextStep(bill)).toEqual(card);
    await closeNextStep(chat);
    expect(await nextStep(bill)).toBeNull();
  } finally {
    await db.delete(workspaces).where(eq(workspaces.id, ws!.id));
    await db.delete(users).where(eq(users.id, user!.id));
  }
});

test("a cache mark on an assistant message goes inside its text, where OpenRouter passes it on", async () => {
  const { markInText } = await import("./models");
  const cc = { type: "ephemeral" };
  const sent = JSON.stringify({ messages: [{ role: "user", content: "hi" }, { role: "assistant", content: "Hello", cache_control: cc }] });
  expect(JSON.parse(markInText(sent)).messages[1]).toEqual({ role: "assistant", content: [{ type: "text", text: "Hello", cache_control: cc }] });
  // nothing marked: the body goes as it was
  const plain = JSON.stringify({ messages: [{ role: "assistant", content: "Hello" }], cache_control: cc });
  expect(markInText(plain)).toBe(plain);
});
