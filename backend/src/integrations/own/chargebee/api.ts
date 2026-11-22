// Where a Chargebee login's calls go: the person's own <site>.chargebee.com/api/v2, with basic auth on the API key.
import { AppsError } from "../../types";
import type { Api } from "../openapi";

export type Login = { host: string; key: string };

// The pasted line: the site and the API key, joined by a colon or a space ("acme:live_..."). The site may be the
// whole address (https://acme.chargebee.com) and a test site's name ends in -test.
export function parseKey(raw: string): Login {
  const m = /^(?:https?:\/\/)?([^\s:/]+)(?:\/[^\s:]*)?[\s:]+(\S+)$/i.exec(raw.trim());
  if (!m) throw new AppsError("enter your Chargebee site (acme from acme.chargebee.com) and an API key");
  const site = m[1]!.toLowerCase();
  const host = site.includes(".") ? site : `${site}.chargebee.com`;
  // only Chargebee's own hosts: the key decides where the API key is sent
  if (!/^[a-z0-9][a-z0-9-]*\.chargebee\.com$/.test(host)) throw new AppsError(`${m[1]} isn't a Chargebee site: use the first part of your Chargebee address, like acme for acme.chargebee.com`);
  return { host, key: m[2]! };
}

export const api: Api = {
  name: "Chargebee",
  base: "https://example.chargebee.com/api/v2",
  tokenHelp: "Chargebee → Settings → Configure Chargebee → API keys and webhooks → API keys",
  auth: (key) => ({ Authorization: `Basic ${Buffer.from(`${parseKey(key).key}:`).toString("base64")}`, Accept: "application/json" }),
  url: (key, _base, path) => `https://${parseKey(key).host}/api/v2${path}`,
};
