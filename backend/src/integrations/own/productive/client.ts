// How Productive is called: the token and the organization's id, both in the one key the person pastes.
import { AppsError } from "../../types";
import type { Api } from "../openapi";

// "organization id:token" in either order; the id is the one that's all digits
export function parseKey(key: string) {
  const parts = key.split(":").map((p) => p.trim());
  const org = parts.find((p) => /^\d+$/.test(p));
  const token = parts.find((p) => p !== org);
  if (parts.length !== 2 || !org || !token) throw new AppsError("paste the organization id and the API token joined by a colon, like 12345:your-token");
  return { org, token };
}

export const api: Api = {
  name: "Productive",
  base: "https://api.productive.io",
  tokenHelp: "Productive → Settings → API integrations → Generate new token",
  auth: (key, input) => {
    const { org, token } = parseKey(key);
    return { "X-Auth-Token": token, "X-Organization-Id": org, "Content-Type": `application/vnd.api+json${input.__bulk ? "; ext=bulk" : ""}` };
  },
};
