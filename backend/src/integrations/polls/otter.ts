// Otter's two webhook events, conversation.completed and conversation.shared. Otter only lets a workspace admin make
// webhooks in its admin pages (no API, no signature), so they're polled here instead.
import { z } from "zod";
import { recent, type PollTrigger, type Run } from "./index";

type Conversation = {
  id: string;
  created_at?: string;
  process_status?: Record<string, string | null> | null;
  [k: string]: unknown;
};
const CONVERSATION = {
  name: "conversation",
  type: "object",
  required: true,
  description:
    "The conversation: id, title, url, owner, created_at, calendar_guests, shared_emails, shared_channels, abstract_summary, conf_join_url. Action items, insights, outline and transcript come from otter.get_conversation",
};
const list = async (input: Record<string, unknown>, run: Run, pages: number) => {
  const out: Conversation[] = [];
  let cursor: string | undefined;
  for (let i = 0; i < pages; i++) {
    const got = (await run("otter.list_conversations", {
      ...input,
      limit: 20,
      cursor,
    })) as {
      data?: Conversation[];
      meta?: { has_more?: boolean; next_cursor?: string };
    };
    out.push(...(got.data ?? []));
    if (!got.meta?.has_more || !got.meta.next_cursor) break;
    cursor = got.meta.next_cursor;
  }
  return out;
};
// the summary, action items and outline Otter makes are all done (or not made for this one)
const finished = (c: Conversation) => {
  const s = Object.values(c.process_status ?? {});
  return s.includes("finished") && s.every((v) => v === null || v === "finished");
};

export const otter: Record<string, PollTrigger> = {
  conversation_completed: {
    description: "An Otter conversation (a recorded meeting) has finished processing: its summary and action items are ready (checked every 5 minutes).",
    config: z.object({
      channel_id: z.string().optional().describe("Only conversations in this channel (otter.list_channels)"),
      include_shared: z.boolean().optional().describe("Also conversations others shared with the key's owner"),
    }),
    output: [CONVERSATION],
    every: 5,
    min: 1,
    // ponytail: the newest 40 conversations; more than that finishing between two checks are missed
    poll: async (c, run) => (await list(c, run, 2)).filter((x) => recent(x.created_at) && finished(x)).map((x) => ({ id: x.id, item: { conversation: x } })),
  },
  conversation_shared: {
    description: "A conversation is shared to an Otter channel, new or old (checked every 5 minutes).",
    config: z.object({
      channel_id: z.string().min(1).describe("The channel to watch (otter.list_channels)"),
    }),
    output: [CONVERSATION],
    every: 5,
    min: 1,
    // ponytail: the channel's newest 100 conversations; an older one shared there isn't seen
    poll: async (c, run) =>
      (await list({ channel_id: c.channel_id }, run, 5)).map((x) => ({
        id: x.id,
        item: { conversation: x },
      })),
  },
};
