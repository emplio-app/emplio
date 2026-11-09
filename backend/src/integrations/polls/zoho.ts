import { z } from "zod";
import { DEFAULT_FIELDS } from "../own/zoho";
import type { PollTrigger, Run } from "./index";

// Zoho CRM's webhooks (notification channels) need renewing every day and a public address per channel; comparing the newest 200 is enough here.
// ponytail: newest 200 per module; more than 200 changes between checks would miss some
const every = { every: 10, min: 5 };
const fields = { fields: z.string().optional().describe("Fields to include, as API names with commas (default: the common ones)") };
const output = (name: string, module: string): PollTrigger["output"] => [{ name, type: "object", required: true, description: `The ${module} record: id, the fields asked for, Created_Time, Modified_Time` }];
const records = async (run: Run, module: string, sortBy: "Created_Time" | "Modified_Time", given?: string) => {
  const out = (await run("zoho.get_zoho_records", { module, fields: given ?? DEFAULT_FIELDS[module], sort_by: sortBy, sort_order: "desc", per_page: 200 })) as { data?: any[] };
  return out.data ?? [];
};

const pair = (one: string, module: string): Record<string, PollTrigger> => ({
  [`new_${one}`]: {
    description: `A new ${one} is added in Zoho CRM.`,
    config: z.object(fields),
    output: output(one, module),
    ...every,
    async poll({ fields: given }, run) {
      return (await records(run, module, "Created_Time", given)).map((r) => ({ id: String(r.id), item: { [one]: r } }));
    },
  },
  [`${one}_updated`]: {
    description: `A ${one} is changed in Zoho CRM (a new one counts as well). If the automation itself changes the ${one}, that sets this off again.`,
    config: z.object(fields),
    output: output(one, module),
    ...every,
    async poll({ fields: given }, run) {
      return (await records(run, module, "Modified_Time", given)).map((r) => ({ id: `${r.id}:${r.Modified_Time}`, item: { [one]: r } }));
    },
  },
});

export const zoho: Record<string, PollTrigger> = { ...pair("lead", "Leads"), ...pair("contact", "Contacts"), ...pair("deal", "Deals") };
