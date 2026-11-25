// lemlist telling us about activity the moment it happens. lemlist allows one webhook per address, so each connection
// gets one webhook with no event type (every event), at /webhooks/app/lemlist/<connection>, and events are matched here.
// lemlist echoes the webhook's `secret` in every delivery's body; ours is worked out from ENCRYPTION_KEY and the
// connection, never stored.
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { ActionDetail } from "@emplio/shared";
import { AppsError } from "../../types";
import type { Delivery } from "../index";
import { type Api, call, type Send } from "../openapi";

type Field = ActionDetail["input"][number];
type Trigger = { description: string; config: ActionDetail["input"]; output: ActionDetail["input"] };

const CAMPAIGN: Field = { name: "campaign_id", type: "string", required: false, description: "Only events from this campaign (its id, cam_...; get_many_campaigns lists them)" };
const SENDER: Field = { name: "sender_id", type: "string", required: false, description: "Only events sent by, or replying to, this lemlist user (their id, usr_...; get_team_senders lists them)" };
const OUTPUT: ActionDetail["input"] = [
  { name: "type", type: "string", required: true, description: "lemlist's event type, like emailsReplied or linkedinInviteAccepted" },
  { name: "_id", type: "string", required: false, description: "The activity's id in lemlist (act_...)" },
  { name: "createdAt", type: "string", required: false, description: "When it happened" },
  { name: "campaignId", type: "string", required: false, description: "The campaign (cam_...), with campaignName; missing outside campaigns" },
  { name: "leadId", type: "string", required: false, description: "The lead (lea_...), with leadEmail, leadFirstName, leadLastName, leadCompanyName as they were then" },
  { name: "contactId", type: "string", required: false, description: "The contact (ctc_...), with the contact's current email, firstName, lastName, companyName, jobTitle, linkedinUrl, phone" },
  { name: "sendUserId", type: "string", required: false, description: "The lemlist user who sent it, with sendUserEmail and sendUserName" },
  { name: "subject", type: "string", required: false, description: "The email's subject (email events), with to / cc lists; a reply also has the text" },
  { name: "sequenceStep", type: "number", required: false, description: "Which step of the sequence (0 is the first), with stepId" },
];

// lemlist event → [our trigger name, what happened]
const EVENTS: Record<string, [string, string]> = {
  contacted: ["lead_contacted", "A lead was contacted by any channel (email, LinkedIn, call, API step...)."],
  hooked: ["lead_opened", "A lead opened a message (email, LinkedIn or WhatsApp)."],
  attracted: ["lead_clicked", "A lead clicked a link or accepted a LinkedIn invite."],
  warmed: ["lead_replied", "A lead replied on any channel (email, LinkedIn, WhatsApp or SMS)."],
  interested: ["lead_interested", "A lead was marked as interested, by any channel."],
  notInterested: ["lead_not_interested", "A lead was marked as not interested, by any channel."],
  emailsSent: ["email_sent", "A campaign email was sent."],
  emailsOpened: ["email_opened", "A lead opened an email."],
  emailsClicked: ["email_clicked", "A lead clicked a link in an email."],
  emailsReplied: ["email_replied", "A lead replied to an email. isThirdPartyReply is true when someone else answered the thread."],
  emailsBounced: ["email_bounced", "An email bounced."],
  emailsFailed: ["email_failed", "An email failed to send."],
  emailsInterested: ["email_interested", "A lead was marked as interested from an email."],
  emailsNotInterested: ["email_not_interested", "A lead was marked as not interested from an email."],
  emailsUnsubscribed: ["email_unsubscribed", "A lead was stopped because their email or domain is on the unsubscribe list."],
  entityUnsubscribed: ["contact_unsubscribed", "A contact unsubscribed from everything (the unsubscribe link, or marked do-not-contact)."],
  variableUnsubscribed: ["variable_unsubscribed", "One email address, phone number or LinkedIn profile of a contact was unsubscribed."],
  linkedinSent: ["linkedin_sent", "A LinkedIn message was sent."],
  linkedinOpened: ["linkedin_opened", "A LinkedIn message was opened."],
  linkedinReplied: ["linkedin_replied", "A lead replied on LinkedIn."],
  linkedinInterested: ["linkedin_interested", "A lead was marked as interested from LinkedIn."],
  linkedinNotInterested: ["linkedin_not_interested", "A lead was marked as not interested from LinkedIn."],
  linkedinSendFailed: ["linkedin_send_failed", "A LinkedIn message failed to send."],
  linkedinVisitDone: ["linkedin_visit_done", "A LinkedIn profile visit was made."],
  linkedinVisitFailed: ["linkedin_visit_failed", "A LinkedIn profile visit failed."],
  linkedinFollowDone: ["linkedin_follow_done", "A LinkedIn profile was followed."],
  linkedinFollowFailed: ["linkedin_follow_failed", "Following a LinkedIn profile failed."],
  linkedinFollowSkipped: ["linkedin_follow_skipped", "Following a LinkedIn profile was skipped."],
  linkedinInviteDone: ["linkedin_invite_sent", "A LinkedIn invite was sent."],
  linkedinInviteFailed: ["linkedin_invite_failed", "A LinkedIn invite failed."],
  linkedinInviteAccepted: ["linkedin_invite_accepted", "A lead accepted a LinkedIn invite."],
  linkedinEndorseDone: ["linkedin_endorse_done", "A LinkedIn endorsement was given."],
  linkedinEndorseFailed: ["linkedin_endorse_failed", "A LinkedIn endorsement failed."],
  linkedinEndorseSkipped: ["linkedin_endorse_skipped", "A LinkedIn endorsement was skipped."],
  linkedinVoiceNoteDone: ["linkedin_voice_note_sent", "A LinkedIn voice note was sent."],
  linkedinVoiceNoteFailed: ["linkedin_voice_note_failed", "A LinkedIn voice note failed."],
  linkedinLikeLastPostDone: ["linkedin_like_post_done", "The lead's latest LinkedIn post was liked."],
  linkedinLikeLastPostNoPost: ["linkedin_like_post_no_post", "Liking the lead's latest LinkedIn post found no post."],
  linkedinLikeLastPostFailed: ["linkedin_like_post_failed", "Liking the lead's latest LinkedIn post failed."],
  linkedinWithdrawInvitationDone: ["linkedin_invite_withdrawn", "A LinkedIn invite was withdrawn."],
  linkedinWithdrawInvitationFailed: ["linkedin_invite_withdraw_failed", "Withdrawing a LinkedIn invite failed."],
  whatsappMessageSent: ["whatsapp_sent", "A WhatsApp message was sent."],
  whatsappMessageDelivered: ["whatsapp_delivered", "A WhatsApp message was delivered."],
  whatsappMessageOpened: ["whatsapp_opened", "A WhatsApp message was read."],
  whatsappReplied: ["whatsapp_replied", "A lead replied on WhatsApp."],
  whatsappMessageFailed: ["whatsapp_failed", "A WhatsApp message failed."],
  smsSent: ["sms_sent", "An SMS was sent."],
  smsDelivered: ["sms_delivered", "An SMS was delivered."],
  smsReplied: ["sms_replied", "A lead replied by SMS."],
  smsFailed: ["sms_failed", "An SMS failed."],
  aircallCreated: ["call_started", "A call was started."],
  aircallEnded: ["call_ended", "A call ended."],
  aircallDone: ["call_task_done", "A call task was completed."],
  aircallInterested: ["call_interested", "A lead was marked as interested from a call."],
  aircallNotInterested: ["call_not_interested", "A lead was marked as not interested from a call."],
  callRecordingDone: ["call_recording_ready", "A call's recording is ready."],
  callTranscriptDone: ["call_transcript_ready", "A call's transcript is ready."],
  apiDone: ["api_step_done", "A campaign's API step ran."],
  apiInterested: ["api_interested", "A lead was marked as interested through the API."],
  apiNotInterested: ["api_not_interested", "A lead was marked as not interested through the API."],
  apiFailed: ["api_step_failed", "A campaign's API step failed."],
  manualInterested: ["manual_interested", "Someone marked a lead as interested by hand."],
  manualNotInterested: ["manual_not_interested", "Someone marked a lead as not interested by hand."],
  annotated: ["lead_annotated", "A note was added to a lead."],
  paused: ["lead_paused", "A lead was paused."],
  resumed: ["lead_resumed", "A paused lead was resumed."],
  stopped: ["lead_stopped", "A lead was stopped in a campaign."],
  campaignComplete: ["campaign_completed", "A campaign finished: every lead went through it."],
  customDomainErrors: ["custom_domain_error", "A custom tracking domain has an error."],
  connectionIssue: ["mailbox_connection_issue", "An email account lost its connection to lemlist."],
  sendLimitReached: ["send_limit_reached", "A sender reached their daily sending limit."],
  lemwarmPaused: ["warmup_paused", "Warmup (lemwarm) was paused on a mailbox."],
  enrichmentDone: ["enrichment_done", "An enrichment finished; data lists the results, failedWorkflows what found nothing."],
  enrichmentError: ["enrichment_failed", "An enrichment failed as a whole; code and reason say why."],
  contactSourcingDone: ["contact_sourcing_done", "A contact-sourcing run finished, with the buying committee it found."],
  contactSourcingFailed: ["contact_sourcing_failed", "A contact-sourcing run failed, with the reason."],
  inboxLabelUpdated: ["inbox_label_changed", "A label of an inbox conversation changed."],
  signalRegistered: ["new_signal", "A Signal Agent found a new signal (a job change, a hiring post, a visit...). A re-found signal comes again with the same _id."],
  deliverabilityAlertTriggered: ["deliverability_alert", "A deliverability alert went off."],
};
const AGAIN: Record<string, string> = {
  emailsSent: " Sending an email from the run starts this again.",
  linkedinSent: " Sending a LinkedIn message from the run starts this again.",
  whatsappMessageSent: " Sending a WhatsApp message from the run starts this again.",
  smsSent: " Sending an SMS from the run starts this again.",
  contacted: " Contacting the lead from the run starts this again.",
  inboxLabelUpdated: " Changing a label from the run starts this again, so say in the prompt when to stop.",
  annotated: " Adding a note from the run starts this again, so say in the prompt when to stop.",
};

export const triggers: Record<string, Trigger> = {};
export const events: Record<string, string> = {};
const BY_TYPE: Record<string, string> = {};
for (const [type, [name, what]] of Object.entries(EVENTS)) {
  triggers[name] = { description: `${what} (lemlist)${AGAIN[type] ?? ""}`, config: [CAMPAIGN, SENDER], output: OUTPUT };
  events[name] = type;
  BY_TYPE[type] = name;
}

export const wanted = (config: unknown, data: unknown) => {
  const want = (config ?? {}) as { campaign_id?: string; sender_id?: string };
  const d = (data ?? {}) as { campaignId?: string; sendUserId?: string };
  const same = (w: unknown, got: unknown) => !w || w === got;
  return same(want.campaign_id, d.campaignId) && same(want.sender_id, d.sendUserId);
};

export const secret = (connection: string) => createHmac("sha256", process.env.ENCRYPTION_KEY!).update(`lemlist-webhook:${connection}`).digest("hex").slice(0, 32);
const hookUrl = (connection: string) => `${process.env.WEBHOOK_URL}/webhooks/app/lemlist/${connection}`;

const send = (method: string, path: string, fields: string[] = []): Send => ({ method, path, query: [], headers: [], ...(fields.length && { body: { kind: "fields" as const, fields: fields.map((f): [string, string] => [f, f]) } }) });
type Hook = { _id: string; targetUrl: string; type?: string; campaignId?: string; disabled?: boolean };
const ours = async (api: Api, key: string, connection: string) => ((await call(api, key, send("GET", "/hooks"), {})) as Hook[]).filter((h) => h.targetUrl === hookUrl(connection));
const remove = (api: Api, key: string, hookId: string) => call(api, key, send("DELETE", "/hooks/{hookId}"), { hookId });

// ponytail: one all-events webhook per connection (lemlist refuses a second webhook on the same address), matched here
export async function watch(api: Api, key: string, connection: string) {
  if (!process.env.WEBHOOK_URL) throw new AppsError("this server can't receive lemlist's events (WEBHOOK_URL isn't set)");
  const id = `lemlist:${connection}`;
  const found = await ours(api, key, connection);
  if (found.some((h) => !h.disabled && !h.type && !h.campaignId)) return id;
  // lemlist switches a webhook off when deliveries fail; a fresh one starts clean (and frees the address)
  for (const h of found) await remove(api, key, h._id);
  await call(api, key, send("POST", "/hooks", ["targetUrl", "secret"]), { targetUrl: hookUrl(connection), secret: secret(connection) });
  return id;
}

export async function unwatch(api: Api, key: string, id: string) {
  const [, connection = ""] = id.split(":");
  for (const h of await ours(api, key, connection)) await remove(api, key, h._id);
}

const matches = (got: unknown, connection: string) => {
  const a = Buffer.from(typeof got === "string" ? got : "");
  const b = Buffer.from(secret(connection));
  return a.length === b.length && timingSafeEqual(a, b);
};

export async function receive(delivery: Delivery) {
  let body: Record<string, any>;
  try {
    body = JSON.parse(delivery.body || "{}");
  } catch {
    return null;
  }
  if (!matches(body.secret, delivery.connection)) return null;
  const { secret: _, ...data } = body;
  const name = BY_TYPE[String(data.type)];
  // a re-found signal keeps its _id with a new receivedAt; enrichment events have no _id at all
  const key = data._id ? [data._id, data.type, data.receivedAt].filter(Boolean).join(":") : createHash("sha256").update(delivery.body).digest("hex").slice(0, 32);
  const id = `${delivery.connection}:${key}`;
  return { events: async () => (name ? [{ id, triggers: [name], data }] : []) };
}
