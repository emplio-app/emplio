// How Bing gets round the site: what it crawled each day, the pages it tripped over, how fast it is
// allowed to crawl, and what it knows about one page or one folder.
import { z } from "zod";
import type { OwnAction } from "../index";
import { pageOf, r, shaped, siteUrl, tag, url } from "./client";

// Bing's filters for a folder listing, each a number; "any" means don't filter on it
const CRAWLED_WHEN = { any: 0, last_week: 1, last_two_weeks: 2, last_three_weeks: 4 } as const;
const FOUND_WHEN = { any: 0, last_week: 1, last_month: 2 } as const;
const FLAGS = { any: 0, blocked_by_robots_txt: 1, has_malware: 2 } as const;
const HTTP_CODE = { any: 0, worked_2xx: 1, moved_3xx: 2, moved_301: 4, moved_302: 8, not_found_4xx: 16, server_error_5xx: 32, anything_else: 64 } as const;

export const crawlActions: Record<string, OwnAction> = {
  // ── crawling
  get_crawl_stats: r("GET", "GetCrawlStats", "Day by day for the last few weeks: how many of the site's pages Bing crawled, how many are in its index, how many links it found, and how many came back as not found, redirected, a server error, blocked by robots.txt or carrying malware.", {
    siteUrl,
  }),
  get_crawl_issues: r("GET", "GetCrawlIssues", "The pages Bing had trouble with: for each one its address, the status it returned, how many links point at it, and what went wrong (not found, redirected, server error, blocked by robots.txt, malware, DNS trouble or a timeout).", {
    siteUrl,
  }),
  get_crawl_settings: r("GET", "GetCrawlSettings", "How fast Bing is allowed to crawl this site: a figure for each of the 24 hours of the day, and whether the faster crawl option is available and switched on.", {
    siteUrl,
  }),
  save_crawl_settings: shaped(
    "SaveCrawlSettings",
    "Change how fast Bing may crawl this site, hour by hour. Slow it down during busy trading hours; speed it up overnight. Bing only accepts the faster crawl option on sites it offers it for.",
    {
      siteUrl,
      crawlRate: z
        .array(z.number().int().min(1).max(10))
        .length(24)
        .describe("One figure for each hour of the day, starting at midnight, from 1 (crawl as little as possible) to 10 (crawl as much as Bing likes). All 24 must be given."),
      crawlBoostEnabled: z.boolean().optional().describe("true asks Bing to crawl faster than normal where it offers that (default false); Bing ignores it on sites without the option"),
      crawlBoostAvailable: z.boolean().optional().describe("Leave this out; it is Bing telling you whether the faster crawl is on offer, not a setting you choose"),
    },
    (i) => ({
      siteUrl: i.siteUrl,
      crawlSettings: {
        ...tag("CrawlSettings"),
        CrawlBoostAvailable: i.crawlBoostAvailable ?? false,
        CrawlBoostEnabled: i.crawlBoostEnabled ?? false,
        CrawlRate: i.crawlRate,
      },
    }),
  ),

  // ── what Bing knows about one page or folder
  get_url_info: r("GET", "GetUrlInfo", "What Bing knows about one page: when it found it, when it last crawled it, the status the page returned, its size, how many links point at it, and how many pages sit under it.", {
    siteUrl,
    url: url("The page or folder to look up, in full, e.g. https://example.com/shop/kettles"),
  }),
  get_children_url_info: shaped(
    "GetChildrenUrlInfo",
    "What Bing knows about the pages inside one folder of the site, a page of results at a time. Use the filters to see only pages Bing crawled recently, only ones it found recently, only ones that returned a certain status, or only ones blocked by robots.txt or carrying malware.",
    {
      siteUrl,
      url: url("The folder to look inside, e.g. https://example.com/shop/ (use the site's own address for the top level)"),
      page: pageOf("results"),
      crawledWhen: z.enum(["any", "last_week", "last_two_weeks", "last_three_weeks"]).optional().describe('Only pages Bing crawled in that window; "any" or left out means no limit'),
      foundWhen: z.enum(["any", "last_week", "last_month"]).optional().describe('Only pages Bing first found in that window; "any" or left out means no limit'),
      flagged: z.enum(["any", "blocked_by_robots_txt", "has_malware"]).optional().describe('Only pages with that problem; "any" or left out means no limit'),
      httpCode: z
        .enum(["any", "worked_2xx", "moved_3xx", "moved_301", "moved_302", "not_found_4xx", "server_error_5xx", "anything_else"])
        .optional()
        .describe('Only pages that answered Bing that way; "any" or left out means no limit'),
    },
    (i) => ({
      siteUrl: i.siteUrl,
      url: i.url,
      page: i.page ?? 0,
      filterProperties: {
        ...tag("FilterProperties"),
        CrawlDateFilter: CRAWLED_WHEN[(i.crawledWhen ?? "any") as keyof typeof CRAWLED_WHEN],
        DiscoveredDateFilter: FOUND_WHEN[(i.foundWhen ?? "any") as keyof typeof FOUND_WHEN],
        DocFlagsFilters: FLAGS[(i.flagged ?? "any") as keyof typeof FLAGS],
        HttpCodeFilters: HTTP_CODE[(i.httpCode ?? "any") as keyof typeof HTTP_CODE],
      },
    }),
    // it only looks things up, even though Bing wants it as a POST
    { readOnly: true },
  ),
  get_url_traffic_info: r("GET", "GetUrlTrafficInfo", "How one page did in Bing search: how many times it was shown and how many times people clicked it.", {
    siteUrl,
    url: url("The page to look up, in full, e.g. https://example.com/shop/kettles"),
  }),
  get_children_url_traffic_info: r("GET", "GetChildrenUrlTrafficInfo", "How the pages inside one folder did in Bing search: clicks and times shown for each, a page of results at a time.", {
    siteUrl,
    url: url("The folder to look inside, e.g. https://example.com/shop/"),
    page: pageOf("results"),
  }),
};
