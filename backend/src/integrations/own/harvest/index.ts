// Harvest on a personal access token plus the account id: every operation of Harvest's API v2 (time, projects,
// clients, invoices, estimates, expenses, people, time off, Forecast scheduling, reports, Gusto). Harvest has no
// OpenAPI spec, so actions.json is read from its reference pages by generate.ts. Harvest has no webhooks: every
// trigger is polled (polls/harvest.ts).
import { AppsError } from "../../types";
import type { OwnApp } from "../index";
import { type Api, call, specActions } from "../openapi";

// "ACCOUNT_ID:TOKEN"; pasted the other way round works too, since the account id is the part that's all digits
export function parseKey(key: string) {
  const at = key.indexOf(":");
  const [a, b] = at < 0 ? ["", key.trim()] : [key.slice(0, at).trim(), key.slice(at + 1).trim()];
  return /^\d+$/.test(a) || !/^\d+$/.test(b) ? { account: a, token: b } : { account: b, token: a };
}

const api: Api = {
  name: "Harvest",
  base: "https://api.harvestapp.com/v2",
  tokenHelp: "id.getharvest.com/developers → Create new personal access token, pasted as ACCOUNT_ID:TOKEN",
  auth: (key) => {
    const { account, token } = parseKey(key);
    return { Authorization: `Bearer ${token}`, "Harvest-Account-Id": account, "User-Agent": "Emplio (https://emplio.app)" };
  },
};

const file = new URL("./actions.json", import.meta.url);
const actions = await specActions(file, api);
// array filters go in the query as name[]=1&name[]=2: the send lists "name[]", so the value moves there
for (const { name, arrays } of (await Bun.file(file).json()).actions as { name: string; arrays?: string[] }[]) {
  if (!arrays) continue;
  const action = actions[name]!;
  const run = action.run;
  action.run = (input: Record<string, unknown>, key) => {
    const moved = { ...input };
    for (const k of arrays) {
      if (moved[k] === undefined) continue;
      moved[`${k}[]`] = moved[k];
      delete moved[k];
    }
    return run(moved, key);
  };
}

export const harvest: OwnApp = {
  app: "harvest",
  name: "Harvest",
  logo: "/logos/harvest.svg",
  keyField: {
    label: "Account ID and personal access token",
    help: "Go to id.getharvest.com/developers and click Create new personal access token. The page then shows your token and, under Account ID, the number for your Harvest account. Emplio can do whatever your own Harvest login can, so use an Administrator login if Emplio should manage invoices, people and settings.",
    placeholder: "1234567:your-personal-access-token",
    sep: ":",
    parts: [{label:"Account ID",placeholder:"1234567"},{label:"Personal access token",secret:true,placeholder:"your-personal-access-token"}],
  },
  // the company's name labels the connection; a wrong token or account id gets a 401, which asks for reconnecting
  async check(key) {
    const { account, token } = parseKey(key);
    if (!account || !token) throw new AppsError("enter both the Account ID and the personal access token");
    const company = (await call(api, key, { method: "GET", path: "/company", query: [], headers: [] }, {})) as { name?: string };
    return company.name;
  },
  actions,
};
