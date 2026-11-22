// Pipedrive things its webhooks don't report: projects, project tasks, files, synced email and call logs.
// Deals, people, organizations, activities, leads, notes and the rest come by webhook (own/pipedrive/triggers.ts).
import { z } from "zod";
import { recent, type PollTrigger, type Run } from "./index";

// v1 says "2026-11-22 07:00:00" in UTC, v2 RFC 3339
const isRecent = (t: unknown) => recent(typeof t === "string" && !/[zZ]|[+-]\d\d:?\d\d$/.test(t) ? `${t.replace(" ", "T")}Z` : t);

// ponytail: the newest page only (up to 500 or what the call allows); a burst bigger than that between polls is missed
const listed = (
  description: string,
  field: string,
  what: string,
  list: (c: any, run: Run) => Promise<any[]>,
  config: z.ZodObject = z.object({}),
  id: (row: any) => string = (row) => String(row.id),
  when: (row: any) => unknown = (row) => row.add_time,
): PollTrigger => ({
  description,
  config,
  output: [{ name: field, type: "object", required: true, description: what }],
  every: 5,
  min: 1,
  poll: async (c, run) => (await list(c, run)).filter((row) => isRecent(when(row))).map((row) => ({ id: id(row), item: { [field]: row } })),
});
const rows = (out: unknown) => ((out as { data?: unknown[] | null })?.data ?? []) as any[];

export const pipedrive: Record<string, PollTrigger> = {
  new_project: listed(
    "A project is added in Pipedrive Projects (checked every 5 minutes).",
    "project",
    "The Pipedrive project: id, title, status, phase_id, board_id, deal_ids, owner_id, add_time",
    async (_c, run) => rows(await run("pipedrive.get_all_projects", { limit: 500 })),
  ),
  new_project_task: listed(
    "A task is added to a Pipedrive project (checked every 5 minutes). Optionally only in one project or for one person.",
    "task",
    "The project task: id, title, project_id, assignee_ids, due_date, done, add_time",
    async ({ project_id, assignee_id }, run) => rows(await run("pipedrive.get_all_tasks", { limit: 500, ...(project_id && { project_id }), ...(assignee_id && { assignee_id }) })),
    z.object({
      project_id: z.number().optional().describe("Only tasks in this project (its id)"),
      assignee_id: z.number().optional().describe("Only tasks assigned to this Pipedrive user (their id)"),
    }),
  ),
  new_file: listed(
    "A file is attached in Pipedrive, to a deal, person, organization, activity, note or product (checked every 5 minutes).",
    "file",
    "The file's details: id, name, file_type, file_size, deal_id, person_id, org_id, add_time. download_file gets the file itself.",
    async (_c, run) => rows(await run("pipedrive.get_all_files", { limit: 100, sort: "id DESC" })),
  ),
  new_email: listed(
    "An email arrives in the Pipedrive inbox synced with the connected user's mailbox: a new conversation or a reply (checked every 5 minutes).",
    "thread",
    "The email thread: id, subject, snippet, parties, deal_id, last_message_timestamp. get_mail_thread_messages gives the emails.",
    async (_c, run) => rows(await run("pipedrive.get_mail_threads", { folder: "inbox", limit: 50 })),
    z.object({}),
    // a reply changes the last message's time, and is news again
    (t) => `${t.id}:${t.last_message_timestamp ?? t.update_time}`,
    (t) => t.last_message_timestamp ?? t.update_time,
  ),
  new_call_log: listed(
    "A call is logged in Pipedrive for the connected user (checked every 5 minutes).",
    "call",
    "The call log: id, subject, outcome, duration, from/to phone numbers, person_id, deal_id, start_time",
    async (_c, run) => rows(await run("pipedrive.get_user_call_logs", { limit: 50 })),
    z.object({}),
    undefined,
    (c) => c.add_time ?? c.start_time,
  ),
};
