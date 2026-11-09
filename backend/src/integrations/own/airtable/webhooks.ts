// Managing Airtable webhooks by hand. Emplio's own triggers don't use these (a pasted token's webhooks stop after 7 days): COVERAGE.md.
import { z } from "zod";
import type { OwnAction } from "../index";
import { baseId, r } from "./client";

const hookId = z.string().min(1).describe("The webhook's id, from airtable.list_webhooks");
const base = { base_id: baseId };

export const webhookActions: Record<string, OwnAction> = {
  list_webhooks: r("GET", "/v0/bases/{base_id}/webhooks", "The webhooks on a base. Needs the webhook:manage scope.", base),
  create_webhook: r("POST", "/v0/bases/{base_id}/webhooks", "Make a webhook on a base; it stops after 7 days unless refreshed. The answer holds its secret once.", {
    ...base,
    notificationUrl: z.string().optional().describe("The address Airtable pings when something changes (optional; payloads can be read without it)"),
    specification: z.object({ options: z.object({ filters: z.object({ dataTypes: z.array(z.string()).describe('What to watch: "tableData", "tableFields", "tableMetadata"') }).loose() }).loose() }).describe('What it watches, e.g. {"options": {"filters": {"dataTypes": ["tableData"]}}}'),
  }),
  delete_webhook: r("DELETE", "/v0/bases/{base_id}/webhooks/{webhook_id}", "Remove a webhook.", { ...base, webhook_id: hookId }),
  refresh_webhook: r("POST", "/v0/bases/{base_id}/webhooks/{webhook_id}/refresh", "Keep a webhook going for another 7 days.", { ...base, webhook_id: hookId }),
  enable_webhook_notifications: r("POST", "/v0/bases/{base_id}/webhooks/{webhook_id}/enableNotifications", "Turn a webhook's pings on or off.", { ...base, webhook_id: hookId, enable: z.boolean().describe("true turns pings on, false off") }),
  list_webhook_payloads: r("GET", "/v0/bases/{base_id}/webhooks/{webhook_id}/payloads", "What a webhook has recorded since a cursor.", {
    ...base,
    webhook_id: hookId,
    cursor: z.number().int().optional().describe("Where to start, from the last answer (default: the first)"),
    limit: z.number().int().min(1).max(50).optional().describe("How many (1-50, default 50)"),
  }),
};
