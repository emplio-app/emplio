// lemlist things its webhooks don't report: new campaigns and new companies. Everything a lead does (opens, replies,
// clicks, LinkedIn, calls, unsubscribes...) comes by webhook (own/lemlist/triggers.ts).
import { z } from "zod";
import { recent, type PollTrigger } from "./index";

// a bare list, or {data} (companies), or {campaigns} (campaigns with version=v2, as the API answers today)
const rows = (out: unknown) => ((Array.isArray(out) ? out : ((out as { data?: unknown[] })?.data ?? (out as { campaigns?: unknown[] })?.campaigns)) ?? []) as any[];

export const lemlist: Record<string, PollTrigger> = {
  new_campaign: {
    description: "A campaign is created in lemlist (checked every 5 minutes).",
    config: z.object({}),
    output: [{ name: "campaign", type: "object", required: true, description: "The campaign: _id, name, status, labels, folderId, createdBy, createdAt" }],
    every: 5,
    min: 1,
    // ponytail: the newest 100; more than 100 new campaigns between polls are missed
    poll: async (_c, run) =>
      rows(await run("lemlist.get_many_campaigns", { version: "v2", sortBy: "createdAt", sortOrder: "desc", limit: 100 }))
        .filter((c) => recent(c.createdAt))
        .map((c) => ({ id: String(c._id), item: { campaign: c } })),
  },
  new_company: {
    description: "A company is added to lemlist's CRM (checked every 5 minutes). Optionally only in one company list.",
    config: z.object({ list_id: z.string().optional().describe("Only companies in this company list (its id, clt_...; get_company_lists lists them)") }),
    output: [{ name: "company", type: "object", required: true, description: "The company: _id, domain, fields (name, industry...), ownerId, createdAt" }],
    every: 5,
    min: 1,
    poll: async ({ list_id }, run) =>
      rows(await run("lemlist.list_companies", { sortBy: "createdAt", sortOrder: "desc", limit: 500, ...(list_id && { listId: list_id }) }))
        .filter((c) => recent(c.createdAt))
        .map((c) => ({ id: String(c._id), item: { company: c } })),
  },
};
