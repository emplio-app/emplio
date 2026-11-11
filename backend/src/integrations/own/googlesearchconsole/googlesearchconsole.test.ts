import { afterEach, expect, test } from "bun:test";
import { z } from "zod";
import { pollConfig, pollOnce } from "../../polls/index";
import { own } from "../index";
import { googlesearchconsole } from "./index";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
type Seen = { url: URL; body: any };
const stub = (answer: (u: URL, body: any) => unknown, status = 200) => {
  const seen: Seen[] = [];
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    const u = new URL(String(url));
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    seen.push({ url: u, body });
    return json(answer(u, body), status);
  }) as typeof fetch;
  return seen;
};
const login = { externalId: "c1", secret: "tok" };
const run = (a: string, i: unknown) => own.run(a, i, login, "o");
// the server checks a trigger's settings before each poll, which is where the defaults come from
const poll = (trigger: string, config: unknown, seen: string[] | null) => pollOnce(trigger, pollConfig(trigger, config).config, seen, run);

// a row the way Search Console answers, keyed by whatever dimensions were asked for
const row = (key: string, clicks: number, impressions: number, position = 5) => ({ keys: [key], clicks, impressions, ctr: impressions ? clicks / impressions : 0, position });

test("reads run unasked, writes ask, every input is a usable schema", async () => {
  for (const r of ["list_sites", "get_site", "list_sitemaps", "get_sitemap", "search_analytics_query", "inspect_url", "search_performance", "compare_search_performance", "list_sitemap_problems"])
    expect((await own.getAction(`googlesearchconsole.${r}`))?.readOnly, r).toBe(true);
  for (const w of ["add_site", "delete_site", "submit_sitemap", "delete_sitemap"]) expect((await own.getAction(`googlesearchconsole.${w}`))?.readOnly, w).toBeFalsy();
  for (const a of Object.values(googlesearchconsole.actions)) z.toJSONSchema(a.input, { io: "input" });
});

test("a domain property and a sitemap's address survive going into the address", async () => {
  const seen = stub(() => ({ sitemap: [] }));
  await run("googlesearchconsole.list_sitemaps", { siteUrl: "sc-domain:acme.co" });
  await run("googlesearchconsole.get_sitemap", { siteUrl: "https://acme.co/", feedpath: "https://acme.co/sitemap.xml" });
  expect(seen[0]!.url.pathname).toBe("/webmasters/v3/sites/sc-domain%3Aacme.co/sitemaps");
  expect(seen[1]!.url.pathname).toBe("/webmasters/v3/sites/https%3A%2F%2Facme.co%2F/sitemaps/https%3A%2F%2Facme.co%2Fsitemap.xml");
});

test("a dead token says to sign in again rather than looking like a broken site", async () => {
  stub(() => ({ error: { message: "Invalid Credentials" } }), 401);
  await expect(run("googlesearchconsole.list_sites", {})).rejects.toThrow(/reconnect/);
});

test("search_performance asks for a window Google already has, and adds the totals up itself", async () => {
  const seen = stub(() => ({ rows: [row("red shoes", 10, 200, 4), row("blue shoes", 30, 300, 6)] }));
  const res = (await run("googlesearchconsole.search_performance", { siteUrl: "sc-domain:acme.co", days: 7, dimension: "QUERY" })) as any;
  const body = seen[0]!.body;
  expect(body.dimensions).toEqual(["QUERY"]);
  expect(body.dataState).toBe("ALL");
  // 9 days back to 2 days back: Google's numbers are two to three days behind
  expect(Math.round((Date.parse(body.endDate) - Date.parse(body.startDate)) / 86_400_000)).toBe(7);
  expect(Date.now() - Date.parse(body.endDate)).toBeGreaterThan(86_400_000);
  expect(res.totals.clicks).toBe(40);
  expect(res.totals.impressions).toBe(500);
  expect(res.totals.ctr).toBeCloseTo(0.08);
  // the average position is weighted by impressions, not a plain average of 4 and 6
  expect(res.totals.position).toBeCloseTo((4 * 200 + 6 * 300) / 500);
  expect(res.rows).toEqual([
    { key: "red shoes", clicks: 10, impressions: 200, ctr: 0.05, position: 4 },
    { key: "blue shoes", clicks: 30, impressions: 300, ctr: 0.1, position: 6 },
  ]);
});

test("compare_search_performance puts the two periods side by side, biggest movers first", async () => {
  let call = 0;
  stub(() => (call++ === 0 ? { rows: [row("red shoes", 10, 100), row("hats", 5, 50)] } : { rows: [row("red shoes", 40, 100), row("hats", 4, 50)] }));
  const res = (await run("googlesearchconsole.compare_search_performance", { siteUrl: "sc-domain:acme.co", days: 7, dimension: "QUERY" })) as any;
  expect(res.totals.now.clicks).toBe(15);
  expect(res.totals.before.clicks).toBe(44);
  expect(res.clicks_change).toBeCloseTo((15 - 44) / 44);
  expect(res.rows[0]).toMatchObject({ key: "red shoes", clicks: 10, clicks_before: 40, clicks_change: -0.75 });
  expect(res.rows[1]!.key).toBe("hats");
});

test("list_sitemap_problems keeps only the sitemaps Google is unhappy about", async () => {
  stub(() => ({
    sitemap: [
      { path: "https://acme.co/good.xml", errors: "0", warnings: "0", lastDownloaded: "2026-11-10T00:00:00Z" },
      { path: "https://acme.co/warn.xml", errors: "0", warnings: "3", lastDownloaded: "2026-11-10T00:00:00Z" },
      { path: "https://acme.co/never.xml", errors: "0", warnings: "0" },
    ],
  }));
  const res = (await run("googlesearchconsole.list_sitemap_problems", { siteUrl: "sc-domain:acme.co" })) as any;
  expect(res.checked).toBe(3);
  expect(res.problems.map((p: any) => p.path)).toEqual(["https://acme.co/warn.xml", "https://acme.co/never.xml"]);
});

test("polled: a sitemap's problem is reported once, and again when the count changes", async () => {
  let sitemaps = [{ path: "https://acme.co/a.xml", errors: "2", warnings: "0", lastDownloaded: "2026-11-10T00:00:00Z" }];
  stub(() => ({ sitemap: sitemaps }));
  const config = { site_url: "sc-domain:acme.co" };
  const first = await poll("googlesearchconsole.sitemap_problem_trigger", config, null);
  expect(first.fresh).toEqual([]);
  const again = await poll("googlesearchconsole.sitemap_problem_trigger", config, first.seen);
  expect(again.fresh).toEqual([]);
  sitemaps = [{ ...sitemaps[0]!, errors: "5" }];
  const worse = await poll("googlesearchconsole.sitemap_problem_trigger", config, again.seen);
  expect((worse.fresh[0] as any).sitemap.errors).toBe("5");
  // a clean sitemap isn't a problem at all
  sitemaps = [{ ...sitemaps[0]!, errors: "0" }];
  expect((await poll("googlesearchconsole.sitemap_problem_trigger", config, worse.seen)).fresh).toEqual([]);
});

test("polled: a big drop in clicks is reported, a small one and the wrong direction aren't", async () => {
  // each check asks for this period and then the one before; 40 clicks before throughout
  let clicks = 40;
  let call = 0;
  stub(() => ({ rows: [row("x", call++ % 2 === 0 ? clicks : 40, 100)] }));
  const config = { site_url: "sc-domain:acme.co", percent: 20 };
  // steady at first, so turning the automation on doesn't report anything
  const first = await poll("googlesearchconsole.search_performance_change_trigger", config, null);
  expect(first.seen).toEqual([]);
  clicks = 10;
  const dropped = await poll("googlesearchconsole.search_performance_change_trigger", config, first.seen);
  expect(dropped.fresh.map((f: any) => [f.direction, f.percent_change])).toEqual([["down", -75]]);
  // still the same drop at the next check on the same day: reported once
  expect((await poll("googlesearchconsole.search_performance_change_trigger", config, dropped.seen)).fresh).toEqual([]);
  expect((await poll("googlesearchconsole.search_performance_change_trigger", { ...config, percent: 90 }, first.seen)).fresh).toEqual([]);
  expect((await poll("googlesearchconsole.search_performance_change_trigger", { ...config, direction: "up" }, first.seen)).fresh).toEqual([]);
});

test("polled: a search term entering the top list is reported once", async () => {
  let rows = [row("red shoes", 10, 100)];
  stub(() => ({ rows }));
  const config = { site_url: "sc-domain:acme.co", top: 3 };
  const first = await poll("googlesearchconsole.new_top_query_trigger", config, null);
  expect(first.fresh).toEqual([]);
  rows = [...rows, row("blue hats", 8, 90)];
  const later = await poll("googlesearchconsole.new_top_query_trigger", config, first.seen);
  expect(later.fresh.map((f: any) => [f.query, f.rank])).toEqual([["blue hats", 2]]);
  expect((await poll("googlesearchconsole.new_top_query_trigger", config, later.seen)).fresh).toEqual([]);
});

test("polled: what Google says about a page is reported when it changes", async () => {
  let state = { verdict: "FAIL", coverageState: "Crawled - currently not indexed" };
  stub(() => ({ inspectionResult: { indexStatusResult: state } }));
  const config = { site_url: "sc-domain:acme.co", inspection_url: "https://acme.co/pricing" };
  const first = await poll("googlesearchconsole.url_index_status_changed_trigger", config, null);
  expect(first.fresh).toEqual([]);
  state = { verdict: "PASS", coverageState: "Submitted and indexed" };
  const changed = await poll("googlesearchconsole.url_index_status_changed_trigger", config, first.seen);
  expect(changed.fresh.map((f: any) => f.verdict)).toEqual(["PASS"]);
  expect((await poll("googlesearchconsole.url_index_status_changed_trigger", config, changed.seen)).fresh).toEqual([]);
});
