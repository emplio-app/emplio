// Zoho Invoice: every operation in Zoho's OpenAPI files, from `bun scripts/openapi-actions.ts zoho_invoice`. Sign-in only.
// Every call needs the organisation, sent as a header: organization_id, left out, is the login's only one (several: the error lists them).
import type { OwnApp } from "../index";
import { type Api, call, specActions } from "../openapi";
import { autoFill, zohoAuth, zohoClient, zohoOAuth } from "../zoho-login";

export const SCOPES = "ZohoInvoice.fullaccess.all";
const base = zohoClient("Zoho Invoice", "https://www.zohoapis.com/invoice/v3");
const api: Api = { ...base, auth: (key, input) => ({ ...zohoAuth(key), ...(input.organization_id && { "X-com-zoho-invoice-organizationid": String(input.organization_id) }) }) };

export const organizations = async (key: string) => {
  const out = (await call(api, key, { method: "GET", path: "/organizations", query: [], headers: [] }, {})) as { organizations?: { organization_id: string; name: string }[] };
  return (out.organizations ?? []).map((o) => ({ id: String(o.organization_id), label: o.name }));
};

const actions = autoFill(await specActions(new URL("./actions.json", import.meta.url), api), {
  field: "organization_id",
  what: "organisation",
  describe: "Which organisation to act on (its organization_id). Leave out when the login has just one; Emplio fills it in.",
  // the organisation calls themselves are the only ones that don't need it
  applies: (name) => !/organi[sz]ation/.test(name),
  list: organizations,
});

export const zoho_invoice: OwnApp = {
  app: "zoho_invoice",
  name: "Zoho Invoice",
  logo: "/logos/zoho_invoice.svg",
  check: async (key) => (await organizations(key)).map((o) => o.label).join(", ") || undefined,
  oauth: zohoOAuth("Zoho Invoice", SCOPES),
  actions,
};
