// The chats Emplio's use of skills is checked against: does it read the skill that fits before the job, and does it
// save a new one when a job turns out to be repeatable. Add a case each time it gets this wrong in a real chat
// (rewritten: these are sent to Braintrust).
import type { ModelMessage } from "ai";
import { FROM_EMPLIO } from "@emplio/shared";
import { SAVE_TOOL } from "../../src/jobs";
import { emplio, person, ran } from "../emplio";

// a job's chat: Emplio's brief, then what it says later (an addition, the person's correction passed on)
const fromEmplio = (text: string) => person(FROM_EMPLIO + text);
const ACCOUNTS = "## You are the Accounts Assistant agent\nKeeps the shop's books: payouts, invoices, reconciliations\n\n(no instructions of its own: do the task the brief gives)\n\n## Accounts Assistant's tools\nNone yet.";
const DISPATCH = "## You are the Dispatch Clerk agent\nMakes packing slips and books pickups for online orders\n\n(no instructions of its own: do the task the brief gives)\n\n## Dispatch Clerk's tools\nNone yet.";

// What can go wrong, and so what each case is there to catch:
// - use: a listed skill fits the job. Not reading it means doing the job the slow way, or the wrong way.
// - leave: no listed skill fits (some only sound close). Reading one wastes a step.
// - save: the job took tries, was corrected, was done a second time or was taught. No skill saved means the same
//   work is figured out again next time.
// - one-off: a fact, a one-time task. A skill for it is clutter.
export type Category = "use" | "leave" | "save" | "one-off";

export type Case = {
  name: string;
  category: Category;
  source: "real" | "written";
  chat: ModelMessage[];
  // what this business's commands answer, first match wins, so the job can be finished: [words in the command, the result]
  world?: [string, string][];
  // job: the chat is an agent's job (the work and saving how it's done are an agent's, src/jobs.ts RULES)
  job?: { agent: string; brief: string };
  // use: the skill it must read first (null: none). save: whether a SKILL.md (or, in a job, a kept tool) must be written in this reply.
  // rule: the owner's "from now on" steps may also go in the standing instructions (company/AGENT.md), which every chat reads
  expect: { use?: string | null; save?: boolean; rule?: boolean };
};

export const SKILLS = [
  "- company/skillset/gst-quote: Make a customer quote PDF with GST, in our format",
  "- company/skillset/courier-booking: Book a Delhivery pickup for an online order",
  "- me/skillset/weekly-sales-summary: Monday summary of last week's sales from Zoho",
];

// a function, not a list: see hand-off/cases.ts
export const cases = (): Case[] => [
  // ── use ────────────────────────────────────────────────────────────────────────────────────────────────────────
  { name: "a quote", category: "use", source: "written", chat: [person("make a quote for hotel sai residency: 40 king bedsheets at 1450")], expect: { use: "gst-quote" } },
  { name: "a quote, asked in hindi", category: "use", source: "written", chat: [person("mrs kulkarni ke liye quotation bana do, 12 grey blackout curtains 1850 each")], expect: { use: "gst-quote" } },
  { name: "a pickup", category: "use", source: "written", chat: [person("book a pickup for order 4417, 2 boxes")], expect: { use: "courier-booking" } },
  { name: "the weekly summary", category: "use", source: "written", chat: [person("send me last week's sales summary")], expect: { use: "weekly-sales-summary" } },
  { name: "fits only partly", category: "use", source: "written", chat: [person("revise the hotel sai quote, they want 50 bedsheets now and 5% off")], expect: { use: "gst-quote" } },

  // ── leave ──────────────────────────────────────────────────────────────────────────────────────────────────────
  { name: "gst sum, not a quote", category: "leave", source: "written", chat: [person("whats 18% gst on 4500")], expect: { use: null } },
  { name: "an email", category: "leave", source: "written", chat: [person("email raj that the shop opens at 11 tomorrow")], expect: { use: null } },
  { name: "a short message", category: "leave", source: "written", chat: [person("write a 2 line whatsapp msg saying we're closed on diwali day")], expect: { use: null } },
  // (a question about couriers was here: reading the courier skill for it is fair, "if one fits even partly")

  // ── save ───────────────────────────────────────────────────────────────────────────────────────────────────────
  {
    name: "corrected on how to do it",
    category: "save",
    source: "written",
    job: { agent: ACCOUNTS, brief: "Match October's Amazon payouts (/work/in/payout-oct.csv) against our orders sheet (/work/tmp/amazon/orders.csv).\nDone when: every payout is matched or listed with why not." },
    chat: [
      fromEmplio("Match October's Amazon payouts (/work/in/payout-oct.csv) against our orders sheet (/work/tmp/amazon/orders.csv).\nDone when: every payout is matched or listed with why not."),
      ...ran("Reading the payout report", "python3 /work/tmp/amazon/read.py /work/in/payout-oct.csv", "118 payouts, total 4,12,300"),
      ...ran("Matching payouts to orders", "python3 /work/tmp/amazon/match.py", "97 matched, 21 don't match (amounts differ)"),
      emplio("Status: Partly done\nResult: 97 of 118 payouts match the orders sheet; 21 differ in amount.\nChecked: counts from the match script.\nFiles: none\nChanged outside: nothing\nLeft: the 21 that differ."),
      fromEmplio('Meera says: "no thats wrong. amazon cuts their fee and 1% TCS before paying. you have to add those back from the fee columns and then match. always do it that way"'),
      // the work done the right way: what's left is keeping it for next time, then the report
      ...ran("Matching with fee and TCS added back", "python3 /work/tmp/amazon/match.py --add-back fee,tcs", "After adding back fee and TCS: 118 of 118 payouts match the orders sheet."),
      emplio("Status: Done\nResult: With Amazon's fee and 1% TCS added back, all 118 October payouts match the orders sheet.\nChecked: 118 payouts in the file, 118 matched, worked out in code.\nFiles: none\nChanged outside: nothing\nLeft: nothing"),
      // after a done job that wrote its own code, the server asks it to keep that as tools (src/jobs.ts SAVE_TOOL)
      fromEmplio(SAVE_TOOL),
    ],
    world: [
      ["^\\s*ls\\b", "match.py  orders.csv  read.py"],
      ["^\\s*(cat|head|sed|wc)\\b.*orders", "order_id,amount\n4301,2134.40\n4302,3619.81\n… 116 more rows"],
      ["payout-oct\\.csv", "order_id,amount,fee,tcs\n4301,1840.00,276.00,18.40\n4302,3120.50,468.10,31.21"],
      ["^\\s*(cat|head|sed|wc)\\b.*\\.py", "import csv, sys\n# match.py: matches each payout to its order; --add-back fee,tcs adds those columns back to the payout first\nadd = sys.argv[sys.argv.index('--add-back') + 1].split(',') if '--add-back' in sys.argv else []\norders = {r['order_id']: float(r['amount']) for r in csv.DictReader(open('/work/tmp/amazon/orders.csv'))}\nrows = list(csv.DictReader(open('/work/in/payout-oct.csv')))\nok = sum(1 for r in rows if abs(orders[r['order_id']] - float(r['amount']) - sum(float(r[c]) for c in add)) < 0.01)\nprint(f'{ok} of {len(rows)} payouts match the orders sheet')"],
      ["python3", "After adding back fee and TCS: 118 of 118 payouts match the orders sheet."],
    ],
    expect: { save: true },
  },
  {
    name: "the second time",
    category: "save",
    source: "written",
    job: { agent: DISPATCH, brief: "Make a packing slip for order 4410." },
    chat: [
      fromEmplio("Make a packing slip for order 4410."),
      ...ran("Reading order 4410", "emplio apps run zoho_books.get_order '{\"number\":\"4410\"}'", '{"customer":"Anita Desai","items":[{"name":"Bedsheet king ivory","qty":2}],"address":"12 Baner Rd, Pune"}'),
      ...ran("Making the packing slip", "python3 /work/tmp/slip/make.py 4410", "Saved /work/out/packing-slip-4410.pdf"),
      emplio("Status: Done\nResult: Packing slip for order 4410: /work/out/packing-slip-4410.pdf\nChecked: the PDF is there with the order's 2 items and address.\nFiles: packing-slip-4410.pdf\nChanged outside: nothing\nLeft: nothing"),
      fromEmplio("Now one for order 4417 too, the same way."),
      ...ran("Reading order 4417", "emplio apps run zoho_books.get_order '{\"number\":\"4417\"}'", '{"customer":"Rohan Mehta","items":[{"name":"Cushion cover 16in teal","qty":4}],"address":"7 Aundh Rd, Pune"}'),
      ...ran("Making the packing slip", "python3 /work/tmp/slip/make.py 4417", "Saved /work/out/packing-slip-4417.pdf"),
      emplio("Status: Done\nResult: Packing slip for order 4417: /work/out/packing-slip-4417.pdf\nChecked: the PDF is there with the order's 4 items and address.\nFiles: packing-slip-4417.pdf\nChanged outside: nothing\nLeft: nothing"),
      fromEmplio(SAVE_TOOL),
    ],
    world: [
      ["get_order", '{"number":"4417","customer":"Rohan Mehta","items":[{"name":"Cushion cover 16in teal","qty":4}],"address":"7 Aundh Rd, Pune"}'],
      ["make\\.py \\d|python3 \\S*make", "Saved /work/out/packing-slip-4417.pdf"],
      ["^\\s*ls\\b.*out", "packing-slip-4410.pdf  packing-slip-4417.pdf"],
      ["^\\s*ls\\b.*slip", "make.py"],
      ["pdftotext|emplio view|strings", "Packing slip: order 4417\nRohan Mehta\n7 Aundh Rd, Pune\n4 x Cushion cover 16in teal"],
      ["python3 -c|import fpdf", "ok"],
    ],
    expect: { save: true },
  },
  {
    name: "taught the steps",
    category: "save",
    source: "written",
    chat: [
      person(
        "from now on when a customer wants to return something: check the order is under 7 days old, ask them for a photo, then make the return in zoho and message them the pickup date. do it for order 4391, she's sent the photo already",
      ),
    ],
    world: [
      ["apps (actions|info)", "zoho_books.get_order  One order by number\nzoho_books.create_return  Create a sales return for an order (returns the pickup date)\nwhatsapp.send_message  Message a customer"],
      ["create_return", '{"return":"RET-88","order":"4391","pickup_date":"2026-11-12"}'],
      ["get_order|4391", '{"number":"4391","customer":"Sneha Patil","phone":"+91 98200 00000","date":"2026-11-06","items":[{"name":"Curtain 7ft grey blackout","qty":2}]}'],
      ["send_message|whatsapp", '{"sent":true,"to":"+91 98200 00000","id":"wamid.8841"}'],
    ],
    expect: { save: true, rule: true },
  },

  // ── one-off ────────────────────────────────────────────────────────────────────────────────────────────────────
  { name: "a fact to remember", category: "one-off", source: "written", chat: [person("our new shop timing is 10:30 to 8:30, sundays closed. note it")], expect: { save: false } },
  { name: "a one-time errand", category: "one-off", source: "written", chat: [person("translate to marathi: we're closed on diwali day, orders resume on the 14th")], expect: { save: false } },
  { name: "a one-time look-up", category: "one-off", source: "written", chat: [person("which day of the week was 15 august 2019")], expect: { save: false } },
];
