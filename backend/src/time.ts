// Every date and time a person sees, or that decides when something happens for them, is in their own time
// zone: the one their phone number's country uses (India when unknown). The web app shows times in the
// browser's own zone; this is the server's side of it (the agent's prompt, its commands, reminders, emails).
import { and, eq } from "drizzle-orm";
import { db } from "./db";
import { users, workspaceMembers } from "./db/schema";

// ponytail: a few calling codes; anyone else (or without a phone) is India
const COUNTRIES: [string, string][] = [["971", "ae"], ["966", "sa"], ["974", "qa"], ["965", "kw"], ["968", "om"], ["973", "bh"],
  ["977", "np"], ["880", "bd"], ["94", "lk"], ["91", "in"], ["65", "sg"], ["60", "my"], ["61", "au"], ["64", "nz"], ["44", "gb"],
  ["49", "de"], ["33", "fr"], ["31", "nl"], ["39", "it"], ["34", "es"], ["41", "ch"], ["27", "za"], ["234", "ng"], ["254", "ke"], ["1", "us"]];
// ponytail: one zone per country (US is New York, Australia Sydney); add a per-person setting if that's wrong for someone
const ZONES: Record<string, string> = { ae: "Asia/Dubai", sa: "Asia/Riyadh", qa: "Asia/Qatar", kw: "Asia/Kuwait", om: "Asia/Muscat",
  bh: "Asia/Bahrain", np: "Asia/Kathmandu", bd: "Asia/Dhaka", lk: "Asia/Colombo", in: "Asia/Kolkata", sg: "Asia/Singapore",
  my: "Asia/Kuala_Lumpur", au: "Australia/Sydney", nz: "Pacific/Auckland", gb: "Europe/London", de: "Europe/Berlin",
  fr: "Europe/Paris", nl: "Europe/Amsterdam", it: "Europe/Rome", es: "Europe/Madrid", ch: "Europe/Zurich",
  za: "Africa/Johannesburg", ng: "Africa/Lagos", ke: "Africa/Nairobi", us: "America/New_York" };
export const DEFAULT_ZONE = "Asia/Kolkata";

export async function countryOf(userId: string) {
  const u = await db.query.users.findFirst({ where: eq(users.id, userId), columns: { phone: true } });
  return COUNTRIES.find(([code]) => u?.phone?.startsWith(code))?.[1] ?? "in";
}
export const timezoneOf = async (userId: string | null | undefined) => (userId ? (ZONES[await countryOf(userId)] ?? DEFAULT_ZONE) : DEFAULT_ZONE);

// For what's about the business rather than one person (billing): its owner's clock.
export async function ownerZone(workspaceId: string) {
  const owner = await db.query.workspaceMembers.findFirst({ where: and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.role, "owner")), columns: { userId: true } });
  return timezoneOf(owner?.userId);
}

// "3 Nov 2026, 9:15 am"
export const when = (d: Date, tz: string) => d.toLocaleString("en-IN", { timeZone: tz, dateStyle: "medium", timeStyle: "short" });
// "2026-11-03"
export const dayIn = (d: Date, tz: string) => d.toLocaleDateString("en-CA", { timeZone: tz });
// 0-23
export const hourIn = (tz: string, d = new Date()) => Number(d.toLocaleString("en-US", { timeZone: tz, hour: "numeric", hour12: false })) % 24;
export const minuteIn = (tz: string, d = new Date()) => Number(d.toLocaleString("en-US", { timeZone: tz, minute: "numeric" }));

// How far `tz`'s clock is ahead of UTC at `d`, in ms.
function offset(tz: string, d: Date) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" })
      .formatToParts(d)
      .map((x) => [x.type, Number(x.value)]),
  );
  return Date.UTC(p.year!, p.month! - 1, p.day!, p.hour!, p.minute!, p.second!) - Math.floor(d.getTime() / 1000) * 1000;
}

// The moment it's `day` ("2026-11-03") at `time` ("09:15") on a clock in `tz`.
// ponytail: off by the jump for a time inside a daylight-saving change; none of our zones has one near the hours we use
export function at(day: string, time: string, tz: string) {
  const guess = new Date(`${day}T${time}:00Z`);
  return new Date(guess.getTime() - offset(tz, guess));
}

if (import.meta.main) {
  console.assert(at("2026-10-25", "18:00", "Asia/Kolkata").toISOString() === "2026-10-25T12:30:00.000Z");
  console.assert(at("2026-07-01", "09:00", "America/New_York").toISOString() === "2026-07-01T13:00:00.000Z");
  console.assert(at("2026-01-01", "09:00", "America/New_York").toISOString() === "2026-01-01T14:00:00.000Z");
  console.assert(dayIn(new Date("2026-11-02T20:00:00Z"), "Asia/Kolkata") === "2026-11-03");
  console.assert(hourIn("Asia/Kolkata", new Date("2026-11-02T20:00:00Z")) === 1);
  console.log("time ok");
}
