import type { Approval } from "@emplio/shared";
import { expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { approve, decide, outcome, waitingIn } from "./approvals";
import { withoutCards } from "./chat";
import { db } from "./db";
import { approvals, conversations, jobs, users, workspaces } from "./db/schema";
import type { Session } from "./sandbox";

test("an action that can't be looked up is refused, not run without an OK", async () => {
  let carded = false;
  const s = {
    workspaceId: crypto.randomUUID(),
    user: { id: crypto.randomUUID(), name: "Asha" },
    settings: { approvals: "ask" },
    notify: () => (carded = true),
  } as unknown as Session;
  expect(await approve(s, "no_such_app.send_email", {})).toContain("wasn't run");
  expect(carded).toBe(false);
});

test("an ask is kept on the server from the moment it's shown to how the action went, also for a job's card", async () => {
  const tag = crypto.randomUUID().slice(0, 8);
  const [ws] = await db.insert(workspaces).values({ name: `approvals-test-${tag}` }).returning();
  const [user] = await db.insert(users).values({ email: `approvals-test-${tag}@example.com` }).returning();
  const who = { workspaceId: ws!.id, userId: user!.id };
  try {
    const [main, jobChat] = [crypto.randomUUID(), crypto.randomUUID()];
    await db.insert(conversations).values([{ id: main, ...who, title: "main", kind: "main" }, { id: jobChat, ...who, title: "job", kind: "job" }]);
    await db.insert(jobs).values({ ...who, conversationId: main, chatId: jobChat, depth: 1, name: "send it" });
    const shown: Approval[] = [];
    const s = { conversationId: jobChat, workspaceId: ws!.id, user: { id: user!.id, name: "Asha" }, settings: { approvals: "ask" }, notify: (a: Approval) => shown.push(a) } as unknown as Session;
    const own = { title: "Send the invoice", readOnly: false, appName: "Mail", alwaysAsk: true, run: async () => {} };
    const row = (id: string) => db.query.approvals.findFirst({ where: eq(approvals.id, id) });

    // asked from a job: waiting, and shown in the chat the person is in
    const asked = approve(s, "mail.send", { to: "priya@acme.com" }, { own });
    while (!shown.length) await new Promise((r) => setTimeout(r, 10));
    const id = shown[0]!.id;
    expect(await row(id)).toMatchObject({ conversationId: jobChat, showIn: main, decision: null, result: null });
    expect(await waitingIn(main)).toBe(true);

    // allowed: the command goes on, and how it went lands on the card
    expect(await decide(id, ws!.id, user!.id, "once")).toBe(true);
    expect(await asked).toBeNull();
    expect(await waitingIn(main)).toBe(false);
    await outcome(shown, user!.id, { exitCode: 0, output: "error: the mailbox is full\nmore" });
    expect(await row(id)).toMatchObject({ decision: "once", result: { ok: false, text: "the mailbox is full" } });

    // denied: said so to Emplio, and nothing recorded as done
    const second = approve(s, "mail.send", {}, { own });
    while (shown.length < 3) await new Promise((r) => setTimeout(r, 10));
    const no = shown.at(-1)!.id;
    await decide(no, ws!.id, user!.id, "deny");
    expect(await second).toContain("said no");
    await outcome(shown, user!.id, { exitCode: 0, output: "fine" });
    expect(await row(no)).toMatchObject({ decision: "deny", result: null });
  } finally {
    await db.delete(workspaces).where(eq(workspaces.id, ws!.id));
    await db.delete(users).where(eq(users.id, user!.id));
  }
});

test("Emplio reads a command's result without its Allow cards", () => {
  expect(withoutCards({ exitCode: 0, output: "sent", approvals: [{ id: "1", decision: "once" }] })).toEqual({ exitCode: 0, output: "sent" });
  expect(withoutCards({ exitCode: 0, output: "sent" })).toEqual({ exitCode: 0, output: "sent" });
  expect(withoutCards("text")).toBe("text");
});
