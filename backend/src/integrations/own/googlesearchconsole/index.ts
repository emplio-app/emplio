// Google Search Console on sign-in: every method of its API from its Discovery document
// (`bun scripts/openapi-actions.ts googlesearchconsole`), plus a few plain-language reports on top: how the site did in
// Google Search over the last so many days, the same two periods compared, and which sitemaps Google is unhappy about.
// Google's search data is two to three days behind, so "yesterday" is usually still missing or partial.
import { z } from "zod";
import { googleApi, googleCheck, googleOAuth } from "../google-login";
import type { OwnAction, OwnApp } from "../index";
import { call, type Send, specActions } from "../openapi";

const api = googleApi("Google Search Console", "https://searchconsole.googleapis.com");
const actions = await specActions(new URL("./actions.json", import.meta.url), api);

const QUERY: Send = {
  method: "POST",
  path: "/webmasters/v3/sites/{siteUrl}/searchAnalytics/query",
  query: [],
  headers: [],
  body: {
    kind: "fields",
    fields: [
      ["startDate", "startDate"],
      ["endDate", "endDate"],
      ["dimensions", "dimensions"],
      ["rowLimit", "rowLimit"],
      ["dimensionFilterGroups", "dimensionFilterGroups"],
      ["type", "type"],
      ["dataState", "dataState"],
    ],
  },
};

const SITE_URL = z
  .string()
  .describe('The site in Search Console, exactly as it is listed there: "https://example.com/" for a URL-prefix property (keep the trailing slash) or "sc-domain:example.com" for a domain property');
const DIMENSION = z.enum(["QUERY", "PAGE", "COUNTRY", "DEVICE", "DATE", "SEARCH_APPEARANCE"]);
const TYPE = z.enum(["WEB", "IMAGE", "VIDEO", "NEWS", "DISCOVER", "GOOGLE_NEWS"]).default("WEB").describe("Which kind of search (default: normal web search)");
const DAY = 86_400_000;
const LAG = "Google's search data is two to three days behind, so the most recent days are missing or partial.";

// Search Console counts days in PST; close enough for day-sized windows, and it never asks for a day Google doesn't have yet
const day = (back: number) => new Date(Date.now() - back * DAY).toISOString().slice(0, 10);

type Row = { keys?: string[]; clicks: number; impressions: number; ctr: number; position: number };
const EMPTY = { clicks: 0, impressions: 0, ctr: 0, position: 0 };

const filters = (contains?: string, dimension: "QUERY" | "PAGE" = "QUERY") =>
  contains ? [{ filters: [{ dimension, operator: "CONTAINS", expression: contains }] }] : undefined;

const performance = (key: string, i: { siteUrl: string; startDate: string; endDate: string; dimensions?: string[]; rowLimit?: number; type?: string; contains?: string; filterDimension?: "QUERY" | "PAGE" }) =>
  call(api, key, QUERY, {
    siteUrl: i.siteUrl,
    startDate: i.startDate,
    endDate: i.endDate,
    dimensions: i.dimensions,
    rowLimit: i.rowLimit ?? 1000,
    type: i.type ?? "WEB",
    dataState: "ALL",
    dimensionFilterGroups: filters(i.contains, i.filterDimension),
  }) as Promise<{ rows?: Row[] }>;

// clicks, impressions, click-through rate and average position added up over a set of rows
const total = (rows: Row[]) =>
  rows.reduce(
    (t, r) => ({
      clicks: t.clicks + (r.clicks ?? 0),
      impressions: t.impressions + (r.impressions ?? 0),
      ctr: 0,
      position: t.position + (r.position ?? 0) * (r.impressions ?? 0),
    }),
    { ...EMPTY },
  );
const summarise = (rows: Row[]) => {
  const t = total(rows);
  return { clicks: t.clicks, impressions: t.impressions, ctr: t.impressions ? t.clicks / t.impressions : 0, position: t.impressions ? t.position / t.impressions : 0 };
};
const named = (r: Row) => ({ key: r.keys?.join(" | ") ?? "all", clicks: r.clicks, impressions: r.impressions, ctr: r.ctr, position: r.position });

const change = (now: number, before: number) => (before ? (now - before) / before : now ? 1 : 0);

const extras: Record<string, OwnAction> = {
  search_performance: {
    description: `How the site did in Google Search over the last so many days: clicks, impressions, click-through rate and average position, broken down by search term, page, country, device or day. ${LAG}`,
    readOnly: true,
    input: z.object({
      siteUrl: SITE_URL,
      days: z.number().int().min(1).max(480).default(28).describe("How many days back to look (default 28)"),
      dimension: DIMENSION.optional().describe("Break the numbers down by this (default: just the totals)"),
      contains: z.string().optional().describe("Only search terms containing these words"),
      limit: z.number().int().min(1).max(5000).default(50).describe("At most this many rows (default 50)"),
      type: TYPE,
    }),
    async run(i, key) {
      const [startDate, endDate] = [day(i.days + 2), day(2)];
      const res = await performance(key, { siteUrl: i.siteUrl, startDate, endDate, dimensions: i.dimension ? [i.dimension] : undefined, rowLimit: i.limit, type: i.type, contains: i.contains });
      const rows = res.rows ?? [];
      return { from: startDate, to: endDate, totals: summarise(rows), rows: i.dimension ? rows.map(named) : undefined };
    },
  },
  compare_search_performance: {
    description: `Compare how the site did in Google Search with the period just before it: what went up, what went down, in total and per search term or page. ${LAG}`,
    readOnly: true,
    input: z.object({
      siteUrl: SITE_URL,
      days: z.number().int().min(1).max(240).default(28).describe("The length of each period in days (default 28, so the last 28 days against the 28 before them)"),
      dimension: DIMENSION.optional().describe("Compare per search term, page, country or device (default: just the totals)"),
      contains: z.string().optional().describe("Only search terms containing these words"),
      limit: z.number().int().min(1).max(5000).default(50).describe("At most this many rows, biggest movers first (default 50)"),
      type: TYPE,
    }),
    async run(i, key) {
      // two windows of the same length, back to back, both ending before the days Google hasn't finished counting
      const windows = [
        { startDate: day(i.days + 2), endDate: day(2) },
        { startDate: day(2 * i.days + 3), endDate: day(i.days + 3) },
      ];
      const [now, before] = await Promise.all(
        windows.map((w) => performance(key, { siteUrl: i.siteUrl, ...w, dimensions: i.dimension ? [i.dimension] : undefined, rowLimit: 5000, type: i.type, contains: i.contains })),
      );
      const totals = { now: summarise(now!.rows ?? []), before: summarise(before!.rows ?? []) };
      const out: Record<string, unknown> = {
        period: windows[0],
        previous: windows[1],
        totals,
        clicks_change: change(totals.now.clicks, totals.before.clicks),
        impressions_change: change(totals.now.impressions, totals.before.impressions),
      };
      if (i.dimension) {
        const was = new Map((before!.rows ?? []).map((r) => [r.keys?.join(" | ") ?? "all", r]));
        out.rows = (now!.rows ?? [])
          .map((r) => {
            const k = r.keys?.join(" | ") ?? "all";
            const old = was.get(k) ?? EMPTY;
            return { key: k, clicks: r.clicks, clicks_before: old.clicks, clicks_change: change(r.clicks, old.clicks), impressions: r.impressions, impressions_before: old.impressions, position: r.position, position_before: old.position };
          })
          .sort((a, b) => Math.abs(b.clicks - b.clicks_before) - Math.abs(a.clicks - a.clicks_before))
          .slice(0, i.limit);
      }
      return out;
    },
  },
  list_sitemap_problems: {
    description: "The sitemaps Google has trouble with: the ones it reported errors or warnings on, or hasn't been able to read.",
    readOnly: true,
    input: z.object({ siteUrl: SITE_URL }),
    async run(i, key) {
      const res = (await actions.list_sitemaps!.run({ siteUrl: i.siteUrl }, key)) as { sitemap?: { path: string; errors?: string; warnings?: string; lastDownloaded?: string; isPending?: boolean }[] };
      const problems = (res.sitemap ?? []).filter((s) => Number(s.errors ?? 0) > 0 || Number(s.warnings ?? 0) > 0 || !s.lastDownloaded);
      return { problems, checked: res.sitemap?.length ?? 0 };
    },
  },
};

export const googlesearchconsole: OwnApp = {
  app: "googlesearchconsole",
  name: "Google Search Console",
  logo: "/logos/googlesearchconsole.svg",
  check: googleCheck,
  oauth: googleOAuth("Google Search Console", "googlesearchconsole"),
  actions: {
    ...actions,
    inspect_url: { ...actions.inspect_url!, description: `Ask Google what it knows about one page: whether it is in the search results, when it was last crawled, which sitemaps point to it, and any problems with the page, its mobile version or its rich results. ${LAG}` },
    search_analytics_query: { ...actions.search_analytics_query!, description: `${actions.search_analytics_query!.description} startDate and endDate are required, in YYYY-MM-DD. ${LAG}` },
    ...extras,
  },
};
