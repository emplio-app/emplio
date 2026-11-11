// Bing Webmaster Tools tells nobody when something changes, so everything here is polled: Emplio reads the
// site's figures and compares them with last time. Bing's own numbers only move about once a day, so the
// default is a daily check and the least allowed is hourly.
//
// Polling only ever reports items it hasn't seen before, so "it got worse" is written as a state folded
// into the item's id: a page whose index status flips, or a search term whose position moves, gets a new
// id and so counts as something new. That means these triggers also fire on the way back up — a sitemap
// that starts working again, a page that returns to the index — and the item says which way it went.
import { z } from "zod";
import type { PollTrigger } from "./index";

const SITE = { site_url: z.string().describe("The website in Bing Webmaster Tools, e.g. https://example.com") };
const DAILY = { every: 1440, min: 60 };

// Bing's crawl problems are a bit field; these are the names it uses for them
const ISSUES: [number, string][] = [
  [1, "redirected (301)"],
  [2, "redirected (302)"],
  [4, "not found or refused (4xx)"],
  [8, "server error (5xx)"],
  [16, "blocked by robots.txt"],
  [32, "carrying malware"],
  [64, "an important page blocked by robots.txt"],
  [128, "a DNS problem"],
  [256, "timed out"],
];
const named = (flags: number) => ISSUES.filter(([bit]) => flags & bit).map(([, name]) => name);

export const bing_webmaster: Record<string, PollTrigger> = {
  crawl_error_found: {
    description: "Bing hits a new problem on a page of your website, or the problem on a page changes (not found, a server error, blocked by robots.txt, malware, a DNS problem or a timeout). Checked once a day by default.",
    config: z.object(SITE),
    output: [
      { name: "url", type: "string", required: true, description: "The page Bing had trouble with" },
      { name: "problems", type: "string[]", required: true, description: "What went wrong, in words, e.g. [\"not found or refused (4xx)\"]" },
      { name: "http_code", type: "number", required: true, description: "The status the page gave Bing, e.g. 404" },
      { name: "links_to_it", type: "number", required: true, description: "How many links point at this page, so you can judge how much it matters" },
      { name: "issue", type: "object", required: true, description: "Bing's own row for the page: Url, HttpCode, Issues (a number), InLinks" },
    ],
    ...DAILY,
    async poll({ site_url }, run) {
      const rows = ((await run("bing_webmaster.get_crawl_issues", { siteUrl: site_url })) ?? []) as { Url?: string; HttpCode?: number; Issues?: number; InLinks?: number }[];
      return (Array.isArray(rows) ? rows : [])
        .filter((row) => row.Url)
        .map((issue) => ({
          // the page plus what's wrong with it: a page whose problem changes counts as something new
          id: `${issue.Url}:${issue.Issues ?? 0}:${issue.HttpCode ?? 0}`,
          item: { url: issue.Url, problems: named(issue.Issues ?? 0), http_code: issue.HttpCode ?? 0, links_to_it: issue.InLinks ?? 0, issue },
        }));
    },
  },

  sitemap_status_changed: {
    description: "A sitemap of your website changes status in Bing — most usefully when Bing starts failing to read it, and again when it works once more. Checked once a day by default.",
    config: z.object(SITE),
    output: [
      { name: "url", type: "string", required: true, description: "The sitemap's address" },
      { name: "status", type: "string", required: true, description: "What Bing makes of it now, e.g. Success, Error, Pending" },
      { name: "failing", type: "boolean", required: true, description: "true when Bing is not reading it successfully" },
      { name: "sitemap", type: "object", required: true, description: "Bing's own row: Url, Status, UrlCount, FileSize, LastCrawled, Submitted, Compressed" },
    ],
    ...DAILY,
    async poll({ site_url }, run) {
      const rows = ((await run("bing_webmaster.get_feeds", { siteUrl: site_url })) ?? []) as { Url?: string; Status?: string }[];
      return (Array.isArray(rows) ? rows : [])
        .filter((row) => row.Url)
        .map((sitemap) => ({
          id: `${sitemap.Url}:${sitemap.Status ?? "unknown"}`,
          item: { url: sitemap.Url, status: sitemap.Status ?? "unknown", failing: (sitemap.Status ?? "").toLowerCase() !== "success", sitemap },
        }));
    },
  },

  page_index_status_changed: {
    description: "A page you name drops out of Bing's index, or comes back into it. Give the pages to watch — your home page, a key product page. Checked once a day by default.",
    config: z.object({
      ...SITE,
      pages: z.array(z.string()).min(1).max(20).describe('The pages to watch, in full, up to 20, e.g. ["https://example.com", "https://example.com/shop"]'),
    }),
    output: [
      { name: "url", type: "string", required: true, description: "The page being watched" },
      { name: "in_index", type: "boolean", required: true, description: "true when Bing has the page in its index now, false when it has dropped out" },
      { name: "page", type: "object", required: true, description: "What Bing knows about it: Url, HttpStatus, LastCrawledDate, DiscoveryDate, DocumentSize, AnchorCount" },
    ],
    ...DAILY,
    async poll({ site_url, pages }, run) {
      const out: { id: string; item: unknown }[] = [];
      for (const url of pages as string[]) {
        // a page Bing has never heard of answers with nothing, which counts as out of the index
        const page = (await run("bing_webmaster.get_url_info", { siteUrl: site_url, url }).catch(() => null)) as { Url?: string; HttpStatus?: number } | null;
        const inIndex = Boolean(page?.Url);
        out.push({ id: `${url}:${inIndex ? "in" : "out"}`, item: { url, in_index: inIndex, page: page ?? {} } });
      }
      return out;
    },
  },

  keyword_position_changed: {
    description: "A search term's average position in Bing moves for your website, up or down. Optionally only the terms you name, and only moves big enough to matter. Checked once a day by default.",
    config: z.object({
      ...SITE,
      queries: z.array(z.string()).optional().describe('Only these search terms, e.g. ["copper kettle"]; left out, every term Bing reports for the site'),
      step: z
        .number()
        .int()
        .min(1)
        .max(20)
        .optional()
        .describe("How many places wide each step is: with 5, positions 10 to 14 count as the same and a move to 15 counts as news (default 1, so every move counts)"),
    }),
    output: [
      { name: "query", type: "string", required: true, description: "The search term" },
      { name: "position", type: "number", required: true, description: "Its average position in Bing's results now (1 is the top)" },
      { name: "clicks", type: "number", required: true, description: "Clicks it brought in the period Bing reports" },
      { name: "impressions", type: "number", required: true, description: "How many times the site was shown for it" },
      { name: "stats", type: "object", required: true, description: "Bing's own row: Query, AvgImpressionPosition, AvgClickPosition, Clicks, Impressions, Date" },
    ],
    ...DAILY,
    async poll({ site_url, queries, step }, run) {
      const rows = ((await run("bing_webmaster.get_query_stats", { siteUrl: site_url })) ?? []) as { Query?: string; AvgImpressionPosition?: number; Clicks?: number; Impressions?: number }[];
      const only = (queries as string[] | undefined)?.map((q) => q.toLowerCase());
      const band = (step as number | undefined) ?? 1;
      return (Array.isArray(rows) ? rows : [])
        .filter((row) => row.Query && (!only?.length || only.includes(row.Query.toLowerCase())))
        .map((stats) => {
          const position = stats.AvgImpressionPosition ?? 0;
          return {
            // the term plus which step it sits in: a move inside one step isn't news
            id: `${stats.Query}:${Math.floor(position / band)}`,
            item: { query: stats.Query, position, clicks: stats.Clicks ?? 0, impressions: stats.Impressions ?? 0, stats },
          };
        });
    },
  },
};
