// Where a Zendesk login's calls go: the person's own <subdomain>.zendesk.com, with basic auth on their email and API token.
import { AppsError } from "../../types";
import type { Api } from "../openapi";

export type Login = { host: string; email: string; token: string };

// "acme", "acme.zendesk.com" or a link into it
function host(raw: string) {
  const s = raw.trim().toLowerCase().replace(/^https?:\/\//, "").split("/")[0]!;
  const h = s.includes(".") ? s : `${s}.zendesk.com`;
  // only Zendesk's own hosts: the key decides where the email and token are sent
  if (!/^[a-z0-9][a-z0-9-]*\.zendesk\.com$/.test(h)) throw new AppsError(`${raw} isn't a Zendesk address: use your subdomain, like acme for acme.zendesk.com`);
  return h;
}

// The pasted line: the subdomain, the account's email and the API token, separated by spaces, in any order.
export function parseKey(key: string): Login {
  const parts = key.trim().split(/\s+/).filter(Boolean);
  const email = parts.find((p) => p.includes("@") && !p.includes("/"));
  const rest = parts.filter((p) => p !== email);
  // ponytail: with a bare subdomain, the shorter of the two is it (tokens are 40 characters)
  const site = rest.find((p) => /zendesk\.com|^https?:/i.test(p)) ?? [...rest].sort((a, b) => a.length - b.length)[0];
  const token = rest.find((p) => p !== site);
  if (parts.length !== 3 || !email || !site || !token)
    throw new AppsError("paste three things separated by spaces: your Zendesk subdomain (acme for acme.zendesk.com), the email you sign in with, and an API token");
  return { host: host(site), email, token };
}

export const api: Api = {
  name: "Zendesk",
  base: "https://example.zendesk.com",
  tokenHelp: "Admin Center → Apps and integrations → APIs → API tokens",
  auth: (key) => {
    const { email, token } = parseKey(key);
    return { Authorization: `Basic ${Buffer.from(`${email}/token:${token}`).toString("base64")}`, Accept: "application/json" };
  },
  url: (key, _base, path) => `https://${parseKey(key).host}${path}`,
  // a ticket attachment goes up as the file itself, with its own type
  upload: (file, _send, headers) => {
    headers["Content-Type"] = file.mimetype;
  },
};
