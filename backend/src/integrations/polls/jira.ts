import { z } from "zod";
import { recent, type PollTrigger } from "./index";

// Jira's own webhooks need a Jira admin's login, so everything a list can show is polled, for anyone: issues and comments
// through a JQL search of the last day, sprints from a board, versions from a project. What only a webhook can tell
// (something deleted, merged, moved or unreleased) is in own/jira/triggers.ts. Names are Composio's.
const SEARCH = "jira.search_for_issues_using_jql_get";
const FIELDS = ["summary", "status", "assignee", "reporter", "priority", "issuetype", "project", "labels", "created", "updated", "duedate", "description", "parent"];

const PROJECT = z.string().optional().describe("Only this project: its key, like SALES (the letters before an issue's number)");
const JQL = z.string().optional().describe('Only issues that also match this JQL, e.g. assignee = currentUser() AND priority = High');

// the issues touched in the last day, newest first; ponytail: one page of 100, so a busier day than that misses the rest
async function issues(config: { project?: string; jql?: string }, by: "created" | "updated", run: (a: string, i: unknown) => Promise<any>, fields = FIELDS) {
  const where = [`${by} >= -1d`];
  if (config.project) where.push(`project = "${config.project.replace(/["\\]/g, "")}"`);
  if (config.jql) where.push(`(${config.jql})`);
  const out = await run(SEARCH, { jql: `${where.join(" AND ")} ORDER BY ${by} DESC`, maxResults: 100, fields });
  return (out.issues ?? []) as { id: string; key: string; fields: Record<string, any> }[];
}

const ISSUE = { name: "issue", type: "object", required: true, description: "The Jira issue: key (like SALES-12), fields.summary, status, assignee, reporter, priority, issuetype, project, labels, created, updated, duedate, description" };
const COMMENT = { name: "comment", type: "object", required: true, description: "The comment: id, author, body (Atlassian document format), created, updated" };

const issueTrigger = (description: string, by: "created" | "updated", keep: (i: { fields: Record<string, any> }) => boolean, id: (i: { id: string; fields: Record<string, any> }) => string): PollTrigger => ({
  description,
  config: z.object({ project: PROJECT, jql: JQL }),
  output: [ISSUE],
  every: 5,
  min: 2,
  poll: async (c, run) => (await issues(c, by, run)).filter(keep).map((issue) => ({ id: id(issue), item: { issue } })),
});

const commentTrigger = (description: string, keep: (c: any) => boolean, id: (c: any) => string): PollTrigger => ({
  description,
  config: z.object({ project: PROJECT, jql: JQL }),
  output: [COMMENT, ISSUE],
  every: 5,
  min: 2,
  async poll(c, run) {
    const out: { id: string; item: unknown }[] = [];
    for (const { fields, ...issue } of await issues(c, "updated", run, [...FIELDS, "comment"])) {
      const { comment, ...rest } = fields;
      for (const cm of comment?.comments ?? []) if (keep(cm)) out.push({ id: id(cm), item: { comment: cm, issue: { ...issue, fields: rest } } });
    }
    return out;
  },
});

// a board's sprints in these states, every page (ponytail: up to 20 pages of 50)
async function sprints(board_id: number, state: string, run: (a: string, i: unknown) => Promise<any>) {
  const all: any[] = [];
  for (let startAt = 0, page = 0; page < 20; page++) {
    const out = await run("jira.list_sprints", { boardId: board_id, state, startAt, maxResults: 50 });
    all.push(...(out.values ?? []));
    if (out.isLast !== false || !out.values?.length) break;
    startAt += out.values.length;
  }
  return all;
}
const BOARD = z.coerce.number().int().describe("The board whose sprints to watch: the number after /boards/ in its link (jira.list_boards lists them)");
const SPRINT = { name: "sprint", type: "object", required: true, description: "The sprint: id, name, state (future, active, closed), goal, startDate, endDate, completeDate" };
const sprintTrigger = (description: string, state: string, keep: (s: any) => boolean, id: (s: any) => string): PollTrigger => ({
  description,
  config: z.object({ board_id: BOARD }),
  output: [SPRINT],
  every: 5,
  min: 2,
  poll: async (c, run) => (await sprints(c.board_id, state, run)).filter(keep).map((sprint) => ({ id: id(sprint), item: { sprint } })),
});

const VERSION_PROJECT = z.string().describe("The project whose versions (releases) to watch: its key, like SALES");
const VERSION = { name: "version", type: "object", required: true, description: "The version: id, name, description, released, archived, startDate, releaseDate, projectId" };
const versionTrigger = (description: string, keep: (v: any) => boolean, id: (v: any) => string): PollTrigger => ({
  description,
  config: z.object({ project: VERSION_PROJECT }),
  output: [VERSION],
  every: 5,
  min: 2,
  poll: async (c, run) => ((await run("jira.get_project_versions", { projectIdOrKey: c.project })) as any[]).filter(keep).map((version) => ({ id: id(version), item: { version } })),
});
const all = () => true;

export const jira: Record<string, PollTrigger> = {
  issue_created: issueTrigger("A new Jira issue is created (checked every 5 minutes by default). Optionally only in one project or matching a JQL filter.", "created", all, (i) => i.id),
  issue_updated: issueTrigger(
    "A Jira issue is changed: its status, assignee, fields, or a new comment (checked every 5 minutes by default). Not when it's just been created. A run that edits the issue starts this again, so say in the prompt when to stop.",
    "updated",
    (i) => i.fields.updated !== i.fields.created,
    (i) => `${i.id}:${i.fields.updated}`,
  ),
  comment_created: commentTrigger(
    "Someone comments on a Jira issue (checked every 5 minutes by default). A run that comments on the same issue starts this again, so say in the prompt when not to reply.",
    (cm) => recent(cm.created),
    (cm) => String(cm.id),
  ),
  comment_updated: commentTrigger("A comment on a Jira issue is edited (checked every 5 minutes by default).", (cm) => cm.updated !== cm.created && recent(cm.updated), (cm) => `${cm.id}:${cm.updated}`),
  sprint_created: sprintTrigger("A sprint is added to a Jira board.", "future,active", all, (s) => String(s.id)),
  sprint_started: sprintTrigger("A sprint on a Jira board starts.", "active", all, (s) => `${s.id}:started`),
  sprint_closed: sprintTrigger("A sprint on a Jira board is completed.", "closed", (s) => recent(s.completeDate ?? s.endDate), (s) => `${s.id}:closed`),
  sprint_updated: sprintTrigger("A sprint on a Jira board is changed: its name, goal, dates or state.", "future,active", all, (s) => `${s.id}:${s.state}:${s.name}:${s.goal ?? ""}:${s.startDate ?? ""}:${s.endDate ?? ""}`),
  version_created: versionTrigger("A version (release) is added to a Jira project.", all, (v) => String(v.id)),
  version_released: versionTrigger("A version (release) of a Jira project is marked released.", (v) => v.released, (v) => `${v.id}:released`),
  version_updated: versionTrigger(
    "A version (release) of a Jira project is changed: its name, description, dates, or released or archived.",
    all,
    (v) => `${v.id}:${v.name}:${v.description ?? ""}:${v.startDate ?? ""}:${v.releaseDate ?? ""}:${v.released}:${v.archived}`,
  ),
};
