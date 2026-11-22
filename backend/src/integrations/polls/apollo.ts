// Apollo.io has no webhooks to subscribe to, so everything that can start an automation is polled here: new and changed
// contacts, accounts and deals, deals moving stage or closing, tasks added and done, calls, recorded meetings, notes, and
// replies to and bounces of outreach emails. Each poll is one call through the person's connection and spends no credits.
import { z } from "zod";
import { recent, type PollTrigger, type Run } from "./index";

type Row = Record<string, any>;
const day = (daysAgo: number) => new Date(Date.now() - daysAgo * 86_400_000).toISOString().slice(0, 10);
// some lists don't say when a row last changed: then what it holds now marks the change
const version = (row: Row) => row.updated_at ?? Bun.hash(JSON.stringify(row)).toString(36);
const list = (out: unknown, key: string) => ((out as Row | null)?.[key] ?? []) as Row[];

// ponytail: the newest page only (100 rows); a burst bigger than that between polls is missed
const trigger = (
  description: string,
  field: string,
  what: string,
  poll: (c: any, run: Run) => Promise<{ id: string; row: Row }[]>,
  config: z.ZodObject = z.object({}),
): PollTrigger => ({
  description,
  config,
  output: [{ name: field, type: "object", required: true, description: what }],
  every: 5,
  min: 1,
  poll: async (c, run) => (await poll(c, run)).map(({ id, row }) => ({ id, item: { [field]: row } })),
});

const CONTACT = "The Apollo contact: id, name, title, email, phone_numbers, organization_name, account_id, contact_stage_id, owner_id, label_ids, created_at, updated_at";
const ACCOUNT = "The Apollo account (a company saved in Apollo): id, name, domain, phone, account_stage_id, owner_id, label_ids, created_at";
const DEAL = "The Apollo deal: id, name, amount, account_id, owner_id, opportunity_stage_id, opportunity_pipeline_id, is_closed, is_won, closed_date, stage_updated_at, created_at";
const TASK = "The Apollo task: id, type, priority, status, due_at, note, contact_id, account_id, opportunity_id, user_id, created_at, completed_at";
const contactConfig = z.object({
  contact_stage_id: z.string().optional().describe("Only contacts in this contact stage (its id; list_contact_stages lists them)"),
  label_id: z.string().optional().describe("Only contacts on this list (its id; get_labels lists them)"),
});
const accountConfig = z.object({
  account_stage_id: z.string().optional().describe("Only accounts in this account stage (its id; list_account_stages lists them)"),
  label_id: z.string().optional().describe("Only accounts on this list (its id; get_labels lists them)"),
});
const dealConfig = z.object({
  pipeline_id: z.string().optional().describe("Only deals in this pipeline (its id; get_opportunity_stages shows each stage's pipeline)"),
  stage_id: z.string().optional().describe("Only deals in this stage (its id; get_opportunity_stages lists them)"),
  owner_id: z.string().optional().describe("Only deals owned by this Apollo user (their id; list_users lists them)"),
});

const contacts = async (c: Row, run: Run, sort: string) =>
  list(
    await run("apollo.search_contacts", {
      sort_by_field: sort,
      per_page: 100,
      ...(c.contact_stage_id && { contact_stage_ids: [c.contact_stage_id] }),
      ...(c.label_id && { contact_label_ids: [c.label_id] }),
    }),
    "contacts",
  );
const accounts = async (c: Row, run: Run, sort: string) =>
  list(
    await run("apollo.search_accounts", {
      sort_by_field: sort,
      per_page: 100,
      ...(c.account_stage_id && { account_stage_ids: [c.account_stage_id] }),
      ...(c.label_id && { account_label_ids: [c.label_id] }),
    }),
    "accounts",
  );
const deals = async (c: Row, run: Run, extra: Row) =>
  list(
    await run("apollo.list_deals", {
      per_page: 100,
      ...(c.pipeline_id && { "opportunity_pipeline_ids[]": [c.pipeline_id] }),
      ...(c.stage_id && { "opportunity_stage_ids[]": [c.stage_id] }),
      ...(c.owner_id && { "opportunity_owner_ids[]": [c.owner_id] }),
      ...extra,
    }),
    "opportunities",
  );
// closed just now, not an old closed deal edited today
const closedNow = (r: Row) => recent(r.stage_updated_at) || recent(r.actual_close_date);
const tasks = async (run: Run) => list(await run("apollo.search_tasks", { per_page: 100 }), "tasks");
// what Apollo's reply sorting calls each kind of answer
const REPLIES = ["willing_to_meet", "follow_up_question", "person_referral", "out_of_office", "already_left_company_or_not_right_person", "not_interested", "unsubscribe", "none_of_the_above"];
const emails = async (run: Run, input: Row) =>
  list(
    await run("apollo.search_outreach_emails", {
      per_page: 100,
      emailer_message_date_range_mode: "completed_at",
      "emailer_message_date_range[min]": day(30),
      ...input,
    }),
    "emailer_messages",
  );
const sequence = z.string().optional().describe("Only emails in this sequence (its id; search_sequences lists them)");

export const apollo: Record<string, PollTrigger> = {
  new_contact: trigger(
    "A contact is added in Apollo, by hand, from a search, by import or by a teammate (checked every 5 minutes).",
    "contact",
    CONTACT,
    async (c, run) => (await contacts(c, run, "contact_created_at")).filter((r) => recent(r.created_at)).map((row) => ({ id: String(row.id), row })),
    contactConfig,
  ),
  contact_updated: trigger(
    "A contact changes in Apollo: details, stage, owner, lists (checked every 5 minutes). A run that changes the same contact starts this again, so say in the prompt when to stop.",
    "contact",
    CONTACT,
    async (c, run) => (await contacts(c, run, "contact_updated_at")).filter((r) => !r.updated_at || recent(r.updated_at)).map((row) => ({ id: `${row.id}:${version(row)}`, row })),
    contactConfig,
  ),
  new_account: trigger(
    "An account (a company) is added in Apollo (checked every 5 minutes).",
    "account",
    ACCOUNT,
    async (c, run) => (await accounts(c, run, "account_created_at")).filter((r) => recent(r.created_at)).map((row) => ({ id: String(row.id), row })),
    accountConfig,
  ),
  account_updated: trigger(
    "An account (a company) changes in Apollo (checked every 5 minutes). A run that changes the same account starts this again, so say in the prompt when to stop.",
    "account",
    ACCOUNT,
    // ponytail: without updated_at on accounts, only the 25 most recently changed are compared
    async (c, run) =>
      (await accounts(c, run, "account_updated_at"))
        .filter((r, i) => (r.updated_at ? recent(r.updated_at) : i < 25))
        .map((row) => ({ id: `${row.id}:${version(row)}`, row })),
    accountConfig,
  ),
  new_deal: trigger(
    "A deal is added in Apollo (checked every 5 minutes).",
    "deal",
    DEAL,
    async (c, run) => (await deals(c, run, { sort_by_field: "opportunity_created_at" })).filter((r) => recent(r.created_at)).map((row) => ({ id: String(row.id), row })),
    dealConfig,
  ),
  deal_updated: trigger(
    "A deal changes in Apollo: amount, stage, close date, owner... (checked every 5 minutes). A run that changes the same deal starts this again, so say in the prompt when to stop.",
    "deal",
    DEAL,
    async (c, run) =>
      (await deals(c, run, { sort_by_field: "opportunity_updated_at", "opportunity_updated_at[min]": day(1) })).map((row) => ({ id: `${row.id}:${version(row)}`, row })),
    dealConfig,
  ),
  deal_stage_changed: trigger(
    "A deal moves to another stage in Apollo (checked every 5 minutes). Use stage_id to act only when deals reach one stage.",
    "deal",
    DEAL,
    async (c, run) =>
      (await deals(c, run, { sort_by_field: "opportunity_updated_at", "opportunity_updated_at[min]": day(1) }))
        .filter((r) => recent(r.stage_updated_at))
        .map((row) => ({ id: `${row.id}:${row.opportunity_stage_id}:${row.stage_updated_at}`, row })),
    dealConfig,
  ),
  deal_won: trigger(
    "A deal is marked won in Apollo (checked every 5 minutes).",
    "deal",
    DEAL,
    async (c, run) =>
      (await deals(c, run, { sort_by_field: "opportunity_updated_at", "opportunity_updated_at[min]": day(1), opportunity_is_closed: true }))
        .filter((r) => r.is_closed && r.is_won && closedNow(r))
        .map((row) => ({ id: `${row.id}:won`, row })),
    dealConfig,
  ),
  deal_lost: trigger(
    "A deal is closed as lost in Apollo (checked every 5 minutes).",
    "deal",
    DEAL,
    async (c, run) =>
      (await deals(c, run, { sort_by_field: "opportunity_updated_at", "opportunity_updated_at[min]": day(1), opportunity_is_closed: true }))
        .filter((r) => r.is_closed && !r.is_won && closedNow(r))
        .map((row) => ({ id: `${row.id}:lost`, row })),
    dealConfig,
  ),
  // ponytail: Apollo's task search can't sort by creation, so this reads the first 100 tasks it gives back
  new_task: trigger(
    "A task (call, email, action item...) is added in Apollo, by a person or a sequence (checked every 5 minutes).",
    "task",
    TASK,
    async (_c, run) => (await tasks(run)).filter((r) => recent(r.created_at)).map((row) => ({ id: String(row.id), row })),
  ),
  task_completed: trigger(
    "A task is marked done in Apollo (checked every 5 minutes).",
    "task",
    TASK,
    async (_c, run) => (await tasks(run)).filter((r) => recent(r.completed_at)).map((row) => ({ id: `${row.id}:done`, row })),
  ),
  new_call: trigger(
    "A call is made or received with Apollo's dialer, or logged in Apollo (checked every 5 minutes).",
    "call",
    "The call: id, user_id, contact_id, account_id, start_time, end_time, duration, inbound, status, phone_call_outcome_id, note, recording_url",
    async (c, run) =>
      list(await run("apollo.search_calls", { "date_range[min]": day(1), per_page: 100, ...(c.direction && { inbound: c.direction }) }), "phone_calls").map((row) => ({
        id: String(row.id),
        row,
      })),
    z.object({ direction: z.enum(["incoming", "outgoing"]).optional().describe("Only incoming calls (the prospect called) or only outgoing ones") }),
  ),
  new_conversation: trigger(
    "A meeting or call is recorded in Apollo Conversations (checked every 5 minutes). get_conversation gets its summary and transcript.",
    "conversation",
    "The recorded conversation: id, topic, start_time, duration, state, host, participant_names, account_names, deals",
    async (c, run) =>
      list(
        await run("apollo.search_conversations", {
          num_fetch_result: 100,
          date_range: { start: `${day(1)}T00:00:00Z` },
          ...(c.conversation_type && { conversation_type: c.conversation_type }),
        }),
        "conversations",
      ).map((row) => ({ id: String(row.id), row })),
    z.object({ conversation_type: z.enum(["video_conference", "phone_call"]).optional().describe("Only video meetings, or only dialer calls") }),
  ),
  new_note: trigger(
    "A note is added in Apollo, on a contact, account, deal or meeting (checked every 5 minutes).",
    "note",
    "The note: id, content, user_id, contact_id, account_id, opportunity_id, conversation_id, created_at",
    async (_c, run) =>
      list(await run("apollo.list_notes", { sort_by_field: "created_at", sort_direction: "desc", limit: 100 }), "notes")
        .filter((r) => recent(r.created_at))
        .map((row) => ({ id: String(row.id), row })),
  ),
  email_replied: trigger(
    "Someone replies to an outreach email sent from Apollo, in a sequence or one by one (checked every 5 minutes). reply_class says how Apollo read the reply, like willing_to_meet or not_interested.",
    "email",
    "The email that was replied to: id, contact_id, to_name, to_email, subject, emailer_campaign_id (sequence), reply_class, completed_at (when it was sent). get_email_content gets the text.",
    async (c, run) =>
      (await emails(run, { "emailer_message_reply_classes[]": c.reply_class ? [c.reply_class] : REPLIES, ...(c.sequence_id && { "emailer_campaign_ids[]": [c.sequence_id] }) })).map(
        (row) => ({ id: `${row.id}:replied`, row }),
      ),
    z.object({
      reply_class: z.enum(REPLIES as [string, ...string[]]).optional().describe("Only replies Apollo sorted this way, like willing_to_meet"),
      sequence_id: sequence,
    }),
  ),
  email_bounced: trigger(
    "An outreach email sent from Apollo bounces (checked every 5 minutes).",
    "email",
    "The bounced email: id, contact_id, to_name, to_email, subject, emailer_campaign_id (sequence), bounce, completed_at",
    async (c, run) =>
      (await emails(run, { "emailer_message_stats[]": ["bounced"], "emailer_message_date_range[min]": day(3), ...(c.sequence_id && { "emailer_campaign_ids[]": [c.sequence_id] }) })).map(
        (row) => ({ id: `${row.id}:bounced`, row }),
      ),
    z.object({ sequence_id: sequence }),
  ),
};
