// Zoho Inventory: every operation in Zoho's OpenAPI files, from `bun scripts/openapi-actions.ts zoho_inventory`. Sign-in only.
// Nearly every call needs organization_id: left out, the login's only organisation is used, and with several the error lists them.
import { z } from "zod";
import type { OwnAction, OwnApp } from "../index";
import { type Api, call, rest, specActions } from "../openapi";
import { autoFill, zohoClient, zohoOAuth } from "../zoho-login";

// Zoho's per-module scopes leave out settings, reports and the newer modules; this one covers all of Inventory
export const SCOPES = "ZohoInventory.FullAccess.all";
const api: Api = zohoClient("Zoho Inventory", "https://www.zohoapis.com/inventory/v1");

const org = z.string().optional();

export const organizations = async (key: string) => {
  const out = (await call(api, key, { method: "GET", path: "/organizations", query: [], headers: [] }, {})) as { organizations?: { organization_id: string; name: string }[] };
  return (out.organizations ?? []).map((o) => ({ id: String(o.organization_id), label: o.name }));
};

const tagId = z.string().describe("The reporting tag's id");
const optionId = z.string().describe("The tag option's id");
// Zoho's spec writes these paths with a regular expression where an id goes (see scripts/openapi/zoho_inventory.ts)
const byHand: Record<string, OwnAction> = {
  mark_tag_option_active: rest(api, "POST", "/reportingtags/{tag_id}/option/{option_id}/active", "Turn on one option of a reporting tag.", z.object({ tag_id: tagId, option_id: optionId, organization_id: org }), { query: ["organization_id"] }),
  mark_tag_option_as_inactive: rest(api, "POST", "/reportingtags/{tag_id}/option/{option_id}/inactive", "Turn off one option of a reporting tag.", z.object({ tag_id: tagId, option_id: optionId, organization_id: org }), { query: ["organization_id"] }),
  get_options: rest(api, "GET", "/reportingtags/{tag_id}/options/all", "All the options of a reporting tag, including inactive ones.", z.object({ tag_id: tagId, organization_id: org }), { readOnly: true }),
};

const actions = autoFill({ ...byHand, ...(await specActions(new URL("./actions.json", import.meta.url), api)) }, {
  field: "organization_id",
  what: "organisation",
  describe: "Which organisation to act on (its organization_id). Leave out when the login has just one; Emplio fills it in.",
  list: organizations,
});

export const zoho_inventory: OwnApp = {
  app: "zoho_inventory",
  name: "Zoho Inventory",
  logo: "/logos/zoho_inventory.svg",
  check: async (key) => (await organizations(key)).map((o) => o.label).join(", ") || undefined,
  oauth: zohoOAuth("Zoho Inventory", SCOPES),
  actions,
};
