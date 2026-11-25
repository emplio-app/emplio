// MeetGeek meetings, polled: works without pasting a webhook address into MeetGeek. The moment its notes are done comes
// by webhook once that's set up (own/meetgeek/triggers.ts).
import { z } from "zod";
import { recent, type PollTrigger } from "./index";

type Meeting = { meeting_id: string; timestamp_start_utc?: string; timestamp_end_utc?: string };

export const meetgeek: Record<string, PollTrigger> = {
  new_meeting: {
    description: "A meeting recorded by MeetGeek ended and is in the meeting list (checked every 15 minutes; Free and Pro keys allow 100 calls a day). Its summary may still be in the making: get_summary reads it.",
    config: z.object({ team_id: z.number().optional().describe("Only this team's meetings (its id; list_teams lists them)") }),
    output: [{ name: "meeting", type: "object", required: true, description: "The meeting: meeting_id, timestamp_start_utc, timestamp_end_utc" }],
    every: 15,
    min: 15,
    poll: async ({ team_id }, run) => {
      // ponytail: the newest 50 only; more meetings than that ending between two checks are missed
      const out = (await (team_id ? run("meetgeek.list_team_meetings", { teamId: team_id, limit: 50 }) : run("meetgeek.list_meetings", { limit: 50 }))) as { meetings?: Meeting[] };
      return (out?.meetings ?? []).filter((m) => recent(m.timestamp_end_utc ?? m.timestamp_start_utc)).map((m) => ({ id: m.meeting_id, item: { meeting: m } }));
    },
  },
};
