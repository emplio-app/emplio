// Pushing pages at Bing: asking it to look at a page now, sending a page's content straight to it, and
// seeing how much of today's allowance is left. Bing caps both per day and per month, per site.
import { z } from "zod";
import type { OwnAction } from "../index";
import { r, shaped, siteUrl, url } from "./client";

const DEVICE = { any: 0, computer: 1, mobile: 2, amp: 3, tablet: 4, screen_reader: 5 } as const;

export const submissionActions: Record<string, OwnAction> = {
  // ── asking Bing to look at a page
  submit_url: r("POST", "SubmitUrl", "Ask Bing to look at one page now, instead of waiting for it to come round. New and changed pages usually appear in Bing within minutes. This uses one of the day's allowance, so check get_url_submission_quota first.", {
    siteUrl,
    url: url("The page to submit, in full, e.g. https://example.com/new-offer"),
  }),
  submit_url_batch: r("POST", "SubmitUrlBatch", "Ask Bing to look at a list of pages now, in one go (up to 500 addresses, and no more than the day's allowance). Faster than one at a time after a big update to the site.", {
    siteUrl,
    urlList: z.array(z.string()).min(1).max(500).describe('The pages to submit, in full, as a list, e.g. ["https://example.com/a", "https://example.com/b"]'),
  }),
  get_url_submission_quota: r("GET", "GetUrlSubmissionQuota", "How many pages this site may still ask Bing to look at today and this month. Bing refuses submissions once the day's number reaches zero.", {
    siteUrl,
  }),

  // ── sending Bing the page itself
  submit_content: shaped(
    "SubmitContent",
    "Send Bing a page's own content, so it can be shown in search without Bing having to fetch the page. For sites that are slow or hard for Bing to read. Check get_content_submission_quota first.",
    {
      siteUrl,
      url: url("The page this content belongs to, in full, e.g. https://example.com/product/1"),
      httpMessage: z.string().min(1).describe("The whole page as Bing would have fetched it (HTTP headers then the HTML), encoded in base64"),
      structuredData: z.string().min(1).describe("The page's structured data (its JSON-LD or similar), encoded in base64; send an empty base64 string when there is none"),
      dynamicServing: z
        .enum(["any", "computer", "mobile", "amp", "tablet", "screen_reader"])
        .describe('Which kind of visitor this version of the page is for; use "any" when the page looks the same to everyone'),
    },
    (i) => ({
      siteUrl: i.siteUrl,
      url: i.url,
      httpMessage: i.httpMessage,
      structuredData: i.structuredData,
      dynamicServing: DEVICE[i.dynamicServing as keyof typeof DEVICE],
    }),
  ),
  get_content_submission_quota: r("GET", "GetContentSubmissionQuota", "How many pages' content this site may still send Bing today and this month.", { siteUrl }),

  // ── Bing fetching a page for you to inspect
  fetch_url: r("POST", "FetchUrl", "Have Bing fetch one page the way its crawler would, so you can see what Bing actually gets. The result shows up in get_fetched_urls a short while later.", {
    siteUrl,
    url: url("The page for Bing to fetch, in full, e.g. https://example.com/about"),
  }),
  get_fetched_urls: r("GET", "GetFetchedUrls", "The pages Bing has fetched for this site at your request, each with the date and whether the fetch worked.", { siteUrl }),
  get_fetched_url_details: r("GET", "GetFetchedUrlDetails", "What Bing actually received when it fetched one page: the response headers and the page's own HTML, so you can see what Bing sees.", {
    siteUrl,
    url: url("The fetched page's address, as bing_webmaster.get_fetched_urls shows it"),
  }),
};
