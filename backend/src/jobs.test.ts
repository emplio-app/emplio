import { expect, test } from "bun:test";
import { FROM_EMPLIO, runRef, splitRef, type Approval } from "@emplio/shared";
import { eq } from "drizzle-orm";
import { notCounted, refusal, remindAt } from "./chat";
import { db } from "./db";
import { conversations, jobs, messages, users, workspaceMembers, workspaces } from "./db/schema";
import { agentNudge, cardsIn, closeTo, EMPLIO, jobReply, jobsCommand, recordedLine, reportGoes, reportsNote, runSpan, threadsNote, untoldNote, untoldReports } from "./jobs";
import { SILENT } from "./reader";

const card = (id: string, decision?: Approval["decision"]) => ({ id, ...(decision && { decision }) }) as Approval;
const output = (...approvals: Approval[]) => ({ type: "tool-output-available", output: { approvals } });

test("a job's card goes to the phone once, and comes off once answered", () => {
  const shown = new Set<string>();
  expect(cardsIn(output(card("a")), shown).ask.map((a) => a.id)).toEqual(["a"]);
  // the command yields its cards again each time something changes
  expect(cardsIn(output(card("a"), card("b")), shown).ask.map((a) => a.id)).toEqual(["b"]);
  const { ask, answered } = cardsIn(output(card("a", "once"), card("b")), shown);
  expect(ask).toEqual([]);
  expect(answered.map((a) => a.id)).toEqual(["a"]);
  expect(cardsIn(output(card("a", "once")), shown).answered).toEqual([]);
  expect(cardsIn({ type: "text-delta" }, shown)).toEqual({ ask: [], answered: [] });
});

test("a report wakes Emplio only when it's waiting on the job and the job has finished", () => {
  const end = { depth: 1, stopped: false, owed: true, interrupted: false };
  expect(reportGoes(end)).toBe("wake");
  // "hi" in the job's chat, or new work the person gave it there
  expect(reportGoes({ ...end, owed: false })).toBe("untold");
  // a message is waiting to go in: the final report comes later, once
  expect(reportGoes({ ...end, interrupted: true })).toBe("untold");
  expect(reportGoes({ ...end, stopped: true })).toBe("nowhere");
  expect(reportGoes({ ...end, depth: 2 })).toBe("nowhere");
});

test("Emplio doesn't sit waiting in a chat with the person; runs nobody watches still can", async () => {
  const who = { workspaceId: crypto.randomUUID(), userId: crypto.randomUUID() };
  const chat = crypto.randomUUID();
  expect((await jobsCommand(who, chat, ["wait"], EMPLIO, true)).text).toContain("end your reply");
  expect((await jobsCommand(who, chat, ["wait"], EMPLIO)).text).toBe("None of your threads are running.");
});

test("Emplio can't notify itself, and a long report is cut short in its note", async () => {
  const who = { workspaceId: crypto.randomUUID(), userId: crypto.randomUUID() };
  expect((await jobsCommand(who, crypto.randomUUID(), ["notify", "hello"], EMPLIO)).text).toContain("you are Emplio");
  const note = untoldNote(["x".repeat(5000), "short"]);
  expect(note.length).toBeLessThan(2000);
  expect(note).toContain("short");
});

test("a report carries the server's record of what the job sent, and nothing when it sent nothing", () => {
  expect(recordedLine([], "Asia/Kolkata")).toBe("");
  const at = new Date("2026-11-05T10:11:00Z");
  const line = recordedLine(
    [
      { action: "gmail.reply_to_thread", ok: true, error: null, createdAt: at },
      { action: "gmail.send_email", ok: false, error: "no such thread", createdAt: at },
    ],
    "Asia/Kolkata",
  );
  expect(line).toContain("gmail.reply_to_thread ok");
  expect(line).toContain("gmail.send_email failed (no such thread)");
  expect(line).toContain("3:41");
});

test("the hand-off reminder comes at 2 commands, then every 15", () => {
  const at = Array.from({ length: 40 }, (_, i) => i + 1).filter(remindAt);
  expect(at).toEqual([2, 17, 32]);
});

test("Emplio has no browser, but a brief may mention it; nothing else is refused", () => {
  expect(refusal("emplio browser open https://x.example", 1)).toBeTruthy();
  expect(refusal("emplio logins list; emplio browser snapshot -i", 1)).toBeTruthy();
  expect(refusal("emplio hand \"Price Checker\" <<'EOF'\nOpen it with emplio browser\nEOF", 1)).toBeNull();
  expect(refusal("python go.py", 40)).toBeNull();
});

test("hand-offs and the checklist aren't counted as work done by hand", () => {
  for (const open of ["emplio hand myself <<'EOF'\nbrief\nEOF", "emplio threads wait", "emplio plan done", "emplio report \"broken\""]) expect(notCounted(open)).toBe(true);
  for (const work of ["emplio web read https://x.com", "python go.py", "emplio browser open https://x.com", "cat handoff.md"]) expect(notCounted(work)).toBe(false);
});

test("reports say what's still running; Emplio may stay quiet after sending work back, or while the rest is coming", () => {
  expect(reportsNote(["r"], [], false)).toContain(`send work back to a job (it isn't done) or answer its question, there's nothing new for them: write no words before or after the command, just end with exactly ${SILENT}`);
  const note = reportsNote(["r"], ["find-invoices"], false);
  expect(note).toContain("Still running: find-invoices");
  expect(note).toContain(`only a piece the others complete (one half of a comparison, one part of a single file or answer), end instead with exactly ${SILENT}`);
});

// against the local database, with no model: a throwaway business and a job's reply starting and ending
test("chatting in a job's chat stays quiet until Emplio's next reply; answering its question doesn't", async () => {
  const tag = crypto.randomUUID().slice(0, 8);
  const [ws] = await db.insert(workspaces).values({ name: `jobs-test-${tag}` }).returning();
  const [user] = await db.insert(users).values({ email: `jobs-test-${tag}@example.com` }).returning();
  const who = { workspaceId: ws!.id, userId: user!.id };
  try {
    const main = crypto.randomUUID();
    const chatId = crypto.randomUUID();
    await db.insert(conversations).values([{ id: main, ...who, title: "main", kind: "main" }, { id: chatId, ...who, title: "job", kind: "job" }]);
    await db.insert(jobs).values({ ...who, conversationId: main, chatId, depth: 1, name: "check", status: "done", report: "first" });
    const reply = async (answer: string) => (await (await jobReply(chatId))!.began(() => {}))(answer, "completed");

    await reply("hello, how are you");
    expect(await untoldReports(main)).toContain("hello, how are you");
    expect(await untoldReports(main)).toBeNull();

    await reply("Question: which account?");
    await untoldReports(main);
    await db.update(jobs).set({ status: "asking" }).where(eq(jobs.chatId, chatId));
    await reply("Used the work account.");
    expect(await untoldReports(main)).toBeNull();
  } finally {
    await db.delete(workspaces).where(eq(workspaces.id, ws!.id));
    await db.delete(users).where(eq(users.id, user!.id));
  }
});

// against the local database and Gitea, with no model: nothing here gets as far as starting a thread
test("a hand-off needs a real pick: nothing starts otherwise, and the list shows what can carry on", async () => {
  const tag = crypto.randomUUID().slice(0, 8);
  const [ws] = await db.insert(workspaces).values({ name: `hand-test-${tag}` }).returning();
  const [user] = await db.insert(users).values({ email: `hand-test-${tag}@example.com` }).returning();
  const who = { workspaceId: ws!.id, userId: user!.id };
  const maker = { admin: true, author: { name: "Test", email: "test@example.com" } };
  try {
    const main = crypto.randomUUID();
    const hand = (args: string[], m?: typeof maker) => jobsCommand(who, main, ["hand", ...args], EMPLIO, true, m);
    await db.insert(conversations).values({ id: main, ...who, title: "main", kind: "main" });
    const started = async () => (await db.select().from(jobs).where(eq(jobs.workspaceId, ws!.id))).length;

    expect((await hand([])).text).toContain("usage: emplio hand");
    expect((await hand(["myself"])).text).toContain("usage: emplio hand");
    // a name that's no agent yet: said plainly, not guessed at
    expect((await hand(["Bookkeeper", "the brief"], maker)).text).toContain("--description");
    expect((await hand(["Bookkeeper", "--description", "Keeps the books", "the brief"])).text).toContain("can't make one");
    expect((await hand(["deadbeef", "the brief"])).text).toContain("no job deadbeef");
    // every job has an agent: no plain copy from Emplio
    expect((await hand(["myself", "the brief"], maker)).text).toContain("not to a copy of you");
    expect(await started()).toBe(0);

    expect(await threadsNote(who, main, EMPLIO)).toBe("");
    const chat = (id: string) => ({ id, ...who, title: "t", kind: "job" as const });
    const [fresh, stale, asking] = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];
    await db.insert(conversations).values([chat(fresh), chat(stale), chat(asking)]);
    const longAgo = new Date(Date.now() - 3 * 86_400_000);
    const rows = await db
      .insert(jobs)
      .values([
        { ...who, conversationId: main, chatId: fresh, depth: 1, name: "october fixes", agent: "book-keeper", status: "done", finishedAt: new Date() },
        { ...who, conversationId: main, chatId: stale, depth: 1, name: "old work", status: "done", finishedAt: longAgo },
        { ...who, conversationId: main, chatId: asking, depth: 1, name: "needs an answer", status: "asking", finishedAt: longAgo },
      ])
      .returning();
    const note = await threadsNote(who, main, EMPLIO);
    expect(note).toContain("Book Keeper · october fixes · done");
    expect(note).toContain("myself · needs an answer · asking");
    // no day's cut-off: an agent's job carries on however long ago it last worked
    expect(note).toContain("myself · old work · done");
    expect(rows).toHaveLength(3);
  } finally {
    await db.delete(workspaces).where(eq(workspaces.id, ws!.id));
    await db.delete(users).where(eq(users.id, user!.id));
  }
});

test("each hand-off card is one run of its job: the prompt it was handed, and what came after", () => {
  expect(splitRef(runRef("job1", "m2"))).toEqual({ id: "job1", run: "m2" });
  const said = (id: string, role: string, text: string) => ({ id, role, parts: [{ type: "text", text }] });
  const msgs = [
    said("m1", "user", `${FROM_EMPLIO}first brief`),
    said("a1", "assistant", "first report"),
    said("m2", "user", `${FROM_EMPLIO}second brief`),
    said("a2", "assistant", "Question: which client?"),
  ];
  // the first run is finished: it ends where the next prompt starts
  expect(runSpan(msgs, "m1")).toEqual({ msgs: msgs.slice(0, 2), latest: false });
  expect(runSpan(msgs, "m2")).toEqual({ msgs: msgs.slice(2), latest: true });
  // a prompt not in the chat yet has no run
  expect(runSpan(msgs, "m3")).toBeNull();
});

test("a plain copy's finished work gets the agent nudge; an agent's, a deeper thread's or unfinished work doesn't", () => {
  expect(agentNudge({ status: "done", agent: null, depth: 1 })).toContain("emplio agents add");
  expect(agentNudge({ status: "done", agent: "invoice-chaser", depth: 1 })).toBe("");
  expect(agentNudge({ status: "done", agent: null, depth: 2 })).toBe("");
  expect(agentNudge({ status: "asking", agent: null, depth: 1 })).toBe("");
});

test("a new agent that nearly copies one already there is caught; clearly different work isn't", () => {
  const have = ["Supplier Finder", "Invoice Chaser", "Price Checker"];
  expect(closeTo("Fabric Supplier Finder", have)).toBe("Supplier Finder");
  expect(closeTo("supplier-finder", have)).toBe("Supplier Finder");
  expect(closeTo("Invoice Chasers Team", have)).toBeNull();
  expect(closeTo("Balance Checker", have)).toBeNull();
  expect(closeTo("Science Project Researcher", have)).toBeNull();
});
