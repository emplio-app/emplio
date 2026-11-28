// A made-up agency for the client-records eval: its clients, the people there, what it sells, the projects going and
// the meetings held, as Emplio's commands would show them. Nothing here is a real customer's. The team is the
// harness's (Meera owner, Raj member, Priya admin).
import type { Business, World } from "../emplio";

export const FIRM: Business["firm"] = {
  name: "Lumen Studio",
  about:
    "A design and digital marketing agency: websites, brand identity, SEO and social media for about 30 clients, mostly retainers. Each client has one of us looking after them and each project a lead. Invoices are due in 15 days.",
};

const help = async (area: string) => (await import(`../../src/${area}`)).USAGE as string;
const TEAM = "Meera <meera@kaveri.example>\towner\nRaj <raj@kaveri.example>\tmember\nPriya <priya@kaveri.example>\tadmin";

const CLIENTS = [
  "northwind-traders\tActive\tPriya\t2 open\tNorthwind Traders",
  "contoso-health\tActive\tRaj\t1 open\tContoso Health",
  "fabrikam-foods\tActive\tPriya\t0 open\tFabrikam Foods",
  "adatum-legal\tActive\tMeera\t1 open\tAdatum Legal",
  "tailspin-travel\tProspect\tnobody named\t0 open\tTailspin Travel",
].join("\n");
const SHOW: Record<string, string> = {
  northwind: `Northwind Traders (Active), handled by Priya · updatedAt 2026-11-04T09:12:00.000Z
Contacts: Sarah Lee (Head of marketing, sarah@northwind.example), Tom Becker (CFO, tom@northwind.example)
Projects: northwind-website (Website redesign, lead Priya, active, due 2026-12-20)
Meetings: 2026-11-03-northwind-website-kickoff
Open work: Send homepage wireframes (Priya, due Thu 12 Nov); Collect brand assets (waiting on Northwind Traders)
Notes: company/clients/northwind-traders/index.md`,
  contoso: `Contoso Health (Active), handled by Raj · updatedAt 2026-10-01T09:00:00.000Z
Contacts: James Carter (Brand manager, james@contoso.example)
Projects: contoso-seo (SEO retainer, lead Raj, active, ₹60,000 monthly)
Meetings: 2026-11-06-contoso-monthly-review
Open work: October SEO report (Raj, due Fri 13 Nov)
Notes: company/clients/contoso-health/index.md`,
  fabrikam: `Fabrikam Foods (Active), handled by Priya · updatedAt 2026-09-12T09:00:00.000Z
Contacts: Anna Park (Founder, anna@fabrikam.example)
Projects: fabrikam-social (Social media management, lead Priya, active, ₹45,000 monthly)
Meetings: none yet
Notes: company/clients/fabrikam-foods/index.md`,
  adatum: `Adatum Legal (Active), handled by Meera · updatedAt 2026-10-20T09:00:00.000Z
Contacts: none yet
Projects: adatum-brand (Brand identity, lead Meera, active, ₹2,00,000 once)
Notes: company/clients/adatum-legal/index.md`,
  tailspin: `Tailspin Travel (Prospect), handled by nobody named · updatedAt 2026-10-28T12:00:00.000Z
Contacts: Lucas Meyer (Marketing lead, lucas@tailspin.example)
Projects: none
Meetings: 2026-10-28-tailspin-intro-call
Notes: company/clients/tailspin-travel/index.md`,
};
const CONTACTS = [
  "sarah-lee\tSarah Lee\tHead of marketing\tsarah@northwind.example\tNorthwind Traders",
  "tom-becker\tTom Becker\tCFO\ttom@northwind.example\tNorthwind Traders",
  "james-carter\tJames Carter\tBrand manager\tjames@contoso.example\tContoso Health",
  "anna-park\tAnna Park\tFounder\tanna@fabrikam.example\tFabrikam Foods",
  "lucas-meyer\tLucas Meyer\tMarketing lead\tlucas@tailspin.example\tTailspin Travel",
].join("\n");
const SERVICES = [
  "website-redesign\tWebsite redesign\t₹3,50,000 once\tprocess website-build\t1 active",
  "seo-retainer\tSEO retainer\t₹60,000 monthly\t\t1 active",
  "social-media\tSocial media management\t₹45,000 monthly\t\t1 active",
  "brand-identity\tBrand identity\t₹2,00,000 once\tprocess brand-sprint\t1 active",
].join("\n");
const PROJECTS = [
  "northwind-website\tWebsite redesign for Northwind\tNorthwind Traders\tWebsite redesign\tlead Priya\tactive\tdue 2026-12-20\t₹3,50,000 once",
  "contoso-seo\tContoso SEO retainer\tContoso Health\tSEO retainer\tlead Raj\tactive\t₹60,000 monthly",
  "fabrikam-social\tFabrikam social media\tFabrikam Foods\tSocial media management\tlead Priya\tactive\t₹45,000 monthly",
  "adatum-brand\tAdatum brand identity\tAdatum Legal\tBrand identity\tlead Meera\tactive\t₹2,00,000 once",
].join("\n");
const MEETINGS = [
  "2026-11-06-contoso-monthly-review\t2026-11-06\tContoso monthly review\tclient contoso-health\tproject contoso-seo\tRaj, James Carter",
  "2026-11-03-northwind-website-kickoff\t2026-11-03\tNorthwind website kickoff\tclient northwind-traders\tproject northwind-website\tPriya, Sarah Lee",
  "2026-10-28-tailspin-intro-call\t2026-10-28\tTailspin intro call\tclient tailspin-travel\tMeera, Lucas Meyer",
].join("\n");
const MEETING_NOTES: Record<string, string> = {
  "northwind-website-kickoff": "# Northwind website kickoff\n\n[[clients/northwind-traders]] [[projects/northwind-website]]\n\n- Sarah wants the new site live before their spring sale (mid-March).\n- Agreed: 5 page templates, Webflow, Priya leads, Raj does SEO setup.\n- Next: Priya sends homepage wireframes by 12 Nov; Northwind sends brand assets.",
  "contoso-monthly-review": "# Contoso monthly review\n\n[[clients/contoso-health]] [[projects/contoso-seo]]\n\n- Organic traffic up 18% in October; 'clinic near me' pages ranking top 5.\n- James asked for a blog calendar for December.\n- Next: Raj sends the October report by 13 Nov.",
  "tailspin-intro-call": "# Tailspin intro call\n\n[[clients/tailspin-travel]]\n\n- Lucas wants a full rebrand before their 2027 season; budget around ₹4L.\n- Next: Meera sends a proposal.",
};
const PROCESSES = ["website-build\t5 steps\tby hand\t1 going\tWebsite build", "brand-sprint\t4 steps\tby hand\t1 going\tBrand sprint", "client-onboarding\t4 steps\tby hand\t0 going\tClient onboarding", "monthly-report\t3 steps\tstarted by automation monthly-reports\t2 going\tMonthly report"].join("\n");
const TASKS = [
  "a1f3c9d2\ttodo\tThu 12 Nov, 6:00 pm\tPriya\tNorthwind Traders: Send homepage wireframes [project northwind-website]",
  "b7e21d04\twaiting\tFri 13 Nov, 6:00 pm\tPriya\tNorthwind Traders: Collect brand assets (waiting on Northwind Traders)",
  "c05d8e11\ttodo\tFri 13 Nov, 6:00 pm\tRaj\tContoso Health: October SEO report [project contoso-seo]",
  "d9c4a370\ttodo\tMon 16 Nov, 6:00 pm\tMeera\tAdatum Legal: Present logo routes",
].join("\n");

// a name or slug, any case, as a pattern (Northwind, northwind-traders)
const loose = (word: string) => word.replace(/./g, (x) => `[${x}${x.toUpperCase()}]`);
const SEARCH = (q: string) => {
  const hits = [...CLIENTS.split("\n"), ...CONTACTS.split("\n"), ...PROJECTS.split("\n"), ...MEETINGS.split("\n")].filter((l) => l.toLowerCase().includes(q.toLowerCase()));
  const notes = Object.entries(MEETING_NOTES).filter(([, t]) => t.toLowerCase().includes(q.toLowerCase())).map(([k, t]) => `company/meetings/${MEETINGS.split("\n").find((l) => l.includes(k))!.split("\t")[0]}.md: ${t.split("\n").find((l) => l.toLowerCase().includes(q.toLowerCase()))}`);
  return `== Files\n${notes.join("\n") || "(none)"}\n\n== Past chats\n(none)\n\n== Activity\n(none)\n\n== Records (clients, contacts, projects, services, meetings)\n${hits.join("\n") || "(none)"}\n\n== Tasks\n${TASKS.split("\n").filter((l) => l.toLowerCase().includes(q.toLowerCase())).join("\n") || "(none)"}`;
};

// emplio <kind> list --client <name>: only that client's lines
const byClient = (kind: string, rows: string) =>
  Object.keys(SHOW).map((k): [string, string] => [`${kind} list .*--client\\s+['"]?${loose(k)}`, rows.split("\n").filter((l) => l.toLowerCase().includes(k)).join("\n") || "(none)"]);

// what the agency's commands answer, first match wins; writes answer like the server does (meetings add: client-records.eval.ts)
export const world = async (): Promise<World> => [
  ["clients help", await help("clients")],
  ["contacts help", await help("contacts")],
  ["projects help", await help("projects")],
  ["services help", await help("services")],
  ["meetings help", await help("meetings")],
  ["tasks help", await help("tasks")],
  ["team( list)?\\s*$", TEAM],
  ["clients (list|search)|clients\\s*$", CLIENTS],
  ...Object.entries(SHOW).map(([k, v]): [string, string] => [`clients show .*${loose(k)}`, v]),
  ["clients show", "error: no such client (emplio clients list)"],
  ...Object.entries(SHOW).map(([k, v]): [string, string] => [`clients add .*${loose(k)}`, `error: did you mean ${v.split(" (")[0]}? (emplio clients show ${k}); if this is another client, add it with --force`]),
  ["clients add", "added: on the client list; their notes are company/clients/<slug>/index.md"],
  ["(clients|contacts|projects|services) update .*\\s['\"]?([aA]mount|[pP]rice|[fF]ee|[eE]mail|[pP]hone|[lL]ead|[sS]tatus|[sS]tage|[pP]eriod)=", 'error: that isn\'t a field: use its option, --amount, --email, --lead... (emplio <kind> help)'],
  ["clients update .*['\"]?(Notes?|Comments?|Summary|History|Updates?)=", 'error: "Notes" isn\'t a field: notes are words, in the client\'s notes file (its show gives the path)'],
  ["clients update .*[aA]datum.*--private (yes|true)", "updated adatum-legal\tActive\tMeera\t1 open\tAdatum Legal\nprivate now: only owners, admins and whoever handles them see them, their projects, tasks and notes (their open tasks too, nothing to change on those); notes moved to /work/restricted/clients/adatum-legal/index.md"],
  ["clients update", "updated"],
  ...byClient("contacts", CONTACTS),
  ["contacts (list|search)|contacts\\s*$", CONTACTS],
  ["contacts show .*([sS]arah|[lL]ee)", "Sarah Lee, Head of marketing at Northwind Traders · sarah@northwind.example · +44 20 7946 0102 · updatedAt 2026-11-03T10:00:00.000Z\nnotes: company/contacts/sarah-lee/index.md"],
  ["contacts show .*([jJ]ames|[cC]arter)", "James Carter, Brand manager at Contoso Health · james@contoso.example · updatedAt 2026-10-01T10:00:00.000Z\nnotes: company/contacts/james-carter/index.md"],
  ["contacts show .*([aA]nna|[pP]ark)", "Anna Park, Founder at Fabrikam Foods · anna@fabrikam.example · updatedAt 2026-09-01T10:00:00.000Z\nnotes: company/contacts/anna-park/index.md"],
  ["contacts show .*([tT]om|[bB]ecker)", "Tom Becker, CFO at Northwind Traders · tom@northwind.example\nnotes: company/contacts/tom-becker/index.md"],
  ["contacts show .*([lL]ucas|[mM]eyer)", "Lucas Meyer, Marketing lead at Tailspin Travel · lucas@tailspin.example\nnotes: company/contacts/lucas-meyer/index.md"],
  ["contacts show", "error: no such contact (emplio contacts list)"],
  ["contacts add .*([sS]arah [lL]ee|[aA]nna [pP]ark|[jJ]ames [cC]arter)", "error: there's a contact close to that already: did you mean the one there? (emplio contacts show <name>; --force only if it's someone else)"],
  ["contacts add", "added: their notes are company/contacts/<slug>/index.md"],
  ["contacts update", "updated"],
  ["services (list|search)|services\\s*$", SERVICES],
  ["services show .*[sS][eE][oO]", "SEO retainer (seo-retainer) · ₹60,000 monthly · 1 active project · updatedAt 2026-08-01T09:00:00.000Z\nnotes: company/services/seo-retainer/index.md"],
  ["services show .*[wW]ebsite", "Website redesign (website-redesign) · ₹3,50,000 once · updatedAt 2026-08-01T09:00:00.000Z · process website-build · 1 active project\nnotes: company/services/website-redesign/index.md"],
  ["services add", "added: on the services list; notes are company/services/<slug>/index.md"],
  ["services update", "updated"],
  ...byClient("projects", PROJECTS),
  ["projects (list|search)|projects\\s*$", PROJECTS],
  ["projects show .*([nN]orthwind|website)", "Website redesign for Northwind (northwind-website) · Northwind Traders · Website redesign · lead Priya · active · started 2026-11-02 · due 2026-12-20 · ₹3,50,000 once · updatedAt 2026-11-04T09:12:00.000Z\nOpen work: Send homepage wireframes (Priya, due Thu 12 Nov)\nnotes: company/projects/northwind-website/index.md"],
  ["projects show .*([cC]ontoso|seo)", "Contoso SEO retainer (contoso-seo) · Contoso Health · SEO retainer · lead Raj · active · ₹60,000 monthly · updatedAt 2026-10-01T09:00:00.000Z\nnotes: company/projects/contoso-seo/index.md"],
  ["projects show .*([fF]abrikam|social)", "Fabrikam social media (fabrikam-social) · Fabrikam Foods · Social media management · lead Priya · active · ₹45,000 monthly · updatedAt 2026-09-12T09:00:00.000Z\nnotes: company/projects/fabrikam-social/index.md"],
  ["projects show .*([aA]datum|brand)", "Adatum brand identity (adatum-brand) · Adatum Legal · Brand identity · lead Meera · active · started 2026-10-05 · ₹2,00,000 once · updatedAt 2026-10-20T09:00:00.000Z\nOpen work: Present logo routes (Meera, due Mon 16 Nov)\nnotes: company/projects/adatum-brand/index.md"],
  ["projects show", "error: no such project (emplio projects list)"],
  ["projects add .*([wW]ebsite|[bB]rand)", "added: a project for the client; its process started, step 1 is task f00dcafe for its lead (emplio processes runs); notes are company/projects/<slug>/index.md"],
  ["projects add", "added: a project for the client (its service has no process, so nothing started); notes are company/projects/<slug>/index.md"],
  ["projects update", "updated"],
  ...byClient("meetings", MEETINGS),
  ["meetings (list|search)|meetings\\s*$", MEETINGS],
  ...Object.entries(MEETING_NOTES).map(([k, v]): [string, string] => [`meetings show .*${k.split("-")[0]}|meetings/[\\d-]*${k}\\.md`, v]),
  ["meetings update", "updated"],
  ["processes( list)?\\s*$", PROCESSES],
  ["processes runs", "4c1e04aa\tWebsite build\tNorthwind Traders\tstep 2/5 Wireframes (Priya, todo, due 2026-11-12, task a1f3c9d2)\n9b9f2d10\tBrand sprint\tAdatum Legal\tstep 3/4 Present logo routes (Meera, todo, due 2026-11-16, task d9c4a370)"],
  ["processes start", "Started 5e6f7a8b: step 1 is made (emplio processes runs)."],
  ["tasks (list|search)", TASKS],
  ["tasks add", "added f00dbeef\ttodo"],
  ["tasks (update|done)", "updated"],
  ["emplio search (.+)", ""],
  ["company/clients/northwind[^ ]*index\\.md", "# Northwind Traders\n\nRetail homeware brand, 14 stores. Sarah decides on design; Tom signs invoices.\n\n- 2026-11-03: website kickoff, see [[projects/northwind-website]]."],
  ["company/clients/[^ ]*index\\.md", "# Notes\n\n(nothing much yet)"],
];

// emplio search <words>: what it finds in this agency (the real search's parts, the files and records that match)
export const search = (command: string) => {
  const m = /emplio search\s+(.+)$/.exec(command);
  if (!m) return null;
  const words = m[1]!.replace(/['"]/g, "").split(/\s+/).filter(Boolean);
  // the longest word that finds something, so "sarah northwind call" still shows Sarah
  for (const w of [...words].sort((a, b) => b.length - a.length)) {
    const s = SEARCH(w);
    if (!/Records[^\n]*\n\(none\)/.test(s) || !/Files\n\(none\)/.test(s)) return s;
  }
  return SEARCH(words[0] ?? "");
};
