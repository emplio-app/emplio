// Tags, topics (with their products) and custom workflows. These calls take their settings as one JSON `details` value.
import { z } from "zod";
import type { OwnAction } from "../index";
import { email, op } from "./client";

const tagName = z.string().min(1).describe("The tag's name (zoho_campaigns.list_tags)");
const page = {
  from_index: z.number().int().min(0).optional().describe("Where to start, counting from 0 (default 0)"),
  range: z.number().int().min(1).optional().describe("How many to return"),
};
const details = (i: Record<string, unknown>) => ({ details: i });

export const moreActions: Record<string, OwnAction> = {
  list_tags: op("GET", "/tag/getalltags", "List the contact tags, with each one's name, description, colour and how many contacts have it.", {}, { read: true }),
  create_tag: op("GET", "/tag/add", "Create a contact tag.", {
    tagName: z.string().min(1).describe("The new tag's name"),
    tagDesc: z.string().optional().describe("A short description"),
    color: z.string().optional().describe("Its colour as a hex code, e.g. #ec676c (the default)"),
  }),
  delete_tag: op("GET", "/tag/delete", "Delete a contact tag (contacts keep everything else).", { tagName }),
  associate_tag_with_contact: op("GET", "/tag/associate", "Put a tag on a contact.", { tagName, lead_email: email("The contact's email address") }),
  dissociate_tag_from_contact: op("GET", "/tag/deassociate", "Take a tag off a contact.", { tagName, lead_email: email("The contact's email address") }),
  list_topics: op("GET", "/topics", "List the topics contacts can subscribe to, with each one's id.", page, { read: true, build: details }),
  create_topic: op(
    "POST",
    "/topics",
    "Create a topic contacts can subscribe to (for example Offers or Newsletter). Accounts that group topics by product need product_id.",
    {
      topic_name: z.string().min(1).describe("The topic's name: no special characters"),
      topic_desc: z.string().min(1).describe("A short description: no special characters"),
      product_id: z.string().optional().describe("The product it belongs to (zoho_campaigns.list_topic_products)"),
    },
    { build: details },
  ),
  list_topic_products: op("GET", "/topics/products", "List the products topics are grouped under, with each one's id.", page, { read: true, build: details }),
  list_open_workflows: op(
    "GET",
    "/workflow",
    "List the custom workflows that can be started by API, with each one's workflow_key and trigger key.",
    {
      page: z.number().int().min(1).optional().describe("Page number (default 1)"),
      limit: z.number().int().min(1).optional().describe("How many per page"),
      sort_order: z.enum(["asc", "desc"]).optional().describe("Oldest (asc) or newest (desc) first"),
      user: z.enum(["all", "my", "other"]).optional().describe("Whose workflows: all, my (yours) or other (others')"),
    },
    { read: true, build: (i) => details({ ...i, trigger_type: "open" }) },
  ),
  trigger_workflow_contacts: op(
    "POST",
    "/workflow/{workflow_key}/action/trigger",
    "Start a custom workflow for contacts in a list, e.g. a welcome series for new customers. Up to 200 emails at a time.",
    {
      workflow_key: z.string().min(1).describe("The workflow's workflow_key (zoho_campaigns.list_open_workflows)"),
      triggerkey: z.string().min(1).describe("The workflow's trigger key (zoho_campaigns.list_open_workflows)"),
      listkey: z.string().min(1).describe("The listkey of the mailing list the contacts are in"),
      lead_email: z.string().min(1).describe("The contacts' email addresses, comma separated"),
    },
    { build: ({ workflow_key, ...rest }) => ({ workflow_key, details: rest }) },
  ),
};
