// Work inside a process once it's going: the owner says what happened (a part payment, a wrong date, a step done,
// a client gone), or one of Emplio's own steps comes up. Each must move the right run or task, and only that.
// Written cases on the made-up firm (../client-work/firm.ts); add real ones, rewritten, as they come.
import type { ModelMessage } from "ai";
import { person, type Business } from "../emplio";
import { FIRM } from "../client-work/firm";

// What can go wrong, and so what each case is there to catch:
// - change: what was filled in changed (a part payment, a new date): set it on the run, never start another.
// - back: an OK step isn't right: send it back (with the fix said), not a new task or run.
// - stop: the work isn't wanted any more (paid in full, client gone): stop the run, not cancel tasks one by one.
// - step-done: someone did the step it's on: mark that task done, which moves the run on.
// - own-step: one of Emplio's own steps: do it and mark it done; stuck on something only a person has: waiting.
// - new-run: a second go of the same process (another invoice) is a new run, not a change to the first.
// - read: where things stand: look, answer, change nothing; nothing to change (no such run): say so.
export type Category = "change" | "back" | "stop" | "step-done" | "own-step" | "new-run" | "read";
// what a reply did, read off its commands (scorers.ts)
export type Act = "set" | "back" | "stop" | "done" | "waiting" | "process" | "task" | "client" | "ask" | "hand";

export type Case = {
  name: string;
  category: Category;
  source: "real" | "written";
  business: Business;
  chat: ModelMessage[];
  expect: {
    // each done, on the right run or task (an id's first letters), and no other write
    acts: { act: Act; or?: Act[]; id?: string; inputs?: Record<string, string> }[];
    allow?: Act[];
  };
};

// One of Emplio's own steps as the app starts it: the task's message (src/tasks.ts taskMessage) with the step's
// notes (src/processes.ts stepNotes)
type Run = Parameters<typeof import("../../src/processes").stepNotes>[0];
async function ownStep(id: string, title: string, run: Run, i: number, note?: string) {
  const { taskMessage } = await import("../../src/tasks");
  const { stepNotes } = await import("../../src/processes");
  return taskMessage({ id, title, asker: "Meera", due: "Tue 10 Nov, 6:00 pm", run: 1, notes: stepNotes(run, i, note), here: false, mainChat: null, handTo: null, agent: null });
}
const CHASE = [
  { name: "Send a reminder", who: "emplio" },
  { name: "Call them", who: "handler", days: 3, after: "start" as const },
  { name: "Escalate to the owner", who: "owner", days: 7 },
];
const FILING = [
  { name: "Get the audited accounts", who: "client", days: 30 },
  { name: "Draft the AGM notice", who: "emplio", days: 2 },
  { name: "Approve the notice", who: "owner", back: 2 },
  { name: "File the annual return", who: "handler", days: 30 },
  { name: "Send the filing receipt", who: "emplio" },
];
const input = (name: string, value: string, type: "text" | "number" | "date" = "text") => ({ name, key: name.toLowerCase().replace(/\s+/g, "-"), type, required: true, value });

export async function cases(): Promise<Case[]> {
  const firm: Business = { firm: FIRM };
  const c = (name: string, category: Category, text: string, expect: Case["expect"]): Case => ({ name, category, source: "written", business: firm, chat: [person(text)], expect });
  const northwindChase = { id: "3b9f2d10-0000-4000-8000-000000000001", process: "payment-chase", processTitle: "Payment chase", subject: "Northwind Traders", period: null, steps: CHASE, inputs: [input("Invoice", "INV-1093"), input("Amount", "42000", "number"), input("Due date", "2026-11-05", "date")] };
  const contosoFiling = { id: "e4a77c02-0000-4000-8000-000000000002", process: "annual-filing", processTitle: "Annual filing", subject: "Contoso Ltd", period: null, steps: FILING, inputs: [input("Financial year", "2025-26"), input("AGM date", "2026-12-15", "date")] };
  const wingtipChase = { id: "c8d2e5f1-0000-4000-8000-000000000004", process: "payment-chase", processTitle: "Payment chase", subject: "Wingtip Studio", period: null, steps: CHASE, inputs: [input("Invoice", "INV-3410"), input("Amount", "9600", "number"), input("Due date", "2026-10-28", "date")] };
  return [
    // change
    c("part payment", "change", "fabrikam paid 30,000 against INV-2207, the rest is still owed", { acts: [{ act: "set", id: "7c1e04aa", inputs: { amount: "55000" } }] }),
    c("wrong due date", "change", "the fabrikam chase has the wrong due date, INV-2207 was due 15 oct not 1 nov", { acts: [{ act: "set", id: "7c1e04aa", inputs: { "due-date": "2026-10-15" } }] }),

    // back
    c("wrong date in the notice", "back", "contoso's agm notice has the wrong date, the agm is on 18 dec not 15. fix it", { acts: [{ act: "set", id: "e4a77c02", inputs: { "agm-date": "2026-12-18" } }, { act: "back", id: "e4a77c02" }] }),
    c("notice not right", "back", "the contoso notice draft isn't right, it's missing the auditor reappointment item. redo it", { acts: [{ act: "back", id: "e4a77c02" }] }),

    // stop
    c("paid in full", "stop", "northwind paid INV-1093 in full this morning", { acts: [{ act: "stop", id: "3b9f2d10" }] }),
    c("client pulled out", "stop", "wingtip pulled out, we're not taking them on. stop their onboarding", { acts: [{ act: "stop", id: "51d0c9e3" }], allow: ["client", "task"] }),
    c("nothing to stop", "read", "tailspin backed out, stop their onboarding", { acts: [], allow: ["client"] }),

    // step-done
    c("notice approved", "step-done", "contoso's notice looks fine, go ahead", { acts: [{ act: "done", id: "c05d8e11" }] }),
    c("kickoff call done", "step-done", "priya had the kickoff call with wingtip today", { acts: [{ act: "done", id: "d9c4a370" }] }),
    c("statements in", "step-done", "raj got northwind's november bank statements by email today", { acts: [{ act: "done", id: "b7e21d04" }] }),

    // held out: written after the rules settled, to see they hold on cases they weren't fitted to
    c("amount was wrong", "change", "the wingtip chase amount is wrong, INV-3410 is 9,800", { acts: [{ act: "set", id: "c8d2e5f1", inputs: { amount: "9800" } }] }),
    c("call made", "step-done", "raj called fabrikam about INV-2207 this morning", { acts: [{ act: "done", id: "a1f3c9d2" }] }),
    c("fabrikam paid", "stop", "fabrikam cleared INV-2207 today", { acts: [{ act: "stop", id: "7c1e04aa" }] }),
    c("wrong year in the notice", "back", "contoso's notice says FY 2024-25, it should be 2025-26. send it back", { acts: [{ act: "back", id: "e4a77c02" }], allow: ["set"] }),

    // new-run
    c("second invoice", "new-run", "fabrikam also hasn't paid INV-2290, 12,000, due 20 oct. chase that one too", { acts: [{ act: "process", inputs: { invoice: "INV-2290", amount: "12000", "due-date": "2026-10-20" } }] }),

    // read
    c("who has the chase", "read", "who has the fabrikam chase now?", { acts: [] }),
    c("what's stuck", "read", "what's stuck or late in our processes?", { acts: [] }),

    // own-step
    { name: "send the reminder", category: "own-step", source: "written", business: firm, chat: [person(await ownStep("f1a2b3c4", "Send a reminder · INV-1093", northwindChase, 0))], expect: { acts: [{ act: "done", or: ["waiting"], id: "f1a2b3c4" }], allow: ["hand"] } },
    { name: "draft the notice", category: "own-step", source: "written", business: firm, chat: [person(await ownStep("f5d6e7a8", "Draft the AGM notice · 2025-26", contosoFiling, 1))], expect: { acts: [{ act: "done", or: ["waiting"], id: "f5d6e7a8" }], allow: ["hand"] } },
    { name: "redo a sent-back draft", category: "own-step", source: "written", business: firm, chat: [person(await ownStep("f9b0c1d2", "Draft the AGM notice · 2025-26", contosoFiling, 1, "the AGM is on 18 Dec, not 15 Dec; fix the date everywhere"))], expect: { acts: [{ act: "done", or: ["waiting"], id: "f9b0c1d2" }], allow: ["hand", "set"] } },
    // Wingtip has no contact email on file: only a person can give it
    { name: "reminder with no email", category: "own-step", source: "written", business: firm, chat: [person(await ownStep("fb617283", "Send a reminder · INV-3410", wingtipChase, 0))], expect: { acts: [{ act: "waiting", id: "fb617283" }], allow: ["hand"] } },
  ];
}
