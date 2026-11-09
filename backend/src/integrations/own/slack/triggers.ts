// Slack telling us about events the moment they happen, through its Events API: one address for the whole app
// (/webhooks/app/slack/events, set in Slack's app settings), so each event names the workspace it's for. Trigger names are Composio's.
import type { ActionDetail } from "@emplio/shared";
import { createHmac, timingSafeEqual } from "node:crypto";
import type { Delivery, WebhookEvent } from "../index";

export const watchId = (team: string) => `slack:${team}`;

// our trigger → Slack's event
export const events: Record<string, string> = {
  channel_created: "channel_created",
  channel_message_received: "message",
  direct_message_received: "message",
  message_reaction_added: "reaction_added",
  message_reaction_removed: "reaction_removed",
  reaction_added: "reaction_added",
  reaction_removed: "reaction_removed",
  receive_bot_message: "message",
  receive_message: "message",
};

const field = (name: string, type: string, required: boolean, description: string) => ({ name, type, required, description });
const CHANNEL = field("channel", "string", false, "Only in this channel: its ID, like C0123ABCDEF (the action list_all_channels shows it)");
const USER = field("user", "string", false, "Only from this person: their ID, like U0123ABCDEF (the action find_users finds it)");

const MESSAGE: ActionDetail["input"] = [
  field("event", "string", true, "Always message"),
  field("team_id", "string", true, "The Slack workspace"),
  field("channel", "string", true, "The channel's ID"),
  field("channel_type", "string", true, "channel, group, im or mpim"),
  field("user", "string", false, "Who sent it: a person's ID, or a bot's for a bot message"),
  field("bot_id", "string", false, "The bot that sent it, if one did"),
  field("text", "string", true, "The message"),
  field("ts", "string", true, "The message's id, used to reply or react to it"),
  field("thread_ts", "string", false, "The thread it's in, if any"),
  field("subtype", "string", false, "bot_message, file_share, thread_broadcast or me_message"),
  field("files", "array", false, "Attached files: id, name, mimetype, size, url_private"),
];
const REACTION: ActionDetail["input"] = [
  field("event", "string", true, "reaction_added or reaction_removed"),
  field("team_id", "string", true, "The Slack workspace"),
  field("reaction", "string", true, "The emoji's name, like thumbsup"),
  field("user", "string", true, "Who reacted"),
  field("item_user", "string", false, "Who wrote the item reacted to"),
  field("channel", "string", false, "The channel, when the item is a message"),
  field("ts", "string", false, "The message's id, when the item is a message"),
  field("item_type", "string", true, "message, file or file_comment"),
];
const CREATED: ActionDetail["input"] = [
  field("event", "string", true, "Always channel_created"),
  field("team_id", "string", true, "The Slack workspace"),
  field("channel", "string", true, "The new channel's ID"),
  field("name", "string", true, "The new channel's name"),
  field("user", "string", true, "Who created it"),
  field("created", "number", true, "When, in seconds since 1970"),
];

const ONLY_WHERE_ADDED = "Emplio only sees channels it has been added to.";
const LOOP = "Messages Emplio's own bot posts are skipped, but anything it posts through the person's login or another app can start this again.";
const message = (what: string, config: ActionDetail["input"]) => ({ description: `${what} ${ONLY_WHERE_ADDED} ${LOOP}`, config, output: MESSAGE });
const reaction = (what: string) => ({ description: `${what} ${ONLY_WHERE_ADDED} Emplio's own reactions are skipped.`, config: [CHANNEL, USER], output: REACTION });

export const triggers: Record<string, { description: string; config: ActionDetail["input"]; output: ActionDetail["input"] }> = {
  channel_created: { description: "A new channel is created in Slack.", config: [USER], output: CREATED },
  channel_message_received: message("Someone posts in a Slack channel, public or private, or a group DM.", [CHANNEL, USER]),
  direct_message_received: message("Someone sends Emplio's Slack bot a direct message.", [USER]),
  receive_message: message("Someone posts anywhere Emplio can see in Slack: a channel, a group DM or a direct message.", [CHANNEL, USER]),
  receive_bot_message: message("Another app or bot posts anywhere Emplio can see in Slack.", [CHANNEL, USER]),
  message_reaction_added: reaction("Someone adds an emoji reaction in Slack."),
  message_reaction_removed: reaction("Someone removes an emoji reaction in Slack."),
  reaction_added: reaction("Someone adds an emoji reaction in Slack. The same as message_reaction_added."),
  reaction_removed: reaction("Someone removes an emoji reaction in Slack. The same as message_reaction_removed."),
};

export const wanted = (config: unknown, data: unknown) => {
  const want = (config ?? {}) as { channel?: string; user?: string };
  const got = data as { channel?: string; user?: string };
  return (!want.channel || got.channel === want.channel) && (!want.user || got.user === want.user);
};

// Slack signs v0:<timestamp>:<body>; older than this could be a replay
const MAX_AGE_S = 5 * 60;

export function signatureOk(delivery: Delivery) {
  const secret = process.env.SLACK_SIGNING_SECRET;
  const ts = String(delivery.headers["x-slack-request-timestamp"] ?? "");
  if (!secret || !/^\d+$/.test(ts) || Math.abs(Date.now() / 1000 - Number(ts)) > MAX_AGE_S) return false;
  const want = Buffer.from(`v0=${createHmac("sha256", secret).update(`v0:${ts}:${delivery.body}`).digest("hex")}`);
  const got = Buffer.from(String(delivery.headers["x-slack-signature"] ?? ""));
  return got.length === want.length && timingSafeEqual(got, want);
}

type SlackEvent = Record<string, any>;
type Envelope = { type: string; challenge?: string; event_id?: string; team_id?: string; api_app_id?: string; authorizations?: { user_id?: string; is_bot?: boolean }[]; event?: SlackEvent };

// message subtypes that are someone saying something; the rest (edits, deletes, joins, topic changes) would only restart automations
const REAL = new Set([undefined, "bot_message", "file_share", "thread_broadcast", "me_message"]);
const REACTIONS = ["message_reaction_added", "reaction_added"];
const UNREACTIONS = ["message_reaction_removed", "reaction_removed"];

const ownPost = (e: SlackEvent, body: Envelope) =>
  Boolean(body.api_app_id && (e.app_id === body.api_app_id || e.bot_profile?.app_id === body.api_app_id)) ||
  Boolean(e.user && body.authorizations?.some((a) => a.is_bot && a.user_id === e.user));

function read(e: SlackEvent, body: Envelope): { triggers: string[]; data: unknown } | null {
  const team_id = body.team_id;
  if (e.type === "channel_created") {
    const c = e.channel ?? {};
    return { triggers: ["channel_created"], data: { event: e.type, team_id, channel: c.id, name: c.name, user: c.creator, created: c.created } };
  }
  if (e.type === "reaction_added" || e.type === "reaction_removed") {
    if (ownPost(e, body)) return null;
    return {
      triggers: e.type === "reaction_added" ? REACTIONS : UNREACTIONS,
      data: { event: e.type, team_id, reaction: e.reaction, user: e.user, item_user: e.item_user, channel: e.item?.channel, ts: e.item?.ts, item_type: e.item?.type },
    };
  }
  if (e.type !== "message" || !REAL.has(e.subtype) || ownPost(e, body)) return null;
  const bot = Boolean(e.bot_id) || e.subtype === "bot_message";
  const room = ["channel", "group", "mpim"].includes(e.channel_type);
  const names = bot ? ["receive_bot_message"] : ["receive_message", ...(room ? ["channel_message_received"] : []), ...(e.channel_type === "im" ? ["direct_message_received"] : [])];
  return {
    triggers: names,
    data: {
      event: e.type,
      team_id,
      channel: e.channel,
      channel_type: e.channel_type,
      user: e.user ?? e.bot_id,
      bot_id: e.bot_id,
      text: e.text ?? "",
      ts: e.ts,
      thread_ts: e.thread_ts,
      subtype: e.subtype,
      files: e.files?.map((f: SlackEvent) => ({ id: f.id, name: f.name, mimetype: f.mimetype, size: f.size, url_private: f.url_private })),
    },
  };
}

export async function receive(delivery: Delivery) {
  if (!signatureOk(delivery)) return null;
  const body = JSON.parse(delivery.body) as Envelope;
  if (body.type === "url_verification") return { reply: { challenge: body.challenge }, events: async () => [] };
  return {
    events: async (): Promise<WebhookEvent[]> => {
      const got = body.type === "event_callback" && body.event && body.team_id ? read(body.event, body) : null;
      return got ? [{ id: body.event_id, triggers: got.triggers, data: got.data, watch: watchId(body.team_id!) }] : [];
    },
  };
}
