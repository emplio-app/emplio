// Whole conversations in one main chat: several pieces of work at once, jobs' reports coming back (done, half
// done, with a question, with a failed send), the person answering and adding more. Each step is checked as it
// comes, on the chat as it went so far. Written for a made-up business: these may be sent to Braintrust.

// person: they write. report: a job ends and its report reaches the chat. from: whose job, by agent; "latest": the
// job of the latest hand-off. apps: the server's own record of what it sent or changed. files: what a file it names
// holds (a sheet: a line per row, cells split by tabs), so a look at it agrees with the report.
export type Step =
  | { person: string; expect: Expect }
  | { report: { from: string; text: string; apps?: string; files?: Record<string, string> }; expect: Expect };

// hand: each piece that must be handed off in this reply. agent: any of these is right; left out, any agent but a
// plain copy. cont: true, to the job that agent already has here; false, a fresh one. say: words (regular
// expressions) its brief carries. none: nothing handed off. tell: words the reply to the person carries. silent: the
// reply is [SILENT] (true) or says something (false). own: at most this many commands of its own. anyOf: right if
// any one of these is.
export type Expect = { hand?: { agent?: string[]; cont?: boolean; say?: string[] }[]; none?: true; tell?: string[]; silent?: boolean; own?: number; anyOf?: Expect[] };

export type Scenario = { name: string; steps: Step[] };

const sheet = (rows: (string | number)[][]) => rows.map((r) => r.join("\t")).join("\n");
const SURAT = [["Supplier", "Price per m (₹)", "Phone"], ["Shree Textiles", 142, "+91 98250 41122"], ["Laxmi Fab", 155, "+91 99090 30215"], ["Om Weaves", 138, "+91 97277 18840"]];
// 40 curtains: cheaper than HomeCraft on 22, dearer on 18; the biggest gap Velvet Blackout 7ft, ₹600 dearer
const CURTAINS = (() => {
  const kinds = ["Blackout", "Sheer", "Linen", "Cotton", "Velvet", "Jacquard", "Eyelet", "Pleated"];
  const sizes = ["5ft", "7ft", "9ft", "Door 7ft", "Window 5ft"];
  const rows: (string | number)[][] = [["Curtain", "Our price (₹)", "HomeCraft (₹)", "Urban Ladder (₹)", "Gap to HomeCraft (₹)", "Gap to Urban Ladder (₹)"]];
  for (let i = 0; i < 40; i++) {
    const name = i === 0 ? "Velvet Blackout 7ft" : `${kinds[i % 8]} ${sizes[i % 5]} ${["Ivory", "Grey", "Teal", "Rust", "Beige"][Math.floor(i / 8)]}`;
    const ours = 899 + ((i * 137) % 1600);
    const hc = i === 0 ? ours - 600 : i <= 22 ? ours + 50 + ((i * 31) % 250) : ours - 40 - ((i * 23) % 300);
    const ul = ours + (((i * 53) % 400) - 200);
    rows.push([name, ours, hc, ul, ours - hc, ours - ul]);
  }
  return rows;
})();

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
        report: { from: "Supplier Finder", text: "Status: Done\nResult: Found 3 in Surat for 200 m of cotton: Shree Textiles ₹142/m, Laxmi Fab ₹155/m, Om Weaves ₹138/m. Sheet: /work/out/surat-cotton.xlsx\nChecked: each price is from the supplier's own listing; the sheet has the 3 rows.\nFiles: /work/out/surat-cotton.xlsx\nChanged outside: nothing\nLeft: nothing", files: { "/work/out/surat-cotton.xlsx": sheet(SURAT) } },
        // of use on its own while the invoices still run: told now
        expect: { none: true, tell: ["138|om weaves"], silent: false },
      },
      { person: "also get their minimum order quantity", expect: { hand: [{ agent: ["Supplier Finder"], cont: true, say: ["minimum"] }] } },
      {
        report: { from: "Invoice Chaser", text: "Question: Sai Residency's INV-1042 has a part payment of ₹6,000. Chase the remaining ₹8,400 too, or skip them?\nSo far: reminders ready for the other October unpaid invoices, none sent yet." },
        // a repeat of what a still-working job already has (the minimum orders) is a wasted message, not new work
        expect: { anyOf: [{ none: true, tell: ["sai residency"] }, { hand: [{ agent: ["Supplier Finder"], cont: true }], tell: ["sai residency"] }] },
      },
      { person: "skip sai residency, they pay at month end", expect: { hand: [{ agent: ["Invoice Chaser"], cont: true, say: ["skip sai residency", "month end"] }] } },
      {
        report: {
          from: "Invoice Chaser",
          text: "Status: Done\nResult: Sent reminders to all 3 customers with unpaid October invoices: Anita Desai, Hotel Panchavati, Green Leaf Cafe.\nChecked: all sent fine.\nFiles: none\nChanged outside: 3 reminder emails\nLeft: nothing",
          apps: "gmail.send_email ok, 12 Nov, 11:02 am; gmail.send_email ok, 12 Nov, 11:03 am; gmail.send_email failed (invalid address: accounts@greenleaf.example), 12 Nov, 11:03 am",
        },
        // the failed send is caught: sent back to the job to find the right address, or the person is asked for it
        expect: { anyOf: [{ hand: [{ agent: ["Invoice Chaser"], cont: true }] }, { tell: ["green ?leaf"] }] },
      },
      {
        report: { from: "Supplier Finder", text: "Status: Done\nResult: Added each one's minimum order: Shree Textiles 300 m, Laxmi Fab 500 m, Om Weaves 200 m. Sheet updated: /work/out/surat-cotton.xlsx\nChecked: each minimum is from the supplier's listing; read the sheet back: 3 rows with the new column.\nFiles: /work/out/surat-cotton.xlsx\nChanged outside: nothing\nLeft: nothing", files: { "/work/out/surat-cotton.xlsx": sheet(SURAT.map((r, i) => [...r, ["Minimum order (m)", 300, 500, 200][i]!])) } },
        expect: { anyOf: [{ none: true, tell: ["300|500|200"] }, { hand: [{ agent: ["Invoice Chaser"], cont: true }], tell: ["300|500|200"] }] },
      },
      // answered in the chat from the reports it has, without opening the sheet
      { person: "which one is cheapest per metre?", expect: { none: true, tell: ["om weaves"], own: 0 } },
      // a report pulled together from what the jobs reported is Emplio's own, saved in a step or two
      { person: "make a one-page summary document comparing the three suppliers, with your pick", expect: { none: true, own: 3 } },
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
        report: { from: "latest", text: "Status: Partly done\nResult: Compared 14 of the 40 so far. Partial sheet: /work/out/curtain-prices.xlsx (14 rows).\nChecked: the sheet has 14 rows, each with both sites' prices read off their pages.\nFiles: /work/out/curtain-prices.xlsx\nChanged outside: nothing\nLeft: the other 26 curtains: ran out of steps before them", files: { "/work/out/curtain-prices.xlsx": sheet(CURTAINS.slice(0, 15)) } },
        // sent back, and nothing to tell the person yet: they see the job at work again
        expect: { hand: [{ agent: ["Price Checker", "Report Maker"], cont: true }], silent: true },
      },
      {
        report: {
          from: "latest",
          text: "Status: Done\nResult: All 40 compared with HomeCraft and Urban Ladder. Sheet: /work/out/curtain-prices.xlsx (40 rows: our price, HomeCraft's, Urban Ladder's, the gap to each). Against HomeCraft we're cheaper on 22 and dearer on 18. Biggest gap: Velvet Blackout 7ft, ₹600 dearer than HomeCraft.\nChecked: the sheet has 40 rows, one per curtain on the list; the gaps and counts were worked out in code.\nFiles: /work/out/curtain-prices.xlsx\nChanged outside: nothing\nLeft: nothing",
          files: { "/work/out/curtain-prices.xlsx": sheet(CURTAINS) },
        },
        expect: { none: true, tell: ["22|18"] },
      },
      // at most three commands of its own, the server's own limit on a reply (src/jobs.ts MANAGER_PROMPT)
      { person: "on how many are we dearer?", expect: { none: true, tell: ["18"], own: 3 } },
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
        report: { from: "latest", text: "Question: Delhivery sent a login code to Meera's phone. What is the code?\nSo far: signed in to the Delhivery dashboard up to the login code." },
        expect: { none: true, tell: ["code"] },
      },
      { person: "482913", expect: { hand: [{ cont: true, say: ["482913"] }] } },
      {
        report: { from: "latest", text: "Status: Done\nResult: Downloaded 6 October invoices, total ₹48,250. Sheet: /work/out/delhivery-oct-2026.xlsx with each invoice and the total.\nChecked: the dashboard lists 6 invoices for October; the sheet has 6 rows and its total, worked out in code, is ₹48,250.\nFiles: /work/out/delhivery-oct-2026.xlsx\nChanged outside: nothing\nLeft: nothing", files: { "/work/out/delhivery-oct-2026.xlsx": sheet([["Invoice", "Date", "Amount (₹)"], ["DLV-OCT-0412", "2026-10-03", 7850], ["DLV-OCT-0587", "2026-10-08", 9120], ["DLV-OCT-0733", "2026-10-13", 6400], ["DLV-OCT-0901", "2026-10-18", 8930], ["DLV-OCT-1066", "2026-10-24", 7250], ["DLV-OCT-1210", "2026-10-30", 8700], ["Total", "", 48250]]) } },
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
        report: { from: "Community Manager", text: "Status: Done\nResult: Found 3 threads (r/pune, r/IndianHomeDecor, r/india). Drafts in /work/out/reddit-drafts.md. Nothing posted.\nChecked: opened each thread; the file has a draft under each one's title.\nFiles: /work/out/reddit-drafts.md\nChanged outside: nothing\nLeft: nothing", files: { "/work/out/reddit-drafts.md": "# Reddit drafts (not posted)\n\n## 1. r/pune: \"Where to buy good blackout curtains in Pune?\"\nFor a west-facing room, look for triple-weave blackout fabric with a thermal lining; it keeps out light and some heat. Measure the window plus 15 cm each side. We run Kaveri Home Furnishings on FC Road: 10% off for r/pune this month.\n\n## 2. r/IndianHomeDecor: \"Blackout curtains that don't look like hotel curtains?\"\nVelvet or linen-look blackout in a warm colour (rust, olive) reads as decor rather than hotel. Double rods let you pair a sheer in front.\n\n## 3. r/india: \"Do blackout curtains help with heat?\"\nYes, a thermal-lined blackout curtain can cut the heat from a sunny window noticeably; hang it close to the glass and floor-length." } },
        expect: { none: true, tell: ["3|three"] },
      },
      {
        person: "post the first one, but remove the line about our shop discount",
        expect: { hand: [{ agent: ["Community Manager"], cont: true, say: ["first", "discount"] }] },
      },
      {
        report: { from: "Community Manager", text: "Status: Done\nResult: Posted the first reply on r/pune without the discount line: https://reddit.example/r/pune/comments/abc123\nChecked: opened the link: the reply is up, without the discount line.\nFiles: none\nChanged outside: one Reddit comment, https://reddit.example/r/pune/comments/abc123\nLeft: nothing" },
        expect: { none: true, tell: ["reddit\\.example|posted"] },
      },
      {
        person: "now write a short intro about our new jute range and post it on the pune buy and sell facebook group",
        expect: { hand: [{ agent: ["Community Manager"], say: ["jute"] }] },
      },
    ],
  },
];
