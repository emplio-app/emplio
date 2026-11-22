// Zendesk telling us about events the moment they happen, through its event webhooks. One webhook per connection, at
// /webhooks/app/zendesk/<connection>/<token>, subscribed to the events its automations want; each automation's
// settings pick what it wants. Only a Zendesk admin's login can set up webhooks. Each request is checked twice: the
// URL's token, and Zendesk's signature with the webhook's signing secret (fetched once, then kept in memory).
import { createHmac, timingSafeEqual } from "node:crypto";
import type { ActionDetail } from "@emplio/shared";
import { AppsError } from "../../types";
import type { Delivery, WebhookEvent } from "../index";
import { type Api, call, type Send } from "../openapi";

const ADMIN = "Needs a Zendesk admin's login, since only admins can set up Zendesk webhooks.";

// Zendesk's event type (after zen:event-type:) → what it means. The trigger is its name with _ for the dot.
const EVENTS: Record<string, string> = {
  "ticket.created": "A new Zendesk ticket is created.",
  "ticket.comment_added": "A reply or internal note is added to a Zendesk ticket. A run that replies on the same ticket starts this again, so say in the prompt when not to reply.",
  "ticket.status_changed": "A Zendesk ticket's status changes (new, open, pending, on-hold, solved, closed).",
  "ticket.custom_status_changed": "A Zendesk ticket's custom status changes.",
  "ticket.priority_changed": "A Zendesk ticket's priority changes.",
  "ticket.agent_assignment_changed": "A Zendesk ticket is assigned to a different agent.",
  "ticket.group_assignment_changed": "A Zendesk ticket is assigned to a different group.",
  "ticket.tags_changed": "Tags are added to or removed from a Zendesk ticket.",
  "ticket.subject_changed": "A Zendesk ticket's subject changes.",
  "ticket.description_changed": "A Zendesk ticket's description changes.",
  "ticket.type_changed": "A Zendesk ticket's type changes (question, incident, problem, task).",
  "ticket.requester_changed": "A Zendesk ticket's requester changes.",
  "ticket.submitter_changed": "A Zendesk ticket's submitter changes.",
  "ticket.organization_changed": "A Zendesk ticket moves to a different organization.",
  "ticket.brand_changed": "A Zendesk ticket moves to a different brand.",
  "ticket.form_changed": "A Zendesk ticket's form changes.",
  "ticket.custom_field_changed": "A custom field on a Zendesk ticket changes.",
  "ticket.external_id_changed": "A Zendesk ticket's external id changes.",
  "ticket.email_ccs_changed": "People are CC'd on, or taken off, a Zendesk ticket.",
  "ticket.followers_changed": "Followers are added to or removed from a Zendesk ticket.",
  "ticket.problem_link_changed": "A Zendesk incident ticket is linked to, or unlinked from, a problem ticket.",
  "ticket.task_due_at_changed": "A Zendesk task ticket's due date changes.",
  "ticket.sla_policy_changed": "The SLA policy on a Zendesk ticket changes.",
  "ticket.ola_policy_changed": "The OLA (internal service target) on a Zendesk ticket changes.",
  "ticket.next_sla_breach_changed": "The time a Zendesk ticket will next miss its SLA changes.",
  "ticket.schedule_changed": "The business-hours schedule on a Zendesk ticket changes.",
  "ticket.comment_made_private": "A public reply on a Zendesk ticket is turned into an internal note.",
  "ticket.comment_redacted": "Words are redacted from a comment on a Zendesk ticket.",
  "ticket.attachment_linked_to_comment": "A file is attached to a comment on a Zendesk ticket.",
  "ticket.attachment_redacted_from_comment": "A file is redacted from a comment on a Zendesk ticket.",
  "ticket.marked_as_spam": "A Zendesk ticket is marked as spam.",
  "ticket.merged": "A Zendesk ticket is merged into another.",
  "ticket.soft_deleted": "A Zendesk ticket is deleted (it can still be restored for 30 days).",
  "ticket.permanently_deleted": "A Zendesk ticket is deleted for good.",
  "ticket.undeleted": "A deleted Zendesk ticket is restored.",
  "ticket.csat_requested": "A customer is asked to rate the help they got on a Zendesk ticket.",
  "ticket.csat_received": "A customer rates the help they got on a Zendesk ticket.",
  "user.created": "A new person is added in Zendesk: a customer or a team member.",
  "user.deleted": "A person is deleted in Zendesk.",
  "user.merged": "Two people in Zendesk are merged into one.",
  "user.name_changed": "A person's name changes in Zendesk.",
  "user.alias_changed": "A team member's alias (the name customers see) changes in Zendesk.",
  "user.details_changed": "A person's details field changes in Zendesk.",
  "user.notes_changed": "The notes on a person change in Zendesk.",
  "user.external_id_changed": "A person's external id changes in Zendesk.",
  "user.custom_field_changed": "A custom field on a person changes in Zendesk.",
  "user.tags_changed": "Tags are added to or removed from a person in Zendesk.",
  "user.time_zone_changed": "A person's time zone changes in Zendesk.",
  "user.photo_changed": "A person's photo changes in Zendesk.",
  "user.role_changed": "A person's role changes in Zendesk (end user, agent, admin).",
  "user.custom_role_changed": "A team member's custom role changes in Zendesk.",
  "user.default_group_changed": "A team member's default group changes in Zendesk.",
  "user.only_private_comments_changed": "Whether a team member may only write internal notes changes in Zendesk.",
  "user.active_changed": "A person is made active or inactive in Zendesk.",
  "user.suspended_changed": "A person is suspended or unsuspended in Zendesk.",
  "user.last_login_changed": "A person signs in to Zendesk.",
  "user.password_changed": "A person's Zendesk password changes.",
  "user.identity_created": "A person gets a new email, phone or other identity in Zendesk.",
  "user.identity_changed": "One of a person's emails, phones or other identities changes in Zendesk.",
  "user.identity_deleted": "One of a person's emails, phones or other identities is removed in Zendesk.",
  "user.group_membership_created": "A team member is added to a group in Zendesk.",
  "user.group_membership_deleted": "A team member is removed from a group in Zendesk.",
  "user.organization_membership_created": "A person is added to an organization in Zendesk.",
  "user.organization_membership_deleted": "A person is removed from an organization in Zendesk.",
  "organization.created": "A new organization (a customer company) is added in Zendesk.",
  "organization.deleted": "An organization is deleted in Zendesk.",
  "organization.name_changed": "An organization's name changes in Zendesk.",
  "organization.external_id_changed": "An organization's external id changes in Zendesk.",
  "organization.custom_field_changed": "A custom field on an organization changes in Zendesk.",
  "organization.tags_changed": "Tags are added to or removed from an organization in Zendesk.",
  "article.published": "A help center article is published in Zendesk.",
  "article.unpublished": "A help center article is unpublished in Zendesk.",
  "article.author_changed": "A help center article's author changes in Zendesk.",
  "article.subscription_created": "Someone follows a help center article in Zendesk.",
  "article.vote_created": "Someone votes on a help center article in Zendesk.",
  "article.vote_changed": "Someone changes their vote on a help center article in Zendesk.",
  "article.vote_removed": "Someone takes back their vote on a help center article in Zendesk.",
  "article.comment_created": "Someone comments on a help center article in Zendesk.",
  "article.comment_changed": "A comment on a help center article is edited in Zendesk.",
  "article.comment_published": "A comment on a help center article is published in Zendesk.",
  "article.comment_unpublished": "A comment on a help center article is unpublished in Zendesk.",
  "community_post.created": "Someone writes a new community post in Zendesk.",
  "community_post.changed": "A community post is edited in Zendesk.",
  "community_post.published": "A community post is published in Zendesk.",
  "community_post.unpublished": "A community post is unpublished in Zendesk.",
  "community_post.subscription_created": "Someone follows a community post in Zendesk.",
  "community_post.vote_created": "Someone votes on a community post in Zendesk.",
  "community_post.vote_changed": "Someone changes their vote on a community post in Zendesk.",
  "community_post.vote_removed": "Someone takes back their vote on a community post in Zendesk.",
  "community_post.comment_created": "Someone comments on a community post in Zendesk.",
  "community_post.comment_changed": "A comment on a community post is edited in Zendesk.",
  "community_post.comment_published": "A comment on a community post is published in Zendesk.",
  "community_post.comment_unpublished": "A comment on a community post is unpublished in Zendesk.",
  "community_post.comment_vote_created": "Someone votes on a comment on a community post in Zendesk.",
  "community_post.comment_vote_changed": "Someone changes their vote on a comment on a community post in Zendesk.",
  "agent.state_changed": "A team member's availability changes in Zendesk (online, away, offline).",
  "agent.unified_state_changed": "A team member's overall availability across channels changes in Zendesk.",
  "agent.work_item_added": "A ticket, call or chat is routed to a team member in Zendesk.",
  "agent.work_item_updated": "A ticket, call or chat routed to a team member changes in Zendesk.",
  "agent.work_item_removed": "A ticket, call or chat is taken off a team member's plate in Zendesk.",
  "agent.max_capacity_changed": "How much work a team member can take at once changes in Zendesk.",
  "agent.channel_created": "A team member gets a new channel (email, messaging, calls) in Zendesk.",
  "agent.channel_deleted": "A team member loses a channel in Zendesk.",
  "agent.groups_updated": "A team member's groups change in Zendesk.",
};

const OUTPUT: ActionDetail["input"] = [
  { name: "type", type: "string", required: true, description: "Zendesk's name for what happened, like zen:event-type:ticket.created" },
  { name: "time", type: "string", required: true, description: "When it happened" },
  { name: "subject", type: "string", required: true, description: "What it's about, like zen:ticket:123 or zen:user:456" },
  { name: "detail", type: "object", required: true, description: "The ticket, person, organization, article or post as it is now: id, subject, status, priority, assignee_id, group_id, tags…" },
  { name: "event", type: "object", required: false, description: "What changed: previous and current values, or the comment that was added" },
];
const TICKET: ActionDetail["input"] = [
  { name: "status", type: "string", required: false, description: "Only tickets with this status now, like open or solved" },
  { name: "group_id", type: "string", required: false, description: "Only tickets in this group (its id)" },
  { name: "brand_id", type: "string", required: false, description: "Only tickets of this brand (its id)" },
  { name: "tag", type: "string", required: false, description: "Only tickets with this tag" },
];

const name = (type: string) => type.replace(".", "_");
export const triggers: Record<string, { description: string; config: ActionDetail["input"]; output: ActionDetail["input"] }> = Object.fromEntries(
  Object.entries(EVENTS).map(([type, about]) => [name(type), { description: `${about} ${ADMIN}`, config: type.startsWith("ticket.") ? TICKET : [], output: OUTPUT }]),
);
// our trigger → Zendesk's event
export const events: Record<string, string> = Object.fromEntries(Object.keys(EVENTS).map((t) => [name(t), `zen:event-type:${t}`]));
const byEvent = Object.fromEntries(Object.entries(events).map(([t, e]) => [e, t]));

type Detail = { status?: string; group_id?: string | number; brand_id?: string | number; tags?: string[] | null };
export const wanted = (config: unknown, data: unknown) => {
  const want = (config ?? {}) as { status?: string; group_id?: string; brand_id?: string; tag?: string };
  const d = ((data as { detail?: Detail })?.detail ?? {}) as Detail;
  const same = (a: unknown, b?: string) => !b || String(a ?? "").toLowerCase() === b.toLowerCase();
  return same(d.status, want.status) && same(d.group_id, want.group_id) && same(d.brand_id, want.brand_id) && (!want.tag || (d.tags ?? []).some((t) => t.toLowerCase() === want.tag!.toLowerCase()));
};

const hookToken = (connection: string) => createHmac("sha256", process.env.ENCRYPTION_KEY!).update(`zendesk-webhook:${connection}`).digest("hex");
export const hookUrl = (connection: string) => `${process.env.WEBHOOK_URL}/webhooks/app/zendesk/${connection}/${hookToken(connection)}`;

const PATH = "/api/v2/webhooks";
const send = (method: string, path = PATH, query: string[] = []): Send => ({ method, path, query, headers: [], ...(method !== "GET" && method !== "DELETE" && { body: { kind: "whole", field: "body" } }) });
type Hook = { id: string; endpoint: string; subscriptions?: string[] };
const findHook = async (api: Api, key: string, url: string) =>
  ((await call(api, key, send("GET", PATH, ["filter[name_contains]", "page[size]"]), { "filter[name_contains]": "Emplio", "page[size]": 100 })) as { webhooks?: Hook[] }).webhooks?.find(
    (h) => h.endpoint === url,
  );

const adminOnly = (e: unknown) => {
  if (e instanceof AppsError && /\(403\)$/.test(e.message)) throw new AppsError("Zendesk only lets an admin set up this trigger. Connect Zendesk with an admin's login, or use a polled Zendesk trigger instead");
  throw e;
};

// Make sure the connection's webhook is there and receives this event
export async function watch(api: Api, key: string, connection: string, event: string) {
  if (!process.env.WEBHOOK_URL) throw new AppsError("this server can't receive Zendesk's events (WEBHOOK_URL isn't set)");
  const url = hookUrl(connection);
  const id = `zendesk:${connection}`;
  try {
    const found = await findHook(api, key, url);
    if (found?.subscriptions?.includes(event)) return id;
    // ponytail: events are only ever added; the whole webhook goes when the connection's last automation does
    if (found) await call(api, key, send("PATCH", `${PATH}/{id}`), { id: found.id, body: { webhook: { subscriptions: [...(found.subscriptions ?? []), event] } } });
    else
      await call(api, key, send("POST"), {
        body: { webhook: { name: "Emplio", description: "Tells Emplio when things happen in Zendesk", endpoint: url, http_method: "POST", request_format: "json", status: "active", subscriptions: [event] } },
      });
  } catch (e) {
    adminOnly(e);
  }
  return id;
}

export async function unwatch(api: Api, key: string, id: string) {
  const found = await findHook(api, key, hookUrl(id.split(":")[1] ?? ""));
  if (found) await call(api, key, send("DELETE", `${PATH}/{id}`), { id: found.id });
}

// webhook id → its signing secret
const secrets = new Map<string, string>();
const secretOf = async (api: Api, key: string, hook: string, fresh = false) => {
  if (!fresh && secrets.has(hook)) return secrets.get(hook)!;
  const got = (await call(api, key, send("GET", `${PATH}/{id}/signing_secret`), { id: hook })) as { signing_secret?: { secret?: string } };
  const secret = got.signing_secret?.secret ?? "";
  secrets.set(hook, secret);
  return secret;
};
const header = (d: Delivery, name: string) => {
  const v = d.headers[name];
  return typeof v === "string" ? v : undefined;
};
const same = (a: string, b: string) => Buffer.from(a).length === Buffer.from(b).length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

export async function receive(api: Api, delivery: Delivery, key: string) {
  if (!same(delivery.rest, hookToken(delivery.connection))) return null;
  const signature = header(delivery, "x-zendesk-webhook-signature");
  const timestamp = header(delivery, "x-zendesk-webhook-signature-timestamp");
  if (!signature || !timestamp) return null;
  const hook = header(delivery, "x-zendesk-webhook-id") ?? (await findHook(api, key, hookUrl(delivery.connection)).catch(() => undefined))?.id;
  if (!hook) return null;
  const sign = (secret: string) => createHmac("sha256", secret).update(timestamp + delivery.body).digest("base64");
  const ok = async (fresh: boolean) => {
    const secret = await secretOf(api, key, hook, fresh).catch(() => "");
    return Boolean(secret) && same(signature, sign(secret));
  };
  // the secret may have been reset since we kept it
  if (!(await ok(false)) && !(await ok(true))) return null;
  const data = JSON.parse(delivery.body || "{}") as { id?: string; type?: string };
  const name = byEvent[data.type ?? ""];
  return { events: async (): Promise<WebhookEvent[]> => (name ? [{ id: data.id ? `${delivery.connection}:${data.id}` : undefined, triggers: [name], data }] : []) };
}
