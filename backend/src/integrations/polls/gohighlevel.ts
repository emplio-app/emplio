// HighLevel's events, polled: its webhooks only reach Marketplace (OAuth) apps, and Emplio signs in with a private
// integration token. Each check asks for the newest items and keeps those from the last day.
import { z } from "zod";
import { recent, type PollTrigger, type Run } from "./index";

// HighLevel gives some times as ISO text and some as milliseconds
const when = (t: unknown) => (typeof t === "number" ? new Date(t).toISOString() : t);
const fresh = (t: unknown) => recent(when(t));
const DAY = 86_400_000;
const isoDay = (ms: number) => new Date(ms).toISOString();

type Out = { name: string; type: string; required: boolean; description: string };
const out = (name: string, description: string): Out[] => [{ name, type: "object", required: true, description }];
const trigger = (description: string, config: z.ZodObject, output: Out[], poll: PollTrigger["poll"]): PollTrigger => ({ description, config, output, every: 5, min: 1, poll });

// ponytail: the newest 100 of each list per check; more than 100 changes between two checks would miss some
const contacts = async (run: Run, field: "dateAdded" | "dateUpdated", tag?: string) =>
  ((await run("gohighlevel.search_contacts", {
    pageLimit: 100,
    sort: [{ field, direction: "desc" }],
    ...(tag && { filters: [{ field: "tags", operator: "contains", value: tag }] }),
  })) as { contacts?: any[] }).contacts ?? [];

// HighLevel sorts opportunities only by when they were added or by name, so a stage or status change is looked for
// among the newest `pages` hundred.
// ponytail: changes to deals older than the newest 500 are missed; a pipeline_id narrows the list when that bites
async function opportunities(run: Run, c: { pipeline_id?: string; stage_id?: string }, pages = 1) {
  const all: any[] = [];
  for (let page = 1; page <= pages; page++) {
    const out = (await run("gohighlevel.search_opportunities", {
      limit: 100,
      page,
      order: "added_desc",
      status: "all",
      ...(c.pipeline_id && { pipelineId: c.pipeline_id }),
      ...(c.stage_id && { pipelineStageId: c.stage_id }),
    })) as { opportunities?: any[]; meta?: { nextPage?: number | null } };
    all.push(...(out.opportunities ?? []));
    if (!out.meta?.nextPage) break;
  }
  return all;
}

// appointments: HighLevel lists them per calendar, so every calendar unless one is named
async function events(run: Run, calendar_id?: string) {
  const ids = calendar_id ? [calendar_id] : (((await run("gohighlevel.get_calendars", {})) as { calendars?: { id: string }[] }).calendars ?? []).map((c) => c.id);
  const now = Date.now();
  const lists = await Promise.all(
    ids.map(async (calendarId) => ((await run("gohighlevel.get_calendar_events", { calendarId, startTime: String(now - 30 * DAY), endTime: String(now + 365 * DAY) })) as { events?: any[] }).events ?? []),
  );
  return lists.flat();
}

const submissions = async (run: Run, action: string, filter: Record<string, string | undefined>) =>
  ((await run(`gohighlevel.${action}`, { limit: 100, startAt: isoDay(Date.now() - DAY).slice(0, 10), ...Object.fromEntries(Object.entries(filter).filter(([, v]) => v)) })) as { submissions?: any[] }).submissions ?? [];

const payments = async (run: Run, action: string) => ((await run(`gohighlevel.${action}`, { limit: 100, offset: 0, startAt: isoDay(Date.now() - DAY) })) as { data?: any[] }).data ?? [];

const invoices = async (run: Run, status?: string) =>
  ((await run("gohighlevel.list_invoices", { limit: "100", offset: "0", sortOrder: "descend", ...(status && { status }) })) as { invoices?: any[] }).invoices ?? [];

const pipeline = z.object({
  pipeline_id: z.string().optional().describe("Only opportunities in this pipeline (get_pipelines lists them)"),
  stage_id: z.string().optional().describe("Only opportunities in this stage of the pipeline"),
});
const OPP = "The opportunity: id, name, monetaryValue, pipelineId, pipelineStageId, status, source, assignedTo, contact, createdAt, lastStageChangeAt";

export const gohighlevel: Record<string, PollTrigger> = {
  new_contact: trigger(
    "A contact is added in HighLevel (a lead from a form, a call, an import or by hand). Optionally only contacts with a tag.",
    z.object({ tag: z.string().optional().describe('Only contacts with this tag, e.g. "new lead"') }),
    out("contact", "The contact: id, firstName, lastName, email, phone, tags, source, dateAdded, customFields"),
    async ({ tag }, run) => (await contacts(run, "dateAdded", tag)).filter((c) => fresh(c.dateAdded)).map((contact) => ({ id: String(contact.id), item: { contact } })),
  ),
  contact_updated: trigger(
    "A contact is changed in HighLevel (details, tags, assigned user). Not for newly added contacts. Optionally only contacts with a tag. If the automation itself edits the contact, that edit starts it again.",
    z.object({ tag: z.string().optional().describe("Only contacts with this tag") }),
    out("contact", "The contact as it is now: id, firstName, lastName, email, phone, tags, dateAdded, dateUpdated"),
    async ({ tag }, run) =>
      (await contacts(run, "dateUpdated", tag))
        .filter((c) => fresh(c.dateUpdated) && c.dateUpdated !== c.dateAdded)
        .map((contact) => ({ id: `${contact.id}:${contact.dateUpdated}`, item: { contact } })),
  ),
  contact_tag_added: trigger(
    "A contact gets a certain tag in HighLevel, the usual way HighLevel starts follow-ups.",
    z.object({ tag: z.string().describe('The tag, e.g. "hot lead"') }),
    out("contact", "The contact that has the tag now: id, firstName, lastName, email, phone, tags"),
    async ({ tag }, run) =>
      (await contacts(run, "dateUpdated", tag))
        .filter((c) => fresh(c.dateUpdated) && c.tags?.some((t: string) => t.toLowerCase() === tag.toLowerCase()))
        .map((contact) => ({ id: `${contact.id}:${tag.toLowerCase()}`, item: { contact } })),
  ),
  new_opportunity: trigger(
    "An opportunity (deal) is added to a HighLevel pipeline. Optionally only in one pipeline or stage.",
    pipeline,
    out("opportunity", OPP),
    async (c, run) => (await opportunities(run, c)).filter((o) => fresh(o.createdAt)).map((opportunity) => ({ id: String(opportunity.id), item: { opportunity } })),
  ),
  opportunity_stage_changed: trigger(
    "An opportunity moves to another stage of its HighLevel pipeline. Optionally only moves into one stage (stage_id) or within one pipeline.",
    pipeline,
    out("opportunity", `${OPP}. pipelineStageId is the stage it moved to`),
    async (c, run) =>
      (await opportunities(run, c, 5))
        .filter((o) => fresh(o.lastStageChangeAt) && o.lastStageChangeAt !== o.createdAt)
        .map((opportunity) => ({ id: `${opportunity.id}:${opportunity.pipelineStageId}:${opportunity.lastStageChangeAt}`, item: { opportunity } })),
  ),
  opportunity_status_changed: trigger(
    "An opportunity is marked won, lost, abandoned or open again in HighLevel. Optionally only one status.",
    pipeline.extend({ status: z.enum(["open", "won", "lost", "abandoned"]).optional().describe("Only changes to this status") }),
    out("opportunity", `${OPP}, lastStatusChangeAt`),
    async (c, run) =>
      (await opportunities(run, c, 5))
        .filter((o) => fresh(o.lastStatusChangeAt) && o.lastStatusChangeAt !== o.createdAt && (!c.status || o.status === c.status))
        .map((opportunity) => ({ id: `${opportunity.id}:${opportunity.status}:${opportunity.lastStatusChangeAt}`, item: { opportunity } })),
  ),
  new_appointment: trigger(
    "An appointment is booked on a HighLevel calendar. Optionally only one calendar.",
    z.object({ calendar_id: z.string().optional().describe("Only this calendar (get_calendars lists them)") }),
    out("appointment", "The appointment: id, title, calendarId, contactId, appointmentStatus, assignedUserId, startTime, endTime, address, notes, dateAdded"),
    async ({ calendar_id }, run) => (await events(run, calendar_id)).filter((e) => fresh(e.dateAdded)).map((appointment) => ({ id: String(appointment.id), item: { appointment } })),
  ),
  appointment_updated: trigger(
    "A HighLevel appointment is rescheduled, confirmed, cancelled or marked showed or no-show. Optionally only one calendar or one status.",
    z.object({
      calendar_id: z.string().optional().describe("Only this calendar"),
      status: z.enum(["new", "confirmed", "cancelled", "showed", "noshow", "invalid"]).optional().describe("Only appointments now in this status"),
    }),
    out("appointment", "The appointment as it is now: id, title, calendarId, contactId, appointmentStatus, startTime, endTime, dateUpdated"),
    async ({ calendar_id, status }, run) =>
      (await events(run, calendar_id))
        .filter((e) => fresh(e.dateUpdated) && e.dateUpdated !== e.dateAdded && (!status || e.appointmentStatus === status))
        .map((appointment) => ({ id: `${appointment.id}:${appointment.appointmentStatus}:${appointment.startTime}`, item: { appointment } })),
  ),
  new_inbound_message: trigger(
    "A customer sends a message to the HighLevel sub-account: SMS, email, WhatsApp, Facebook, Instagram, live chat or a call. Several messages between two checks come as one, with the latest. Optionally only one channel.",
    z.object({
      channel: z.string().optional().describe("Only this kind, as HighLevel names it: TYPE_SMS, TYPE_EMAIL, TYPE_WHATSAPP, TYPE_FACEBOOK, TYPE_INSTAGRAM, TYPE_WEBCHAT, TYPE_CALL…"),
    }),
    out("conversation", "The conversation: id, contactId, fullName, email, phone, lastMessageBody (the message), lastMessageType, lastMessageDate, unreadCount"),
    async ({ channel }, run) =>
      ((((await run("gohighlevel.search_conversations", { lastMessageDirection: "inbound", sortBy: "last_message_date", sort: "desc", limit: 100, ...(channel && { lastMessageType: channel }) })) as { conversations?: any[] }).conversations) ?? [])
        .filter((c) => fresh(c.lastMessageDate))
        .map((conversation) => ({ id: `${conversation.id}:${conversation.lastMessageDate}`, item: { conversation } })),
  ),
  form_submission: trigger(
    "Someone fills in a HighLevel form. Optionally only one form.",
    z.object({ form_id: z.string().optional().describe("Only this form (get_forms lists them)") }),
    out("submission", "The submission: id, formId, contactId, name, email, createdAt, and the answers in others"),
    async ({ form_id }, run) => (await submissions(run, "get_forms_submissions", { formId: form_id })).filter((s) => fresh(s.createdAt)).map((submission) => ({ id: String(submission.id), item: { submission } })),
  ),
  survey_submission: trigger(
    "Someone completes a HighLevel survey. Optionally only one survey.",
    z.object({ survey_id: z.string().optional().describe("Only this survey (get_surveys lists them)") }),
    out("submission", "The submission: id, surveyId, contactId, name, email, createdAt, and the answers in others"),
    async ({ survey_id }, run) => (await submissions(run, "get_surveys_submissions", { surveyId: survey_id })).filter((s) => fresh(s.createdAt)).map((submission) => ({ id: String(submission.id), item: { submission } })),
  ),
  new_invoice: trigger(
    "An invoice is created in HighLevel.",
    z.object({}),
    out("invoice", "The invoice: _id, invoiceNumber, name, status, total, amountDue, currency, contactDetails, dueDate, createdAt"),
    async (_c, run) => (await invoices(run)).filter((i) => fresh(i.createdAt)).map((invoice) => ({ id: String(invoice._id), item: { invoice } })),
  ),
  invoice_paid: trigger(
    "A HighLevel invoice is paid in full.",
    z.object({}),
    out("invoice", "The paid invoice: _id, invoiceNumber, name, total, amountPaid, currency, contactDetails, updatedAt"),
    async (_c, run) => (await invoices(run, "paid")).filter((i) => fresh(i.updatedAt)).map((invoice) => ({ id: String(invoice._id), item: { invoice } })),
  ),
  new_order: trigger(
    "An order is placed through a HighLevel funnel, website or store.",
    z.object({}),
    out("order", "The order: _id, contactName, contactEmail, amount, currency, status, sourceName, items, createdAt"),
    async (_c, run) => (await payments(run, "list_orders")).filter((o) => fresh(o.createdAt)).map((order) => ({ id: String(order._id), item: { order } })),
  ),
  new_payment: trigger(
    "A payment comes in through HighLevel (an order, invoice or subscription charge).",
    z.object({}),
    out("payment", "The transaction: _id, contactName, contactEmail, amount, currency, status, entitySourceName, paymentProviderType, createdAt"),
    async (_c, run) => (await payments(run, "list_transactions")).filter((t) => fresh(t.createdAt)).map((payment) => ({ id: String(payment._id), item: { payment } })),
  ),
  new_subscription: trigger(
    "A customer starts a subscription through HighLevel.",
    z.object({}),
    out("subscription", "The subscription: _id, contactName, contactEmail, amount, currency, status, entitySourceName, createdAt"),
    async (_c, run) => (await payments(run, "list_subscriptions")).filter((s) => fresh(s.createdAt)).map((subscription) => ({ id: String(subscription._id), item: { subscription } })),
  ),
  new_task: trigger(
    "A task is added in HighLevel. Optionally only tasks for one user.",
    z.object({ assigned_to: z.string().optional().describe("Only tasks assigned to this user id") }),
    out("task", "The task: id, title, body, contactId, assignedTo, dueDate, completed, dateAdded"),
    async ({ assigned_to }, run) =>
      ((((await run("gohighlevel.task_search", { limit: 100, completed: false, ...(assigned_to && { assignedTo: [assigned_to] }) })) as { tasks?: any[] }).tasks) ?? [])
        .filter((t) => fresh(t.dateAdded ?? t.createdAt))
        .map((task) => ({ id: String(task.id ?? task._id), item: { task } })),
  ),
  task_completed: trigger(
    "A HighLevel task is marked done. Optionally only tasks for one user.",
    z.object({ assigned_to: z.string().optional().describe("Only tasks assigned to this user id") }),
    out("task", "The task: id, title, body, contactId, assignedTo, dueDate, completed"),
    async ({ assigned_to }, run) =>
      ((((await run("gohighlevel.task_search", { limit: 100, completed: true, ...(assigned_to && { assignedTo: [assigned_to] }) })) as { tasks?: any[] }).tasks) ?? [])
        .filter((t) => fresh(t.dateUpdated ?? t.updatedAt))
        .map((task) => ({ id: String(task.id ?? task._id), item: { task } })),
  ),
};
