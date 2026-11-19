// Campaigns: listing, details and reports, who received, opened or clicked, creating, cloning, sending, scheduling and
// deleting them, and coupon codes.
import { z } from "zod";
import type { OwnAction } from "../index";
import { campaignkey, fromindex, op, range, sort } from "./client";

const couponCode = z.string().min(1).describe("The coupon code, as sent in a coupon campaign");

export const campaignActions: Record<string, OwnAction> = {
  list_recent_campaigns: op(
    "GET",
    "/recentcampaigns",
    "List campaigns, newest first by default, with each one's campaign_key, name, status and when it was made. Filter by status, e.g. sent or drafts.",
    {
      status: z
        .enum(["all", "drafts", "scheduled", "inprogress", "sent", "stopped", "canceled", "tobereviewed", "reviewed", "paused", "intesting"])
        .optional()
        .describe("Only campaigns in this state (default all)"),
      sort,
      fromindex,
      range,
    },
    { read: true },
  ),
  list_recently_sent_campaigns: op(
    "GET",
    "/recentsentcampaigns",
    "The most recently sent campaigns, with when each was sent.",
    { limit: z.number().int().min(1).max(100).describe("How many to return") },
    { read: true },
  ),
  get_campaign_details: op(
    "GET",
    "/getcampaigndetails",
    "A campaign's details: subject, sender, status, the lists and segments it goes to, and its numbers so far.",
    { campaignkey, campaigntype: z.enum(["normal", "abtesting"]).optional().describe("normal (default) or abtesting for an A/B test campaign") },
    { read: true },
  ),
  get_campaign_report: op(
    "GET",
    "/campaignreports",
    "A sent campaign's report: delivered, opens, clicks, bounces, unsubscribes, spam complaints and forwards (counts and percentages), and where it was opened.",
    { campaignkey },
    { read: true },
  ),
  get_last_campaign_report: op("POST", "/getlastcampaignreport", "The report of the last campaign sent: delivered, opens, clicks, bounces and unsubscribes.", {}, { read: true }),
  list_campaign_recipients: op(
    "POST",
    "/getcampaignrecipientsdata",
    "Who a sent campaign reached, opened it, clicked, unsubscribed, bounced or marked it as spam.",
    {
      campaignkey,
      action: z
        .enum(["sentcontacts", "openedcontacts", "unopenedcontacts", "clickedcontacts", "optoutcontacts", "spamcontacts", "senthardbounce", "sentsoftbounce", "unsentcontacts"])
        .describe("Which recipients: sent, opened, unopened, clicked, optout (unsubscribed), spam, hard or soft bounces, or unsent"),
      fromindex,
      range,
    },
    { read: true },
  ),
  create_campaign: op(
    "POST",
    "/createCampaign",
    "Create a draft email campaign for one or more mailing lists (or segments). The content comes from a public web page with the email's HTML. Nothing is sent until zoho_campaigns.send_campaign or schedule_campaign.",
    {
      campaignname: z.string().min(1).describe("The campaign's name (for you, not shown to recipients)"),
      subject: z.string().min(1).describe("The email's subject line"),
      from_email: z.string().min(1).describe("The sender address; it must be verified in Zoho Campaigns"),
      from_name: z.string().optional().describe("The sender name recipients see"),
      content_url: z.string().optional().describe("A public web address whose HTML becomes the email's content"),
      list_details: z
        .record(z.string(), z.array(z.string()))
        .optional()
        .describe('The lists to send to, each listkey with the segment ids to limit it to (an empty list for all of it), e.g. {"3c20ad52...": []}'),
      segments: z.array(z.string()).optional().describe("Segment ids to send to, when not sending to whole lists"),
      topicId: z.string().optional().describe("A topic's id (zoho_campaigns.list_topics); needed on accounts that use topics"),
    },
    { build: ({ segments, ...i }) => ({ ...i, segments: segments && `[${segments.join(",")}]` }) },
  ),
  clone_campaign: op(
    "POST",
    "/json/clonecampaign",
    "Make a new draft campaign as a copy of an existing one, with a new name and subject.",
    {
      oldcampaignkey: z.string().min(1).describe("The campaign_key of the campaign to copy"),
      campaignname: z.string().min(1).describe("The new campaign's name"),
      subject: z.string().min(1).describe("The new campaign's subject line"),
      from_name: z.string().optional().describe("Sender name"),
      from_add: z.string().optional().describe("Sender address; it must be verified in Zoho Campaigns"),
      reply_to: z.string().optional().describe("Address replies go to"),
      encode_type: z.string().optional().describe("Text encoding, e.g. UTF-8 (default)"),
    },
    { build: (campaigninfo) => ({ campaigninfo }) },
  ),
  send_campaign: op(
    "POST",
    "/sendcampaign",
    "Send a campaign now, to the lists and segments it was created with (see zoho_campaigns.get_campaign_details). This emails real people and can't be undone.",
    { campaignkey },
  ),
  schedule_campaign: op(
    "POST",
    "/sendcampaign",
    "Schedule a campaign to be sent later, to the lists and segments it was created with.",
    {
      campaignkey,
      scheduledate: z.string().min(1).describe("The day, as mm/dd/yyyy"),
      schedulehour: z.number().int().min(1).max(12).describe("The hour, 1-12"),
      scheduleminute: z.string().describe("The minute, in steps of 5: 00, 05 ... 55"),
      am_pm: z.enum(["am", "pm"]).describe("am or pm"),
      istimewarp: z.boolean().optional().describe("true: send at that time in each recipient's own time zone"),
      sendingTZ: z.string().optional().describe("The time zone the time is in, e.g. Asia/Kolkata"),
    },
    { build: (i) => ({ ...i, isschedule: true }) },
  ),
  delete_campaign: op("GET", "/deletecampaign", "Delete a campaign.", { campaignkey }),
  get_coupon_details: op("POST", "/coupon/coupondetails", "A coupon code's details: its campaign, who it was sent to and whether it's been used.", { couponCode }, { read: true, fmt: "type" }),
  mark_coupon_used: op("GET", "/coupon/changestatus", "Mark a coupon code as used, e.g. when a customer redeems it in your shop.", { couponCode }, { fmt: "type", build: (i) => ({ ...i, changeStatus: "used" }) }),
};
