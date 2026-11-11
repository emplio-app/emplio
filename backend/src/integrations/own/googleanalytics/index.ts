// Google Analytics 4 on sign-in: every method of the Analytics Admin API (the setup) and the Analytics Data API (the
// numbers) from their Discovery documents (`bun scripts/openapi-actions.ts googleanalytics`), plus plain-language
// reports on top — how the website did over the last so many days, the same against the period before, who is on the
// site right now — and the two Measurement Protocol calls, which send events into a property with its own secret.
import { z } from "zod";
import { AppsError } from "../../types";
import { googleApi, googleCheck, googleOAuth } from "../google-login";
import type { OwnAction, OwnApp } from "../index";
import { call, type Send, specActions } from "../openapi";

const api = googleApi("Google Analytics", "https://analyticsadmin.googleapis.com");
const DATA = "https://analyticsdata.googleapis.com";
const generated = await specActions(new URL("./actions.json", import.meta.url), api);

// Google's answers name things "properties/123456", which is what people paste back; only the number goes in the address
const shortIds = (a: OwnAction): OwnAction => ({
  ...a,
  run: (i, key) => a.run(Object.fromEntries(Object.entries(i).map(([f, v]) => [f, /Id$/.test(f) && typeof v === "string" ? v.split("/").pop() : v])), key),
});

const report = (path: string): Send => ({
  method: "POST",
  base: DATA,
  path: `/v1beta/properties/{propertiesId}${path}`,
  query: [],
  headers: [],
  body: {
    kind: "fields",
    fields: [["dateRanges", "dateRanges"], ["dimensions", "dimensions"], ["metrics", "metrics"], ["limit", "limit"], ["orderBys", "orderBys"], ["dimensionFilter", "dimensionFilter"], ["minuteRanges", "minuteRanges"], ["metricAggregations", "metricAggregations"]],
  },
});
const RUN_REPORT = report(":runReport");
const RUN_REALTIME = report(":runRealtimeReport");

const propertiesId = z.string().describe('The property to look at, from googleanalytics.list_properties: its number, or the whole "properties/123456"');
const DAY = 86_400_000;
const day = (back: number) => new Date(Date.now() - back * DAY).toISOString().slice(0, 10);

// what a business owner asks for, in the API's own dimension names
const BREAKDOWN = {
  page: "pagePath",
  landing_page: "landingPage",
  source: "sessionSourceMedium",
  channel: "sessionDefaultChannelGroup",
  campaign: "sessionCampaignName",
  country: "country",
  city: "city",
  device: "deviceCategory",
  browser: "browser",
  language: "language",
  event: "eventName",
  day: "date",
  hour: "dateHour",
} as const;
const DEFAULT_METRICS = ["activeUsers", "newUsers", "sessions", "screenPageViews", "keyEvents"];
const breakdown = z
  .enum(Object.keys(BREAKDOWN) as [keyof typeof BREAKDOWN])
  .optional()
  .describe("Split the numbers by this (default: just the totals). page and landing_page are addresses on the site, source is where people came from, channel groups them (Organic Search, Direct, Paid Social), event counts one kind of action");
const metrics = z
  .array(z.string())
  .optional()
  .describe(`Which numbers, in Google's names (default ${DEFAULT_METRICS.join(", ")}). Others worth asking for: averageSessionDuration, bounceRate, engagementRate, totalRevenue, purchaseRevenue, transactions, eventCount`);

type ReportAnswer = { dimensionHeaders?: { name: string }[]; metricHeaders?: { name: string }[]; rows?: { dimensionValues?: { value: string }[]; metricValues?: { value: string }[] }[]; rowCount?: number; totals?: { metricValues?: { value: string }[] }[] };
const number = (v?: string) => (v === undefined || v === "" ? 0 : Number(v));
// Google answers in parallel header and value lists; this gives back plain rows, and the totals by name
const readable = (res: ReportAnswer) => {
  const dims = (res.dimensionHeaders ?? []).map((h) => h.name);
  const nums = (res.metricHeaders ?? []).map((h) => h.name);
  return {
    totals: Object.fromEntries(nums.map((n, i) => [n, number(res.totals?.[0]?.metricValues?.[i]?.value)])),
    rows: (res.rows ?? []).map((r) => ({
      ...Object.fromEntries(dims.map((d, i) => [d, r.dimensionValues?.[i]?.value ?? ""])),
      ...Object.fromEntries(nums.map((n, i) => [n, number(r.metricValues?.[i]?.value)])),
    })),
    row_count: res.rowCount ?? res.rows?.length ?? 0,
  };
};

const runReport = (key: string, input: Record<string, unknown>) => call(api, key, RUN_REPORT, input) as Promise<ReportAnswer>;

const traffic = (key: string, i: { propertiesId: string; startDate: string; endDate: string; dimension?: keyof typeof BREAKDOWN; metrics?: string[]; limit?: number; contains?: string; dimensionName?: string }) => {
  const names = i.metrics ?? DEFAULT_METRICS;
  const dimension = i.dimensionName ?? (i.dimension && BREAKDOWN[i.dimension]);
  return runReport(key, {
    propertiesId: i.propertiesId,
    dateRanges: [{ startDate: i.startDate, endDate: i.endDate }],
    dimensions: dimension ? [{ name: dimension }] : undefined,
    metrics: names.map((name) => ({ name })),
    // without this Google leaves the totals out, and a page of rows isn't the whole period
    metricAggregations: ["TOTAL"],
    limit: i.limit ?? 50,
    orderBys: dimension && dimension !== "date" && dimension !== "dateHour" ? [{ metric: { metricName: names[0] }, desc: true }] : undefined,
    dimensionFilter: i.contains && dimension ? { filter: { fieldName: dimension, stringFilter: { matchType: "CONTAINS", value: i.contains, caseSensitive: false } } } : undefined,
  });
};

const change = (now: number, before: number) => (before ? (now - before) / before : now ? 1 : 0);

const MP = "https://www.google-analytics.com";
const measurementId = z.string().describe('The data stream\'s measurement id, which starts with "G-": from googleanalytics.list_data_streams');
const apiSecret = z.string().describe("The data stream's measurement protocol secret value. Make one in Analytics under Admin > Data streams > the stream > Measurement Protocol API secrets, or with googleanalytics.create_measurement_protocol_secret");
const mpInput = z.object({
  measurementId,
  apiSecret,
  clientId: z.string().describe('Which visitor the events belong to: the GA client id from the site\'s _ga cookie, or any id of your own that stays the same for one person (e.g. "crm-4821")'),
  userId: z.string().optional().describe("Your own id for the signed-in person, if you have one"),
  events: z
    .array(z.object({ name: z.string().describe('The event\'s name, e.g. "purchase" or "quote_requested"'), params: z.record(z.string(), z.any()).optional().describe('Anything else to record with it: {"value": 4999, "currency": "INR"}') }).loose())
    .min(1)
    .max(25)
    .describe("The events to record, up to 25 at a time"),
  userProperties: z.record(z.string(), z.any()).optional().describe('Lasting facts about the person: {"plan": {"value": "pro"}}'),
  timestampMicros: z.string().optional().describe("When it happened, in microseconds since 1970. Leave out for now; Google only accepts the last 72 hours"),
});

const measurementProtocol = async (i: z.infer<typeof mpInput>, debug: boolean) => {
  const url = `${MP}${debug ? "/debug" : ""}/mp/collect?measurement_id=${encodeURIComponent(i.measurementId)}&api_secret=${encodeURIComponent(i.apiSecret)}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: i.clientId, user_id: i.userId, timestamp_micros: i.timestampMicros, user_properties: i.userProperties, events: i.events.map((e) => ({ name: e.name, params: e.params })) }),
  });
  const text = await res.text();
  if (!res.ok) throw new AppsError(`Google Analytics refused the events: ${text || res.statusText} (${res.status})`);
  const body = text ? JSON.parse(text) : {};
  // the real address answers 204 whatever happens, which is why validate_events exists
  return debug ? { problems: body.validationMessages ?? [], ok: (body.validationMessages ?? []).length === 0 } : { sent: i.events.length, note: "Google accepts events without checking them; googleanalytics.validate_events says whether they are right" };
};

const extras: Record<string, OwnAction> = {
  website_report: {
    description: "How the website did over the last so many days: visitors, new visitors, sessions, page views and conversions, split by page, where people came from, country, device or day.",
    readOnly: true,
    input: z.object({
      propertiesId,
      days: z.number().int().min(1).max(730).default(28).describe("How many days back, ending today (default 28)"),
      dimension: breakdown,
      contains: z.string().optional().describe("Only rows whose value contains this, e.g. a part of a page's address"),
      limit: z.number().int().min(1).max(10_000).default(50).describe("At most this many rows, biggest first (default 50)"),
      metrics,
    }),
    async run(i, key) {
      const [startDate, endDate] = [day(i.days - 1), "today"];
      return { from: startDate, to: new Date().toISOString().slice(0, 10), ...readable(await traffic(key, { ...i, startDate, endDate })) };
    },
  },
  compare_website_report: {
    description: "Compare the website's numbers with the period just before: what went up, what went down, in total and per page, source or country.",
    readOnly: true,
    input: z.object({
      propertiesId,
      days: z.number().int().min(1).max(365).default(28).describe("The length of each period in days (default 28, so the last 28 days against the 28 before them)"),
      dimension: breakdown,
      limit: z.number().int().min(1).max(1000).default(50).describe("At most this many rows, biggest movers first (default 50)"),
      metrics,
    }),
    async run(i, key) {
      const windows = [
        { startDate: day(i.days - 1), endDate: "today" },
        { startDate: day(2 * i.days - 1), endDate: day(i.days) },
      ];
      const [now, before] = (await Promise.all(windows.map((w) => traffic(key, { ...i, ...w, limit: 1000 })))).map(readable);
      const main = (i.metrics ?? DEFAULT_METRICS)[0]!;
      const out: Record<string, unknown> = {
        period: windows[0],
        previous: windows[1],
        totals: { now: now!.totals, before: before!.totals },
        changes: Object.fromEntries(Object.keys(now!.totals).map((m) => [m, change(now!.totals[m] ?? 0, before!.totals[m] ?? 0)])),
      };
      if (i.dimension) {
        const field = BREAKDOWN[i.dimension as keyof typeof BREAKDOWN];
        const was = new Map(before!.rows.map((r) => [r[field], r]));
        out.rows = now!.rows
          .map((r) => {
            const old = was.get(r[field]) ?? {};
            return { [field]: r[field], now: r, before: old, change: change(Number(r[main] ?? 0), Number(old[main] ?? 0)) };
          })
          .sort((a, b) => Math.abs(Number(b.now[main] ?? 0) - Number(b.before[main] ?? 0)) - Math.abs(Number(a.now[main] ?? 0) - Number(a.before[main] ?? 0)))
          .slice(0, i.limit);
      }
      return out;
    },
  },
  live_visitors: {
    description: "Who is on the website right now: people active in the last half hour, and which pages, countries or sources they came through.",
    readOnly: true,
    input: z.object({
      propertiesId,
      dimension: z.enum(["page", "country", "city", "device", "platform", "event"]).optional().describe("Split the live count by this (default: just the number). Where people came from isn't in the live numbers, only in googleanalytics.website_report"),
      minutes: z.number().int().min(1).max(30).default(30).describe("How far back to count, in minutes (default 30, the most Google keeps live)"),
      limit: z.number().int().min(1).max(100).default(20).describe("At most this many rows (default 20)"),
    }),
    async run(i, key) {
      const LIVE: Record<string, string> = { page: "unifiedScreenName", country: "country", city: "city", device: "deviceCategory", platform: "platform", event: "eventName" };
      const res = (await call(api, key, RUN_REALTIME, {
        propertiesId: i.propertiesId,
        minuteRanges: [{ startMinutesAgo: i.minutes, endMinutesAgo: 0 }],
        dimensions: i.dimension ? [{ name: LIVE[i.dimension] }] : undefined,
        metrics: [{ name: "activeUsers" }, { name: "screenPageViews" }, { name: "keyEvents" }],
        metricAggregations: ["TOTAL"],
        limit: i.limit,
        orderBys: i.dimension ? [{ metric: { metricName: "activeUsers" }, desc: true }] : undefined,
      })) as ReportAnswer;
      const read = readable(res);
      return { minutes: i.minutes, active_users: read.totals.activeUsers ?? 0, ...read };
    },
  },
  send_events: {
    description: "Record something that happened outside the website in Analytics — an order taken on the phone, a quote accepted — so it shows up in the reports. Needs the data stream's measurement id and a measurement protocol secret.",
    input: mpInput,
    run: (i) => measurementProtocol(i, false),
  },
  validate_events: {
    description: "Check events against Google's rules before sending them for real: it answers with what is wrong, and records nothing.",
    readOnly: true,
    input: mpInput,
    run: (i) => measurementProtocol(i, true),
  },
};

// every action, generated or written by hand, takes a property either way round
const actions = Object.fromEntries(Object.entries({ ...generated, ...extras }).map(([n, a]) => [n, shortIds(a)])) as Record<string, OwnAction>;

export const googleanalytics: OwnApp = {
  app: "googleanalytics",
  name: "Google Analytics",
  logo: "/logos/googleanalytics.svg",
  check: googleCheck,
  oauth: googleOAuth("Google Analytics", "googleanalytics"),
  actions: {
    ...actions,
    // Composio's names for the same two calls, kept so a skill written against it still works
    list_properties_filtered: actions.list_properties!,
    list_sk_ad_network_conversion_value_schemas: actions.list_sk_ad_network_conversion_value_schema!,
  },
};
