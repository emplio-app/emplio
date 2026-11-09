// Google Calendar on sign-in: every method of its API from its Discovery document (`bun scripts/openapi-actions.ts googlecalendar`),
// plus what Composio had on top, under the same names. Triggers are polled (polls/googlecalendar.ts).
import { z } from "zod";
import { AppsError } from "../../types";
import { googleApi, googleCheck, googleOAuth } from "../google-login";
import type { OwnAction, OwnApp } from "../index";
import { call, rest, type Send, specActions } from "../openapi";

const api = googleApi("Google Calendar", "https://www.googleapis.com/calendar/v3");
const actions = await specActions(new URL("./actions.json", import.meta.url), api);

const EVENTS = "/calendars/{calendarId}/events";
const calendarId = z.string().default("primary").describe('Which calendar: its id, or "primary" for the person\'s main one (default)');
const eventId = z.string().describe("The event's id, from googlecalendar.events_list or find_event");
const when = (word: string) => z.string().describe(`${word} time, with its offset, like 2026-11-09T09:00:00+05:30`);
const get = (path: string, ...query: string[]): Send => ({ method: "GET", path, query, headers: [] });
const patch = (path: string, ...fields: string[]): Send => ({ method: "PATCH", path, query: ["sendUpdates"], headers: [], body: { kind: "fields", fields: fields.map((f): [string, string] => [f, f]) } });
const sendUpdates = z.enum(["all", "externalOnly", "none"]).optional().describe("Who Google emails about this: all, externalOnly or none");

const listCalendars = (key: string) => call(api, key, get("/users/me/calendarList", "maxResults"), { maxResults: 250 }) as Promise<{ items?: { id: string; summary?: string }[] }>;
const listEvents = (key: string, i: Record<string, unknown>) => call(api, key, get(EVENTS, "q", "timeMin", "timeMax", "maxResults", "pageToken", "singleEvents", "orderBy"), i) as Promise<{ items?: any[] }>;
const profile = (key: string) => call(api, key, get("/calendars/primary"), {}) as Promise<{ id: string; summary?: string; timeZone?: string }>;

// free time between the busy stretches, inside [from, to]
export function gaps(busy: { start: string; end: string }[], from: string, to: string, minMinutes = 0) {
  const stretches = busy.map((b) => [Date.parse(b.start), Date.parse(b.end)] as const).sort((a, b) => a[0] - b[0]);
  const free: { start: string; end: string; minutes: number }[] = [];
  const end = Date.parse(to);
  let at = Date.parse(from);
  const add = (a: number, b: number) => {
    const minutes = Math.floor((b - a) / 60_000);
    if (minutes > 0 && minutes >= minMinutes) free.push({ start: new Date(a).toISOString(), end: new Date(b).toISOString(), minutes });
  };
  for (const [a, b] of stretches) {
    if (a > at) add(at, Math.min(a, end));
    at = Math.max(at, b);
  }
  if (at < end) add(at, end);
  return free;
}

const helpers: Record<string, OwnAction> = {
  find_event: rest(api, "GET", EVENTS, "Find events in a calendar by words in the title or description, and between two times.", z.object({
    calendarId,
    q: z.string().optional().describe("Words to look for"),
    timeMin: when("Earliest").optional(),
    timeMax: when("Latest").optional(),
    singleEvents: z.boolean().default(true).describe("true (default) lists each meeting of a repeating series on its own"),
    orderBy: z.enum(["startTime", "updated"]).default("startTime"),
    maxResults: z.number().int().max(2500).optional(),
    pageToken: z.string().optional().describe("From the last answer, for the next page"),
  })),
  events_list_all_calendars: {
    description: "List events across all the person's calendars between two times. An event on several calendars appears once. A calendar that can't be read is reported in errors.",
    readOnly: true,
    input: z.object({
      calendarIds: z.array(z.string()).optional().describe("Only these calendars (default: all of them)"),
      timeMin: when("Earliest"),
      timeMax: when("Latest"),
      q: z.string().optional().describe("Words to look for"),
      maxResults: z.number().int().max(250).default(100).describe("At most this many per calendar"),
    }),
    async run(i, key) {
      const ids: string[] = i.calendarIds ?? ((await listCalendars(key)).items ?? []).map((c) => c.id);
      const errors: { calendarId: string; error: string }[] = [];
      const seen = new Map<string, unknown>();
      for (const id of ids) {
        const page = await listEvents(key, { calendarId: id, q: i.q, timeMin: i.timeMin, timeMax: i.timeMax, maxResults: i.maxResults, singleEvents: true, orderBy: "startTime" }).catch((e: Error) => {
          errors.push({ calendarId: id, error: e.message });
          return { items: [] };
        });
        for (const ev of page.items ?? []) if (!seen.has(ev.iCalUID ?? ev.id)) seen.set(ev.iCalUID ?? ev.id, { ...ev, calendarId: id });
      }
      return { items: [...seen.values()], errors };
    },
  },
  find_free_slots: {
    description: "Work out the free time in one or more calendars between two times.",
    readOnly: true,
    input: z.object({
      calendars: z.array(z.string()).default(["primary"]).describe('The calendars to check (default: ["primary"])'),
      timeMin: when("Start").optional().describe("From when (default: now), with offset, like 2026-11-09T09:00:00+05:30"),
      timeMax: when("End").optional().describe("Until when (default: 24 hours from the start). At most about 3 months ahead"),
      minMinutes: z.number().int().default(0).describe("Only gaps at least this long"),
    }),
    async run(i, key) {
      const timeMin = i.timeMin ?? new Date().toISOString();
      const timeMax = i.timeMax ?? new Date(Date.parse(timeMin) + 86_400_000).toISOString();
      const out = (await call(api, key, { method: "POST", path: "/freeBusy", query: [], headers: [], body: { kind: "fields", fields: [["timeMin", "timeMin"], ["timeMax", "timeMax"], ["items", "items"]] } }, {
        timeMin,
        timeMax,
        items: i.calendars.map((id: string) => ({ id })),
      })) as { calendars?: Record<string, { busy?: { start: string; end: string }[]; errors?: unknown[] }> };
      const busy = Object.values(out.calendars ?? {}).flatMap((c) => c.busy ?? []);
      const errors = Object.entries(out.calendars ?? {}).filter(([, c]) => c.errors?.length).map(([id, c]) => ({ calendarId: id, errors: c.errors }));
      return { timeMin, timeMax, free: gaps(busy, timeMin, timeMax, i.minMinutes), busy, errors };
    },
  },
  get_current_user: { description: "Who the connected Google Calendar belongs to: email, name and time zone.", readOnly: true, input: z.object({}), run: async (_i, key) => { const p = await profile(key); return { email: p.id, name: p.summary, timeZone: p.timeZone }; } },
  get_calendar_profile: { description: "The person's main calendar: id, name and time zone.", readOnly: true, input: z.object({}), run: (_i, key) => profile(key) },
  get_current_date_time: {
    description: "The current date and time in a time zone. Use it before working out relative dates like \"tomorrow\".",
    readOnly: true,
    input: z.object({ timeZone: z.string().optional().describe("An IANA zone, like Asia/Kolkata (default: the calendar's own)") }),
    async run(i, key) {
      const timeZone = i.timeZone ?? (await profile(key)).timeZone ?? "UTC";
      const now = new Date();
      return { iso: now.toISOString(), timeZone, local: now.toLocaleString("en-GB", { timeZone, dateStyle: "full", timeStyle: "long" }) };
    },
  },
  remove_attendee: {
    description: "Take one person off an event's guest list. Two of these at once on the same event can overwrite each other.",
    input: z.object({ calendarId, eventId, email: z.string().describe("The guest's email address"), sendUpdates }),
    async run(i, key) {
      const event = (await call(api, key, get(`${EVENTS}/{eventId}`), i)) as { attendees?: { email?: string }[] };
      const left = (event.attendees ?? []).filter((a) => a.email?.toLowerCase() !== i.email.toLowerCase());
      if (left.length === (event.attendees ?? []).length) throw new AppsError(`${i.email} isn't on this event`);
      return call(api, key, patch(`${EVENTS}/{eventId}`, "attendees"), { ...i, attendees: left });
    },
  },
  sync_events: rest(api, "GET", EVENTS, "Get events for a full sync, or only what changed since an earlier sync token. The answer's nextSyncToken is for next time; an expired one (410) means start over without it.", z.object({
    calendarId,
    syncToken: z.string().optional().describe("From an earlier answer. Leave out for a full sync"),
    pageToken: z.string().optional().describe("From the last answer, for the next page"),
    maxResults: z.number().int().max(2500).optional(),
    showDeleted: z.boolean().optional().describe("Also list cancelled events"),
  })),
  batch_events: {
    description: "Create, change or delete up to 100 events in one go. Each is done in turn, and the answer says how each went.",
    input: z.object({
      operations: z.array(z.object({
        action: z.enum(["create", "patch", "delete"]).describe("What to do"),
        calendarId,
        eventId: z.string().optional().describe("The event, for patch and delete"),
        event: z.record(z.string(), z.any()).optional().describe("The event's fields, as in googlecalendar.create_event, for create and patch"),
        sendUpdates,
      })).min(1).max(100).describe("What to do, in order"),
    }),
    async run(i, key) {
      // ponytail: one at a time up to 100; Google's multipart batch endpoint if a bigger migration shows up
      const results: unknown[] = [];
      for (const op of i.operations) {
        const verb = op.action === "create" ? "create_event" : op.action === "patch" ? "patch_event" : "delete_event";
        results.push(await actions[verb]!.run({ calendarId: op.calendarId, eventId: op.eventId, sendUpdates: op.sendUpdates, ...op.event }, key).then(
          (result) => ({ ok: true, result }),
          (e: Error) => ({ ok: false, error: e.message }),
        ));
      }
      return { results };
    },
  },
};

export const googlecalendar: OwnApp = {
  app: "googlecalendar",
  name: "Google Calendar",
  logo: "/logos/googlecalendar.svg",
  check: googleCheck,
  oauth: googleOAuth("Google Calendar", "googlecalendar"),
  // Composio had these twice under another name; saved automations keep working
  actions: { ...actions, ...helpers, duplicate_calendar: actions.create_calendar!, list_settings: actions.settings_list! },
};
