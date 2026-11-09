import { z } from "zod";
import { recent, type PollTrigger } from "./index";

export const googlemeet: Record<string, PollTrigger> = {
  conference_ended: {
    description: "A Google Meet call ends. Recordings and transcripts can take a while to be ready after that.",
    config: z.object({ meeting_code: z.string().optional().describe("Only this meeting, like abc-mnop-xyz (default: all of them)") }),
    output: [{ name: "conference", type: "object", required: true, description: "The call: name, space, startTime, endTime" }],
    every: 5,
    min: 5,
    async poll({ meeting_code }, run) {
      const res = (await run("googlemeet.list_conference_records", { pageSize: 100, ...(meeting_code && { filter: `space.meeting_code = "${meeting_code.replace(/"/g, "")}"` }) })) as { conferenceRecords?: any[] };
      return (res.conferenceRecords ?? []).filter((c) => recent(c.endTime)).map((conference) => ({ id: conference.name, item: { conference } }));
    },
  },
};
