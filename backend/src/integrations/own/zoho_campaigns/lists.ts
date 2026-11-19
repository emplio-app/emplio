// Mailing lists and contacts: lists, their contacts and counts, segments, contact fields and merge tags, adding,
// subscribing, unsubscribing and Do-Not-Mail.
import { z } from "zod";
import type { OwnAction } from "../index";
import { email, fieldtype, fromindex, listkey, op, range, sort } from "./client";

const emails = z.array(z.string()).min(1).max(10).describe("Up to 10 email addresses");
const signupform = z.enum(["public", "private"]).describe("public: people can sign up to it through a form; private: only you add contacts");
const topic_id = z.string().optional().describe("A topic's id (zoho_campaigns.list_topics), for accounts that sort contacts by topic");
// a contact as Zoho takes it: field names as shown in Zoho Campaigns ("Contact Email", "First Name"...)
const contact = {
  contact_email: email("The contact's email address"),
  first_name: z.string().optional().describe("First name"),
  last_name: z.string().optional().describe("Last name"),
  company_name: z.string().optional().describe("Company name"),
  phone: z.string().optional().describe("Phone number"),
  fields: z
    .record(z.string(), z.string())
    .optional()
    .describe('Any other fields, by the name shown in Zoho Campaigns (zoho_campaigns.list_contact_fields, DISPLAY_NAME), e.g. {"City": "Pune", "Job Title": "Owner"}'),
};
const contactinfo = ({ contact_email, first_name, last_name, company_name, phone, fields, ...rest }: Record<string, any>) => ({
  ...rest,
  contactinfo: { "Contact Email": contact_email, "First Name": first_name, "Last Name": last_name, "Company Name": company_name, Phone: phone, ...fields },
});

export const listActions: Record<string, OwnAction> = {
  list_mailing_lists: op("GET", "/getmailinglists", "List the mailing lists, with each one's listkey, name, number of contacts, unsubscribes and bounces.", { sort, fromindex, range }, { read: true }),
  get_mailing_list_details: op(
    "GET",
    "/getlistadvanceddetails",
    "A mailing list's dashboard: its contact numbers (active, unsubscribed, bounced), where its contacts are, and the campaigns sent or scheduled to it.",
    {
      listkey,
      filtertype: z.enum(["sentcampaigns", "scheduledcampaigns", "recentcampaigns"]).optional().describe("Which of the list's campaigns to include (default sent ones)"),
      fromindex,
      range,
    },
    { read: true },
  ),
  list_mailing_list_contacts: op(
    "GET",
    "/getlistsubscribers",
    "List a mailing list's contacts: email, name, company, phone. Filter by status to see only the unsubscribed or bounced ones.",
    {
      listkey,
      status: z.enum(["active", "recent", "mostrecent", "unsub", "bounce"]).optional().describe("Which contacts: active (default), recent, mostrecent, unsub (unsubscribed) or bounce (bounced)"),
      sort,
      fromindex,
      range,
    },
    { read: true },
  ),
  count_mailing_list_contacts: op(
    "GET",
    "/listsubscriberscount",
    "How many contacts a mailing list has, optionally only those with one status.",
    { listkey, status: z.enum(["active", "unsub", "bounce", "spam"]).optional().describe("Count only these: active, unsub (unsubscribed), bounce or spam") },
    { read: true },
  ),
  list_contact_fields: op("GET", "/contact/allfields", "List every contact field (built in and custom), with its display name, field name and id.", {}, { read: true, fmt: "type" }),
  get_segment_details: op(
    "GET",
    "/getsegmentdetails",
    "A segment's rules: which contacts of a list it picks.",
    { listkey, cvid: z.string().min(1).describe("The segment's id (cvid, under segments in zoho_campaigns.list_mailing_lists)") },
    { read: true },
  ),
  list_segment_contacts: op(
    "GET",
    "/getsegmentcontacts",
    "List the contacts in a segment.",
    { cvid: z.string().min(1).describe("The segment's id (cvid, under segments in zoho_campaigns.list_mailing_lists)"), fromindex, range },
    { read: true },
  ),
  add_mailing_list_and_contacts: op(
    "POST",
    "/addlistandcontacts",
    "Create a new mailing list with up to 10 contacts in it.",
    {
      listname: z.string().min(1).describe("The new list's name"),
      signupform,
      emailids: emails,
      listdescription: z.string().optional().describe("A short description of the list"),
    },
    { build: (i) => ({ ...i, mode: "newlist" }) },
  ),
  add_contacts_to_mailing_list: op(
    "POST",
    "/addlistsubscribersinbulk",
    "Add up to 10 email addresses to an existing mailing list. On a list with a sign-up form they get an email to confirm first.",
    { listkey, emailids: emails },
  ),
  subscribe_contact: op(
    "POST",
    "/json/listsubscribe",
    "Add one contact to a mailing list, with their name and other fields, or update an existing contact's fields. On a list with a sign-up form they get an email to confirm first.",
    { listkey, ...contact, source: z.string().optional().describe("Where the contact came from, e.g. Website or Shop"), topic_id },
    { build: contactinfo },
  ),
  unsubscribe_contact: op(
    "POST",
    "/json/listunsubscribe",
    "Unsubscribe a contact from a mailing list, so they get no more campaigns sent to that list.",
    { listkey, contact_email: email("The contact's email address"), topic_id },
    { build: ({ contact_email, ...rest }) => ({ ...rest, contactinfo: { "Contact Email": contact_email } }) },
  ),
  move_contact_to_do_not_mail: op(
    "POST",
    "/json/contactdonotmail",
    "Put a contact on the Do-Not-Mail list: no campaign from this account will ever reach them again.",
    { contact_email: email("The contact's email address") },
    { build: ({ contact_email }) => ({ contactinfo: { "Contact Email": contact_email } }) },
  ),
  update_mailing_list: op("POST", "/updatelistdetails", "Rename a mailing list and choose whether people can sign up to it.", {
    listkey,
    newlistname: z.string().min(1).describe("The list's name (give the current one to keep it)"),
    signupform,
  }),
  delete_mailing_list: op("GET", "/deletemailinglist", "Delete a mailing list, and optionally the contacts that are only in it.", {
    listkey,
    deletecontacts: z.enum(["on", "off"]).optional().describe("on: also delete its contacts; off (default): keep them"),
  }),
  create_contact_field: op(
    "POST",
    "/custom/add",
    "Add a custom contact field, to store something extra about contacts (birthday, plan, city...).",
    {
      fieldname: z.string().min(1).describe("The field's name: letters, numbers and spaces"),
      fieldtype,
      fieldlength: z.number().int().optional().describe("Longest value allowed, in characters (default 20)"),
    },
    { fmt: "type" },
  ),
  create_merge_tag: op(
    "GET",
    "/merge/create",
    "Create a merge tag: a placeholder in email content that's replaced with each contact's value.",
    {
      fieldname: z.string().min(1).describe("The tag's name: letters, numbers and spaces"),
      fieldtype,
      mailvalue: z.string().optional().describe("What to show in emails when a contact has no value"),
      socialvalue: z.string().optional().describe("What to show in social posts when there is no value"),
    },
    { fmt: "type", build: (i) => ({ ...i, tagtype: "Custom" }) },
  ),
};
