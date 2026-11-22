# Webflow coverage

Source: Webflow's official OpenAPI spec for the Data API v2 (github.com/webflow/openapi-spec, openapi/v2.yml),
generated 2026-11-22 by `bun scripts/openapi-actions.ts webflow`. Every operation a site API token can call is
an action (112), plus upload_asset written by hand: 113. Webhook payloads and signing from
developers.webflow.com/data/docs/working-with-webhooks.

## Deliberately left out

| What | Why |
| --- | --- |
| GET /token/authorized_by, GET /token/introspect | Only answer for a token from a Webflow OAuth app; a site API token is refused |
| Custom code: page and site custom code, registered scripts, custom code blocks (10 calls) | Webflow only accepts a token from an OAuth app for these |
| POST /workspaces/{workspace_id}/sites, GET /workspaces/{id}/audit_logs | Need an Enterprise workspace token, not a site token |
| OAuth sign-in | Not in this job: site API token only. Adding an OAuth app later unlocks custom code and multi-site connections |
| Memberships / user accounts | Webflow retired User Accounts and its API; not in the spec |

Composio's unmatched names: get_page_custom_code and get_token_authorized_by (OAuth-only, above); list_custom_domains is the
same call as get_custom_domains; update_collection_items_bulk and update_collection_item_v2 are update_collection_items and
update_collection_item; update_page is update_page_metadata (settings) or update_page_content (text on the page).

## Hand adjustments (scripts/openapi/webflow.ts, own/webflow/index.ts)

- Base `https://api.webflow.com/v2`, token as `Authorization: Bearer`. A 401 means the token is dead. Errors say {code, message}.
- Action names follow Composio's where one means the same call (`namer`, plus `rename` for ten whose summaries differ).
- The spec gives path ids a default of null; dropped, so a missing id is asked for instead of sent as "null".
- Bracket query params (list_collection_items' createdOn/lastUpdated/lastPublished/filter/sort, the analytics reports'
  filter and timeseries) are spread out as `createdOn[gte]=...` instead of JSON.
- upload_asset: Webflow's two-step upload (create_asset, then the file to its storage) in one action, from a file on the computer.
- list_webhooks and get_webhook ask first: a webhook made with a site token carries its signing key.

## Auth

| Method | Status |
| --- | --- |
| Site API token (Site settings → Apps & integrations → API access → Generate API token), sent as Bearer | done |

## Triggers

Webhooks (own/webflow/triggers.ts), one per site and event type, made by start() and removed by stop() with the
last automation. Webflow's signing key is made per webhook and can't be chosen, so the address carries a token
worked out from ENCRYPTION_KEY and the connection instead. Webflow sends no delivery id, so a retry is recognised by its body.

| Trigger | Webflow event | Filters |
| --- | --- | --- |
| new_form_submission | form_submission | form_name, form_id |
| site_published | site_publish | |
| page_created | page_created | |
| page_updated | page_metadata_updated | page_id |
| page_deleted | page_deleted | page_id |
| new_order | ecomm_new_order | |
| order_updated | ecomm_order_changed | status |
| inventory_changed | ecomm_inventory_changed | |
| collection_item_created / _updated / _deleted / _published / _unpublished | collection_item_* | collection_id |
| new_comment | comment_created | page_id |

All take site_id (default: the token's site). Polled (polls/webflow.ts), every 5 minutes: new_product, new_asset.
Composio has no Webflow triggers.

## Limits

- A site token covers one site; another site needs its own connection. Only a site admin can make one. Webflow expires
  a token after a year without use.
- CMS calls need a site plan with CMS (CMS, Business or higher); shop calls and order triggers need an Ecommerce plan;
  analytics reports need the Analyze add-on; redirects, robots.txt, well-known files, site plan, activity logs and
  update/delete site need an Enterprise workspace.
- Rate limits: 60 calls a minute (Starter and Basic site plans) or 120 (CMS, Business, Ecommerce); one publish a minute.

## Actions by group (* asks first)

**hand-written** (1): upload_asset*

**Sites** (6): list_webflow_sites, get_site_info, update_site*, delete_site*, get_custom_domains, publish_site*

**Enterprise site settings** (12): get_301_redirects, create_301_redirect*, update_301_redirect*, delete_301_redirects*, get_site_plan, get_robots_txt, replace_robots_txt*, update_robots_txt*, delete_robots_txt*, set_well_known_file*, delete_well_known_file*, get_site_activity_logs

**Google tags** (4): list_google_tags, update_google_tag*, delete_google_tags*, delete_google_tag*

**Analytics (Analyze add-on)** (5): get_traffic_report, get_top_pages_report, get_top_dimensions_report, get_top_events_report, get_time_on_page_report

**CMS collections** (8): list_collections, create_collection*, get_collection, update_collection*, delete_collection*, create_collection_field*, update_collection_field*, delete_collection_field*

**CMS items** (16): list_collection_items, create_collection_item*, update_collection_items*, delete_collection_items*, list_live_collection_items, create_live_collection_item*, update_live_collection_items*, unpublish_live_collection_items*, create_bulk_collection_items*, get_collection_item, update_collection_item*, delete_collection_item*, get_live_collection_item, update_live_collection_item*, unpublish_live_collection_item*, publish_collection_items*

**Comments** (5): list_comment_threads, get_comment_thread, resolve_comment_thread*, list_comment_replies, create_comment_reply*

**Pages** (5): list_pages, get_page, update_page_metadata*, get_page_dom, update_page_content*

**Components** (5): list_components, get_component_content, update_component_content*, get_component_properties, update_component_properties*

**Assets** (8): list_assets, create_asset*, get_asset, update_asset*, delete_asset*, list_asset_folders, create_asset_folder*, get_asset_folder

**Custom fonts** (8): list_custom_fonts, create_custom_font*, get_custom_font, update_custom_font*, delete_custom_font*, replace_custom_font_file*, batch_create_custom_fonts*, batch_delete_custom_fonts*

**Webhooks** (4): list_webhooks*, create_webhook*, get_webhook*, delete_webhook*

**Forms** (11): list_forms, get_form_schema, list_form_submissions, get_form_submission, modify_form_submission*, delete_form_submission*, list_form_submissions_by_site, list_submissions, get_form_submission_by_site, modify_form_submission_by_site*, delete_form_submission_by_site*

**Ecommerce** (15): list_products_skus, create_product_sku*, get_product_and_skus, update_product*, create_skus*, update_sku*, list_orders, get_order, update_order*, fulfill_order*, unfulfill_order*, refund_order*, get_item_inventory, update_item_inventory*, get_ecommerce_settings
