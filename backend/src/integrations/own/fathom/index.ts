// Fathom (AI meeting notes) on the business's own API key: every operation of Fathom's API (actions.json, generated
// by `bun scripts/openapi-actions.ts fathom`): meetings with their summaries, transcripts, action items and CRM
// matches, recording downloads, teams, members, meeting types and webhooks. Finished meetings start automations by
// webhook (triggers.ts). COVERAGE.md says what's where.
import type { OwnApp } from "../index";
import { type Api, call, specActions } from "../openapi";
import { events, receive, triggers, unwatch, wanted, watch } from "./triggers";

const HELP = "Fathom → Settings → API Access → Generate API key";

export const api: Api = {
  name: "Fathom",
  base: "https://api.fathom.ai/external/v1",
  tokenHelp: HELP,
  auth: (key) => ({ "X-Api-Key": key }),
};

export const fathom: OwnApp = {
  app: "fathom",
  name: "Fathom",
  logo: "/logos/fathom.svg",
  keyField: {
    label: "API key",
    help: "In Fathom, open Settings → API Access (fathom.video/customize#api-access-header), press Generate API key, name it Emplio and copy it. Every Fathom plan includes it. Emplio then sees the meetings you recorded and the ones shared with you or your team, never other people's private ones. For every shared meeting in the company, use the key of an admin who has view access to all shared calls.",
    placeholder: "Your Fathom API key",
  },
  async check(key) {
    // Fathom has no "who am I"; listing meetings is its cheapest call. It doesn't say whose key it is.
    await call(api, key, { method: "GET", path: "/meetings", query: [], headers: [] }, {});
  },
  push: {
    events,
    triggers,
    start: (key, connection) => watch(api, key, connection),
    stop: (key, id) => unwatch(api, key, id),
    receive,
    wanted,
  },
  actions: await specActions(new URL("./actions.json", import.meta.url), api),
};
