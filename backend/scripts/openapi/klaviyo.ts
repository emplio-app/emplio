// Klaviyo: what the generator (../openapi-actions.ts) can't tell from the spec. Klaviyo's spec sends JSON:API bodies as
// application/vnd.api+json, which the generator doesn't read, so a copy with plain application/json (Klaviyo takes both)
// is written to the temp folder and generated from.
import { tmpdir } from "node:os";
import type { AppConfig } from "../openapi-actions";
import { composioNames, namer } from "./composio-names";

const SPEC = "https://raw.githubusercontent.com/klaviyo/openapi/main/openapi/stable.json";
const local = `${tmpdir()}/klaviyo-openapi.json`;
await Bun.write(local, (await (await fetch(SPEC)).text()).replaceAll('"application/vnd.api+json"', '"application/json"'));

const theirs = await composioNames("klaviyo");
const known = new Set(theirs);
const byName = namer(theirs);
const used = new Set<string>();

export default {
  spec: local,
  out: "src/integrations/own/klaviyo/actions.json",
  // Klaviyo lists each call's old names (x-klaviyo-operation-aliases); Composio often uses one of those
  name: (id, method, path, op) => {
    const guess = byName((op["x-klaviyo-operation-aliases"] ?? []).find((a: string) => known.has(a)) ?? id, method, path, op);
    // Klaviyo's operation ids are good names already; only Composio's own name replaces one
    const name = known.has(guess) ? guess : id;
    if (used.has(name)) return id;
    used.add(name);
    return name;
  },
  // the API version goes on every call by itself (index.ts)
  drop: { "*": ["revision"] },
  reads: ["query_campaign_values", "query_flow_values", "query_flow_series", "query_form_values", "query_form_series", "query_segment_values", "query_segment_series", "query_metric_aggregates", "create_template_render"],
  params: {
    "page[cursor]": "Where the next page starts: the cursor in the previous answer's links.next. Leave out for the first page",
    "page[size]": "How many to return per page",
    include: "Related things to return alongside, by relationship name (see the allowed values)",
    company_id: "Your Klaviyo public API key (site id), 6 characters; get_accounts shows it as public_api_key",
  },
} satisfies AppConfig;
