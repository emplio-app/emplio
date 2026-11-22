// How Smartsheet is called: the token as a bearer, sent to the region its account lives in.
import { AppsError } from "../../types";
import type { Api } from "../openapi";

// A token only works in the region its account lives in: US, EU, Australia, or Smartsheet Gov
export const HOSTS = ["https://api.smartsheet.com/2.0", "https://api.smartsheet.eu/2.0", "https://api.smartsheet.au/2.0", "https://api.smartsheetgov.com/2.0"];
// ponytail: each token's region, worked out once per process (at most four calls); store it with the connection if that ever matters
const region = new Map<string, string>();
// sent on every call, so changes Emplio makes come back marked and don't start its own automations again (triggers.ts)
export const AGENT = "emplio";

export const api: Api = {
  name: "Smartsheet",
  base: HOSTS[0]!,
  tokenHelp: "Smartsheet → your picture → Personal Settings → API Access → Generate new access token",
  auth: (key) => ({ Authorization: `Bearer ${key}`, "Smartsheet-Change-Agent": AGENT }),
  url: (key, base, path) => `${HOSTS.includes(base) ? (region.get(key) ?? base) : base}${path}`,
  // uploads go as the raw file, named in Content-Disposition (attachments, imports, cell and summary images)
  upload: (file, _send, headers) => {
    headers["Content-Type"] = file.mimetype;
    headers["Content-Disposition"] = `attachment; filename="${file.name.replace(/["\\\r\n]/g, "_")}"`;
  },
};

// The region the token belongs to; a token no region knows is dead
export async function home(key: string) {
  const known = region.get(key);
  if (known) return known;
  for (const host of HOSTS) {
    const res = await fetch(`${host}/users/me`, { headers: api.auth!(key, {}) });
    if (res.ok) return region.set(key, host), host;
    if (res.status !== 401 && res.status !== 403) throw new AppsError(`Smartsheet couldn't check the token right now (${res.status}); try again in a minute`);
  }
  throw new AppsError(`Smartsheet didn't accept that API access token; make a new one (${api.tokenHelp}) and paste it again`, true);
}
