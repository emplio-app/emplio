// Zoho Billing (formerly Zoho Subscriptions): every operation in Zoho's OpenAPI files, from `bun scripts/openapi-actions.ts zoho_billing`. Sign-in only.
// Every call needs the organisation, sent as a header: organization_id, left out, is the login's only one (several: the error lists them).
import { z } from "zod";
import type { OwnAction, OwnApp } from "../index";
import { type Api, call, rest, specActions } from "../openapi";
import { autoFill, zohoAuth, zohoClient, zohoOAuth } from "../zoho-login";

// Billing's scopes still carry its old name; the per-module ones in the spec don't cover webhooks, settings and custom modules together, this one does.
export const SCOPES = "ZohoSubscriptions.fullaccess.all";
const base = zohoClient("Zoho Billing", "https://www.zohoapis.com/billing/v1");
const api: Api = { ...base, auth: (key, input) => ({ ...zohoAuth(key), ...(input.organization_id && { "X-com-zoho-subscriptions-organizationid": String(input.organization_id) }) }) };

export const organizations = async (key: string) => {
  const out = (await call(api, key, { method: "GET", path: "/organizations", query: [], headers: [] }, {})) as { organizations?: { organization_id: string; name: string }[] };
  return (out.organizations ?? []).map((o) => ({ id: String(o.organization_id), label: o.name }));
};

const tagId = z.string().describe("The reporting tag's id");
const optionId = z.string().describe("The tag option's id");
// Zoho's spec writes these paths with a regular expression where an id goes (see scripts/openapi/zoho_billing.ts).
// ponytail: organization_id also rides along in the query here; Zoho ignores it there
const byHand: Record<string, OwnAction> = {
  mark_option_as_active: rest(api, "POST", "/reportingtags/{tag_id}/option/{option_id}/active", "Turn on one option of a reporting tag.", z.object({ tag_id: tagId, option_id: optionId }), { query: ["organization_id"] }),
  mark_option_as_inactive: rest(api, "POST", "/reportingtags/{tag_id}/option/{option_id}/inactive", "Turn off one option of a reporting tag.", z.object({ tag_id: tagId, option_id: optionId }), { query: ["organization_id"] }),
  get_options: rest(api, "GET", "/reportingtags/{tag_id}/options/all", "All the options of a reporting tag, including inactive ones.", z.object({ tag_id: tagId }), { readOnly: true }),
};

const actions = autoFill({ ...byHand, ...(await specActions(new URL("./actions.json", import.meta.url), api)) }, {
  field: "organization_id",
  what: "organisation",
  describe: "Which organisation to act on (its organization_id). Leave out when the login has just one; Emplio fills it in.",
  // the organisation calls themselves are the only ones that don't need it
  applies: (name) => !/organi[sz]ation/.test(name),
  list: organizations,
});

export const zoho_billing: OwnApp = {
  app: "zoho_billing",
  name: "Zoho Billing",
  logo: "/logos/zoho_billing.svg",
  check: async (key) => (await organizations(key)).map((o) => o.label).join(", ") || undefined,
  oauth: zohoOAuth("Zoho Billing", SCOPES),
  actions,
};
