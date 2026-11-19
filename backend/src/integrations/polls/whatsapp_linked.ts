// WhatsApp (linked): new messages, checked every hour rather than the moment they arrive, so nobody's WhatsApp has to
// stay connected around the clock. Each check connects the account, takes in what WhatsApp queued while it was away,
// and reads what came in over the last three hours (own/whatsapp_linked, list_recent_messages).
import { z } from "zod";
import { wanted } from "../own/whatsapp_linked";
import type { PollTrigger } from "./index";

// ponytail: the newest 500 of the last 3 hours per check; an account busier than that between checks loses the rest
const LOOK_BACK_MS = 3 * 3600_000;
const LIMIT = 500;

export const whatsapp_linked: Record<string, PollTrigger> = {
  new_message: {
    description:
      "A new message on the linked WhatsApp, in any chat, groups included (checked every hour by default, so it can start up to an hour after the message). Messages sent from it, Emplio's own replies included, don't start it unless from_me is set.",
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
};
