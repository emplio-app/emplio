import { afterEach, expect, test } from "bun:test";
import { z } from "zod";
import { pollConfig, pollOnce } from "../../polls/index";
import { own } from "../index";
import { googleanalytics } from "./index";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
type Seen = { url: URL; body: any; method?: string };
const stub = (answer: (u: URL, body: any) => unknown, status = 200) => {
  const seen: Seen[] = [];
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    const u = new URL(String(url));
    seen.push({ url: u, body: init?.body ? JSON.parse(String(init.body)) : undefined, method: init?.method });
    return json(answer(u, seen.at(-1)!.body), status);
  }) as typeof fetch;
  return seen;
};
const login = { externalId: "c1", secret: "tok" };
const run = (a: string, i: unknown) => own.run(a, i, login, "o");
// the server checks a trigger's settings before each poll, which is where the defaults come from
const poll = (trigger: string, config: unknown, seen: string[] | null) => pollOnce(trigger, pollConfig(trigger, config).config, seen, run);

// a report the way the Data API answers: headers and values in parallel lists
const report = (dimension: string | undefined, metrics: string[], rows: [string, number[]][], totals: number[]) => ({
  dimensionHeaders: dimension ? [{ name: dimension }] : [],
  metricHeaders: metrics.map((name) => ({ name })),
  rows: rows.map(([key, values]) => ({ dimensionValues: dimension ? [{ value: key }] : [], metricValues: values.map((v) => ({ value: String(v) })) })),
  totals: [{ metricValues: totals.map((v) => ({ value: String(v) })) }],
  rowCount: rows.length,
});
const USERS = ["activeUsers", "sessions", "keyEvents"];

test("the setup and the numbers go to their own Google hosts", async () => {
  const seen = stub(() => ({ properties: [] }));
  await run("googleanalytics.list_properties", { filter: "parent:accounts/1" });
  await run("googleanalytics.run_report", { propertiesId: "123", dateRanges: [{ startDate: "2026-11-01", endDate: "today" }] });
  expect(seen[0]!.url.host).toBe("analyticsadmin.googleapis.com");
  expect(seen[1]!.url.host).toBe("analyticsdata.googleapis.com");
  expect(seen[1]!.url.pathname).toBe("/v1beta/properties/123:runReport");
});

test('a whole "properties/123456" name and a bare number both reach the right address', async () => {
  const seen = stub(() => ({ dataStreams: [] }));
  await run("googleanalytics.list_data_streams", { propertiesId: "properties/123456" });
  await run("googleanalytics.list_data_streams", { propertiesId: "123456" });
  expect(seen.map((s) => s.url.pathname)).toEqual(["/v1alpha/properties/123456/dataStreams", "/v1alpha/properties/123456/dataStreams"]);
  // the reports written by hand take it the same way round
  await run("googleanalytics.website_report", { propertiesId: "properties/123456" });
  expect(seen[2]!.url.pathname).toBe("/v1beta/properties/123456:runReport");
});

test("reads run unasked, writes ask, secrets ask, every input is a usable schema", async () => {
  for (const r of ["run_report", "run_realtime_report", "run_funnel_report", "batch_run_reports", "check_compatibility", "search_change_history_events", "run_access_report", "query_audience_export", "website_report", "compare_website_report", "live_visitors", "validate_events", "list_properties", "get_metadata"])
    expect((await own.getAction(`googleanalytics.${r}`))?.readOnly, r).toBe(true);
  for (const w of ["create_property", "update_property", "delete_property", "create_data_stream", "create_key_event", "archive_audience", "create_access_binding", "send_events"]) expect((await own.getAction(`googleanalytics.${w}`))?.readOnly, w).toBeFalsy();
  // reading a measurement protocol secret hands over a key anyone could send events with, so it asks first
  for (const s of ["get_measurement_protocol_secret", "list_measurement_protocol_secrets"]) {
    const a = await own.getAction(`googleanalytics.${s}`);
    expect(a?.readOnly, s).toBeFalsy();
    expect(a?.description, s).toContain("Shows a secret");
  }
  for (const a of Object.values(googleanalytics.actions)) z.toJSONSchema(a.input, { io: "input" });
});

test("every operation of both APIs is an action, and the deprecated ones aren't", async () => {
  const names = (await own.listActions("googleanalytics")).map((a) => a.action.split(".")[1]!);
  // the Admin API's 166 methods, the Data API's 11 + 13, less the 2 the Data API repeats and the 5 Google deprecated
  expect(names.length).toBeGreaterThan(180);
  for (const n of ["list_accounts", "list_properties", "list_data_streams", "list_audiences", "list_bigquery_links", "list_google_ads_links", "list_search_ads360_links", "list_access_bindings", "list_custom_dimensions", "list_custom_metrics", "run_report", "run_pivot_report", "run_realtime_report", "run_funnel_report", "get_metadata", "create_audience_export", "create_report_task", "provision_account_ticket"])
    expect(names, n).toContain(n);
  for (const gone of ["list_conversion_events", "get_conversion_event"]) expect(names, gone).not.toContain(gone);
});

test("website_report asks Google for the totals and hands back plain rows", async () => {
  const seen = stub(() => report("pagePath", USERS, [["/pricing", [80, 100, 4]], ["/", [20, 30, 1]]], [100, 130, 5]));
  const res = (await run("googleanalytics.website_report", { propertiesId: "properties/123", days: 7, dimension: "page", metrics: USERS })) as any;
  const body = seen[0]!.body;
  expect(body.dimensions).toEqual([{ name: "pagePath" }]);
  expect(body.metricAggregations).toEqual(["TOTAL"]);
  expect(body.dateRanges[0]!.endDate).toBe("today");
  expect(body.orderBys).toEqual([{ metric: { metricName: "activeUsers" }, desc: true }]);
  expect(res.totals).toEqual({ activeUsers: 100, sessions: 130, keyEvents: 5 });
  expect(res.rows[0]).toEqual({ pagePath: "/pricing", activeUsers: 80, sessions: 100, keyEvents: 4 });
});

test("compare_website_report works out what moved", async () => {
  let call = 0;
  stub(() => (call++ === 0 ? report(undefined, USERS, [["all", [120, 150, 9]]], [120, 150, 9]) : report(undefined, USERS, [["all", [100, 150, 10]]], [100, 150, 10])));
  const res = (await run("googleanalytics.compare_website_report", { propertiesId: "123", days: 7, metrics: USERS })) as any;
  expect(res.totals.now.activeUsers).toBe(120);
  expect(res.totals.before.activeUsers).toBe(100);
  expect(res.changes.activeUsers).toBeCloseTo(0.2);
  expect(res.changes.sessions).toBe(0);
  expect(res.changes.keyEvents).toBeCloseTo(-0.1);
});

test("live_visitors counts the last half hour and says where people are", async () => {
  const seen = stub(() => report("unifiedScreenName", ["activeUsers", "screenPageViews", "keyEvents"], [["Pricing", [7, 9, 0]]], [7, 9, 0]));
  const res = (await run("googleanalytics.live_visitors", { propertiesId: "123", dimension: "page" })) as any;
  expect(seen[0]!.url.pathname).toBe("/v1beta/properties/123:runRealtimeReport");
  expect(seen[0]!.body.minuteRanges).toEqual([{ startMinutesAgo: 30, endMinutesAgo: 0 }]);
  expect(res.active_users).toBe(7);
  expect(res.rows[0]!.unifiedScreenName).toBe("Pricing");
});

test("events are sent with the stream's own secret, and checking them records nothing", async () => {
  const seen = stub((u) => (u.pathname.startsWith("/debug") ? { validationMessages: [{ description: "bad name" }] } : {}));
  const input = { measurementId: "G-ABC", apiSecret: "sek", clientId: "123.456", events: [{ name: "purchase", params: { value: 4999, currency: "INR" } }] };
  const sent = (await run("googleanalytics.send_events", input)) as any;
  expect(seen[0]!.url.origin + seen[0]!.url.pathname).toBe("https://www.google-analytics.com/mp/collect");
  expect(seen[0]!.url.searchParams.get("measurement_id")).toBe("G-ABC");
  expect(seen[0]!.url.searchParams.get("api_secret")).toBe("sek");
  expect(seen[0]!.body).toEqual({ client_id: "123.456", events: [{ name: "purchase", params: { value: 4999, currency: "INR" } }] });
  expect(sent.sent).toBe(1);
  const checked = (await run("googleanalytics.validate_events", input)) as any;
  expect(seen[1]!.url.pathname).toBe("/debug/mp/collect");
  expect(checked).toMatchObject({ ok: false, problems: [{ description: "bad name" }] });
});

test("a dead token says to sign in again", async () => {
  stub(() => ({ error: { message: "Invalid Credentials" } }), 401);
  await expect(run("googleanalytics.list_accounts", {})).rejects.toThrow(/reconnect/);
});

test("polled: a new data stream is reported once", async () => {
  let streams = [{ name: "properties/123/dataStreams/1", displayName: "Website" }];
  stub(() => ({ dataStreams: streams }));
  const config = { property: "123" };
  const first = await poll("googleanalytics.new_data_stream_trigger", config, null);
  expect(first.fresh).toEqual([]);
  streams = [...streams, { name: "properties/123/dataStreams/2", displayName: "App" }];
  const later = await poll("googleanalytics.new_data_stream_trigger", config, first.seen);
  expect(later.fresh.map((f: any) => f.data_stream.displayName)).toEqual(["App"]);
  expect((await poll("googleanalytics.new_data_stream_trigger", config, later.seen)).fresh).toEqual([]);
});

test("polled: new properties are looked for under the account that was asked for", async () => {
  const seen = stub(() => ({ properties: [{ name: "properties/9", displayName: "Shop" }] }));
  const first = await poll("googleanalytics.new_property_trigger", { account: "555" }, null);
  expect(seen[0]!.url.searchParams.get("filter")).toBe("parent:accounts/555");
  await poll("googleanalytics.new_property_trigger", { account: "accounts/555" }, first.seen);
  expect(seen[1]!.url.searchParams.get("filter")).toBe("parent:accounts/555");
});

test("polled: a change to the setup is reported once, old ones are left alone", async () => {
  const changes = [
    { id: "ch1", changeTime: new Date().toISOString(), userActorEmail: "asha@acme.co" },
    { id: "ch-old", changeTime: new Date(Date.now() - 3 * 86_400_000).toISOString() },
  ];
  const seen = stub(() => ({ changeHistoryEvents: changes }));
  const config = { account: "555", resource_type: ["PROPERTY"] };
  const first = await poll("googleanalytics.setup_changed_trigger", config, null);
  expect(seen[0]!.body.resourceType).toEqual(["PROPERTY"]);
  expect(first.seen).toEqual(["ch1"]);
  changes.unshift({ id: "ch2", changeTime: new Date().toISOString(), userActorEmail: "raj@acme.co" });
  const later = await poll("googleanalytics.setup_changed_trigger", config, first.seen);
  expect(later.fresh.map((f: any) => f.actor)).toEqual(["raj@acme.co"]);
});

test("polled: live visitors over the figure are reported once a quiet period", async () => {
  let users = 10;
  stub(() => report("unifiedScreenName", ["activeUsers", "screenPageViews", "keyEvents"], [["/", [users, users, 0]]], [users, users, 0]));
  const config = { property: "123", visitors: 50, quiet_minutes: 60 };
  const quiet = await poll("googleanalytics.live_visitors_trigger", config, null);
  expect(quiet.seen).toEqual([]);
  users = 80;
  const busy = await poll("googleanalytics.live_visitors_trigger", config, quiet.seen);
  expect(busy.fresh.map((f: any) => f.active_users)).toEqual([80]);
  expect((await poll("googleanalytics.live_visitors_trigger", config, busy.seen)).fresh).toEqual([]);
  // the other way round: under the figure
  expect((await poll("googleanalytics.live_visitors_trigger", { ...config, when: "below" }, busy.seen)).fresh).toEqual([]);
});

test("polled: a big move in visitors is reported, a small one isn't", async () => {
  // each check asks for this period and then the one before; 100 visitors before throughout
  let users = 100;
  let call = 0;
  stub(() => (call++ % 2 === 0 ? report(undefined, USERS, [["all", [users, 120, 4]]], [users, 120, 4]) : report(undefined, USERS, [["all", [100, 120, 4]]], [100, 120, 4])));
  const config = { property: "123", percent: 20 };
  // steady at first, so turning the automation on doesn't report anything
  const first = await poll("googleanalytics.traffic_change_trigger", config, null);
  expect(first.seen).toEqual([]);
  users = 50;
  const dropped = await poll("googleanalytics.traffic_change_trigger", config, first.seen);
  expect(dropped.fresh.map((f: any) => [f.metric, f.direction, f.percent_change])).toEqual([["activeUsers", "down", -50]]);
  expect((await poll("googleanalytics.traffic_change_trigger", config, dropped.seen)).fresh).toEqual([]);
  expect((await poll("googleanalytics.traffic_change_trigger", { ...config, percent: 80 }, first.seen)).fresh).toEqual([]);
  expect((await poll("googleanalytics.traffic_change_trigger", { ...config, direction: "up" }, first.seen)).fresh).toEqual([]);
});

test("polled: conversions passing the day's figure are reported", async () => {
  let conversions = 2;
  stub(() => report(undefined, ["keyEvents"], [["all", [conversions]]], [conversions]));
  const config = { property: "123", count: 10 };
  const quiet = await poll("googleanalytics.key_events_threshold_trigger", config, null);
  expect(quiet.fresh).toEqual([]);
  conversions = 12;
  const hit = await poll("googleanalytics.key_events_threshold_trigger", config, quiet.seen);
  expect(hit.fresh.map((f: any) => f.count)).toEqual([12]);
  expect((await poll("googleanalytics.key_events_threshold_trigger", config, hit.seen)).fresh).toEqual([]);
});
