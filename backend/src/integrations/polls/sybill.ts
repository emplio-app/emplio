// Sybill's webhooks are set up only in its dashboard (Settings → Integrations → Webhooks), never through the API, so
// these compare its lists every few minutes instead.
import { z } from "zod";
import { recent, type PollTrigger, type Run } from "./index";

type Page<K extends string, T> = { [k in K]?: T[] } & { pagination?: { nextCursor?: string | null } };
type Conversation = { conversationId: string; startTime?: string };
type Deal = { dealId: string; stage?: string | null; createdDate?: string | null };
type Account = { accountId: string; createdDate?: string | null };
type Message = { messageId: string; createdAt?: string };

const dayAgo = () => new Date(Date.now() - 86_400_000).toISOString();
const given = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== ""));

// every page of a list, up to `pages` of 50
async function all<T>(run: Run, action: string, field: string, input: Record<string, unknown>, pages = 4) {
  const out: T[] = [];
  let cursor: string | undefined;
  for (let i = 0; i < pages; i++) {
    const page = (await run(`sybill.${action}`, given({ ...input, limit: 50, cursor }))) as Page<string, T>;
    out.push(...((page[field] as T[]) ?? []));
    cursor = page.pagination?.nextCursor ?? undefined;
    if (!cursor) break;
  }
  return out;
}

const field = (name: string, description: string) => ({ name, type: "object", required: true, description });

export const sybill: Record<string, PollTrigger> = {
  new_conversation: {
    description: "A call or meeting was recorded and processed in Sybill (checked every 10 minutes). get_conversation has its summary and transcript.",
    config: z.object({
      title: z.string().optional().describe("Only meetings whose title contains this"),
      attendees: z.string().optional().describe("Only meetings with this attendee: part of a name, a full email, or a company domain like @northwind.com"),
      type: z.string().optional().describe("Only this kind of meeting: EXTERNAL (with customers) or INTERNAL"),
    }),
    output: [field("conversation", "The meeting: conversationId, title, startTime, endTime, type, participants, crm (matched deal and account)")],
    every: 10,
    min: 5,
    poll: async (c, run) =>
      (await all<Conversation>(run, "list_conversations", "conversations", { startedAfter: dayAgo(), title: c.title, attendees: c.attendees, type: c.type })).map((x) => ({
        id: x.conversationId,
        item: { conversation: x },
      })),
  },
  new_deal: {
    description: "A deal appeared in Sybill from the connected CRM (checked every 15 minutes).",
    config: z.object({ owner: z.string().optional().describe("Only deals this person owns (their name or email)") }),
    output: [field("deal", "The deal: dealId, name, accountName, stage, pipeline, amount, closeDate, closed, createdDate, owner")],
    every: 15,
    min: 5,
    // ponytail: Sybill can't list deals by creation date, so new deals are found among those active in the last day
    poll: async (c, run) =>
      (await all<Deal>(run, "list_deals", "deals", { lastActivityAfter: dayAgo(), owner: c.owner })).filter((d) => recent(d.createdDate)).map((d) => ({ id: d.dealId, item: { deal: d } })),
  },
  deal_stage_changed: {
    description: "A deal in Sybill moved to another stage, like Discovery to Negotiation (checked every 15 minutes).",
    config: z.object({
      stage: z.string().optional().describe("Only deals moving into this stage (its name as your CRM shows it)"),
      owner: z.string().optional().describe("Only deals this person owns (their name or email)"),
    }),
    output: [field("deal", "The deal as it is now: dealId, name, accountName, stage (the new one), pipeline, amount, closeDate, closed, owner")],
    every: 15,
    min: 5,
    // ponytail: deals active in the last week, at most 200; a stage change on a deal quiet for longer is missed
    poll: async (c, run) =>
      (await all<Deal>(run, "list_deals", "deals", { lastActivityAfter: new Date(Date.now() - 7 * 86_400_000).toISOString(), owner: c.owner }))
        .filter((d) => !c.stage || d.stage?.toLowerCase() === String(c.stage).toLowerCase())
        .map((d) => ({ id: `${d.dealId}:${d.stage ?? ""}`, item: { deal: d } })),
  },
  new_account: {
    description: "A company (account) appeared in Sybill from the connected CRM (checked every 15 minutes).",
    config: z.object({ owner: z.string().optional().describe("Only accounts this person owns (their name or email)") }),
    output: [field("account", "The account: accountId, name, website, owner, createdDate, lastActivityDate, latestDeal")],
    every: 15,
    min: 5,
    poll: async (c, run) => (await all<Account>(run, "list_accounts", "accounts", { createdAfter: dayAgo(), owner: c.owner })).map((a) => ({ id: a.accountId, item: { account: a } })),
  },
  new_message: {
    description: "A new email or message reached Sybill (checked every 10 minutes).",
    config: z.object({ participant_email: z.string().optional().describe("Only messages this email address sent or received") }),
    output: [field("message", "The message: messageId, subject, sender, recipients, bodyPreview, threadId, createdAt")],
    every: 10,
    min: 5,
    poll: async (c, run) =>
      (await all<Message>(run, "list_messages", "messages", { createdAfter: dayAgo(), participantEmail: c.participant_email })).map((m) => ({ id: m.messageId, item: { message: m } })),
  },
};
