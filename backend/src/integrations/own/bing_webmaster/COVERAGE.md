# Bing Webmaster Tools coverage

Source: Bing's own method list, `IWebmasterApi`
(learn.microsoft.com/dotnet/api/microsoft.bing.webmaster.api.interfaces.iwebmasterapi) plus the JSON protocol
page (learn.microsoft.com/bingwebmaster/api-protocols), read 2026-11-11. Request and answer shapes were
checked against Merj's Python wrapper (github.com/merj/bing-webmaster-tools), and the error shape against the
live service with a deliberately wrong key.

Bing publishes no OpenAPI spec, so the 62 calls are written by hand in `own/bing_webmaster/`, split by
resource, all running through `own/openapi.ts`. **All 62 methods Bing's interface lists are actions.** Nothing
was left out. 36 of them only look things up and run without asking; the other 26 change something and ask
first.

## The service's quirks, and where each is handled

| Quirk | What happens | Where |
| --- | --- | --- |
| The key is a query parameter | `?apikey=…` on every call; the service takes no auth header at all, so `auth` sends none and `apikey` is added to every call's query | `client.ts` (`api.auth`, `r`, `shaped`) |
| Every answer is wrapped | The real answer sits under `d`; `tidy` unwraps it, so actions hand back the data itself | `client.ts` (`tidy`) |
| .NET dates | Bing writes dates as `/Date(1762819200000+0000)/` and insists on that shape in request bodies too. Answers are turned into ordinary dates; a date going out is converted, and a date Emplio can't read is refused before the call | `client.ts` (`tidy`, `bingDate`) |
| .NET type tags | Every object carries `__type`; stripped from answers, and added back (as `Name:#Microsoft.Bing.Webmaster.Api`) on the objects Bing requires it on | `client.ts` (`tag`), `sites.ts`, `crawl.ts`, `blocking.ts` |
| A bad key is a 400, not a 401 | A mistyped or regenerated key comes back `400 {"ErrorCode":3}`, so `deadToken` looks at the code, and the connection is marked for reconnecting | `client.ts` (`api.deadToken`) |
| Some failures come back with a 200 | A 200 whose body carries an `ErrorCode` is treated as a failure, with Bing's own `Message` | `client.ts` (`api.failed`) |
| Bing's wording in errors | Bing's field is `Message` with a capital M, so that was added to the reason chain shared by all own apps | `own/openapi.ts` |
| Asking Bing to look at a page is rationed | Capped per day and per month, per site. `get_url_submission_quota` and `get_content_submission_quota` are actions, each named in the description of the call it limits, so Emplio can check before spending one. Over the cap, Bing refuses with its own message | `submission.ts` |
| A folder listing is a POST that only reads | `get_children_url_info` is marked read-only, so it runs without asking | `crawl.ts` |

## Against Composio

`bun ../.claude/skills/new-integration/coverage.ts bing_webmaster bing_webmaster_tools` → ours 62 actions and 4
triggers, Composio's toolkit 13 actions and no triggers. Ten of Composio's names don't match ours, and every
one of them is the same call under Bing's own name:

| Composio | Here |
| --- | --- |
| `list_sites` | `get_user_sites` |
| `inspect_url` | `get_url_info` |
| `list_child_urls` | `get_children_url_info` |
| `get_search_performance` | `get_rank_and_traffic_stats` |
| `get_query_performance` | `get_query_stats` |
| `get_page_performance` | `get_page_stats` |
| `get_crawl_diagnostics` | `get_crawl_issues`, `get_crawl_stats` |
| `get_inbound_links` | `get_link_counts`, `get_url_links` |
| `get_submission_quotas` | `get_url_submission_quota`, `get_content_submission_quota` |
| `research_keywords` | `get_keyword`, `get_keyword_stats`, `get_related_keywords` |

Bing's own names are kept, because this app is new to Emplio: no automation was ever saved against Composio's
names, so there is nothing to keep working, and a name that matches Bing's own docs is easier to follow.

## Deliberately left out

| What | Why |
| --- | --- |
| Nothing from the JSON service | All 62 methods are actions |
| Webhooks | Bing Webmaster Tools has none: there is no way to register one and no events are sent. Everything is polled instead (below) |
| OAuth sign-in | Bing does document an OAuth flow, but it needs an Azure app registration in the owner's own Microsoft account, which is theirs to set up. The pasted key covers every site in the account and is what the Webmaster Tools screen offers, so that is what ships. Worth adding later if owners find the key awkward |
| The SOAP and POX versions of the same service | Microsoft retires both on 31 August 2026; this uses the JSON service, which stays |

## Auth

| Method | Status |
| --- | --- |
| API key, pasted (bing.com/webmasters → gear → API access → API key), sent as `?apikey=` | done |

`check` calls `GetUserSites` — the cheapest call there is — and labels the connection with the account's first
website, so the owner can see which Bing account is connected. One key covers every site in that account, and
generating a new key in Bing stops the old one working, which shows up as a connection to reconnect.

## Triggers (polled, `polls/bing_webmaster.ts`)

Bing sends nothing when something changes, so each of these reads the site's figures and compares with last
time. Bing's own numbers move about once a day, so the default is a daily check and the least allowed is
hourly.

Polling only ever reports what it hasn't seen before, so "it got worse" is written as a state folded into the
item's id. One consequence worth knowing: these also fire on the way back up, and the item says which way it
went (`failing`, `in_index`), so a prompt can tell good news from bad.

| Trigger | Fires when | Its id |
| --- | --- | --- |
| `crawl_error_found` | Bing hits a new problem on a page, or the problem on a page changes | `url:issues:httpCode` |
| `sitemap_status_changed` | A sitemap's status changes — most usefully, Bing starts failing to read it | `url:status` |
| `page_index_status_changed` | A page the owner names drops out of Bing's index, or returns to it | `url:in` / `url:out` |
| `keyword_position_changed` | A search term's average position moves into a different step of positions (step 1 by default, so every move counts) | `query:position/step` |

Two things these cannot do, both because of the state folded into the id:

- A page that drops out, comes back, and drops out again reports the first drop and the recovery, but not the
  second drop, because `url:out` has already been seen. The same holds for a sitemap failing twice with the
  same status. Fixing it properly needs the poller to keep the last value rather than a list of ids seen.
- `page_index_status_changed` costs one call per page watched, so it is capped at 20 pages.
- `keyword_position_changed` works in steps of positions rather than measuring the move itself, so with a step
  of 5 a one-place slip from 14 to 15 counts as news while a four-place slip from 15 to 19 does not. Measuring
  the move needs the poller to keep the last position, as above.

## Actions by group (* asks first)

**Sites** (12): get_user_sites, add_site\*, verify_site\*, remove_site\*, get_site_roles, add_site_roles\*,
remove_site_role\*, get_site_moves, submit_site_move\*, get_country_region_settings,
add_country_region_settings\*, remove_country_region_settings\*

**Sitemaps** (4): get_feeds, get_feed_details, submit_feed\*, remove_feed\*

**Getting pages into Bing** (8): submit_url\*, submit_url_batch\*, get_url_submission_quota, submit_content\*,
get_content_submission_quota, fetch_url\*, get_fetched_urls, get_fetched_url_details

**Crawling and the index** (8): get_crawl_stats, get_crawl_issues, get_crawl_settings, save_crawl_settings\*,
get_url_info, get_children_url_info, get_url_traffic_info, get_children_url_traffic_info

**Search traffic and keywords** (10): get_rank_and_traffic_stats, get_query_stats, get_query_traffic_stats,
get_query_page_stats, get_query_page_detail_stats, get_page_stats, get_page_query_stats, get_keyword,
get_keyword_stats, get_related_keywords

**Links and deep links** (10): get_link_counts, get_url_links, get_connected_pages, add_connected_page\*,
get_deep_link_blocks, add_deep_link_block\*, remove_deep_link_block\*, get_deep_link, get_deep_link_algo_urls,
update_deep_link\*

**Blocking and web address parameters** (10): get_blocked_urls, add_blocked_url\*, remove_blocked_url\*,
get_active_page_preview_blocks, add_page_preview_block\*, remove_page_preview_block\*, get_query_parameters,
add_query_parameter\*, remove_query_parameter\*, enable_disable_query_parameter\*

Three of the deep link calls — `get_deep_link`, `get_deep_link_algo_urls`, `update_deep_link` — are marked
obsolete by Bing. They are here so nothing in the service is out of reach, and each says in its own
description that Bing has retired it and may answer with nothing.

## Not tried against Bing

Every call and trigger here is covered by tests with `fetch` faked, but nothing has been run against a real
Bing Webmaster Tools account: that needs the owner's own API key. The error shape (`{"ErrorCode":3,...}` with
a 400) was confirmed against the live service with a wrong key.
