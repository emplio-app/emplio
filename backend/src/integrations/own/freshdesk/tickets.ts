// Tickets and everything on them: replies and notes, forwarding, merging, watchers, summaries, archived tickets,
// who may see a ticket, time spent, customer satisfaction ratings, and WhatsApp proactive messages.
import { z } from "zod";
import type { OwnAction } from "../index";
import { api, customFields, emails, files, id, page, PRIORITY, r, SOURCE, STATUS, tags, withFiles, wrapped } from "./client";
import { call } from "../openapi";

const ticketId = id("ticket", "the number shown on the ticket, e.g. 1234");
const userId = (what: string) => z.number().int().describe(`${what}: an agent's id (freshdesk.get_agents)`);

const ticketFields = {
  name: z.string().optional().describe("Requester's name (used when making a new contact)"),
  requester_id: z.number().int().optional().describe("The requester's contact id. Give this, email, phone, twitter_id, facebook_id or unique_external_id to say who asked"),
  email: z.string().optional().describe("Requester's email; a contact is made if none has it"),
  phone: z.string().optional().describe("Requester's phone; with no email, name is needed too"),
  twitter_id: z.string().optional().describe("Requester's Twitter handle"),
  facebook_id: z.string().optional().describe("Requester's Facebook id"),
  unique_external_id: z.string().optional().describe("Requester's id in your own systems"),
  subject: z.string().optional().describe("Ticket subject"),
  description: z.string().optional().describe("The ticket's first message, in HTML"),
  type: z.string().optional().describe("Ticket type, one of the choices of the type field, e.g. Question, Incident, Problem, Feature Request"),
  status: z.number().int().optional().describe(STATUS),
  priority: z.number().int().min(1).max(4).optional().describe(PRIORITY),
  source: z.number().int().optional().describe(SOURCE),
  responder_id: z.number().int().optional().describe("Agent the ticket is assigned to (freshdesk.get_agents)"),
  group_id: z.number().int().optional().describe("Group the ticket is assigned to (freshdesk.list_groups)"),
  company_id: z.number().int().optional().describe("Company the ticket belongs to (freshdesk.get_companies)"),
  product_id: z.number().int().optional().describe("Product it's about (freshdesk.list_products)"),
  email_config_id: z.number().int().optional().describe("Support email it is sent from (freshdesk.list_email_configs)"),
  due_by: z.string().optional().describe("When it must be resolved, ISO time e.g. 2026-12-01T10:00:00Z (needs fr_due_by too)"),
  fr_due_by: z.string().optional().describe("When the first reply is due, ISO time"),
  parent_id: z.number().int().optional().describe("Make this a child ticket of that ticket"),
  related_ticket_ids: z.array(z.number().int()).optional().describe("Make this a tracker ticket linking these tickets"),
  cc_emails: emails("Email addresses copied on the ticket"),
  tags,
  custom_fields: customFields,
  internal_agent_id: z.number().int().optional().describe("Internal agent (shared ownership)"),
  internal_group_id: z.number().int().optional().describe("Internal group (shared ownership)"),
  lookup_parameter: z.string().optional().describe('With a lookup custom field: "display_id" or "primary_field_value"'),
  attachments: files,
};

const listTickets = {
  filter: z.enum(["new_and_my_open", "watching", "spam", "deleted"]).optional().describe("A ready-made view"),
  requester_id: z.number().int().optional().describe("Only this contact's tickets"),
  email: z.string().optional().describe("Only tickets from this email"),
  unique_external_id: z.string().optional().describe("Only tickets from the contact with this external id"),
  company_id: z.number().int().optional().describe("Only this company's tickets"),
  updated_since: z.string().optional().describe("Only tickets changed since this ISO time. Without it, only tickets made in the last 30 days are listed"),
  order_by: z.enum(["created_at", "due_by", "updated_at", "status"]).optional().describe("Sort by (default created_at)"),
  order_type: z.enum(["asc", "desc"]).optional().describe("Sort direction (default desc)"),
  include: z.string().optional().describe('Extra details, comma separated: "requester", "stats" (when replied, resolved, closed), "description". Each costs an extra API call'),
  ...page,
};

// search: Freshdesk wants the query in double quotes
const searchTickets: OwnAction = {
  description:
    'Find tickets with a query on their fields, e.g. "priority:4 AND status:2", "tag:\'vip\'", "created_at:>\'2026-11-01\'", "agent_id:null", or custom fields like "cf_city:\'Paris\'". Up to 30 per page, 10 pages; the answer has results and total.',
  readOnly: true,
  input: z.object({
    query: z.string().min(1).describe("The query: field:value joined by AND / OR, strings in single quotes, < and > for numbers and dates. Fields: agent_id, group_id, priority, status, tag, type, due_by, fr_due_by, created_at, updated_at, closed_at, and custom fields"),
    page: z.number().int().min(1).max(10).optional().describe("Page 1-10 (default 1)"),
  }),
  run: (i: { query: string; page?: number }, key: string) =>
    call(api, key, { method: "GET", path: "/search/tickets", query: ["query", "page"], headers: [] }, { ...i, query: i.query.startsWith('"') ? i.query : `"${i.query}"` }),
};

const timeFields = {
  agent_id: z.number().int().optional().describe("Agent the time is for (default: you)"),
  billable: z.boolean().optional().describe("Billable time (default true)"),
  executed_at: z.string().optional().describe("When the work was done, ISO time"),
  note: z.string().optional().describe("What the time was spent on"),
  start_time: z.string().optional().describe("When the timer started, ISO time (only while timer_running)"),
  time_spent: z.string().optional().describe('Time spent as "hh:mm", e.g. "01:30"'),
  timer_running: z.boolean().optional().describe("Start a running timer"),
};

export const ticketActions: Record<string, OwnAction> = {
  // ── tickets
  create_ticket: withFiles("POST", "/tickets", "Open a ticket for a customer. Give who it's from (requester_id or email or phone...), status and priority; subject and description usually too.", {
    ...ticketFields,
    status: ticketFields.status.describe(`${STATUS}. Default 2`),
    priority: ticketFields.priority.describe(`${PRIORITY}. Default 1`),
  }),
  create_ticket_outbound_email: withFiles("POST", "/tickets/outbound_email", "Email a customer first: makes an outbound ticket and sends it from one of your support addresses.", {
    email: z.string().min(1).describe("Customer's email address"),
    subject: z.string().min(1).describe("Email subject"),
    email_config_id: z.number().int().describe("Support address to send from (freshdesk.list_email_configs)"),
    description: z.string().optional().describe("The email, in HTML"),
    name: ticketFields.name,
    status: ticketFields.status,
    priority: ticketFields.priority,
    type: ticketFields.type,
    group_id: ticketFields.group_id,
    cc_emails: ticketFields.cc_emails,
    due_by: ticketFields.due_by,
    fr_due_by: ticketFields.fr_due_by,
    tags,
    custom_fields: customFields,
    attachments: files,
  }),
  view_ticket: r("GET", "/tickets/{id}", "One ticket with all its fields. include adds its conversations (first 10), requester, company or stats.", {
    id: ticketId,
    include: z.string().optional().describe('Comma separated: "conversations", "requester", "company", "stats"'),
  }),
  get_tickets: r("GET", "/tickets", "List tickets, newest first. Without updated_since only those made in the last 30 days. Use freshdesk.search_tickets to find by field values.", listTickets),
  search_tickets: searchTickets,
  update_ticket: withFiles("PUT", "/tickets/{id}", "Change a ticket: status, priority, who it's assigned to, type, tags, custom fields... Fields left out stay as they are. Closing or resolving may need the required fields filled.", {
    id: ticketId,
    ...ticketFields,
  }),
  delete_ticket: r("DELETE", "/tickets/{id}", "Move a ticket to trash (freshdesk.restore_ticket brings it back).", { id: ticketId }),
  restore_ticket: r("PUT", "/tickets/{id}/restore", "Bring a deleted ticket back from trash.", { id: ticketId }),
  bulk_update_tickets: wrapped("POST", "/tickets/bulk_update", "Change many tickets at once in the background (answers a job id; freshdesk.get_job tracks it).", "bulk_action", {
    ids: z.array(z.number().int()).min(1).describe("Ticket ids"),
    properties: z.record(z.string(), z.any()).optional().describe('Fields to set on all of them, e.g. {"status": 4, "group_id": 12, "priority": 3, "type": "Question", "tags": ["x"], "custom_fields": {...}}'),
    reply: z.object({ body: z.string(), from_email: z.string().optional() }).loose().optional().describe('A reply sent on each, e.g. {"body": "We have fixed this"}'),
  }),
  delete_multiple_tickets: wrapped("POST", "/tickets/bulk_delete", "Delete many tickets at once in the background (answers a job id).", "bulk_action", {
    ids: z.array(z.number().int()).min(1).describe("Ticket ids"),
  }),
  merge_tickets: r("PUT", "/tickets/merge", "Merge duplicate tickets into one primary ticket; the others are closed with a note.", {
    primary_id: z.number().int().describe("Ticket that stays"),
    ticket_ids: z.array(z.number().int()).min(1).describe("Tickets merged into it"),
    convert_recepients_to_cc: z.boolean().optional().describe("Copy the other tickets' requesters on the primary one"),
    note_in_primary: z.object({ body: z.string(), private: z.boolean().optional() }).optional().describe("Note added to the primary ticket"),
    note_in_secondary: z.object({ body: z.string(), private: z.boolean().optional() }).optional().describe("Note added to each merged ticket"),
  }, { loose: true }),
  get_associated_tickets: r("GET", "/tickets/{id}/associated_tickets", "Tickets linked to this one (parent/child or tracker/related).", { id: ticketId }),
  get_prime_association: r("GET", "/tickets/{id}/prime_association", "The parent or tracker ticket of a child or related ticket.", { id: ticketId }),
  delete_attachment: r("DELETE", "/attachments/{id}", "Remove a file attached to a ticket, reply or note.", { id: id("attachment", "attachments[].id on the ticket or conversation") }),

  // ── replies, notes and forwards
  list_all_ticket_conversations: r("GET", "/tickets/{id}/conversations", "Every reply and note on a ticket, oldest first (body, who wrote it, private or public, attachments).", { id: ticketId, ...page }),
  reply_to_ticket: withFiles("POST", "/tickets/{id}/reply", "Send a reply to the customer on a ticket; it is emailed to them.", {
    id: ticketId,
    body: z.string().min(1).describe("The reply, in HTML"),
    from_email: z.string().optional().describe("Support address to send from"),
    user_id: z.number().int().optional().describe("Agent the reply is from (default: you)"),
    cc_emails: emails("Copy to these addresses"),
    bcc_emails: emails("Blind copy to these addresses"),
    attachments: files,
  }),
  add_note_to_ticket: withFiles("POST", "/tickets/{id}/notes", "Add a note to a ticket. Private by default (agents only); private: false lets the customer see it.", {
    id: ticketId,
    body: z.string().min(1).describe("The note, in HTML"),
    private: z.boolean().optional().describe("false makes it public (default true)"),
    incoming: z.boolean().optional().describe("Show it as coming from outside (default false)"),
    notify_emails: emails("Agent emails to tell about the note"),
    user_id: z.number().int().optional().describe("Agent or contact the note is from"),
    attachments: files,
  }),
  update_conversation: withFiles("PUT", "/conversations/{id}", "Edit a note's text or attachments (replies can't be edited).", {
    id: id("conversation", "freshdesk.list_all_ticket_conversations"),
    body: z.string().optional().describe("New text, in HTML"),
    attachments: files,
  }),
  delete_conversation: r("DELETE", "/conversations/{id}", "Delete a reply or note from a ticket.", { id: id("conversation", "freshdesk.list_all_ticket_conversations") }),
  forward_ticket: r("POST", "/tickets/{id}/forward", "Forward a ticket to someone outside by email.", {
    id: ticketId,
    to_emails: z.array(z.string()).min(1).describe("Addresses to forward to"),
    body: z.string().optional().describe("Message on top, in HTML"),
    cc_emails: emails("Copy to"),
    bcc_emails: emails("Blind copy to"),
    from_email: z.string().optional().describe("Support address to send from"),
    agent_id: z.number().int().optional().describe("Agent it is forwarded as"),
    include_quoted_text: z.boolean().optional().describe("Include the ticket's text (default true)"),
    include_original_attachments: z.boolean().optional().describe("Include the ticket's files (default true)"),
  }, { loose: true }),
  reply_to_forward_ticket: r("POST", "/tickets/{id}/reply_to_forward", "Reply on a forwarded thread (to the people it was forwarded to).", {
    id: ticketId,
    body: z.string().min(1).describe("The reply, in HTML"),
    to_emails: z.array(z.string()).min(1).describe("Recipients"),
    cc_emails: emails("Copy to"),
    bcc_emails: emails("Blind copy to"),
    from_email: z.string().optional().describe("Support address to send from"),
    user_id: z.number().int().optional().describe("Agent sending it"),
  }, { loose: true }),

  // ── watchers
  list_tickets_watchers: r("GET", "/tickets/{id}/watchers", "Agents following a ticket (they get emails on its changes).", { id: ticketId }),
  add_watcher: r("POST", "/tickets/{id}/watch", "Make an agent follow a ticket.", { id: ticketId, user_id: userId("Who watches") }),
  remove_watcher: r("PUT", "/tickets/{id}/unwatch", "Stop following a ticket yourself.", { id: ticketId }),
  update_ticket_bulk_watch: r("PUT", "/tickets/bulk_watch", "Make an agent follow several tickets.", {
    ids: z.array(z.number().int()).min(1).describe("Ticket ids"),
    user_id: userId("Who watches; default you").optional(),
  }),
  bulk_unwatch_tickets: r("PUT", "/tickets/bulk_unwatch", "Stop following several tickets yourself.", { ids: z.array(z.number().int()).min(1).describe("Ticket ids") }),

  // ── summary (a section under the description other teams read)
  view_ticket_summary: r("GET", "/tickets/{id}/summary", "A ticket's summary: the progress note shown under its description.", { id: ticketId }),
  update_ticket_summary: withFiles("PUT", "/tickets/{id}/summary", "Write or replace a ticket's summary.", {
    id: ticketId,
    body: z.string().min(1).describe("The summary, in HTML"),
    user_id: z.number().int().optional().describe("Agent writing it"),
    attachments: files,
  }),
  delete_ticket_summary: r("DELETE", "/tickets/{id}/summary", "Remove a ticket's summary.", { id: ticketId }),

  // ── archived tickets (old closed tickets Freshdesk moved away)
  view_archived_ticket: r("GET", "/tickets/archived/{id}", "One archived ticket.", { id: ticketId, include: z.string().optional().describe('"stats", "requester", "company" (comma separated)') }),
  delete_archived_ticket: r("DELETE", "/tickets/archived/{id}", "Delete an archived ticket for good.", { id: ticketId }),
  list_archived_ticket_conversations: r("GET", "/tickets/archived/{id}/conversations", "Replies and notes of an archived ticket.", { id: ticketId, ...page }),

  // ── who may see a ticket
  get_ticket_user_access: r("GET", "/tickets/{id}/accesses", "Agents given extra access to a ticket.", { id: ticketId }),
  add_ticket_user_access: r("POST", "/tickets/{id}/accesses", "Give agents access to a ticket they couldn't otherwise see.", { id: ticketId, user_ids: z.array(z.number().int()).min(1).describe("Agent ids") }),
  update_ticket_user_access: r("PATCH", "/tickets/{id}/accesses", "Replace the agents with extra access to a ticket.", { id: ticketId, user_ids: z.array(z.number().int()).describe("Agent ids") }),
  delete_ticket_user_access: r("DELETE", "/tickets/{id}/accesses", "Take away all extra agent access to a ticket.", { id: ticketId }),

  // ── time tracking
  get_ticket_time_entries: r("GET", "/tickets/{id}/time_entries", "Time logged on one ticket.", { id: ticketId }),
  create_ticket_time_entry: r("POST", "/tickets/{id}/time_entries", "Log time spent on a ticket, or start a timer.", { id: ticketId, ...timeFields }),
  list_time_entries: r("GET", "/time_entries", "Time logged across tickets, with filters.", {
    company_id: z.number().int().optional().describe("Only this company's tickets"),
    agent_id: z.number().int().optional().describe("Only this agent's time"),
    executed_after: z.string().optional().describe("Only work done after this ISO time"),
    executed_before: z.string().optional().describe("Only work done before this ISO time"),
    billable: z.boolean().optional().describe("Only billable (true) or non-billable (false) time"),
    ...page,
  }),
  update_time_entry: r("PUT", "/time_entries/{id}", "Change a time entry. Fields left out stay.", { id: id("time entry"), ...timeFields }),
  toggle_timer: r("PUT", "/time_entries/{id}/toggle_timer", "Start or stop a time entry's timer.", { id: id("time entry") }),
  delete_time_entry: r("DELETE", "/time_entries/{id}", "Delete a time entry.", { id: id("time entry") }),

  // ── customer satisfaction (legacy surveys, accounts made before December 2025)
  list_surveys: r("GET", "/surveys", "Satisfaction surveys and their questions (older accounts).", { state: z.enum(["active"]).optional().describe("Only the active survey"), ...page }),
  list_satisfaction_ratings: r("GET", "/surveys/satisfaction_ratings", "Customers' satisfaction ratings across tickets (older accounts).", {
    created_since: z.string().optional().describe("Only ratings since this ISO time (default: last 30 days)"),
    user_id: z.number().int().optional().describe("Only ratings given by this contact"),
    ...page,
  }),
  list_ticket_satisfaction_ratings: r("GET", "/tickets/{id}/satisfaction_ratings", "Satisfaction ratings on one ticket.", { id: ticketId }),
  create_satisfaction_rating: r("POST", "/tickets/{id}/satisfaction_ratings", "Record a customer's satisfaction rating on a ticket (older accounts).", {
    id: ticketId,
    ratings: z.record(z.string(), z.number().int()).describe('Answer per question, e.g. {"default_question": 103}. 103 Extremely happy, 102 Very happy, 101 Happy, 100 Neutral, -101 Unhappy, -102 Very unhappy, -103 Extremely unhappy'),
    feedback: z.string().optional().describe("The customer's comment"),
  }),
  // ── customer satisfaction (accounts made from December 2025)
  list_csat_surveys: r("GET", "/customer-satisfaction/surveys", "Satisfaction surveys and their questions (accounts made from December 2025).", {
    state: z.string().optional().describe("e.g. active"),
    per_page: z.number().int().optional().describe("How many per page"),
    next_token: z.string().optional().describe("From paging in the last answer, for the next page"),
  }),
  list_survey_responses: r("GET", "/customer-satisfaction/surveys/{survey_id}/responses", "Customers' answers to a satisfaction survey (accounts made from December 2025).", {
    survey_id: z.string().min(1).describe("Survey id (freshdesk.list_csat_surveys)"),
    created_since: z.string().optional().describe("Only answers since this ISO time"),
    status: z.string().optional().describe("Answer status filter"),
    per_page: z.number().int().optional().describe("How many per page"),
    next_token: z.string().optional().describe("From paging in the last answer, for the next page"),
  }),
  create_survey_response: r("POST", "/customer-satisfaction/surveys/{survey_id}/responses", "Record a customer's answers to a satisfaction survey for a ticket (accounts made from December 2025).", {
    survey_id: z.string().min(1).describe("Survey id (freshdesk.list_csat_surveys)"),
    ticket_id: z.number().int().describe("The ticket rated"),
    answers: z.array(z.object({ question_id: z.string(), value: z.any() })).min(1).describe('Answers, e.g. [{"question_id": "q1", "value": 5}]'),
  }),

  // ── WhatsApp proactive messages
  send_outbound_message: r("POST", "/channels/outbound-messages", "Send a WhatsApp template message to a customer who opted in (order updates, reminders). Can open a ticket for their reply.", {
    from: z.object({ channel_identifier: z.string() }).describe('Your WhatsApp number, e.g. {"channel_identifier": "+15550001111"}'),
    to: z.object({ recipient_identifier: z.string() }).describe('Customer\'s number, e.g. {"recipient_identifier": "+15552223333"}'),
    channel_type: z.string().describe('"whatsapp"'),
    message: z.record(z.string(), z.any()).describe('{"type": "template", "template": {"name": "order_update", "language": {"code": "en"}, "components": [...]}}'),
    external_reference_id: z.string().optional().describe("Your own reference"),
    note_policy: z.record(z.string(), z.any()).optional().describe("Whether the message is added as a note on a ticket when they reply"),
    ticket_properties: z.record(z.string(), z.any()).optional().describe("Fields for the ticket made when they reply (status, priority, group_id...)"),
  }, { loose: true }),
  get_outbound_message: r("GET", "/channels/outbound-messages/{message_id}", "Whether a WhatsApp proactive message was delivered.", { message_id: z.string().min(1).describe("Id from freshdesk.send_outbound_message") }),
};
