// Leexi's events, polled: its only webhook (call.processed) is set up by hand in Leexi's settings, unsigned, and
// can't be registered through the API.
import { z } from "zod";
import { recent, type PollTrigger } from "./index";

type Row = Record<string, any>;
const rows = (out: unknown) => ((out as { data?: Row[] })?.data ?? []) as Row[];
// a call is ready once Leexi has written its AI notes (summary prompts) or its chapters, as its webhook waits for
const ready = (c: Row) => (c.prompts ?? []).some((p: Row) => (p.completions ?? []).length) || (c.chapters ?? []).length > 0;

export const leexi: Record<string, PollTrigger> = {
  new_call: {
    description: "A call or meeting recorded in Leexi is transcribed and its AI notes are ready (checked every 10 minutes). Optionally only one person's calls, or one kind of conversation.",
    config: z.object({
      owner_uuid: z.string().optional().describe("Only calls this Leexi user owns (their uuid; list_users lists them)"),
      conversation_type_uuid: z.string().optional().describe("Only this kind of conversation, like a sales demo (its uuid, from a call's conversation_type)"),
    }),
    output: [
      {
        name: "call",
        type: "object",
        required: true,
        description:
          "The call: uuid, title, description, performed_at, duration (seconds), direction, owner and participating_users (name, email, uuid), customers, prompts (AI notes: title, category, completions), chapters, leexi_url, recording_url. get_call adds the transcript",
      },
    ],
    every: 10,
    min: 2,
    // ponytail: the 100 most recently changed calls; more than 100 changed between polls are missed
    poll: async ({ owner_uuid, conversation_type_uuid }, run) =>
      rows(
        await run("leexi.list_calls", { order: "updated_at desc", items: 100, ...(owner_uuid && { owner_uuid: [owner_uuid] }), ...(conversation_type_uuid && { conversation_type_uuid }) }),
      )
        .filter((c) => recent(c.updated_at ?? c.created_at) && ready(c))
        .map((c) => ({ id: String(c.uuid), item: { call: c } })),
  },
  new_meeting_event: {
    description: "A meeting is added to Leexi: from a connected calendar, by hand or through the API (checked every 10 minutes).",
    config: z.object({ origin: z.enum(["calendar", "manual", "api"]).optional().describe("Only meetings that came this way") }),
    output: [
      {
        name: "meeting_event",
        type: "object",
        required: true,
        description: "The meeting: uuid, title, description, start_time, end_time, organizer, attendees (emails), meeting_url, meeting_provider, internal, to_record, bot_scheduled",
      },
    ],
    every: 10,
    min: 2,
    // ponytail: the newest 100; seen ids keep old ones from coming back
    poll: async ({ origin }, run) =>
      rows(await run("leexi.list_meeting_events", { order: "created_at desc", items: 100, ...(origin && { origin }) })).map((m) => ({ id: String(m.uuid), item: { meeting_event: m } })),
  },
  meeting_starting_soon: {
    description: "A meeting in Leexi starts within the next hour, or however many minutes you choose (checked every 5 minutes). Good for a briefing before a call. Moving the meeting makes it news again.",
    config: z.object({ minutes: z.number().min(5).max(1440).optional().describe("How long before the start to be told, in minutes (default 60)") }),
    output: [{ name: "meeting_event", type: "object", required: true, description: "The meeting: uuid, title, description, start_time, end_time, organizer, attendees (emails), meeting_url, to_record, bot_scheduled" }],
    every: 5,
    min: 1,
    poll: async ({ minutes = 60 }, run) => {
      const now = Date.now();
      const out = await run("leexi.list_meeting_events", {
        order: "start_time asc",
        items: 100,
        date_filter: "start_time",
        from: new Date(now).toISOString(),
        to: new Date(now + minutes * 60_000).toISOString(),
      });
      return rows(out).map((m) => ({ id: `${m.uuid}:${m.start_time}`, item: { meeting_event: m } }));
    },
  },
};
