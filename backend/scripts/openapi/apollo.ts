// Apollo.io: what the generator (../openapi-actions.ts) can't tell from the spec. Apollo publishes one OpenAPI file,
// regenerated with its docs. Its descriptions open with an "Endpoint essentials" table (key access, OAuth scope, credits)
// in HTML or markdown; that is boiled down here to one "Credits: ..." line up front, and the rest of the HTML to text,
// before the generator reads it. docs.apollo.io sits behind a bot check that sometimes refuses scripts: then download
// the file in a browser and run  APOLLO_SPEC=/path/apollo-rest-api.json bun scripts/openapi-actions.ts apollo
import { tmpdir } from "node:os";
import type { AppConfig } from "../openapi-actions";
import { composioNames, namer } from "./composio-names";

const URL_ = "https://docs.apollo.io/openapi/apollo-rest-api.json";
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";
type Schema = Record<string, any>;

const text = (s: string) =>
  s
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|li|tr|div|h\d)>/gi, "\n")
    .replace(/<li>/gi, "- ")
    .replace(/<a [^>]*>(.*?)<\/a>/gis, "$1")
    .replace(/<[^>]+>/g, "")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .replace(/\n{2,}/g, "\n")
    .trim();

// "Credit usage: `1 credit per company` — Learn more..." and "Plan access: ..." out of the essentials, the rest dropped
export function essentials(raw: string) {
  let body = raw;
  const facts: string[] = [];
  const grab = (label: string) => {
    const m = new RegExp(`${label}(?:</strong>)?\\s*(?:</td>\\s*<td[^>]*>|:\\*\\*)\\s*([\\s\\S]*?)(?:</td>|\\n\\n|$)`, "i").exec(body);
    return m ? text(m[1]!).replace(/\s*—.*$/s, "").replace(/`/g, "").replace(/\.$/, "") : undefined;
  };
  const credits = grab("Credit usage");
  const plan = grab("Plan access");
  const free = grab("Free account access");
  // only a call that spends credits says so; index.ts makes those ask first
  if (credits && !/^0 credits?$/i.test(credits)) facts.push(`Credits: ${credits}.`);
  if (plan) facts.push(`Plan: ${plan}.`);
  if (free) facts.push(`Free plan: ${free}.`);
  body = body
    .replace(/<table>[\s\S]*?Endpoint essentials[\s\S]*?<\/table>/i, "")
    .replace(/^#+ Endpoint essentials\s*$/im, "")
    .replace(/^\*\*(API key access|OAuth scopes|Credit usage|Plan access|Free account access|Authentication note):\*\*.*$/gim, "");
  return [...facts, text(body)].filter(Boolean).join(" ");
}

function tidy(node: unknown, key?: string): void {
  if (Array.isArray(node)) return node.forEach((n) => tidy(n));
  if (!node || typeof node !== "object") return;
  const o = node as Schema;
  for (const [k, v] of Object.entries(o)) {
    if (k === "description" && typeof v === "string") o[k] = key === "op" ? essentials(v) : text(v);
    else if (k === "summary" && typeof v === "string") o[k] = text(v).replace(/^\[BETA\]\s*/i, "");
    else tidy(v, ["get", "post", "put", "patch", "delete"].includes(k) ? "op" : undefined);
  }
}

const raw = process.env.APOLLO_SPEC ? await Bun.file(process.env.APOLLO_SPEC).text() : await (await fetch(URL_, { headers: { "User-Agent": UA } })).text();
if (!raw.trimStart().startsWith("{")) throw new Error("docs.apollo.io refused the download (bot check); download it in a browser and set APOLLO_SPEC");
const spec = JSON.parse(raw) as Schema;
tidy(spec.paths);
const cleaned = `${tmpdir()}/apollo-openapi.json`;
await Bun.write(cleaned, JSON.stringify(spec));

export default {
  spec: cleaned,
  out: "src/integrations/own/apollo/actions.json",
  name: namer(await composioNames("apollo")),
  // Composio's names for the same calls, so skills and automations written for it carry over
  rename: {
    people_api_search: "people_search",
    company_job_postings: "get_organization_job_postings",
    update_account_owner_for_multiple_accounts: "update_account_owners",
    view_account: "get_account",
    view_contact: "get_contact",
    view_deal: "get_deal",
    update_deal: "update_deals",
    list_deal_stages: "get_opportunity_stages",
    check_email_stats: "get_email_activities",
    create_call_records: "create_call_record",
    update_call_records: "update_call_record",
    get_list_of_users: "list_users",
    get_list_of_email_accounts: "list_email_accounts",
    get_list_of_lists: "get_labels",
    update_list: "update_label",
    get_list_of_fields: "list_fields",
    get_list_of_notes: "list_notes",
    get_complete_company_info: "get_organization",
    view_api_usage_stats_and_rate_limits: "view_api_usage_stats",
    get_conversations_info: "get_conversation",
    get_conversations_export: "get_conversation_export",
  },
  // POSTs that only look things up and spend no credits, so they run without asking
  reads: [
    "people_search",
    "search_accounts",
    "search_contacts",
    "view_associated_deals",
    "search_sequences",
    "search_tasks",
    "get_email_content",
    "check_email_send_status",
    "get_contact_sequence_activity",
    "view_credit_usage_stats",
    "view_api_usage_stats",
    "query_analytics_report",
    "search_conversations",
    "poll_assistant_task",
  ],
} satisfies AppConfig;
