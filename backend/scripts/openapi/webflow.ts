// Webflow: what the generator (../openapi-actions.ts) can't tell from the spec. One spec, the Data API v2, read from
// Webflow's own GitHub repository. The person connects with a site API token, so calls that need an OAuth app's token
// or a workspace token are left out (COVERAGE.md lists them).
import type { AppConfig } from "../openapi-actions";
import { composioNames, namer } from "./composio-names";

const OUT = "src/integrations/own/webflow/actions.json";
const OAUTH = "needs a token from a Webflow OAuth app; a site API token is refused";
const WORKSPACE = "needs an Enterprise workspace token; a site API token is refused";

export default {
  spec: "https://raw.githubusercontent.com/webflow/openapi-spec/main/openapi/v2.yml",
  out: OUT,
  name: namer(await composioNames("webflow")),
  skip: {
    authorized_by: OAUTH,
    introspect: OAUTH,
    "get-page-custom-code": OAUTH,
    "delete-page-custom-code": OAUTH,
    "add-custom-code-to-page": OAUTH,
    "get-site-custom-code": OAUTH,
    "delete-site-custom-code": OAUTH,
    "add-custom-code-tosite": OAUTH,
    "get-scripts": OAUTH,
    "post-hosted-script": OAUTH,
    "post-inline-scripts": OAUTH,
    "get-site-custom-code-blocks": OAUTH,
    "create-site": WORKSPACE,
    "get-workspace-audit-logs": WORKSPACE,
  },
  // Composio's names for the same calls, so skills and automations made with Composio's Webflow keep working
  rename: {
    list_sites: "list_webflow_sites",
    get_site: "get_site_info",
    get_collection_details: "get_collection",
    get_page_metadata: "get_page",
    get_page_content: "get_page_dom",
    list_inventory: "get_item_inventory",
    create_collection_item_s: "create_collection_item",
    create_live_collection_item_s: "create_live_collection_item",
    create_collection_items: "create_bulk_collection_items",
    publish_collection_item: "publish_collection_items",
  },
  params: {
    site_id: "The Webflow site's id (list_webflow_sites gives it; a site API token covers one site)",
  },
  // query params Webflow reads in bracket notation (createdOn[gte]=..., filter[country][eq]=US); own/webflow/index.ts
  // sends these as brackets, where the generic runner would send JSON
  after: async () => {
    const file = new URL(`../../${OUT}`, import.meta.url).pathname;
    const out = await Bun.file(file).json();
    for (const a of out.actions) {
      const deep = a.send.query.filter((q: string) => a.input.properties[q]?.type === "object");
      if (deep.length) a.deep = deep;
      // the spec gives ids a default of null, which would fill the path with "null" instead of asking for the id
      for (const p of Object.values<Record<string, unknown>>(a.input.properties)) if (p.default === null) delete p.default;
    }
    await Bun.write(file, JSON.stringify(out));
  },
  // a webhook made with a site token carries its signing key
  secrets: ["list_webhooks", "get_webhook"],
} satisfies AppConfig;
