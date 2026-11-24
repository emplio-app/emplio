// Gong's events, polled: its webhooks are an action inside an automation rule set up by hand in Gong, not through the
// API. New calls, answered scorecards and Engage tasks are read from the API instead.
import { z } from "zod";
import { AppsError } from "../types";
import { recent, type PollTrigger } from "./index";

type Row = Record<string, any>;
const DAY = 86_400_000;
// Gong answers an empty list with a 404 ("No calls found corresponding to the provided filters")
const orNone = async (p: Promise<unknown>) => {
  try {
    return (await p) as Row;
  } catch (e) {
    if (e instanceof AppsError && /no .* found|\(404\)/i.test(e.message)) return {};
    throw e;
  }
};
const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);

export const gong: Record<string, PollTrigger> = {
  new_call: {
    description: "A call or meeting is recorded in Gong (checked every 10 minutes). Optionally only one person's calls or one workspace. Its transcript can take a little longer: get_call_transcripts reads it.",
    config: z.object({
      user_id: z.string().optional().describe("Only calls this Gong user hosted (their id; list_users lists them)"),
      workspace_id: z.string().optional().describe("Only calls in this workspace (its id; list_company_workspaces lists them)"),
    }),
    output: [
      {
        name: "call",
        type: "object",
        required: true,
        description: "The call: id, title, url (to open it in Gong), started, scheduled, duration (seconds), primaryUserId, direction, system, scope (Internal/External), media, language, workspaceId, purpose, meetingUrl",
      },
    ],
    every: 10,
    min: 5,
    // ponytail: the first page (100) of the last day's calls; a company with more calls a day than that misses some
    poll: async ({ user_id, workspace_id }, run) => {
      const out = await orNone(run("gong.list_calls", { fromDateTime: new Date(Date.now() - DAY).toISOString(), ...(workspace_id && { workspaceId: workspace_id }) }));
      return ((out.calls ?? []) as Row[])
        .filter((c) => !user_id || String(c.primaryUserId) === String(user_id))
        .map((c) => ({ id: String(c.id), item: { call: c } }));
    },
  },
  new_answered_scorecard: {
    description: "Someone fills in a scorecard on a Gong call, reviewing how it went (checked every 30 minutes). Optionally only one scorecard or one reviewed person.",
    config: z.object({
      scorecard_id: z.string().optional().describe("Only this scorecard (its id; list_scorecards lists them)"),
      reviewed_user_id: z.string().optional().describe("Only reviews of this Gong user (their id)"),
    }),
    output: [
      {
        name: "scorecard",
        type: "object",
        required: true,
        description: "The answered scorecard: answeredScorecardId, scorecardId, scorecardName, callId, callStartTime, reviewedUserId, reviewerUserId, reviewMethod, reviewTime, answers (questionId, answerText, score...)",
      },
    ],
    every: 30,
    min: 10,
    poll: async ({ scorecard_id, reviewed_user_id }, run) => {
      const filter = {
        reviewFromDate: day(Date.now() - DAY),
        ...(scorecard_id && { scorecardIds: [scorecard_id] }),
        ...(reviewed_user_id && { reviewedUserIds: [reviewed_user_id] }),
      };
      const out = await orNone(run("gong.list_answered_scorecards", { filter }));
      return ((out.answeredScorecards ?? []) as Row[]).map((s) => ({ id: String(s.answeredScorecardId), item: { scorecard: s } }));
    },
  },
  new_task: {
    description: "A new open Gong Engage task (a call to make, from a flow or added by hand) lands on someone's list (checked every 15 minutes).",
    config: z.object({ user_id: z.string().describe("Whose tasks (their Gong user id; list_users lists them)") }),
    output: [
      {
        name: "task",
        type: "object",
        required: true,
        description: "The task: id, userId, title, status, type (FLOW or MANUAL), actions, dueDate, priority, account, opportunity, contact, flow, created",
      },
    ],
    every: 15,
    min: 5,
    poll: async ({ user_id }, run) => {
      const out = await orNone(run("gong.list_tasks", { filter: { userId: user_id, status: ["OPEN"], types: ["FLOW", "MANUAL"], taskAction: ["CALL"] } }));
      return ((out.tasks ?? []) as Row[]).filter((t) => !t.created || recent(t.created)).map((t) => ({ id: String(t.id), item: { task: t } }));
    },
  },
};
