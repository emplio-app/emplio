// Jamie on the person's own API key: every call of Jamie's API (meetings with their summaries, transcripts and tasks,
// search, tags). Jamie has two kinds of key with the same calls under different routes: a personal key (/v1/me/, the
// person's meetings and ones shared with them) and a workspace key (/v1/workspace/, every meeting in the workspace).
// Jamie's webhooks are set up only in its own settings page, so new meetings and tasks start automations by polling
// (polls/jamie.ts). COVERAGE.md says what's where.
import { z } from "zod";
import { AppsError } from "../../types";
import type { OwnAction, OwnApp } from "../index";

const BASE = "https://beta-api.meetjamie.ai/v1";
type Scope = "me" | "workspace";

// which routes a key belongs to, learnt from its first call
// ponytail: in memory per process; a restart learns it again with one extra call
const scopes = new Map<string, Scope>();

async function send(scope: Scope, key: string, procedure: string, input: Record<string, unknown>, post: boolean) {
  const json = Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined));
  const empty = !Object.keys(json).length;
  const url = `${BASE}/${scope}/${procedure}${post || empty ? "" : `?${new URLSearchParams({ input: JSON.stringify({ json }) })}`}`;
  const res = await fetch(url, {
    method: post ? "POST" : "GET",
    headers: { "x-api-key": key, ...(post && { "Content-Type": "application/json" }) },
    body: post ? JSON.stringify({ json }) : undefined,
  });
  const text = await res.text();
  let body: any;
  try {
    body = JSON.parse(text);
  } catch {
    body = undefined;
  }
  const why = body?.error?.message ?? body?.error?.json?.message ?? (typeof body?.error === "string" ? body.error : undefined) ?? (text || res.statusText);
  return { status: res.status, ok: res.ok, why: String(why), data: body?.result?.data?.json ?? body };
}

// one call on whichever routes the key belongs to: a 403 on the personal ones means a workspace key
export async function jamieCall(key: string, procedure: string, input: Record<string, unknown> = {}, post = false) {
  const known = scopes.get(key);
  let scope: Scope = known ?? "me";
  let out = await send(scope, key, procedure, input, post);
  if (!known && out.status === 403 && /requires a workspace/i.test(out.why)) {
    scope = "workspace";
    out = await send(scope, key, procedure, input, post);
  }
  if (out.status === 401) throw new AppsError("Jamie rejected the API key; make a new one (Jamie → Settings → API & MCP → API keys) and reconnect", true, out.why);
  if (!out.ok) {
    if (out.status === 403 && scope === "workspace" && /personal/i.test(out.why))
      throw new AppsError(`Jamie: ${procedure} works only with a personal API key, and this connection uses a workspace key (${out.why})`);
    throw new AppsError(`Jamie: ${out.why} (${out.status})`);
  }
  scopes.set(key, scope);
  return out.data;
}

const action = (description: string, procedure: string, input: z.ZodRawShape, opts: { post?: boolean } = {}): OwnAction => ({
  description,
  readOnly: !opts.post,
  input: z.object(input),
  run: (i, key) => jamieCall(key, procedure, i, opts.post),
});

const page = {
  limit: z.number().int().min(1).max(100).optional().describe("How many to return (default 50, at most 100)"),
  cursor: z.string().optional().describe("nextCursor from the previous answer, for the next page"),
  startDate: z.string().optional().describe("Only from this date on, ISO 8601, e.g. 2026-11-01T00:00:00Z"),
  endDate: z.string().optional().describe("Only up to this date, ISO 8601"),
};
const userEmail = z.string().optional().describe("Workspace key only: just this teammate's (their email)");
const meetingId = z.string().min(1).describe("The meeting's id, from jamie.list_meetings or jamie.search_meetings");

const actions: Record<string, OwnAction> = {
  list_meetings: action(
    "Recorded meetings, newest first: id, title, AI title, start and end, calendar event. With a personal key: your meetings and ones shared with you; with a workspace key: everyone's. Answers {meetings, nextCursor}.",
    "meetings.list",
    {
      ...page,
      userEmail,
      tag: z.string().optional().describe("Personal key only: just meetings with this tag (its name, from jamie.list_tags)"),
    },
  ),
  get_meeting: action(
    "One meeting in full: the summary (Markdown, HTML and one line), the whole transcript, who spoke, the tasks, tags, calendar event and invitees, and (your own meetings, personal key) your scratchpad notes.",
    "meetings.get",
    { meetingId },
  ),
  search_meetings: action(
    "Search what was said across your meetings by meaning, not just words (personal key only). Looks at the last 6 months unless dates are given; answers up to 40 matching passages, each with its meeting's id, title and date.",
    "meetings.search",
    {
      query: z.string().min(1).describe('What to look for, e.g. "pricing for Northwind"'),
      startDate: page.startDate,
      endDate: page.endDate,
    },
  ),
  delete_meeting: action(
    "Delete a meeting with its summary, transcript and tasks, for good. A personal key can delete only your own meetings.",
    "meetings.delete",
    { meetingId },
    { post: true },
  ),
  list_tasks: action(
    "Action items from meetings, newest first: text, done or not, due date, priority, who it's for, and its meeting. Answers {tasks, nextCursor}.",
    "tasks.list",
    {
      ...page,
      completed: z.boolean().optional().describe("true: only done tasks; false: only open ones; left out: both"),
      meetingId: z.string().optional().describe("Only this meeting's tasks"),
      userEmail,
    },
  ),
  update_task: action(
    "Change a task's text, mark it done, or reopen it. A personal key can change only your own tasks.",
    "tasks.update",
    {
      taskId: z.string().min(1).describe("The task's id, from jamie.list_tasks"),
      completed: z.boolean().optional().describe("true to mark it done, false to reopen it"),
      text: z.string().min(1).max(10_000).optional().describe("The task's new text"),
    },
    { post: true },
  ),
  list_tags: action("Your tags and the ones shared with you (personal key only): id, name, and whether it was shared.", "tags.list", {}),
};

export const jamie: OwnApp = {
  app: "jamie",
  name: "Jamie",
  logo: "/logos/jamie.svg",
  keyField: {
    label: "API key",
    help: "In Jamie, open Settings → API & MCP → API keys, click New key, name it and copy it; it's shown only once. Needs a Pro, Team or Enterprise plan. A Personal key covers your meetings and ones shared with you (and can search them); admins can pick the Team tab for a workspace key that covers everyone's meetings.",
    placeholder: "jk_...",
  },
  async check(key) {
    await jamieCall(key, "meetings.list", { limit: 1 });
    return scopes.get(key) === "workspace" ? "Jamie workspace" : "Jamie";
  },
  actions,
};
