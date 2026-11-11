import { afterEach, expect, test } from "bun:test";
import { z } from "zod";
import { CATALOG } from "../../catalog";
import { pollOnce } from "../../polls/index";
import { AppFile } from "../../types";
import { own } from "../index";
import { googlebusiness, stars } from "./index";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
type Call = { url: URL; method: string; body: any; raw: BodyInit | undefined; headers: Record<string, string> };
const stub = (answer: (c: Call) => Response) => {
  const calls: Call[] = [];
  globalThis.fetch = (async (url: string, init: RequestInit = {}) => {
    let body: unknown;
    try {
      body = init.body ? JSON.parse(String(init.body)) : undefined;
    } catch {
      body = undefined;
    }
    const c = { url: new URL(String(url)), method: init.method ?? "GET", body, raw: init.body ?? undefined, headers: init.headers as Record<string, string> };
    calls.push(c);
    return answer(c);
  }) as typeof fetch;
  return calls;
};
const login = { externalId: "c1", secret: "tok" };
const run = (a: string, i: unknown) => own.run(a, i, login, "o");

const ACCOUNTS = { accounts: [{ name: "accounts/111", accountName: "Dosa Corner", type: "LOCATION_GROUP" }] };
const LOCATIONS = {
  locations: [
    { name: "locations/222", title: "Dosa Corner, Koramangala", storefrontAddress: { addressLines: ["5th Block"], locality: "Bengaluru", postalCode: "560095" } },
    { name: "locations/333", title: "Dosa Corner, Indiranagar", storefrontAddress: { addressLines: ["100ft Road"], locality: "Bengaluru" } },
  ],
};
const review = (id: string, rating: string, over: Record<string, unknown> = {}) => ({
  name: `accounts/111/locations/222/reviews/${id}`,
  reviewId: id,
  reviewer: { displayName: "Asha" },
  starRating: rating,
  comment: "Lovely dosa",
  createTime: new Date(Date.now() - 3_600_000).toISOString(),
  updateTime: new Date(Date.now() - 3_600_000).toISOString(),
  ...over,
});
// accounts, then the locations of each, then reviews for them all: the walk every helper and poll makes
const business = (reviews: any[], extra: (c: Call) => Response | undefined = () => undefined) =>
  stub((c) => {
    const more = extra(c);
    if (more) return more;
    if (c.url.pathname === "/v1/accounts") return json(ACCOUNTS);
    if (c.url.pathname === "/v1/accounts/111/locations") return json(LOCATIONS);
    if (c.url.pathname.endsWith(":batchGetReviews")) return json({ locationReviews: reviews.map((r) => ({ name: "accounts/111/locations/222", review: r })) });
    return json({});
  });

test("it is in the catalog and the app list, with a logo", async () => {
  expect(CATALOG.find((a) => a.app === "googlebusiness")).toMatchObject({ provider: "own", name: "Google Business Profile" });
  expect((await own.listActions("googlebusiness")).length).toBeGreaterThan(70);
  expect(await Bun.file(new URL(`../../../../../frontend/public${googlebusiness.logo}`, import.meta.url)).exists()).toBe(true);
  // sign-in only: there is no key to paste
  expect(googlebusiness.keyField).toBeUndefined();
});

test("reads run unasked, writes ask, and every input is a usable schema", async () => {
  for (const r of ["get_reviews", "get_review", "list_all_reviews", "reviews_summary", "find_location", "get_locations" in googlebusiness.actions ? "get_location" : "get_location", "get_media", "list_customer_media", "get_performance", "get_voice_of_merchant_state", "search_google_locations", "list_verification_options", "get_location_edit_status"])
    expect((await own.getAction(`googlebusiness.${r}`))?.readOnly, r).toBe(true);
  for (const w of ["update_review_reply", "reply_to_review", "remove_review_reply", "delete_review_reply", "create_local_post", "delete_local_post", "create_media", "add_photo", "update_location", "delete_location", "start_verification", "update_notification_setting"])
    expect((await own.getAction(`googlebusiness.${w}`))?.readOnly, w).toBeFalsy();
  for (const [name, a] of Object.entries(googlebusiness.actions)) {
    expect(a.description.length, name).toBeGreaterThan(20);
    z.toJSONSchema(a.input, { io: "input" });
  }
});

test("each generated action goes to its own Google service", async () => {
  const calls = stub(() => json({}));
  await run("googlebusiness.get_location", { locationsId: "222", readMask: "title,regularHours" });
  await run("googlebusiness.get_accounts", {});
  await run("googlebusiness.list_call_insights", { locationsId: "222" });
  await run("googlebusiness.get_daily_metrics", { locationsId: "222", dailyMetric: "CALL_CLICKS" });
  expect(calls.map((c) => c.url.origin + c.url.pathname)).toEqual([
    "https://mybusinessbusinessinformation.googleapis.com/v1/locations/222",
    "https://mybusinessaccountmanagement.googleapis.com/v1/accounts",
    "https://mybusinessbusinesscalls.googleapis.com/v1/locations/222/businesscallsinsights",
    "https://businessprofileperformance.googleapis.com/v1/locations/222:getDailyMetricsTimeSeries",
  ]);
  expect(calls[0]!.url.searchParams.get("readMask")).toBe("title,regularHours");
  expect(calls[0]!.headers.Authorization).toBe("Bearer tok");
});

test("reviews come from the legacy v4 API, with the sort in the query", async () => {
  const calls = stub(() => json({ reviews: [], averageRating: 4.5, totalReviewCount: 2 }));
  await run("googlebusiness.get_reviews", { accountId: "111", locationId: "222", orderBy: "rating", pageSize: 50 });
  expect(calls[0]!.url.origin + calls[0]!.url.pathname).toBe("https://mybusiness.googleapis.com/v4/accounts/111/locations/222/reviews");
  expect(Object.fromEntries(calls[0]!.url.searchParams)).toEqual({ orderBy: "rating", pageSize: "50" });
});

test("reply_to_review takes the review's own name, and refuses one that isn't", async () => {
  const calls = stub(() => json({ comment: "Thank you!" }));
  await run("googlebusiness.reply_to_review", { review: "accounts/111/locations/222/reviews/ABC", comment: "Thank you!" });
  expect(calls[0]!.method).toBe("PUT");
  expect(calls[0]!.url.pathname).toBe("/v4/accounts/111/locations/222/reviews/ABC/reply");
  expect(calls[0]!.body).toEqual({ comment: "Thank you!" });
  await run("googlebusiness.remove_review_reply", { review: "accounts/111/locations/222/reviews/ABC" });
  expect(calls[1]!.method).toBe("DELETE");
  expect(calls[1]!.url.pathname).toBe("/v4/accounts/111/locations/222/reviews/ABC/reply");
  await expect(run("googlebusiness.reply_to_review", { review: "ABC", comment: "hi" })).rejects.toThrow("isn't a review's name");
});

test("find_location walks accounts to shops, and the query narrows it", async () => {
  business([]);
  const all = (await run("googlebusiness.find_location", {})) as any;
  expect(all.count).toBe(2);
  expect(all.shops[0]).toMatchObject({ accountId: "111", locationId: "222", location: "accounts/111/locations/222", title: "Dosa Corner, Koramangala", address: "5th Block, Bengaluru, 560095" });
  business([]);
  const one = (await run("googlebusiness.find_location", { query: "indiranagar" })) as any;
  expect(one.shops.map((s: any) => s.locationId)).toEqual(["333"]);
});

test("list_all_reviews fetches every shop in one call per account, and filters", async () => {
  const calls = business([review("A", "FIVE"), review("B", "TWO"), review("C", "ONE", { reviewReply: { comment: "sorry" } })]);
  const out = (await run("googlebusiness.list_all_reviews", {})) as any;
  const batch = calls.find((c) => c.url.pathname.endsWith(":batchGetReviews"))!;
  expect(batch.body.locationNames).toEqual(["accounts/111/locations/222", "accounts/111/locations/333"]);
  expect(out.count).toBe(3);
  expect(out.reviews[0]).toMatchObject({ rating: 5, replied: false, shop: "Dosa Corner, Koramangala" });

  business([review("A", "FIVE"), review("B", "TWO"), review("C", "ONE", { reviewReply: { comment: "sorry" } })]);
  const unhappy = (await run("googlebusiness.list_all_reviews", { maxRating: 3, unansweredOnly: true })) as any;
  expect(unhappy.reviews.map((r: any) => r.reviewId)).toEqual(["B"]);
});

test("reviews_summary averages, counts the stars and says how many wait for a reply", async () => {
  business([review("A", "FIVE"), review("B", "TWO"), review("C", "FOUR", { reviewReply: { comment: "thanks" } })]);
  const out = (await run("googlebusiness.reviews_summary", {})) as any;
  expect(out.total).toMatchObject({ reviews: 3, average: 3.67, waitingForReply: 2 });
  expect(out.total.byStars).toEqual({ 1: 0, 2: 1, 3: 0, 4: 1, 5: 1 });
  expect(out.shops.find((s: any) => s.location === "accounts/111/locations/333").reviews).toBe(0);
});

test("a listing that can't be read is reported, not thrown", async () => {
  stub((c) => (c.url.pathname === "/v1/accounts" ? json(ACCOUNTS) : c.url.pathname === "/v1/accounts/111/locations" ? json(LOCATIONS) : json({ error: { message: "no access" } }, 403)));
  const out = (await run("googlebusiness.list_all_reviews", {})) as any;
  expect(out.reviews).toEqual([]);
  expect(out.errors[0]).toMatchObject({ account: "accounts/111" });
});

test("add_photo books the slot, sends the bytes as their own type, then adds it to the listing", async () => {
  const calls = stub((c) =>
    c.url.pathname.endsWith(":startUpload")
      ? json({ resourceName: "accounts/111/locations/222/media/itemdataref/xyz" })
      : json({ name: "accounts/111/locations/222/media/m1" }),
  );
  const file = new AppFile("shopfront.jpg", "image/jpeg", new Uint8Array([1, 2, 3]));
  await run("googlebusiness.add_photo", { accountId: "111", locationId: "222", file, category: "EXTERIOR", description: "Front of the shop" });
  expect(calls[0]!.url.pathname).toBe("/v4/accounts/111/locations/222/media:startUpload");
  // the slot's name keeps its slashes in the address
  expect(calls[1]!.url.origin + calls[1]!.url.pathname).toBe("https://mybusiness.googleapis.com/upload/v1/media/accounts/111/locations/222/media/itemdataref/xyz");
  expect(calls[1]!.url.searchParams.get("uploadType")).toBe("media");
  expect(calls[1]!.headers["Content-Type"]).toBe("image/jpeg");
  expect(calls[1]!.raw).toEqual(file.bytes as unknown as BodyInit);
  expect(calls[2]!.url.pathname).toBe("/v4/accounts/111/locations/222/media");
  expect(calls[2]!.body).toEqual({ mediaFormat: "PHOTO", locationAssociation: { category: "EXTERIOR" }, dataRef: { resourceName: "accounts/111/locations/222/media/itemdataref/xyz" }, description: "Front of the shop" });
  await expect(run("googlebusiness.add_photo", { accountId: "111", locationId: "222", file: "/work/x.jpg" })).rejects.toThrow("give the picture as");
});

test("get_performance turns plain dates into Google's own fields and totals the days", async () => {
  const calls = stub(() =>
    json({
      multiDailyMetricTimeSeries: [{
        dailyMetricTimeSeries: [
          { dailyMetric: "CALL_CLICKS", timeSeries: { datedValues: [{ date: { year: 2026, month: 10, day: 1 }, value: "3" }, { date: { year: 2026, month: 10, day: 2 }, value: "4" }] } },
          { dailyMetric: "WEBSITE_CLICKS", timeSeries: { datedValues: [{ date: { year: 2026, month: 10, day: 1 }, value: "9" }] } },
        ],
      }],
    }),
  );
  const out = (await run("googlebusiness.get_performance", { locationId: "222", from: "2026-10-01", to: "2026-10-31", metrics: ["CALL_CLICKS", "WEBSITE_CLICKS"] })) as any;
  const q = calls[0]!.url.searchParams;
  expect(q.getAll("dailyMetrics")).toEqual(["CALL_CLICKS", "WEBSITE_CLICKS"]);
  expect([q.get("dailyRange.startDate.year"), q.get("dailyRange.startDate.month"), q.get("dailyRange.startDate.day")]).toEqual(["2026", "10", "1"]);
  expect([q.get("dailyRange.endDate.year"), q.get("dailyRange.endDate.month"), q.get("dailyRange.endDate.day")]).toEqual(["2026", "10", "31"]);
  expect(out.totals).toEqual({ CALL_CLICKS: 7, WEBSITE_CLICKS: 9 });
  expect(out.daily.CALL_CLICKS[0]).toEqual({ date: "2026-10-01", value: 3 });
  await expect(run("googlebusiness.get_performance", { locationId: "222", from: "last week", to: "2026-10-31" })).rejects.toThrow("give the day as");
});

test("edit status goes to the v1alpha service, which is where Google put it", async () => {
  const calls = stub(() => json({}));
  await run("googlebusiness.get_location_edit_status", { locationId: "222" });
  expect(calls[0]!.url.origin + calls[0]!.url.pathname).toBe("https://mybusinessbusinessinformation.googleapis.com/v1alpha/locations/222:getExtended");
  expect(calls[0]!.url.searchParams.get("readMask")).toBe("*");
});

// ----- polled triggers -----
const poll = (trigger: string, config: unknown, seen: string[] | null) => pollOnce(`googlebusiness.${trigger}`, config, seen, run);

test("new_review: the first check is quiet, then only brand new reviews start it", async () => {
  const old = new Date(Date.now() - 3 * 86_400_000).toISOString();
  const rows = [review("A", "FIVE"), review("OLD", "FIVE", { createTime: old, updateTime: old })];
  business(rows);
  const first = await poll("new_review", {}, null);
  expect(first.fresh).toEqual([]);
  expect(first.seen).toEqual(["accounts/111/locations/222/reviews/A"]);

  business([...rows, review("NEW", "ONE")]);
  const next = await poll("new_review", {}, first.seen);
  expect((next.fresh[0] as any).review.reviewId).toBe("NEW");
});

test("new_review: the star filter keeps the happy ones from waking anyone", async () => {
  business([review("HAPPY", "FIVE"), review("ANGRY", "ONE")]);
  const seen = (await poll("new_review", { maxRating: 2 }, null)).seen;
  expect(seen).toEqual(["accounts/111/locations/222/reviews/ANGRY"]);
  business([review("HAPPY", "FIVE"), review("ANGRY", "ONE"), review("CROSS", "TWO")]);
  const next = await poll("new_review", { maxRating: 2 }, seen);
  expect(next.fresh.map((f: any) => f.review.reviewId)).toEqual(["CROSS"]);
});

test("review_updated: a first save is not a change, and each later state is reported once", async () => {
  const made = new Date(Date.now() - 7_200_000).toISOString();
  const fresh = review("A", "FIVE", { createTime: made, updateTime: made });
  business([fresh]);
  expect((await poll("review_updated", {}, [])).fresh).toEqual([]);

  const replied = { ...fresh, updateTime: new Date().toISOString(), reviewReply: { comment: "Thank you!" } };
  business([replied]);
  const once = await poll("review_updated", {}, []);
  expect(once.fresh.length).toBe(1);
  expect(once.seen[0]).toBe(`accounts/111/locations/222/reviews/A:${replied.updateTime}`);
  business([replied]);
  expect((await poll("review_updated", {}, once.seen)).fresh).toEqual([]);
});

test("voice_of_merchant_changed: steady is quiet, a change is reported once", async () => {
  const state = (over: Record<string, unknown>) => (c: Call) => (c.url.pathname.endsWith("/VoiceOfMerchantState") ? json(over) : undefined);
  business([], state({ hasVoiceOfMerchant: true, hasBusinessAuthority: true }));
  const first = await poll("voice_of_merchant_changed", {}, null);
  expect(first.seen).toHaveLength(2);
  business([], state({ hasVoiceOfMerchant: true, hasBusinessAuthority: true }));
  expect((await poll("voice_of_merchant_changed", {}, first.seen)).fresh).toEqual([]);

  business([], state({ hasVoiceOfMerchant: false, complyWithGuidelines: { recommendationReason: "BUSINESS_LOCATION_SUSPENDED" } }));
  const lost = await poll("voice_of_merchant_changed", {}, first.seen);
  expect(lost.fresh).toHaveLength(2);
  expect((lost.fresh[0] as any).verified).toBe(false);
});

test("google_update_pending: only a listing Google has actually changed", async () => {
  const updated = (diffMask?: string) => (c: Call) => (c.url.pathname.endsWith(":getGoogleUpdated") ? json(diffMask ? { name: "locations/222", diffMask } : { name: "locations/222" }) : undefined);
  business([], updated());
  expect((await poll("google_update_pending", {}, [])).fresh).toEqual([]);
  business([], updated("regularHours,phoneNumbers"));
  const out = await poll("google_update_pending", {}, []);
  expect(out.fresh).toHaveLength(2);
  expect((out.fresh[0] as any).changed).toBe("regularHours,phoneNumbers");
});

test("new_customer_photo: only photos added since the last check", async () => {
  const old = new Date(Date.now() - 3 * 86_400_000).toISOString();
  const media = (items: any[]) => (c: Call) => (c.url.pathname.endsWith("/media/customers") ? json({ mediaItems: items }) : undefined);
  business([], media([{ name: "accounts/111/locations/222/media/old", createTime: old }, { name: "accounts/111/locations/222/media/new", createTime: new Date().toISOString() }]));
  const first = await poll("new_customer_photo", {}, null);
  expect(first.seen).toEqual(["accounts/111/locations/222/media/new"]);
});

test("star ratings read as numbers", () => {
  expect([stars("ONE"), stars("FIVE"), stars("STAR_RATING_UNSPECIFIED"), stars(undefined)]).toEqual([1, 5, 0, 0]);
});
