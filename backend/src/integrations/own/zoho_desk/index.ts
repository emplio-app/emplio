// Zoho Desk: every operation in Zoho's OpenAPI files (github.com/zoho/zohodesk-oas), from `bun scripts/openapi-actions.ts zoho_desk`. Sign-in only.
// Every call but the list of organisations needs orgId: left out, the login's only organisation is used, and with several the error lists them.
import { z } from "zod";
import type { OwnAction, OwnApp } from "../index";
import { type Api, call, specActions } from "../openapi";
import { autoFill, zohoClient, zohoOAuth } from "../zoho-login";
import { events, organizations as listOrgs, receive, triggers, unwatch, wanted, watch } from "./triggers";

// What the actions need, from each operation's scope in Zoho's files: the .ALL scope wherever Zoho has one. Left out:
// scopes the files name but Zoho's own scope list doesn't (qaautomation, recyclebin, privacysettings, sandbox.deploy,
// automation.CREATE); an unknown scope would make Zoho refuse the whole sign-in. See COVERAGE.md.
export const SCOPES = [
  "Desk.tickets.ALL", "Desk.contacts.ALL", "Desk.accounts.ALL", "Desk.tasks.ALL", "Desk.events.ALL", "Desk.calls.ALL",
  "Desk.activities.tasks.ALL", "Desk.activities.events.ALL", "Desk.activities.calls.ALL", "Desk.agents.ALL", "Desk.departments.ALL",
  "Desk.teams.READ", "Desk.teams.CREATE", "Desk.teams.UPDATE", "Desk.teams.DELETE", "Desk.basic.ALL", "Desk.search.READ",
  "Desk.articles.ALL", "Desk.products.ALL", "Desk.contracts.ALL", "Desk.custommodule.ALL", "Desk.modules.ALL", "Desk.fields.ALL",
  "Desk.layouts.ALL", "Desk.templates.ALL", "Desk.automations.ALL", "Desk.settings.ALL", "Desk.webhooks.ALL", "Desk.channels.email.ALL",
  "Desk.channels.helpcenter.ALL", "Desk.community.ALL", "Desk.forums.ALL", "Desk.InstantMessages.ALL", "Desk.integrations.ALL",
  "Desk.organization.READ", "Desk.organization.UPDATE", "Desk.permissions.READ", "Desk.permissions.CREATE", "Desk.permissions.UPDATE",
  "Desk.permissions.DELETE", "Desk.featuresettings.READ", "Desk.featuresettings.UPDATE", "Desk.sandbox.READ", "Desk.sandbox.CREATE",
  "Desk.sandbox.UPDATE", "Desk.imports.CUSTOM", "Desk.exports.CUSTOM",
].join(",");
export const api: Api = zohoClient("Zoho Desk", "https://desk.zoho.com");

const organizations = (key: string) => listOrgs(api, key);

const ORG_HELP = "Which Zoho Desk organisation to act on (its orgId). Leave out when the login has just one; Emplio fills it in.";
// Desk has this call (Composio's download_ticket_attachment) but Zoho's files leave it out
const byHand: Record<string, OwnAction> = {
  download_ticket_attachment: {
    description: "Download a file attached to a ticket. It comes back as a file on Emplio's computer. list_ticket_attachments gives the attachment ids.",
    readOnly: true,
    input: z.object({ ticketId: z.string().describe("The ticket's id (not the number people see)"), attachmentId: z.string().describe("The attachment's id"), org_id: z.string().optional().describe(ORG_HELP) }),
    run: (i, key) => call(api, key, { method: "GET", path: "/api/v1/tickets/{ticketId}/attachments/{attachmentId}/content", query: [], headers: [["org_id", "orgId"]] }, i),
  },
};
const actions = autoFill({ ...byHand, ...(await specActions(new URL("./actions.json", import.meta.url), api)) }, {
  field: "org_id",
  what: "organisation",
  describe: ORG_HELP,
  list: organizations,
});

export const zoho_desk: OwnApp = {
  app: "zoho_desk",
  name: "Zoho Desk",
  logo: "/logos/zoho_desk.svg",
  check: async (key) => (await organizations(key)).map((o) => o.label).join(", ") || undefined,
  oauth: zohoOAuth("Zoho Desk", SCOPES),
  actions,
  push: {
    events,
    triggers,
    start: (key, connection, event, config) => watch(api, key, connection, event, config),
    stop: (key, id) => unwatch(api, key, id),
    receive: (delivery) => receive(delivery),
    wanted,
  },
};
