// Analytics sends no webhooks, so these watch it by asking: new properties, data streams, conversions and audiences,
// anything someone changed in the setup, how busy the site is right now, and big moves against the period before.
import { z } from "zod";
import { recent, type PollTrigger, type Run } from "./index";

const PROPERTY = { property: z.string().describe('The property to watch, from googleanalytics.list_properties: its number, or the whole "properties/123456"') };
const EVERY = { every: 60, min: 15 } as const;
const LIVE = { every: 5, min: 5 } as const;
const property = (): PollTrigger["output"][number] => ({ name: "property", type: "string", required: true, description: "The property watched" });

// a new thing on a property: its resource name never changes, so each one is reported once
const appears = (description: string, action: string, field: string, list: string, what: string, config: z.ZodRawShape = {}): PollTrigger => ({
  description,
  config: z.object({ ...PROPERTY, ...config }),
  output: [property(), { name: field, type: "object", required: true, description: what }],
  ...EVERY,
  poll: async (c, run) => {
    const res = (await run(action, { propertiesId: c.property, pageSize: 200 })) as Record<string, { name: string }[]>;
    return (res[list] ?? []).map((item) => ({ id: item.name, item: { property: c.property, [field]: item } }));
  },
});

const metricNames = z.array(z.string()).optional().describe("Which numbers to compare, in Google's names (default activeUsers, sessions, keyEvents)");
const DEFAULTS = ["activeUsers", "sessions", "keyEvents"];

export const googleanalytics: Record<string, PollTrigger> = {
  new_property_trigger: {
    description: "A new Analytics property is set up under an account.",
    config: z.object({ account: z.string().describe('The account to watch, from googleanalytics.list_accounts: its number, or the whole "accounts/123456"') }),
    output: [{ name: "property", type: "object", required: true, description: "The new property: name, displayName, timeZone, currencyCode, createTime, industryCategory" }],
    ...EVERY,
    poll: async (c, run) => {
      const account = String(c.account).startsWith("accounts/") ? c.account : `accounts/${c.account}`;
      const res = (await run("googleanalytics.list_properties", { filter: `parent:${account}`, pageSize: 200 })) as { properties?: { name: string }[] };
      return (res.properties ?? []).map((p) => ({ id: p.name, item: { property: p } }));
    },
  },
  new_data_stream_trigger: appears(
    "A new data stream is added to a property, which is how a website or app starts sending data in.",
    "googleanalytics.list_data_streams",
    "data_stream",
    "dataStreams",
    "The new stream: name, displayName, type, webStreamData (measurement id and site address), createTime",
  ),
  new_key_event_trigger: appears("A new conversion (key event) is set up on a property.", "googleanalytics.list_key_events", "key_event", "keyEvents", "The conversion: name, eventName, countingMethod, createTime"),
  new_audience_trigger: appears("A new audience is created on a property.", "googleanalytics.list_audiences", "audience", "audiences", "The audience: name, displayName, description, membershipDurationDays, filterClauses"),
  new_custom_dimension_trigger: appears(
    "A new custom dimension is added to a property, so something the site sends starts showing up in reports.",
    "googleanalytics.list_custom_dimensions",
    "custom_dimension",
    "customDimensions",
    "The dimension: name, parameterName, displayName, scope",
  ),
  setup_changed_trigger: {
    description: "Someone changes the Analytics setup: a property, data stream, conversion, audience or who has access. Useful for noticing a change nobody mentioned.",
    config: z.object({
      account: z.string().describe('The account to watch, from googleanalytics.list_accounts: its number, or the whole "accounts/123456"'),
      resource_type: z.array(z.string()).optional().describe("Only these kinds, in Google's names, e.g. PROPERTY, DATA_STREAM, GOOGLE_SIGNALS_SETTINGS, AUDIENCE, ACCESS_BINDING (default: every kind)"),
      action: z.array(z.string()).optional().describe("Only CREATED, UPDATED or DELETED (default: all three)"),
    }),
    output: [
      { name: "change", type: "object", required: true, description: "The change: id, changeTime, actorType, userActorEmail, changesFiltered and changes (each with resource, action, resourceBeforeChange, resourceAfterChange)" },
      { name: "actor", type: "string", required: false, description: "Who did it, where Google says" },
    ],
    ...EVERY,
    async poll(c, run) {
      const res = (await run("googleanalytics.search_change_history_events", {
        accountsId: c.account,
        earliestChangeTime: new Date(Date.now() - 86_400_000).toISOString(),
        resourceType: c.resource_type,
        action: c.action,
        pageSize: 200,
      })) as { changeHistoryEvents?: { id: string; changeTime?: string; userActorEmail?: string }[] };
      return (res.changeHistoryEvents ?? []).filter((e) => recent(e.changeTime)).map((change) => ({ id: change.id, item: { change, actor: change.userActorEmail } }));
    },
  },
  live_visitors_trigger: {
    description: "More people than usual are on the website right now: the number active in the last half hour goes above (or below) a figure you set. Reported once per quiet period, so a busy afternoon isn't reported over and over.",
    config: z.object({
      ...PROPERTY,
      visitors: z.number().int().min(1).default(50).describe("The number to watch for (default 50)"),
      when: z.enum(["above", "below"]).default("above").describe("Report when the live count goes above this number, or below it (default above)"),
      quiet_minutes: z.number().int().min(5).max(1440).default(60).describe("At most one report per this many minutes while it stays that way (default 60)"),
    }),
    output: [property(), { name: "active_users", type: "number", required: true, description: "People active in the last half hour" }, { name: "page_views", type: "number", required: false, description: "Page views in the same half hour" }, { name: "top", type: "object", required: false, description: "The busiest pages right now" }],
    ...LIVE,
    async poll(c, run) {
      const res = (await run("googleanalytics.live_visitors", { propertiesId: c.property, dimension: "page", limit: 10 })) as { active_users: number; totals: Record<string, number>; rows: Record<string, unknown>[] };
      const users = res.active_users ?? 0;
      if (c.when === "above" ? users < c.visitors : users > c.visitors) return [];
      return [
        {
          // the quiet period is part of the id, so one stretch of being busy is reported once per period
          id: `${c.when}:${c.visitors}:${Math.floor(Date.now() / (c.quiet_minutes * 60_000))}`,
          item: { property: c.property, active_users: users, page_views: res.totals?.screenPageViews, top: res.rows?.slice(0, 10) },
        },
      ];
    },
  },
  traffic_change_trigger: {
    description: "The website's numbers move a lot against the period just before: visitors, sessions or conversions up or down by more than the share you set. Reported at most once a day, since the numbers settle daily.",
    config: z.object({
      ...PROPERTY,
      days: z.number().int().min(1).max(90).default(7).describe("The length of each period in days (default 7, so the last 7 days against the 7 before them)"),
      metric: z.string().default("activeUsers").describe("Which number to watch, in Google's name (default activeUsers; others: sessions, keyEvents, screenPageViews, totalRevenue)"),
      percent: z.number().min(1).max(1000).default(20).describe("How big the move has to be, in percent (default 20)"),
      direction: z.enum(["up", "down", "either"]).default("either").describe("Only jumps, only drops, or both (default both)"),
      metrics: metricNames,
    }),
    output: [
      property(),
      { name: "metric", type: "string", required: true, description: "The number watched" },
      { name: "direction", type: "string", required: true, description: "up or down" },
      { name: "percent_change", type: "number", required: true, description: "How big the move was, in percent (negative for a drop)" },
      { name: "now", type: "object", required: true, description: "This period's numbers" },
      { name: "before", type: "object", required: true, description: "The period before it" },
      { name: "period", type: "object", required: true, description: "The dates compared" },
    ],
    ...EVERY,
    async poll(c, run) {
      const wanted = [...new Set([c.metric, ...(c.metrics ?? DEFAULTS)])];
      const res = (await run("googleanalytics.compare_website_report", { propertiesId: c.property, days: c.days, metrics: wanted })) as {
        period: { startDate: string; endDate: string };
        totals: { now: Record<string, number>; before: Record<string, number> };
        changes: Record<string, number>;
      };
      const moved = (res.changes?.[c.metric] ?? 0) * 100;
      const direction = moved >= 0 ? "up" : "down";
      if (Math.abs(moved) < c.percent || (c.direction !== "either" && c.direction !== direction)) return [];
      return [
        {
          // one report a day: the period ends today, so the id changes when the day does
          id: `${c.metric}:${direction}:${new Date().toISOString().slice(0, 10)}`,
          item: { property: c.property, metric: c.metric, direction, percent_change: Math.round(moved), now: res.totals.now, before: res.totals.before, period: res.period },
        },
      ];
    },
  },
  key_events_threshold_trigger: {
    description: "Conversions today pass a number you set — enough orders, enquiries or sign-ups for the day. Reported once per quiet period.",
    config: z.object({
      ...PROPERTY,
      count: z.number().int().min(1).default(10).describe("How many conversions today (default 10)"),
      metric: z.string().default("keyEvents").describe("Which number counts as a conversion (default keyEvents; could be transactions or eventCount)"),
      event_name: z.string().optional().describe('Only one kind of conversion, by its event name, e.g. "purchase"'),
      quiet_minutes: z.number().int().min(15).max(1440).default(240).describe("At most one report per this many minutes while it stays over (default 240)"),
    }),
    output: [property(), { name: "metric", type: "string", required: true, description: "The number counted" }, { name: "count", type: "number", required: true, description: "How many so far today" }, { name: "rows", type: "object", required: false, description: "The breakdown by event name, when one was asked for" }],
    ...EVERY,
    async poll(c, run) {
      const res = (await run("googleanalytics.website_report", { propertiesId: c.property, days: 1, metrics: [c.metric], dimension: c.event_name ? "event" : undefined, contains: c.event_name, limit: 50 })) as {
        totals: Record<string, number>;
        rows: Record<string, unknown>[];
      };
      const count = c.event_name ? (res.rows ?? []).reduce((n, r) => n + Number(r[c.metric] ?? 0), 0) : (res.totals?.[c.metric] ?? 0);
      if (count < c.count) return [];
      return [{ id: `${c.metric}:${c.count}:${Math.floor(Date.now() / (c.quiet_minutes * 60_000))}`, item: { property: c.property, metric: c.metric, count, rows: c.event_name ? res.rows : undefined } }];
    },
  },
};
