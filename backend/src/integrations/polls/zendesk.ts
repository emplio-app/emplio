// Zendesk triggers checked every few minutes through search, for logins that aren't a Zendesk admin's (only admins can
// set up the webhooks own/zendesk/triggers.ts uses). Names are Composio's where it has the trigger.
import { z } from "zod";
import { recent, type PollTrigger } from "./index";

type Found = { id: number; created_at?: string; updated_at?: string };
const CONFIG = z.object({
  query: z.string().optional().describe('More Zendesk search words to narrow it, e.g. "status:open tags:vip" or "group:Billing"'),
});

// ponytail: the 100 newest search results; a busier day than that misses some (Zendesk's own search also lags a minute or two)
const searched = (description: string, type: string, field: string, by: "created" | "updated"): PollTrigger => ({
  description,
  config: CONFIG,
  output: [{ name: field, type: "object", required: true, description: `The Zendesk ${field} as it is now` }],
  every: 5,
  min: 2,
  async poll({ query }, run) {
    const out = (await run("zendesk.search_zendesk", {
      query: `type:${type} ${by}>24hours${query ? ` ${query}` : ""}`,
      sort_by: `${by}_at`,
      sort_order: "desc",
      per_page: 100,
    })) as { results?: Found[] };
    return (out.results ?? [])
      .filter((r) => recent(by === "created" ? r.created_at : r.updated_at))
      .map((r) => ({ id: by === "created" ? String(r.id) : `${r.id}:${r.updated_at}`, item: { [field]: r } }));
  },
});

export const zendesk: Record<string, PollTrigger> = {
  new_zendesk_ticket_trigger: searched("A new Zendesk ticket is created (checked every 5 minutes; works without an admin's login).", "ticket", "ticket", "created"),
  zendesk_ticket_updated: searched("A Zendesk ticket is created or changed in any way (checked every 5 minutes; works without an admin's login). A run that changes the ticket starts this again.", "ticket", "ticket", "updated"),
  new_user_trigger: searched("A new person is added in Zendesk, a customer or a team member (checked every 5 minutes; works without an admin's login).", "user", "user", "created"),
  new_zendesk_organization: searched("A new organization (a customer company) is added in Zendesk (checked every 5 minutes; works without an admin's login).", "organization", "organization", "created"),
};
