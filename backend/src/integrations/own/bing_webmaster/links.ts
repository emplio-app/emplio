// Links: who links to the site and to which pages, pages you tell Bing link to you, and the extra links
// Bing sometimes shows underneath a result (deep links).
import { z } from "zod";
import type { OwnAction } from "../index";
import { pageOf, r, shaped, siteUrl, url } from "./client";

const WEIGHT = { off: 0, low: 1, normal: 2, high: 3 } as const;

export const linkActions: Record<string, OwnAction> = {
  // ── links pointing at the site
  get_link_counts: r("GET", "GetLinkCounts", "The site's pages that have links pointing at them from elsewhere, each with how many links it has, a page of results at a time.", {
    siteUrl,
    page: pageOf("results"),
  }),
  get_url_links: r("GET", "GetUrlLinks", "The pages elsewhere that link to one page of this site, each with the wording of the link, a page of results at a time.", {
    siteUrl,
    link: url("The page of yours to look up, in full, e.g. https://example.com/shop/kettles"),
    page: pageOf("results"),
  }),
  get_connected_pages: r("GET", "GetConnectedPages", "Pages elsewhere that you have told Bing link to this site (your social profiles, listings, a partner's page), each with whether Bing has verified the link and when.", {
    siteUrl,
  }),
  add_connected_page: r("POST", "AddConnectedPage", "Tell Bing about a page elsewhere that links to this site, such as your own profile on another site. Bing checks the page really links here.", {
    siteUrl,
    masterUrl: url("The page elsewhere that links to you, in full, e.g. https://www.facebook.com/yourshop"),
  }),

  // ── deep links: the extra links Bing can show under a search result
  get_deep_link_blocks: r("GET", "GetDeepLinkBlocks", "The deep links you have told Bing not to show under this site's search results, each with the search page and the market it was blocked for.", {
    siteUrl,
  }),
  add_deep_link_block: r("POST", "AddDeepLinkBlock", "Stop Bing showing one of your pages as an extra link underneath a search result. Use it when an out-of-date or unhelpful page keeps appearing there.", {
    siteUrl,
    market: z.string().min(2).describe('The Bing market it applies to, as language and country, e.g. "en-GB", "en-US", "en-IN"'),
    searchUrl: url("The page of yours whose result the extra links appear under, in full, e.g. https://example.com"),
    deepLinkUrl: url("The page of yours to stop showing as an extra link, in full, e.g. https://example.com/old-offer"),
  }),
  remove_deep_link_block: r("POST", "RemoveDeepLinkBlock", "Let Bing show a deep link it was told to hide. Use the market and addresses exactly as bing_webmaster.get_deep_link_blocks shows them.", {
    siteUrl,
    market: z.string().min(2).describe('The market on the block, as get_deep_link_blocks shows it, e.g. "en-GB"'),
    searchUrl: url("The search page on the block, as get_deep_link_blocks shows it"),
    deepLinkUrl: url("The blocked page, as get_deep_link_blocks shows it"),
  }),
  // Bing marks these three obsolete; they stay here so nothing in the API is out of reach, but they may
  // answer with nothing at all
  get_deep_link: r("GET", "GetDeepLink", "The extra links Bing shows under one page's search result, with their wording and order. Bing has retired this call, so it may answer with nothing.", {
    siteUrl,
    url: url("The page whose search result to look at, in full"),
  }),
  get_deep_link_algo_urls: r("GET", "GetDeepLinkAlgoUrls", "The site's pages whose search results Bing adds extra links to, with how many links each has. Bing has retired this call, so it may answer with nothing.", {
    siteUrl,
  }),
  update_deep_link: shaped(
    "UpdateDeepLink",
    "Ask Bing to show one extra link more or less prominently under a page's search result. Bing has retired this call; block the link with add_deep_link_block instead.",
    {
      siteUrl,
      algoUrl: url("The page whose search result the extra link appears under, in full"),
      deepLink: url("The extra link's page, in full"),
      weight: z.enum(["off", "low", "normal", "high"]).describe('How prominently to show it; "off" stops it being shown'),
    },
    (i) => ({ siteUrl: i.siteUrl, algoUrl: i.algoUrl, deepLink: i.deepLink, weight: WEIGHT[i.weight as keyof typeof WEIGHT] }),
  ),
};
