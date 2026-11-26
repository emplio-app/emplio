import { generateId, type UIMessage } from "ai";
import { and, asc, desc, eq, gt, isNull, like, max, ne, notInArray, notLike } from "drizzle-orm";
import { BRIEF_PREFIX, CHECK_IN_PREFIX, REPORT_PREFIX, JOB_NOTE_PREFIX, JOBS_DONE_PREFIX, WORKERS_DONE_PREFIX, type Settings, type Task } from "@emplio/shared";
import { personFor } from "./automations";
import { foldIdleChats, generateReply, quiet } from "./chat";
import { chatLink, heldBack, mainChat, post } from "./channels";
import { db } from "./db";
import { activity, automationRuns, chatNotes, connections, conversations, messages, users, workspaceMembers, workspaces } from "./db/schema";
import { toolsIn } from "./agents";
import { createFile, ensureRepo, listPaths, readFile } from "./gitea";
import { overLimit, PROMPT_LIMIT } from "./sandbox";
import { runAction } from "./integrations";
import { isReplying, notify } from "./live";
import { settingsFor } from "./settings";
import { chase, line, listTasks } from "./tasks";
import { notesWithNames, readChats, SILENT } from "./reader";
import { at, dayIn as day, hourIn, minuteIn, timezoneOf, when as time } from "./time";

// Check-ins (on by default): every few hours in the working day the agent looks around on
// its own, as the owner, in one hidden "Check-ins" chat per business (kind background); a note that needs them is
// posted to the owner's main chat (channels/index.ts post), and so to their phone (to their email when no Telegram
// reaches them in this business). It goes through the owner's
// list, company/heartbeat.md, handles what it can and writes only when something needs a person. The same timer sends people's task reminders (`chase`).
// The day's first check-in is the morning brief (always written: today's tasks, what's late, what needs the owner),
// and one at the report hour (Settings → Schedule) is the end-of-day report (done / not done / couldn't / assumed), whatever the interval. Everyone
// else on the team gets their own morning brief and end-of-day report at the same times, run as them in their main
// chat, so it sees only what they may see (their tasks, their calendar and email); it says nothing when there's nothing for them. A check-in
// with nothing to say answers SILENT and is removed from the chat (the activity log still has what it did).
// Never while the chat is busy, and missed check-ins coalesce into one. A cheap look first (`worthWaking`): the AI is only woken when something changed.
// The owner's check-ins are the business's background agent (the "thinker"): every round it gets the goals
// (company/goals.md), its own journal (restricted/journal.md: open matters, and what it tried and how that went)
// and the readers' notes on everyone's chats since its last round (reader.ts). It sees everything, changes the
// business's own setup (knowledge, skills, tasks, goal progress), hands outside work to the AI employee as tasks,
// only suggests automations and messages only the team. An urgent note wakes it before its next round. Its
// rounds stay in its chat (one with nothing to say is hidden, not deleted), so it carries on from what it did.
// ponytail: one ticker in this process; the claim is a compare-and-set, so a second server wouldn't double-fire

export const HEARTBEAT = "heartbeat";
const EVERY: Record<string, number> = { "1h": 1, "2h": 2, "4h": 4, daily: 20 };

const DEFAULT_GOALS = `# Goals

What the business is working toward: the owner sets these; the AI employee works toward them and its background
rounds add dated progress lines under each.

## This year

## This quarter

## Current initiatives
`;

const DEFAULT_JOURNAL = `# Background agent's journal

## Open matters
(what's in motion and what to check next round)

## Tried
(each suggestion, change or nudge: date, what, for whom; then how it turned out)
`;

const MAX_NOTES = 150;
const clip = (s: string, max: number) => (s.length > max ? `${s.slice(0, max)}\n… (cut: read the file for the rest)` : s);

// The words of thinkerBrief, from pieces already read; the evals (backend/evals/background-round) use it too.
// changes: what the server found new since the last round (changesSince); tooLong: memory files over the prompt's
// limit, for the daily cleanup to rewrite.
export const backgroundBrief = (p: { name: string; chat: string; today: string; goals: string; journal: string; notes: string; changes?: string; tooLong?: string; tidy?: string }) =>
  `## You, in the background
You are ${p.name}'s background agent: the same Emplio as in everyone's chats, working between them as the owner. Nobody is watching or will answer. Your job: keep the business's memory, tasks and goals true, so every chat goes better and nothing falls through. You see everything: anyone's chats (\`emplio history search <words>\`, \`emplio history show <chat>\`), activity, tasks, all files including restricted/, the database, and the apps (to read).

Yours to change:
- Knowledge: one folder per thing in company/, its main page index.md: clients/, contacts/ (someone at a client, client: "[[clients/<name>]]"), team/ (someone on the team), services/, projects/ (client: "[[clients/<name>]]"); longer notes on one beside its index.md; a meeting: company/meetings/<YYYY-MM-DD>-<name>.md; the rest in knowledge/ (suppliers/, topics/); each line dated with its source and the person's own words; a changed fact: add the new line and mark the old one "(replaced <date>)". Links are [[<folder>/<name>]] (any note: [[knowledge/topics/pricing]]), one to each page or note it's about, in quotes in the YAML at the top, several as a list (team: then - "[[team/sarah]]" lines); never move a client's folder.
- People: \`emplio person <email>\` shows someone's profile and preferences; \`emplio person <email> prefer "<line>"\` adds a preference (\`profile\` for who they are); \`emplio person <email> rewrite prefer <<'EOF'\` replaces the whole preferences file (\`rewrite profile\` the profile). Preferences hold only rules for all of that person's work; anything about one client, person or job goes in that one's knowledge file or the job's skill.
- Skills: a way of doing a job that was worked out or corrected: fix the skill that covers it, else make one for the kind of job (company/skillset/<name>/SKILL.md).
- Tasks: \`emplio tasks add "<what>" --to <email or ai> --due <when>\`, \`emplio tasks done <id>\`, \`emplio tasks update <id> --status cancelled\`; one per thing, never two joined with "and".
- Goals: dated progress lines in company/goals.md under the goal they move; never the goals themselves.
- Your journal (restricted/journal.md): open matters and what you tried, short; drop what's settled.
- Tools (company/ and restricted/ toolset/<area>.py): only what "Toolset to tidy" lists, in the daily cleanup.
Never yourself: email or message customers or suppliers, change data in apps, pay, delete, or use the browser. That becomes a task for the AI (\`emplio tasks add "<what>" --to ai --due <when> --notes "<how>"\`) or for the person it belongs to.
Automations: only suggest one, to the person whose work it is, for work done by hand again and again; never create one, never the same suggestion twice (journal).
Messaging: the team only, \`emplio channels send <email> "<message>"\`, only when something needs that person, all in one message, at most 3 a day each.
What you need is below: look further only where something below points. Check a thing isn't saved already (\`emplio search\`) before saving it. Do your changes in as few steps as you can.

## What changed since your last round
${p.changes?.trim() || "(nothing new beyond the notes below)"}

## Readers' notes on people's chats since your last round
${p.notes}
A note isn't enough? Read the chat: \`emplio history show <chat>\`.
${p.tooLong ? `\n## Memory files over their limit (shown cut short in every chat)\n${p.tooLong}\n` : ""}${p.tidy ? `\n## Toolset to tidy\n${p.tidy}\n` : ""}
## Goals (company/goals.md)
${clip(p.goals.trim(), 8000)}${p.goals.trim() === DEFAULT_GOALS.trim() ? "\n(Not set yet.)" : ""}

## Your journal (restricted/journal.md)
${clip(p.journal.trim(), 8000)}
`;

// What every round of the background agent starts from, after the round's own instructions.
async function thinkerBrief(w: typeof workspaces.$inferSelect, chatId: string, last: Date | null, tz: string, changes: string, daily: boolean) {
  await ensureRepo(w.id, "restricted", "Finance, HR and owner notes");
  let [goals, journal] = await Promise.all([readFile(w.id, "company", "goals.md"), readFile(w.id, "restricted", "journal.md")]);
  if (goals === null) await createFile(w.id, "company", "goals.md", (goals = DEFAULT_GOALS), "Add the goals file");
  if (journal === null) await createFile(w.id, "restricted", "journal.md", (journal = DEFAULT_JOURNAL), "Start the background agent's journal");
  const notes = await notesWithNames(w.id, last ? [gt(chatNotes.createdAt, last)] : [], MAX_NOTES, tz);
  const more = (notes[0]?.total ?? 0) - notes.length;
  const today = day(new Date(), tz);
  return backgroundBrief({
    name: w.name,
    chat: chatId.slice(0, 8),
    today,
    goals,
    journal,
    changes,
    tooLong: daily ? await tooLong(w.id) : "",
    tidy: daily ? await toolsetTidy(w.id).catch(() => "") : "",
    notes: notes.length ? `${more > 0 ? `(${more} earlier ones: \`emplio notes --since ${last ? day(last, tz) : today}\`)\n\n` : ""}${notes.map((n) => n.line).join("\n\n")}` : "(nothing)",
  });
}

const DEFAULT_CHECKLIST = `# Check-ins

What the AI employee looks at on its own every few hours. The owner edits this list; things to do later are tasks (Tasks in the web app).

## Always check
- New emails that need a reply from us (if Gmail is connected)
- Automations that failed since the last check-in
- Customer or staff messages nobody has answered
`;

// Every day and hour below is on the clock of the person the round is for (the owner's, or the staff
// member's): their morning, their evening, their "today" (time.ts).

type Kind = "check-in" | "brief" | "report";

// every round of the background agent starts with these (the notes, changes and journal are below the round's message)
const FILE = `First, everything new below ("What changed", "Readers' notes"): file each thing where it belongs (a fact: knowledge; how someone likes things done: \`emplio person\`; a way of doing a job: its skill; a promise or follow-up with no task: a task) and handle each change (a failed automation: find why and add a task to fix it; an email or message that needs an answer: a task for whoever it's on). Nothing new: skip this.`;
const JOURNAL = `Update your journal (restricted/journal.md) only if something is open or you tried something: open matters as they stand, and how earlier tries turned out.`;
// once a day, in the day's last round (the report, else the brief): the bigger look
const DAILY = `Today's cleanup (do each part now):
a. Tasks (all open ones are listed below): close each one that's already done (a chat, an email or the activity shows it, by \`emplio search <words>\` or \`emplio history search <words>\`: \`emplio tasks done <id>\`); tasks that are the same thing: keep one, cancel the rest (\`emplio tasks update <id> --status cancelled\`); cancel ones that no longer matter; chase or reassign late ones (the person's own reminder covers a task due today).
b. Memory: rewrite each file under "Memory files over their limit" so it fits in half its limit: merge repeated lines into one, drop rules that are stale or that a later line contradicts, move lines about one client, person or job into that one's knowledge file or skill (their exact words), keep every rule that still holds for all their work, one short line each without dates or backstory. Rules where a slip would hurt stay in the file even when they name someone: who never to contact, money, what needs their OK before it goes out. People's files with the \`emplio person <email> rewrite\` command named beside each; company files in place.
c. A job that went wrong or was corrected today: fix its skill. Work done by hand again and again: suggest an automation (journal first).
d. Tools, only what "Toolset to tidy" lists, in Python: tools that do the same thing: keep the better one (fix it to cover both, \`emplio.tools.save(fn, area=..., risk=..., replace=True)\`), delete the other from its file, and put the kept name in place of the other in each agent's list (\`emplio agents update <agent> --tools ...\`) and skill that names it. A file too long: move a group of its tools that belong together into a new area file the same way, then delete them from the old one. Check each changed area still loads (\`from tools.<area> import *\`).
e. Clients (\`emplio clients list\`): anyone the business clearly works for, met today and missing: add them. Stages that changed (a prospect won: active or the business's own word for where they are, like onboarding; work ended: past): \`emplio clients update <name> --stage <stage>\` (never by editing the stage: in their page). Nobody handling an active client: whoever did their work lately is (\`--handler\`), else ask the owner in the brief, once. Each active client whose work moved today: keep a "## Now" section at the top of their notes (in their page, company/clients/<name>/index.md, under its YAML top and the title, at most 5 lines: where things stand, the next step and who has it, what we're waiting on from them), rewritten, not appended; the dated lines stay below. Open tasks plainly for a client but not labelled: \`emplio tasks update <id> --client <name>\`. The same job done for two or more clients that plainly comes round again (a monthly report, a yearly filing): make it repeat for them (\`emplio tasks add "<job>" --every "<cron>" --clients <a,b or all> --due-days <n>\`, no app actions) unless one already does, and say so in one line of the brief. The same several steps done for two or more clients (or candidates, or projects) in the same order: write them as a process (\`emplio processes add\`, who does each step, days for each) unless one exists, and say so in one line of the brief; if one exists but the work went differently, update its steps.`;
// Mondays, in the brief
const WEEKLY = `This week's goals review (do it now, before the rest): for each goal in company/goals.md, look at the real numbers (apps to read, \`emplio db sql\`, tasks, activity), then write company/goals.md again with one new dated line under each goal ("- 2026-11-16: 31% of sales online, up from 28%"), every goal heading and earlier line left as it was. Add up to 3 tasks for this week that would move it most (to the AI or the person whose work it is), unless open ones already cover it. A goal with no progress in two weeks: one line in the brief. No goals set: ask the owner for them in the brief.`;

export const instructions = (kind: Kind, last: Date | null, tasks: string, tz: string, more: { daily?: boolean; weekly?: boolean } = {}) => {
  const steps = (...list: string[]) => list.filter(Boolean).map((t, i) => `${i + 1}. ${t}`).join("\n");
  const tail = `${JOURNAL}\n\nTasks:\n${tasks}`;
  if (kind === "brief")
    return `${BRIEF_PREFIX}Morning brief. Nobody asked for this; the owner reads it first thing.
${steps(FILE, more.weekly ? WEEKLY : "", `Go through "Always check" in company/heartbeat.md once, with the apps (to read). Something to do later: a task.`, more.daily ? DAILY : "", `Always write the brief (never ${SILENT}): at most 5 short bullets, one fact each, most important first, empty parts left out. If a calendar is connected, today's meetings come first (time, who; a clash or something to prepare). Then only what's late (and who it's on), due today, needs their decision (including new staff proposals in company/inbox/: who, what, one line), or came in overnight that matters. Rank by consequence and time, not by how many messages there are. Don't repeat what an earlier message in this chat already said unless it changed or is now late; old open items go in one line at most ("Still open: Gmail login, Rahul's question"). More than 5? Pick the 5 that most need the owner (money, customers, deadlines first), group alike ones ("3 supplier emails unanswered") and end with one line counting the rest ("Also: 14 late tasks, 9 emails; all in Tasks"). No greeting, no sign-off, nothing routine you already handled.`)}
${tail}`;
  if (kind === "report")
    return `${REPORT_PREFIX}End-of-day report. Nobody asked for this; the owner reads it this evening.
${steps(FILE, more.daily ? DAILY : "", `Write the report from what was done today (below, and \`emplio activity --since ${day(new Date(), tz)}\` if you need more), as up to five labelled lines, leaving out empty ones: **Done:** (the few that matter, comma-separated); **Not done:** (and when); **Couldn't:** (why, what you need); **Assumed:** (what you decided on your own); **Tomorrow:** (the first thing or two, and any early meeting). At most one line each, no intro or wrap-up; on a busy day name the few that matter and count the rest ("Done: GST filing, Mehta quote, 12 more"). Don't do new work now; add a task for anything that needs doing. If nothing at all happened today, reply with exactly ${SILENT} and nothing else.`)}
${tail}`;
  return `${CHECK_IN_PREFIX}Check-in: something changed since your last round. Nobody asked for this; the owner reads this chat later.
${steps(FILE, `Reply with exactly ${SILENT} unless the owner must see or decide something now; then one to three short lines, only that. Nothing routine you handled.`)}
${tail}`;
};

const staffBrief = (name: string, last: Date | null, tasks: string, tz: string) => `${BRIEF_PREFIX}Morning brief for ${name}. Nobody asked for this; ${name} reads it first thing. It's about their day only, never the owner's matters or anyone else's.
1. If their calendar is connected (\`emplio apps list\`), today's meetings. If their email is connected, what came in ${last ? `since ${time(last, tz)}` : "since yesterday"} that needs a reply from them.
2. Their tasks, below: late, due today, waiting on someone.
3. At most 5 short bullets, one fact each, most important first: meetings (time, who), then late and due-today tasks, then emails that need them. Don't do the work now and don't message anyone. No greeting, no sign-off. If there's nothing at all for them today, reply with exactly ${SILENT} and nothing else.

Their tasks:
${tasks}`;

const staffReport = (name: string, tasks: string, tz: string) => `${REPORT_PREFIX}End-of-day report for ${name}. Nobody asked for this; ${name} reads it this evening. It's about their day only, never the owner's matters or anyone else's.
1. What they did today: their tasks below, and \`emplio history search\` / \`emplio activity --since ${day(new Date(), tz)}\` for what they worked on with you.
2. Up to four labelled lines, leaving out empty ones: **Done:** (the few that matter); **Still open:** (late or due today and not done, and who it's waiting on); **Tomorrow:** (the first thing or two, and any early meeting if their calendar is connected); **Needs you:** (one thing they should do before they log off, if any). At most one line each, no greeting or sign-off. Don't do the work now and don't message anyone.
3. If nothing at all happened for them today and nothing is open, reply with exactly ${SILENT} and nothing else.

Their tasks:
${tasks}`;

// The business's tasks as of now, for the brief and the report: late, due today, waiting, done today. `mine`:
// only the ones this person does or asked for (a staff brief).
// ponytail: listTasks' 500 rows, soonest due first; a done-today query if a business has more
async function taskSummary(workspaceId: string, userId: string, tz: string, mine = false) {
  const all = await listTasks({ workspaceId, userId, role: mine ? "member" : "owner" }, { mine });
  const today = day(new Date(), tz);
  const due = (t: Task) => (t.dueAt ? new Date(t.dueAt) : null);
  const open = all.filter((t) => t.status === "todo" || t.status === "doing" || t.status === "waiting");
  const late = open.filter((t) => due(t) && due(t)! < new Date());
  const todays = open.filter((t) => !late.includes(t) && due(t) && day(due(t)!, tz) === today);
  const groups: [string, Task[]][] = [
    ["Late", late],
    ["Due today", todays],
    ["Waiting (not due yet)", open.filter((t) => t.status === "waiting" && !late.includes(t) && !todays.includes(t))],
    ["Done today", all.filter((t) => t.doneAt && day(new Date(t.doneAt), tz) === today)],
  ];
  // a busy business has hundreds: the first few of each, and how many more (the brief counts them, it doesn't list them)
  const text = groups
    .flatMap(([name, ts]) => (ts.length ? [`${name} (${ts.length}):`, ...ts.slice(0, 15).map((t) => line(t, tz)), ...(ts.length > 15 ? [`…and ${ts.length - 15} more`] : []), ""] : []))
    .join("\n")
    .trim();
  return text || "(none late, due today, waiting or done today)";
}

// What the AI's own tasks found since `since` (tasks.ts work): they don't message anyone unless they need a
// person, so the brief and the report are where their results reach people. `userId`: only theirs (a staff member's).
// ponytail: the latest 40; a busier day is counted, not listed
async function taskResults(workspaceId: string, since: Date, tz: string, userId?: string) {
  const rows = await db
    .select({ summary: activity.summary, createdAt: activity.createdAt })
    .from(activity)
    .where(
      and(
        eq(activity.workspaceId, workspaceId),
        eq(activity.kind, "task"),
        like(activity.summary, "Worked on task %"),
        gt(activity.createdAt, since),
        userId ? eq(activity.userId, userId) : undefined,
      ),
    )
    .orderBy(asc(activity.createdAt));
  if (!rows.length) return "";
  const shown = rows.slice(-40);
  return [
    `\n\nWhat your own tasks did since ${time(since, tz)} (not sent to anyone yet: put the ones that matter in, as results; skip routine "nothing new" ones):`,
    ...shown.map((r) => `- ${time(r.createdAt, tz)}: ${r.summary.replace(/^Worked on task /, "")}`),
    ...(rows.length > shown.length ? [`…and ${rows.length - shown.length} earlier`] : []),
  ].join("\n");
}

// A business's working day (Settings → Schedule): from its morning brief to an hour after its report, 8pm
// without one. Rounds, briefs and the report happen only inside it.
export const workingDay = (s: Pick<Settings, "briefHour" | "reportHour">) => {
  const report = s.reportHour === "off" ? null : Number(s.reportHour);
  return { start: Number(s.briefHour) || 9, end: report === null ? 20 : report + 1, report };
};

// A business's or person's own minute in the first quarter hour of the working day, the same every day (from its id)
export const startMinute = (id: string) => (parseInt(id.replace(/[^0-9a-f]/gi, "").slice(-4), 16) || 0) % 15;
const waitsToStart = (id: string, hour: number, start: number, tz: string) => hour === start && minuteIn(tz) < startMinute(id);

async function tick() {
  // readers run at any hour; the rounds they feed only in the working day
  await readChats().catch((error) => console.error("reading chats failed", error));
  // not awaited: the notes can take a while, and each chat is claimed so the next tick skips it
  void foldIdleChats().catch((error) => console.error("compacting idle chats failed", error));
  // each person's reminders, in their own work hours (tasks.ts)
  await chase().catch((error) => console.error("task reminders failed", error));
  const owners = new Map((await db.select().from(workspaceMembers).where(eq(workspaceMembers.role, "owner"))).map((m) => [m.workspaceId, m.userId]));
  for (const w of await db.select().from(workspaces)) {
    const settings = await settingsFor(w.id);
    const every = EVERY[settings.checkIns];
    const hours = workingDay(settings);
    // the business's rounds go by its owner's clock
    const tz = await timezoneOf(owners.get(w.id));
    const hour = hourIn(tz);
    if (!every || hour < hours.start || hour >= hours.end) continue;
    // a new business has no rounds until the owner has briefed it (setup.ts) or skipped that; one that's been
    // running keeps them
    if (!w.heartbeatAt && !w.setupDoneAt && !w.setupSkippedAt) continue;
    const today = day(new Date(), tz);
    const report = hours.report !== null && hour >= hours.report && (!w.reportAt || day(w.reportAt, tz) !== today);
    // the day's first round from the brief hour on is the brief, whatever ran overnight or how recently; a
    // business's very first round is one only in the morning (set up at 2pm: a check-in, tomorrow the brief)
    const brief = w.heartbeatAt ? w.heartbeatAt < at(today, `${String(hours.start).padStart(2, "0")}:00`, tz) : hour < 12;
    if (!report && !brief && w.heartbeatAt && Date.now() - w.heartbeatAt.getTime() < every * 3_600_000 - 60_000 && !(await urgentSince(w.id, w.heartbeatAt))) continue;
    // the day's first rounds start spread over its first quarter hour, not all in its first minute (computers are capped)
    if (brief && !report && waitsToStart(w.id, hour, hours.start, tz)) continue;
    const kind: Kind = report ? "report" : brief ? "brief" : "check-in";
    // not awaited: a check-in takes minutes; the claim in checkIn keeps the next tick from starting another
    void checkIn(w, kind).catch((error) => console.error("check-in failed", w.id, error));
  }
  // everyone but the owner, on their own clock: their brief, once a day, on the first tick of their working
  // day (none after noon: a brief that late isn't one), and their report from the report hour to the working day's end
  // ponytail: looks up every staff member's zone each minute; keep the zone on the member row if there are thousands
  for (const m of await db.select().from(workspaceMembers).where(ne(workspaceMembers.role, "owner"))) {
    const settings = await settingsFor(m.workspaceId);
    const hours = workingDay(settings);
    if (!EVERY[settings.checkIns] || !settings.staffBriefs) continue;
    const tz = await timezoneOf(m.userId);
    const hour = hourIn(tz);
    const last = hour < 12 ? m.briefAt : m.reportAt;
    if (last && day(last, tz) === day(new Date(), tz)) continue;
    if (hour < 12 && hour >= hours.start && !waitsToStart(m.userId, hour, hours.start, tz)) void briefFor(m, "brief").catch((error) => console.error("staff brief failed", m.workspaceId, m.userId, error));
    else if (hour >= 12 && hours.report !== null && hour >= hours.report && hour < hours.end) void briefFor(m, "report").catch((error) => console.error("staff report failed", m.workspaceId, m.userId, error));
  }
}

// A staff member's brief or report is a turn in their main chat: it's about their day, and short.
export async function briefFor(m: typeof workspaceMembers.$inferSelect, kind: "brief" | "report" = "brief") {
  const person = await personFor(m.workspaceId, m.userId);
  if (!person) return;
  const chatId = await mainChat(m.workspaceId, m.userId);
  // they're talking in it: next minute
  if (isReplying(chatId)) return;
  if (await heldBack(m.workspaceId)) return;
  const who = and(eq(workspaceMembers.workspaceId, m.workspaceId), eq(workspaceMembers.userId, m.userId));
  // claim it, like checkIn
  const [col, prev] = kind === "report" ? [workspaceMembers.reportAt, m.reportAt] : [workspaceMembers.briefAt, m.briefAt];
  const [claimed] = await db
    .update(workspaceMembers)
    .set(kind === "report" ? { reportAt: new Date() } : { briefAt: new Date() })
    .where(and(who, prev ? eq(col, prev) : isNull(col)))
    .returning({ userId: workspaceMembers.userId });
  if (!claimed) return;
  const tz = await timezoneOf(m.userId);
  // a quiet team (checkIn): no report, and a brief only when they have something late or due today
  const idle = await quietDays({ id: m.workspaceId, createdAt: m.createdAt });
  if (idle >= PAUSE_DAYS || (idle >= SLOW_DAYS && (kind === "report" || !/^(Late|Due today) \(/m.test(await taskSummary(m.workspaceId, m.userId, tz, true))))) return;
  const since = kind === "report" ? at(day(new Date(), tz), "00:00", tz) : (m.briefAt ?? new Date(Date.now() - 86_400_000));
  const tasks = (await taskSummary(m.workspaceId, m.userId, tz, true)) + (await taskResults(m.workspaceId, since, tz, m.userId));
  const text = kind === "report" ? staffReport(person.userName, tasks, tz) : staffBrief(person.userName, m.briefAt, tasks, tz);
  const note = await run(person, chatId, { id: generateId(), role: "user", parts: [{ type: "text", text }] });
  // already in the main chat: only their phone still needs it
  if (note) await post(m.workspaceId, m.userId, note, { inChat: true, email: `${LABEL[kind]} for ${person.workspaceName}` });
}

// The AI's turn in a check-in chat; its last words, or null when it had nothing to say.
async function run(person: NonNullable<Awaited<ReturnType<typeof personFor>>>, chatId: string, message: UIMessage) {
  const log = { error: (obj: unknown, msg: string) => console.error(`check-in ${person.workspaceId}: ${msg}`, obj) };
  let failed = false;
  for await (const chunk of (await generateReply(person, chatId, message, log, HEARTBEAT))!) if (chunk.type === "error") failed = true;
  // nothing new was said: its last words would be the previous round's, sent again as if new
  if (failed) return null;
  // the reply is saved when it lets go of the chat (holdChat)
  await quiet(chatId);
  return outcome(chatId, person.userId, message.id);
}

const LABEL: Record<Kind, string> = { brief: "Morning brief", report: "End of day", "check-in": "Check-in" };

export async function checkIn(w: typeof workspaces.$inferSelect, kind: Kind) {
  const [owner] = await db
    .select({ userId: workspaceMembers.userId })
    .from(workspaceMembers)
    .where(and(eq(workspaceMembers.workspaceId, w.id), eq(workspaceMembers.role, "owner")));
  const person = owner && (await personFor(w.id, owner.userId));
  if (!person) return;
  // its rounds stay in their own chat, out of the owner's main chat (they're long); only what needs the owner
  // is posted there (and to their phone), so their answer carries on from it
  let chatId = w.heartbeatChatId;
  if (chatId && !(await db.query.conversations.findFirst({ where: eq(conversations.id, chatId), columns: { id: true } }))) chatId = null;
  // the last one is still going: next minute
  if (chatId && isReplying(chatId)) return;
  // unclaimed: once there's credit again, the next minute's tick runs it
  if (await heldBack(w.id)) return;
  // claim it: another tick (or server) that read the same heartbeatAt (reportAt for the report) gets nothing
  const now = new Date();
  const [col, prev] = kind === "report" ? [workspaces.reportAt, w.reportAt] : [workspaces.heartbeatAt, w.heartbeatAt];
  const [claimed] = await db
    .update(workspaces)
    .set(kind === "report" ? { reportAt: now, heartbeatAt: now } : { heartbeatAt: now })
    .where(and(eq(workspaces.id, w.id), prev ? eq(col, prev) : isNull(col)))
    .returning({ id: workspaces.id });
  if (!claimed) return;
  const idle = await quietDays(w);
  if (idle >= PAUSE_DAYS) {
    // the day it crosses the line, once (the brief is claimed once a day)
    if (kind === "brief" && idle < PAUSE_DAYS + 1) await post(w.id, person.userId, PAUSED, { email: `Check-ins paused for ${person.workspaceName}` });
    return;
  }
  if (idle >= SLOW_DAYS) {
    if (kind !== "brief") return;
    const tz = await timezoneOf(person.userId);
    const dueOrLate = /^(Late|Due today) \(/m.test(await taskSummary(w.id, person.userId, tz));
    if (!dueOrLate && !(await changesSince(w.id, person.userId, w.heartbeatAt ?? new Date(Date.now() - 86_400_000), tz)).length) return;
  }
  if (!chatId) {
    chatId = crypto.randomUUID();
    await db.insert(conversations).values({ id: chatId, workspaceId: w.id, userId: person.userId, title: "Check-ins", kind: "background" });
    await db.update(workspaces).set({ heartbeatChatId: chatId }).where(eq(workspaces.id, w.id));
  }
  await ensureRepo(w.id, "company", "Shared company files");
  const checklist = await readFile(w.id, "company", "heartbeat.md");
  if (checklist === null) await createFile(w.id, "company", "heartbeat.md", DEFAULT_CHECKLIST, "Add the check-in checklist");
  const tz = await timezoneOf(person.userId);
  const changes = await changesSince(w.id, person.userId, w.heartbeatAt ?? new Date(Date.now() - 86_400_000), tz);
  // a check-in only when something changed: the brief and the report run anyway
  if (kind === "check-in" && !changes.length) return;
  const settings = await settingsFor(w.id);
  // the day's bigger look goes in its last round: the report, or the brief when there's no report
  const daily = kind === "report" || (kind === "brief" && settings.reportHour === "off");
  const weekly = kind === "brief" && new Intl.DateTimeFormat("en-US", { weekday: "short", timeZone: tz }).format(new Date()) === "Mon";
  const since = kind === "report" ? at(day(new Date(), tz), "00:00", tz) : (w.heartbeatAt ?? new Date(Date.now() - 86_400_000));
  const tasks =
    (await taskSummary(w.id, person.userId, tz)) + (kind === "check-in" ? "" : await taskResults(w.id, since, tz)) + (daily ? await openTasks(w.id, person.userId, tz) : "");
  // the round's own instructions start the message, so the chat still shows it as a check-in, brief or report
  const text = `${instructions(kind, w.heartbeatAt, tasks, tz, { daily, weekly })}\n\n${await thinkerBrief(w, chatId, w.heartbeatAt, tz, changes.join("\n"), daily)}`;
  const note = await run(person, chatId, { id: generateId(), role: "user", parts: [{ type: "text", text }] });
  // no Telegram here: by email too, so a brief reaches someone who doesn't open the app
  if (note) await post(w.id, person.userId, `**${LABEL[kind]}**\n\n${note}\n\n[See how I got there](${chatLink(chatId)})`, { from: chatId, email: `${LABEL[kind]} for ${person.workspaceName}` });
}

// Every open task, with its id, for the daily cleanup to close what's done and tidy the rest.
// ponytail: listTasks' first 500, 80 shown; a busier business gets the rest from \`emplio tasks list --all\`
async function openTasks(workspaceId: string, userId: string, tz: string) {
  const open = (await listTasks({ workspaceId, userId, role: "owner" }, {})).filter((t) => ["todo", "doing", "waiting"].includes(t.status));
  if (!open.length) return "";
  return [`\n\nAll open tasks (${open.length}; id, status, due, who, what):`, ...open.slice(0, 80).map((t) => line(t, tz)), ...(open.length > 80 ? [`…and ${open.length - 80} more: \`emplio tasks list --all\``] : [])].join("\n");
}

// What in the toolsets needs the daily cleanup (part d): tools that look like the same one (the same name in two areas,
// or the same description), and files past TOOLSET_LINES.
// ponytail: retiring tools nobody uses needs their use counted; add when lists fill with dead ones
const TOOLSET_LINES = 300;
export async function toolsetTidy(workspaceId: string) {
  const out: string[] = [];
  const tools: { name: string; description: string; where: string }[] = [];
  for (const repo of ["company", "restricted"]) {
    const paths = await listPaths(workspaceId, repo).catch(() => []);
    for (const p of paths.filter((p) => /^toolset\/[a-z][a-z0-9_]*\.py$/.test(p.path))) {
      const text = (await readFile(workspaceId, repo, p.path)) ?? "";
      const area = p.path.slice("toolset/".length, -3);
      const lines = text.split("\n").length;
      if (lines > TOOLSET_LINES) out.push(`- ${repo}/${p.path}: ${lines} lines (over ${TOOLSET_LINES}): split it`);
      for (const t of toolsIn(area, text)) tools.push({ name: t.name, description: t.description, where: `${repo}/${p.path}` });
    }
  }
  const same = (a: (typeof tools)[number], b: (typeof tools)[number]) =>
    a.name.split(".")[1] === b.name.split(".")[1] || (a.description !== "(no description)" && a.description.toLowerCase() === b.description.toLowerCase());
  for (let i = 0; i < tools.length; i++)
    for (let j = i + 1; j < tools.length; j++)
      if (same(tools[i]!, tools[j]!)) out.push(`- ${tools[i]!.name} (${tools[i]!.where}) and ${tools[j]!.name} (${tools[j]!.where}) look like the same tool: "${tools[i]!.description}" / "${tools[j]!.description}"`);
  return out.slice(0, 15).join("\n");
}

// The memory files every chat's prompt carries that have grown past its limit (sandbox.ts capped), for the daily
// cleanup to rewrite: the business's standing instructions and description, and each person's profile and preferences.
export async function tooLong(workspaceId: string) {
  const people = await db
    .select({ id: users.id, name: users.name, email: users.email })
    .from(workspaceMembers)
    .innerJoin(users, eq(users.id, workspaceMembers.userId))
    .where(eq(workspaceMembers.workspaceId, workspaceId));
  const files: [string, string, string][] = [
    ["company", "AGENT.md", "company/AGENT.md (edit in place)"],
    ["company", "README.md", "company/README.md (edit in place)"],
    ...people.flatMap((p): [string, string, string][] => [
      [`me-${p.id}`, "preferences.md", `${p.name ?? p.email}'s preferences (\`emplio person ${p.email} rewrite prefer\`)`],
      [`me-${p.id}`, "profile.md", `${p.name ?? p.email}'s profile (\`emplio person ${p.email} rewrite profile\`)`],
    ]),
  ];
  const over: string[] = [];
  for (const [repo, file, label] of files) {
    const text = await readFile(workspaceId, repo, file).catch(() => null);
    if (text && overLimit(text)) over.push(`- ${label}: ${text.trim().split("\n").length} lines, ${text.length.toLocaleString("en-US")} characters (limit ${PROMPT_LIMIT.lines} lines, ${PROMPT_LIMIT.chars.toLocaleString("en-US")} characters)`);
  }
  return over.join("\n");
}

// A reader flagged something since the last round that can't wait for the next one.
const urgentSince = async (workspaceId: string, since: Date) =>
  !!(await db.query.chatNotes.findFirst({
    where: and(eq(chatNotes.workspaceId, workspaceId), eq(chatNotes.urgent, true), gt(chatNotes.createdAt, since)),
    columns: { id: true },
  }));

// Nobody on the team has written to the AI for a while: check-ins nobody reads only cost. After SLOW_DAYS the
// day is just the morning brief, and only when something is new; after PAUSE_DAYS nothing, with one note to the
// owner that day. Anyone writing again brings them back (this is worked out each time, nothing to undo).
const SLOW_DAYS = 3;
const PAUSE_DAYS = 7;
const PAUSED = "I've paused my check-ins: nobody has messaged me for a week. Send me anything and they start again.";

// Days since anyone on the team last wrote to the AI themselves (not a check-in, task, automation or job report).
export async function quietDays(w: Pick<typeof workspaces.$inferSelect, "id" | "createdAt">) {
  const [row] = await db
    .select({ at: max(activity.createdAt) })
    .from(activity)
    .where(
      and(
        eq(activity.workspaceId, w.id),
        eq(activity.kind, "message"),
        // what chat.ts records for a turn nobody typed (older entries have no byPerson mark)
        notInArray(activity.summary, ["Check-in started", "Task started"]),
        notLike(activity.summary, 'Automation "%'),
        notLike(activity.summary, `${WORKERS_DONE_PREFIX.trim()}%`),
        notLike(activity.summary, `${JOBS_DONE_PREFIX.trim()}%`),
        notLike(activity.summary, `${JOB_NOTE_PREFIX.trim()}%`),
      ),
    );
  return (Date.now() - (row?.at ?? w.createdAt).getTime()) / 86_400_000;
}

// What's new since the last round, a line each, for the round to start from (and a check-in to wake for at all):
// readers' notes, failed automations, new mail in the owner's inbox. The AI's own tasks start on their own (tasks.ts).
export async function changesSince(workspaceId: string, userId: string, since: Date, tz: string) {
  const lines: string[] = [];
  const notes = await db.select({ id: chatNotes.id }).from(chatNotes).where(and(eq(chatNotes.workspaceId, workspaceId), gt(chatNotes.createdAt, since)));
  if (notes.length) lines.push(`- ${notes.length} new readers' note${notes.length === 1 ? "" : "s"} on people's chats (below)`);
  const failed = await db
    .select({ name: automationRuns.name, startedAt: automationRuns.startedAt, error: automationRuns.error })
    .from(automationRuns)
    .where(and(eq(automationRuns.workspaceId, workspaceId), eq(automationRuns.status, "failed"), gt(automationRuns.startedAt, since)))
    .orderBy(asc(automationRuns.startedAt));
  for (const f of failed.slice(-10)) lines.push(`- Automation "${f.name}" failed at ${time(f.startedAt, tz)}${f.error ? `: ${f.error.slice(0, 200)}` : ""}`);
  const gmails = await db.query.connections.findMany({
    where: and(eq(connections.workspaceId, workspaceId), eq(connections.userId, userId), eq(connections.app, "gmail"), eq(connections.status, "active")),
    columns: { id: true },
  });
  const query = `in:inbox after:${Math.floor(since.getTime() / 1000)} -category:promotions -category:social`;
  for (const g of gmails) {
    const out = (await runAction({ workspaceId, userId }, "gmail.fetch_emails", { query, max_results: 10, include_payload: false }, { account: g.id, quiet: true }).catch(
      // can't tell: let the AI look
      () => ({ messages: [{ subject: "(couldn't read the inbox: look with the apps)" }] }),
    )) as { messages?: Record<string, any>[] };
    for (const m of out?.messages ?? []) {
      const from = m.sender ?? m.from ?? "";
      const subject = m.subject ?? m.preview?.subject ?? "";
      lines.push(`- New email${from ? ` from ${from}` : ""}${subject ? `: ${String(subject).slice(0, 120)}` : ""}`);
    }
  }
  return lines;
}

// The check-in's final words, or null when it had nothing to say: then it isn't sent anywhere or marked unread,
// and the chat hides it (hideSilent), but it stays in the chat's history for the agent's next round.
// Only this round's own reply: a round that saved none (it stopped before answering) must not send the last round's again.
async function outcome(chatId: string, userId: string, roundId: string) {
  const [reply] = await db
    .select({ id: messages.id, parts: messages.parts })
    .from(messages)
    .where(and(eq(messages.conversationId, chatId), eq(messages.role, "assistant"), eq(messages.parentId, roundId)))
    .orderBy(desc(messages.createdAt))
    .limit(1);
  const texts = ((reply?.parts ?? []) as UIMessage["parts"]).flatMap((p) => (p.type === "text" && p.text.trim() ? [p.text.trim()] : []));
  // a line and then the marker: the line is what they meant to say
  const last = texts[texts.length - 1]?.replace(SILENT, "").trim() || null;
  if (last) return last;
  await db.update(conversations).set({ unread: false }).where(eq(conversations.id, chatId));
  notify(userId);
  return null;
}

// Rounds that ended with nothing to say, taken out of what the chat shows (the round's message and its reply).
export function hideSilent<M extends { role: string; parts: unknown }>(rows: M[]) {
  const silent = (m: M) => {
    const texts = ((m.parts ?? []) as { type: string; text?: string }[]).flatMap((p) => (p.type === "text" && p.text?.trim() ? [p.text.trim()] : []));
    return m.role === "assistant" && texts.at(-1) === SILENT;
  };
  return rows.filter((m, i) => !silent(m) && !(m.role === "user" && rows[i + 1] && silent(rows[i + 1]!)));
}

export function startHeartbeat() {
  setInterval(() => void tick().catch((error) => console.error("check-in timer failed", error)), 60_000);
}
