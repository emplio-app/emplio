// Sitemaps (Bing calls them feeds): the lists of pages a site hands Bing so it knows what to look at.
import type { OwnAction } from "../index";
import { r, siteUrl, url } from "./client";

export const sitemapActions: Record<string, OwnAction> = {
  get_feeds: r("GET", "GetFeeds", "Every sitemap Bing knows about for this site, with how many addresses it holds, its size, when Bing last read it, and whether reading it worked or failed.", {
    siteUrl,
  }),
  get_feed_details: r("GET", "GetFeedDetails", "The sitemaps listed inside one sitemap index file, each with its own status and when Bing last read it. Use this when get_feeds shows a sitemap index.", {
    siteUrl,
    feedUrl: url("The sitemap index file's address, e.g. https://example.com/sitemap_index.xml"),
  }),
  submit_feed: r("POST", "SubmitFeed", "Hand Bing a sitemap for this site, so it knows which pages to look at. Bing reads it within a few days.", {
    siteUrl,
    feedUrl: url("The sitemap's address, e.g. https://example.com/sitemap.xml"),
  }),
  remove_feed: r("POST", "RemoveFeed", "Tell Bing to forget a sitemap for this site. The pages already found stay in Bing; only the list is dropped.", {
    siteUrl,
    feedUrl: url("The sitemap's address, as bing_webmaster.get_feeds shows it"),
  }),
};
