// How the site is doing in Bing and Copilot search: clicks and times shown, by day, by search term and by
// page — plus Bing's own figures for how often a search term is typed, whoever's site it leads to.
import type { OwnAction } from "../index";
import { country, day, language, r, siteUrl, url } from "./client";

export const trafficActions: Record<string, OwnAction> = {
  // ── the site as a whole
  get_rank_and_traffic_stats: r("GET", "GetRankAndTrafficStats", "Day by day for roughly the last six months: how many times the site was shown in Bing search and how many times people clicked through to it.", {
    siteUrl,
  }),

  // ── by search term
  get_query_stats: r("GET", "GetQueryStats", "The search terms bringing the most people to this site, each with clicks, times shown, and the average position the site sat at in the results.", {
    siteUrl,
  }),
  get_query_traffic_stats: r("GET", "GetQueryTrafficStats", "Day by day, how one search term did for this site: clicks and times shown on each date.", {
    siteUrl,
    query: url('The search term, exactly as bing_webmaster.get_query_stats shows it, e.g. "copper kettle"'),
  }),
  get_query_page_stats: r("GET", "GetQueryPageStats", "For one search term, which of the site's pages Bing showed for it, each with clicks, times shown and average position.", {
    siteUrl,
    query: url('The search term, e.g. "copper kettle"'),
  }),
  get_query_page_detail_stats: r("GET", "GetQueryPageDetailStats", "Day by day, how one page did for one search term: clicks, times shown and the position it sat at on each date.", {
    siteUrl,
    query: url('The search term, e.g. "copper kettle"'),
    page: url("The page's address, in full, e.g. https://example.com/shop/kettles"),
  }),

  // ── by page
  get_page_stats: r("GET", "GetPageStats", "The site's pages getting the most from Bing search, each with clicks, times shown and the average position it sat at.", {
    siteUrl,
  }),
  get_page_query_stats: r("GET", "GetPageQueryStats", "For one page, the search terms that brought people to it, each with clicks, times shown and average position.", {
    siteUrl,
    page: url("The page's address, in full, e.g. https://example.com/shop/kettles"),
  }),

  // ── what people are searching for, across Bing (no site needed)
  get_keyword: r("GET", "GetKeyword", "How often one search term was typed into Bing over a period, in one country and language — across the whole of Bing, not just this site. Good for judging whether a term is worth writing for.", {
    q: url('The search term to look up, e.g. "copper kettle"'),
    country,
    language,
    startDate: day("First day of the period"),
    endDate: day("Last day of the period"),
  }),
  get_keyword_stats: r("GET", "GetKeywordStats", "Month by month, how often one search term was typed into Bing, both exactly as written and as part of longer searches. Shows whether interest is rising or falling.", {
    q: url('The search term to look up, e.g. "copper kettle"'),
    country,
    language,
  }),
  get_related_keywords: r("GET", "GetRelatedKeywords", "Other search terms people type around one term, with how often each was typed over the period. Use it to find what else to write about.", {
    q: url('The search term to start from, e.g. "copper kettle"'),
    country,
    language,
    startDate: day("First day of the period"),
    endDate: day("Last day of the period"),
  }),
};
