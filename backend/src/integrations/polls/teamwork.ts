// Teamwork.com things to watch without webhooks: the activity feed, which every user can read on every plan. Webhooks
// (own/teamwork/triggers.ts) need a site administrator on a paid plan; this works for anyone, a few minutes late.
import { z } from "zod";
import { recent, type PollTrigger } from "./index";

export const teamwork: Record<string, PollTrigger> = {
  new_activity: {
    description:
      "Something happens in Teamwork.com that shows in the activity feed: a task, comment, message, file, milestone, notebook or project is added, changed or completed (checked every 5 minutes). Works for any user on any plan; optionally only one project or kind of activity.",
    config: z.object({
      project_id: z.number().optional().describe("Only activity in this project (its id; list_projects lists them)"),
      activity_types: z.array(z.string()).optional().describe("Only these kinds of activity, like new, edited, completed, reopened, deleted, undeleted, liked, reacted, viewed"),
    }),
    output: [{ name: "activity", type: "object", required: true, description: "The activity: id, activityType, itemType (task, comment, message...), itemId, description, projectId, userId, dateTime" }],
    every: 5,
    min: 1,
    // ponytail: the newest 100 only; a burst bigger than that between polls is missed
    poll: async ({ project_id, activity_types }, run) => {
      const out = (await run("teamwork.latest_activity_projects", {
        pageSize: 100,
        ...(project_id && { projectIds: [project_id] }),
        ...(activity_types?.length && { activityTypes: [activity_types.join(",")] }),
      })) as { activities?: any[] };
      return (out?.activities ?? []).filter((a) => recent(a.dateTime ?? a.createdAt)).map((a) => ({ id: String(a.id), item: { activity: a } }));
    },
  },
};
