// Fellow things its webhooks don't report: a note being made (an agenda before the meeting, too), a recording landing
// and any new action item. AI notes and action items assigned or done come by webhook (own/fellow/triggers.ts).
import { z } from "zod";
import { recent, type PollTrigger, type Run } from "./index";

type Item = { id: string; created_at?: string | null };
const DAY = () => new Date(Date.now() - 86_400_000).toISOString();
// ponytail: the newest 50 made in the last day only; more than that between two checks are missed
const list = async (action: string, field: string, run: Run, filters: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) => {
  const out = (await run(`fellow.${action}`, { pagination: { page_size: 50 }, filters: { created_at_start: DAY(), ...filters }, ...extra })) as Record<string, { data?: Item[] }>;
  return (out?.[field]?.data ?? []).filter((i) => recent(i.created_at));
};

export const fellow: Record<string, PollTrigger> = {
  new_note: {
    description: "A note was made in Fellow, such as a meeting's agenda ahead of time (checked every 5 minutes). For finished AI notes after a meeting, use ai_notes_ready.",
    config: z.object({ channel_id: z.string().optional().describe("Only notes in this Fellow channel (its id)") }),
    output: [{ name: "note", type: "object", required: true, description: "The note: id, title, created_at, event_guid, event_start, event_end, event_attendees, organizer_email, content_markdown" }],
    every: 5,
    min: 2,
    poll: async ({ channel_id }, run) =>
      (await list("list_notes", "notes", run, channel_id ? { channel_id } : {}, { include: { event_attendees: true, organizer_email: true, content_markdown: true } })).map((n) => ({ id: n.id, item: { note: n } })),
  },
  new_recording: {
    description: "A meeting recording landed in Fellow (checked every 5 minutes). AI notes come a little later: ai_notes_ready says when.",
    config: z.object({ channel_id: z.string().optional().describe("Only recordings in this Fellow channel (its id)") }),
    output: [{ name: "recording", type: "object", required: true, description: "The recording: id, title, created_at, started_at, ended_at, event_call_url, event_guid, note_id" }],
    every: 5,
    min: 2,
    poll: async ({ channel_id }, run) => (await list("list_recordings", "recordings", run, channel_id ? { channel_id } : {})).map((r) => ({ id: r.id, item: { recording: r } })),
  },
  new_action_item: {
    description: "A new action item was made in Fellow, assigned to anyone the connected person can see (checked every 5 minutes). Only the person's own? Use action_item_assigned.",
    config: z.object({ scope: z.enum(["assigned_to_me", "assigned_to_others", "all"]).optional().describe("Whose items: assigned_to_me, assigned_to_others or all (default)") }),
    output: [{ name: "action_item", type: "object", required: true, description: "The action item: id, text, created_at, due_date, note_id, assignees, ai_detected" }],
    every: 5,
    min: 2,
    poll: async ({ scope }, run) =>
      (await list("list_action_items", "action_items", run, scope ? { scope } : {}, { order_by: "created_at_desc" })).map((a) => ({ id: a.id, item: { action_item: a } })),
  },
};
