import { afterEach, expect, test } from "bun:test";
import { z } from "zod";
import { pollOnce } from "../../polls/index";
import { own } from "../index";
import { gaps, googlecalendar } from "./index";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
type Call = { url: URL; method: string; body: any; headers: Record<string, string> };
const stub = (answer: (c: Call) => Response) => {
  const calls: Call[] = [];
  globalThis.fetch = (async (url: string, init: RequestInit = {}) => {
    const c = { url: new URL(String(url)), method: init.method ?? "GET", body: init.body ? JSON.parse(String(init.body)) : undefined, headers: init.headers as Record<string, string> };
    calls.push(c);
    return answer(c);
  }) as typeof fetch;
  return calls;
};
const login = { externalId: "c1", secret: "tok" };
const run = (a: string, i: unknown) => own.run(a, i, login, "o");

test("reads run unasked, writes ask, every input is a usable schema", async () => {
  for (const r of ["events_list", "events_get", "list_calendars", "free_busy_query", "find_event", "find_free_slots", "get_current_user", "settings_list", "acl_list", "events_list_all_calendars", "get_current_date_time"]) expect((await own.getAction(`googlecalendar.${r}`))?.readOnly, r).toBe(true);
  for (const w of ["create_event", "update_event", "patch_event", "delete_event", "quick_add", "events_move", "remove_attendee", "batch_events", "acl_insert", "calendars_delete", "clear_calendar"]) expect((await own.getAction(`googlecalendar.${w}`))?.readOnly, w).toBeFalsy();
  for (const a of Object.values(googlecalendar.actions)) z.toJSONSchema(a.input, { io: "input" });
});

test("create_event sends the event, nested times included, with the query where it belongs", async () => {
  const calls = stub(() => json({ id: "e1" }));
  await run("googlecalendar.create_event", { calendarId: "primary", summary: "Standup", start: { dateTime: "2026-11-10T09:00:00+05:30", timeZone: "Asia/Kolkata" }, end: { dateTime: "2026-11-10T09:30:00+05:30" }, sendUpdates: "all", conferenceDataVersion: 1 });
  const c = calls[0]!;
  expect(c.method).toBe("POST");
  expect(c.url.origin + c.url.pathname).toBe("https://www.googleapis.com/calendar/v3/calendars/primary/events");
  expect(Object.fromEntries(c.url.searchParams)).toEqual({ sendUpdates: "all", conferenceDataVersion: "1" });
  expect(c.body).toEqual({ summary: "Standup", start: { dateTime: "2026-11-10T09:00:00+05:30", timeZone: "Asia/Kolkata" }, end: { dateTime: "2026-11-10T09:30:00+05:30" } });
  expect(c.headers.Authorization).toBe("Bearer tok");
});

test("quick_add and free/busy", async () => {
  const calls = stub((c) => (c.url.pathname.endsWith("/freeBusy") ? json({ calendars: { primary: { busy: [{ start: "2026-11-10T10:00:00Z", end: "2026-11-10T11:00:00Z" }] } } }) : json({ id: "e2" })));
  await run("googlecalendar.quick_add", { calendarId: "a@b.co", text: "Lunch tomorrow 1pm" });
  expect(calls[0]!.url.pathname).toBe("/calendar/v3/calendars/a%40b.co/events/quickAdd");
  expect(calls[0]!.url.searchParams.get("text")).toBe("Lunch tomorrow 1pm");
  const out = (await run("googlecalendar.find_free_slots", { timeMin: "2026-11-10T09:00:00Z", timeMax: "2026-11-10T12:00:00Z" })) as any;
  expect(calls[1]!.body).toEqual({ timeMin: "2026-11-10T09:00:00Z", timeMax: "2026-11-10T12:00:00Z", items: [{ id: "primary" }] });
  expect(out.free).toEqual([{ start: "2026-11-10T09:00:00.000Z", end: "2026-11-10T10:00:00.000Z", minutes: 60 }, { start: "2026-11-10T11:00:00.000Z", end: "2026-11-10T12:00:00.000Z", minutes: 60 }]);
});

test("gaps ignore overlaps and short spells", () => {
  const busy = [{ start: "2026-11-10T09:00:00Z", end: "2026-11-10T10:00:00Z" }, { start: "2026-11-10T09:30:00Z", end: "2026-11-10T10:30:00Z" }, { start: "2026-11-10T10:40:00Z", end: "2026-11-10T11:00:00Z" }];
  expect(gaps(busy, "2026-11-10T09:00:00Z", "2026-11-10T12:00:00Z", 30)).toEqual([{ start: "2026-11-10T11:00:00.000Z", end: "2026-11-10T12:00:00.000Z", minutes: 60 }]);
});

test("remove_attendee keeps the others, and says when the person isn't on it", async () => {
  const calls = stub((c) => (c.method === "GET" ? json({ attendees: [{ email: "a@b.co" }, { email: "c@d.co" }] }) : json({ id: "e1" })));
  await run("googlecalendar.remove_attendee", { eventId: "e1", email: "A@B.CO", sendUpdates: "all" });
  expect(calls[1]!.method).toBe("PATCH");
  expect(calls[1]!.body).toEqual({ attendees: [{ email: "c@d.co" }] });
  expect(calls[1]!.url.searchParams.get("sendUpdates")).toBe("all");
  await expect(run("googlecalendar.remove_attendee", { eventId: "e1", email: "x@y.co" })).rejects.toThrow("isn't on this event");
});

test("batch_events reports each one, and one failing doesn't stop the rest", async () => {
  stub((c) => (c.method === "DELETE" ? json({ error: { message: "Gone" } }, 410) : json({ id: "made" })));
  const out = (await run("googlecalendar.batch_events", { operations: [{ action: "delete", eventId: "e0" }, { action: "create", event: { summary: "S", start: { date: "2026-11-10" }, end: { date: "2026-11-11" } } }] })) as any;
  expect(out.results[0]).toMatchObject({ ok: false });
  expect(out.results[1]).toEqual({ ok: true, result: { id: "made" } });
});

const iso = (ago: number) => new Date(Date.now() - ago * 60_000).toISOString();

test("polled: a first look only notes, later ones report the new event, and q reaches Google", async () => {
  let items = [{ id: "e1", created: iso(30), updated: iso(30), status: "confirmed" }];
  const calls = stub(() => json({ items }));
  const first = await pollOnce("googlecalendar.google_calendar_event_created_trigger", { calendar_id: "primary", q: "standup" }, null, run);
  expect(first.fresh).toEqual([]);
  expect(calls[0]!.url.searchParams.get("q")).toBe("standup");
  expect(calls[0]!.url.searchParams.get("orderBy")).toBe("updated");
  expect(calls[0]!.url.searchParams.get("updatedMin")).toBeTruthy();
  items = [...items, { id: "e2", created: iso(1), updated: iso(1), status: "confirmed" }];
  const later = await pollOnce("googlecalendar.google_calendar_event_created_trigger", { calendar_id: "primary" }, first.seen, run);
  expect((later.fresh[0] as any).event.id).toBe("e2");
});

test("polled: updated skips brand-new events; cancelled needs status cancelled and asks for deleted ones", async () => {
  const items = [{ id: "new", created: iso(1), updated: iso(1), status: "confirmed" }, { id: "old", created: iso(600), updated: iso(1), status: "confirmed" }, { id: "gone", created: iso(600), updated: iso(1), status: "cancelled" }];
  const calls = stub(() => json({ items }));
  const up = await pollOnce("googlecalendar.google_calendar_event_updated_trigger", { calendar_id: "primary" }, [], run);
  expect(up.fresh.map((f: any) => f.event.id)).toEqual(["old"]);
  const gone = await pollOnce("googlecalendar.event_canceled_deleted_trigger", { calendar_id: "primary" }, [], run);
  expect(gone.fresh.map((f: any) => f.event.id)).toEqual(["gone"]);
  expect(calls[1]!.url.searchParams.get("showDeleted")).toBe("true");
});

test("polled: starting soon looks only as far ahead as asked, and takes minutes", async () => {
  const soon = new Date(Date.now() + 10 * 60_000).toISOString();
  const calls = stub(() => json({ items: [{ id: "e9", start: { dateTime: soon } }] }));
  const out = await pollOnce("googlecalendar.event_starting_soon_trigger", { calendar_id: "primary", minutes: 15 }, [], run);
  expect((out.fresh[0] as any).minutes_left).toBe(10);
  const span = Date.parse(calls[0]!.url.searchParams.get("timeMax")!) - Date.parse(calls[0]!.url.searchParams.get("timeMin")!);
  expect(span).toBe(15 * 60_000);
});

test("polled: a guest's new answer is reported once; an invitation not yet answered isn't", async () => {
  const event = (status: string) => ({ id: "e1", attendees: [{ email: "a@b.co", responseStatus: status }, { email: "c@d.co", responseStatus: "needsAction" }] });
  let items = [event("needsAction")];
  stub(() => json({ items }));
  const first = await pollOnce("googlecalendar.attendee_response_changed_trigger", { calendar_id: "primary" }, null, run);
  items = [event("accepted")];
  const later = await pollOnce("googlecalendar.attendee_response_changed_trigger", { calendar_id: "primary" }, first.seen, run);
  expect(later.fresh.map((f: any) => f.attendee.email)).toEqual(["a@b.co"]);
});
