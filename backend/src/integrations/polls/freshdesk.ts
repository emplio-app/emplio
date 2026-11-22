// Freshdesk's webhooks are only made by hand in its automation rules (no API for them), so its events are polled:
// tickets, contacts and companies changed in the last day, compared with what was seen last time.
import { z } from "zod";
import { recent, type PollTrigger, type Run } from "./index";

const DAY = 86_400_000;
const since = () => new Date(Date.now() - DAY).toISOString();
const ticketConfig = {
  group_id: z.number().int().optional().describe("Only tickets in this group"),
  priority: z.array(z.number().int()).optional().describe("Only these priorities: 1 Low, 2 Medium, 3 High, 4 Urgent"),
  type: z.string().optional().describe("Only tickets of this type, e.g. Incident"),
};
const ticketOutput = [{ name: "ticket", type: "object", required: true, description: "The Freshdesk ticket: id, subject, description_text, status (2 Open, 3 Pending, 4 Resolved, 5 Closed), priority, type, requester (name, email), responder_id, group_id, tags, custom_fields, created_at, updated_at" }];
const matches = (t: any, c: { group_id?: number; priority?: number[]; type?: string }) =>
  (!c.group_id || t.group_id === c.group_id) && (!c.priority?.length || c.priority.includes(t.priority)) && (!c.type || t.type === c.type);

// ponytail: the first 100 tickets changed in the last day; on a desk busier than that between polls, the rest are missed
const tickets = async (run: Run, order_by: string, include: string, updated = true) =>
  ((await run("freshdesk.get_tickets", { ...(updated && { updated_since: since() }), order_by, order_type: "desc", per_page: 100, include })) as any[]) ?? [];

const newTicket: PollTrigger = {
  description: "A ticket comes in on Freshdesk (checked every 5 minutes by default). Optionally only one group, type or some priorities.",
  config: z.object(ticketConfig),
  output: ticketOutput,
  every: 5,
  min: 1,
  async poll(c, run) {
    return (await tickets(run, "created_at", "requester,description", false))
      .filter((t) => recent(t.created_at) && matches(t, c))
      .map((ticket) => ({ id: String(ticket.id), item: { ticket } }));
  },
};

const ticketUpdated: PollTrigger = {
  description: "A Freshdesk ticket is changed: a field, its status, an assignment, a reply or note. Optionally only one group, type or some priorities. A run that changes the ticket starts this again.",
  config: z.object(ticketConfig),
  output: ticketOutput,
  every: 5,
  min: 1,
  async poll(c, run) {
    return (await tickets(run, "updated_at", "requester"))
      .filter((t) => recent(t.updated_at) && t.updated_at !== t.created_at && matches(t, c))
      .map((ticket) => ({ id: `${ticket.id}:${ticket.updated_at}`, item: { ticket } }));
  },
};

const statusChanged: PollTrigger = {
  description: "A Freshdesk ticket's status changes (e.g. to Resolved). Optionally only to some statuses, or one group, type or priorities.",
  config: z.object({ ...ticketConfig, status: z.array(z.number().int()).optional().describe("Only when the new status is one of these: 2 Open, 3 Pending, 4 Resolved, 5 Closed, or your own status numbers") }),
  output: ticketOutput,
  every: 5,
  min: 1,
  async poll(c, run) {
    return (await tickets(run, "updated_at", "requester,stats"))
      .filter((t) => recent(t.stats?.status_updated_at) && t.stats.status_updated_at !== t.created_at && matches(t, c) && (!c.status?.length || c.status.includes(t.status)))
      .map((ticket) => ({ id: `${ticket.id}:${ticket.status}:${ticket.stats.status_updated_at}`, item: { ticket } }));
  },
};

const newReply: PollTrigger = {
  description: "Someone replies on a Freshdesk ticket: the customer (default), an agent, or either. Private notes don't count. Brings the ticket and its latest messages. A reply Emplio sends counts as an agent reply.",
  config: z.object({ ...ticketConfig, from: z.enum(["customer", "agent", "any"]).optional().describe("Whose replies: customer (default), agent or any") }),
  output: [...ticketOutput, { name: "conversations", type: "object[]", required: false, description: "The ticket's latest replies and notes (body_text, incoming, private, user_id, created_at), newest last; left out when many tickets changed at once" }],
  every: 5,
  min: 1,
  async poll(c, run) {
    const from = c.from ?? "customer";
    const at = (t: any) => [from !== "agent" && t.stats?.requester_responded_at, from !== "customer" && t.stats?.agent_responded_at].filter(recent).sort().at(-1) as string | undefined;
    const replied = (await tickets(run, "updated_at", "requester,stats")).filter((t) => at(t) && matches(t, c));
    // ponytail: messages fetched only for replies from the last 30 minutes, at most 10 tickets a poll; older ones come without them
    let fetches = 10;
    return Promise.all(
      replied.map(async (ticket) => {
        const when = at(ticket)!;
        const fresh = Date.now() - Date.parse(when) < 1_800_000 && fetches-- > 0;
        const conversations = fresh ? ((await run("freshdesk.list_all_ticket_conversations", { id: ticket.id, per_page: 100 })) as any[]).slice(-5) : undefined;
        return { id: `${ticket.id}:${when}`, item: { ticket, ...(conversations && { conversations }) } };
      }),
    );
  },
};

const listed = (description: string, field: string, action: string, out: string): PollTrigger => ({
  description,
  config: z.object({}),
  output: [{ name: field, type: "object", required: true, description: out }],
  every: 5,
  min: 1,
  // ponytail: first 100 changed in the last day
  poll: async (_c, run) =>
    (((await run(action, { updated_since: since(), per_page: 100 })) as any[]) ?? []).filter((x) => recent(x.created_at)).map((x) => ({ id: String(x.id), item: { [field]: x } })),
});

export const freshdesk: Record<string, PollTrigger> = {
  new_ticket: newTicket,
  ticket_updated: ticketUpdated,
  ticket_status_changed: statusChanged,
  new_reply: newReply,
  new_contact: listed("A contact (customer) is added in Freshdesk.", "contact", "freshdesk.get_contacts", "The Freshdesk contact: id, name, email, phone, company_id, tags, custom_fields, created_at"),
  new_company: listed("A company is added in Freshdesk.", "company", "freshdesk.get_companies", "The Freshdesk company: id, name, domains, description, custom_fields, created_at"),
  new_satisfaction_rating: {
    description: "A customer rates a Freshdesk ticket in the satisfaction survey (accounts made before December 2025).",
    config: z.object({ unhappy_only: z.boolean().optional().describe("Only ratings below neutral") }),
    output: [{ name: "rating", type: "object", required: true, description: "The rating: ticket_id, user_id, agent_id, group_id, feedback, ratings (103 extremely happy … -103 extremely unhappy), created_at" }],
    every: 15,
    min: 5,
    async poll(c, run) {
      const rows = ((await run("freshdesk.list_satisfaction_ratings", { created_since: since(), per_page: 100 })) as any[]) ?? [];
      return rows
        .filter((x) => !c.unhappy_only || Object.values(x.ratings ?? {}).some((v) => Number(v) < 100))
        .map((rating) => ({ id: String(rating.id), item: { rating } }));
    },
  },
};
