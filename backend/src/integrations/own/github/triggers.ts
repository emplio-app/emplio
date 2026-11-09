// GitHub telling us about a repository's events the moment they happen. One webhook per connection and repository, at
// /webhooks/github/<connection>/<owner>/<repo>, carrying the events its automations need. Things GitHub has no webhook
// for are in polls/github.ts. Trigger names are the ones automations used before this was ours (Composio's).
// ponytail: repositories only; an organisation-wide webhook needs admin:org_hook and a config without repo
import { createHmac } from "node:crypto";
import type { ActionDetail } from "@emplio/shared";
import { AppsError } from "../../types";
import { type Api, call, type Send } from "../openapi";

type Payload = Record<string, any>;

// What one setting (config: in the automation's file) reads off an event; set, only events with that value start a run.
const FILTERS: Record<string, { type: string; description: string; read(p: Payload): unknown }> = {
  branch: {
    type: "string",
    description: "Only this branch (a pull request's: the branch it merges into)",
    read: (p) => p.ref?.replace("refs/heads/", "") ?? p.pull_request?.base?.ref ?? p.workflow_run?.head_branch ?? p.check_suite?.head_branch,
  },
  issue_number: { type: "number", description: "Only this issue", read: (p) => p.issue?.number },
  pull_number: { type: "number", description: "Only this pull request", read: (p) => p.pull_request?.number },
  comment_id: { type: "number", description: "Only this comment", read: (p) => p.comment?.id },
  check_run_id: { type: "number", description: "Only this check run", read: (p) => p.check_run?.id },
  deployment_id: { type: "number", description: "Only this deployment", read: (p) => p.deployment?.id },
  tag: { type: "string", description: "Only the release with this tag", read: (p) => p.release?.tag_name },
  workflow_run_id: { type: "number", description: "Only this workflow run", read: (p) => p.workflow_run?.id ?? p.workflow_job?.run_id },
  job_id: { type: "number", description: "Only this job", read: (p) => p.workflow_job?.id },
};
const PATH = { name: "path", type: "string", required: false, description: "Only changes to this file, or to anything in this folder" };
const PREFIX = { name: "prefix", type: "string", required: false, description: "Only names starting with this" };

const changed = (p: Payload): string[] => (p.commits ?? []).flatMap((c: Payload) => [...(c.added ?? []), ...(c.modified ?? []), ...(c.removed ?? [])]);
const inPath = (file: string, path: string) => file === path || file.startsWith(`${path.replace(/\/$/, "")}/`);

// [our name, GitHub's event, which of its actions (! = any but; none = all), description, its settings, any further test]
type Row = [string, string, string[] | null, string, string[]?, ((p: Payload) => boolean)?];
const BUT_OPENED = ["!opened"];
const ROWS: Row[] = [
  ["commit_event", "push", null, "Commits are pushed to a repository", ["branch", "path"]],
  ["branch_changed_trigger", "push", null, "A branch gets new commits, or is deleted", ["branch", "path"]],
  ["repository_content_changed_trigger", "push", null, "A file or folder in a repository changes", ["branch", "path"]],
  ["readme_changed_trigger", "push", null, "A README changes", ["branch", "path"], (p) => changed(p).some((f) => /(^|\/)readme[^/]*$/i.test(f))],
  ["branch_created_trigger", "create", null, "A branch is created", [], (p) => p.ref_type === "branch"],
  ["repository_tag_created_trigger", "create", null, "A tag is created", [], (p) => p.ref_type === "tag"],
  ["git_reference_created_trigger", "create", null, "A branch or tag is created", ["prefix"]],
  ["issue_created_trigger", "issues", ["opened"], "An issue is opened"],
  ["issue_added_event", "issues", ["opened"], "An issue is opened"],
  ["issue_updated_trigger", "issues", BUT_OPENED, "An issue changes: edited, labelled, assigned, closed or reopened", ["issue_number"]],
  ["issue_state_changed_trigger", "issues", BUT_OPENED, "An issue changes: edited, labelled, assigned, closed or reopened", ["issue_number"]],
  ["issue_event_occurred_trigger", "issues", null, "Anything happens to an issue", ["issue_number"]],
  ["issue_label_changed_trigger", "issues", ["labeled", "unlabeled"], "A label is added to or removed from an issue", ["issue_number"]],
  ["issue_comment_created_trigger", "issue_comment", ["created"], "A comment is added to an issue or pull request, including one Emplio posts itself (check sender if the run replies)", ["issue_number"]],
  ["issue_comment_changed_trigger", "issue_comment", ["edited", "deleted"], "A comment on an issue is edited or deleted", ["issue_number", "comment_id"]],
  ["pull_request_created", "pull_request", ["opened"], "A pull request is opened", ["branch"]],
  ["pull_request_event", "pull_request", ["opened", "closed", "synchronize"], "A pull request is opened, closed or gets new commits", ["branch", "pull_number"]],
  ["pull_request_updated", "pull_request", BUT_OPENED, "A pull request changes: edited, labelled, new commits, closed or merged", ["branch", "pull_number"]],
  ["pull_request_state_changed_trigger", "pull_request", ["edited", "closed", "reopened", "ready_for_review", "converted_to_draft"], "A pull request is edited, closed, merged, reopened, or goes in or out of draft", ["branch", "pull_number"]],
  ["pull_request_commit_added_trigger", "pull_request", ["synchronize"], "A pull request gets new commits", ["branch", "pull_number"]],
  ["pull_request_reviewers_changed_trigger", "pull_request", ["review_requested", "review_request_removed"], "A pull request's requested reviewers change", ["branch", "pull_number"]],
  ["label_added_event", "pull_request", ["labeled"], "A label is added to a pull request", ["branch", "pull_number"]],
  ["pull_request_review_submitted_trigger", "pull_request_review", ["submitted"], "A review is submitted on a pull request", ["pull_number"]],
  ["pr_review_comment_created_trigger", "pull_request_review_comment", ["created"], "An inline review comment is added to a pull request, including one Emplio posts itself (check sender if the run replies)", ["pull_number"]],
  ["check_run_status_changed_trigger", "check_run", null, "A check run is created or finishes", ["check_run_id"]],
  ["check_suite_status_changed_trigger", "check_suite", null, "A check suite finishes", ["branch"]],
  ["workflow_run_created", "workflow_run", ["requested"], "A workflow run starts", ["branch"]],
  ["workflow_run_state_changed_trigger", "workflow_run", null, "A workflow run starts, moves on or finishes", ["branch", "workflow_run_id"]],
  ["workflow_job_added_trigger", "workflow_job", ["queued"], "A job is queued in a workflow run", ["workflow_run_id"]],
  ["workflow_job_state_changed", "workflow_job", null, "A job in a workflow run is queued, starts or finishes", ["workflow_run_id", "job_id"]],
  ["deployment_created_trigger", "deployment", ["created"], "A deployment is created"],
  ["deployment_status_created", "deployment_status", ["created"], "A deployment gets a new status", ["deployment_id"]],
  ["deployment_state_changed_trigger", "deployment_status", ["created"], "A deployment's status changes", ["deployment_id"]],
  ["release_state_changed_trigger", "release", null, "A release is published, edited or removed", ["tag"]],
  ["new_stargazer_added_trigger", "star", ["created"], "Someone stars a repository"],
  ["star_added_event", "star", ["created"], "Someone stars a repository"],
  ["collaborator_added_trigger", "member", ["added"], "A collaborator is added to a repository"],
  ["code_scanning_alert_created_trigger", "code_scanning_alert", ["created"], "Code scanning finds a new problem"],
  ["secret_scanning_alert_detected_trigger", "secret_scanning_alert", ["created"], "A secret is found in a repository"],
];

// what each of GitHub's events carries besides repository and sender
const CARRIES: Record<string, string[]> = {
  push: ["ref", "before", "after", "commits", "head_commit", "pusher"],
  create: ["ref", "ref_type", "master_branch"],
  issues: ["action", "issue", "changes", "label", "assignee"],
  issue_comment: ["action", "issue", "comment", "changes"],
  pull_request: ["action", "number", "pull_request", "changes", "label", "requested_reviewer"],
  pull_request_review: ["action", "pull_request", "review"],
  pull_request_review_comment: ["action", "pull_request", "comment"],
  check_run: ["action", "check_run"],
  check_suite: ["action", "check_suite"],
  workflow_run: ["action", "workflow_run", "workflow"],
  workflow_job: ["action", "workflow_job"],
  deployment: ["action", "deployment"],
  deployment_status: ["action", "deployment_status", "deployment"],
  release: ["action", "release", "changes"],
  star: ["action", "starred_at"],
  member: ["action", "member"],
  code_scanning_alert: ["action", "alert", "ref", "commit_oid"],
  secret_scanning_alert: ["action", "alert"],
};

const SETTINGS: ActionDetail["input"] = [
  { name: "owner", type: "string", required: true, description: "Who owns the repository" },
  { name: "repo", type: "string", required: true, description: "The repository's name" },
];

export const events: Record<string, string> = Object.fromEntries(ROWS.map(([name, event]) => [name, event]));

export const triggers: Record<string, { description: string; config: ActionDetail["input"]; output: ActionDetail["input"] }> = Object.fromEntries(
  ROWS.map(([name, event, , description, settings = []]) => [
    name,
    {
      description: `${description}.`,
      config: [
        ...SETTINGS,
        ...settings.map((s) => (s === "path" ? PATH : s === "prefix" ? PREFIX : { name: s, type: FILTERS[s]!.type, required: false, description: FILTERS[s]!.description })),
      ],
      output: [...CARRIES[event]!, "repository", "sender"].map((name) => ({ name, type: "any", required: false, description: `GitHub's ${name}` })),
    },
  ]),
);

const actionMatches = (on: string[] | null, action: unknown) => !on || on.some((a) => (a.startsWith("!") ? action !== a.slice(1) : action === a));

// the triggers (github.issue_created_trigger) one of GitHub's events starts
export const triggersFor = (event: string, p: Payload) =>
  ROWS.filter(([, e, on, , , test]) => e === event && actionMatches(on, p.action) && (!test || test(p))).map(([name]) => `github.${name}`);

// whether this automation's settings want the event
export function wanted(config: unknown, p: Payload) {
  const c = (config ?? {}) as Payload;
  for (const [name, f] of Object.entries(FILTERS)) if (c[name] !== undefined && String(f.read(p)) !== String(c[name])) return false;
  if (c.prefix && !String(p.ref ?? "").startsWith(c.prefix)) return false;
  return !c.path || changed(p).some((f) => inPath(f, c.path));
}

// What an automation sees: the event without GitHub's dozens of API links, so it fits.
export const eventData = (v: any): any =>
  Array.isArray(v)
    ? v.map(eventData)
    : v && typeof v === "object"
      ? Object.fromEntries(Object.entries(v).filter(([k]) => k === "html_url" || !/_url$|^node_id$|^gravatar_id$/.test(k)).map(([k, x]) => [k, eventData(x)]))
      : v;

// Each connection's webhook secret, worked out rather than stored.
export function webhookSecret(connection: string) {
  const key = process.env.ENCRYPTION_KEY;
  if (!key) throw new Error("ENCRYPTION_KEY isn't set");
  return createHmac("sha256", key).update(`github-webhook:${connection}`).digest("hex");
}

export const watchId = (connection: string, owner: string, repo: string) => `github:${connection}:${owner}/${repo}`.toLowerCase();

const SAFE = /^[\w.-]+$/;
const hookUrl = (connection: string, owner: string, repo: string) => `${process.env.WEBHOOK_URL}/webhooks/github/${connection}/${owner}/${repo}`;
const send = (method: string, path = "/repos/{owner}/{repo}/hooks", fields: [string, string][] = []): Send => ({
  method,
  path,
  query: method === "GET" ? ["per_page"] : [],
  headers: [],
  ...(fields.length && { body: { kind: "fields" as const, fields } }),
});
type Hook = { id: number; active: boolean; events: string[]; config: { url?: string } };
const findHook = async (api: Api, key: string, url: string, owner: string, repo: string) =>
  ((await call(api, key, send("GET"), { owner, repo, per_page: 100 })) as Hook[]).find((h) => h.config.url === url);

// Make sure this connection's webhook on the repository exists and carries `event`. Answers the id automations are stored under.
export async function watch(api: Api, key: string, connection: string, event: string, config: unknown) {
  if (!process.env.WEBHOOK_URL) throw new AppsError("this server can't receive GitHub's events (WEBHOOK_URL isn't set)");
  const c = (config ?? {}) as Payload;
  if (typeof c.owner !== "string" || typeof c.repo !== "string" || !SAFE.test(c.owner) || !SAFE.test(c.repo)) throw new AppsError("config needs owner and repo: the repository to watch");
  const owner = c.owner.toLowerCase();
  const repo = c.repo.toLowerCase();
  const url = hookUrl(connection, owner, repo);
  try {
    const found = await findHook(api, key, url, owner, repo);
    if (found?.active && found.events.includes(event)) return watchId(connection, owner, repo);
    if (found) await call(api, key, send("PATCH", "/repos/{owner}/{repo}/hooks/{id}", [["add_events", "add_events"], ["active", "active"]]), { owner, repo, id: found.id, add_events: [event], active: true });
    else
      await call(api, key, send("POST", undefined, [["name", "name"], ["active", "active"], ["events", "events"], ["config", "config"]]), {
        owner,
        repo,
        name: "web",
        active: true,
        events: [event],
        config: { url, content_type: "json", secret: webhookSecret(connection) },
      });
  } catch (error) {
    if (!(error instanceof AppsError)) throw error;
    throw new AppsError(`can't watch ${owner}/${repo}: the connected GitHub account must be an admin of it, and a fine-grained token needs the Webhooks permission (${error.message})`);
  }
  return watchId(connection, owner, repo);
}

// The last automation on this repository is gone: take the webhook off it. Other events it still carries go with it.
export async function unwatch(api: Api, key: string, id: string) {
  const [, connection = "", path = ""] = id.split(":");
  const [owner = "", repo = ""] = path.split("/");
  const found = await findHook(api, key, hookUrl(connection, owner, repo), owner, repo);
  if (found) await call(api, key, send("DELETE", "/repos/{owner}/{repo}/hooks/{id}"), { owner, repo, id: found.id });
}
