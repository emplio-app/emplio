// Where an ActiveCampaign login's calls go: the person's own <account>.api-us1.com, with their API key in Api-Token.
import { AppsError } from "../../types";
import type { Api } from "../openapi";

export type Login = { origin: string; token: string };

// "https://acme.api-us1.com", "acme.api-us1.com", a link into it, or just "acme"
function origin(raw: string) {
  const s = raw.trim().toLowerCase().replace(/^https?:\/\//, "").split("/")[0]!;
  const host = s.includes(".") ? s : `${s}.api-us1.com`;
  // only ActiveCampaign's own hosts: the key decides where the API key is sent
  if (!/^[a-z0-9][a-z0-9-]*\.(api-us\d+\.com|activehosted\.com)$/.test(host))
    throw new AppsError(`${raw} isn't an ActiveCampaign API address: use the URL from Settings → Developer, like https://acme.api-us1.com`);
  return `https://${host}`;
}

// The pasted line: the API URL and the API key, separated by a space, in either order.
export function parseKey(key: string): Login {
  const parts = key.trim().split(/\s+/).filter(Boolean);
  const url = parts.find((p) => p.includes(".") || /^https?:/i.test(p));
  const token = parts.find((p) => p !== url);
  if (parts.length !== 2 || !url || !token)
    throw new AppsError("paste two things separated by a space: your API URL (like https://acme.api-us1.com) and your API key, both from Settings → Developer in ActiveCampaign");
  return { origin: origin(url), token };
}

export const api: Api = {
  name: "ActiveCampaign",
  base: "https://account.api-us1.com/api/3",
  tokenHelp: "ActiveCampaign → Settings → Developer",
  // event tracking (track_event, on trackcmp.net) proves itself with its own actid and event key, so the API key stays home
  auth: (key, input): Record<string, string> => ("actid" in input ? {} : { "Api-Token": parseKey(key).token, Accept: "application/json" }),
  // every spec names the person's host its own way ({youraccountname}.api-us1.com); trackcmp.net is the same for everyone
  url: (key, base, path) => (base.startsWith("https://trackcmp.net") ? `${base}${path}` : `${parseKey(key).origin}${base.replace(/^https:\/\/[^/]+/, "")}${path}`),
  // event tracking answers {"success": 0, "message": "..."} with a 200
  failed: (body) => (body?.success === 0 ? String(body.message ?? "it didn't work") : undefined),
};
