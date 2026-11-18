// The end of an automation's run: the work (or the hand-off and its report) is already in the chat, and Emplio writes
// the last line, which says whether the run is done or failed (src/automations.ts runMessage, outcome; #244).
// Add a case each time a run shows done when it did nothing, or failed when it did its work (rewritten: these are
// sent to Braintrust).
import type { ModelMessage } from "ai";
import { person, ran, type World } from "../emplio";

// What can go wrong, and so what each case is there to catch:
// - blocked: nothing went through (a check it can't pass, a login gone, an action refused). Must be NOT DONE.
// - little: a sliver went through and the rest was stopped. Must be NOT DONE.
// - empty: the hand-off came back with no report, and trying again doesn't help. Must be NOT DONE.
// - done: the work went through, all or nearly all. Must not be NOT DONE.
// - nothing: there was nothing to do this time. Done (silent is fine), never NOT DONE.
export type Category = "blocked" | "little" | "empty" | "done" | "nothing";

export type Case = {
  name: string;
  category: Category;
  source: "real" | "written";
  // the automation's name, as the run's rules name it
  automation: string;
  chat: ModelMessage[];
  world?: World;
  expect: { notDone: boolean };
};

const INVITES = "Send connection invites to up to 20 people from the Leads sheet's \"To invite\" tab on LinkedIn, with the note in company/skillset/linkedin-outreach. Mark each one sent in the sheet.";
const REMINDERS = "Email a payment reminder to every customer with an invoice more than 7 days overdue in Zoho Books, using gmail.send_email. Polite, one email each.";
const QUOTES = "Look in Gmail for new supplier quotes since yesterday and add each one to the Quotes sheet (supplier, item, price, valid until).";

// An agent's run: handed off, waited for, its report in.
async function handed(name: string, prompt: string, agent: string, job: string, report: string, status = "done") {
  const { runMessage } = await import("../../src/automations");
  const id = "7f3a2c1e";
  return [
    person(runMessage({ name, agent, prompt }, "Meera", "schedule")),
    ...ran(`Hand the run to ${agent}`, `emplio hand ${JSON.stringify(agent)} <<'EOF'\n${prompt}\nEOF`, `started ${id} "${job}" with ${agent}`),
    ...ran("Wait for its report", "emplio threads wait", `${id} "${job}" (${agent.toLowerCase().replace(/ /g, "-")}): ${status}, 6 actions\n${report}`),
  ];
}
// Emplio's own run: the commands it ran and what they gave.
async function itself(name: string, prompt: string, steps: [string, string, string][]) {
  const { runMessage } = await import("../../src/automations");
  return [person(runMessage({ name, agent: null, prompt }, "Meera", "schedule")), ...steps.flatMap(([d, c, o]) => ran(d, c, o))];
}

// trying again goes the same way
const AGAIN = (report: string, status = "done"): World => [
  ["emplio hand", 'started 9b2d4e6f "Send today\'s LinkedIn invites" with LinkedIn Outreach'],
  ["emplio threads wait", `9b2d4e6f "Send today's LinkedIn invites" (linkedin-outreach): ${status}, 3 actions\n${report}`],
];

export const cases = async (): Promise<Case[]> => [
  {
    name: "every invite stuck on a profile that asks for an email",
    category: "blocked",
    source: "real",
    automation: "linkedin-invites",
    chat: await handed("linkedin-invites", INVITES, "LinkedIn Outreach", "Send today's LinkedIn invites", "Not done. Sent 0 of 20. The first profile on the list (Rohan Mehta) asks for his email address before it lets me connect, and I don't have it, so I stopped there. Nothing marked in the sheet."),
    world: AGAIN("Not done. Sent 0 of 20: Rohan Mehta's profile still asks for his email address before connecting."),
    expect: { notDone: true },
  },
  {
    name: "LinkedIn asks for a security code",
    category: "blocked",
    source: "written",
    automation: "linkedin-invites",
    chat: await handed("linkedin-invites", INVITES, "LinkedIn Outreach", "Send today's LinkedIn invites", "Not done: LinkedIn showed a security check asking for the code it emailed to the account, which I can't get. 0 invites sent."),
    world: AGAIN("Not done: the security check is still there. 0 sent."),
    expect: { notDone: true },
  },
  {
    name: "the hand-off ends with no report, twice",
    category: "empty",
    source: "real",
    automation: "linkedin-invites",
    chat: await handed("linkedin-invites", INVITES, "LinkedIn Outreach", "Send today's LinkedIn invites", "(it ended without a report)", "failed"),
    world: AGAIN("(it ended without a report)", "failed"),
    expect: { notDone: true },
  },
  {
    name: "3 of 20 then the weekly limit",
    category: "little",
    source: "written",
    automation: "linkedin-invites",
    chat: await handed("linkedin-invites", INVITES, "LinkedIn Outreach", "Send today's LinkedIn invites", "Partly done. Sent 3 of 20 (Anil Joshi, Kavita Rao, Sameer Shah, marked in the sheet). Then LinkedIn said the weekly invitation limit is reached, so the other 17 wait."),
    world: AGAIN("Still blocked: the weekly invitation limit is reached. Nothing more sent."),
    expect: { notDone: true },
  },
  {
    name: "18 of 20, two skipped",
    category: "done",
    source: "written",
    automation: "linkedin-invites",
    chat: await handed("linkedin-invites", INVITES, "LinkedIn Outreach", "Send today's LinkedIn invites", "Done. Sent 18 of 20 invites, all marked in the sheet. Skipped 2 whose profiles ask for an email address (Rohan Mehta, Divya Nair); left unmarked."),
    expect: { notDone: false },
  },
  {
    name: "all 20 sent",
    category: "done",
    source: "written",
    automation: "linkedin-invites",
    chat: await handed("linkedin-invites", INVITES, "LinkedIn Outreach", "Send today's LinkedIn invites", "Done. Sent all 20 invites with the note, each marked sent in the sheet."),
    expect: { notDone: false },
  },
  {
    name: "no new orders to add",
    category: "nothing",
    source: "written",
    automation: "website-orders",
    chat: await handed("website-orders", "Add yesterday's website orders to the Orders sheet.", "Order Keeper", "Add yesterday's website orders", "Done. No new website orders since yesterday's run; nothing to add."),
    expect: { notDone: false },
  },
  {
    name: "reminders drafted but sending refused",
    category: "blocked",
    source: "written",
    automation: "invoice-reminders",
    chat: await itself("invoice-reminders", REMINDERS, [
      ["List overdue invoices", 'emplio apps run zoho_books.list_invoices \'{"status": "unpaid"}\'', '[{"invoice_number":"198","customer":"Anita Desai","email":"anita@example.com","total":6400,"due":"2026-10-12"},{"invoice_number":"203","customer":"Hotel Sai Residency","email":"accounts@sairesidency.example","total":84200,"due":"2026-10-20"}]'],
      ["Send the first reminder", 'emplio apps run gmail.send_email \'{"to": "anita@example.com", "subject": "Payment reminder: invoice 198"}\'', "error: gmail.send_email isn't allowed for this automation. An admin allows it on the Automations page."],
      ["Send the second reminder", 'emplio apps run gmail.send_email \'{"to": "accounts@sairesidency.example", "subject": "Payment reminder: invoice 203"}\'', "error: gmail.send_email isn't allowed for this automation. An admin allows it on the Automations page."],
    ]),
    expect: { notDone: true },
  },
  {
    name: "the Gmail login has expired",
    category: "blocked",
    source: "written",
    automation: "invoice-reminders",
    chat: await itself("invoice-reminders", REMINDERS, [
      ["List overdue invoices", 'emplio apps run zoho_books.list_invoices \'{"status": "unpaid"}\'', '[{"invoice_number":"203","customer":"Hotel Sai Residency","email":"accounts@sairesidency.example","total":84200,"due":"2026-10-20"}]'],
      ["Send the reminder", 'emplio apps run gmail.send_email \'{"to": "accounts@sairesidency.example", "subject": "Payment reminder: invoice 203"}\'', "error: 401 the Gmail login has expired; reconnect Gmail on the Apps page"],
    ]),
    world: [["gmail", "error: 401 the Gmail login has expired; reconnect Gmail on the Apps page"]],
    expect: { notDone: true },
  },
  {
    name: "both reminders sent",
    category: "done",
    source: "written",
    automation: "invoice-reminders",
    chat: await itself("invoice-reminders", REMINDERS, [
      ["List overdue invoices", 'emplio apps run zoho_books.list_invoices \'{"status": "unpaid"}\'', '[{"invoice_number":"198","customer":"Anita Desai","email":"anita@example.com","total":6400,"due":"2026-10-12"},{"invoice_number":"203","customer":"Hotel Sai Residency","email":"accounts@sairesidency.example","total":84200,"due":"2026-10-20"}]'],
      ["Remind Anita Desai", 'emplio apps run gmail.send_email \'{"to": "anita@example.com", "subject": "Payment reminder: invoice 198", "body": "Hi Anita, a gentle reminder that invoice 198 for Rs 6,400 was due on 12 Oct. Could you let us know when to expect payment? Thank you, Kaveri Home Furnishings"}\'', '{"id": "18c2a", "threadId": "18c2a", "labelIds": ["SENT"]}'],
      ["Remind Hotel Sai Residency", 'emplio apps run gmail.send_email \'{"to": "accounts@sairesidency.example", "subject": "Payment reminder: invoice 203", "body": "Hello, a gentle reminder that invoice 203 for Rs 84,200 was due on 20 Oct. Could you let us know when to expect payment? Thank you, Kaveri Home Furnishings"}\'', '{"id": "18c2b", "threadId": "18c2b", "labelIds": ["SENT"]}'],
    ]),
    expect: { notDone: false },
  },
  {
    name: "no new quotes in the inbox",
    category: "nothing",
    source: "written",
    automation: "supplier-quotes",
    chat: await itself("supplier-quotes", QUOTES, [
      ["Look at yesterday's mail", "emplio apps run gmail.search '{\"query\": \"newer_than:1d\"}'", '[{"from":"orders@amazon.example","subject":"Your order has shipped"},{"from":"raj@kaveri.example","subject":"Shop keys"},{"from":"noreply@zoho.example","subject":"Your weekly Zoho Books summary"}]'],
    ]),
    expect: { notDone: false },
  },
  {
    name: "the Quotes sheet can't be opened",
    category: "blocked",
    source: "written",
    automation: "supplier-quotes",
    chat: await itself("supplier-quotes", QUOTES, [
      ["Search the inbox for quotes", "emplio apps run gmail.search '{\"query\": \"quote newer_than:1d\"}'", '[{"from":"sales@shreeramtextiles.example","subject":"Quote: 200 m cotton voile","snippet":"Rs 145/m, valid till 30 Nov"}]'],
      ["Add it to the sheet", "emplio apps run googlesheets.append_row '{\"sheet\": \"Quotes\"}'", "error: 403 the connected Google account has no access to the Quotes sheet"],
    ]),
    world: [["googlesheets", "error: 403 the connected Google account has no access to the Quotes sheet"]],
    expect: { notDone: true },
  },
];
