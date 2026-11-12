// The chats Emplio-as-manager is checked against: it understands, hands the doing to an agent, keeps follow-ups with
// the job that did the work, passes the person's words on as they are, and checks what comes back.
// Rewritten from real chats (Nov 2026) with a made-up business: these are sent to Braintrust.
import type { ModelMessage } from "ai";
import { reportsNote } from "../../src/jobs";
import { emplio, person, type Business } from "../emplio";

// What can go wrong, and what should happen instead:
// - follow: more of the same work, a fix or an answer for a job on the list. It goes to that job, which remembers
//   everything; a fresh job starts cold and the work splits (Reddit: four jobs in an hour as the names drifted).
// - fresh: new work for an agent whose job in this chat was about something else. A fresh job, not the old one.
// - agent: doing work. It goes to an agent (one that fits, or a new one); never a plain copy of Emplio, and never a
//   near-copy of an agent that exists.
// - browser: anything on a website goes to an agent from the first step. Emplio browsing by itself fills its
//   memory, costs many times more and gets cut off mid-site.
// - review: a job's report. Missing or failed work goes back to the same job; done work is told to the person.
// - relay: the person answers a job's question. Their words go to that job as they are (Reddit: "delete it" came out
//   as an apology and "Ashish did not ask"; login codes expired in the relay).
// - quick: a question Emplio can answer from what it knows. Handing it off makes the person wait for nothing.
export type Category = "follow" | "fresh" | "agent" | "browser" | "review" | "relay" | "quick";

export type Case = {
  name: string;
  category: Category;
  source: "real" | "written";
  business?: Business;
  chat: ModelMessage[];
  world?: [string, string][];
  // hand: it hands work off. agent: any of these agents is right ("new": an agent it makes); left out, any agent but
  // a plain copy. cont: true, the job of that agent on the list carries on; false, a fresh one; left out, either.
  // say: words (regular expressions) the brief must carry, from what the person said.
  expect: { hand: boolean; agent?: string[]; cont?: boolean; say?: string[] };
};

export const AGENTS = [
  "- Community Manager (agents/community-manager, light): Posts and replies for the shop on forums and social sites",
  "- Supplier Finder (agents/supplier-finder, light): Finds and compares suppliers for a product",
  "- Invoice Chaser (agents/invoice-chaser, light): Chases unpaid invoices by email and WhatsApp",
  "- Price Checker (agents/price-checker, light): Checks competitors' prices on their websites",
  "- Balance Checker (agents/balance-checker, light): Checks the shop's balances on payment and SMS provider sites",
  "- Data Entry (agents/data-entry, light): Enters the shop's figures into online tools",
  "- Report Maker (agents/report-maker, light): Makes sheets and reports from the shop's data",
];
export const THREADS = [
  "- 5d2e91c4 · Community Manager · Post one approved reply on r/homedecor · done, 10 Nov, 4:40 pm",
  "- b81d04aa · Invoice Chaser · October unpaid invoices · working",
  "- 7f3a2c1e · Supplier Finder · Curtain fabric suppliers, Surat · done, 10 Nov, 11:20 am",
  "- 9c41e0b2 · Price Checker · Bedsheet prices at HomeCraft · done, 9 Nov, 7:10 pm",
  "- 3b7f00a1 · Data Entry · Enter October sales into Swipe · done, 9 Nov, 5:30 pm",
];
const team: Business = { agents: AGENTS, threads: THREADS };
// one thread waiting on the person's answer, in place of its done line
const asking = (line: string): Business => ({ agents: AGENTS, threads: [line, ...THREADS.filter((t) => !t.startsWith(line.slice(0, 11)))] });
// a job's report as it reaches Emplio when the job ends after Emplio's reply did
const report = (head: string, text: string) => person(reportsNote([`${head}\n${text}`], [], /^\W*question\b/i.test(text)));

export const cases = (): Case[] => [
  // follow
  {
    name: "reddit: list our comments after a posting job (real)",
    category: "follow",
    source: "real",
    business: team,
    chat: [
      person("post the approved reply to the cushion covers thread on r/homedecor"),
      emplio("Posted it: reddit.example/r/homedecor/comments/k2x9/comment/m81"),
      person("good. now find every comment we've posted on r/homedecor this month, only the ones about kaveri, and list them with links"),
    ],
    expect: { hand: true, agent: ["Community Manager"], cont: true, say: ["kaveri"] },
  },
  {
    name: "swipe: same entry for the next month (real)",
    category: "follow",
    source: "real",
    business: team,
    chat: [person("do the same for november sales in swipe")],
    expect: { hand: true, agent: ["Data Entry"], cont: true, say: ["november"] },
  },
  {
    name: "more from the suppliers just found",
    category: "follow",
    source: "written",
    business: team,
    chat: [person("also get the minimum order quantity and delivery time from those surat suppliers")],
    expect: { hand: true, agent: ["Supplier Finder"], cont: true, say: ["minimum order|moq", "deliver"] },
  },
  {
    name: "a change for the job still running",
    category: "follow",
    source: "written",
    business: team,
    chat: [person("skip hotel sai residency in the invoice chasing, they paid by cheque yesterday")],
    expect: { hand: true, agent: ["Invoice Chaser"], cont: true, say: ["sai residency", "cheque"] },
  },
  {
    name: "a gap in what came back",
    category: "follow",
    source: "written",
    business: team,
    chat: [person("the surat list has no price for the second supplier, get that")],
    expect: { hand: true, agent: ["Supplier Finder"], cont: true, say: ["price", "second"] },
  },
  {
    name: "same site, another product (real: homecraft)",
    category: "follow",
    source: "real",
    business: team,
    chat: [person("check homecraft's price for the 7ft grey blackout curtain too, like you did for bedsheets")],
    expect: { hand: true, agent: ["Price Checker"], cont: true, say: ["7 ?ft", "blackout"] },
  },
  {
    name: "september invoices after october's",
    category: "follow",
    source: "written",
    business: team,
    chat: [person("chase september's unpaid ones too, the same way")],
    expect: { hand: true, agent: ["Invoice Chaser"], say: ["september"] },
  },
  // fresh
  {
    name: "same agent, unrelated work",
    category: "fresh",
    source: "written",
    business: team,
    chat: [person("find packaging box suppliers in mumbai, 3 options with prices for 500 boxes")],
    expect: { hand: true, agent: ["Supplier Finder"], cont: false, say: ["mumbai", "500"] },
  },
  {
    name: "forum work on a new subject",
    category: "fresh",
    source: "written",
    business: team,
    chat: [person("write and post a short intro about our new jute range on the pune buy and sell facebook group")],
    expect: { hand: true, agent: ["Community Manager"], cont: false, say: ["jute"] },
  },
  {
    name: "an agent with no job here yet (real: frontel balances)",
    category: "fresh",
    source: "real",
    business: team,
    chat: [person("check our balances on exotel, gupshup and msg91")],
    expect: { hand: true, agent: ["Balance Checker"], say: ["exotel", "gupshup", "msg91"] },
  },
  // agent
  {
    name: "weekly competitor watch",
    category: "agent",
    source: "written",
    business: team,
    chat: [person("every week i want fabindia's and home centre's new arrivals in bed linen checked with prices. do this week's now")],
    expect: { hand: true, agent: ["Price Checker", "new"], say: ["fabindia", "home centre"] },
  },
  {
    name: "a one-off with no agent for it",
    category: "agent",
    source: "written",
    business: team,
    chat: [person("my daughter's school wants 10 science project ideas with materials and cost for each, research it properly")],
    expect: { hand: true, agent: ["new"], say: ["10", "material", "cost"] },
  },
  {
    name: "not a near-copy of the supplier agent",
    category: "agent",
    source: "written",
    business: team,
    chat: [person("find 5 cotton fabric suppliers in tiruppur with prices per metre")],
    expect: { hand: true, agent: ["Supplier Finder"], say: ["tiruppur", "metre|meter"] },
  },
  {
    name: "a stock clean-up across the sheet",
    category: "agent",
    source: "written",
    business: team,
    chat: [person("our google sheet 'Stock 2026' has loads of duplicate items, merge them and fix the totals")],
    world: [["googlesheets", "Stock 2026: 1,412 rows (Item, Qty, Updated); saved to /work/tmp/apps/stock.json"], ["stock\\.json", '[["Item","Qty","Updated"],["Cushion cover 16in teal",40,"2026-09-02"],\n… 1,410 more rows']],
    expect: { hand: true, say: ["duplicate"] },
  },
  {
    name: "no agents at all yet",
    category: "agent",
    source: "written",
    chat: [person("read the last month of customer emails and list every complaint with what we did about it")],
    world: [["gmail", '212 emails in the last month. The first 3:\n{"id":"m1","from":"anita@example.com","subject":"Wrong colour delivered"}\n{"id":"m2","from":"orders@delhivery.example","subject":"Pickup scheduled"}\n{"id":"m3","from":"rohan.mehta@example.com","subject":"Cushion covers torn at the seam"}\n(209 more: the next page with {"page": 2}; one mail in full with gmail.get_message)']],
    expect: { hand: true, agent: ["new"], say: ["complaint"] },
  },
  // browser
  {
    name: "a price on a competitor's site",
    category: "browser",
    source: "written",
    business: team,
    chat: [person("what is homecraft charging for the king size ivory bedsheet right now? check their site")],
    expect: { hand: true, agent: ["Price Checker"], say: ["king", "ivory"] },
  },
  {
    name: "a download behind our own sign-in",
    category: "browser",
    source: "written",
    business: team,
    chat: [person("log into our delhivery dashboard and download last month's shipping invoice")],
    expect: { hand: true, say: ["delhivery", "invoice"] },
  },
  {
    name: "sellers on a marketplace",
    category: "browser",
    source: "written",
    business: team,
    chat: [person("go on indiamart and find 5 sellers of jute table runners with prices")],
    expect: { hand: true, agent: ["Supplier Finder"], say: ["indiamart", "jute"] },
  },
  {
    name: "a look at our own store",
    category: "browser",
    source: "written",
    business: team,
    chat: [person("open our shopify store and check if the diwali banner is still up")],
    expect: { hand: true, say: ["diwali", "banner"] },
  },
  {
    name: "one balance on a provider's site (real: gupshup)",
    category: "browser",
    source: "real",
    business: team,
    chat: [person("whats our gupshup balance")],
    expect: { hand: true, agent: ["Balance Checker"], say: ["gupshup"] },
  },
  // review
  {
    name: "done, but no file (real: erik's checklist)",
    category: "review",
    source: "real",
    business: { agents: AGENTS, threads: ["- e19a77d3 · Report Maker · Stock checklist workbook · done, 12 Nov, 1:15 pm", ...THREADS] },
    chat: [
      person("make an excel checklist of every item in the stock sheet with columns for photo proof and notes, so raj can fill it"),
      emplio("On it: building the checklist now."),
      report('e19a77d3 "Stock checklist workbook" (report-maker): done, 61 actions', "Read the stock sheet: 1,412 rows. Found the 97 duplicate items. Now building the workbook from the cleaned list."),
    ],
    world: [["emplio files|ls[^\\n]*/work/out", "(no files)"]],
    expect: { hand: true, agent: ["Report Maker"], cont: true },
  },
  {
    name: "said sent, but the send failed",
    category: "review",
    source: "written",
    business: team,
    chat: [
      person("chase october's unpaid invoices"),
      emplio("On it."),
      report(
        'b81d04aa "October unpaid invoices" (invoice-chaser): done, 18 actions',
        "Emailed all 3 unpaid customers (Anita Desai, Hotel Sai Residency, Blue Lotus Cafe) with their amount and due date.\nApps, as recorded: gmail.send_email ok, 12 Nov, 2:01 pm; gmail.send_email failed (invalid recipient), 12 Nov, 2:02 pm; gmail.send_email ok, 12 Nov, 2:02 pm",
      ),
    ],
    expect: { hand: true, agent: ["Invoice Chaser"], cont: true },
  },
  {
    name: "done and the file is there",
    category: "review",
    source: "written",
    business: team,
    chat: [
      person("find curtain fabric suppliers in surat, 5 with prices"),
      emplio("On it."),
      report(
        '7f3a2c1e "Curtain fabric suppliers, Surat" (supplier-finder): done, 22 actions',
        "Found 5 suppliers with prices per metre, MOQ and contact. Saved /work/out/surat-curtain-fabric.xlsx.\n1. Shree Textiles ₹142/m, MOQ 500 m\n2. Laxmi Fabrics ₹128/m, MOQ 1,000 m\n3. Kiran Mills ₹155/m, MOQ 300 m\n4. Om Weaves ₹131/m, MOQ 800 m\n5. Surya Fab ₹149/m, MOQ 400 m",
      ),
    ],
    world: [["emplio files|ls[^\\n]*/work/out", "surat-curtain-fabric.xlsx"]],
    expect: { hand: false },
  },
  {
    name: "sent, and the record agrees",
    category: "review",
    source: "written",
    business: team,
    chat: [
      person("chase october's unpaid invoices"),
      emplio("On it."),
      report(
        'b81d04aa "October unpaid invoices" (invoice-chaser): done, 15 actions',
        "Emailed all 3 unpaid customers with their amount and due date: Anita Desai ₹6,400, Hotel Sai Residency ₹84,200, Blue Lotus Cafe ₹31,750.\nApps, as recorded: gmail.send_email ok, 12 Nov, 2:01 pm; gmail.send_email ok, 12 Nov, 2:02 pm; gmail.send_email ok, 12 Nov, 2:02 pm",
      ),
    ],
    expect: { hand: false },
  },
  // relay
  {
    name: "yes, delete it (real: reddit)",
    category: "relay",
    source: "real",
    business: asking("- 5d2e91c4 · Community Manager · Post one approved reply on r/homedecor · asking, 10 Nov, 4:50 pm"),
    chat: [
      person("post the approved reply to the cushion covers thread on r/homedecor"),
      emplio("Before posting, one question: there's an older comment of ours from 3 Nov in that thread linking the wrong product. Delete it?"),
      person("yes delete it"),
    ],
    expect: { hand: true, agent: ["Community Manager"], cont: true, say: ["delete"] },
  },
  {
    name: "a sign-in code (real: government portal)",
    category: "relay",
    source: "real",
    business: asking("- 3b7f00a1 · Data Entry · Enter October sales into Swipe · asking, 12 Nov, 3:05 pm"),
    chat: [person("enter october sales into swipe"), emplio("Swipe sent a sign-in code to your phone. What is it?"), person("482913")],
    expect: { hand: true, agent: ["Data Entry"], cont: true, say: ["482913"] },
  },
  {
    name: "change the wording before posting",
    category: "relay",
    source: "written",
    business: asking("- 5d2e91c4 · Community Manager · Reply on the r/pune curtains thread · asking, 10 Nov, 4:50 pm"),
    chat: [
      person("post a reply on the r/pune thread asking where to buy curtains"),
      emplio('Here\'s the draft: "Kaveri in Aundh has a good range, try them." Post it?'),
      person("no, say we deliver across pune and add kaveri.example, then post it"),
    ],
    expect: { hand: true, agent: ["Community Manager"], cont: true, say: ["across pune", "kaveri\\.example"] },
  },
  // quick
  {
    name: "a fact from the business notes",
    category: "quick",
    source: "written",
    business: team,
    chat: [person("whats the gst on cushions")],
    expect: { hand: false },
  },
  {
    name: "a teammate's email",
    category: "quick",
    source: "written",
    business: team,
    chat: [person("whats raj's email")],
    expect: { hand: false },
  },
  {
    name: "how a running job is doing",
    category: "quick",
    source: "written",
    business: team,
    chat: [person("how's the invoice chasing going")],
    expect: { hand: false },
  },
  {
    name: "a two-line reply to draft",
    category: "quick",
    source: "written",
    business: team,
    chat: [person("give me a 2 line whatsapp reply for a customer asking if we deliver to baner")],
    expect: { hand: false },
  },
  {
    name: "thanks",
    category: "quick",
    source: "written",
    business: team,
    chat: [person("ok thanks, that's all for today")],
    expect: { hand: false },
  },
];
