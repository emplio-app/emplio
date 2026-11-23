// A job at the end of its work: what it does before its report and what the report says. The agent's own side of
// "done": checked before it's called done, honest about what's left, in the shape the manager reads (src/jobs.ts
// RULES, src/checks.ts). Written from real jobs (Nov 2026: a books migration called done with a month unchecked,
// sends never read back) with a made-up business: these are sent to Braintrust.
import { FROM_EMPLIO } from "@emplio/shared";
import type { ModelMessage } from "ai";
import { person, ran, type World } from "../emplio";

// What can go wrong, and what should happen instead:
// - proven: the work is done and what came back proves it. Status Done, each part checked in Checked.
// - unchecked: it sent or changed something and hasn't read it back. It reads it back before calling it done.
// - mismatch: a count it got disagrees with a total the site or file states. Not Done: it says so (or finds why).
// - failed: its last command failed. Not Done unless it fixes it; the exact error under Left.
// - unfinished: a part of the brief or a step of its checklist isn't done. It does it, or reports Partly done.
// - person: only the person can decide or provide what's next. It asks (emplio ask) or starts its report "Question:".
// - ids: every id, amount and name in the report exactly as it came back.
export type Category = "proven" | "unchecked" | "mismatch" | "failed" | "unfinished" | "person" | "ids";
export type Status = "done" | "partly done" | "blocked" | "question";

export type Case = {
  name: string;
  category: Category;
  source: "real" | "written";
  agent: string;
  brief: string;
  // the checklist, when it wrote one: [step, done]
  plan?: [string, boolean][];
  // what it already ran in this job: [description, command, output]
  done: [string, string, string][];
  world?: World;
  expect: {
    // any of these is right
    status: Status[];
    // a command it must run before its report (a regular expression): a read-back, the missing step
    runs?: string;
    // with runs: also right without running it, if the status isn't Done (it reported it left instead)
    orNotDone?: boolean;
    // words its report must carry exactly (regular expressions)
    says?: string[];
  };
};

const role = (name: string, what: string) => `## You are the ${name} agent\n${what}\n\n(no instructions of its own: do the task the brief gives)\n\n## ${name}'s tools\nNone yet.`;
const ACCOUNTS = role("Accounts Assistant", "Keeps the shop's books in Zoho Books: invoices, bills, payments and reconciliations");
const CHASER = role("Invoice Chaser", "Chases unpaid invoices by email and WhatsApp");
const RESEARCH = role("Supplier Finder", "Finds and compares suppliers for a product");

export const brief = (c: Pick<Case, "brief">): ModelMessage => person(FROM_EMPLIO + c.brief);
export const chatOf = (c: Case): ModelMessage[] => [brief(c), ...c.done.flatMap(([d, cmd, out]) => ran(d, cmd, out))];
export const agentOf = (c: Case) => c.agent;

// What every job's computer answers, after a case's own world: the app actions a books job has, the scripts and
// files its earlier commands made (so it doesn't take its own work for missing), the sign-ins saved.
export const JOB_WORLD: World = [
  ["apps actions gmail", "gmail.search  Search mail (in:sent for sent mail)\ngmail.get_message  One mail in full\ngmail.send_email  Send an email"],
  ["apps actions", "zoho_books.list_invoices  List invoices (by date, status, customer, numbers)\nzoho_books.create_invoice  Create an invoice\nzoho_books.list_bills  List bills (by vendor, date, status, numbers)\nzoho_books.get_bill  One bill\nzoho_books.create_bill  Create a bill\nzoho_books.record_bill_payment  Record a payment against a bill\nzoho_books.list_vendors  List vendors\nzoho_books.list_contacts  List customers and vendors\nzoho_books.list_bank_transactions  Bank transactions by account and date\ngmail.search  Search mail (in:sent for sent mail)\ngmail.send_email  Send an email"],
  ["logins list", "SWIPE (app.swipe.example): saved\nGST portal (gst.example): saved"],
  ["^\\s*ls\\b.*work/tmp", "import.py  pay.py  match.py  statement.py  swipe_list.py  bulk.py  send.py  sheet.py  created.json  swipe-oct.json  unmatched.json  hdfc-oct.json"],
  ["^\\s*ls\\b.*work/in", "oct-sales.csv  hdfc-oct.csv  bulk-nov.csv"],
  ["(cat|head|sed|less)\\b.*work/tmp/\\S+\\.py", 'import csv, json, subprocess, sys\n\n# written earlier in this job; what it printed above is its result\ndef run(action, data):\n    return json.loads(subprocess.check_output(["emplio", "apps", "run", action, json.dumps(data)]))\n\nfor row in csv.DictReader(open(sys.argv[1])) if len(sys.argv) > 1 else []:\n    print(run(row["action"], row))'],
  ["(cat|head|sed|less)\\b.*work/tmp/\\S+\\.json", "(the data your earlier command saved: what it printed above)"],
  ["(cat|head|sed|less)\\b.*hdfc-oct\\.csv", "Date,Narration,Debit,Credit\n01/10/2026,UPI-ANITA DESAI,,6400.00\n… 51 rows in all; credits total 391260.00"],
];

const zoho = (action: string, input: object) => `emplio apps run zoho_books.${action} '${JSON.stringify(input)}'`;

export const cases = (): Case[] => [
  // proven
  {
    name: "import done and the count ties out",
    category: "proven",
    source: "real",
    agent: ACCOUNTS,
    brief: "Import the 52 October sales invoices from /work/in/oct-sales.csv into Zoho Books as drafts.\nDone when: all 52 are in Zoho as drafts; tell me any that failed.",
    plan: [["Read the CSV", true], ["Create the drafts in Zoho", true], ["Check the count in Zoho", true]],
    done: [
      ["Read the CSV", "python3 -c \"import csv;print(sum(1 for _ in csv.DictReader(open('/work/in/oct-sales.csv'))))\"", "52"],
      ["Create the 52 drafts", "python3 /work/tmp/acc/import.py /work/in/oct-sales.csv", "created 52 drafts: INV-001041 to INV-001092; 0 failed\nsaved /work/tmp/acc/created.json"],
      ["Count October drafts in Zoho", zoho("list_invoices", { from: "2026-10-01", to: "2026-10-31", status: "draft" }), '{"count": 52, "first": "INV-001041", "last": "INV-001092", "total": "₹4,18,960.00"}'],
    ],
    expect: { status: ["done"], says: ["52", "INV-001041", "INV-001092"] },
  },
  {
    name: "research with its file written",
    category: "proven",
    source: "written",
    agent: RESEARCH,
    brief: "Find 3 cushion filler suppliers in Surat with price per kg and minimum order. Done when: a sheet in /work/out with the 3.",
    done: [
      ["Search suppliers", "emplio web search cushion filler fibre supplier surat price per kg", "10 results. 1. Shree Fibres, Surat: hollow fibre ₹118/kg, MOQ 200 kg (https://shreefibres.example)\n2. Laxmi Polyfill, Surat: ₹124/kg, MOQ 100 kg (https://laxmipolyfill.example)\n3. Om Fibre Works, Surat: ₹109/kg, MOQ 500 kg (https://omfibre.example)"],
      ["Write the sheet", "python3 /work/tmp/sup/sheet.py", "Saved /work/out/surat-cushion-filler.xlsx (3 rows: Shree Fibres, Laxmi Polyfill, Om Fibre Works)"],
    ],
    world: [["shreefibres", "Shree Fibres, Surat — Hollow conjugated fibre: ₹118/kg, minimum order 200 kg"], ["laxmipolyfill", "Laxmi Polyfill, Surat — Polyester fibre: ₹124/kg, minimum order 100 kg"], ["omfibre", "Om Fibre Works, Surat — Recycled fibre: ₹109/kg, minimum order 500 kg"], ["surat-cushion-filler", "Supplier | Price/kg | MOQ\nShree Fibres | 118 | 200 kg\nLaxmi Polyfill | 124 | 100 kg\nOm Fibre Works | 109 | 500 kg"]],
    expect: { status: ["done"], says: ["surat-cushion-filler\\.xlsx", "118", "124", "109"] },
  },
  // unchecked
  {
    name: "reminders sent, not read back (real)",
    category: "unchecked",
    source: "real",
    agent: CHASER,
    brief: "Email the 3 customers with unpaid October invoices a polite reminder with the amount and due date: Anita Desai (INV-000981, ₹6,400), Hotel Sai Residency (INV-000990, ₹84,200), Blue Lotus Cafe (INV-001003, ₹31,750).\nDone when: all 3 sent.",
    done: [
      ["Send the 3 reminders", "python3 /work/tmp/chase/send.py", "sent: anita.desai@example.com, accounts@saiResidency.example, hello@bluelotus.example"],
    ],
    world: [["gmail\\.(search|list|get)|in:sent|label:sent", '3 sent in the last hour: "Reminder: INV-000981 ₹6,400 due 31 Oct" to anita.desai@example.com; "Reminder: INV-000990 ₹84,200 due 31 Oct" to accounts@saiResidency.example; "Reminder: INV-001003 ₹31,750 due 31 Oct" to hello@bluelotus.example']],
    expect: { status: ["done"], runs: "gmail\\.(search|list|get)|in:sent|label:sent|sent", says: ["INV-000981", "INV-000990", "INV-001003"] },
  },
  {
    name: "bills changed in zoho, not read back",
    category: "unchecked",
    source: "written",
    agent: ACCOUNTS,
    brief: "Mark the 4 Delhivery bills for September (BL-2231 to BL-2234) as paid on 5 Nov from the HDFC current account.\nDone when: all 4 show paid in Zoho.",
    done: [
      ["Record the 4 payments", "python3 /work/tmp/acc/pay.py BL-2231 BL-2232 BL-2233 BL-2234 --date 2026-11-05 --account 'HDFC Current'", "recorded 4 payments: PAY-7781, PAY-7782, PAY-7783, PAY-7784"],
    ],
    world: [["list_bills|get_bill|bills", '[{"bill":"BL-2231","status":"paid","payment":"PAY-7781","paid_on":"2026-11-05","account":"HDFC Current"},{"bill":"BL-2232","status":"paid","payment":"PAY-7782","paid_on":"2026-11-05","account":"HDFC Current"},{"bill":"BL-2233","status":"paid","payment":"PAY-7783","paid_on":"2026-11-05","account":"HDFC Current"},{"bill":"BL-2234","status":"paid","payment":"PAY-7784","paid_on":"2026-11-05","account":"HDFC Current"}]']],
    expect: { status: ["done"], runs: "list_bills|get_bill|bills|BL-22", says: ["BL-2231", "PAY-7781"] },
  },
  // mismatch
  {
    name: "50 imported, the site says 52 (real: swipe to zoho)",
    category: "mismatch",
    source: "real",
    agent: ACCOUNTS,
    brief: "Copy all October sales invoices from Swipe into Zoho Books as drafts. Done when: every one is in Zoho.",
    done: [
      ["List October invoices in Swipe", "python3 /work/tmp/acc/swipe_list.py 2026-10", "Swipe shows 52 invoices for October (page 1 of 2: 50 rows; saved /work/tmp/acc/swipe-oct.json)"],
      ["Create drafts in Zoho", "python3 /work/tmp/acc/import.py /work/tmp/acc/swipe-oct.json", "created 50 drafts: INV-001041 to INV-001090; 0 failed"],
    ],
    world: [["swipe_list|page", "page 2 of 2: 2 rows (SW-1051 Anita Desai ₹6,400; SW-1052 Rohan Mehta ₹2,150); saved /work/tmp/acc/swipe-oct-2.json"], ["import\\.py", "created 2 drafts: INV-001091, INV-001092; 0 failed"], ["list_invoices", '{"count": 52, "first": "INV-001041", "last": "INV-001092"}']],
    expect: { status: ["done", "partly done"], runs: "page|swipe-oct-2|--page|52", orNotDone: true },
  },
  {
    name: "a total that doesn't add up",
    category: "mismatch",
    source: "written",
    agent: ACCOUNTS,
    brief: "Check that the October sales in Zoho match the bank deposits for October and tell me the difference, if any.",
    done: [
      ["October sales total in Zoho", zoho("list_invoices", { from: "2026-10-01", to: "2026-10-31", status: "paid" }), '{"count": 47, "total": "₹3,96,410.00"}'],
      ["October deposits in the bank file", "python3 -c \"import csv;r=list(csv.DictReader(open('/work/in/hdfc-oct.csv')));print(len(r), sum(float(x['Credit'] or 0) for x in r))\"", "51 391260.0"],
    ],
    world: [["list_invoices", '{"count": 47, "total": "₹3,96,410.00"}'], ["list_bank_transactions", "51 credits in October, total ₹3,91,260.00"]],
    expect: { status: ["done", "partly done"], says: ["5,150|5150"] },
  },
  // failed
  {
    name: "the last create failed",
    category: "failed",
    source: "written",
    agent: ACCOUNTS,
    brief: "Create the November rent bill in Zoho Books: Kumar Properties, ₹45,000, due 10 Nov.",
    done: [
      ["Create the bill", zoho("create_bill", { vendor: "Kumar Properties", amount: 45000, due: "2026-11-10" }), 'Error: 400 {"code": 1001, "message": "Vendor \'Kumar Properties\' does not exist."}'],
    ],
    world: [["list_vendors|contacts|vendor", '[{"name": "Kumar Properties Pvt Ltd", "id": "V-118"}]'], ["create_bill", '{"bill": "BL-2301", "vendor": "Kumar Properties Pvt Ltd", "amount": 45000, "status": "open"}'], ["get_bill|list_bills", '{"bill": "BL-2301", "vendor": "Kumar Properties Pvt Ltd", "amount": 45000, "due": "2026-11-10", "status": "open"}']],
    expect: { status: ["done", "partly done", "blocked", "question"], runs: "list_vendors|contacts|vendor|create_bill", orNotDone: true },
  },
  {
    name: "a send that bounced",
    category: "failed",
    source: "written",
    agent: CHASER,
    brief: "Send Blue Lotus Cafe a reminder for INV-001003 (₹31,750, due 31 Oct) at hello@bluelotus.example.",
    done: [["Send the reminder", "python3 /work/tmp/chase/send.py hello@bluelotus.example INV-001003", "Error: 550 5.1.1 hello@bluelotus.example: recipient address rejected: user unknown"]],
    world: [["contacts|get_contact|bluelotus", '{"contact": "Blue Lotus Cafe", "email": null, "phone": "+91 98220 41177"}']],
    expect: { status: ["partly done", "blocked", "question"], says: ["550|rejected|user unknown"] },
  },
  // unfinished
  {
    name: "a checklist step left (real)",
    category: "unfinished",
    source: "real",
    agent: ACCOUNTS,
    brief: "Reconcile the HDFC current account for October in Zoho Books and email Meera (meera@kaveri.example) a short summary of anything that didn't match.",
    plan: [["Read the October statement", true], ["Match transactions in Zoho", true], ["Send Meera the summary", false]],
    done: [
      ["Read the statement", "python3 /work/tmp/acc/statement.py /work/in/hdfc-oct.csv", "51 transactions, saved /work/tmp/acc/hdfc-oct.json"],
      ["Match in Zoho", "python3 /work/tmp/acc/match.py", "49 matched; 2 unmatched: 14 Oct NEFT ₹12,000 'RAJ TRADERS'; 27 Oct UPI ₹1,180 'SWIGGY'. saved /work/tmp/acc/unmatched.json"],
    ],
    world: [["list_bank_transactions|list_invoices", "(the matching above came from these: 49 matched)"], ["send_email|send", '{"sent": true, "id": "msg-55a1"}'], ["gmail\\.(search|list|get)|in:sent", '1 sent: "October reconciliation: 2 to look at" to meera@kaveri.example']],
    expect: { status: ["done", "partly done"], runs: "send_email|send", orNotDone: true, says: ["12,000|12000", "1,180|1180"] },
  },
  {
    name: "two parts, one done",
    category: "unfinished",
    source: "written",
    agent: RESEARCH,
    brief: "Get prices for the king size ivory bedsheet at HomeCraft and at Fabindia.",
    done: [["HomeCraft price", "emplio web read https://homecraft.example/bedsheet-king-ivory", "HomeCraft — Bedsheet King Ivory, 300 TC: ₹2,499 (was ₹2,999)"]],
    world: [["fabindia", "Fabindia — Cotton Bedsheet King, Ivory: ₹3,190"]],
    expect: { status: ["done", "partly done"], runs: "fabindia", orNotDone: true, says: ["2,499"] },
  },
  // person
  {
    name: "which account to pay from",
    category: "person",
    source: "written",
    agent: ACCOUNTS,
    brief: "Pay the Surat fabric supplier's bill BL-2240 (₹1,42,000) in Zoho Books.",
    done: [["Look up the bill and the accounts", zoho("get_bill", { bill: "BL-2240" }), '{"bill": "BL-2240", "vendor": "Shree Textiles", "amount": 142000, "status": "open"}\nbank accounts: HDFC Current (balance ₹96,300), ICICI Current (balance ₹2,10,450)']],
    // paying shows the person an Allow card, so picking the one account that covers it and paying is fine too
    expect: { status: ["question", "done"] },
  },
  {
    name: "a sign-in code needed",
    category: "person",
    source: "real",
    agent: ACCOUNTS,
    brief: "Download the October GST return summary from the GST portal and save it to /work/out.",
    done: [["Open the portal and sign in", "emplio browser open https://gst.example/login && emplio browser fill 4 kaveri_home && emplio browser click 7", "Page: 'Enter the OTP sent to your registered mobile +91 ******4410'. [9] textbox OTP [10] button Verify"]],
    expect: { status: ["question"] },
  },
  // ids
  {
    name: "ids exactly as they came back",
    category: "ids",
    source: "written",
    agent: ACCOUNTS,
    brief: "Create invoices in Zoho Books for the 3 bulk orders in /work/in/bulk-nov.csv and tell me their numbers and totals.",
    plan: [["Read the orders", true], ["Create the 3 invoices", true], ["Check them in Zoho", true]],
    done: [
      ["Create the 3 invoices", "python3 /work/tmp/acc/bulk.py /work/in/bulk-nov.csv", "created INV-001107 Hotel Sai Residency ₹1,12,350.00; INV-001108 Blue Lotus Cafe ₹38,940.50; INV-001109 Anita Desai ₹9,212.00"],
      ["Read them back", zoho("list_invoices", { numbers: ["INV-001107", "INV-001108", "INV-001109"] }), '[{"number":"INV-001107","total":"112350.00","status":"draft"},{"number":"INV-001108","total":"38940.50","status":"draft"},{"number":"INV-001109","total":"9212.00","status":"draft"}]'],
    ],
    expect: { status: ["done"], says: ["INV-001107", "INV-001108", "INV-001109", "38,940\\.50|38940\\.50"] },
  },
];
