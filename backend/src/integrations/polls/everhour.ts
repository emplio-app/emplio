// Everhour things its webhooks don't report: expenses, the schedule, time off, timesheet approvals, clock-ins and new
// team members. Projects, tasks, sections, timers, time, clients, estimates and invoices come by webhook (own/everhour/triggers.ts).
import { z } from "zod";
import type { PollTrigger, Run } from "./index";

const day = (daysAgo: number) => new Date(Date.now() - daysAgo * 86_400_000).toISOString().slice(0, 10);
const rows = (out: unknown) => (Array.isArray(out) ? out : []) as any[];
// ponytail: these lists have no "created" time, but ids only grow, so the newest 200 by id are what's new; a burst bigger than that between polls is missed
const newest = (list: any[]) => [...list].sort((a, b) => Number(b.id) - Number(a.id)).slice(0, 200);

const PROJECT = z.string().optional().describe("Only for this project (its id, like ev:1234567890)");
const USER = z.number().optional().describe("Only for this person (their Everhour user id; list_team_members shows them)");
const mine = (c: { project_id?: string; user_id?: number }, row: any) => (!c.project_id || row.project === c.project_id) && (c.user_id === undefined || Number(row.user) === c.user_id);

const poll = (
  description: string,
  field: string,
  what: string,
  list: (c: any, run: Run) => Promise<{ id: string; row: any }[]>,
  config: z.ZodObject = z.object({ user_id: USER }),
): PollTrigger => ({
  description,
  config,
  output: [{ name: field, type: "object", required: true, description: what }],
  every: 5,
  min: 1,
  poll: async (c, run) => (await list(c, run)).map(({ id, row }) => ({ id, item: { [field]: row } })),
});
const byId = (list: any[]) => newest(list).map((row) => ({ id: String(row.id), row }));

const assignments = (type: "time-off" | "assignment") => async (c: any, run: Run) =>
  byId(rows(await run("everhour.list_schedule_assignments", { type, from: day(31), ...(c.project_id && { project: c.project_id }) })).filter((r) => mine(c, r)));

// a timesheet's approval: the id carries the status and how many steps it's had, so a resubmission after a rejection is new again
const approvals = (status: string) => async (c: any, run: Run) =>
  rows(await run("everhour.list_team_timesheets", { limit: 200 }))
    .filter((t) => t.approval?.status === status && (c.user_id === undefined || Number(t.user) === c.user_id))
    .map((t) => ({ id: `${t.id}:${status}:${t.approval.history?.length ?? 0}`, row: t }));

const timecards = (field: "clockIn" | "clockOut") => async (c: any, run: Run) =>
  rows(await run("everhour.list_timecards", { from: day(1), to: day(0) }))
    .filter((t) => t[field] && (c.user_id === undefined || Number(t.user) === c.user_id))
    // after a break, lastClockIn moves on: that's a new clock-in
    .map((t) => ({ id: `${t.user}:${t.date}:${field === "clockIn" ? (t.lastClockIn ?? t.clockIn) : t.clockOut}`, row: t }));

export const everhour: Record<string, PollTrigger> = {
  new_expense: poll(
    "An expense is logged in Everhour (checked every 5 minutes).",
    "expense",
    "The expense: id, amount (in cents), category, date, details, project, user, billable, quantity, attachments",
    async (c, run) => byId(rows(await run("everhour.expenses_list", {})).filter((r) => mine(c, r))),
    z.object({ project_id: PROJECT, user_id: USER }),
  ),
  new_time_off: poll(
    "Someone's time off is added to the Everhour schedule (checked every 5 minutes).",
    "time_off",
    "The time off: id, user, startDate, endDate, days, time (seconds a day), timeOffType, status",
    assignments("time-off"),
  ),
  new_schedule_assignment: poll(
    "Someone is scheduled on a project in Everhour's resource planner (checked every 5 minutes).",
    "assignment",
    "The schedule assignment: id, user, project, startDate, endDate, days, time (seconds a day)",
    assignments("assignment"),
    z.object({ project_id: PROJECT, user_id: USER }),
  ),
  timesheet_submitted: poll(
    "Someone sends their weekly timesheet for approval in Everhour (checked every 5 minutes).",
    "timesheet",
    "The timesheet: id, week (id, from, to), user, dailyTime, taskTime, approval (status, reviewer, history). review_timesheet_approval approves or rejects it.",
    approvals("pending"),
  ),
  timesheet_approved: poll(
    "A weekly timesheet is approved in Everhour (checked every 5 minutes).",
    "timesheet",
    "The timesheet: id, week (id, from, to), user, approval (status, reviewer, totalTime, history)",
    approvals("approved"),
  ),
  timesheet_rejected: poll(
    "A weekly timesheet is rejected in Everhour (checked every 5 minutes).",
    "timesheet",
    "The timesheet: id, week (id, from, to), user, approval (status, reviewer, history with the reason)",
    approvals("rejected"),
  ),
  clocked_in: poll(
    "Someone clocks in on Everhour's timecards, including back from a break (checked every 5 minutes).",
    "timecard",
    "The day's timecard: user, date, clockIn, lastClockIn, breakTime and workTime (seconds)",
    timecards("clockIn"),
  ),
  clocked_out: poll(
    "Someone clocks out on Everhour's timecards (checked every 5 minutes).",
    "timecard",
    "The day's timecard: user, date, clockIn, clockOut, breakTime and workTime (seconds)",
    timecards("clockOut"),
  ),
  new_team_member: poll(
    "Someone joins or is invited to the Everhour team (checked every 5 minutes).",
    "user",
    "The team member: id, name, email, role, status (invited, active...), type, createdAt",
    async (_c, run) => byId(rows(await run("everhour.list_team_members", {}))),
    z.object({}),
  ),
};
