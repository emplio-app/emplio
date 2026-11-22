// Linear telling us about events the moment they happen. One webhook per connection and scope, at
// /webhooks/app/linear/<connection>/<scope>: "all" (every public team), a team's id (private teams too), or "audit"
// (audit entries, which Linear wants on a webhook of their own). Each carries the resource types its automations need,
// signed with Linear-Signature, an HMAC of the body with a secret we set and never store. Webhooks need an admin's key;
// polls/linear.ts has polled twins for everyone else. Composio's trigger names are kept.
import { createHmac, timingSafeEqual } from "node:crypto";
import type { ActionDetail } from "@emplio/shared";
import { AppsError } from "../../types";
import type { Delivery, WebhookEvent } from "../index";
import { gql } from "./api";

type Payload = Record<string, any>;

const lower = (v: unknown) => String(v ?? "").toLowerCase();
// What one setting (config: in the automation's file) reads off an event; set, only events with that value start a run.
const FILTERS: Record<string, { type: string; description: string; test(p: Payload, want: unknown): boolean }> = {
  action: { type: "create|update|remove", description: "Only this kind of change", test: (p, w) => p.action === w },
  field: { type: "string", description: "On changes, only when this field changed, like stateId, assigneeId, priority, dueDate or title", test: (p, w) => Boolean(p.updatedFrom && String(w) in p.updatedFrom) },
  issue: {
    type: "string",
    description: "Only this issue: its key like ENG-12, or its id",
    test: (p, w) => [p.data?.id, p.data?.identifier, p.data?.issueId, p.data?.issue?.id, p.data?.issue?.identifier].some((v) => v != null && lower(v) === lower(w)),
  },
  project_id: { type: "string", description: "Only this project (its id)", test: (p, w) => [p.data?.projectId, p.data?.project?.id, p.type === "Project" ? p.data?.id : undefined].includes(w) },
  assignee_id: { type: "string", description: "Only issues assigned to this person (their user id)", test: (p, w) => p.data?.assigneeId === w || p.data?.assignee?.id === w },
  state: { type: "string", description: "Only issues now in this status, by name, like In Progress or Done", test: (p, w) => lower(p.data?.state?.name) === lower(w) },
  label: { type: "string", description: "Only issues with this label, by name", test: (p, w) => (p.data?.labels ?? []).some((l: { name?: string }) => lower(l.name) === lower(w)) },
};
const TEAM = { name: "team_id", type: "string", required: false, description: "Only this team (its id, from list_teams). Needed for private teams; left out, every public team" };

// [our name, Linear's resource type, which actions (none = all), description, its settings, any further test]
type Row = [string, string, string[] | null, string, string[], ((p: Payload) => boolean)?];
const ISSUE = ["field", "issue", "project_id", "assignee_id", "state", "label"];
const LOOPS = " A run that changes it starts this again, so say in the prompt when to stop";
const ROWS: Row[] = [
  ["issue_created_trigger", "Issue", ["create"], "An issue is created", ISSUE],
  ["public_team_issue_created", "Issue", ["create"], "An issue is created in a public team", ISSUE],
  ["private_team_issue_created", "Issue", ["create"], "An issue is created in a private team (give team_id)", ISSUE],
  ["issue_updated_trigger", "Issue", ["update"], "An issue changes: status, assignee, priority, labels, title or anything else." + LOOPS, ISSUE],
  ["public_team_issue_properties_updated", "Issue", ["update"], "An issue in a public team changes." + LOOPS, ISSUE],
  ["private_team_issue_properties_updated", "Issue", ["update"], "An issue in a private team changes (give team_id)." + LOOPS, ISSUE],
  ["issue_status_changed_trigger", "Issue", ["update"], "An issue moves to another status." + LOOPS, ISSUE, (p) => "stateId" in (p.updatedFrom ?? {})],
  ["issue_assigned_trigger", "Issue", ["update"], "An issue is assigned to someone, or unassigned", ISSUE, (p) => "assigneeId" in (p.updatedFrom ?? {})],
  ["issue_completed_trigger", "Issue", ["update"], "An issue is marked done", ISSUE, (p) => "completedAt" in (p.updatedFrom ?? {}) && Boolean(p.data?.completedAt)],
  ["issue_removed_trigger", "Issue", ["remove"], "An issue is deleted", ISSUE],
  ["comment_event_trigger", "Comment", null, "A comment is added, edited or removed", ["action", "issue"]],
  ["comment_created_trigger", "Comment", ["create"], "A comment is added to an issue, including one Emplio posts itself (check the author if the run replies)", ["issue"]],
  ["public_team_comment_created", "Comment", ["create"], "A comment is added to an issue in a public team, including one Emplio posts itself (check the author if the run replies)", ["issue"]],
  ["private_team_comment_created", "Comment", ["create"], "A comment is added to an issue in a private team (give team_id), including one Emplio posts itself", ["issue"]],
  ["comment_updated_trigger", "Comment", ["update"], "A comment is edited", ["issue"]],
  ["comment_removed_trigger", "Comment", ["remove"], "A comment is removed", ["issue"]],
  ["attachment_event_trigger", "Attachment", null, "A link or file is attached to an issue, changed or removed", ["action", "issue"]],
  ["issue_label_event_trigger", "IssueLabel", null, "An issue label is created, changed or removed", ["action", "field"]],
  ["issue_sla_event_trigger", "IssueSLA", null, "An issue's SLA is set, gets close to breaching, or is breached", ["action", "issue"]],
  ["reaction_event_trigger", "Reaction", null, "Someone reacts with an emoji, or takes a reaction back", ["action", "issue"]],
  ["project_created", "Project", ["create"], "A project is created", ["project_id"]],
  ["project_properties_updated", "Project", ["update"], "A project changes: status, lead, dates, name or anything else." + LOOPS, ["field", "project_id"]],
  ["project_removed_trigger", "Project", ["remove"], "A project is deleted", ["project_id"]],
  ["project_update_posted", "ProjectUpdate", ["create"], "Someone posts a project update", ["project_id"]],
  ["project_update_event_trigger", "ProjectUpdate", null, "A project update is posted, edited or removed", ["action", "project_id"]],
  ["project_label_event_trigger", "ProjectLabel", null, "A project label is created, changed or removed", ["action"]],
  ["cycle_event_trigger", "Cycle", null, "A cycle is created, changes (starts, ends, dates) or is removed", ["action", "field"]],
  ["document_event_trigger", "Document", null, "A document is created, edited or removed", ["action", "field", "project_id"]],
  ["initiative_event_trigger", "Initiative", null, "An initiative is created, changes or is removed", ["action", "field"]],
  ["initiative_update_posted", "InitiativeUpdate", ["create"], "Someone posts an initiative update", []],
  ["initiative_update_event_trigger", "InitiativeUpdate", null, "An initiative update is posted, edited or removed", ["action"]],
  ["customer_event_trigger", "Customer", null, "A customer is added, changes or is removed", ["action", "field"]],
  ["customer_request_event_trigger", "CustomerNeed", null, "A customer request is added to an issue or project, changes or is removed", ["action", "issue", "project_id"]],
  ["user_event_trigger", "User", null, "Someone joins the workspace, or a member's profile or role changes", ["action", "field"]],
  ["release_event_trigger", "Release", null, "A release is created, changes or is removed", ["action", "field"]],
  ["release_note_event_trigger", "ReleaseNote", null, "A release note is written, edited or removed", ["action"]],
  ["audit_entry_created", "AuditEntry", ["create"], "Something is recorded in the workspace's audit log (sign-ins, setting changes). Needs Linear's Enterprise plan", []],
];

const OUTPUT: ActionDetail["input"] = [
  { name: "action", type: "string", required: true, description: "create, update or remove" },
  { name: "type", type: "string", required: true, description: "What it's about: Issue, Comment, Project…" },
  { name: "data", type: "object", required: true, description: "The record as it is now (an issue: id, identifier, title, description, state, assignee, labels, team, priority, dueDate, url…)" },
  { name: "updatedFrom", type: "object", required: false, description: "On update: the fields that changed, with their old values" },
  { name: "actor", type: "object", required: false, description: "Who did it" },
  { name: "url", type: "string", required: false, description: "Its link in Linear" },
  { name: "createdAt", type: "string", required: true, description: "When it happened" },
];

export const events: Record<string, string> = Object.fromEntries(ROWS.map(([name, type]) => [name, type]));

export const triggers: Record<string, { description: string; config: ActionDetail["input"]; output: ActionDetail["input"] }> = Object.fromEntries(
  ROWS.map(([name, type, , description, settings]) => [
    name,
    {
      description: `${description}.`,
      config: [...(type === "AuditEntry" ? [] : [TEAM]), ...settings.map((s) => ({ name: s, type: FILTERS[s]!.type, required: false, description: FILTERS[s]!.description }))],
      output: OUTPUT,
    },
  ]),
);

// the triggers (short names) one of Linear's events starts
export const triggersFor = (p: Payload) => ROWS.filter(([, type, on, , , test]) => type === p.type && (!on || on.includes(p.action)) && (!test || test(p))).map(([name]) => name);

export function wanted(config: unknown, data: unknown) {
  const c = (config ?? {}) as Payload;
  return Object.entries(FILTERS).every(([name, f]) => c[name] === undefined || c[name] === "" || f.test(data as Payload, c[name]));
}

// Each connection's signing secret, worked out rather than stored.
export function webhookSecret(connection: string) {
  const key = process.env.ENCRYPTION_KEY;
  if (!key) throw new Error("ENCRYPTION_KEY isn't set");
  return createHmac("sha256", key).update(`linear-webhook:${connection}`).digest("hex");
}

const SAFE = /^[\w-]+$/;
const hookUrl = (connection: string, scope: string) => `${process.env.WEBHOOK_URL}/webhooks/app/linear/${connection}/${scope}`;
type Hook = { id: string; url: string; enabled: boolean; resourceTypes: string[] };
// ponytail: first 250 webhooks of the workspace; page through them if a workspace ever has more
const findHook = async (key: string, url: string) =>
  ((await gql(key, "query { webhooks(first: 250) { nodes { id url enabled resourceTypes } } }")).data.webhooks as { nodes: Hook[] }).nodes.find((h) => h.url === url);

const ok = async (key: string, query: string, variables: Record<string, unknown>, name: string) => {
  const { data, errors } = await gql(key, query, variables);
  if (!(data[name] as { success?: boolean } | null)?.success) throw new AppsError(`Linear: ${errors.join("; ") || "it said no"}`);
};

// Make sure this connection's webhook for the scope exists and carries `type`. Answers the id automations are stored under.
export async function watch(key: string, connection: string, type: string, config: unknown) {
  if (!process.env.WEBHOOK_URL) throw new AppsError("this server can't receive Linear's events (WEBHOOK_URL isn't set)");
  const team = (config as { team_id?: unknown } | null)?.team_id;
  if (team !== undefined && (typeof team !== "string" || !SAFE.test(team))) throw new AppsError("team_id: give the team's id, from list_teams");
  const scope = type === "AuditEntry" ? "audit" : team || "all";
  const url = hookUrl(connection, scope);
  const id = `linear:${connection}:${scope}`;
  try {
    const found = await findHook(key, url);
    if (found?.enabled && found.resourceTypes.includes(type)) return id;
    if (found)
      await ok(key, "mutation($id: String!, $input: WebhookUpdateInput!) { webhookUpdate(id: $id, input: $input) { success } }", { id: found.id, input: { enabled: true, resourceTypes: [...new Set([...found.resourceTypes, type])], secret: webhookSecret(connection) } }, "webhookUpdate");
    else {
      const where = scope === "all" || scope === "audit" ? { allPublicTeams: true } : { teamId: scope };
      await ok(key, "mutation($input: WebhookCreateInput!) { webhookCreate(input: $input) { success } }", { input: { url, label: "Emplio", resourceTypes: [type], secret: webhookSecret(connection), ...where } }, "webhookCreate");
    }
  } catch (error) {
    if (!(error instanceof AppsError) || error.expired) throw error;
    throw new AppsError(`can't get Linear's events: webhooks need the API key of a Linear admin (or use a checked-every-few-minutes trigger like linear.new_issue instead) (${error.message})`);
  }
  return id;
}

// The last automation on this scope is gone: take the webhook away.
export async function unwatch(key: string, id: string) {
  const [, connection = "", scope = ""] = id.split(":");
  const found = await findHook(key, hookUrl(connection, scope));
  if (found) await ok(key, "mutation($id: String!) { webhookDelete(id: $id) { success } }", { id: found.id }, "webhookDelete");
}

export async function receive(delivery: Delivery) {
  const sig = delivery.headers["linear-signature"];
  if (!SAFE.test(delivery.rest) || typeof sig !== "string") return null;
  const want = Buffer.from(createHmac("sha256", webhookSecret(delivery.connection)).update(delivery.body).digest("hex"));
  const got = Buffer.from(sig);
  if (got.length !== want.length || !timingSafeEqual(got, want)) return null;
  // ponytail: no webhookTimestamp age check, so Linear's retries (up to hours later) still arrive; the signature and `seen` guard instead
  const p = JSON.parse(delivery.body || "{}") as Payload;
  const id = delivery.headers["linear-delivery"];
  const { organizationId: _o, webhookId: _w, webhookTimestamp: _t, ...data } = p;
  return {
    events: async (): Promise<WebhookEvent[]> => [{ id: typeof id === "string" ? id : [delivery.connection, p.webhookId, p.createdAt, p.type, p.action, p.data?.id].join(":"), triggers: triggersFor(p), data }],
  };
}
