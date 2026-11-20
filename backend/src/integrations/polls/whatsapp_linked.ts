// WhatsApp (linked): new messages, and edits, deletes, reactions, poll votes, group members and new chats, checked every
// hour rather than the moment they happen, so nobody's WhatsApp has to stay connected around the clock. Each check
// connects the account, takes in what WhatsApp queued while it was away, and reads the last three hours
// (own/whatsapp_linked, list_recent_messages and list_events).
import { z } from "zod";
import { wanted } from "../own/whatsapp_linked";
import type { PollTrigger } from "./index";

// ponytail: the newest 500 of the last 3 hours per check; an account busier than that between checks loses the rest
const LOOK_BACK_MS = 3 * 3600_000;
const LIMIT = 500;

export const whatsapp_linked: Record<string, PollTrigger> = {
  new_message: {
    description:
      "A new message on the linked WhatsApp, in any chat, groups included. Needs a paid plan: on Pro it starts the moment the message arrives; on Starter and Growth it's checked every hour, so it can start up to an hour later. Messages sent from it, Emplio's own replies included, don't start it unless from_me is set.",
    config: z.object({
      chat: z.string().max(200).optional().describe("Only this chat: part of its name, the phone number, or its id"),
      groups: z.enum(["include", "exclude", "only"]).optional().describe("Group chats: include (the default), exclude, or only groups"),
      contains: z.string().max(200).optional().describe("Only messages containing this text"),
      from_me: z.boolean().optional().describe("Also messages sent from this WhatsApp (by the person on their phone, or by Emplio)"),
    }),
    output: [
      {
        name: "message",
        type: "object",
        required: true,
        description:
          "The message: id, chat (the chat's id, to answer with send_message), chat_name, is_group, from (their phone number), from_name, from_me, time, type (conversation, image, audio for voice notes, document, video, location, contact...), text (media as a label like [voice note] or [photo] with any caption), replying_to, has_media (fetch it with download_media).",
      },
    ],
    every: 60,
    min: 60,
    async poll(config, run) {
      const out = (await run("whatsapp_linked.list_recent_messages", { after: new Date(Date.now() - LOOK_BACK_MS).toISOString(), limit: LIMIT })) as { messages?: any[] };
      return (out.messages ?? []).filter((m) => wanted(config, m)).map((message) => ({ id: `${message.chat}:${message.id}`, item: { message } }));
    },
  },
  message_edited: happened(["edited"], "A message on the linked WhatsApp was edited", "text is the new text; message is the edited message's id"),
  message_deleted: happened(["deleted"], "A message on the linked WhatsApp was deleted for everyone", "text is what the message said before it was deleted"),
  new_reaction: happened(["reaction"], "Someone reacted to a message on the linked WhatsApp", "text is the emoji; message is the id of the message reacted to (get_message shows it)"),
  new_poll_vote: happened(["poll_vote"], "Someone voted in a poll on the linked WhatsApp", "text is the choices they picked (empty when they took their vote back); message is the poll's id"),
  group_members_changed: happened(
    ["joined", "left", "promoted", "demoted"],
    "Someone joined or left a group on the linked WhatsApp, or was made or stopped being an admin",
    'kind is joined, left, promoted or demoted; from is the person\'s phone number; text says who did it ("by +15551234567") when someone else did',
  ),
  new_chat: happened(["new_chat"], "Someone new messaged the linked WhatsApp for the first time", "from is their phone number; text is their first message, message its id"),
  added_to_group: happened(["added_to_group"], "The linked WhatsApp was added to a group", "chat is the group's id; text is its name"),
};

const EVENT_LIMIT = 500;

// A trigger for some kinds of list_events, with the usual chat, groups and from_me settings.
function happened(kinds: string[], what: string, fields: string): PollTrigger {
  return {
    description: `${what} (needs a paid plan: the moment it happens on Pro, checked every hour on Starter and Growth). What this WhatsApp did itself doesn't start it unless from_me is set.`,
    config: z.object({
      chat: z.string().max(200).optional().describe("Only this chat: part of its name, the phone number, or its id"),
      groups: z.enum(["include", "exclude", "only"]).optional().describe("Group chats: include (the default), exclude, or only groups"),
      from_me: z.boolean().optional().describe("Also what this WhatsApp did itself (on the phone, or through Emplio)"),
    }),
    output: [
      {
        name: "event",
        type: "object",
        required: true,
        description: `What happened: kind, time, chat (the chat's id), chat_name, is_group, message, from (a phone number, or "me"), from_name, from_me, text. ${fields}.`,
      },
    ],
    every: 60,
    min: 60,
    async poll(config, run) {
      const out = (await run("whatsapp_linked.list_events", { kinds, after: new Date(Date.now() - LOOK_BACK_MS).toISOString(), limit: EVENT_LIMIT })) as { events?: any[] };
      return (out.events ?? []).filter((e) => wanted(config, { ...e, text: "" })).map((event) => ({ id: `event:${event.event}`, item: { event } }));
    },
  };
}
