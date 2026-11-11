# Google Search Console coverage

Source: Google's own Discovery document for the Search Console API
(`https://searchconsole.googleapis.com/$discovery/rest?version=v1`, which covers both the Search Console v1 and the
Webmasters v3 surfaces), generated 2026-11-11 by `bun scripts/openapi-actions.ts googlesearchconsole`.

Every method in it is an action (10), plus three written by hand (search_performance, compare_search_performance,
list_sitemap_problems) that do the date arithmetic and the comparing a business owner actually asks for. Composio's
toolkit has 9 tools and no triggers; all 9 are here under the same names, and there are 8 triggers.

Google's search data is two to three days behind, so every action and trigger that reads numbers looks at a window
ending three days ago, and says so in its description.

## Deliberately left out

| What | Why |
| --- | --- |
| `urlTestingTools.mobileFriendlyTest.run` | Google shut the Mobile-Friendly Test API down in December 2023. It is still in the Discovery document and asks for no scope at all; `inspect_url` reports mobile usability instead |
| Index coverage, Core Web Vitals, manual actions, security issues, links, removals | Search Console has no API for these reports — they exist only in the web interface. `inspect_url` gives per-page index status, crawl time, mobile usability and rich results, which is as close as the API comes |
| Adding or verifying site ownership | `add_site` registers a site, but verification is a different API (Site Verification) with its own scope and its own OAuth review; the person verifies in Search Console, which takes a minute |

## Hand adjustments (scripts/openapi/googlesearchconsole.ts, own/googlesearchconsole/index.ts)

- Actions are renamed to Composio's names (`list_sites`, `search_analytics_query`, `inspect_url`…), so a skill or
  automation written against Composio's Search Console keeps working.
- `siteUrl` and `feedpath` get descriptions saying exactly what to paste, since Google's own are vague about the
  `sc-domain:` form and the trailing slash.
- `search_analytics_query` and `inspect_url` are POSTs that only look things up, so they run without asking.
- `search_performance`, `compare_search_performance` and `list_sitemap_problems` are written by hand: days instead of
  dates, one dimension instead of Google's nested filter groups, totals worked out (Google returns per-row numbers
  only), and the period before compared row by row. `compare_search_performance` is what the
  `search_performance_change_trigger` reads.
- `inspect_url`'s description from Google is the two words "Index inspection", so it is rewritten.

## Auth

| Method | Status |
| --- | --- |
| Sign in with Google (the one Google OAuth client, `own/google-login.ts`), scope `.../auth/webmasters` | done |
| Pasted key | not offered: Search Console has no API keys |

`webmasters` is a sensitive scope, not a restricted one, so it needs Google's OAuth consent-screen review but no
yearly security audit. The Search Console API has to be turned on in the Google Cloud project behind the client.

## Triggers (polled; Search Console has no webhooks)

| Trigger | What starts it |
| --- | --- |
| new_site_trigger | A site appears in Search Console for this account |
| new_sitemap_trigger | A sitemap is submitted for the site |
| sitemap_problem_trigger | Google reports errors or warnings on a sitemap, or can't read it; again when the counts change |
| sitemap_read_trigger | Google reads a sitemap again |
| url_index_status_changed_trigger | What Google says about one page changes (in the results, or why not) |
| search_performance_change_trigger | Clicks or impressions move more than a set share against the period before; at most once a day |
| new_top_query_trigger | A search term enters the site's top list |
| new_top_page_trigger | A page enters the site's most-clicked pages |

## Actions by group (* asks first)

**Sites** (4): list_sites, get_site, add_site*, delete_site*

**Sitemaps** (5): list_sitemaps, get_sitemap, submit_sitemap*, delete_sitemap*, list_sitemap_problems

**Search performance** (3): search_analytics_query, search_performance, compare_search_performance

**One page** (1): inspect_url
