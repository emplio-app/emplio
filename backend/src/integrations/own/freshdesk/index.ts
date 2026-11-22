// Freshdesk on the helpdesk's address and an agent's API key: every call of Freshdesk's API v2 — tickets, replies
// and notes, contacts and companies, agents and groups, knowledge base, canned responses, forums, time entries,
// satisfaction ratings, SLA policies, automations, custom objects and the rest. Freshdesk has no OpenAPI spec, so the
// calls are listed by hand from developers.freshdesk.com/api; COVERAGE.md says what's where. Freshdesk's webhooks are
// only set up in its own automation rules, so events are polled (polls/freshdesk.ts).
import type { OwnApp } from "../index";
import { call } from "../openapi";
import { adminActions } from "./admin";
import { api, login } from "./client";
import { contactActions } from "./contacts";
import { knowledgeActions } from "./knowledge";
import { teamActions } from "./team";
import { ticketActions } from "./tickets";

export const freshdesk: OwnApp = {
  app: "freshdesk",
  name: "Freshdesk",
  logo: "/logos/freshdesk.svg",
  keyField: {
    label: "Helpdesk address and API key",
    help: "In Freshdesk, click your profile picture → Profile settings → View API key. Paste your helpdesk address and that key joined by a colon: yourco.freshdesk.com:YOUR_API_KEY. Emplio can then do whatever your agent account can, so use an admin for set-up tasks.",
    placeholder: "yourco.freshdesk.com:AbCdEf123456",
  },
  // who the key belongs to; a wrong key gets a 401, which marks the connection for reconnecting
  async check(key) {
    const { host } = login(key);
    const me = (await call(api, key, { method: "GET", path: "/agents/me", query: [], headers: [] }, {})) as { contact?: { name?: string; email?: string } };
    const who = me.contact?.name || me.contact?.email;
    return who ? `${who} (${host})` : host;
  },
  actions: { ...ticketActions, ...contactActions, ...teamActions, ...knowledgeActions, ...adminActions },
};
