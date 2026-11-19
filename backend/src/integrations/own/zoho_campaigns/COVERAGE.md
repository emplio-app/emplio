# Zoho Campaigns coverage

Source: Zoho Campaigns API v1.1 docs (zoho.com/campaigns/help/developers, read 2026-11-19). It has no OpenAPI spec, so every
call page under Campaign, List, Tag, Topic and Workflow management is listed by hand: 39 calls, 39 actions. Composio's
`zoho_campaigns` toolkit has the same 39 under the same names (`coverage.ts`: 0 unmatched) and no triggers.

## Left out

| What | Why |
| --- | --- |
| XML forms of each call | Same calls; we always ask for JSON |
| Webhooks | Zoho Campaigns has no API to register them (set by hand per list in its settings), so triggers are polled |
| Older v1 calls with an auth token | Retired by Zoho in favour of v1.1 with OAuth |

## Sign-in

Sign in with Zoho only (no key), through the shared Zoho client (`zohoOAuth`). Scopes:
`ZohoCampaigns.campaign.ALL,ZohoCampaigns.contact.ALL,ZohoCampaigns.workflow.READ,ZohoCampaigns.workflow.CREATE`.
Tokens last an hour and are renewed. The host follows the login's data centre (campaigns.zoho.in, campaigns.zoho.eu,
campaigns.zohocloud.ca...), worked out from the Mail address in `zoho-login.ts`. `check` reads the contact fields, which
every account has.

## Hand adjustments

- Every field goes in the query string, as in all of Zoho's samples, with `resfmt=JSON` (`type=json` on custom fields,
  merge tags and coupons).
- `subscribe_contact`, `unsubscribe_contact` and `move_contact_to_do_not_mail` take plain fields (contact_email,
  first_name...) and build Zoho's `contactinfo` JSON; other fields go in `fields` by display name.
- `create_campaign` takes `list_details` as an object and `segments` as a list; `clone_campaign`, topics and workflows
  build their JSON `campaigninfo` / `details` value from plain fields.
- `schedule_campaign` is `sendcampaign` with `isschedule=true`; `create_merge_tag` sends `tagtype=Custom`;
  `mark_coupon_used` sends `changeStatus=used`; `add_mailing_list_and_contacts` sends `mode=newlist`.
- Failures sent with a 200 (`status: failure`, or a code other than 0/200) become errors. "Nothing here yet" codes
  (2401 no lists, 6101 no campaigns, 992 no tags, 2604 empty segment) come back as an empty answer instead.
- Answers with JSON in a text content type are read as JSON.

## Triggers (polled, polls/zoho_campaigns.ts, every 15 minutes)

new_subscriber, contact_unsubscribed (both: one list by `listkey`, or all lists, up to 25, newest 200 contacts each),
campaign_sent (newest 100 sent campaigns).

## Actions by group (* asks first)

**Mailing lists and contacts** (16): list_mailing_lists, get_mailing_list_details, list_mailing_list_contacts,
count_mailing_list_contacts, list_contact_fields, get_segment_details, list_segment_contacts,
add_mailing_list_and_contacts*, add_contacts_to_mailing_list*, subscribe_contact*, unsubscribe_contact*,
move_contact_to_do_not_mail*, update_mailing_list*, delete_mailing_list*, create_contact_field*, create_merge_tag*

**Campaigns** (13): list_recent_campaigns, list_recently_sent_campaigns, get_campaign_details, get_campaign_report,
get_last_campaign_report, list_campaign_recipients, get_coupon_details, create_campaign*, clone_campaign*,
send_campaign*, schedule_campaign*, delete_campaign*, mark_coupon_used*

**Tags** (5): list_tags, create_tag*, delete_tag*, associate_tag_with_contact*, dissociate_tag_from_contact*

**Topics** (3): list_topics, list_topic_products, create_topic*

**Workflows** (2): list_open_workflows, trigger_workflow_contacts*
