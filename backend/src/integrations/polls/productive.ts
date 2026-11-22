// Productive events with no webhook, checked every few minutes: new comments, discussions and docs, and finished tasks.
import { z } from "zod";
import { recent, type PollTrigger } from "./index";

type Row = { id: string; type: string; attributes: Record<string, any>; relationships?: Record<string, { data?: { id: string } | null }> };
const OUT = (what: string) => [{ name: what, type: "object", required: true, description: `The Productive ${what}: id, type, attributes (all its fields) and relationships` }];

// ponytail: the newest 50; more than 50 new ones between two checks and the oldest are missed
const listed = (description: string, what: string, action: string, config: z.ZodObject, filter: (c: any) => Record<string, unknown>, when = "created_at", sort = "-created_at"): PollTrigger => ({
  description,
  config,
  output: OUT(what),
  every: 5,
  min: 1,
  async poll(c, run) {
    const out = (await run(`productive.${action}`, { sort: [sort], "page[size]": 50, filter: filter(c) })) as { data?: Row[] };
    return (out.data ?? []).filter((r) => recent(r.attributes?.[when])).map((r) => ({ id: `${r.id}:${r.attributes[when]}`, item: { [what]: r } }));
  },
});

const id = (what: string) => z.string().optional().describe(`Only in this ${what} (its id)`);
const pick = (c: Record<string, unknown>) => Object.fromEntries(Object.entries(c).filter(([k, v]) => k !== "every" && v !== undefined && v !== ""));

export const productive: Record<string, PollTrigger> = {
  comment_created: listed(
    "Someone commented in Productive: on a task, deal, doc or discussion. A run that comments on the same thing starts this again, so say in the prompt when not to reply.",
    "comment",
    "list_comments",
    z.object({ project_id: id("project"), task_id: id("task"), deal_id: id("deal") }),
    pick,
  ),
  discussion_created: listed("A discussion was started on a Productive doc.", "discussion", "list_discussions", z.object({ page_id: id("doc") }), pick),
  page_created: listed("A doc was added in Productive.", "page", "list_pages", z.object({ project_id: id("project") }), pick),
  task_completed: listed(
    "A task was closed (marked done) in Productive.",
    "task",
    "list_tasks",
    z.object({ project_id: id("project"), assignee_id: z.string().optional().describe("Only tasks assigned to this person (their id)") }),
    (c) => ({ ...pick(c), status: 2 }),
    "closed_at",
    "-closed_at",
  ),
};
