// Linear triggers checked every few minutes, for keys that can't make webhooks (only Linear admins can). Each lists
// what changed in the last day through the connection's own actions. The instant twins are in own/linear/triggers.ts.
import { z } from "zod";
import type { PollTrigger, Run } from "./index";

const DAY = () => ({ gt: new Date(Date.now() - 86_400_000).toISOString() });
type Row = { id: string; updatedAt?: string };
// ponytail: the newest 100 of the last day; a busier workspace can miss some between checks (check more often then)
const list = async (run: Run, action: string, filter: Record<string, unknown>, orderBy = "createdAt") =>
  ((await run(`linear.${action}`, { first: 100, orderBy, filter })) as { nodes?: Row[] }).nodes ?? [];

const issueConfig = z.object({
  team_id: z.string().optional().describe("Only this team (its id, from list_teams)"),
  assignee_id: z.string().optional().describe("Only issues assigned to this person (their user id)"),
  label: z.string().optional().describe("Only issues with this label, by name"),
});
type IssueConfig = z.infer<typeof issueConfig>;
const issueFilter = (c: IssueConfig) => ({
  ...(c.team_id && { team: { id: { eq: c.team_id } } }),
  ...(c.assignee_id && { assignee: { id: { eq: c.assignee_id } } }),
  ...(c.label && { labels: { some: { name: { eqIgnoreCase: c.label } } } }),
});
const ISSUE = [{ name: "issue", type: "object", required: true, description: "The Linear issue: id, identifier, title, description, state, assignee, team, priority, dueDate, url" }];

const issues = (description: string, when: string, changes = false): PollTrigger => ({
  description,
  config: issueConfig,
  output: ISSUE,
  every: 5,
  min: 1,
  poll: async (c: IssueConfig, run) =>
    (await list(run, "list_issues", { ...issueFilter(c), [when]: DAY() }, changes ? "updatedAt" : "createdAt")).map((issue) => ({ id: changes ? `${issue.id}:${issue.updatedAt}` : issue.id, item: { issue } })),
});

const added = (description: string, action: string, field: string, config: z.ZodObject, filter: (c: any) => Record<string, unknown>): PollTrigger => ({
  description,
  config,
  output: [{ name: field, type: "object", required: true, description: `The Linear ${field.replace("_", " ")}` }],
  every: 5,
  min: 1,
  poll: async (c, run) => (await list(run, action, { ...filter(c), createdAt: DAY() })).map((row) => ({ id: row.id, item: { [field]: row } })),
});

export const linear: Record<string, PollTrigger> = {
  new_issue: issues("An issue is created in Linear (checked every 5 minutes; works without admin rights). Optionally only one team, assignee or label.", "createdAt"),
  issue_changed: issues("An issue in Linear is created or changes (checked every 5 minutes; works without admin rights). A run that changes the issue starts this again, so say in the prompt when to stop.", "updatedAt", true),
  issue_done: issues("An issue in Linear is marked done (checked every 5 minutes; works without admin rights).", "completedAt"),
  new_comment: added(
    "A comment is added in Linear (checked every 5 minutes; works without admin rights), including ones Emplio posts itself. Optionally only on one issue.",
    "list_comments",
    "comment",
    z.object({ issue_id: z.string().optional().describe("Only comments on this issue (its id)") }),
    (c: { issue_id?: string }) => (c.issue_id ? { issue: { id: { eq: c.issue_id } } } : {}),
  ),
  new_project: added("A project is created in Linear (checked every 5 minutes; works without admin rights).", "list_projects", "project", z.object({}), () => ({})),
  new_project_update: added(
    "Someone posts a project update in Linear (checked every 5 minutes; works without admin rights). Optionally only one project.",
    "list_project_updates",
    "project_update",
    z.object({ project_id: z.string().optional().describe("Only updates on this project (its id)") }),
    (c: { project_id?: string }) => (c.project_id ? { project: { id: { eq: c.project_id } } } : {}),
  ),
};
