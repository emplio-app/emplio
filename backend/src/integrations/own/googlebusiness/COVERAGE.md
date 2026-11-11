# Google Business Profile coverage

Source: the Discovery documents of the eight Business Profile services, generated 2026-11-11 by
`bun scripts/openapi-actions.ts googlebusiness`, plus the legacy My Business v4 REST reference
(developers.google.com/my-business/reference/rest/v4, read 2026-11-11) written by hand in `v4.ts`.
54 actions from the eight services, 34 from v4, 9 added on top and 1 alias: **98 actions, 5 triggers**.
Composio's `google_business_profile` toolkit has 56 tools and no triggers; `coverage.ts` reports 0 unmatched
on either side.

## Sign-in

Google sign-in only (no key), on the one Google OAuth client shared with Calendar, Docs, Sheets and Meet:
`GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`, callback `/oauth/googlebusiness/callback`.

| Scope | Google's class |
| --- | --- |
| `business.manage` | Sensitive (not restricted, so no yearly security audit) |
| `openid`, `email` | Non-sensitive |

`business.manage` is the only scope any Business Profile API takes; there are no narrower ones. The test in
`own/google-login.test.ts` fails if a restricted scope ever appears. Tokens last an hour and renew with the
refresh token (`offline`, `prompt=consent`).

**Google gates this API, and no code can open the gate.** Before a sign-in works at all, the owner must:

1. Manage a Google Business Profile that has been verified and active for 60+ days, with a website for that business.
2. Create (or pick) a Google Cloud project and note its **project number**.
3. Submit the **GBP API contact form**, choosing *Application for Basic API Access*, from an email that is an
   owner or manager on that Business Profile. Google reviews it; the answer comes by email and can take days.
   Approval shows as the Business Profile quota going from 0 QPM to 300 QPM in the Cloud console.
4. Once approved, turn on all eight APIs in that project: Google My Business, My Business Account Management,
   Business Information, Verifications, Notifications, Place Actions, Lodging, Business Calls.

Until step 3 is approved the APIs are not even visible in the Cloud console, so nothing here can be tried live.

## The API is eight services plus a legacy one

Each service has its own host, so the generator writes the host onto every call
(`server` in `scripts/openapi/googlebusiness.ts`). Reviews, posts, photos, food menus, services and followers
have **no v1 service at all** - they exist only in My Business v4, which Google still adds fields to (review
reply links July 2026, food-menu dietary tags October 2026). v4 publishes no Discovery document, so those calls
are written out in `v4.ts`.

v4 resource names are nested (`accounts/1/locations/2/reviews/ABC`) and a name in the address cannot be
url-encoded, so each v4 action takes the ids one at a time (`accountId`, `locationId`, `reviewId`). The review
helpers take the whole name and split it themselves, so an automation can pass what it was given.

## Left out

| What | Why |
| --- | --- |
| Q&A: questions and answers on a listing, and the `NEW_QUESTION` / `NEW_ANSWER` triggers | Google discontinued the My Business Q&A API on 3 November 2025. Its Discovery document now 404s, and Google's own Notifications API marks those four notification types deprecated with the words "The My Business Q&A API was discontinued on November 3, 2025." Composio has no Q&A tools either. The two triggers the task asked for cannot be built on an API that has been switched off |
| v4 `accounts.locations.reportInsights` | Replaced by the Performance API, which is here as `get_daily_metrics`, `get_multi_daily_metrics`, `list_search_keyword_impressions` and the friendlier `get_performance`. The v4 one is capped at 10 listings a call and Google marks it superseded |
| v4 `accounts`, `accounts.admins`, `accounts.invitations`, `accounts.locations` CRUD, `attributes`, `categories`, `chains`, `googleLocations.search`, `questions`, `verifications` | All of these moved to the v1 services, which is where the generated actions call them. Only the v4 calls with no v1 home are written by hand |
| v4 `accounts.getNotifications` / `updateNotifications` / `deleteNotifications` | Replaced by the Notifications service, here as `get_notification_setting` and `update_notification_setting` |
| Business Information **v1alpha** apart from edit status | v1alpha repeats v1 for everything else. Its two genuinely new methods (added 2 November 2026) are here by hand as `get_location_edit_status` and `get_location_attributes_edit_status` |
| Food Menus as its own service | Google lists no Food Menus API of its own; menus live at v4 `getFoodMenus` / `updateFoodMenus`, which are here |
| Nothing else | Every method of all eight Discovery documents is an action (0 skipped by the generator) |

## Hand adjustments

- `scripts/openapi/googlebusiness.ts` names each generated action the way Composio's toolkit does, so a skill or
  automation written against Composio carries over. `readMask` and `updateMask` get descriptions a person can
  follow, because Google's own are a sentence about field masks.
- `scripts/openapi/google-discovery.ts` now only checks a method's scopes when the document declares scopes at
  all. Business Profile's eight documents declare none (everything is behind `business.manage`); Calendar, Docs,
  Sheets and Meet still have every method checked.
- Business Calls publishes no Discovery document on its own host (404), so its document is read from Google's own
  client-library repository, `googleapis/google-api-go-client`.
- Reads that are POSTs run without asking: `search_google_locations`, `list_verification_options`,
  `batch_get_reviews`, `batch_get_locations`, `find_matches`, `report_local_post_insights`.
- `add_photo` does the three steps Google's upload takes - book a slot, send the bytes to the upload host with the
  picture's own content type, then add it to the listing - as one action. `upload_location_media` is Composio's
  name for it.
- `get_performance` takes plain dates and metric names instead of Google's `dailyRange.startDate.year` fields, and
  totals the series.

## Triggers (all polled)

Google sends Business Profile events through **Cloud Pub/Sub**, not a webhook: it needs a topic in a Google Cloud
project of ours, publish rights for `mybusiness-api-pubsub@system.gserviceaccount.com`, a push subscription
pointing at Emplio, and then `updateNotificationSetting` on every one of the owner's accounts - and the message
carries only the review's resource name, so the review still has to be fetched afterwards. That is cloud plumbing
one integration cannot set up for itself, so these poll instead. `get_notification_setting` and
`update_notification_setting` are actions, so an owner who wants the Pub/Sub route can still point it at a topic.

| Trigger | How | Limits |
| --- | --- | --- |
| `new_review` | Reviews for every shop of every account in one `batchGetReviews` per account, `createTime` within a day. `maxRating` setting wakes it only for unhappy reviews | Replying does not set it off again; that is `review_updated` |
| `review_updated` | Same walk; id holds `updateTime`, so each state is reported once. Skips reviews saved within 5 seconds of being written | Two changes between checks are one report, with the latest state |
| `new_customer_photo` | `media/customers` per shop, `createTime` within a day | Google's credit line must be shown as given and must not be removed |
| `google_update_pending` | `getGoogleUpdated` per shop; fires only when Google answers with a `diffMask`. Id holds the changed fields | Every 60 minutes by default, since Google's own edits are not sudden |
| `voice_of_merchant_changed` | `VoiceOfMerchantState` per shop; the standing itself is folded into the id, so a steady listing stays quiet | Reports a listing losing or regaining its standing, a guideline problem, an ownership conflict or a duplicate |

The first check of any of them only notes what is there, so turning an automation on does not fire for every
existing review. Review triggers default to every 15 minutes (at least 10); the per-shop ones to 30 or 60, because
they cost one call per shop.

## Actions (* asks first)

**Account Management** (16): get_accounts, get_account, create_account*, update_account*, list_admins,
invite_admin*, update_admin*, delete_admin*, list_invitations, accept_invitation*, decline_invitation*,
transfer_location*, list_location_admins, invite_location_admin*, update_location_admin*, delete_location_admin*

**Business Information** (15): list_locations, get_location, create_location*, update_location*, delete_location*,
get_google_updated_location, get_location_attributes, update_location_attributes*,
get_google_updated_location_attributes, list_attribute_metadata, get_categories, batch_get_categories, find_chains,
get_chain, search_google_locations

**Performance** (3): get_daily_metrics, get_multi_daily_metrics, list_search_keyword_impressions

**Verifications** (6): get_voice_of_merchant_state, list_verification_options, start_verification*,
list_verifications, complete_verification*, generate_verification_token*

**Place Actions** (6): get_place_action_links, get_place_action_link, create_place_action_link*,
update_place_action_link*, delete_place_action_link*, list_place_action_type_metadata

**Notifications** (2): get_notification_setting, update_notification_setting*

**Lodging** (3): get_lodging, update_lodging*, get_google_updated_lodging

**Business Calls** (3): get_call_settings, update_call_settings*, list_call_insights

**Reviews, from My Business v4** (5): get_reviews, get_review, batch_get_reviews, update_review_reply*,
delete_review_reply*

**Posts, from My Business v4** (6): get_local_posts, get_local_post, create_local_post*, update_local_post*,
delete_local_post*, report_local_post_insights

**Photos and videos, from My Business v4** (8): get_media, get_media_item, create_media*, update_media*,
delete_media*, start_media_upload*, list_customer_media, get_customer_media

**Menus, services, health and followers, from My Business v4** (8): get_food_menus, update_food_menus*,
get_service_list, update_service_list*, get_health_provider_attributes, update_health_provider_attributes*,
list_insurance_networks, get_follower_metadata

**Claiming a listing, from My Business v4** (7): batch_get_locations, find_matches, associate_location*,
clear_location_association*, list_recommended_google_locations, report_google_location*, generate_account_number*

**Added on top** (10): find_location, list_all_reviews, reviews_summary, reply_to_review*, remove_review_reply*,
add_photo*, upload_location_media*, get_performance, get_location_edit_status, get_location_attributes_edit_status

## Not tried live

Nothing here has been run against Google. The API cannot be called at all until Google approves an access request
for a Cloud project (see Sign-in above), so every call is covered by tests with `fetch` faked and by Google's own
reference documentation, and none by a real answer.
