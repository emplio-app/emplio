// Search Console sends no webhooks, so these watch it by asking: the sites and sitemaps on the account, what Google
// says about one page, and how the site is doing in search against the period before.
// Its numbers are two to three days behind and only change about once a day, so checking every hour is plenty.
import { z } from "zod";
import type { PollTrigger, Run } from "./index";

const SITE = { site_url: z.string().describe('The site to watch, exactly as Search Console lists it: "https://example.com/" or "sc-domain:example.com"') };
const EVERY = { every: 60, min: 15 } as const;
const DAYS = z.number().int().min(1).max(240).default(7).describe("The length of each period in days (default 7, so the last 7 days against the 7 before them)");
const site = (description: string): PollTrigger["output"][number] => ({ name: "site_url", type: "string", required: true, description });

type Sitemap = { path: string; errors?: string; warnings?: string; lastDownloaded?: string; isPending?: boolean; type?: string };
const sitemaps = async (run: Run, site_url: string) => (((await run("googlesearchconsole.list_sitemaps", { siteUrl: site_url })) as { sitemap?: Sitemap[] }).sitemap ?? []);
const count = (v: unknown) => Number(v ?? 0);

const sitemapTrigger = (description: string, id: (s: Sitemap) => string, keep: (s: Sitemap) => boolean = () => true): PollTrigger => ({
  description,
  config: z.object(SITE),
  output: [site("The site in Search Console"), { name: "sitemap", type: "object", required: true, description: "The sitemap: path, type, lastSubmitted, lastDownloaded, errors, warnings, isPending, contents" }],
  ...EVERY,
  poll: async (c, run) => (await sitemaps(run, c.site_url)).filter(keep).map((sitemap) => ({ id: id(sitemap), item: { site_url: c.site_url, sitemap } })),
});

// the top rows by clicks over the period; an entry that wasn't there before is reported once
const topTrigger = (description: string, dimension: "QUERY" | "PAGE", field: string): PollTrigger => ({
  description,
  config: z.object({
    ...SITE,
    top: z.number().int().min(1).max(100).default(10).describe("How long the list is (default the top 10)"),
    days: z.number().int().min(1).max(480).default(28).describe("Over how many days (default 28)"),
    contains: z.string().optional().describe("Only search terms containing these words"),
  }),
  output: [
    site("The site in Search Console"),
    { name: field, type: "string", required: true, description: dimension === "QUERY" ? "The search term" : "The page's address" },
    { name: "stats", type: "object", required: true, description: "Its clicks, impressions, ctr and average position over the period" },
    { name: "rank", type: "number", required: true, description: "Where it sits in the list, 1 being the most clicks" },
  ],
  ...EVERY,
  async poll(c, run) {
    const res = (await run("googlesearchconsole.search_performance", { siteUrl: c.site_url, days: c.days, dimension, limit: c.top, contains: c.contains })) as {
      rows?: { key: string; clicks: number; impressions: number; ctr: number; position: number }[];
    };
    return (res.rows ?? []).map((r, n) => ({ id: `${dimension}:${r.key}`, item: { site_url: c.site_url, [field]: r.key, stats: { clicks: r.clicks, impressions: r.impressions, ctr: r.ctr, position: r.position }, rank: n + 1 } }));
  },
});

export const googlesearchconsole: Record<string, PollTrigger> = {
  new_site_trigger: {
    description: "A new site appears in Search Console for this Google account.",
    config: z.object({}),
    output: [site("The site that was added"), { name: "permission_level", type: "string", required: false, description: "What this account may do with it: siteOwner, siteFullUser, siteRestrictedUser or siteUnverifiedUser" }],
    ...EVERY,
    poll: async (_c, run) =>
      (((await run("googlesearchconsole.list_sites", {})) as { siteEntry?: { siteUrl: string; permissionLevel?: string }[] }).siteEntry ?? []).map((s) => ({
        id: s.siteUrl,
        item: { site_url: s.siteUrl, permission_level: s.permissionLevel },
      })),
  },
  new_sitemap_trigger: sitemapTrigger("A new sitemap is submitted for the site.", (s) => `sitemap:${s.path}`),
  sitemap_problem_trigger: sitemapTrigger(
    "Google reports a problem with a sitemap: errors or warnings in it, or it hasn't managed to read it at all. Reported again when the number of errors or warnings changes.",
    (s) => `problem:${s.path}:${count(s.errors)}:${count(s.warnings)}:${s.lastDownloaded ? "read" : "unread"}`,
    (s) => count(s.errors) > 0 || count(s.warnings) > 0 || !s.lastDownloaded,
  ),
  sitemap_read_trigger: sitemapTrigger("Google reads a sitemap again, which is how it picks up new pages.", (s) => `read:${s.path}:${s.lastDownloaded ?? "never"}`, (s) => Boolean(s.lastDownloaded)),
  url_index_status_changed_trigger: {
    description: "What Google says about one page changes: whether it is in the search results, why it isn't, or a problem with the page or its rich results. Google's answer is two to three days behind.",
    config: z.object({ ...SITE, inspection_url: z.string().describe("The full address of the page to watch, e.g. https://example.com/pricing") }),
    output: [
      site("The site in Search Console"),
      { name: "inspection_url", type: "string", required: true, description: "The page that was looked at" },
      { name: "verdict", type: "string", required: false, description: "PASS, NEUTRAL, FAIL or PARTIAL" },
      { name: "coverage_state", type: "string", required: false, description: 'Google\'s own words, e.g. "Submitted and indexed" or "Crawled - currently not indexed"' },
      { name: "result", type: "object", required: true, description: "Everything Google answered: indexStatusResult, mobileUsabilityResult, richResultsResult, ampResult" },
    ],
    ...EVERY,
    async poll(c, run) {
      const res = (await run("googlesearchconsole.inspect_url", { siteUrl: c.site_url, inspectionUrl: c.inspection_url })) as {
        inspectionResult?: { indexStatusResult?: { verdict?: string; coverageState?: string } };
      };
      const index = res.inspectionResult?.indexStatusResult;
      return [
        {
          id: `${c.inspection_url}:${index?.verdict ?? "?"}:${index?.coverageState ?? "?"}`,
          item: { site_url: c.site_url, inspection_url: c.inspection_url, verdict: index?.verdict, coverage_state: index?.coverageState, result: res.inspectionResult },
        },
      ];
    },
  },
  search_performance_change_trigger: {
    description: "Clicks or impressions from Google Search move a lot against the period just before: a jump or a drop bigger than the share you set. Reported at most once a day, since the numbers only change daily.",
    config: z.object({
      ...SITE,
      days: DAYS,
      metric: z.enum(["clicks", "impressions"]).default("clicks").describe("Which number to watch (default clicks)"),
      percent: z.number().min(1).max(1000).default(20).describe("How big the move has to be, in percent (default 20)"),
      direction: z.enum(["up", "down", "either"]).default("either").describe("Only jumps, only drops, or both (default both)"),
    }),
    ...EVERY,
    output: [
      site("The site in Search Console"),
      { name: "metric", type: "string", required: true, description: "clicks or impressions" },
      { name: "direction", type: "string", required: true, description: "up or down" },
      { name: "percent_change", type: "number", required: true, description: "How big the move was, in percent (negative for a drop)" },
      { name: "now", type: "object", required: true, description: "This period's clicks, impressions, ctr and average position" },
      { name: "before", type: "object", required: true, description: "The period before it" },
      { name: "period", type: "object", required: true, description: "The dates compared: startDate and endDate" },
    ],
    async poll(c, run) {
      const res = (await run("googlesearchconsole.compare_search_performance", { siteUrl: c.site_url, days: c.days })) as {
        period: { startDate: string; endDate: string };
        totals: { now: Record<string, number>; before: Record<string, number> };
        clicks_change: number;
        impressions_change: number;
      };
      const moved = (c.metric === "clicks" ? res.clicks_change : res.impressions_change) * 100;
      const direction = moved >= 0 ? "up" : "down";
      if (Math.abs(moved) < c.percent || (c.direction !== "either" && c.direction !== direction)) return [];
      return [
        {
          // the end date moves on each day, so a move that lasts is reported once a day, not at every check
          id: `${c.metric}:${direction}:${res.period.endDate}`,
          item: { site_url: c.site_url, metric: c.metric, direction, percent_change: Math.round(moved), now: res.totals.now, before: res.totals.before, period: res.period },
        },
      ];
    },
  },
  new_top_query_trigger: topTrigger("A search term people find the site by enters its top list.", "QUERY", "query"),
  new_top_page_trigger: topTrigger("A page enters the site's most-clicked pages in Google Search.", "PAGE", "page"),
};
