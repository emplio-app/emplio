// The chats Emplio's use of skills is checked against: does it read the skill that fits before the job, and does it
// save a new one when a job turns out to be repeatable. Add a case each time it gets this wrong in a real chat
// (rewritten: these are sent to Braintrust).
import type { ModelMessage } from "ai";
import { emplio, person, ran } from "../emplio";

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
  // use: the skill it must read first (null: none). save: whether a SKILL.md must be written in this reply.
  expect: { use?: string | null; save?: boolean };
};

export const SKILLS = [
  "- company/skills/gst-quote: Make a customer quote PDF with GST, in our format",
  "- company/skills/courier-booking: Book a Delhivery pickup for an online order",
  "- me/skills/weekly-sales-summary: Monday summary of last week's sales from Zoho",
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
  { name: "a question about couriers", category: "leave", source: "written", chat: [person("is delhivery or bluedart usually cheaper for pune to bangalore")], expect: { use: null } },

  // ── save ───────────────────────────────────────────────────────────────────────────────────────────────────────
  {
    name: "corrected on how to do it",
    category: "save",
    source: "written",
    chat: [
      person("match october's amazon payouts against our orders sheet"),
      ...ran("Reading the payout report", "python3 /work/tmp/amazon/read.py /work/in/payout-oct.csv", "118 payouts, total 4,12,300"),
      ...ran("Matching payouts to orders", "python3 /work/tmp/amazon/match.py", "97 matched, 21 don't match (amounts differ)"),
      emplio("97 of 118 payouts match the orders sheet; 21 differ in amount. Shall I list the 21?"),
      person("no thats wrong. amazon cuts their fee and 1% TCS before paying. you have to add those back from the fee columns and then match. always do it that way"),
    ],
    world: [
      ["^\\s*(cd [^;&]+[;&]+\\s*)?(ls|head|cat|sed)\\b", "read.py  match.py\norder_id,amount,fee,tcs\n4301,1840.00,276.00,18.40\n4302,3120.50,468.10,31.21"],
      ["python3|match", "After adding back fee and TCS: 118 of 118 payouts match the orders sheet."],
    ],
    expect: { save: true },
  },
  {
    name: "the second time",
    category: "save",
    source: "written",
    chat: [
      person("make a packing slip for order 4410"),
      ...ran("Reading order 4410", "emplio apps run zoho_books.get_order '{\"number\":\"4410\"}'", '{"customer":"Anita Desai","items":[{"name":"Bedsheet king ivory","qty":2}],"address":"12 Baner Rd, Pune"}'),
      ...ran("Making the packing slip", "python3 /work/tmp/slip/make.py 4410", "Saved /work/out/packing-slip-4410.pdf"),
      emplio("Packing slip for order 4410 is ready."),
      person("good. now one for 4417 too"),
    ],
    world: [
      ["get_order", '{"number":"4417","customer":"Rohan Mehta","items":[{"name":"Cushion cover 16in teal","qty":4}],"address":"7 Aundh Rd, Pune"}'],
      ["make\\.py \\d|python3 \\S*make", "Saved /work/out/packing-slip-4417.pdf"],
      ["^\\s*(cd [^;&]+[;&]+\\s*)?(ls|head|cat|sed)\\b", "make.py\n# usage: make.py <order number>: reads the order from Zoho and writes /work/out/packing-slip-<number>.pdf"],
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
      ["send_message", "Sent."],
    ],
    expect: { save: true },
  },

  // ── one-off ────────────────────────────────────────────────────────────────────────────────────────────────────
  { name: "a fact to remember", category: "one-off", source: "written", chat: [person("our new shop timing is 10:30 to 8:30, sundays closed. note it")], expect: { save: false } },
  { name: "a one-time errand", category: "one-off", source: "written", chat: [person("translate to marathi: we're closed on diwali day, orders resume on the 14th")], expect: { save: false } },
  { name: "a one-time look-up", category: "one-off", source: "written", chat: [person("which day of the week was 15 august 2019")], expect: { save: false } },
];
