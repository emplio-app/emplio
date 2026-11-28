// The messages Emplio's handling of client work is checked against: a busy owner of a firm that works for clients
// asks for something, and the work has to go through the right door, once. Written cases (made-up firm, ./firm.ts)
// until real ones come in; add each wrong call seen in a real chat, rewritten (these are sent to Braintrust).
import type { ModelMessage } from "ai";
import { person, type Business } from "../emplio";
import { about, CLIENTS, FIRM } from "./firm";

// What can go wrong, and so what each case is there to catch:
// - task: a one-off for someone (later, by a person). A task with --client and --to, never a process or a schedule.
// - process: a process fits. Start it for the client with what was said filled in, never its steps as loose tasks.
// - ask: a process fits but something it needs wasn't said and can't be found: ask, don't start it on a guess.
// - repeat: work that comes round (monthly, every Monday, each quarter). One automation (or a repeating task),
//   for the right clients and person; a process's schedule never goes in the process file.
// - new-client: work for each client won. An automation with when: new client, never a schedule.
// - client: a client added, won, lost or handed to someone else: the client changes, nothing else.
// - detail: a short fact about a client (an email, a tax number, how often they file): a detail on them, not a task.
// - write-process: told how something is done step by step: a process file that the app can read.
// - read: a question: look it up, answer, change nothing (an existing schedule is a near miss: don't make it again).
export type Category = "task" | "process" | "ask" | "repeat" | "new-client" | "client" | "detail" | "write-process" | "read";
// the doors a reply can go through (scorers.ts reads them off its commands)
// contact: a page in company/contacts/, <name>/index.md (src/things.ts)
export type Kind = "task" | "process" | "repeat" | "new-client" | "client" | "detail" | "write-process" | "contact" | "change" | "ask";

export type Case = {
  name: string;
  category: Category;
  source: "real" | "written";
  business: Business;
  chat: ModelMessage[];
  expect: {
    // every one of these is done, and nothing else that writes
    kinds: Kind[];
    // fine either way (adding a missing client on the side, a detail along with the client)
    allow?: Kind[];
    // tasks and process runs are for this client (its name or slug)
    client?: string;
    // a task's or a repeat's person: their name, as the team list has it (me: Meera)
    to?: string;
    // the process started, and what it was given (compared loosely: 85,000 is 85000)
    process?: string;
    inputs?: Record<string, string>;
    // an automation it saves: when it runs, what it starts, for which clients (words in clients:), who does it
    file?: { when?: string; process?: string; clients?: string; who?: string; due?: number };
  };
};

const firm = (client?: string): Business => ({ firm: FIRM, ...(client && { client }) });

export async function cases(): Promise<Case[]> {
  const northwind = await about(CLIENTS.northwind);
  const fabrikam = await about(CLIENTS.fabrikam);
  const c = (name: string, category: Category, text: string, expect: Case["expect"], client?: string): Case => ({ name, category, source: "written", business: firm(client), chat: [person(text)], expect });
  return [
    // task
    c("letter for raj", "task", "ask raj to send northwind the revised engagement letter by friday", { kinds: ["task"], client: "northwind", to: "raj" }),
    c("call tomorrow, mine", "task", "remind me to call contoso about their audit queries tomorrow", { kinds: ["task"], client: "contoso", to: "meera" }),
    c("payroll check for priya", "task", "priya needs to check wingtip's payroll file before the 15th", { kinds: ["task"], client: "wingtip", to: "priya" }),
    c("proposal on my list", "task", "put tailspin's proposal review on my list for monday", { kinds: ["task"], client: "tailspin", to: "meera" }),
    c("task in a client's chat", "task", "add a task for raj: get the signed board resolution", { kinds: ["task"], client: "northwind", to: "raj" }, northwind),
    c("chase documents, not money", "task", "chase northwind for the documents we asked for last week, raj can do it", { kinds: [], client: "northwind", to: "raj", allow: ["task", "change"] }),

    // process
    c("payment chase with all inputs", "process", "fabrikam hasn't paid INV-2231, 64,500, was due 1 nov. start chasing", { kinds: ["process"], process: "payment-chase", client: "fabrikam", inputs: { invoice: "INV-2231", amount: "64500", "due-date": "2026-11-01" } }),
    c("onboarding", "process", "litware signed today, start their onboarding", { kinds: ["process", "client"], process: "client-onboarding", client: "litware" }),
    c("annual filing with dates", "process", "kick off the annual filing for northwind, FY 2025-26, agm on 15 dec", { kinds: ["process"], process: "annual-filing", client: "northwind", inputs: { "financial-year": "2025-26", "agm-date": "2026-12-15" } }),
    c("chase in a client's chat", "process", "they owe us 18,200 on INV-1107, due 3 nov. chase it", { kinds: ["process"], process: "payment-chase", client: "fabrikam", inputs: { invoice: "INV-1107", amount: "18200", "due-date": "2026-11-03" } }, fabrikam),
    c("onboarding a just-won prospect", "process", "tailspin signed today, priya looks after them. start their onboarding", { kinds: ["process", "client"], process: "client-onboarding", client: "tailspin" }),

    // ask
    c("chase with nothing", "ask", "start the payment chase for contoso", { kinds: [], allow: ["process"] }),
    c("chase with only the invoice", "ask", "start chasing wingtip for INV-3301", { kinds: [], allow: ["process"] }),

    // repeat
    c("books schedule already there", "read", "every month on the 1st, do the books for all our monthly clients", { kinds: [] }),
    c("quarterly advance tax", "repeat", "every quarter, for the clients who file quarterly, prepare the advance tax working. give it 10 days", { kinds: ["repeat"], allow: ["write-process"], file: { clients: "quarterly", due: 10 } }),
    c("bank feeds every monday", "repeat", "raj should check the bank feeds every monday morning", { kinds: ["repeat"], to: "raj", file: { who: "raj" } }),
    c("annual filing every april", "repeat", "every year in april, start the annual filing for all our clients", { kinds: ["repeat"], file: { process: "annual-filing", clients: "*" } }),
    c("reminder emails by emplio", "repeat", "on the 25th of every month, email each active client to upload their invoices. you do it", { kinds: ["repeat"] }),
    c("one-off, not a repeat", "task", "this month only, raj should send fabrikam their books summary by the 20th", { kinds: ["task"], client: "fabrikam", to: "raj" }),

    // new-client
    c("onboarding for each new client", "new-client", "whenever we sign a new client, start onboarding for them", { kinds: ["new-client"], file: { when: "new client", process: "client-onboarding" } }),
    c("folder set-up for each new client", "new-client", "for every new client, priya should set up their drive folder within 2 days", { kinds: ["new-client"], allow: ["write-process"], file: { when: "new client", who: "priya", due: 2 } }),

    // client
    c("prospect won", "client", "we just signed tailspin toys! priya will look after them", { kinds: ["client"], allow: ["process"] }),
    c("new client with a detail", "client", "new client: Adatum Corp, raj handles them, they file monthly", { kinds: ["client"], allow: ["detail", "process"] }),
    c("client lost", "client", "we stopped working with fabrikam last month", { kinds: ["client"], allow: ["change", "detail"] }),
    // held out: written after the rules settled
    c("audit letter for priya", "task", "remind priya to send contoso their audit letter on friday", { kinds: ["task"], client: "contoso", to: "priya" }),
    c("new contact", "detail", "fabrikam's new contact is anna@fabrikam.example", { kinds: ["contact"], allow: ["detail"] }),
    c("welcome call each new client", "new-client", "every new client should get a welcome call from whoever handles them, within 3 days", { kinds: ["new-client"], allow: ["write-process"], file: { when: "new client", due: 3 } }),
    c("who handles contoso", "read", "who handles contoso?", { kinds: [] }),
    c("books for wingtip now", "process", "start wingtip's november books now", { kinds: ["process"], process: "monthly-books", client: "wingtip" }),
    c("handler change", "client", "priya is taking over northwind from raj", { kinds: ["client"], allow: ["change"] }),

    // detail
    c("new contact email", "detail", "northwind's contact is now tom@northwind.example", { kinds: [], allow: ["detail", "contact"] }),
    c("tax number", "detail", "contoso's tax number is 27AAACC1234D1Z9", { kinds: ["detail"] }),
    c("filing frequency", "detail", "wingtip moved to quarterly filing", { kinds: ["detail"] }),
    c("detail in a client's chat", "detail", "their accounts email is now finance@fabrikam.example", { kinds: ["detail"] }, fabrikam),

    // write-process
    c("company closure steps", "write-process", "this is how we close a company: get the board resolution from the client, raj files the closure application, i approve it before filing, then we wait for the registrar and tell the client", { kinds: ["write-process"] }),
    c("one more step in the chase", "write-process", "add a step to the payment chase: if they still haven't paid a week after the escalation, i send a legal notice", { kinds: ["write-process"] }),
    c("steps and a schedule", "write-process", "our sales tax return each month: get the sales register from the client, raj prepares the return, i review it, then raj files it. do this for the monthly filers on the 5th", { kinds: ["write-process", "repeat"], file: { clients: "monthly" } }),

    // read
    c("where are we", "read", "where are we with northwind?", { kinds: [] }),
    c("who handles", "read", "who looks after contoso?", { kinds: [] }),
    c("waiting on clients", "read", "what are we waiting on from clients right now?", { kinds: [] }),
    c("monthly filers", "read", "which clients file monthly?", { kinds: [] }),
  ];
}
