// tl;dv's two events, MeetingReady and TranscriptReady. tl;dv sends them by webhook only to an address set in its
// own settings (no API to register one, and no signature to check), so they're polled here instead.
import { z } from "zod";
import { recent, type PollTrigger, type Run } from "./index";

type Meeting = {
  id: string;
  name?: string;
  happenedAt?: string;
  [k: string]: unknown;
};
const MEETING = {
  name: "meeting",
  type: "object",
  required: true,
  description: "The meeting: id, name, happenedAt, url, duration (seconds), organizer, invitees, template",
};
const config = z.object({
  meetingType: z.enum(["internal", "external"]).optional().describe("Only internal meetings (everyone from the same company) or external ones"),
  onlyParticipated: z.boolean().optional().describe("Only meetings the key's owner took part in"),
});

// meetings from the last day, newest first
const meetings = async (c: z.infer<typeof config>, run: Run) => {
  const from = new Date(Date.now() - 86_400_000).toISOString();
  const out = (await run("tldv.list_meetings", { from, limit: 100, ...c })) as {
    results?: Meeting[];
  };
  return (out.results ?? []).filter((m) => recent(m.happenedAt));
};

export const tldv: Record<string, PollTrigger> = {
  meeting_ready: {
    description:
      "A tl;dv meeting recording is ready (checked every 5 minutes). Its notes and transcript come from tldv.get_meeting_notes and tldv.get_meeting_transcript.",
    config,
    output: [MEETING],
    every: 5,
    min: 2,
    poll: async (c, run) => (await meetings(c, run)).map((m) => ({ id: m.id, item: { meeting: m } })),
  },
  transcript_ready: {
    description: "A tl;dv meeting's transcript is ready (checked every 5 minutes); the event carries the transcript, speaker by speaker.",
    config,
    output: [
      MEETING,
      {
        name: "transcript",
        type: "object",
        required: true,
        description: "id, meetingId, data: sentences with speaker, text, startTime, endTime (seconds)",
      },
    ],
    every: 5,
    min: 2,
    poll: async (c, run) => {
      // ponytail: one transcript call per meeting of the last day, the 10 newest; a busier day misses the rest
      const found = await Promise.all(
        (await meetings(c, run)).slice(0, 10).map(async (m) => {
          const t = (await run("tldv.get_meeting_transcript", {
            meetingId: m.id,
          }).catch(() => null)) as { data?: unknown[] } | null;
          return t?.data?.length ? { id: m.id, item: { meeting: m, transcript: t } } : null;
        }),
      );
      return found.filter((x) => x !== null);
    },
  },
};
