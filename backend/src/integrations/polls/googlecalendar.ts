import { z } from "zod";
import { recent, type PollTrigger, type Run } from "./index";

// ponytail: 250 most recently updated events per check; a calendar changing more than that within a check may miss some
const CONFIG = {
  calendar_id: z.string().default("primary").describe('Which calendar: its id, or "primary" for the person\'s main one'),
  q: z.string().optional().describe("Only events with these words in the title or description"),
};
const output: PollTrigger["output"] = [{ name: "event", type: "object", required: true, description: "The Google Calendar event: id, status, summary, start, end, attendees, organizer, hangoutLink, updated" }];
const DAY = 86_400_000;

type Config = { calendar_id: string; q?: string };
const changed = async ({ calendar_id, q }: Config, run: Run, showDeleted: boolean) => {
  const res = (await run("googlecalendar.events_list", { calendarId: calendar_id, q, updatedMin: new Date(Date.now() - DAY).toISOString(), orderBy: "updated", showDeleted, maxResults: 250 })) as { items?: any[] };
  return (res.items ?? []).filter((e) => recent(e.updated));
};
const trigger = (description: string, deleted: boolean, keep: (e: any) => boolean, id: (e: any) => string = (e) => `${e.id}:${e.updated}`): PollTrigger => ({
  description: `${description}.`,
  config: z.object(CONFIG),
  output,
  every: 5,
  min: 5,
  poll: async (c, run) => (await changed(c, run, deleted)).filter(keep).map((event) => ({ id: id(event), item: { event } })),
});
// Google stamps an event a moment after making it, so a first save isn't an update
const edited = (e: any) => Date.parse(e.updated) - Date.parse(e.created) > 5_000;

export const googlecalendar: Record<string, PollTrigger> = {
  google_calendar_event_created_trigger: trigger("A new event is added to a calendar", false, (e) => recent(e.created) && e.status !== "cancelled", (e) => e.id),
  google_calendar_event_updated_trigger: trigger("An event is changed after it was made", false, (e) => edited(e) && e.status !== "cancelled"),
  google_calendar_event_change_trigger: trigger("An event is created, changed or cancelled", true, () => true),
  google_calendar_event_sync_trigger: trigger("An event is created, changed or cancelled, with its full details", true, () => true),
  event_canceled_deleted_trigger: trigger("An event is cancelled or deleted", true, (e) => e.status === "cancelled", (e) => e.id),
  attendee_response_changed_trigger: {
    description: "A guest accepts, declines or says maybe to an upcoming event. An event already on the calendar when this is turned on is watched too, so only changes from then on are reported.",
    config: z.object({ ...CONFIG, email: z.string().optional().describe("Only this guest") }),
    output: [...output, { name: "attendee", type: "object", required: true, description: "The guest: email, displayName, responseStatus (accepted, declined, tentative)" }],
    every: 5,
    min: 5,
    async poll({ calendar_id, q, email }, run) {
      // ponytail: the next 100 events, so seen ids fit; a response on an event further out is noticed once it's within them
      const res = (await run("googlecalendar.events_list", { calendarId: calendar_id, q, timeMin: new Date().toISOString(), singleEvents: true, orderBy: "startTime", maxResults: 100 })) as { items?: any[] };
      return (res.items ?? []).flatMap((event) =>
        (event.attendees ?? [])
          .filter((a: any) => a.responseStatus !== "needsAction" && (!email || a.email?.toLowerCase() === email.toLowerCase()))
          .map((attendee: any) => ({ id: `${event.id}:${attendee.email}:${attendee.responseStatus}`, item: { event, attendee } })),
      ).slice(0, 900);
    },
  },
  event_starting_soon_trigger: {
    description: "An event is about to start, a set number of minutes ahead (checked every 5 minutes by default, so it can be a few minutes early).",
    config: z.object({ ...CONFIG, minutes: z.number().int().positive().default(15).describe("How many minutes before it starts") }),
    output: [...output, { name: "minutes_left", type: "number", required: true, description: "Minutes until it starts" }],
    every: 5,
    min: 5,
    async poll({ calendar_id, q, minutes }, run) {
      const now = Date.now();
      const res = (await run("googlecalendar.events_list", { calendarId: calendar_id, q, timeMin: new Date(now).toISOString(), timeMax: new Date(now + minutes * 60_000).toISOString(), singleEvents: true, orderBy: "startTime", maxResults: 250 })) as { items?: any[] };
      return (res.items ?? [])
        .filter((e) => e.start?.dateTime && Date.parse(e.start.dateTime) > now)
        .map((event) => ({ id: `${event.id}:${event.start.dateTime}`, item: { event, minutes_left: Math.round((Date.parse(event.start.dateTime) - now) / 60_000) } }));
    },
  },
};
