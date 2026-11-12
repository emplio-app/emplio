// Whole conversations in one main chat: several pieces of work at once, jobs' reports coming back (done, half
// done, with a question, with a failed send), the person answering and adding more. Each step is checked as it
// comes, on the chat as it went so far. Written for a made-up business: these may be sent to Braintrust.

// person: they write. report: a job ends and its report reaches the chat. from: whose job, by agent; "latest": the
// job of the latest hand-off. apps: the server's own record of what it sent or changed.
export type Step =
  | { person: string; expect: Expect }
  | { report: { from: string; text: string; apps?: string }; expect: Expect };

// hand: each piece that must be handed off in this reply. agent: any of these is right; left out, any agent but a
// plain copy. cont: true, to the job that agent already has here; false, a fresh one. say: words (regular
// expressions) its brief carries. none: nothing handed off. tell: words the reply to the person carries. silent: the
// reply is [SILENT] (true) or says something (false). own: at most this many commands of its own. anyOf: right if
// any one of these is.
export type Expect = { hand?: { agent?: string[]; cont?: boolean; say?: string[] }[]; none?: true; tell?: string[]; silent?: boolean; own?: number; anyOf?: Expect[] };

export type Scenario = { name: string; steps: Step[] };

export const scenarios = (): Scenario[] => [
  {
    name: "three things at once, then follow-ups",
    steps: [
      {
        person:
          "three things today: 1) chase october's unpaid invoices by email, 2) find 3 cotton fabric suppliers in surat with prices per metre for 200 m, 3) what's our GST on cushions?",
        expect: { hand: [{ agent: ["Invoice Chaser"], say: ["october"] }, { agent: ["Supplier Finder"], say: ["surat", "200"] }], tell: ["18"] },
      },
      {
        report: { from: "Supplier Finder", text: "Found 3 in Surat for 200 m of cotton: Shree Textiles ₹142/m, Laxmi Fab ₹155/m, Om Weaves ₹138/m. Sheet: /work/out/surat-cotton.xlsx" },
        // of use on its own while the invoices still run: told now
        expect: { none: true, tell: ["138|om weaves"], silent: false },
      },
      { person: "also get their minimum order quantity", expect: { hand: [{ agent: ["Supplier Finder"], cont: true, say: ["minimum"] }] } },
      {
        report: { from: "Invoice Chaser", text: "Question: Sai Residency's INV-1042 has a part payment of ₹6,000. Chase the remaining ₹8,400 too, or skip them?" },
        expect: { none: true, tell: ["sai residency"] },
      },
      { person: "skip sai residency, they pay at month end", expect: { hand: [{ agent: ["Invoice Chaser"], cont: true, say: ["skip sai residency", "month end"] }] } },
      {
        report: {
          from: "Invoice Chaser",
          text: "Sent reminders to all 3 customers with unpaid October invoices: Anita Desai, Hotel Panchavati, Green Leaf Cafe.",
          apps: "gmail.send_email ok, 12 Nov, 11:02 am; gmail.send_email ok, 12 Nov, 11:03 am; gmail.send_email failed (invalid address: accounts@greenleaf.example), 12 Nov, 11:03 am",
        },
        // the failed send is caught: sent back to the job to find the right address, or the person is asked for it
        expect: { anyOf: [{ hand: [{ agent: ["Invoice Chaser"], cont: true }] }, { tell: ["green ?leaf"] }] },
      },
      {
        report: { from: "Supplier Finder", text: "Added each one's minimum order: Shree Textiles 300 m, Laxmi Fab 500 m, Om Weaves 200 m. Sheet updated: /work/out/surat-cotton.xlsx" },
        expect: { none: true, tell: ["300|500|200"] },
      },
      // answered in the chat from the reports it has, without opening the sheet
      { person: "which one is cheapest per metre?", expect: { none: true, tell: ["om weaves"], own: 0 } },
      // a report pulled together from what the jobs reported is Emplio's own, saved in a step or two
      { person: "make a one-page summary document comparing the three suppliers, with your pick", expect: { none: true, own: 2 } },
      // a change to a job's file, with something its report doesn't have: back to that job
      { person: "add each supplier's GST number to the sheet", expect: { hand: [{ agent: ["Supplier Finder"], cont: true, say: ["gst"] }], own: 1 } },
    ],
  },
  {
    name: "a big job that comes back half done",
    steps: [
      {
        person: "make a price comparison of our 40 best-selling curtains against homecraft and urban ladder: a sheet with our price, theirs and the gap",
        expect: { hand: [{ agent: ["Price Checker", "Report Maker"], say: ["40", "homecraft", "urban ladder"] }] },
      },
      {
        report: { from: "latest", text: "Compared 14 of the 40 so far; stopped at the step limit. Partial sheet: /work/out/curtain-prices.xlsx (14 rows)." },
        // sent back, and nothing to tell the person yet: they see the job at work again
        expect: { hand: [{ agent: ["Price Checker", "Report Maker"], cont: true }], silent: true },
      },
      {
        report: {
          from: "latest",
          text: "All 40 compared with HomeCraft and Urban Ladder. Sheet: /work/out/curtain-prices.xlsx (40 rows: our price, HomeCraft's, Urban Ladder's, the gap to each). We're cheaper on 22 and dearer on 18. Biggest gap: Velvet Blackout 7ft, ₹600 dearer than HomeCraft.",
        },
        expect: { none: true, tell: ["22|18"] },
      },
      { person: "on how many are we dearer?", expect: { none: true, tell: ["18"], own: 1 } },
      // new work across the sheet's data: not Emplio's to grind through
      {
        person: "for the 18 where we're dearer, work out what price would make us the cheapest, and add it as a column",
        expect: { hand: [{ agent: ["Price Checker", "Report Maker"] }], own: 1 },
      },
    ],
  },
  {
    name: "a site behind a login, with a code",
    steps: [
      {
        person: "download last month's delhivery shipping invoices from their dashboard and put the totals in a sheet",
        expect: { hand: [{ say: ["delhivery"] }] },
      },
      {
        report: { from: "latest", text: "Question: Delhivery sent a login code to Meera's phone. What is the code?" },
        expect: { none: true, tell: ["code"] },
      },
      { person: "482913", expect: { hand: [{ cont: true, say: ["482913"] }] } },
      {
        report: { from: "latest", text: "Downloaded 6 October invoices, total ₹48,250. Sheet: /work/out/delhivery-oct-2026.xlsx with each invoice and the total." },
        expect: { none: true, tell: ["48,250"] },
      },
    ],
  },
  {
    name: "forum work, a change, then a new subject",
    steps: [
      {
        person: "find reddit threads where people in pune ask about blackout curtains and draft a helpful reply for each. don't post yet",
        expect: { hand: [{ agent: ["Community Manager"], say: ["pune", "don'?t post"] }] },
      },
      {
        report: { from: "Community Manager", text: "Found 3 threads (r/pune, r/IndianHomeDecor, r/india). Drafts in /work/out/reddit-drafts.md. Nothing posted." },
        expect: { none: true, tell: ["3|three"] },
      },
      {
        person: "post the first one, but remove the line about our shop discount",
        expect: { hand: [{ agent: ["Community Manager"], cont: true, say: ["first", "discount"] }] },
      },
      {
        report: { from: "Community Manager", text: "Posted the first reply on r/pune without the discount line: https://reddit.example/r/pune/comments/abc123" },
        expect: { none: true, tell: ["reddit\\.example|posted"] },
      },
      {
        person: "now write a short intro about our new jute range and post it on the pune buy and sell facebook group",
        expect: { hand: [{ agent: ["Community Manager"], cont: false, say: ["jute"] }] },
      },
    ],
  },
];
