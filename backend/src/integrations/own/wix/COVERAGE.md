# Wix coverage

Source: Wix publishes no OpenAPI spec. Every REST method has a markdown page under dev.wix.com/docs/api-reference
(append `.md`) with a schema block: URL, HTTP method and the parameter tree. `scripts/openapi/wix.ts` reads the method
list from dev.wix.com/docs/llms-full.txt, fetches every page, turns them into one OpenAPI file and hands it to
`bun scripts/openapi-actions.ts wix`. Generated 2026-11-16: 2,762 method pages, 2,534 actions (1,004 run unasked).
Benchmark: Composio's Wix toolkit (147 tools, no triggers), checked with `.claude/skills/new-integration/coverage.ts`:
138 of its names are ours too.

## Deliberately left out

| What | Why |
| --- | --- |
| App Management (129 pages with Wix Backoffice, Mobile, Tools, site viewer, resellers, enterprise, channels) | App Management answers only to a Wix app's own token; the rest is Wix's dev center, the mobile app builder, docs search, code that runs in a visitor's browser, or partner/enterprise programmes |
| 85 pages with no REST call | SDK-only methods (Velo / JavaScript SDK); there is no URL to call |
| ~14 pages documenting the same call twice | The same URL and method; the first page's version is kept |
| Composio's `get_app_instance`, `list_app_permissions`, `list_app_plans_by_app_id`, `get_site_plugins_placement_status`, `get_purchase_history` | App Management: a Wix app's token only |
| Composio's `list_catalogs`, `update_content_by_key_bulk`, `query_forms_form_submissions` | Not in Wix's current REST docs (the last is covered by `query_submissions_by_namespace`) |

## Hand adjustments (scripts/openapi/wix.ts, own/wix/index.ts)

- **Public addresses.** The schema's URL is sometimes Wix's internal route (`/v3/posts`, `/_api/bookings/...`). When
  the page's curl example for the same HTTP method ends the same way, its start is used (`/blog/v3/posts`,
  `/bookings/v2/...`). 228 calls are moved this way; pages without an example keep the schema's URL.
- **Paging.** The docs indent `filter` and `sort` inside `cursorPaging`; they are moved back beside it.
- **GET params** with nested fields are sent dotted (`paging.limit=50`), as Wix reads them.
- **Path ids** with a dot (`{product.id}`) become plain fields (`product_id`).
- **Lookups that are POSTs** (query, search, count, list, get, calculate, preview, check…) run without asking, except
  "get or create", "check in" and payment-request links, which make something. `get_secret_value` asks first.
- **Names** follow Composio where it has the same call (30 by hand in `rename`); otherwise the page's address
  (`get-site-properties` → `get_site_properties`). A name used by two APIs gets the API's folder in front
  (`contacts_v5_query_contacts`).
- **Account-level calls** (sites, domains, accounts, Studio workspace…) send `wix-account-id`; everything else, and
  the account section's per-site calls (contributors, publish), sends `wix-site-id`. Wix refuses both together.
- `actions.json` is 7 MB (the docs' parameter trees are deep); loading takes about 0.2 s.

## Auth

| Method | Status |
| --- | --- |
| API key (manage.wix.com/account/api-keys) + site id, optional account id, pasted on one line separated by spaces | done |
| OAuth | not built: Wix OAuth exists only for apps listed in the Wix App Market (app registration and Wix's review), and REST can't act as a signed-in Wix user. API keys are Wix's way for an owner's own server-to-server access |

The key is checked with Get Site Properties on that site, and the connection is labelled with the site's name.
One connection is one site; connect Wix again for another site (same key, other site id).

## Triggers (22, all polled, `polls/wix.ts`)

Wix delivers webhooks only to a Wix app configured in its dev center, never to an API key, so nothing can be
registered by API. Each trigger lists the newest 100 rows every 5 minutes and keeps the last day's. "Changed"
triggers put the change in the id (`<id>:<updatedDate>`, `<id>:paid`), so each change counts once. Composio has no
Wix triggers.

- Orders (eCommerce: Stores, Bookings and every Wix checkout): `order_created`, `order_updated`, `order_paid`,
  `order_fulfilled`, `order_canceled`
- Contacts and members: `contact_created`, `contact_updated`, `member_created`
- Forms: `form_submission_created` (namespace, default Wix Forms; optional form id)
- Bookings: `booking_created`, `booking_updated`, `booking_canceled`
- Blog: `blog_post_published`
- Stores: `product_created`, `low_stock` (threshold, default 5; again each time the stock changes while low). Both
  try catalog v3 and fall back to v1 on older stores
- CMS: `cms_item_created`, `cms_item_updated` (collection id)
- Events: `event_rsvp_created`, `event_order_created`
- Pricing plans: `pricing_plan_order_created`
- Invoices: `invoice_created`, `invoice_paid`

Not done: Wix Automations can call a URL ("Send HTTP request") set by hand in the dashboard; that would give instant
events but needs the owner to build one automation per event, so polling stays the default.

## Actions by group (count, of which ask first)

| Group | Actions | Ask first |
| --- | --- | --- |
| business-solutions/e-commerce (orders, checkout, carts, fulfillments, refunds, discounts, shipping, tax) | 226 | 153 |
| business-management/marketing (email campaigns, coupons, Google/social ads, consent) | 194 | 107 |
| business-solutions/restaurants | 170 | 102 |
| business-solutions/bookings (services, bookings, staff, availability, resources) | 165 | 96 |
| business-solutions/stores (products v1+v3, inventory, categories, brands, back-in-stock) | 164 | 112 |
| crm/members-contacts (contacts v4+v5, labels, members, roles, badges) | 157 | 96 |
| business-solutions/cms (collections, data items, indexes) | 114 | 83 |
| business-solutions/events (events, RSVPs, tickets, orders, policies) | 100 | 64 |
| crm/community (comments, reviews, groups, forum, moderation) | 92 | 55 |
| business-management/online-programs | 86 | 58 |
| business-management/get-paid (invoices, price quotes, receipts, payment links, billable items) | 83 | 56 |
| crm/forms (forms, submissions, spam) | 76 | 43 |
| business-management/seo | 73 | 40 |
| crm/loyalty-program | 61 | 33 |
| account-level/studio-workspace | 60 | 27 |
| business-solutions/benefit-programs | 56 | 31 |
| business-management/automations | 51 | 31 |
| business-solutions/blog (posts, drafts, categories, tags) | 44 | 21 |
| business-management/google-business-profile | 40 | 21 |
| business-management/multilingual | 36 | 19 |
| business-management/calendar | 34 | 19 |
| business-management/payments | 32 | 14 |
| business-management/functions | 28 | 17 |
| business-solutions/pricing-plans (plans, orders) | 26 | 15 |
| assets/media (files, folders, upload/import) | 26 | 15 |
| business-solutions/portfolio, suppliers-hub | 48 | 33 |
| crm/crm (pipelines, cards), crm/communication | 35 | 23 |
| account-level/domains, sites, user-management, accounts, premium, git-codestore, b2b, ai-credits | 62 | 34 |
| Everything else (FAQ, headless, cookie consent, gift cards, rich content, pro gallery, dashboard, donations, branches, locations, AI site chat, analytics, coupons, app installation, site properties, accessibility, custom embeds, secrets*, tags, data extensions, notifications, async jobs, site URLs, capital, meetings, captcha, site search) | 195 | 112 |

Every name, its group and whether it asks first are in `actions.json` (`group`, `readOnly`).

## Not tried live

No real Wix site was connected: the key check, an account-level call, the moved public addresses and every trigger
are tested against fakes only.
