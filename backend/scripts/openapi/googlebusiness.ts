// Google Business Profile: a shop's Google listing. Its API is eight separate services, each with its own host and
// its own Discovery document, so each is converted and the operation's own host goes on the call. What has no v1
// service at all - reviews, posts, photos, food menus - is written by hand in own/googlebusiness/v4.ts against the
// legacy My Business v4 API, which Google still updates.
import { GOOGLE_SCOPES } from "../../src/integrations/own/google-login";
import type { AppConfig } from "../openapi-actions";
import { discovery } from "./google-discovery";

const SCOPES = GOOGLE_SCOPES.googlebusiness;
// [short name, host, Discovery document]. The order is the order of `spec`, which `server` is indexed by.
const SERVICES: [string, string, string][] = [
  ["accountmanagement", "https://mybusinessaccountmanagement.googleapis.com", "https://mybusinessaccountmanagement.googleapis.com/$discovery/rest?version=v1"],
  ["businessinformation", "https://mybusinessbusinessinformation.googleapis.com", "https://mybusinessbusinessinformation.googleapis.com/$discovery/rest?version=v1"],
  ["performance", "https://businessprofileperformance.googleapis.com", "https://businessprofileperformance.googleapis.com/$discovery/rest?version=v1"],
  ["verifications", "https://mybusinessverifications.googleapis.com", "https://mybusinessverifications.googleapis.com/$discovery/rest?version=v1"],
  ["placeactions", "https://mybusinessplaceactions.googleapis.com", "https://mybusinessplaceactions.googleapis.com/$discovery/rest?version=v1"],
  ["notifications", "https://mybusinessnotifications.googleapis.com", "https://mybusinessnotifications.googleapis.com/$discovery/rest?version=v1"],
  ["lodging", "https://mybusinesslodging.googleapis.com", "https://mybusinesslodging.googleapis.com/$discovery/rest?version=v1"],
  // Business Calls publishes no Discovery document on its own host (404); Google's own client-library repo carries it
  ["businesscalls", "https://mybusinessbusinesscalls.googleapis.com", "https://raw.githubusercontent.com/googleapis/google-api-go-client/main/mybusinessbusinesscalls/v1/mybusinessbusinesscalls-api.json"],
];

export default {
  spec: await Promise.all(SERVICES.map(([name, , url]) => discovery(url, `googlebusiness-${name}`, SCOPES))),
  server: (_path, spec) => SERVICES[spec]![1],
  out: "src/integrations/own/googlebusiness/actions.json",
  // Composio's names for the same calls, so a skill or automation written against its toolkit carries over
  rename: {
    accounts_create: "create_account",
    accounts_get: "get_account",
    accounts_list: "get_accounts",
    accounts_patch: "update_account",
    accounts_admins_create: "invite_admin",
    accounts_admins_list: "list_admins",
    accounts_admins_patch: "update_admin",
    accounts_admins_delete: "delete_admin",
    accounts_invitations_accept: "accept_invitation",
    accounts_invitations_decline: "decline_invitation",
    accounts_invitations_list: "list_invitations",
    accounts_get_notification_setting: "get_notification_setting",
    accounts_update_notification_setting: "update_notification_setting",
    locations_transfer: "transfer_location",
    locations_admins_create: "invite_location_admin",
    locations_admins_list: "list_location_admins",
    locations_admins_patch: "update_location_admin",
    locations_admins_delete: "delete_location_admin",
    accounts_locations_list: "list_locations",
    accounts_locations_create: "create_location",
    locations_get: "get_location",
    locations_patch: "update_location",
    locations_delete: "delete_location",
    locations_get_google_updated: "get_google_updated_location",
    locations_get_attributes: "get_location_attributes",
    locations_update_attributes: "update_location_attributes",
    locations_attributes_get_google_updated: "get_google_updated_location_attributes",
    google_locations_search: "search_google_locations",
    attributes_list: "list_attribute_metadata",
    categories_list: "get_categories",
    categories_batch_get: "batch_get_categories",
    chains_search: "find_chains",
    chains_get: "get_chain",
    locations_get_daily_metrics_time_series: "get_daily_metrics",
    locations_fetch_multi_daily_metrics_time_series: "get_multi_daily_metrics",
    locations_searchkeywords_impressions_monthly_list: "list_search_keyword_impressions",
    locations_fetch_verification_options: "list_verification_options",
    locations_get_voice_of_merchant_state: "get_voice_of_merchant_state",
    locations_verify: "start_verification",
    locations_verifications_list: "list_verifications",
    locations_verifications_complete: "complete_verification",
    verification_tokens_generate: "generate_verification_token",
    locations_place_action_links_create: "create_place_action_link",
    locations_place_action_links_list: "get_place_action_links",
    locations_place_action_links_get: "get_place_action_link",
    locations_place_action_links_patch: "update_place_action_link",
    locations_place_action_links_delete: "delete_place_action_link",
    place_action_type_metadata_list: "list_place_action_type_metadata",
    locations_get_lodging: "get_lodging",
    locations_update_lodging: "update_lodging",
    locations_lodging_get_google_updated: "get_google_updated_lodging",
    locations_get_businesscallssettings: "get_call_settings",
    locations_update_businesscallssettings: "update_call_settings",
    locations_businesscallsinsights_list: "list_call_insights",
  },
  // POSTs that only look things up
  reads: ["search_google_locations", "list_verification_options"],
  params: {
    readMask: 'Which fields of the listing to answer with, comma separated, or "*" for all of them. Google insists on this one. Fields include name, title, storefrontAddress, phoneNumbers, categories, websiteUri, regularHours, specialHours, openInfo, metadata, latlng, profile, serviceItems, labels',
    updateMask: "Which fields you are changing, comma separated, like regularHours,phoneNumbers. Anything not named is left alone",
  },
} satisfies AppConfig;
