// Cal.com things its webhooks don't report: a booking about to start. Everything else comes by webhook
// (own/calcom/triggers.ts).
import { z } from "zod";
import type { PollTrigger } from "./index";

type Booking = { uid: string; start: string; [k: string]: unknown };

export const calcom: Record<string, PollTrigger> = {
  booking_starting_soon: {
    description: "A Cal.com booking starts within the next hour, or however many minutes you choose (checked every 5 minutes). Good for a briefing before a call. Moving the booking makes it news again.",
    config: z.object({
      minutes: z.number().min(5).max(1440).optional().describe("How long before the start to be told, in minutes (default 60)"),
      event_type_id: z.number().optional().describe("Only bookings of this event type (its id; list_event_types lists them)"),
    }),
    output: [{ name: "booking", type: "object", required: true, description: "The booking: uid, title, start, end, eventType, attendees (name, email, timeZone), hosts, location, meetingUrl, bookingFieldsResponses" }],
    every: 5,
    min: 1,
    poll: async ({ minutes = 60, event_type_id }, run) => {
      const now = Date.now();
      // ponytail: the next 100 upcoming bookings only; a diary with more than that within the window misses the rest
      const out = (await run("calcom.fetch_all_bookings", { status: "upcoming", sortStart: "asc", limit: 100, ...(event_type_id && { eventTypeId: String(event_type_id) }) })) as { data?: Booking[] };
      return (out.data ?? [])
        .filter((b) => {
          const start = Date.parse(b.start);
          return start >= now && start <= now + minutes * 60_000;
        })
        .map((b) => ({ id: `${b.uid}:${b.start}`, item: { booking: b } }));
    },
  },
};
