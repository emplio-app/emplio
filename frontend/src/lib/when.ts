// Dates as people say them: "Due Fri", "3 days late", "Tomorrow"; the exact date for a hover.

// a YYYY-MM-DD date (a project's due:) is that day here, not midnight in London
export const toDate = (s: string) => (/^\d{4}-\d{2}-\d{2}$/.test(s) ? new Date(`${s}T00:00`) : new Date(s));
// whole days from today to it: 0 today, -2 two days ago
export const daysAway = (s: string) => Math.round((toDate(s).setHours(0, 0, 0, 0) - new Date().setHours(0, 0, 0, 0)) / 86_400_000);
export const exactDate = (s: string) => (isNaN(daysAway(s)) ? s : toDate(s).toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric" }));
// "15 Sep", "28 Feb 2027" (en-GB writes "Sept")
const short = (d: Date) => d.toLocaleDateString("en-GB", { day: "numeric", month: "short", ...(d.getFullYear() !== new Date().getFullYear() && { year: "numeric" }) }).replace("Sept", "Sep");

// "Today", "Tomorrow", "Fri", "12 Dec"; late ones "Yesterday", "3 days late" when late is what matters
export function dayText(s: string, { late = false } = {}) {
  const n = daysAway(s);
  if (isNaN(n)) return s; // "end of March", "Q3": as written
  if (n === 0) return "Today";
  if (n === 1) return "Tomorrow";
  if (n < 0 && late) return n === -1 ? "1 day late" : `${-n} days late`;
  if (n === -1) return "Yesterday";
  if (n > 1 && n < 7) return toDate(s).toLocaleDateString("en-GB", { weekday: "short" });
  return short(toDate(s));
}
// a plain date field (start, due) as words: "15 Jan 2027"
export const dateText = (s: string) => (/^\d{4}-\d{2}-\d{2}$/.test(s) ? short(toDate(s)) : s);
