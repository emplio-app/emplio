import { z } from "zod";
import type { PollTrigger, Run } from "./index";

// HubSpot's webhooks can only be set on a developer app, so everything is found through its CRM search.
// ponytail: the 200 newest of the last day; a business changing more records between checks misses the older ones
const DAY_MS = 86_400_000;
type Row = { id: string; properties: Record<string, string | null>; updatedAt?: string };

const search = async (run: Run, action: string, by: string, properties: string[], filters: object[] = []) =>
  ((await run(`hubspot.${action}`, {
    filterGroups: [{ filters: [{ propertyName: by, operator: "GTE", value: String(Date.now() - DAY_MS) }, ...filters] }],
    sorts: [{ propertyName: by, direction: "DESCENDING" }],
    properties,
    limit: 200,
  })) as { results: Row[] }).results;

const OUT = (name: string) => [{ name, type: "object", required: true, description: `The HubSpot ${name}: id, properties, createdAt, updatedAt` }];

// `change` makes an edit count as a new item
const trigger = (description: string, name: string, action: string, by: string, properties: string[], change = false): PollTrigger => ({
  description,
  config: z.object({}),
  output: OUT(name),
  every: 5,
  min: 5,
  async poll(_config, run) {
    return (await search(run, action, by, properties)).map((row) => ({ id: change ? `${row.id}:${row.properties[by]}` : row.id, item: { [name]: row } }));
  },
});

const CONTACT = ["firstname", "lastname", "email", "phone", "company", "lifecyclestage", "hs_lead_status", "createdate", "lastmodifieddate"];
const COMPANY = ["name", "domain", "industry", "phone", "city", "country", "createdate", "hs_lastmodifieddate"];
const DEAL = ["dealname", "amount", "pipeline", "dealstage", "closedate", "createdate", "hs_lastmodifieddate", "hubspot_owner_id"];
const TICKET = ["subject", "content", "hs_pipeline", "hs_pipeline_stage", "hs_ticket_priority", "createdate", "hs_lastmodifieddate"];
const ENTERED = "hs_v2_date_entered_current_stage";

export const hubspot: Record<string, PollTrigger> = {
  contact_created_trigger: trigger("A new contact is added in HubSpot.", "contact", "search_contacts_by_criteria", "createdate", CONTACT),
  contact_updated_trigger: trigger("A HubSpot contact is added or changed.", "contact", "search_contacts_by_criteria", "lastmodifieddate", CONTACT, true),
  company_created_trigger: trigger("A new company is added in HubSpot.", "company", "search_companies", "createdate", COMPANY),
  deal_created_trigger: trigger("A new deal is added in HubSpot.", "deal", "search_deals", "createdate", DEAL),
  deal_updated_trigger: trigger("A HubSpot deal is added or changed.", "deal", "search_deals", "hs_lastmodifieddate", DEAL, true),
  ticket_created_trigger: trigger("A new support ticket is added in HubSpot.", "ticket", "search_tickets", "createdate", TICKET),
  deal_stage_updated_trigger: {
    description: "A HubSpot deal moves to another stage.",
    config: z.object({
      pipeline: z.string().optional().describe("Only deals in this pipeline (its id)"),
      stage: z.string().optional().describe("Only deals moving into this stage (its id)"),
    }),
    output: OUT("deal"),
    every: 5,
    min: 5,
    async poll(config: { pipeline?: string; stage?: string }, run) {
      const filters = Object.entries({ pipeline: config.pipeline, dealstage: config.stage }).flatMap(([propertyName, value]) => (value ? [{ propertyName, operator: "EQ", value }] : []));
      const rows = await search(run, "search_deals", "hs_lastmodifieddate", [...DEAL, ENTERED], filters);
      // a deal edited some other way, in a stage it entered long ago, hasn't moved (and nothing noted it the first time)
      const moved = rows.filter((r) => !r.properties[ENTERED] || Date.now() - Date.parse(r.properties[ENTERED]!) < DAY_MS);
      return moved.map((row) => ({ id: `${row.id}:${row.properties.dealstage}:${row.properties[ENTERED] ?? ""}`, item: { deal: row } }));
    },
  },
};
