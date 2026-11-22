import { z } from "zod";
import { recent, type PollTrigger } from "./index";

// Everything a workspace reports comes by webhook (own/toggl/triggers.ts). Toggl's Free plan allows one webhook with
// three events per workspace, so the person's own new time entries are also watched by polling, which has no limit.
export const toggl: Record<string, PollTrigger> = {
  new_time_entry: {
    description: "You add a time entry or start a timer in Toggl Track (checked every 5 minutes by default). Works on every Toggl plan. Optionally only one project.",
    config: z.object({ project_id: z.number().optional().describe("Only time entries on this project (its id, from get_projects)") }),
    output: [{ name: "time_entry", type: "object", required: true, description: "The time entry: id, description, start, stop, duration in seconds (negative while running), project_id, workspace_id, tags, billable" }],
    every: 5,
    min: 1,
    async poll({ project_id }, run) {
      const since = new Date(Date.now() - 86_400_000).toISOString();
      const entries = (await run("toggl.get_time_entries", { start_date: since, end_date: new Date(Date.now() + 60_000).toISOString() })) as any[];
      return (entries ?? [])
        .filter((t) => recent(t.at ?? t.start))
        .filter((t) => !project_id || t.project_id === project_id)
        .map((time_entry) => ({ id: String(time_entry.id), item: { time_entry } }));
    },
  },
};
