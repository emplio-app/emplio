import { expect, test } from "bun:test";
import { FROM_EMPLIO, runRef, splitRef, type Approval, type AskCard } from "@emplio/shared";
import { eq } from "drizzle-orm";
import { failed, HAND_IT_OFF, notCounted, refusal, remindAt } from "./chat";
import { db } from "./db";
import { conversations, jobs, messages, users, workspaceMembers, workspaces } from "./db/schema";
import { agentNudge, cardsIn, expireAsking, openAsks, RULES, closeTo, EMPLIO, jobReply, jobsCommand, nudged, RESTARTED, CARRY_ON, recordedLine, SAVE_TOOL, reportGoes, reportsNote, runSpan, savedTool, threadsNote, untoldNote, untoldReports, reportsDue } from "./jobs";
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

test("Emplio has no browser, but a brief may mention it; past three of its own commands the rest is an agent's", () => {
  expect(refusal("emplio browser open https://x.example", 1)).toBeTruthy();
  expect(refusal("emplio logins list; emplio browser snapshot -i", 1)).toBeTruthy();
  expect(refusal("emplio hand \"Price Checker\" <<'EOF'\nOpen it with emplio browser\nEOF", 1)).toBeNull();
  expect(refusal("python go.py", 3)).toBeNull();
  expect(refusal("python go.py", 4)).toBe(HAND_IT_OFF);
  // handing off, asking and setting up are never counted, so they're never refused (nth 0)
  expect(refusal("emplio hand \"Price Checker\" <<'EOF'\nbrief\nEOF", 0)).toBeNull();
});

test("a failed command of Emplio's own: Python errors and real shell errors, not grep finding nothing", () => {
  expect(failed({ exitCode: 1 }, true)).toBe(true);
  expect(failed({ exitCode: 1 }, false)).toBe(false);
  expect(failed({ exitCode: 2 }, false)).toBe(true);
  expect(failed({ exitCode: 0 }, true)).toBe(false);
  expect(failed({}, true)).toBe(false);
});

test("hand-offs and the checklist aren't counted as work done by hand", () => {
  for (const open of ["emplio hand myself <<'EOF'\nbrief\nEOF", "emplio threads wait", "emplio plan done", "emplio report \"broken\"", "emplio ask \"Send it?\" Yes No", "emplio tasks add \"x\"", "emplio automations off daily"]) expect(notCounted(open)).toBe(true);
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
    const reply = async (answer: string, cards: AskCard[] = []) => (await (await jobReply(chatId))!.began(() => {}))(answer, "completed", false, false, cards);

    await reply("hello, how are you");
    expect(await untoldReports(main)).toContain("hello, how are you");
    expect(await untoldReports(main)).toBeNull();

    await reply("Question: which account?");
    await untoldReports(main);
    await db.update(jobs).set({ status: "asking" }).where(eq(jobs.chatId, chatId));
    await reply("Used the work account.");
    expect(await untoldReports(main)).toBeNull();

    // a question on a card: it waits for the person, and Emplio hears nothing of it
    await reply("Asked which account.", [{ id: "q", question: "Which account?", options: ["Work", "Personal"] }]);
    const asking = await db.query.jobs.findFirst({ where: eq(jobs.chatId, chatId) });
    expect(asking).toMatchObject({ status: "asking", report: "Question: Which account? [Work / Personal]" });
    expect(await untoldReports(main)).toBeNull();

    // a run that ends without a word did nothing anyone can check: failed, not done (#244)
    await reply("");
    expect(await db.query.jobs.findFirst({ where: eq(jobs.chatId, chatId) })).toMatchObject({ status: "failed", report: "(it ended without a report)" });
    // its report wakes Emplio's chat in the background (resume): due until that has taken it
    for (let i = 0; i < 100 && (await reportsDue(main)); i++) await Bun.sleep(20);
    expect(await reportsDue(main)).toBe(false);
    await db.update(jobs).set({ status: "working" }).where(eq(jobs.chatId, chatId));
    expect(await reportsDue(main)).toBe(true);
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
  expect(agentNudge({ status: "done", agent: "invoice-chaser", depth: 1 }, true)).toContain("emplio agents update invoice-chaser");
  expect(agentNudge({ status: "asking", agent: "invoice-chaser", depth: 1 }, true)).toBe("");
});

test("a new agent that nearly copies one already there is caught; clearly different work isn't", () => {
  const have = ["Supplier Finder", "Invoice Chaser", "Price Checker"];
  expect(closeTo("Fabric Supplier Finder", have)).toBe("Supplier Finder");
  expect(closeTo("supplier-finder", have)).toBe("Supplier Finder");
  expect(closeTo("Invoice Chasers Team", have)).toBeNull();
  expect(closeTo("Balance Checker", have)).toBeNull();
  expect(closeTo("Science Project Researcher", have)).toBeNull();
});

test("an agent's question card waits over the chat box until a message answers it", () => {
  const q = { id: "q", question: "Which supplier?", options: ["Acme", "Bharat"] };
  const asked = { role: "assistant", parts: [{ type: "tool-bash", output: { asks: [q] } }, { type: "text" }] };
  expect(openAsks([{ role: "user", parts: [] }, asked])).toEqual([q]);
  expect(openAsks([asked, { role: "user", parts: [{ type: "text", text: "Acme" }] }])).toEqual([]);
  expect(openAsks([])).toEqual([]);
});

test("Emplio's agents ask the person with a card; deeper threads ask in their report", () => {
  expect(RULES(1, "0123456789")).toContain("emplio ask");
  expect(RULES(1, "0123456789")).toContain("--chat 01234567");
  expect(RULES(2, "0123456789")).not.toContain("emplio ask");
});

test("a run counts as having kept a tool only for what it saved since its last brief", () => {
  const brief = (t: string) => ({ role: "user", parts: [{ type: "text", text: FROM_EMPLIO + t }] });
  const ran = (code: string, output = "") => ({ role: "assistant", parts: [{ type: "tool-python", input: { code }, output: { output, exitCode: 0 } }] });
  const saved = 'Saved tool billing.grant_pro (changes things) in company/toolset/billing.py. Use it: from tools.billing import grant_pro';
  expect(savedTool([brief("check usage"), ran("emplio.db.sql('select 1')")])).toBe(false);
  expect(savedTool([brief("grant pro"), ran("emplio.tools.save(grant_pro, area='billing', risk='changes')", saved)])).toBe(true);
  // the Aakash grant: it opened a skill that only reads, and did the write inline
  expect(savedTool([brief("grant pro"), ran("u = emplio.skill('emplio-server-users'); sh('psql ... insert ...')")])).toBe(false);
  // a save that was refused prints no "Saved tool" line
  expect(savedTool([brief("grant pro"), ran("emplio.tools.save(grant, area='billing')", "Error\ngrant uses email from earlier in this session")])).toBe(false);
  expect(savedTool([brief("check usage"), ran("open('/work/me/toolset/usage.py','w').write(src)")])).toBe(true);
  expect(savedTool([brief("check usage"), ran("Path('/work/company/toolset/usage.py').write_text(src)")])).toBe(true);
  expect(savedTool([brief("a"), ran("x = 'toolset/usage.py'"), brief("b"), ran("print(1)")])).toBe(false);
  expect(savedTool([brief("a"), ran("emplio.tools.save(f, area='a')", saved), brief("b"), ran("print(1)")])).toBe(false);
});

test("a run the person started by chatting in the job isn't asked for a skill", () => {
  const said = (text: string) => ({ role: "user", parts: [{ type: "text", text }] });
  expect(savedTool([said(FROM_EMPLIO + "check usage"), said("hello, how are you")])).toBe(true);
  expect(savedTool([])).toBe(true);
});

test("a question nobody answers for a day stops waiting; \"Question: none\" never waited", async () => {
  const tag = crypto.randomUUID().slice(0, 8);
  const [ws] = await db.insert(workspaces).values({ name: `jobs-test-${tag}` }).returning();
  const [user] = await db.insert(users).values({ email: `jobs-test-${tag}@example.com` }).returning();
  const who = { workspaceId: ws!.id, userId: user!.id };
  try {
    const main = crypto.randomUUID();
    const chatId = crypto.randomUUID();
    await db.insert(conversations).values([{ id: main, ...who, title: "main", kind: "main" }, { id: chatId, ...who, title: "job", kind: "job" }]);
    const hour = 3_600_000;
    const [old, fresh] = await db
      .insert(jobs)
      .values([
        { ...who, conversationId: main, depth: 1, name: "old", status: "asking", report: "Question: code?", finishedAt: new Date(Date.now() - 25 * hour) },
        { ...who, conversationId: main, depth: 1, name: "fresh", status: "asking", report: "Question: code?", finishedAt: new Date(Date.now() - 23 * hour) },
      ])
      .returning();
    await expireAsking();
    expect((await db.query.jobs.findFirst({ where: eq(jobs.id, old!.id) }))!.status).toBe("stopped");
    expect((await db.query.jobs.findFirst({ where: eq(jobs.id, fresh!.id) }))!.status).toBe("asking");

    await db.insert(jobs).values({ ...who, conversationId: main, chatId, depth: 1, name: "check", status: "done", report: "first" });
    await (await (await jobReply(chatId))!.began(() => {}))("Question: none. Sent the email.", "completed", false, false, []);
    expect((await db.query.jobs.findFirst({ where: eq(jobs.chatId, chatId) }))!.status).toBe("done");
  } finally {
    await db.delete(workspaces).where(eq(workspaces.id, ws!.id));
    await db.delete(users).where(eq(users.id, user!.id));
  }
});

test("each piece of work a job is given gets the tool-saving nudge, but not the nudge's own run or a tiny one", () => {
  const said = (text: string) => ({ role: "user", parts: [{ type: "text", text }] });
  const ran = (n: number) => ({ role: "assistant", parts: Array.from({ length: n }, () => ({ type: "tool-python", input: { code: "print(1)" } })) });
  expect(nudged([said(FROM_EMPLIO + "check usage"), ran(3)])).toBe(false);
  // two commands or fewer: nothing worth keeping
  expect(nudged([said(FROM_EMPLIO + "check usage"), ran(2)])).toBe(true);
  expect(nudged([said(FROM_EMPLIO + SAVE_TOOL), ran(5)])).toBe(true);
  expect(nudged([said(FROM_EMPLIO + "Before your report: keep what the next job like this would call as tools.")])).toBe(true);
  // a follow-up after the nudge gets its own
  expect(nudged([said(FROM_EMPLIO + "email the team"), ran(9), said(FROM_EMPLIO + SAVE_TOOL), ran(1), said(FROM_EMPLIO + "delete the test email"), ran(4)])).toBe(false);
  // a restart or the step limit mid-nudge doesn't make it ask again
  expect(nudged([said(FROM_EMPLIO + SAVE_TOOL), ran(4), said(FROM_EMPLIO + RESTARTED), ran(3)])).toBe(true);
  expect(nudged([said(FROM_EMPLIO + "email the team"), ran(30), said(FROM_EMPLIO + CARRY_ON), ran(1)])).toBe(false);
});

test("the report goes first: the job is done with its answer before the tool-saving run", async () => {

  const tag = crypto.randomUUID().slice(0, 8);
  const [ws] = await db.insert(workspaces).values({ name: `jobs-test-${tag}` }).returning();
  const [user] = await db.insert(users).values({ email: `jobs-test-${tag}@example.com` }).returning();
  const who = { workspaceId: ws!.id, userId: user!.id };
  try {
    const main = crypto.randomUUID();
    const chatId = crypto.randomUUID();
    await db.insert(conversations).values([{ id: main, ...who, title: "main", kind: "main" }, { id: chatId, ...who, title: "job", kind: "job" }]);
    await db.insert(messages).values({ id: crypto.randomUUID(), conversationId: chatId, role: "user", parts: [{ type: "text", text: FROM_EMPLIO + "Check if Tushar replied" }] });
    await db.insert(jobs).values({ ...who, conversationId: main, chatId, depth: 1, name: "check", status: "working" });
    await (await (await jobReply(chatId))!.began(() => {}))("Yes, Tushar replied: it's failing.", "completed", false, false, []);
    expect(await db.query.jobs.findFirst({ where: eq(jobs.chatId, chatId) })).toMatchObject({ status: "done", report: "Yes, Tushar replied: it's failing." });
  } finally {
    await db.delete(workspaces).where(eq(workspaces.id, ws!.id));
    await db.delete(users).where(eq(users.id, user!.id));
  }
});

test("told something new while it runs, the job stays working until the reply that took over ends", async () => {
  const tag = crypto.randomUUID().slice(0, 8);
  const [ws] = await db.insert(workspaces).values({ name: `jobs-test-${tag}` }).returning();
  const [user] = await db.insert(users).values({ email: `jobs-test-${tag}@example.com` }).returning();
  const who = { workspaceId: ws!.id, userId: user!.id };
  try {
    const main = crypto.randomUUID();
    const chatId = crypto.randomUUID();
    await db.insert(conversations).values([{ id: main, ...who, title: "main", kind: "main" }, { id: chatId, ...who, title: "job", kind: "job" }]);
    await db.insert(jobs).values({ ...who, conversationId: main, chatId, depth: 2, name: "check", status: "working" });
    const first = await (await jobReply(chatId))!.began(() => {});
    // the next message's reply begins before the steered one has wrapped up
    const second = await (await jobReply(chatId))!.began(() => {});
    await first("Partway there.", "completed", true, false, []);
    expect((await db.query.jobs.findFirst({ where: eq(jobs.chatId, chatId) }))!.status).toBe("working");
    await second("All done.", "completed", false, false, []);
    expect(await db.query.jobs.findFirst({ where: eq(jobs.chatId, chatId) })).toMatchObject({ status: "done", report: "All done." });
  } finally {
    await db.delete(workspaces).where(eq(workspaces.id, ws!.id));
    await db.delete(users).where(eq(users.id, user!.id));
  }
});
