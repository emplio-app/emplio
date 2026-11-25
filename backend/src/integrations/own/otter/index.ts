// Otter.ai on a workspace's own API key (Enterprise only): conversations with their summaries, action items,
// insights, outlines, transcripts and audio; channels and their members; the workspace and its usage; importing a
// recording from a link. Otter publishes no OpenAPI spec, so the calls are listed by hand from its Public API and
// Super Admin API articles (help.otter.ai). Otter's webhooks are made in its admin pages, not by API, so triggers
// are polled (polls/otter.ts). COVERAGE.md says what's where.
import { z } from "zod";
import type { OwnApp } from "../index";
import { type Api, call, rest } from "../openapi";

export const api: Api = {
  name: "Otter",
  base: "https://api.otter.ai/v1",
  tokenHelp: "otter.ai/setting/developer",
};

const id = (what: string, from: string) => z.string().min(1).describe(`The ${what}'s id; ${from} lists them`);
const page = {
  limit: z.number().int().min(1).max(20).optional().describe("How many to return, 1 to 20 (default 20)"),
  cursor: z.string().optional().describe("meta.next_cursor from the previous page, for the next one; keep going while meta.has_more is true"),
};
const INCLUDE = ["action_items", "insights", "outline", "transcript", "all"] as const;

const actions = {
  // ── conversations
  list_conversations: rest(
    api,
    "GET",
    "/conversations",
    "The key owner's conversations (recorded meetings), newest first: title, link, owner, when, guests, who it's shared with, and the AI summary. Add include_shared for ones shared with them, or channel_id for one channel's.",
    z.object({
      include_shared: z.boolean().optional().describe("Also conversations others shared with the key's owner (default false)"),
      channel_id: z.string().optional().describe("Only conversations in this channel (list_channels); includes shared ones"),
      ...page,
    }),
  ),
  get_conversation: {
    ...rest(
      api,
      "GET",
      "/conversations/{id}",
      "One conversation with its AI summary, plus what you ask for in include: action items (with assignee and done or not), insights (topics such as budget, decisions, risks), outline (sections), transcript (speaker, time and text), or all.",
      z.object({
        id: id("conversation", "list_conversations"),
        include: z
          .array(z.enum(INCLUDE))
          .min(1)
          .default(["action_items", "insights", "outline"])
          .describe("What to add: action_items, insights, outline, transcript (long), or all"),
      }),
    ),
    // Otter wants include comma separated, not repeated
    run: (i: Record<string, unknown>, key: string) =>
      call(
        api,
        key,
        {
          method: "GET",
          path: "/conversations/{id}",
          query: ["include"],
          csv: ["include"],
          headers: [],
        },
        i,
      ),
  },
  get_conversation_audio: rest(
    api,
    "GET",
    "/conversations/{id}/audio",
    "A download link for a conversation's audio, as MP3. Download it on the computer with curl -L -o <file> '<url>'.",
    z.object({ id: id("conversation", "list_conversations") }),
  ),
  import_recording: rest(
    api,
    "POST",
    "/conversations",
    "Have Otter transcribe a recording from a link (a call from a phone system, a meeting recorded elsewhere). It becomes a new conversation.",
    z.object({
      file: z.string().url().describe("A link Otter can download the audio or video from, e.g. https://example.com/call.mp4"),
      name: z.string().optional().describe("The conversation's title"),
    }),
  ),

  // ── channels
  list_channels: rest(
    api,
    "GET",
    "/channels",
    "Channels (shared folders of conversations) the key's owner can see, A to Z: name, owner, member count, private or workspace-wide.",
    z.object({}),
  ),
  list_channel_members: rest(
    api,
    "GET",
    "/channels/{id}/members",
    "Who is in a channel, A to Z: name and email.",
    z.object({ id: id("channel", "list_channels") }),
  ),

  // ── workspace
  get_workspace: rest(api, "GET", "/workspace", "The Otter workspace: id, name, owner, member count, handle and type.", z.object({})),
  get_workspace_analytics: rest(
    api,
    "GET",
    "/workspace/{id}/analytics",
    "Workspace usage over a period (workspace admins only): minutes transcribed, conversations, seats used and paid for, and per member: conversations, minutes, AI chats, shares, views, last login. Leave both dates out for the last 30 days.",
    z.object({
      id: z.string().min(1).describe("The workspace's id; get_workspace gives it"),
      start_date: z.string().optional().describe("First day, yyyy-mm-dd, e.g. 2026-09-01"),
      end_date: z.string().optional().describe("Last day, yyyy-mm-dd; only with start_date (default today)"),
      timezone: z.string().optional().describe("Time zone the dates are in, e.g. Europe/London (default the workspace's)"),
    }),
  ),
  list_workspace_conversations: rest(
    api,
    "GET",
    "/workspace/{id}/conversations",
    "Every conversation in the workspace, newest first, whoever owns it (Super Admins only; others are refused).",
    z.object({
      id: z.string().min(1).describe("The workspace's id; get_workspace gives it"),
      ...page,
    }),
  ),
};

export const otter: OwnApp = {
  app: "otter",
  name: "Otter.ai",
  logo: "/logos/otter.png",
  keyField: {
    label: "API key",
    help: "Needs an Otter Enterprise workspace. In Otter: Settings → Integrations → Developer (otter.ai/setting/developer) → Create key → Copy (it's shown only once). If Developer isn't there, ask your Otter account manager to turn on the API.",
    placeholder: "Your Otter API key",
  },
  async check(key) {
    const out = (await call(api, key, { method: "GET", path: "/workspace", query: [], headers: [] }, {})) as { data?: { name?: string } };
    return out.data?.name;
  },
  actions,
};
