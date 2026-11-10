// The messages Emplio's hand-off choice is checked against: does it do the work itself, or hand it off, and to whom.
// Add a case each time Emplio makes the wrong choice in a real chat (rewritten: these are sent to Braintrust).
import type { ModelMessage } from "ai";
import { longRunNote } from "../../src/chat";
import { emplio, person, ran, type Business } from "../emplio";

// What can go wrong, and so what each case is there to catch:
// - quick: a look-up, one action, a short answer. Handing it off makes the person wait for nothing.
// - together: work done with the person step by step, or a sign-in. It has to stay in the chat.
// - long: research, digging, browser work. Done by hand it blocks the chat for minutes.
// - midway: Emplio started by itself and is past 4 commands. A lot left: hand off. Nearly done: finish.
// - pick: it should hand off, and there is a right place: the thread doing that work, the agent for it, a new agent
//   for work that will come back, or a plain copy of itself for a true one-off.
export type Category = "quick" | "together" | "long" | "midway" | "pick";
// thread:<id>, agent:<name>, new (a new agent made on the spot) or myself
export type Pick = `thread:${string}` | `agent:${string}` | "new" | "myself";

export type Case = {
  name: string;
  category: Category;
  source: "real" | "written";
  business?: Business;
  chat: ModelMessage[];
  // what this business's commands answer, first match wins: [words in the command (a regular expression), the result]
  world?: [string, string][];
  // picks: any of these is right; left out, any pick is
  expect: { hand: boolean; picks?: Pick[] };
};

const INVOICES = JSON.stringify([
  { invoice_number: "198", customer: "Anita Desai", email: "anita@example.com", total: 6400, status: "unpaid", due: "2026-10-12" },
  { invoice_number: "203", customer: "Hotel Sai Residency", email: "accounts@sairesidency.example", total: 84200, status: "unpaid", due: "2026-10-20" },
  { invoice_number: "207", customer: "Mrs Kulkarni", email: "anjali.kulkarni@example.com", total: 24864, status: "paid", due: "2026-10-22" },
  { invoice_number: "212", customer: "Sharma Traders", email: "sharma@example.com", total: 18500, status: "paid", paid_on: "2026-11-03", due: "2026-10-28" },
  { invoice_number: "215", customer: "Blue Lotus Cafe", email: "owner@bluelotus.example", total: 31750, status: "unpaid", due: "2026-10-30" },
]);
// the books answer with real-looking rows, so a look-up can finish and a report has something to chew on
const BOOKS: [string, string][] = [
  ["/work/tmp/apps|invoices\\.json|items\\.json", "61 invoices in October, total 7,84,300. Unpaid: 14, worth 2,96,450 (largest: Hotel Sai Residency 84,200; Blue Lotus Cafe 31,750). 310 items; 41 sold fewer than 5 in October."],
  ["apps (run|info) .*invoice", `${INVOICES}\n(5 of 61 shown; the rest: /work/tmp/apps/invoices.json)`],
  ["apps run .*item", '[{"name":"Bedsheet king ivory","stock":40,"sold_october":3},{"name":"Cushion cover 16in teal","stock":120,"sold_october":64}]\n(2 of 310 shown; the rest: /work/tmp/apps/items.json)'],
];

const AGENTS = ["- Supplier Finder (agents/supplier-finder, light): Finds and compares suppliers for a product", "- Invoice Chaser (agents/invoice-chaser, light): Chases unpaid invoices by email and WhatsApp"];
const THREADS = [
  "- 7f3a2c1e · Supplier Finder · Curtain fabric suppliers, Surat · done, 10 Nov, 11:20 am",
  "- b81d04aa · Invoice Chaser · October unpaid invoices · working",
  "- 2c9e7710 · myself · Diwali offer landing page · done, 9 Nov, 6:05 pm",
];

// five commands of a stock clean-up done by hand, the reminder on the last one
const fiveIn = (left: string): ModelMessage[] => [
  ...ran("Opening the stock sheet", "emplio apps run googlesheets.get_values '{\"sheet\":\"Stock 2026\"}'", "Saved 1,412 rows to /work/tmp/apps/stock.json"),
  ...ran("Counting duplicate items", "python3 /work/tmp/stock/dupes.py", "236 duplicate rows across 97 items"),
  ...ran("Checking the first duplicate", "python3 /work/tmp/stock/show.py 0", "Cushion cover 16in teal: rows 14, 388, 902"),
  ...ran("Checking the second duplicate", "python3 /work/tmp/stock/show.py 1", "Bedsheet king ivory: rows 22, 23"),
  ...ran("Checking the third duplicate", "python3 /work/tmp/stock/show.py 2", `Curtain 7ft grey blackout: rows 31, 640\n\n${left}`),
];

// a function, not a list: the app's files load in a loop of their own, and their words aren't ready until they have
export const cases = (): Case[] => [
  // ── quick: itself ──────────────────────────────────────────────────────────────────────────────────────────────
  { name: "gst on an amount", category: "quick", source: "written", chat: [person("whats 18% gst on 4500")], expect: { hand: false } },
  { name: "hello", category: "quick", source: "written", chat: [person("hi")], expect: { hand: false } },
  { name: "one email", category: "quick", source: "written", chat: [person("email raj that the shop opens at 11 tomorrow")], expect: { hand: false } },
  { name: "one look-up in the books", category: "quick", source: "written", chat: [person("did sharma traders pay invoice 212")], world: BOOKS, expect: { hand: false } },
  { name: "a reminder", category: "quick", source: "written", chat: [person("remind me friday to call the landlord")], expect: { hand: false } },
  { name: "a short draft", category: "quick", source: "written", chat: [person("write a 2 line whatsapp msg saying we're closed on diwali day")], expect: { hand: false } },
  { name: "a plain question", category: "quick", source: "written", chat: [person("what's the difference between blackout and dimout curtains")], expect: { hand: false } },
  { name: "add one row", category: "quick", source: "written", chat: [person("add a row to the orders sheet: Anita Desai, 2 king bedsheets, 3200")], expect: { hand: false } },
  {
    name: "a quick question about work an agent does",
    category: "quick",
    source: "written",
    business: { agents: AGENTS, threads: THREADS },
    chat: [
      person("find me curtain fabric suppliers in surat"),
      emplio("On it, looking for Surat suppliers now."),
      person("ok"),
      emplio("Found 5 curtain fabric suppliers in Surat; Shree Textiles is cheapest at ₹92 a metre. The comparison sheet is ready."),
      person("how many suppliers did you find in surat"),
    ],
    expect: { hand: false },
  },

  {
    name: "one small page",
    category: "quick",
    source: "written",
    chat: [person("build a small page where customers can enter window width and height and get a curtain price. rates: blackout 180 per sq ft, sheer 95, stitching 250 per panel")],
    expect: { hand: false },
  },

  // ── together: itself ───────────────────────────────────────────────────────────────────────────────────────────
  {
    name: "walk me through it",
    category: "together",
    source: "written",
    chat: [person("i want to set up our return policy, ask me the questions one by one and write it as we go")],
    expect: { hand: false },
  },
  {
    name: "sign in to a site",
    category: "together",
    source: "written",
    chat: [person("log in to our indiamart seller account, i'll give you the otp when it comes")],
    expect: { hand: false },
  },
  {
    name: "answering its question",
    category: "together",
    source: "written",
    chat: [person("make a quote for 12 curtains for Mrs Kulkarni"), emplio("Happy to. Which fabric, and what size are the windows?"), person("grey blackout, all 7 ft")],
    expect: { hand: false },
  },

  // ── long: hand off ─────────────────────────────────────────────────────────────────────────────────────────────
  {
    name: "supplier research",
    category: "long",
    source: "written",
    chat: [person("find me five curtain fabric suppliers in surat, compare prices and minimum order and put it in a sheet")],
    expect: { hand: true },
  },
  {
    name: "a month of mail",
    category: "long",
    source: "written",
    chat: [person("go through all of last month's emails and list every customer complaint with what we replied")],
    expect: { hand: true },
  },
  {
    name: "browser work on many pages",
    category: "long",
    source: "written",
    chat: [person("check the price of our top 20 products on amazon and flipkart and tell me where we're costlier")],
    expect: { hand: true },
  },
  {
    name: "a report across apps",
    category: "long",
    source: "written",
    chat: [person("make me a full report on october: sales from zoho, top customers, unpaid invoices and which products moved slowest")],
    world: BOOKS,
    expect: { hand: true },
  },
  {
    name: "three things at once",
    category: "long",
    source: "written",
    chat: [person("three things: research 3 courier companies for pune to bangalore, clean up the customer list for duplicates, and draft next month's instagram calendar")],
    expect: { hand: true },
  },
  {
    name: "they didn't say it's big",
    category: "long",
    source: "written",
    chat: [person("fabindia, home centre aur urban ladder ki websites dekh ke batao kaun kya offer de raha hai diwali pe")],
    expect: { hand: true },
  },

  // ── midway ─────────────────────────────────────────────────────────────────────────────────────────────────────
  {
    name: "five commands in, 94 items left",
    category: "midway",
    source: "written",
    chat: [person("clean up the duplicates in the stock sheet: check each one, keep the row with the latest date and add the quantities into it"), ...fiveIn(longRunNote(4, false))],
    expect: { hand: true },
  },
  {
    name: "four commands in, one left",
    category: "midway",
    source: "written",
    chat: [
      person("send mrs kulkarni her quote for the 12 grey blackout curtains"),
      ...ran("Looking up curtain rates", "cat /work/company/knowledge/rates.md", "Blackout 7ft: 1,850 each"),
      ...ran("Working out the total", "python3 -c 'print(12*1850, 12*1850*1.12)'", "22200 24864.0"),
      ...ran("Making the quote PDF", "python3 /work/company/tools/quote.py --to 'Mrs Kulkarni' --items 12 --rate 1850", "Saved /work/out/quote-kulkarni.pdf"),
      ...ran("Finding her email", "emplio apps run gmail.search '{\"q\":\"Kulkarni\"}'", `anjali.kulkarni@example.com\n\n${longRunNote(4, false)}`),
    ],
    expect: { hand: false },
  },

  // ── pick ───────────────────────────────────────────────────────────────────────────────────────────────────────
  {
    name: "more of the same work: its thread",
    category: "pick",
    source: "written",
    business: { agents: AGENTS, threads: THREADS },
    chat: [person("for the surat suppliers also get their delivery time to pune and whether they give credit")],
    expect: { hand: true, picks: ["thread:7f3a2c1e"] },
  },
  {
    name: "more for work still going on: its thread",
    category: "pick",
    source: "written",
    business: { agents: AGENTS, threads: THREADS },
    chat: [person("in the october payment reminders also say we now take UPI, and skip hotel sai residency, they called me. go through all of them again")],
    expect: { hand: true, picks: ["thread:b81d04aa"] },
  },
  {
    name: "new work the agent does",
    category: "pick",
    source: "written",
    business: { agents: AGENTS, threads: THREADS },
    chat: [person("we need a new supplier for cushion fillers, find 4 or 5 near pune with rates")],
    expect: { hand: true, picks: ["agent:Supplier Finder"] },
  },
  {
    name: "same agent, different work: not the old thread",
    category: "pick",
    source: "written",
    business: { agents: AGENTS, threads: THREADS },
    chat: [person("find packaging box suppliers in mumbai, 3 options with prices for 500 boxes")],
    expect: { hand: true, picks: ["agent:Supplier Finder"] },
  },
  {
    name: "work that will come back, no agent for it",
    category: "pick",
    source: "written",
    business: { agents: AGENTS, threads: THREADS },
    chat: [person("every week i want fabindia's and home centre's instagram checked: what they posted, what got most likes. do this week's now")],
    expect: { hand: true, picks: ["new"] },
  },
  {
    name: "a true one-off",
    category: "pick",
    source: "written",
    business: { agents: AGENTS, threads: THREADS },
    chat: [person("my daughter's school wants a list of 10 good science project ideas with materials and cost for each, can you research properly")],
    expect: { hand: true, picks: ["myself"] },
  },
  {
    name: "no agents yet",
    category: "pick",
    source: "written",
    chat: [person("chase all the unpaid invoices from october, email each customer with their amount and due date")],
    world: BOOKS,
    expect: { hand: true, picks: ["new"] },
  },
];
