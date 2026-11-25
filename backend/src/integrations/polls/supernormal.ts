// Supernormal has no webhooks its API can register (its own integrations and Zapier are set up in its app), so
// both its events are polled: notes ready for a recorded meeting, and a calendar meeting about to start.
import { z } from "zod";
import { type PollTrigger, recent } from "./index";

type Recording = { id: string; completed_at?: string | null; [k: string]: unknown };
type Meeting = { id: string; start: string; [k: string]: unknown };

export const supernormal: Record<string, PollTrigger> = {
  new_recording: {
    description: "A recorded meeting's notes are ready in Supernormal (checked every 5 minutes). Carries the title, length, people count and short summary; supernormal.get_recording gives the full notes, supernormal.get_transcript every word.",
    config: z.object({
      visibility: z.enum(["all", "organization", "shared_with_me"]).optional().describe("Which meetings: all (default), organization (the whole team's), or shared_with_me"),
    }),
    output: [{ name: "recording", type: "object", required: true, description: "The recording: id, title, status, recorded_at, completed_at, duration_seconds, participants_count, summary, owner (first_name, last_name, email)" }],
    every: 5,
    min: 2,
    poll: async ({ visibility }, run) => {
      // ponytail: first page only (assumed newest first); more than a page of meetings finishing between checks misses the rest
      const out = (await run("supernormal.list_recordings", visibility ? { visibility } : {})) as { recordings?: Recording[] };
      return (out.recordings ?? []).filter((r) => r.completed_at && recent(r.completed_at)).map((r) => ({ id: r.id, item: { recording: r } }));
    },
  },
  meeting_starting_soon: {
    description: "A meeting on the Supernormal calendar starts within the next hour, or however many minutes you choose (checked every 5 minutes). Good for a briefing before a call, or for turning recording on or off. Moving the meeting makes it news again.",
    config: z.object({
      minutes: z.number().min(5).max(1440).optional().describe("How long before the start to be told, in minutes (default 60)"),
      only_recorded: z.boolean().optional().describe("Only meetings Supernormal is set to record"),
    }),
    output: [{ name: "meeting", type: "object", required: true, description: "The calendar meeting: id, name, start, end, url (meeting link), platform_name, is_recurring, scheduled_to_record, is_blocked_from_capture" }],
    every: 5,
    min: 2,
    poll: async ({ minutes = 60, only_recorded }, run) => {
      const now = Date.now();
      const out = (await run("supernormal.list_upcoming_meetings", { from: new Date(now).toISOString(), to: new Date(now + minutes * 60_000).toISOString() })) as Meeting[];
      return (Array.isArray(out) ? out : [])
        .filter((m) => {
          const start = Date.parse(m.start);
          return start >= now && start <= now + minutes * 60_000 && (!only_recorded || m.scheduled_to_record);
        })
        .map((m) => ({ id: `${m.id}:${m.start}`, item: { meeting: m } }));
    },
  },
};
