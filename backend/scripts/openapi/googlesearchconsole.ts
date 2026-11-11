// Google Search Console: every method in its Discovery document, under Composio's names where it has one.
import { GOOGLE_SCOPES } from "../../src/integrations/own/google-login";
import type { AppConfig } from "../openapi-actions";
import { discovery } from "./google-discovery";

export default {
  // the mobile-friendly test was shut down by Google in December 2023 and asks for no scope at all
  spec: await discovery("https://searchconsole.googleapis.com/$discovery/rest?version=v1", "googlesearchconsole", GOOGLE_SCOPES.googlesearchconsole, [
    "searchconsole.urlTestingTools.mobileFriendlyTest.run",
  ]),
  out: "src/integrations/own/googlesearchconsole/actions.json",
  rename: {
    sites_list: "list_sites",
    sites_get: "get_site",
    sites_add: "add_site",
    sites_delete: "delete_site",
    sitemaps_list: "list_sitemaps",
    sitemaps_get: "get_sitemap",
    sitemaps_submit: "submit_sitemap",
    sitemaps_delete: "delete_sitemap",
    searchanalytics_query: "search_analytics_query",
    url_inspection_index_inspect: "inspect_url",
  },
  // POSTs that only look things up
  reads: ["search_analytics_query", "inspect_url"],
  params: {
    siteUrl: 'The site in Search Console, exactly as it is listed there: "https://example.com/" for a URL-prefix property (keep the trailing slash) or "sc-domain:example.com" for a domain property',
    feedpath: 'The sitemap\'s full address, e.g. "https://example.com/sitemap.xml"',
  },
} satisfies AppConfig;
