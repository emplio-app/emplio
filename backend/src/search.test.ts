import { afterAll, expect, test } from "bun:test";
import { eq, inArray } from "drizzle-orm";
import { db } from "./db";
import { conversations, fileIndex, messages, users, workspaces } from "./db/schema";
import { searchChats, similarWords } from "./search";

// against the local database: a throwaway business with two people
const tag = crypto.randomUUID().slice(0, 8);
const [ws] = await db.insert(workspaces).values({ name: `search-test-${tag}` }).returning();
const [me, other] = await db.insert(users).values([{ email: `me-${tag}@test.local` }, { email: `other-${tag}@test.local` }]).returning();
const chat = (userId: string) => ({ id: crypto.randomUUID(), workspaceId: ws!.id, userId, title: "t" });
const [mine, theirs, titled, theirTitled] = await db
  .insert(conversations)
  .values([chat(me!.id), chat(other!.id), { ...chat(me!.id), title: "Install PostHog MCP" }, { ...chat(other!.id), title: "PostHog numbers" }])
  .returning();
const say = (conversationId: string, role: "user" | "assistant", text: string) => ({ id: crypto.randomUUID(), conversationId, role, parts: [{ type: "text", text }] });
await db.insert(messages).values([
  say(mine!.id, "user", "Mail Mahesh Aathavale the documents"),
  say(mine!.id, "assistant", "Sent to Mahesh Athawalle"),
  say(theirs!.id, "user", "Call Rishabh Jainn"),
  say(mine!.id, "user", "Check the PostHog sign-in figures"),
  say(titled!.id, "user", "Set up posthog for me"),
]);
await db.insert(fileIndex).values({ workspaceId: ws!.id, repo: "restricted", path: "rent.md", sha: "x", text: "Rent to Rishabh Jain" });
afterAll(async () => {
  await db.delete(workspaces).where(eq(workspaces.id, ws!.id));
  await db.delete(users).where(inArray(users.id, [me!.id, other!.id]));
});

const who = { workspaceId: ws!.id, userId: me!.id };

test("close spellings come from the person's own words and the repos they may see", async () => {
  // their own message, not the agent's
  expect(await similarWords(who, ["company"], "Athavale")).toEqual(["athavale → aathavale"]);
  // restricted only when allowed; another person's chat never
  expect(await similarWords(who, ["company"], "Rishab")).toEqual([]);
  expect(await similarWords(who, ["company", "restricted"], "Rishab")).toEqual(["rishab → rishabh"]);
  // the background agent reads everyone's chats
  expect(await similarWords({ ...who, everyone: true }, [], "Jain")).toEqual(["jain → jainn"]);
  // exact words and short ones aren't suggested
  expect(await similarWords(who, ["company"], "aathavale doc")).toEqual([]);
});

test("the sidebar's search lists chats whose title matches first, each once", async () => {
  const hits = await searchChats(who, "posthog");
  // the titled chat on top, without its own message again; then the message from the other chat; never someone else's chat
  expect(hits.map((h) => [h.conversationId, h.messageId ? "message" : "title"])).toEqual([
    [titled!.id, "title"],
    [mine!.id, "message"],
  ]);
  expect(hits.some((h) => h.conversationId === theirTitled!.id)).toBe(false);
});
