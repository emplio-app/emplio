// A made-up firm that works for clients, for the clients evals (client-work, process-steps): its clients, processes,
// schedules and open work, as Emplio's commands would show them. Nothing here is a real customer's.
import type { Client } from "@emplio/shared";
import type { Business, World } from "../emplio";

export const FIRM: Business["firm"] = {
  name: "Brightline Partners",
  about:
    "An accounting and company-secretarial firm: bookkeeping, tax returns, payroll and annual filings for about 40 small companies. Each client has one of us looking after them. Invoices are due in 30 days.",
};

const person = (name: string, email: string) => ({ id: email, name, email });
const RAJ = person("Raj", "raj@kaveri.example");
const PRIYA = person("Priya", "priya@kaveri.example");
const client = (slug: string, name: string, stage: Client["stage"], handlers: Client["handlers"], details: [string, string][], openTasks = 2, waitingTasks = 0): Client =>
  ({ id: slug, slug, name, stage, handlers, details: details.map(([n, value]) => ({ name: n, value })), openTasks, waitingTasks }) as unknown as Client;

export const CLIENTS = {
  northwind: client("northwind-traders", "Northwind Traders", "active", [RAJ], [["Contact email", "sarah@northwind.example"], ["Files", "monthly"], ["Tax number", "27AAACN1234F1Z5"]], 3, 1),
  contoso: client("contoso", "Contoso Ltd", "active", [PRIYA], [["Contact email", "accounts@contoso.example"], ["Files", "quarterly"]], 1),
  fabrikam: client("fabrikam", "Fabrikam Inc", "active", [RAJ], [["Contact email", "ap@fabrikam.example"], ["Files", "monthly"]], 2),
  wingtip: client("wingtip-studio", "Wingtip Studio", "active", [PRIYA], [["Files", "monthly"]], 0),
  tailspin: client("tailspin-toys", "Tailspin Toys", "prospect", [], [], 0),
};

const LIST = Object.values(CLIENTS)
  .map((c) => [c.slug, c.stage, c.handlers.map((h) => h.name).join(", ") || "nobody named", `${c.openTasks} open${c.waitingTasks ? ` (${c.waitingTasks} waiting)` : ""}`, c.name].join("\t"))
  .join("\n");
const SHOW = (c: Client) =>
  [`${c.name} (${c.stage}), handled by ${c.handlers.map((h) => h.name).join(", ") || "nobody named"}`, ...c.details.map((d) => `${d.name}: ${d.value}`), `Notes: company/knowledge/clients/${c.slug}.md`].join("\n");

const PROCESSES = [
  "payment-chase\t3 steps\tby hand\t2 going\tPayment chase",
  "client-onboarding\t4 steps\tby hand\t1 going\tClient onboarding",
  "monthly-books\t3 steps\tstarted by automation monthly-books-run\t9 going\tMonthly books",
  "annual-filing\t5 steps\tby hand\t3 going\tAnnual filing",
].join("\n");
export const PAYMENT_CHASE = `company/processes/payment-chase.md:
---
title: Payment chase
inputs:
  - name: Invoice
  - name: Amount
    type: number
  - name: Due date
    type: date
steps:
  - name: Send a reminder
    who: emplio
  - name: Call them
    days: 3
    after: Due date
  - name: Escalate to the owner
    who: owner
    days: 7
---
Polite first, firm by the call. Never threaten in writing.`;
const ANNUAL = `company/processes/annual-filing.md:
---
title: Annual filing
inputs:
  - name: Financial year
    required: false
  - name: AGM date
    type: date
    required: false
steps:
  - name: Get the audited accounts
    who: client
    days: 30
  - name: Draft the AGM notice
    who: emplio
    days: 2
  - name: Approve the notice
    who: owner
    back: 2
  - name: File the annual return
    days: 30
    after: AGM date
  - name: Send the filing receipt
    who: emplio
---`;
const ONBOARDING = `company/processes/client-onboarding.md:
---
title: Client onboarding
steps:
  - name: Kickoff call
    days: 2
  - name: Collect documents
    who: client
    days: 7
  - name: Set up their books
    days: 5
  - name: Welcome pack
    who: emplio
---`;
const BOOKS = `company/processes/monthly-books.md:
---
title: Monthly books
steps:
  - name: Collect bank statements
    who: client
    days: 5
  - name: Reconcile
    days: 3
  - name: Partner review
    who: owner
    back: 2
---`;
const AUTOMATIONS = [
  'monthly-books-run\tat "0 9 1 * *" Asia/Kolkata\ton\tas Meera\t(starts monthly-books for every active client with Files=monthly)',
  'weekly-summary\tat "0 18 * * 5" Asia/Kolkata\ton\tas Meera, last run 2026-11-06 18:00 done',
].join("\n");
// the runs going now: ids, where each is, who has its step (emplio processes runs)
export const RUNS = [
  "7c1e04aa\tPayment chase\tFabrikam Inc\tstep 2/3 Call them (Raj, todo, due 2026-11-12, task a1f3c9d2)\n\tInvoice: INV-2207 · Amount: 85000 · Due date: 2026-11-01",
  "3b9f2d10\tPayment chase\tNorthwind Traders\tstep 1/3 Send a reminder (Emplio, doing, task f1a2b3c4)\n\tInvoice: INV-1093 · Amount: 42000 · Due date: 2026-11-05",
  "e4a77c02\tAnnual filing\tContoso Ltd\tstep 3/5 Approve the notice (Meera, todo, due 2026-11-11, task c05d8e11)\n\tFinancial year: 2025-26 · AGM date: 2026-12-15",
  "51d0c9e3\tClient onboarding\tWingtip Studio\tstep 1/4 Kickoff call (Priya, todo, due 2026-11-11, task d9c4a370)",
  "c8d2e5f1\tPayment chase\tWingtip Studio\tstep 1/3 Send a reminder (Emplio, doing, task fb617283)\n\tInvoice: INV-3410 · Amount: 9600 · Due date: 2026-10-28",
  "9a2b6f71\tMonthly books\tNorthwind Traders · Nov 2026\tstep 1/3 Collect bank statements (Raj, waiting, due 2026-11-06, task b7e21d04)",
].join("\n");
export const TASKS = [
  "a1f3c9d2\ttodo\tThu 12 Nov, 6:00 pm\tRaj\tFabrikam Inc: Call them · INV-2207 [asked by Meera]",
  "b7e21d04\twaiting\tFri 6 Nov, 6:00 pm\tRaj\tNorthwind Traders: Collect bank statements · Nov 2026 (waiting on Northwind Traders: Collect bank statements) [asked by Meera]",
  "c05d8e11\ttodo\tWed 11 Nov, 6:00 pm\tMeera\tContoso Ltd: Approve the notice · 2025-26 [asked by Meera]",
  "d9c4a370\ttodo\tWed 11 Nov, 6:00 pm\tPriya\tWingtip Studio: Kickoff call [asked by Meera]",
  "e2b8f615\ttodo\tFri 13 Nov, 6:00 pm\tRaj\tNorthwind Traders: Send the signed engagement letter [asked by Meera]",
].join("\n");

// Processes and automations written are read by the app's own readers first, so a broken file gets the app's error
// back, as it would in the app, and Emplio can fix it.
export async function checker() {
  const { parseAutomation } = await import("../../src/automations");
  const { parseProcess } = await import("../../src/processes");
  const { writesOf } = await import("./scorers");
  return (command: string) => {
    for (const w of writesOf([command])) {
      const r = !w.body ? null : w.kind === "write-process" ? parseProcess(w.body) : w.kind === "repeat" || w.kind === "new-client" ? parseAutomation(w.body) : null;
      if (r && "error" in r) return `error: ${r.error}`;
    }
    return null;
  };
}

// The same, as data: what code gets back in code mode (the app answers code with rows, src/sandbox.ts)
const CODE = process.env.EVAL_CODE_MODE !== "0";
const asData = (c: Client) => ({ slug: c.slug, name: c.name, stage: c.stage, handled_by: c.handlers.map((h) => h.name), details: Object.fromEntries(c.details.map((d) => [d.name, d.value])), open_tasks: c.openTasks, waiting_tasks: c.waitingTasks, notes: `company/knowledge/clients/${c.slug}.md` });
const listOf = (text: string, data: unknown) => (CODE ? JSON.stringify(data, null, 1) : text);
const RUN_ROWS = RUNS.split("\n").filter((l) => !l.startsWith("\t")).map((l, i) => {
  const [id, title, subject, at] = l.split("\t") as [string, string, string, string];
  const m = /^step (\d+)\/(\d+) (.+?) \((\w+), (\w+)(?:, due ([\d-]+))?, task (\w+)\)$/.exec(at)!;
  const inputs = (RUNS.split("\n").filter((x) => !x.startsWith("\t"))[i] && RUNS.split("\n")[RUNS.split("\n").indexOf(l) + 1]?.startsWith("\t") ? RUNS.split("\n")[RUNS.split("\n").indexOf(l) + 1]!.trim().split(" · ").map((p) => ({ name: p.split(": ")[0], value: p.split(": ")[1] })) : []);
  return { id, process: title.toLowerCase().replace(/ /g, "-"), title, subject, step: `${m[1]} of ${m[2]}: ${m[3]}`, current: { task_id: m[7], who: m[4], status: m[5], due: m[6] ?? null }, inputs };
});
const TASK_ROWS = TASKS.split("\n").map((l) => {
  const [id, status, due, assignee, rest] = l.split("\t") as [string, string, string, string, string];
  const [client, title] = rest.split(/: (.+)/) as [string, string];
  return { id, title: title.replace(/ \[asked by .+\]$/, "").replace(/ \(waiting on .+\)$/, ""), status, due, assignee, client, waiting_on: /waiting on ([^)]+)/.exec(rest)?.[1] ?? null, asked_by: "Meera" };
});
const RUN_IDS = [...[...RUNS.matchAll(/^(\w{8})\t/gm)].map((m) => m[1]), "5e6f7a8b"].join("|");
// the tasks listed, a task just added, and Emplio's own steps in ../process-steps/cases.ts
const TASK_IDS = [...[...TASKS.matchAll(/^(\w{8})\t/gm)].map((m) => m[1]), "f00dbeef", "f1a2b3c4", "f5d6e7a8", "f9b0c1d2", "fb617283"].join("|");
const HELP = async (area: string) => (await import(`../../src/${area}`)).USAGE as string;
const TEAM = "Meera <meera@kaveri.example>\towner\nRaj <raj@kaveri.example>\tmember\nPriya <priya@kaveri.example>\tadmin";
const FILE = (text: string) => text.replace(/^company\/[^\n]+:\n/, "");

// what the firm's commands answer, first match wins; writes answer like the server does
export const world = async (): Promise<World> => [
  ["clients help", await HELP("clients")],
  ["processes help", await HELP("processes")],
  ["automations help", await HELP("automations")],
  ["tasks help", await HELP("tasks")],
  ["team( list)?\\s*$", TEAM],
  ["clients (list|search)|clients\\s*$", listOf(LIST, Object.values(CLIENTS).map(asData))],
  // by name or slug, any case (Northwind, northwind-traders)
  ...Object.values(CLIENTS).map((c): [string, string] => [`clients show .*${c.slug.split("-")[0]!.replace(/./g, (x) => `[${x}${x.toUpperCase()}]`)}`, listOf(SHOW(c), asData(c))]),
  ["clients show", "error: no such client (emplio clients list)"],
  ["clients add", "added: the client is on the list; their notes file is company/knowledge/clients/<slug>.md"],
  ["clients update", "updated"],
  ["processes show .*payment", PAYMENT_CHASE],
  ["processes show .*annual", ANNUAL],
  ["processes show .*onboard", ONBOARDING],
  ["processes show .*books", BOOKS],
  ["processes runs", listOf(RUNS, RUN_ROWS)],
  ["processes start", "Started 5e6f7a8b: step 1 is made (emplio processes runs)."],
  // an id that isn't one gets the app's error (a run's id given to tasks done, say)
  [`processes (set|back|stop) ['"]?(?!(?:${RUN_IDS})\\b)\\w`, "error: no such run (emplio processes runs)"],
  ["processes (set|back|stop)", "ok: the run is updated (emplio processes runs)"],
  [`tasks (update|done|show) ['"]?(?!(?:${TASK_IDS})\\b)\\w`, "error: no such task (emplio tasks list)"],
  ["processes (add|update)", "Saved: company/processes/<name>.md; start it with emplio processes start, or on a schedule or for each new client with an automation (process: <name>)"],
  ["processes( list)?\\s*$", PROCESSES],
  ["processes/payment-chase\\.md", FILE(PAYMENT_CHASE)],
  ["processes/annual-filing\\.md", FILE(ANNUAL)],
  ["processes/client-onboarding\\.md", FILE(ONBOARDING)],
  ["processes/monthly-books\\.md", FILE(BOOKS)],
  ["automations/monthly-books-run\\.md|automations show .*monthly-books", '---\nwhen: schedule\nschedule: "0 9 1 * *"\nclients: [Files=monthly]\nprocess: monthly-books\n---\nStart the monthly books for each monthly client'],
  ["automations/weekly-summary\\.md|automations show .*weekly", '---\nwhen: schedule\nschedule: "0 18 * * 5"\n---\nSend Meera a summary of the week: what moved for each client, what is late.'],
  ["^\\s*ls\\b.*processes", "annual-filing.md  client-onboarding.md  monthly-books.md  payment-chase.md"],
  ["^\\s*ls\\b.*automations", "monthly-books-run.md  weekly-summary.md"],
  ["automations (add|update)", "saved and on. It runs as Meera."],
  ["automations( list)?\\s*$", AUTOMATIONS],
  ["tasks (list|search)", listOf(TASKS, TASK_ROWS)],
  ["tasks add.*--every", "saved and on. It runs as Meera."],
  ["tasks add", "added f00dbeef\ttodo"],
  ["tasks (update|done)", "updated"],
  ["apps run gmail\\.send", '{"id":"msg_8f2","sent":true}'],
  ["knowledge/clients", "# Notes\n\n## Now\nBooks up to date to October. Waiting on November bank statements."],
];

// the chat is about this client: the note the app adds to each message
export const about = async (c: Client) => (await import("../../src/clients")).clientNoteText(c);
