// Clockify on an API key: every operation of Clockify's API, reports and audit log included. actions.json is generated
// by `bun scripts/openapi-actions.ts clockify`; every event Clockify reports starts automations by webhook (triggers.ts).
import type { OwnApp } from "../index";
import { type Api, call, specActions } from "../openapi";
import { events, receive, triggers, unwatch, wanted, watch } from "./triggers";

// A workspace kept in one of Clockify's regions is reached through that region's servers. Its key is pasted as
// "euc1:<key>" (EU), "use2:" (USA), "euw2:" (UK) or "apse2:" (Australia); a plain key uses the global servers.
const REGION = /^(euc1|use2|euw2|apse2):(.+)$/;
const parse = (key: string) => {
  const m = key.match(REGION);
  return m ? { region: m[1], key: m[2]! } : { key };
};

const api: Api = {
  name: "Clockify",
  base: "https://api.clockify.me/api",
  tokenHelp: "app.clockify.me/user/preferences#advanced → API key",
  auth: (key) => ({ "X-Api-Key": parse(key).key }),
  // ponytail: the audit log stays on its global server; Clockify doesn't document a regional one
  url: (key, base, path) => {
    const { region } = parse(key);
    if (region && base === "https://api.clockify.me/api") return `https://${region}.clockify.me/api${path}`;
    if (region && base === "https://reports.api.clockify.me") return `https://${region}.clockify.me/report${path}`;
    return `${base}${path}`;
  },
};

const actions = await specActions(new URL("./actions.json", import.meta.url), api);

export const clockify: OwnApp = {
  app: "clockify",
  name: "Clockify",
  logo: "/logos/clockify.svg",
  keyField: {
    label: "API key",
    help: "In Clockify open your profile picture → Preferences → Advanced (app.clockify.me/user/preferences#advanced), press Generate new under API key, then copy it. Emplio can then do whatever your Clockify account can. If your workspace's data is kept in a region, pick it.",
    placeholder: "Your Clockify API key",
    sep: ":",
    parts: [{label:"Data region",optional:true,options:[{value:"",label:"Global (most workspaces)"},{value:"euc1",label:"EU"},{value:"use2",label:"USA"},{value:"euw2",label:"UK"},{value:"apse2",label:"Australia"}]},{label:"API key",secret:true,placeholder:"Your Clockify API key"}],
  },
  async check(key) {
    const me = (await call(api, key, { method: "GET", path: "/v1/user", query: [], headers: [] }, {})) as { id: string; name?: string; email?: string };
    return me.name || me.email || me.id;
  },
  push: {
    events,
    triggers,
    start: (key, connection, event, config) => watch(api, key, connection, event, config),
    stop: (key, id) => unwatch(api, key, id),
    receive: (delivery) => receive(delivery),
    wanted,
  },
  actions,
};
