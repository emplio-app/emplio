// The rounds the background agent is checked against. Between chats it gets the readers' notes and has to put each
// thing where it belongs, so the next chat is better: a way of doing a job into a skill, a fact into knowledge, a
// preference onto the person, a promise into a task. Add a case each time a note led nowhere (rewritten: these are
// sent to Braintrust).

// What each case is there to catch:
// - skill: a way that was worked out or repeated, and no skill saved in the chat. This is the catch-up for it.
// - knowledge, preference, task: the same for facts, preferences and promises.
// - nothing: no notes. Saving things anyway is noise.
// - tidy: what's saved stays true and said once (the start of "dreaming": https://platform.claude.com/docs/en/managed-agents/dreams).
//   A fact already saved isn't saved again; a fact that changed marks the old one replaced.
export type Category = "skill" | "knowledge" | "preference" | "task" | "nothing" | "tidy" | "tasks" | "memory" | "goals" | "change";
export type Does = "skill" | "knowledge" | "preference" | "task";

export type Case = {
  name: string;
  category: Category;
  source: "real" | "written";
  // the readers' notes, as the round gets them (src/reader.ts noteLine)
  notes: string;
  // what's already saved, as this business's commands answer: [words in the command (a regular expression), the result]
  world?: [string, string][];
  // which round it is (default a check-in), and whether it carries the daily cleanup or the weekly goals review
  round?: { kind?: "check-in" | "brief" | "report"; daily?: boolean; weekly?: boolean };
  // what the server found new (heartbeat.ts changesSince), the task list it gives, the goals file, the memory files
  // over their limit (tooLong)
  changes?: string;
  tasks?: string;
  goals?: string;
  tooLong?: string;
  // replaces: the knowledge write must also mark the old fact replaced (or edit it in place)
  // everything in `does` must be done; for "nothing", none of the four may be
  expect: { does: Does[]; replaces?: boolean } & Ideal;
};

// The rest of what an ideal round does (scorers.ts ideal):
// done: tasks it must mark done; open: tasks it must leave open; cancelled: one of each group must be cancelled or removed.
// rewrite: a person's file rewritten whole: under max characters, every keep still there, no drop left, at most one
//   line matching each once. goals: progress written under the goals, headings untouched, at least `tasks` tasks added.
export type Ideal = {
  done?: string[];
  open?: string[];
  cancelled?: string[][];
  rewrite?: { email: string; file: "prefer" | "profile"; max: number; keep: string[]; drop?: string[]; once?: string[] };
  goals?: { headings: string[]; tasks: number };
};

// reads only (a search, a look in knowledge/), never the write itself
const saved = (line: string): [string, string][] => [["emplio search|\\b(grep|cat|ls|head|find)\\b[^>]*knowledge", line]];

const note = (title: string, text: string) => `[10 Nov, 4:10 pm] Meera, chat 3f9a12bc "${title}":\n${text}`;

const FILING: Case[] = [
  {
    name: "a job done twice with no skill",
    category: "skill",
    source: "written",
    notes: note("Packing slips", "Repeated: Meera needs a packing slip for every order going out; made for 4410 and 4417 with /work/tmp/slip/make.py <order number>, which reads the order from Zoho and writes a PDF.\nWay: packing slip = run make.py with the order number; no skill saved for it."),
    expect: { does: ["skill"] },
  },
  {
    name: "a corrected way",
    category: "skill",
    source: "written",
    notes: note("Amazon payouts", "Way: to match Amazon payouts to the orders sheet, first add back Amazon's fee and 1% TCS from the fee columns, then match. Meera corrected this; the first try without it left 21 of 118 unmatched."),
    expect: { does: ["skill"] },
  },
  { name: "a fact", category: "knowledge", source: "written", notes: note("Shop timing", "Fact: shop timing changes to 10:30 to 8:30, closed Sundays, from 15 Nov."), expect: { does: ["knowledge"] } },
  { name: "a supplier's terms", category: "knowledge", source: "written", notes: note("New supplier", "Fact: cushion fillers now come from Shree Foam, ₹92 a kg, 30 days' credit."), expect: { does: ["knowledge"] } },
  {
    name: "a preference",
    category: "preference",
    source: "written",
    notes: note("Customer messages", "Preference: Meera wants no emojis in customer messages, ever, and every one signed Kaveri Home Furnishings."),
    expect: { does: ["preference"] },
  },
  {
    name: "a promise with no task",
    category: "task",
    source: "written",
    notes: note("Blue Lotus invoice", "Promise: the AI said it will check on Friday 13 Nov whether Blue Lotus Cafe paid invoice 215 (₹31,750) and remind them if not; no task was added."),
    expect: { does: ["task"] },
  },
  {
    name: "a fact and a promise in one chat",
    category: "task",
    source: "written",
    notes: note("New supplier", "Fact: cushion fillers moved to Shree Foam, ₹92 a kg, 30 days' credit.\nPromise: Raj will send Shree Foam the first PO by Wednesday 11 Nov; no task was added."),
    expect: { does: ["knowledge", "task"] },
  },
  {
    name: "two chats, three kinds",
    category: "skill",
    source: "written",
    notes: [
      note("Amazon payouts", "Way: match Amazon payouts only after adding back the fee and 1% TCS from the fee columns; corrected by Meera."),
      note("Customer messages", "Preference: Meera wants no emojis in customer messages."),
      note("Shop timing", "Fact: shop closed on Sundays from 15 Nov."),
    ].join("\n\n"),
    expect: { does: ["skill", "preference", "knowledge"] },
  },
  {
    name: "a fact that's already saved",
    category: "tidy",
    source: "written",
    notes: note("Fillers", "Fact: cushion fillers come from Shree Foam, ₹92 a kg, 30 days' credit."),
    world: saved("company/knowledge/suppliers/shree-foam.md:3: 2026-11-08, Meera: cushion fillers come from Shree Foam, ₹92 a kg, 30 days' credit"),
    expect: { does: [] },
  },
  {
    name: "a fact that changed",
    category: "tidy",
    source: "written",
    notes: note("Shop timing", "Fact: shop timing changes to 10:30 to 8:30, closed Sundays, from 15 Nov."),
    world: saved("company/knowledge/topics/shop.md:2: 2026-08-02, Meera: shop timing is 10 to 8, open all seven days"),
    expect: { does: ["knowledge"], replaces: true },
  },
  { name: "no notes", category: "nothing", source: "written", notes: "(nothing)", expect: { does: [] } },

];

// The ideal background agent, beyond filing notes: tasks kept true, memory kept short, goals worked toward, changes
// handled without the browser. Written for the made-up business.
const T = (id: string, status: string, due: string, who: string, title: string) => [id, status, due, who, title].join("\t");
const BLOATED = [
  "# Preferences",
  "",
  "How Meera likes things done (format, tone, timing). One line each; the agent updates it.",
  "- Short replies; she dislikes long messages (2 Oct).",
  "- Customer messages: no emojis, ever, and sign every one \"Kaveri Home Furnishings\" (10 Nov).",
  "- Keep answers short and to the point (from ChatGPT).",
  "- Never send anything to a customer or supplier without her OK, even to fix a mistake: show the draft and wait (12 Oct, after a wrong quote went to Hotel Panchavati).",
  "- Respond very short when she says so (from Claude).",
  "- No messages to Sunil Traders until she says so (8 Nov, a payment dispute).",
  "- Always call Mahesh Athavale \"Mahesh sir\" in emails (13 Nov).",
  "- Diwali offer posts (20 Oct): 15% off bed linen, until 5 Nov only; mention the FC Road shop.",
  "- Quotes for Hotel Panchavati: always include the 5% bulk discount and 30-day credit (3 Nov).",
  "- Dates and prices she gives go in exactly as said; never work out your own (29 Oct, a deadline was changed).",
  "- Short answers please, no long intros (4 Nov).",
  "- Reply in English even when she writes in Hindi or Marathi (27 Oct).",
  "- Supplier calls: Raj handles Shree Foam, never message them yourself (6 Nov).",
  "- Before saying a payment came in, check Zoho Books itself, not the email (25 Oct, she corrected a wrong reading twice).",
  ...Array.from({ length: 60 }, (_, i) => `- (${i + 1} Oct) Old note on order ${4300 + i}: packed and sent; nothing more to do.`),
].join("\n");
const GOALS = `# Goals

## Grow online orders to 40% of sales by March
- 2026-10-26: 28% of October sales online.

## Collect every invoice within 30 days
- 2026-10-26: 6 invoices over 30 days.`;

const IDEAL: Case[] = [
  {
    name: "a task already done in a chat",
    category: "tasks",
    source: "written",
    round: { kind: "report", daily: true },
    notes: note("Panchavati quote", "Done: Raj sent Hotel Panchavati the revised quote for 40 curtain sets (₹1,84,000) on 10 Nov, 3:12 pm; Meera saw it go."),
    tasks: [
      T("a1b2c3d4", "todo", "11 Nov, 6:00 pm", "Raj", "Send Hotel Panchavati the revised curtain quote"),
      T("e5f6a7b8", "todo", "12 Nov, 6:00 pm", "Emplio", "Chase Green Leaf Cafe for invoice 233 (₹12,400)"),
    ].join("\n"),
    world: [["emplio (history )?search", "chat 3f9a12bc, 10 Nov 3:12 pm, Raj: sent the revised quote to Hotel Panchavati (₹1,84,000), they confirmed receipt"]],
    expect: { does: [], done: ["a1b2c3d4"], open: ["e5f6a7b8"] },
  },
  {
    name: "the same task twice",
    category: "tasks",
    source: "written",
    round: { kind: "report", daily: true },
    notes: "(nothing)",
    tasks: [
      T("c0ffee01", "todo", "13 Nov, 6:00 pm", "Raj", "Call Shree Foam about the late filler delivery"),
      T("c0ffee02", "todo", "13 Nov, 6:00 pm", "Raj", "Call Shree Foam about late filler delivery"),
      T("c0ffee03", "todo", "14 Nov, 6:00 pm", "Priya", "Update the website banner for the jute range"),
    ].join("\n"),
    expect: { does: [], cancelled: [["c0ffee01", "c0ffee02"]], open: ["c0ffee03"] },
  },
  {
    name: "a preferences file over its limit",
    category: "memory",
    source: "written",
    round: { kind: "report", daily: true },
    notes: "(nothing)",
    tooLong: "- Meera's preferences (`emplio person meera@kaveri.example rewrite prefer`): 75 lines, 6,410 characters (limit 60 lines, 6,000 characters)",
    world: [["^emplio person meera@kaveri\\.example\\s*$", `== profile.md\nRuns the shop.\n\n== preferences.md\n${BLOATED}`], ["cat\\b.*me/preferences\\.md", BLOATED]],
    expect: {
      does: ["knowledge"],
      rewrite: {
        email: "meera@kaveri.example",
        file: "prefer",
        max: 3000,
        keep: ["emoji", "Kaveri Home Furnishings", "without her OK|her OK|approval", "Sunil Traders", "English", "Zoho"],
        drop: ["order 43\\d\\d", "Diwali|until 5 Nov"],
        once: ["short (replies|answers)|short and to the point|long (intros|messages)"],
      },
    },
  },
  {
    name: "rules about one client move out of preferences",
    category: "memory",
    source: "written",
    round: { kind: "report", daily: true },
    notes: "(nothing)",
    tooLong: "- Meera's preferences (`emplio person meera@kaveri.example rewrite prefer`): 75 lines, 6,410 characters (limit 60 lines, 6,000 characters)",
    world: [["^emplio person meera@kaveri\\.example\\s*$", `== profile.md\nRuns the shop.\n\n== preferences.md\n${BLOATED}`], ["cat\\b.*me/preferences\\.md", BLOATED]],
    expect: {
      does: ["knowledge"],
      rewrite: { email: "meera@kaveri.example", file: "prefer", max: 3000, keep: ["emoji", "Sunil Traders"], drop: ["Panchavati", "Mahesh"] },
    },
  },
  {
    name: "the weekly goals review",
    category: "goals",
    source: "written",
    round: { kind: "brief", weekly: true },
    notes: "(nothing)",
    goals: GOALS,
    world: [
      ["zoho_books\\.list_invoices", JSON.stringify({ invoices: [
        { invoice_number: "INV-1042", customer_name: "Sai Residency", total: 14400, balance: 8400, due_date: "2026-09-30", status: "overdue" },
        { invoice_number: "INV-1077", customer_name: "Green Leaf Cafe", total: 12400, balance: 12400, due_date: "2026-10-05", status: "overdue" },
        { invoice_number: "INV-1101", customer_name: "Anita Desai", total: 6200, balance: 6200, due_date: "2026-10-09", status: "overdue" },
      ] })],
      ["emplio db sql", '[{"channel": "online", "sales": 412000}, {"channel": "shop", "sales": 688000}]'],
      ["\\bgoals\\.md", GOALS],
    ],
    expect: { does: [], goals: { headings: ["Grow online orders to 40% of sales by March", "Collect every invoice within 30 days"], tasks: 1 } },
  },
  {
    name: "a failed automation",
    category: "change",
    source: "written",
    changes: '- Automation "daily-sales-sheet" failed at 9:05 am: googlesheets.append_row: The caller does not have permission',
    notes: "(nothing)",
    expect: { does: ["task"] },
  },
  {
    name: "a site to check, without the browser",
    category: "change",
    source: "written",
    notes: note("Frontel balance", "Promise: the AI said it would check the Frontel prepaid balance on frontel.example (the dashboard after login) every Monday and tell Meera if it's under ₹2,000; no task or automation was set up."),
    expect: { does: ["task"] },
  },
];

export const cases: Case[] = [...FILING, ...IDEAL];
