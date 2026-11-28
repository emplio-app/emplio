import { and, desc, eq, gte, ilike, lt, or, sql, type SQL } from "drizzle-orm";
import { db } from "./db";
import { sendEmail } from "./mail";
import { at, timezoneOf } from "./time";
import { activity, conversations, users } from "./db/schema";

// The activity log: one line for everything that happens in a business, written by the server where it
// happens (a message, a command, an app action, a file save, a team or settings change...), never by the agent.
// Entries outlive the chat they came from, so deleting a chat doesn't erase what was done in it. Read by
// people through `emplio activity` (owner and admins: everyone's; others: their own). Append-only: nothing edits it.

export type Kind =
  | "message"
  | "reply"
  | "command"
  | "app"
  | "database"
  | "job"
  | "automation"
  | "files"
  | "chat"
  | "team"
  | "settings"
  | "connection"
  | "task"
  | "client" | "contact" | "project" | "service" | "process"
  | "problem";

type Entry = {
  workspaceId: string;
  // whose doing it was (for an automation: the person it runs as); null for the system
  userId: string | null;
  conversationId?: string | null;
  kind: Kind;
  summary: string;
  detail?: Record<string, unknown>;
};

const clip = (s: string, max: number) => (s.length > max ? `${s.slice(0, max)}…` : s);

// Fire and forget: a log write never slows or breaks the thing being logged.
export function record(e: Entry) {
  void db
    .insert(activity)
    .values({ ...e, summary: clip(e.summary.replace(/\s+/g, " ").trim(), 300) })
    .catch((error) => console.error("activity: write failed", error));
}

// A fault in Emplio itself, for its makers: `emplio report`, or the server when a command can't run at all (sandbox.ts).
// It stays in the log (kind "problem") and goes to PROBLEMS_EMAIL. `automatic`: one email per business every
// MAIL_GAP, since every command fails while a computer is down; every one still goes in the log.
const MAIL_GAP = 10 * 60_000;
const mailed = new Map<string, number>();
export const mailDue = (workspaceId: string, now = Date.now()) => {
  if (now - (mailed.get(workspaceId) ?? 0) < MAIL_GAP) return false;
  mailed.set(workspaceId, now);
  return true;
};
type Reporter = { workspaceId: string; userId: string; conversationId: string; userName: string; role: string };
export function reportProblem(who: Reporter, summary: string, details: string, automatic = false) {
  const { userName, role, ...entry } = who;
  record({ ...entry, kind: "problem", summary, detail: { details: details.slice(0, 8000), automatic } });
  console.error(`problem in chat ${who.conversationId}, business ${who.workspaceId}: ${summary}`, details);
  // ponytail: one email per report Emplio files, no dedupe; group them if the inbox gets noisy
  if (process.env.PROBLEMS_EMAIL && (!automatic || mailDue(who.workspaceId)))
    void sendEmail(process.env.PROBLEMS_EMAIL, `Emplio problem: ${summary.slice(0, 120)}`, `Workspace ${who.workspaceId}, chat ${who.conversationId}, ${userName} (${role})\n\n${details}`);
}

// --- `emplio activity` ---

type Who = { workspaceId: string; userId: string; admin: boolean };
// in the reader's own time zone (time.ts)
const stamp = (d: Date, tz: string) =>
  d.toLocaleString("en-IN", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });

const USAGE = `usage: emplio activity [words] [options]        what's been done, newest first (owner and admins see everyone's; others their own)
         --who <name or email>      one person's
         --kind <kind>              message, reply, command, app, database, job, automation, files, chat, team, settings, connection, task, problem
         --chat <chat id>           one chat's (first 8 characters are enough)
         --since <YYYY-MM-DD>       on or after   --until <YYYY-MM-DD>   before
         --n <1-200>                how many (default 40)
       emplio activity show <id>                     one entry in full`;

export async function activityCommand(who: Who, args: string[]) {
  if (args[0] === "help") return USAGE;
  const tz = await timezoneOf(who.userId);
  if (args[0] === "show") {
    if (!args[1]) return USAGE;
    const [row] = await query(who, [sql`${activity.id}::text like ${`${args[1]}%`}`], 1);
    if (!row) return `No entry ${args[1]}.`;
    return [line(row, tz), ...(row.detail ? ["", JSON.stringify(row.detail, null, 2)] : [])].join("\n");
  }
  const words: string[] = [];
  const opts: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a.startsWith("--")) opts[a.slice(2)] = args[++i] ?? "";
    else words.push(a);
  }
  const where: SQL[] = [];
  const day = (s: string, flag: string) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) throw new Error(`${flag} takes a date like 2026-10-23`);
    return at(s, "00:00", tz);
  };
  try {
    if (opts.since !== undefined) where.push(gte(activity.createdAt, day(opts.since, "--since")));
    if (opts.until !== undefined) where.push(lt(activity.createdAt, day(opts.until, "--until")));
  } catch (error) {
    return `error: ${(error as Error).message}`;
  }
  if (opts.kind) where.push(eq(activity.kind, opts.kind));
  if (opts.chat) where.push(sql`${activity.conversationId}::text like ${`${opts.chat}%`}`);
  if (opts.who) where.push(or(ilike(users.name, `%${opts.who}%`), ilike(users.email, `%${opts.who}%`))!);
  for (const w of words) where.push(ilike(activity.summary, `%${w}%`));
  const rows = await query(who, where, Math.min(200, Math.max(1, Number(opts.n) || 40)));
  if (!rows.length) return "Nothing matches. Try fewer words, a wider date range, or no --who/--kind.";
  const more = rows[0]!.total - rows.length;
  return [
    ...rows.map((r) => line(r, tz)),
    "",
    ...(more > 0 ? [`${more} more not shown: add words, --since, --who, --kind, or -n 200.`] : []),
    "Full entry: emplio activity show <id>.",
  ].join("\n");
}

export function query(who: Who, where: SQL[], limit: number) {
  return db
    .select({
      id: activity.id,
      kind: activity.kind,
      summary: activity.summary,
      detail: activity.detail,
      createdAt: activity.createdAt,
      conversationId: activity.conversationId,
      name: users.name,
      email: users.email,
      chat: conversations.title,
      // every match, not just the ones shown
      total: sql<number>`(count(*) over ())::int`,
    })
    .from(activity)
    .leftJoin(users, eq(users.id, activity.userId))
    .leftJoin(conversations, eq(conversations.id, activity.conversationId))
    .where(and(eq(activity.workspaceId, who.workspaceId), who.admin ? undefined : eq(activity.userId, who.userId), ...where))
    .orderBy(desc(activity.createdAt))
    .limit(limit);
}

type Row = Awaited<ReturnType<typeof query>>[number];
const line = (r: Row, tz: string) =>
  [
    r.id.slice(0, 8),
    stamp(r.createdAt, tz),
    r.name ?? r.email ?? "system",
    r.kind,
    r.summary + (r.conversationId ? ` (chat ${r.conversationId.slice(0, 8)}${r.chat ? ` "${r.chat}"` : ", deleted"})` : ""),
  ].join("\t");
