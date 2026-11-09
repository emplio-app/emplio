import { z } from "zod";
import type { PollTrigger } from "./index";

// ponytail: the newest 200 messages each check; more than 200 new between checks would miss some
export const zoho_mail: Record<string, PollTrigger> = {
  new_message: {
    description: "A new email arrives (checked every 5 minutes by default). Limit it to a folder or a sender so it wakes only for what matters.",
    config: z.object({
      accountId: z.string().optional().describe("Which mailbox, when the login has several (its accountId)"),
      folderId: z.string().optional().describe("Only this folder (its id, from zoho_mail.folders_list_folders)"),
      sender: z.string().optional().describe("Only emails whose sender contains this, e.g. orders@acme.com or acme.com"),
    }),
    output: [{ name: "message", type: "object", required: true, description: "The email: messageId, folderId, fromAddress, sender, toAddress, subject, summary, receivedTime, hasAttachment" }],
    every: 5,
    min: 2,
    async poll({ sender, ...rest }, run) {
      const out = (await run("zoho_mail.messages_list_emails", { ...rest, limit: 200, sortBy: "date", sortorder: false })) as { data?: any[] };
      const who = sender?.toLowerCase();
      return (out.data ?? [])
        .filter((m) => !who || `${m.fromAddress ?? ""} ${m.sender ?? ""}`.toLowerCase().includes(who))
        .map((message) => ({ id: String(message.messageId), item: { message } }));
    },
  },
};
