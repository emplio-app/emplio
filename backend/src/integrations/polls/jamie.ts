// Jamie: its webhooks (meeting.completed) are set up only in its own settings page, not through the API, so everything
// here is polled: meetings whose summary is ready, new tasks, and tasks done.
import { z } from "zod";
import type { PollTrigger } from "./index";

const DAY = 86_400_000;
const userEmail = z.string().optional().describe("Workspace key only: just this teammate's (their email)");
const TASK = "The task: id, text, completed, dueDate, priority, assignee (name, email), meetingId, meetingTitle, createdAt";
const forAssignee = (email: string | undefined) => (t: any) => !email || t.assignee?.email?.toLowerCase() === email.toLowerCase();

export const jamie: Record<string, PollTrigger> = {
  meeting_completed: {
    description: "A Jamie meeting is summarised (checked every 5 minutes): the summary, transcript, tasks and who spoke. Optionally only meetings with a tag, or one teammate's.",
    config: z.object({
      tag: z.string().optional().describe("Personal key only: just meetings with this tag (its name; jamie.list_tags lists them)"),
      user_email: userEmail,
    }),
    output: [{ name: "meeting", type: "object", required: true, description: "The meeting: id, title, startTime, endTime, user, summary (markdown, html, short), transcript, participants, tasks, tags, event (the calendar event and its attendees)" }],
    every: 5,
    min: 1,
    // ponytail: fetches each meeting of the last day that has ended, every poll (about 2 calls a minute for 10 meetings a
    // day); keep a list of summarised ids if that grows
    poll: async ({ tag, user_email }, run) => {
      const out = (await run("jamie.list_meetings", { startDate: new Date(Date.now() - DAY).toISOString(), limit: 100, tag, userEmail: user_email })) as { meetings?: any[] };
      const ended = (out.meetings ?? []).filter((m) => m.endTime);
      const full = await Promise.all(ended.map((m) => run("jamie.get_meeting", { meetingId: m.id }) as Promise<any>));
      return full.filter((m) => m?.summary?.markdown || m?.summary?.short).map((m) => ({ id: String(m.id), item: { meeting: m } }));
    },
  },
  new_task: {
    description: "A new task (action item) comes out of a Jamie meeting (checked every 5 minutes). Optionally only ones assigned to one person.",
    config: z.object({
      assignee_email: z.string().optional().describe("Only tasks assigned to this email"),
      user_email: userEmail,
    }),
    output: [{ name: "task", type: "object", required: true, description: TASK }],
    every: 5,
    min: 1,
    poll: async ({ assignee_email, user_email }, run) => {
      const out = (await run("jamie.list_tasks", { startDate: new Date(Date.now() - DAY).toISOString(), limit: 100, userEmail: user_email })) as { tasks?: any[] };
      return (out.tasks ?? []).filter(forAssignee(assignee_email)).map((t) => ({ id: String(t.id), item: { task: t } }));
    },
  },
  task_completed: {
    description: "A Jamie task is marked done (checked every 5 minutes). Optionally only ones assigned to one person.",
    config: z.object({
      assignee_email: z.string().optional().describe("Only tasks assigned to this email"),
      user_email: userEmail,
    }),
    output: [{ name: "task", type: "object", required: true, description: TASK }],
    every: 5,
    min: 1,
    // ponytail: the 100 newest done tasks (newest by when the task was made); finishing an older task than those is missed
    poll: async ({ assignee_email, user_email }, run) => {
      const out = (await run("jamie.list_tasks", { completed: true, limit: 100, userEmail: user_email })) as { tasks?: any[] };
      return (out.tasks ?? []).filter(forAssignee(assignee_email)).map((t) => ({ id: `${t.id}:done`, item: { task: t } }));
    },
  },
};
