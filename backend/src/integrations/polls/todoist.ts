import { z } from "zod";
import { recent, type PollTrigger } from "./index";

const newTask: PollTrigger = {
    description: "A task is added in Todoist (checked every 5 minutes by default). Optionally only tasks with certain labels or in one project.",
    config: z.object({
      labels: z.array(z.string()).optional().describe('Only tasks with at least one of these label names, e.g. ["aayush", "parth"]'),
      project_id: z.string().optional().describe("Only tasks in this project"),
    }),
    output: [{ name: "task", type: "object", required: true, description: "The Todoist task: id, content, description, labels, project_id, due, priority, added_at" }],
    every: 5,
    min: 1,
    async poll({ labels, project_id }, run) {
      const tasks: any[] = [];
      let cursor: string | undefined;
      // ponytail: 5 pages of 200 active tasks; past that, new tasks on later pages are missed (filter by "created after" then)
      for (let page = 0; page < 5; page++) {
        // `results` from Todoist itself, `tasks` from the Composio connection older tests pin
        const out = (await run("todoist.get_all_tasks", { limit: 200, ...(cursor && { cursor }) })) as { results?: any[]; tasks?: any[]; next_cursor?: string | null };
        tasks.push(...(out.results ?? out.tasks ?? []));
        cursor = out.next_cursor ?? undefined;
        if (!cursor) break;
      }
      return tasks
        .filter((t) => recent(t.added_at))
        .filter((t) => !project_id || t.project_id === project_id)
        .filter((t) => !labels?.length || t.labels?.some((l: string) => labels.includes(l)))
        .map((task) => ({ id: String(task.id), item: { task } }));
    },
};

// ponytail: first 200 of each list; a list longer than that may miss a new row
const listed = (description: string, field: string, config: z.ZodObject, list: (c: any, run: (a: string, i: unknown) => Promise<any>) => Promise<any[]>): PollTrigger => ({
  description,
  config,
  output: [{ name: field, type: "object", required: true, description: `The Todoist ${field}` }],
  every: 5,
  min: 1,
  poll: async (c, run) => (await list(c, run)).map((row) => ({ id: String(row.id), item: { [field]: row } })),
});

export const todoist: Record<string, PollTrigger> = {
  new_task: newTask,
  // Composio's name for the same trigger, so automations saved before the move carry on
  new_task_created: newTask,
  task_completed: listed(
    "A task is completed in Todoist. Optionally only in one project.",
    "task",
    z.object({ project_id: z.string().optional().describe("Only tasks in this project") }),
    async ({ project_id }, run) => {
      const now = Date.now();
      const iso = (ms: number) => new Date(ms).toISOString();
      const out = await run("todoist.get_completed_tasks_by_completion_date", { since: iso(now - 86_400_000), until: iso(now), limit: 200, ...(project_id && { project_id }) });
      return out.items ?? [];
    },
  ),
  new_project: listed("A project is added in Todoist.", "project", z.object({}), async (_c, run) => (await run("todoist.get_all_projects", { limit: 200 })).results ?? []),
  new_comment: listed(
    "A comment is added on one Todoist task or project.",
    "comment",
    z.object({ task_id: z.string().optional().describe("The task to watch"), project_id: z.string().optional().describe("The project to watch, when no task is given") }).refine((c) => c.task_id || c.project_id, "give task_id or project_id") as unknown as z.ZodObject,
    async (c, run) => (await run("todoist.get_all_comments", { limit: 200, ...c })).results ?? [],
  ),
};
