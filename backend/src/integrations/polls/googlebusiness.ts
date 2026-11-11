// Google Business Profile tells an app about new reviews through Cloud Pub/Sub, not a plain webhook: it needs a
// topic in a Google Cloud project of ours, publish rights for Google's own service account, a push subscription,
// and then updateNotificationSetting on every one of the owner's accounts - and the message only carries the
// review's name, so the review still has to be fetched. That is a piece of cloud plumbing, not an integration, so
// these poll instead. COVERAGE.md says so, and the two notification-setting actions are there for an owner who
// wants the Pub/Sub route anyway.
import { z } from "zod";
import { type PollTrigger, recent, type Run } from "./index";

const query = z.string().optional().describe("Only shops whose name or address contains these words (default: all of them)");
const CONFIG = { query };
const review: PollTrigger["output"][number] = { name: "review", type: "object", required: true, description: "The review: name, reviewId, reviewer (displayName, profilePhotoUrl, isAnonymous), starRating, rating (1-5), comment, createTime, updateTime, reviewReply, replied, location, shop" };
const EVERY = 15;
const MIN = 10;

type Reviews = { reviews?: any[] };
const reviews = (config: unknown, run: Run) => run("googlebusiness.list_all_reviews", { ...(config as object), limit: 200, orderBy: "updateTime desc" }) as Promise<Reviews>;

export const googlebusiness: Record<string, PollTrigger> = {
  new_review: {
    description: "A customer leaves a new review on one of the business's Google listings. Replying to it with googlebusiness.reply_to_review does not set this off again; it sets off review_updated.",
    config: z.object({
      ...CONFIG,
      maxRating: z.number().int().min(1).max(5).optional().describe("Only reviews of this many stars or fewer, so 3 wakes it only for the unhappy ones"),
    }),
    output: [review],
    every: EVERY,
    min: MIN,
    async poll(config, run) {
      const { maxRating } = config as { maxRating?: number };
      return ((await reviews(config, run)).reviews ?? [])
        .filter((r) => recent(r.createTime))
        .filter((r) => (maxRating ? r.rating && r.rating <= maxRating : true))
        .map((r) => ({ id: String(r.name), item: { review: r } }));
    },
  },
  review_updated: {
    description: "A customer changes a review they already left, or a reply is written or changed on one. The latest state of the review is reported.",
    config: z.object(CONFIG),
    output: [review],
    every: EVERY,
    min: MIN,
    async poll(config, run) {
      return ((await reviews(config, run)).reviews ?? [])
        .filter((r) => recent(r.updateTime) && Date.parse(r.updateTime) - Date.parse(r.createTime) > 5_000)
        // the change is part of the id, so each new state is reported once
        .map((r) => ({ id: `${r.name}:${r.updateTime}`, item: { review: r } }));
    },
  },
  new_customer_photo: {
    description: "A customer adds a photo or video to one of the business's Google listings. The credit Google sends with it must be shown as given and must not be removed.",
    config: z.object(CONFIG),
    output: [
      { name: "media", type: "object", required: true, description: "The photo or video: name, mediaFormat, googleUrl, thumbnailUrl, createTime, attribution (profileName, profilePhotoUrl, takedownUrl)" },
      { name: "shop", type: "string", required: false, description: "The name of the shop it was added to" },
    ],
    every: 30,
    min: 15,
    async poll(config, run) {
      const shops = ((await run("googlebusiness.find_location", { query: (config as { query?: string }).query })) as { shops?: any[] }).shops ?? [];
      const out: { id: string; item: unknown }[] = [];
      for (const shop of shops) {
        const page = (await run("googlebusiness.list_customer_media", { accountId: shop.accountId, locationId: shop.locationId, pageSize: 50 }).catch(() => ({}))) as { mediaItems?: any[] };
        for (const media of page.mediaItems ?? []) if (recent(media.createTime)) out.push({ id: String(media.name), item: { media, shop: shop.title } });
      }
      return out;
    },
  },
  google_update_pending: {
    description: "Google itself has changed, or wants to change, what a listing says - its address, hours or phone number - and the change is waiting for the owner. Compare it with the listing as the owner left it and accept or put it back.",
    config: z.object(CONFIG),
    output: [
      { name: "location", type: "object", required: true, description: "The listing as Google has it live, including diffMask: the fields Google has changed" },
      { name: "changed", type: "string", required: true, description: "The fields Google has changed, comma separated" },
      { name: "shop", type: "string", required: false, description: "The name of the shop" },
    ],
    every: 60,
    min: 30,
    async poll(config, run) {
      const shops = ((await run("googlebusiness.find_location", { query: (config as { query?: string }).query })) as { shops?: any[] }).shops ?? [];
      const out: { id: string; item: unknown }[] = [];
      for (const shop of shops) {
        const live = (await run("googlebusiness.get_google_updated_location", { locationsId: shop.locationId, readMask: "name,title,storefrontAddress,phoneNumbers,regularHours,websiteUri,categories,openInfo" }).catch(() => ({}))) as { diffMask?: unknown };
        const changed = String((live as any).diffMask ?? "");
        // no diffMask means Google's copy matches the owner's, so there is nothing waiting
        if (changed) out.push({ id: `${shop.location}:${changed}`, item: { location: live, changed, shop: shop.title } });
      }
      return out;
    },
  },
  voice_of_merchant_changed: {
    description: "A listing's standing with Google changes: it loses or regains verification, falls foul of the guidelines, or is flagged as a duplicate. While a listing has lost its standing, what the business publishes stops showing on Google, so this is worth acting on at once.",
    config: z.object(CONFIG),
    output: [
      { name: "state", type: "object", required: true, description: "The listing's standing: hasVoiceOfMerchant, hasBusinessAuthority, waitForVoiceOfMerchant, complyWithGuidelines, resolveOwnershipConflict, verify, duplicateLocation" },
      { name: "verified", type: "boolean", required: true, description: "Whether the listing is in good standing with Google right now" },
      { name: "shop", type: "string", required: false, description: "The name of the shop" },
      { name: "location", type: "string", required: true, description: "The listing's full name" },
    ],
    every: 60,
    min: 30,
    async poll(config, run) {
      const shops = ((await run("googlebusiness.find_location", { query: (config as { query?: string }).query })) as { shops?: any[] }).shops ?? [];
      const out: { id: string; item: unknown }[] = [];
      for (const shop of shops) {
        const state = (await run("googlebusiness.get_voice_of_merchant_state", { locationsId: shop.locationId }).catch(() => null)) as Record<string, unknown> | null;
        if (!state) continue;
        // the standing itself is part of the id, so each change is reported once and a steady listing is quiet
        const which = Object.entries(state).filter(([, v]) => v !== undefined && v !== false).map(([k]) => k).sort().join(",");
        out.push({ id: `${shop.location}:${which}`, item: { state, verified: Boolean(state.hasVoiceOfMerchant), shop: shop.title, location: shop.location } });
      }
      return out;
    },
  },
};
