import { z } from "zod";
import type { PollTrigger, Run } from "./index";

// Zoho Campaigns can't register webhooks through its API (they're set up by hand per list in its settings), so lists are compared at each check.
// ponytail: the newest 200 contacts per list and at most 25 lists; more than that between checks would miss some
const every = { every: 15, min: 5 };
const list = { listkey: z.string().optional().describe("Only this mailing list (its listkey); leave out for all lists") };
type List = { listkey: string; listname?: string };

const lists = async (run: Run, listkey?: string): Promise<List[]> => {
  if (listkey) return [{ listkey }];
  const out = (await run("zoho_campaigns.list_mailing_lists", { sort: "desc", range: 25 })) as { list_of_details?: List[] };
  return out.list_of_details ?? [];
};

const contacts = (status: string) =>
  async ({ listkey }: { listkey?: string }, run: Run) => {
    const found = [];
    for (const l of await lists(run, listkey)) {
      const out = (await run("zoho_campaigns.list_mailing_list_contacts", { listkey: l.listkey, status, sort: "desc", range: 200 })) as { list_of_details?: any[] };
      for (const contact of out.list_of_details ?? []) found.push({ id: `${l.listkey}:${contact.contact_email}`, item: { contact, list: { listkey: l.listkey, listname: l.listname } } });
    }
    return found;
  };

const contactOutput: PollTrigger["output"] = [
  { name: "contact", type: "object", required: true, description: "The contact: contact_email, firstname, lastname, companyname, phone" },
  { name: "list", type: "object", required: true, description: "The mailing list: listkey, listname (listname only when watching all lists)" },
];

export const zoho_campaigns: Record<string, PollTrigger> = {
  new_subscriber: {
    description: "Someone new joins a mailing list (signed up or added).",
    config: z.object(list),
    output: contactOutput,
    ...every,
    poll: contacts("active"),
  },
  contact_unsubscribed: {
    description: "A contact unsubscribes from a mailing list.",
    config: z.object(list),
    output: contactOutput,
    ...every,
    poll: contacts("unsub"),
  },
  campaign_sent: {
    description: "A campaign has been sent. Good for sending its report to the team a little later.",
    config: z.object({}),
    output: [{ name: "campaign", type: "object", required: true, description: "The campaign: campaign_key, campaign_name, campaign_status, created_time" }],
    ...every,
    async poll(_config, run) {
      const out = (await run("zoho_campaigns.list_recent_campaigns", { status: "sent", sort: "desc", range: 100 })) as { recent_campaigns?: any[] };
      return (out.recent_campaigns ?? []).map((campaign) => ({ id: String(campaign.campaign_key), item: { campaign } }));
    },
  },
};
