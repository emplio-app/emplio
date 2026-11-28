// What an agency, law or accounting firm's owner tells Emplio about clients, the people there, what they sell, the
// projects going and the meetings held, and what should happen: each fact goes into the right record, through its
// command, once, and the reply says so in plain words. Written cases (made-up agency, ./firm.ts) until real ones come
// in; add each wrong call seen in a real chat, rewritten (these are sent to Braintrust).
import type { ModelMessage } from "ai";
import { emplio, person, ran, type Business } from "../emplio";
import { FIRM } from "./firm";

// What can go wrong, and so what each case is there to catch:
// - meeting: a meeting or call held. A meeting record (meetings add) with its client, project and everyone in it,
//   then its notes at the path the command gives; never only a loose note in knowledge/ or the client's notes.
// - contact: a person at a client. A contact (contacts add --client), not a client field or a knowledge note; one
//   already there is changed (contacts update), never added twice.
// - project: work a client bought. A project (projects add --client --service --lead), not a task or a note.
// - service: something the business sells, with its price. A service (services add), not a knowledge note.
// - private: a client or project only the owner and admins may see. Its switch (--private yes), nothing else.
// - read: a question about clients, people, projects, meetings: look it up (show, list, search), answer, change nothing.
// - change: a record's fact changed (a new email, a new lead, a new fee): update that record, not add a new one.
// - many: a long brain dump after a busy day: every fact to its record, each once.
export type Category = "meeting" | "contact" | "project" | "service" | "private" | "read" | "change" | "many";
// the doors a reply can go through (scorers.ts reads them off its commands)
export type Kind =
  | "meeting" | "meeting-change" | "meeting-notes"
  | "contact" | "contact-change"
  | "project" | "project-change"
  | "service" | "service-change"
  | "client" | "client-change" | "private"
  | "task" | "task-change" | "process"
  | "notes" | "knowledge" | "ask";

export type Case = {
  name: string;
  category: Category;
  source: "real" | "written";
  business: Business;
  chat: ModelMessage[];
  expect: {
    // every one of these is done, and nothing else that writes
    kinds: Kind[];
    // fine either way (a note beside the record, a task for the next step)
    allow?: Kind[];
    // what a write of that kind must carry, loosely (any one write of the kind): a flag's words (a list: every one
    // in it, for --people), or "name" for the record's own name
    has?: Partial<Record<Kind, Record<string, string | string[]>>>;
  };
};

const firm = (client?: string): Business => ({ firm: FIRM, ...(client && { client }) });

export async function cases(): Promise<Case[]> {
  const c = (name: string, category: Category, text: string | ModelMessage[], expect: Case["expect"]): Case => ({
    name,
    category,
    source: "written",
    business: firm(),
    chat: typeof text === "string" ? [person(text)] : text,
    expect,
  });
  return [
    // meeting
    c("call with sarah", "meeting", "just got off a call with sarah at northwind. she wants the homepage hero to be a video, not a slider, and they'll send footage by friday", {
      kinds: ["meeting", "meeting-notes"],
      // the change noted on the wireframes task is fine too
      allow: ["task", "task-change", "notes", "project-change"],
      has: { meeting: { client: "northwind", people: ["sarah"] } },
    }),
    c("review meeting with james, project", "meeting", "had the monthly review with james from contoso today with raj. traffic up 22%, they want 4 blog posts a month from december", {
      kinds: ["meeting", "meeting-notes"],
      allow: ["task", "notes"],
      has: { meeting: { client: "contoso", project: "contoso-seo", people: ["james", "raj"] } },
    }),
    c("yesterday's pitch", "meeting", "yesterday priya and i pitched tailspin travel, lucas and their ceo maria were there. they liked route B for the logo, want a quote by monday", {
      kinds: ["meeting", "meeting-notes"],
      // a prospect nobody looked after, pitched by Meera and Priya: naming who handles them is fair
      allow: ["task", "notes", "contact", "client-change"],
      has: { meeting: { client: "tailspin", date: "2026-11-09", people: ["lucas", "priya", "maria"] } },
    }),
    c("meeting with a new prospect", "meeting", "met the founder of litware labs today, ravi kumar, they need a new website + seo. budget ~5L. send proposal next week", {
      kinds: ["meeting", "meeting-notes", "client"],
      allow: ["task", "notes", "contact", "client-change"],
      has: { meeting: { client: "litware", people: ["ravi"] }, client: { name: "litware" } },
    }),
    c("internal meeting, no client", "meeting", "team meeting today with raj and priya: we agreed every client gets a monthly report by the 5th from now on", {
      kinds: [],
      allow: ["meeting", "meeting-notes", "knowledge", "task"],
    }),
    c("future meeting is a task", "meeting", "set up a call with anna from fabrikam next tuesday to go over the december content plan", {
      kinds: [],
      allow: ["task", "ask", "meeting"],
    }),

    // contact
    c("new person at a client", "contact", "northwind's new ecommerce manager is daniel kim, daniel.kim@northwind.example. he'll approve the product pages", {
      kinds: ["contact"],
      allow: ["notes"],
      has: { contact: { name: "daniel", client: "northwind", email: "daniel.kim@northwind.example" } },
    }),
    c("contact already there", "contact", "add anna park from fabrikam as a contact, she's the founder", { kinds: [], allow: ["contact-change", "notes"] }),
    c("contact's new email", "change", "james at contoso has a new email, james.carter@contosohealth.example", {
      kinds: ["contact-change"],
      has: { "contact-change": { email: "james.carter@contosohealth.example" } },
    }),
    c("person at a non-client firm", "contact", "our printer contact is nikhil at orbit press, 98200 11223, for brochures", { kinds: ["contact"], allow: ["knowledge", "notes"], has: { contact: { name: "nikhil" } } }),

    // project
    c("new project for a client", "project", "fabrikam just approved a brand identity project, 2L, priya leads, start 1 dec", {
      kinds: ["project"],
      allow: ["notes"],
      has: { project: { client: "fabrikam", service: "brand", lead: "priya", start: "2026-12-01" } },
    }),
    c("retainer won", "project", "contoso is adding social media to their retainer from december, 45k a month, raj will run it", {
      kinds: ["project"],
      allow: ["notes", "task"],
      has: { project: { client: "contoso", service: "social", lead: "raj" } },
    }),
    c("project lead changes", "change", "raj is taking over the northwind website from priya", { kinds: ["project-change"], allow: ["notes", "task-change"], has: { "project-change": { lead: "raj" } } }),
    c("project done", "change", "adatum brand project is done, they signed off the final logo today", { kinds: ["project-change"], allow: ["notes", "task-change", "process"], has: { "project-change": { status: "done" } } }),

    // service
    c("new service", "service", "we now offer google ads management, 35k a month + ad spend", { kinds: ["service"], has: { service: { name: "ads", amount: "35000", period: "monthly" } } }),
    c("price change", "change", "our seo retainer price is now 70k a month for new clients. existing ones stay as they are", { kinds: ["service-change"], allow: ["notes", "knowledge"], has: { "service-change": { amount: "70000" } } }),

    // private
    c("keep a client private", "private", "adatum legal is confidential, keep them between me and priya, nobody else on the team should see them", { kinds: ["private"], allow: ["client-change"] }),

    // read
    c("what did we agree", "read", "what did we agree with northwind on the website kickoff?", { kinds: [] }),
    c("who is the contact", "read", "who's our contact at contoso and what's their email?", { kinds: [] }),
    c("what are we billing", "read", "how much are we charging contoso every month?", { kinds: [] }),
    c("last meeting with tailspin", "read", "when did we last talk to tailspin and what's pending from us?", { kinds: [] }),
    c("what's priya leading", "read", "which projects is priya leading right now?", { kinds: [] }),

    // many: a busy owner's end-of-day dump, long and half-ordered, as typed on a phone
    c("end of day dump", "many", `ok quick update before i forget:
1. met anna at fabrikam this morning (me + priya). they want to add a website redesign, 3.5L, priya to lead, start mid dec. she was happy with the november posts
2. their new marketing manager is chloe martin, chloe@fabrikam.example, she'll be our day to day contact now
3. northwind is late on brand assets again, sarah says by wednesday
4. we're adding a new service - landing page sprint, 75k one-time`, {
      kinds: ["meeting", "meeting-notes", "project", "contact", "service"],
      allow: ["task", "task-change", "notes", "client-change"],
      has: {
        meeting: { client: "fabrikam", people: ["anna", "priya"] },
        project: { client: "fabrikam", service: "website", lead: "priya" },
        contact: { name: "chloe", client: "fabrikam", email: "chloe@fabrikam.example" },
        service: { name: "landing", amount: "75000" },
      },
    }),
    c("pasted call notes", "many", `notes from the adatum call (meera, priya, their partner john silva, and kate from their ops):
- logo route A approved w/ small changes - darker navy, tighter kerning
- they also want the website done, same look. told them 3.5L, they're ok
- kate (kate@adatum.example) handles invoices from now on
- next: priya sends final logo files by 18 nov, i send website proposal`, {
      kinds: ["meeting", "meeting-notes", "project", "contact"],
      allow: ["task", "task-change", "notes", "process", "contact-change"],
      has: {
        meeting: { client: "adatum", people: ["john", "kate", "priya"] },
        project: { client: "adatum", service: "website" },
        contact: { name: "kate", client: "adatum", email: "kate@adatum.example" },
      },
    }),
    c("whatsapp-style forward", "many", `fwd from raj: "contoso call done. james confirmed the dec blog calendar, wants 6 posts not 4. also their new cmo is olivia brown (olivia@contoso.example), she wants a quarterly review with you"`, {
      kinds: ["meeting", "meeting-notes", "contact"],
      allow: ["task", "notes", "project-change"],
      has: { meeting: { client: "contoso", people: ["raj", "james"] }, contact: { name: "olivia", client: "contoso", email: "olivia@contoso.example" } },
    }),

    // held out: written after the rules settled
    c("call about a late invoice", "meeting", "spoke to tom at northwind about the overdue website invoice, he says they'll pay by the 25th", {
      // a quick call with one fact: a check on the 25th is the work; a meeting record is fine too
      kinds: ["task"],
      allow: ["meeting", "meeting-notes", "notes", "process", "task-change"],
    }),
    c("prospect signs with a project", "many", "tailspin signed!! full rebrand, 4L, priya leads it, lucas stays our main contact", {
      kinds: ["client-change", "project"],
      allow: ["notes", "process", "task", "contact-change"],
      has: { project: { client: "tailspin", service: "brand", lead: "priya" } },
    }),
    c("contact leaves", "change", "james has left contoso. their new brand manager is olivia brown, olivia@contoso.example", {
      kinds: ["contact", "contact-change"],
      allow: ["notes"],
      has: { contact: { name: "olivia", client: "contoso", email: "olivia@contoso.example" } },
    }),
    c("private project", "private", "make the adatum brand project private, only me and the admins", { kinds: ["private"] }),
    c("what's open with fabrikam", "read", "anything pending with fabrikam? who's their contact again", { kinds: [] }),

    // a chat that goes on: the owner follows up with what was missing
    c("follow-up adds people", "meeting", [
      person("log a meeting: northwind website review today"),
      ...ran(
        "Log the meeting",
        'emplio meetings add "Northwind website review" --date 2026-11-10 --client northwind-traders --project northwind-website',
        "added 2026-11-10-northwind-website-review\t2026-11-10\tNorthwind website review\tclient northwind-traders\tproject northwind-website\nnotes: /work/company/meetings/2026-11-10-northwind-website-review.md (write them there: what was said, decided, and who does what next)",
      ),
      emplio("Logged \"Northwind website review\" for today under Northwind Traders and the website project. Who was in it, and what was decided?"),
      person("me, priya, sarah and tom. they approved the wireframes and want our homepage copy by the 20th"),
    ], {
      kinds: ["meeting-change", "meeting-notes"],
      // wireframes approved: their task is done
      allow: ["task", "task-change", "notes", "project-change"],
      has: { "meeting-change": { people: ["priya", "sarah", "tom"] } },
    }),
  ];
}
