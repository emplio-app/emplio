// Airtable on the business's personal access token: records, comments, attachments, bases, tables, fields, views,
// webhooks and base/workspace administration. Calls are written by hand; triggers are polled (polls/airtable.ts). COVERAGE.md says why.
import type { OwnApp } from "../index";
import { call } from "../openapi";
import { adminActions } from "./admin";
import { api } from "./client";
import { recordActions } from "./records";
import { schemaActions } from "./schema";
import { webhookActions } from "./webhooks";

export const airtable: OwnApp = {
  app: "airtable",
  name: "Airtable",
  logo: "/logos/airtable.svg",
  keyField: {
    label: "Personal access token",
    help: "airtable.com/create/tokens → Create token. Add the scopes data.records:read and write, data.recordComments:read and write, schema.bases:read and write, webhook:manage and user.email:read, then add the bases Emplio should use.",
    placeholder: "pat...",
  },
  async check(key) {
    const me = (await call(api, key, { method: "GET", path: "/v0/meta/whoami", query: [], headers: [] }, {})) as { id?: string; email?: string };
    return me.email || me.id;
  },
  actions: { ...recordActions, ...schemaActions, ...webhookActions, ...adminActions },
};
