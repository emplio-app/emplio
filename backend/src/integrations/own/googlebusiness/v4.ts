// The parts of a Google listing that have no newer API at all: reviews and replies, posts, photos, food menus,
// services, followers. They live only in Google's My Business v4 API, which has no Discovery document, so every
// call here is written by hand. Google still adds fields to these (review reply links in July 2026, food-menu
// dietary tags in October 2026), so they are current, not leftovers.
//
// Resource names are nested ("accounts/1/locations/2/reviews/ABC") and a name in the address can't be url-encoded,
// so each action takes the ids one by one. The review helpers in index.ts take the whole name and split it.
import { z } from "zod";
import type { OwnAction } from "../index";
import { type Api, rest } from "../openapi";

export const V4 = "https://mybusiness.googleapis.com/v4";

export const accountId = z.string().describe('The account the listing sits under: just the number, as in "accounts/123" (googlebusiness.get_accounts lists them)');
export const locationId = z.string().describe('The listing: just the id, as in "locations/456" (googlebusiness.list_locations lists them)');
const LOC = "/accounts/{accountId}/locations/{locationId}";
const page = {
  pageSize: z.number().int().optional().describe("How many per page"),
  pageToken: z.string().optional().describe("From the last answer, for the next page"),
};
const updateMask = z.string().describe("Which fields you are changing, comma separated. Anything not named is left alone");
const languageCode = z.string().optional().describe('A BCP 47 language code like "en"');

export const v4Actions = (api: Api): Record<string, OwnAction> => {
  const get = (path: string, description: string, input: z.ZodObject) => rest(api, "GET", path, description, input, { readOnly: true });
  const post = (path: string, description: string, input: z.ZodObject, query: string[] = []) => rest(api, "POST", path, description, input, { query });
  // POSTs that only look things up, so they run without asking
  const lookup = (path: string, description: string, input: z.ZodObject) => rest(api, "POST", path, description, input, { readOnly: true });
  const patch = (path: string, description: string, input: z.ZodObject, query: string[] = ["updateMask"]) => rest(api, "PATCH", path, description, input, { query });
  const del = (path: string, description: string, input: z.ZodObject) => rest(api, "DELETE", path, description, input);

  return {
    // ----- reviews: what this integration is really for -----
    get_reviews: get(`${LOC}/reviews`, "The reviews customers have left on a listing, newest change first, with the average rating and the total count. Only works once the listing is verified. At most 50 per page.", z.object({
      accountId,
      locationId,
      orderBy: z.enum(["updateTime desc", "rating", "rating desc"]).optional().describe('How to sort: "updateTime desc" (default, latest change first), "rating" (worst first) or "rating desc" (best first)'),
      pageSize: z.number().int().max(50).optional().describe("How many reviews per page, at most 50"),
      pageToken: page.pageToken,
    })),
    get_review: get(`${LOC}/reviews/{reviewId}`, "One review: who wrote it, the star rating, what they said, and the owner's reply if there is one.", z.object({
      accountId,
      locationId,
      reviewId: z.string().describe("The review's id, the last part of its name from googlebusiness.get_reviews"),
    })),
    batch_get_reviews: lookup("/accounts/{accountId}/locations:batchGetReviews", "Reviews for several listings of one account in a single call, each answer saying which listing it came from. Use this when a business has more than one shop.", z.object({
      accountId,
      locationNames: z.array(z.string()).min(1).describe('The listings to fetch reviews for, by full name: ["accounts/123/locations/456", ...]'),
      orderBy: z.enum(["updateTime desc", "rating", "rating desc"]).optional().describe('How to sort: "updateTime desc" (default), "rating" or "rating desc"'),
      ...page,
    })),
    update_review_reply: rest(api, "PUT", `${LOC}/reviews/{reviewId}/reply`, "Write or rewrite the owner's public reply to a review. A reply already there is replaced. The customer is emailed that the business answered, so a reply should be worth sending. At most 4096 characters.", z.object({
      accountId,
      locationId,
      reviewId: z.string().describe("The review's id, the last part of its name from googlebusiness.get_reviews"),
      comment: z.string().max(4096).describe("The reply, as plain text, in the business's own voice. Everyone who reads the listing sees it"),
    })),
    delete_review_reply: del(`${LOC}/reviews/{reviewId}/reply`, "Take the owner's reply off a review. The review itself stays; only the business's answer goes.", z.object({
      accountId,
      locationId,
      reviewId: z.string().describe("The review's id, the last part of its name from googlebusiness.get_reviews"),
    })),

    // ----- posts (what Google calls local posts: the updates, offers and events on a listing) -----
    get_local_posts: get(`${LOC}/localPosts`, "The posts on a listing: updates, offers, events and alerts, each with its state (live, processing, scheduled, rejected).", z.object({ accountId, locationId, ...page })),
    get_local_post: get(`${LOC}/localPosts/{localPostId}`, "One post on a listing, with its text, picture, button and state.", z.object({ accountId, locationId, localPostId: z.string().describe("The post's id, the last part of its name") })),
    create_local_post: post(`${LOC}/localPosts`, "Put a post on the listing: an update, an offer, an event or an alert. It shows on the business's Google listing in Search and Maps. Google checks it, so it can be rejected for breaking its content rules.", z.object({
      accountId,
      locationId,
      topicType: z.enum(["STANDARD", "EVENT", "OFFER", "ALERT"]).describe("What kind of post: STANDARD (an update), EVENT (needs event), OFFER (needs event and may have offer), ALERT (a timely announcement; not always allowed)"),
      summary: z.string().describe("The words of the post, as the customer reads them"),
      languageCode: z.string().optional().describe('The language the post is written in, like "en" or "hi"'),
      callToAction: z.object({
        actionType: z.enum(["BOOK", "ORDER", "SHOP", "LEARN_MORE", "SIGN_UP", "CALL"]).describe("The button on the post. CALL takes no url"),
        url: z.string().optional().describe("Where the button goes. Leave out for CALL"),
      }).optional().describe("The button on the post. Ignored for an OFFER post"),
      event: z.object({
        title: z.string().describe("The event's name"),
        schedule: z.record(z.string(), z.any()).describe('When it runs: {"startDate": {"year": 2026, "month": 12, "day": 1}, "startTime": {"hours": 10}, "endDate": {...}, "endTime": {...}}'),
      }).loose().optional().describe("Needed for an EVENT or OFFER post"),
      offer: z.object({
        couponCode: z.string().optional().describe("A code the customer can use in the shop or online"),
        redeemOnlineUrl: z.string().optional().describe("A link to use the offer online"),
        termsConditions: z.string().optional().describe("The small print"),
      }).optional().describe("Only for an OFFER post"),
      alertType: z.literal("COVID_19").optional().describe("Only for an ALERT post"),
      media: z.array(z.record(z.string(), z.any())).optional().describe('Pictures for the post, each {"mediaFormat": "PHOTO", "sourceUrl": "https://..."}. A post\'s picture can only come from a public link, not an upload'),
      scheduledTime: z.string().optional().describe("Publish it later, like 2026-12-01T09:00:00Z"),
    }).loose()),
    update_local_post: patch(`${LOC}/localPosts/{localPostId}`, "Change a post already on the listing. Say in updateMask which fields you are changing.", z.object({
      accountId,
      locationId,
      localPostId: z.string().describe("The post's id, the last part of its name"),
      updateMask: updateMask.describe('Which fields you are changing, comma separated, like "summary,callToAction"'),
    }).loose()),
    delete_local_post: del(`${LOC}/localPosts/{localPostId}`, "Take a post off the listing for good.", z.object({ accountId, locationId, localPostId: z.string().describe("The post's id, the last part of its name") })),
    report_local_post_insights: lookup(`${LOC}/localPosts:reportInsights`, "How posts did: views and clicks for the posts you name.", z.object({
      accountId,
      locationId,
      localPostNames: z.array(z.string()).min(1).describe('The posts to report on, by full name: ["accounts/123/locations/456/localPosts/789", ...]. All must belong to this listing'),
      basicRequest: z.record(z.string(), z.any()).describe('What to count: {"metricRequests": [{"metric": "LOCAL_POST_VIEWS_SEARCH"}, {"metric": "LOCAL_POST_ACTIONS_CALL_TO_ACTION"}], "timeRange": {"startTime": "2026-10-01T00:00:00Z", "endTime": "2026-11-01T00:00:00Z"}}'),
    })),

    // ----- photos and videos -----
    get_media: get(`${LOC}/media`, "The photos and videos the business itself has put on the listing, with how many times each has been seen.", z.object({ accountId, locationId, ...page })),
    get_media_item: get(`${LOC}/media/{mediaId}`, "One photo or video on the listing.", z.object({ accountId, locationId, mediaId: z.string().describe("The media item's id, the last part of its name") })),
    create_media: post(`${LOC}/media`, 'Add a photo or video to the listing from a public link. To add a file from this computer, use googlebusiness.add_photo instead. Photos must be at least 250px on the short side and 10KB, except the profile and cover ones.', z.object({
      accountId,
      locationId,
      mediaFormat: z.enum(["PHOTO", "VIDEO"]).describe("PHOTO or VIDEO"),
      locationAssociation: z.object({
        category: z.enum(["COVER", "PROFILE", "EXTERIOR", "INTERIOR", "PRODUCT", "AT_WORK", "FOOD_AND_DRINK", "MENU", "COMMON_AREA", "ROOMS", "TEAMS", "ADDITIONAL"]).optional().describe("Where it belongs on the listing. A listing has only one COVER and one PROFILE"),
        priceListItemId: z.string().optional().describe("Instead of a category: the price-list item this picture is of"),
      }).describe("Where the picture belongs on the listing"),
      sourceUrl: z.string().describe("A public link Google can fetch the file from"),
      description: z.string().optional().describe("A caption. Not allowed on the cover photo"),
    }).loose()),
    update_media: patch(`${LOC}/media/{mediaId}`, "Change a photo or video's details, like which part of the listing it belongs to. The file itself can't be swapped.", z.object({
      accountId,
      locationId,
      mediaId: z.string().describe("The media item's id, the last part of its name"),
      updateMask: updateMask.describe('Which fields you are changing, comma separated, like "locationAssociation.category"'),
    }).loose()),
    delete_media: del(`${LOC}/media/{mediaId}`, "Take a photo or video off the listing for good.", z.object({ accountId, locationId, mediaId: z.string().describe("The media item's id, the last part of its name") })),
    start_media_upload: post(`${LOC}/media:startUpload`, "Book a slot to upload a file's bytes, answering the reference to upload them against. googlebusiness.add_photo does this, the upload and the create in one go.", z.object({ accountId, locationId })),
    list_customer_media: get(`${LOC}/media/customers`, "The photos and videos customers have added to the listing, each with who to credit. The credit must be shown as given and must not be removed.", z.object({ accountId, locationId, ...page })),
    get_customer_media: get(`${LOC}/media/customers/{mediaId}`, "One photo or video a customer added to the listing.", z.object({ accountId, locationId, mediaId: z.string().describe("The customer media item's id, the last part of its name") })),

    // ----- followers -----
    get_follower_metadata: get(`${LOC}/followers/metadata`, "How many people follow the business on Google Maps.", z.object({ accountId, locationId })),

    // ----- food menus, services, health -----
    get_food_menus: get(`${LOC}/foodMenus`, "The food menus on the listing: sections, dishes, prices and dietary tags. For restaurants and cafés.", z.object({
      accountId,
      locationId,
      readMask: z.string().optional().describe('Which fields to answer with, comma separated. Leave out for all of them. Whole lists can\'t be picked apart: "menus" works, "menus.sections" does not'),
    })),
    update_food_menus: patch(`${LOC}/foodMenus`, "Replace or change the food menus on the listing. Without updateMask every field is replaced by what you send, so anything you leave out is cleared.", z.object({
      accountId,
      locationId,
      updateMask: updateMask.optional().describe('Which fields you are changing, comma separated, like "menus". Leave it out to replace everything'),
      menus: z.array(z.record(z.string(), z.any())).optional().describe('The menus: [{"labels": [{"displayName": "Lunch", "languageCode": "en"}], "sections": [{"labels": [...], "items": [{"labels": [...], "attributes": {"price": {"currencyCode": "INR", "units": "250"}, "dietaryRestriction": ["VEGETARIAN"]}}]}]}]'),
    }).loose()),
    get_service_list: get(`${LOC}/serviceList`, "The list of services the business offers, as shown on the listing.", z.object({ accountId, locationId })),
    update_service_list: patch(`${LOC}/serviceList`, "Set the services the business offers. Without updateMask everything is replaced by what you send.", z.object({
      accountId,
      locationId,
      updateMask: updateMask.optional().describe("Which fields you are changing. Leave it out to replace everything"),
      serviceItems: z.array(z.record(z.string(), z.any())).optional().describe('The services: [{"structuredServiceItem": {"serviceTypeId": "job_type_id:plumber"}}] or [{"freeFormServiceItem": {"category": "categories/gcid:plumber", "label": {"displayName": "Drain cleaning", "languageCode": "en"}}}]'),
    }).loose()),
    get_health_provider_attributes: get(`${LOC}/healthProviderAttributes`, "Which insurance networks a health practice takes, as shown on the listing. Only for health businesses.", z.object({ accountId, locationId, languageCode })),
    update_health_provider_attributes: patch(`${LOC}/healthProviderAttributes`, "Set which insurance networks a health practice takes.", z.object({
      accountId,
      locationId,
      updateMask: updateMask.optional().describe('Which fields you are changing. Today only "insuranceNetworks" can be changed'),
      insuranceNetworks: z.array(z.record(z.string(), z.any())).optional().describe('The networks taken: [{"networkId": "networks/123", "state": "ACCEPTED"}]. googlebusiness.list_insurance_networks lists the ids'),
    }).loose()),
    list_insurance_networks: get(`${LOC}/insuranceNetworks`, "Every insurance network Google knows about, to pick from when setting what a health practice takes.", z.object({ accountId, locationId, languageCode, ...page })),

    // ----- claiming and matching a listing -----
    batch_get_locations: lookup("/accounts/{accountId}/locations:batchGet", "Several listings of one account in a single call, by their full names.", z.object({
      accountId,
      locationNames: z.array(z.string()).min(1).describe('The listings to fetch: ["accounts/123/locations/456", ...]'),
    })),
    find_matches: lookup(`${LOC}:findMatches`, "Places already on Google Maps that look like this listing, best match first. Use it before claiming, so a second copy of the shop isn't created.", z.object({
      accountId,
      locationId,
      numResults: z.number().int().max(10).optional().describe("How many matches, up to 10 (default 3)"),
      languageCode,
    })),
    associate_location: post(`${LOC}:associate`, "Tie this listing to a place already on Google Maps, so the two become one. Send no placeId to say none of the suggestions match.", z.object({
      accountId,
      locationId,
      placeId: z.string().optional().describe("The Google Maps place id to tie it to. Leave out to say nothing matches"),
    })),
    clear_location_association: post(`${LOC}:clearAssociation`, "Untie this listing from the place on Google Maps it was tied to.", z.object({ accountId, locationId })),
    list_recommended_google_locations: get("/accounts/{accountId}:recommendGoogleLocations", "Places on Google Maps that Google thinks belong to this account and could be claimed, most likely first.", z.object({ accountId, ...page })),
    report_google_location: post("/googleLocations/{googleLocationId}:report", "Tell Google a place it suggested is wrong: closed, a duplicate, spam, or not this business.", z.object({
      googleLocationId: z.string().describe('The suggested place\'s id, the last part of its name from googlebusiness.search_google_locations'),
      reportReasonBadLocation: z.enum(["BAD_LOCATION_REASON_UNSPECIFIED", "NOT_A_LOCATION", "PERMANENTLY_CLOSED", "DOES_NOT_EXIST", "SPAM", "NOT_A_BUSINESS", "OTHER"]).optional().describe("Wrong with the place itself. Give this or reportReasonBadRecommendation, not both"),
      reportReasonBadRecommendation: z.enum(["BAD_RECOMMENDATION_REASON_UNSPECIFIED", "NOT_A_STORE", "NOT_PART_OF_SUGGESTED_BUSINESS", "OTHER"]).optional().describe("Wrong with suggesting it to this business. Give this or reportReasonBadLocation, not both"),
      reportReasonElaboration: z.string().max(512).optional().describe("Say more, up to 512 characters"),
      reportReasonLanguageCode: z.string().optional().describe("The language the explanation is written in"),
      locationGroupName: z.string().optional().describe('Which account it is being reported for, as "accounts/123"'),
    })),
    generate_account_number: post("/accounts/{accountId}:generateAccountNumber", "Give an account a number if it has none. An account that already has one is left as it is.", z.object({ accountId })),
  };
};
