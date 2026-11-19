// Zoho Campaigns: every call in its API docs (v1.1; it has no OpenAPI spec), listed by hand. Sign-in with Zoho only.
import type { OwnApp } from "../index";
import { zohoOAuth } from "../zoho-login";
import { campaignActions } from "./campaigns";
import { op } from "./client";
import { listActions } from "./lists";
import { moreActions } from "./more";

// campaign.ALL and contact.ALL are Zoho's read+create+update+delete; workflow is for custom workflows
export const SCOPES = "ZohoCampaigns.campaign.ALL,ZohoCampaigns.contact.ALL,ZohoCampaigns.workflow.READ,ZohoCampaigns.workflow.CREATE";

const actions = { ...listActions, ...campaignActions, ...moreActions };

export const zoho_campaigns: OwnApp = {
  app: "zoho_campaigns",
  name: "Zoho Campaigns",
  logo: "/logos/zoho_campaigns.svg",
  // contact fields always exist, even on a new account with no lists yet
  check: async (key) => {
    await op("GET", "/contact/allfields", "", {}, { read: true, fmt: "type" }).run({}, key);
  },
  oauth: zohoOAuth("Zoho Campaigns", SCOPES),
  actions,
};
