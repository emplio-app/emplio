// lemlist: what the generator (../openapi-actions.ts) can't tell from the spec. lemlist publishes one OpenAPI 3 file
// (linked from https://developer.lemlist.com/llms.txt). Most operations have no operationId, so one is made from the
// summary first (the call's path when two summaries are the same), and the result is saved next to the system's temp files.
import { tmpdir } from "node:os";
import type { AppConfig } from "../openapi-actions";
import { composioNames, namer } from "./composio-names";

type Schema = Record<string, any>;
const SPEC = "https://developer.lemlist.com/api-reference/openapi/v2.json";
const METHODS = ["get", "post", "put", "patch", "delete"];

const spec = (await (await fetch(SPEC)).json()) as Schema;
const words = (s: string) => s.replace(/&/g, "and").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
const used = new Set<string>();
for (const [path, ops] of Object.entries<Schema>(spec.paths))
  for (const [m, op] of Object.entries<Schema>(ops)) {
    if (!METHODS.includes(m) || op.operationId) continue;
    let id = words(op.summary ?? `${m} ${path}`);
    if (used.has(id)) id = words(`${m} ${path.replace(/[{}]/g, "")}`);
    used.add(id);
    op.operationId = id;
  }
const file = `${tmpdir()}/emplio-lemlist-openapi.json`;
await Bun.write(file, JSON.stringify(spec));

export default {
  spec: file,
  out: "src/integrations/own/lemlist/actions.json",
  name: namer(await composioNames("lemlist")),
  rename: {
    // "A/B" loses its "A" as an article
    create_b_test_variant: "create_ab_test_variant",
    get_b_test_variant: "get_ab_test_variant",
    update_b_test_variant: "update_ab_test_variant",
    delete_b_test_variant: "delete_ab_test_variant",
    select_b_test_winner: "select_ab_test_winner",
    delete_campaigns_campaignid_leads_email: "unsubscribe_lead_from_campaign_by_email",
    // Composio's names for the same calls (theirs that only add the HTTP method, like post_create_campaign, aren't copied)
    get_many_webhooks: "get_all_webhooks",
    get_campaign: "get_campaign_by_id",
    get_many_companies: "list_companies",
    get_company_notes: "list_company_notes",
    get_contact_lists: "list_contact_lists",
    get_many_contacts: "list_contacts",
    get_many_inboxes: "list_inbox_conversations",
    get_many_labels: "list_labels",
    add_and_update_contact: "upsert_contact",
    add_and_update_company: "upsert_company",
    send_email: "send_inbox_email",
    get_team: "get_team_info",
  },
  // Get Team answers with the team's Slack notification address, which lets anyone post into that Slack channel
  secrets: ["get_team_info"],
  // searches of lemlist's people and companies databases, and stats asked for in bulk: POSTs that only look things up
  reads: ["search_people_database", "search_linked_in_post_engagers", "search_companies_database", "get_batch_campaign_stats", "search_domains"],
} satisfies AppConfig;
