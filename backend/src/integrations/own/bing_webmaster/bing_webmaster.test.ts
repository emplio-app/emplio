import { afterEach, expect, test } from "bun:test";
import type { AppsError } from "../../types";
import { own } from "../index";
import { pollOnce } from "../../polls/index";

type Call = { method: string; url: URL; headers: Record<string, string>; body: any };
const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

// records every request and answers with reply(call); anything unanswered is a test bug, not a trip to Bing
function stub(reply: (c: Call) => Response | undefined) {
  const calls: Call[] = [];
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    const raw = init.body;
    const c = { method: init.method!, url: new URL(url), headers: init.headers as Record<string, string>, body: raw ? JSON.parse(String(raw)) : undefined };
    calls.push(c);
    const r = reply(c);
    if (!r) throw new Error(`unexpected ${c.method} ${c.url}`);
    return r;
  }) as typeof fetch;
  return calls;
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
// Bing wraps every answer in {"d": ...}
const d = (data: unknown) => json({ d: data });

const run = (action: string, input: unknown) => own.run(`bing_webmaster.${action}`, input, { externalId: "", secret: "key123" }, "owner");
const fails = (p: Promise<unknown>) =>
  p.then(
    () => {
      throw new Error("expected it to fail");
    },
    (e: AppsError) => e,
  );
const poll = (trigger: string, config: unknown, seen: string[] | null, reply: (c: Call) => Response | undefined) => {
  stub(reply);
  // pollOnce hands the poll the whole action name, the way the server does
  return pollOnce(`bing_webmaster.${trigger}`, config, seen, (action, input) => own.run(action, input, { externalId: "", secret: "key123" }, "owner"));
};

test("a lookup sends the key in the query and unwraps Bing's d", async () => {
  const calls = stub(() => d([{ __type: "Site:#x", Url: "https://example.com", IsVerified: true }]));
  const out = await run("get_user_sites", {});
  expect(calls[0]!.method).toBe("GET");
  expect(calls[0]!.url.origin + calls[0]!.url.pathname).toBe("https://ssl.bing.com/webmaster/api.svc/json/GetUserSites");
  expect(calls[0]!.url.searchParams.get("apikey")).toBe("key123");
  expect(calls[0]!.headers.Authorization).toBeUndefined();
  // the d wrapper and the .NET type tag are gone
  expect(out).toEqual([{ Url: "https://example.com", IsVerified: true }]);
});

test("Bing's .NET dates come back as ordinary dates", async () => {
  stub(() => d([{ __type: "Feed:#x", Url: "https://example.com/sitemap.xml", Status: "Success", LastCrawled: "/Date(1762819200000+0000)/" }]));
  const out = (await run("get_feeds", { siteUrl: "https://example.com" })) as { LastCrawled: string }[];
  expect(out[0]!.LastCrawled).toBe(new Date(1762819200000).toISOString());
});

test("a GET puts its own fields in the query, never in a body", async () => {
  const calls = stub(() => d({ Clicks: 4, Impressions: 90 }));
  await run("get_url_traffic_info", { siteUrl: "https://example.com", url: "https://example.com/shop" });
  expect(calls[0]!.url.searchParams.get("siteUrl")).toBe("https://example.com");
  expect(calls[0]!.url.searchParams.get("url")).toBe("https://example.com/shop");
  expect(calls[0]!.body).toBeUndefined();
});

test("a write goes as a POST with a JSON body, with only the key in the query", async () => {
  const calls = stub(() => d(null));
  await run("submit_url_batch", { siteUrl: "https://example.com", urlList: ["https://example.com/a", "https://example.com/b"] });
  expect(calls[0]!.method).toBe("POST");
  expect(calls[0]!.url.searchParams.get("apikey")).toBe("key123");
  expect(calls[0]!.url.searchParams.get("siteUrl")).toBeNull();
  expect(calls[0]!.body).toEqual({ siteUrl: "https://example.com", urlList: ["https://example.com/a", "https://example.com/b"] });
});

test("plain words become the numbers Bing wants, inside the object it wants", async () => {
  const calls = stub(() => d(null));
  await run("add_blocked_url", { siteUrl: "https://example.com", blockedUrl: "https://example.com/oops", entityType: "folder", requestType: "remove_from_search", date: "2026-11-11" });
  expect(calls[0]!.body.blockedUrl.__type).toBe("BlockedUrl:#Microsoft.Bing.Webmaster.Api");
  expect(calls[0]!.body.blockedUrl.EntityType).toBe(1);
  expect(calls[0]!.body.blockedUrl.RequestType).toBe(1);
  expect(calls[0]!.body.blockedUrl.Date).toBe(`/Date(${Date.parse("2026-11-11")}+0000)/`);
});

test("a folder listing is a POST that still counts as only looking", async () => {
  const calls = stub(() => d([]));
  await run("get_children_url_info", { siteUrl: "https://example.com", url: "https://example.com/shop/", httpCode: "not_found_4xx" });
  expect(calls[0]!.method).toBe("POST");
  expect(calls[0]!.body.filterProperties.HttpCodeFilters).toBe(16);
  expect(calls[0]!.body.page).toBe(0);
  expect((await own.getAction("bing_webmaster.get_children_url_info"))!.readOnly).toBe(true);
  // a write still asks first
  expect((await own.getAction("bing_webmaster.submit_url"))!.readOnly).toBe(false);
});

test("a bad date is refused before it reaches Bing", async () => {
  stub(() => d(null));
  const e = await fails(run("submit_site_move", { siteUrl: "https://example.com", sourceUrl: "https://old.example.com", targetUrl: "https://example.com", moveScope: "whole_domain", moveType: "same_country", date: "whenever" }));
  expect(e.message).toContain("isn't a date");
});

test("a mistyped key is a dead connection, not a passing failure", async () => {
  // Bing answers a bad key with a 400 and ErrorCode 3, not a 401
  stub(() => json({ ErrorCode: 3, Message: "ERROR!!! InvalidApiKey" }, 400));
  const e = await fails(run("get_user_sites", {}));
  expect(e.expired).toBe(true);
  expect(e.message).toContain("make a new one");
});

test("an error Bing sends with a 200 is still a failure", async () => {
  stub(() => json({ ErrorCode: 8, Message: "Invalid parameter" }));
  const e = await fails(run("submit_url", { siteUrl: "https://example.com", url: "not-a-url" }));
  expect(e.expired).toBeFalsy();
  expect(e.message).toBe("Bing Webmaster Tools: Invalid parameter (code 8)");
});

test("an ordinary refusal shows Bing's own wording", async () => {
  stub(() => json({ ErrorCode: 4, Message: "ERROR!!! Throttle user" }, 400));
  const e = await fails(run("submit_url", { siteUrl: "https://example.com", url: "https://example.com/a" }));
  expect(e.expired).toBeFalsy();
  expect(e.message).toBe("Bing Webmaster Tools: ERROR!!! Throttle user (400)");
});

test("a pasted key is checked, and labels the connection with the account's first site", async () => {
  stub(() => d([{ Url: "https://example.com" }, { Url: "https://shop.example.com" }]));
  expect(await own.connectWithKey!("bing_webmaster", " key123 ")).toEqual({ secret: "key123", label: "https://example.com and 1 more" });
  stub(() => d([]));
  expect((await own.connectWithKey!("bing_webmaster", "key123")).label).toBe("no websites added yet");
  stub(() => json({ ErrorCode: 3, Message: "ERROR!!! InvalidApiKey" }, 400));
  expect((await fails(own.connectWithKey!("bing_webmaster", "nope"))).expired).toBe(true);
});

test("a crawl problem starts the trigger once, and again when the problem changes", async () => {
  const issues = (rows: unknown[]) => () => d(rows);
  const site = { site_url: "https://example.com" };
  const first = await poll("crawl_error_found", site, null, issues([{ Url: "https://example.com/a", HttpCode: 404, Issues: 4, InLinks: 3 }]));
  expect(first.fresh).toEqual([]);
  const second = await poll("crawl_error_found", site, first.seen, issues([
    { Url: "https://example.com/a", HttpCode: 404, Issues: 4, InLinks: 3 },
    { Url: "https://example.com/b", HttpCode: 500, Issues: 8, InLinks: 1 },
  ]));
  expect(second.fresh).toHaveLength(1);
  expect((second.fresh[0] as any).problems).toEqual(["server error (5xx)"]);
  // the same page, now failing differently: news again
  const third = await poll("crawl_error_found", site, second.seen, issues([{ Url: "https://example.com/b", HttpCode: 404, Issues: 4, InLinks: 1 }]));
  expect(third.fresh).toHaveLength(1);
  // nothing changed: nothing to say
  const fourth = await poll("crawl_error_found", site, third.seen, issues([{ Url: "https://example.com/b", HttpCode: 404, Issues: 4, InLinks: 1 }]));
  expect(fourth.fresh).toEqual([]);
});

test("a sitemap that starts failing, and then works again, each start the trigger once", async () => {
  const feeds = (status: string) => () => d([{ Url: "https://example.com/sitemap.xml", Status: status }]);
  const site = { site_url: "https://example.com" };
  const first = await poll("sitemap_status_changed", site, null, feeds("Success"));
  const failed = await poll("sitemap_status_changed", site, first.seen, feeds("Error"));
  expect(failed.fresh).toHaveLength(1);
  expect((failed.fresh[0] as any).failing).toBe(true);
  const again = await poll("sitemap_status_changed", site, failed.seen, feeds("Error"));
  expect(again.fresh).toEqual([]);
  const fixed = await poll("sitemap_status_changed", site, again.seen, feeds("Success"));
  expect(fixed.fresh).toEqual([]); // that state was already seen on the first check
});

test("a page dropping out of Bing's index starts the trigger", async () => {
  const site = { site_url: "https://example.com", pages: ["https://example.com/shop"] };
  const there = await poll("page_index_status_changed", site, null, () => d({ Url: "https://example.com/shop", HttpStatus: 200 }));
  expect(there.seen).toEqual(["https://example.com/shop:in"]);
  // Bing answers with nothing for a page it no longer has
  const gone = await poll("page_index_status_changed", site, there.seen, () => d(null));
  expect(gone.fresh).toHaveLength(1);
  expect((gone.fresh[0] as any).in_index).toBe(false);
});

test("a search term only counts as moved once it moves by the step given", async () => {
  const stats = (position: number) => () => d([{ Query: "copper kettle", AvgImpressionPosition: position, Clicks: 2, Impressions: 50 }]);
  const site = { site_url: "https://example.com", step: 5 };
  const first = await poll("keyword_position_changed", site, null, stats(12));
  const small = await poll("keyword_position_changed", site, first.seen, stats(13));
  expect(small.fresh).toEqual([]);
  const big = await poll("keyword_position_changed", site, small.seen, stats(28));
  expect(big.fresh).toHaveLength(1);
  expect((big.fresh[0] as any).position).toBe(28);
});

test("only the search terms asked for are watched", async () => {
  const rows = () => d([
    { Query: "copper kettle", AvgImpressionPosition: 4 },
    { Query: "teapot", AvgImpressionPosition: 9 },
  ]);
  const site = { site_url: "https://example.com", queries: ["Copper Kettle"] };
  const first = await poll("keyword_position_changed", site, null, rows);
  expect(first.seen).toEqual(["copper kettle:4"]);
});
