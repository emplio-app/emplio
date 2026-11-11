// Google Business Profile: the business's own listing on Google Search and Maps - its shops, hours, photos, posts
// and, above all, its reviews. Google splits this across eight small APIs plus the legacy My Business v4, so the
// generated actions (`bun scripts/openapi-actions.ts googlebusiness`) carry every method of the eight, v4.ts carries
// reviews, posts, photos, menus and services by hand, and the helpers below are what a shop owner actually asks for.
// Triggers are polled (polls/googlebusiness.ts). COVERAGE.md says what is left out and why.
import { z } from "zod";
import { AppFile, AppsError } from "../../types";
import { googleApi, googleCheck, googleOAuth } from "../google-login";
import type { OwnAction, OwnApp } from "../index";
import { call, type Send, specActions } from "../openapi";
import { accountId, locationId, V4, v4Actions } from "./v4";

const NAME = "Google Business Profile";
// each generated action carries its own service host; this base is only for the hand-written v4 calls
const api = googleApi(NAME, V4);
// uploading a photo's bytes: its own host, and Google wants the picture's real type, not application/octet-stream
const uploads = { ...googleApi(NAME, "https://mybusiness.googleapis.com"), upload: (file: AppFile, _s: Send, headers: Record<string, string>) => { headers["Content-Type"] = file.mimetype; } };

const generated = await specActions(new URL("./actions.json", import.meta.url), api);
const v4 = v4Actions(api);
const actions = { ...generated, ...v4 };

// what `list_locations` answers with when nobody says otherwise: enough to recognise a shop
const LOCATION_FIELDS = "name,title,storefrontAddress,phoneNumbers,websiteUri,categories,metadata,openInfo,regularHours";
const STARS: Record<string, number> = { ONE: 1, TWO: 2, THREE: 3, FOUR: 4, FIVE: 5 };
export const stars = (rating: unknown) => STARS[String(rating)] ?? 0;

type Listing = { account: string; accountId: string; accountName?: string; location: string; locationId: string; title?: string; address?: string };
type Named = { name?: string };

const idOf = (name: unknown) => String(name ?? "").split("/").pop() ?? "";
const line = (a: any) => [...(a?.addressLines ?? []), a?.locality, a?.administrativeArea, a?.postalCode].filter(Boolean).join(", ") || undefined;

// Every shop on every account this sign-in can reach, with the ids the v4 actions need. `match` keeps only the
// shops whose name or address contains it.
export async function listings(key: string, match?: string): Promise<Listing[]> {
  const accounts = ((await actions.get_accounts!.run({ pageSize: 20 }, key)) as { accounts?: (Named & { accountName?: string })[] }).accounts ?? [];
  const out: Listing[] = [];
  for (const account of accounts) {
    const page = (await actions.list_locations!.run({ accountsId: idOf(account.name), readMask: LOCATION_FIELDS, pageSize: 100 }, key).catch(() => ({}))) as {
      locations?: (Named & { title?: string; storefrontAddress?: unknown })[];
    };
    for (const l of page.locations ?? [])
      out.push({
        account: String(account.name),
        accountId: idOf(account.name),
        accountName: account.accountName,
        location: `${account.name}/${l.name}`,
        locationId: idOf(l.name),
        title: l.title,
        address: line(l.storefrontAddress),
      });
  }
  const want = match?.trim().toLowerCase();
  return want ? out.filter((l) => `${l.title ?? ""} ${l.address ?? ""}`.toLowerCase().includes(want)) : out;
}

// The review's own name holds everything a reply needs: accounts/1/locations/2/reviews/ABC
const splitReview = (name: string) => {
  const m = /^accounts\/([^/]+)\/locations\/([^/]+)\/reviews\/([^/]+)$/.exec(name.trim());
  if (!m) throw new AppsError(`"${name}" isn't a review's name; they look like accounts/123/locations/456/reviews/ABC (googlebusiness.list_all_reviews gives them)`);
  return { accountId: m[1]!, locationId: m[2]!, reviewId: m[3]! };
};

const reviewsOf = async (key: string, shops: Listing[], orderBy?: string) => {
  const byAccount = new Map<string, Listing[]>();
  for (const s of shops) byAccount.set(s.accountId, [...(byAccount.get(s.accountId) ?? []), s]);
  const reviews: any[] = [];
  const errors: { account: string; error: string }[] = [];
  for (const [account, group] of byAccount) {
    // one call covers every shop on the account, so a chain of ten shops is still one request
    const page = (await actions.batch_get_reviews!.run({ accountId: account, locationNames: group.map((g) => g.location), orderBy, pageSize: 50 }, key).catch((e: Error) => {
      errors.push({ account: `accounts/${account}`, error: e.message });
      return {};
    })) as { locationReviews?: { name?: string; review?: any }[] };
    for (const lr of page.locationReviews ?? []) {
      const shop = group.find((g) => g.location === lr.name || g.locationId === idOf(lr.name));
      reviews.push({ ...lr.review, location: lr.name, shop: shop?.title, rating: stars(lr.review?.starRating), replied: Boolean(lr.review?.reviewReply) });
    }
  }
  return { reviews, errors };
};

const helpers: Record<string, OwnAction> = {
  find_location: {
    description: "Find the business's shops on Google: every listing this sign-in can manage, with the account id and listing id every other Google Business Profile action needs. Start here when you only know the shop by name.",
    readOnly: true,
    input: z.object({ query: z.string().optional().describe("Only shops whose name or address contains these words (default: all of them)") }),
    run: (i, key) => listings(key, i.query).then((shops) => ({ shops, count: shops.length })),
  },
  list_all_reviews: {
    description: "Every review across all the business's shops, newest change first, each saying which shop it is for and whether the owner has answered it. This is the one to use for \"what are people saying about us\".",
    readOnly: true,
    input: z.object({
      query: z.string().optional().describe("Only shops whose name or address contains these words (default: all of them)"),
      orderBy: z.enum(["updateTime desc", "rating", "rating desc"]).optional().describe('How to sort: "updateTime desc" (default, latest change first), "rating" (worst first) or "rating desc" (best first)'),
      maxRating: z.number().int().min(1).max(5).optional().describe("Only reviews of this many stars or fewer, so 3 finds the unhappy ones"),
      unansweredOnly: z.boolean().default(false).describe("true: only reviews the business has not replied to yet"),
      limit: z.number().int().min(1).max(200).default(50).describe("How many reviews to answer with (default 50)"),
    }),
    async run(i, key) {
      const shops = await listings(key, i.query);
      if (!shops.length) return { reviews: [], count: 0, shops: 0, note: "No shops found for this sign-in. Check it manages a Google Business Profile." };
      const { reviews, errors } = await reviewsOf(key, shops, i.orderBy);
      const kept = reviews
        .filter((r) => (i.maxRating ? r.rating && r.rating <= i.maxRating : true))
        .filter((r) => (i.unansweredOnly ? !r.replied : true));
      return { reviews: kept.slice(0, i.limit), count: kept.length, shops: shops.length, ...(errors.length && { errors }) };
    },
  },
  reviews_summary: {
    description: "How the business is doing on reviews: average stars, how many reviews, how many of each star rating, and how many are still waiting for a reply - for each shop and for the business as a whole.",
    readOnly: true,
    input: z.object({ query: z.string().optional().describe("Only shops whose name or address contains these words (default: all of them)") }),
    async run(i, key) {
      const shops = await listings(key, i.query);
      const { reviews, errors } = await reviewsOf(key, shops);
      const tally = (rows: any[]) => {
        const rated = rows.filter((r) => r.rating);
        const byStars = Object.fromEntries([1, 2, 3, 4, 5].map((n) => [n, rated.filter((r) => r.rating === n).length]));
        return {
          reviews: rows.length,
          average: rated.length ? Math.round((rated.reduce((t, r) => t + r.rating, 0) / rated.length) * 100) / 100 : null,
          byStars,
          waitingForReply: rows.filter((r) => !r.replied).length,
          latest: rows.map((r) => r.updateTime).filter(Boolean).sort().at(-1),
        };
      };
      return {
        total: tally(reviews),
        shops: shops.map((s) => ({ shop: s.title, location: s.location, ...tally(reviews.filter((r) => r.location === s.location)) })),
        ...(errors.length && { errors }),
      };
    },
  },
  reply_to_review: {
    description: "Reply to a review in public, as the business. Takes the review's own name, so it can be used straight from list_all_reviews or a new-review automation. A reply already there is replaced, and the customer is emailed that the business answered.",
    input: z.object({
      review: z.string().describe("The review's name, as list_all_reviews gives it: accounts/123/locations/456/reviews/ABC"),
      comment: z.string().max(4096).describe("The reply, as plain text, in the business's own voice. Everyone who reads the listing sees it"),
    }),
    run: (i, key) => actions.update_review_reply!.run({ ...splitReview(i.review), comment: i.comment }, key),
  },
  remove_review_reply: {
    description: "Take the business's reply off a review, by the review's own name. The review itself stays.",
    input: z.object({ review: z.string().describe("The review's name: accounts/123/locations/456/reviews/ABC") }),
    run: (i, key) => actions.delete_review_reply!.run(splitReview(i.review), key),
  },
  add_photo: {
    description: "Put a photo or video from this computer on a shop's Google listing: books the upload, sends the file and adds it to the listing in one go. Photos must be at least 250px on the short side and 10KB, except the profile and cover ones.",
    input: z.object({
      accountId,
      locationId,
      file: z.any().describe('The picture or video from this computer: {"file": "/work/shopfront.jpg"}'),
      category: z.enum(["COVER", "PROFILE", "EXTERIOR", "INTERIOR", "PRODUCT", "AT_WORK", "FOOD_AND_DRINK", "MENU", "COMMON_AREA", "ROOMS", "TEAMS", "ADDITIONAL"]).default("ADDITIONAL").describe("Where it belongs on the listing. A listing has only one COVER and one PROFILE"),
      description: z.string().optional().describe("A caption. Not allowed on the cover photo"),
    }),
    async run(i, key) {
      if (!(i.file instanceof AppFile)) throw new AppsError('file: give the picture as {"file": "/work/shopfront.jpg"}');
      const ref = (await actions.start_media_upload!.run({ accountId: i.accountId, locationId: i.locationId }, key)) as { resourceName?: string };
      if (!ref.resourceName) throw new AppsError("Google didn't give an upload slot for this listing");
      // the slot's name holds slashes and must go in the address as it is, so the path is built here, not substituted
      await call(uploads, key, { method: "POST", path: `/upload/v1/media/${ref.resourceName}`, query: ["uploadType"], headers: [], body: { kind: "file", field: "file" } }, { file: i.file, uploadType: "media" });
      return actions.create_media!.run({
        accountId: i.accountId,
        locationId: i.locationId,
        mediaFormat: i.file.mimetype.startsWith("video/") ? "VIDEO" : "PHOTO",
        locationAssociation: { category: i.category },
        dataRef: { resourceName: ref.resourceName },
        ...(i.description && { description: i.description }),
      }, key);
    },
  },
  get_performance: {
    description: "How a shop did on Google between two dates: how many people saw it, called, asked for directions, clicked the website, booked or ordered. Answers the day-by-day numbers and the totals.",
    readOnly: true,
    input: z.object({
      locationId,
      from: z.string().describe("First day, as 2026-10-01"),
      to: z.string().describe("Last day, as 2026-10-31. At most 18 months back, and today's numbers aren't in yet"),
      metrics: z.array(z.enum(["BUSINESS_IMPRESSIONS_DESKTOP_MAPS", "BUSINESS_IMPRESSIONS_DESKTOP_SEARCH", "BUSINESS_IMPRESSIONS_MOBILE_MAPS", "BUSINESS_IMPRESSIONS_MOBILE_SEARCH", "BUSINESS_CONVERSATIONS", "BUSINESS_DIRECTION_REQUESTS", "CALL_CLICKS", "WEBSITE_CLICKS", "MESSAGING_CLICKS", "BUSINESS_BOOKINGS", "BUSINESS_FOOD_ORDERS", "BUSINESS_FOOD_MENU_CLICKS"]))
        .default(["BUSINESS_IMPRESSIONS_MOBILE_SEARCH", "BUSINESS_IMPRESSIONS_MOBILE_MAPS", "CALL_CLICKS", "WEBSITE_CLICKS", "BUSINESS_DIRECTION_REQUESTS"])
        .describe("What to count (default: the five that matter most to a shop)"),
    }),
    async run(i, key) {
      const part = (which: "startDate" | "endDate", day: string) => {
        const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day.trim());
        if (!m) throw new AppsError(`${which === "startDate" ? "from" : "to"}: give the day as 2026-10-01`);
        return { [`dailyRange.${which}.year`]: Number(m[1]), [`dailyRange.${which}.month`]: Number(m[2]), [`dailyRange.${which}.day`]: Number(m[3]) };
      };
      const out = (await actions.get_multi_daily_metrics!.run({ locationsId: i.locationId, dailyMetrics: i.metrics, ...part("startDate", i.from), ...part("endDate", i.to) }, key)) as {
        multiDailyMetricTimeSeries?: { dailyMetricTimeSeries?: { dailyMetric?: string; timeSeries?: { datedValues?: { date?: { year?: number; month?: number; day?: number }; value?: string }[] } }[] }[];
      };
      const series = (out.multiDailyMetricTimeSeries ?? []).flatMap((m) => m.dailyMetricTimeSeries ?? []);
      const day = (d?: { year?: number; month?: number; day?: number }) => (d?.year ? `${d.year}-${String(d.month ?? 1).padStart(2, "0")}-${String(d.day ?? 1).padStart(2, "0")}` : undefined);
      return {
        from: i.from,
        to: i.to,
        totals: Object.fromEntries(series.map((s) => [s.dailyMetric, (s.timeSeries?.datedValues ?? []).reduce((t, v) => t + Number(v.value ?? 0), 0)])),
        daily: Object.fromEntries(series.map((s) => [s.dailyMetric, (s.timeSeries?.datedValues ?? []).map((v) => ({ date: day(v.date), value: Number(v.value ?? 0) }))])),
      };
    },
  },
  // Google's newest listing fields (what the owner typed, what the public sees, and why an edit was rejected) are
  // only on the v1alpha service, so these two go straight to it rather than through the generated v1 actions.
  get_location_edit_status: {
    description: "What is pending or rejected on a listing: the owner's own version of each field, the version the public sees, how far each edit has got, and why Google turned any of them down.",
    readOnly: true,
    input: z.object({
      locationId,
      readMask: z.string().default("*").describe('Which fields to answer with, comma separated, or "*" for all of them'),
    }),
    run: (i, key) => call(api, key, { method: "GET", base: "https://mybusinessbusinessinformation.googleapis.com", path: "/v1alpha/locations/{locationId}:getExtended", query: ["readMask"], headers: [] }, i),
  },
  get_location_attributes_edit_status: {
    description: "What is pending or rejected on a listing's attributes (the yes/no features like wheelchair access or outdoor seating): the owner's version, the public one, and any rejection reason.",
    readOnly: true,
    input: z.object({ locationId }),
    run: (i, key) => call(api, key, { method: "GET", base: "https://mybusinessbusinessinformation.googleapis.com", path: "/v1alpha/locations/{locationId}/attributes:getExtended", query: [], headers: [] }, i),
  },
};

export const googlebusiness: OwnApp = {
  app: "googlebusiness",
  name: NAME,
  logo: "/logos/googlebusiness.svg",
  check: googleCheck,
  oauth: googleOAuth(NAME, "googlebusiness"),
  // Composio calls adding a photo from a file "upload location media"; both names work, so a skill written against it carries over
  actions: { ...actions, ...helpers, upload_location_media: helpers.add_photo! },
};
