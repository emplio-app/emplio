// Read AI has no webhooks it can be told about through its API (they're set up by hand in Read AI's settings), so a
// finished meeting is noticed by checking its newest meetings (the MCP server's list_meetings tool).
// ponytail: the newest page only (about 10 meetings); more than that ending between two checks are missed
import { z } from "zod";
import type { PollTrigger, Run } from "./index";

type Meeting = { id?: string; end_time_ms?: number | null; summary?: unknown; transcript?: unknown; [k: string]: unknown };

// The tool answers in text: JSON with the meetings in data (as the REST API does), or under meetings, or a bare list
export function meetingsIn(answer: unknown): Meeting[] {
  let v: any = answer;
  if (typeof v === "string") {
    try {
      v = JSON.parse(v);
    } catch {
      return [];
    }
  }
  const list = Array.isArray(v) ? v : (v?.data ?? v?.meetings ?? v?.items);
  return Array.isArray(list) ? list.filter((m): m is Meeting => !!m && typeof m === "object" && typeof (m as Meeting).id === "string") : [];
}

const DAY = 86_400_000;

export const readai: Record<string, PollTrigger> = {
  meeting_ended: {
    description:
      "A meeting Read AI took notes in has ended and its report is ready: title, times, participants, summary, action items, key questions and topics (checked every 10 minutes). The transcript is left out to keep it short: get_meeting_by_id with its id has it.",
    config: z.object({}),
    output: [
      { name: "meeting", type: "object", required: true, description: "The meeting: id, title, start_time_ms, end_time_ms, participants (name, email, attended), owner, report_url, platform, folders, and its report (summary, action_items, key_questions, topics, chapter_summaries, metrics) as Read AI gives it" },
    ],
    every: 10,
    min: 5,
    poll: async (_c, run: Run) =>
      meetingsIn(await run("readai.list_meetings", {}))
        // ended in the last day, with its summary written when the answer has a place for one
        .filter((m) => typeof m.end_time_ms === "number" && Date.now() - m.end_time_ms < DAY && (!("summary" in m) || !!m.summary))
        .map(({ transcript: _t, ...m }) => ({ id: m.id!, item: { meeting: m } })),
  },
};
