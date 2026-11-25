// Circleback: its webhooks are set up only in its own Automations page, not through the API, so everything here is
// polled: meetings whose notes are ready, action items added or done, and calendar meetings about to start.
import { z } from "zod";
import { recent, type PollTrigger } from "./index";

const DAY = 86_400_000;
const items = (out: unknown) => ((out as { items?: any[] })?.items ?? []) as any[];
const assignee = z
  .enum(["Me", "NotMe", "MyWorkspace", "OutsideMyWorkspace", "Unassigned", "Anyone"])
  .optional()
  .describe("Whose action items: Me (default), NotMe, MyWorkspace, OutsideMyWorkspace, Unassigned or Anyone");
const ACTION_ITEM = "The action item: id, title, description, assignee (name, email), status (PENDING or DONE), completedAt, meetingIds, meetings";

export const circleback: Record<string, PollTrigger> = {
  new_meeting: {
    description: "A Circleback meeting's notes are ready (checked every 5 minutes): notes, action items, attendees, insights. Optionally only meetings with a tag or in a folder.",
    config: z.object({
      ownership: z.enum(["Mine", "Shared", "All"]).optional().describe("Mine (default): meetings you own; Shared: shared with you; All: both"),
      tag_id: z.number().int().optional().describe("Only meetings with this tag (its id; circleback.list_tags lists them)"),
      folder_id: z.string().optional().describe("Only meetings in this folder (its id; circleback.list_folders lists them)"),
    }),
    output: [{ name: "meeting", type: "object", required: true, description: "The meeting: id, name, createdAt, duration, url, recordingUrl, tags, attendees, notes (Markdown), actionItems, insights, calendarEvent. Its page is https://circleback.ai/meetings/<id>" }],
    every: 5,
    min: 1,
    // ponytail: the first page of meetings created in the last day; a meeting whose notes take longer than a day is missed
    poll: async ({ ownership, tag_id, folder_id }, run) =>
      items(
        await run("circleback.list_meetings", {
          createdAtGte: new Date(Date.now() - DAY).toISOString(),
          ...(ownership && { ownership }),
          ...(tag_id && { tagIds: [tag_id] }),
          ...(folder_id && { folderId: folder_id }),
        }),
      )
        .filter((m) => typeof m.notes === "string" && m.notes.trim())
        .map((m) => ({ id: String(m.id), item: { meeting: m } })),
  },
  new_action_item: {
    description: "A new open action item comes out of a Circleback meeting, or is added by hand (checked every 5 minutes). By default only ones assigned to you.",
    config: z.object({ assignee }),
    output: [{ name: "action_item", type: "object", required: true, description: ACTION_ITEM }],
    every: 5,
    min: 1,
    // ponytail: the first page of open action items; a burst bigger than a page between polls may miss some
    poll: async ({ assignee }, run) =>
      items(await run("circleback.list_action_items", { ...(assignee && { assigneeType: assignee }) })).map((a) => ({ id: String(a.id), item: { action_item: a } })),
  },
  action_item_completed: {
    description: "A Circleback action item is marked done (checked every 5 minutes). By default only ones assigned to you.",
    config: z.object({ assignee }),
    output: [{ name: "action_item", type: "object", required: true, description: ACTION_ITEM }],
    every: 5,
    min: 1,
    poll: async ({ assignee }, run) =>
      items(await run("circleback.list_action_items", { status: "DONE", ...(assignee && { assigneeType: assignee }) }))
        .filter((a) => !a.completedAt || recent(a.completedAt))
        .map((a) => ({ id: `${a.id}:done`, item: { action_item: a } })),
  },
  meeting_starting_soon: {
    description: "A meeting on your connected calendar starts within the next hour, or however many minutes you choose (checked every 5 minutes). Good for a briefing before a call. Moving the meeting makes it news again.",
    config: z.object({ minutes: z.number().min(5).max(1440).optional().describe("How long before the start to be told, in minutes (default 60)") }),
    output: [{ name: "event", type: "object", required: true, description: "The calendar meeting: id, title, startTime, endTime, attendees (name, email, isOrganizer, status), organizerEmail, location, meetingPlatform, isExternal, willRecord, meetingId" }],
    every: 5,
    min: 1,
    poll: async ({ minutes = 60 }, run) => {
      const now = Date.now();
      return items(await run("circleback.list_calendar_events", { startTimeLookbackHours: 0, startTimeLookaheadHours: Math.ceil(minutes / 60) }))
        .filter((e) => {
          const start = Date.parse(e.startTime);
          return start >= now && start <= now + minutes * 60_000;
        })
        .map((e) => ({ id: `${e.id}:${e.startTime}`, item: { event: e } }));
    },
  },
};
