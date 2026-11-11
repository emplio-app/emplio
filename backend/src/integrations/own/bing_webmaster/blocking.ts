// Keeping things out of Bing: pages and folders blocked from search, pages whose preview snapshot is
// hidden, and the parts of a web address Bing should ignore when deciding two pages are the same.
import { z } from "zod";
import type { OwnAction } from "../index";
import { bingDate, dateField, r, shaped, siteUrl, tag, url } from "./client";

const ENTITY = { page: 0, folder: 1 } as const;
const REQUEST = { hide_the_snapshot: 0, remove_from_search: 1 } as const;
const REASON = { adult_content: 1, copyright: 2, illegal_content: 3, other: 4 } as const;

const blockFields = {
  siteUrl,
  blockedUrl: url("The page or folder to act on, in full, e.g. https://example.com/old-offer or https://example.com/drafts/"),
  entityType: z.enum(["page", "folder"]).describe('Whether the address above is one page or a whole folder; "folder" covers everything under it'),
  requestType: z
    .enum(["hide_the_snapshot", "remove_from_search"])
    .describe('"remove_from_search" takes it out of Bing results altogether; "hide_the_snapshot" leaves it listed but hides Bing\'s saved copy'),
  date: dateField("The date to record against the block"),
};
const blockBody = (i: any) => ({
  siteUrl: i.siteUrl,
  blockedUrl: {
    ...tag("BlockedUrl"),
    Date: bingDate(i.date),
    EntityType: ENTITY[i.entityType as keyof typeof ENTITY],
    RequestType: REQUEST[i.requestType as keyof typeof REQUEST],
    Url: i.blockedUrl,
  },
});

export const blockingActions: Record<string, OwnAction> = {
  // ── pages and folders kept out of Bing
  get_blocked_urls: r("GET", "GetBlockedUrls", "The pages and folders of this site blocked from Bing search, each with what kind of block it is and when it was added. Bing drops a block after 90 days, so check this if something reappears.", {
    siteUrl,
  }),
  add_blocked_url: shaped(
    "AddBlockedUrl",
    "Take one of your pages, or a whole folder, out of Bing search quickly — for something published by mistake or now wrong. Bing holds the block for 90 days, so also fix or remove the page itself.",
    blockFields,
    blockBody,
  ),
  remove_blocked_url: shaped(
    "RemoveBlockedUrl",
    "Lift a block so the page or folder can appear in Bing search again. Use the values exactly as bing_webmaster.get_blocked_urls shows them.",
    blockFields,
    blockBody,
  ),

  // ── hiding the little preview Bing shows beside a result
  get_active_page_preview_blocks: r("GET", "GetActivePagePreviewBlocks", "The pages of this site whose preview picture Bing has been told not to show, each with the reason given and when.", {
    siteUrl,
  }),
  add_page_preview_block: shaped(
    "AddPagePreviewBlock",
    "Stop Bing showing the little preview picture of one page beside its search result. The page itself stays in Bing.",
    {
      siteUrl,
      url: url("The page whose preview to hide, in full, e.g. https://example.com/private-offer"),
      reason: z.enum(["adult_content", "copyright", "illegal_content", "other"]).describe("Why the preview should not be shown"),
    },
    (i) => ({ siteUrl: i.siteUrl, url: i.url, reason: REASON[i.reason as keyof typeof REASON] }),
  ),
  remove_page_preview_block: r("POST", "RemovePagePreviewBlock", "Let Bing show a page's preview picture again.", {
    siteUrl,
    url: url("The page, as bing_webmaster.get_active_page_preview_blocks shows it"),
  }),

  // ── parts of a web address Bing should ignore
  get_query_parameters: r("GET", "GetQueryParameters", "The parts of a web address Bing has been told to ignore for this site (things like ?utm_source or ?sessionid), each with whether it is switched on.", {
    siteUrl,
  }),
  add_query_parameter: r("POST", "AddQueryParameter", "Tell Bing to ignore one part of a web address, so pages that differ only by it count as the same page and the site's ranking isn't split between them.", {
    siteUrl,
    queryParameter: z.string().min(1).describe('Just the name, without the = or a value, e.g. "utm_source", "sessionid", "ref"'),
  }),
  remove_query_parameter: r("POST", "RemoveQueryParameter", "Stop Bing ignoring one part of a web address, so pages differing by it count as different pages again.", {
    siteUrl,
    queryParameter: z.string().min(1).describe("The name, as bing_webmaster.get_query_parameters shows it"),
  }),
  enable_disable_query_parameter: r("POST", "EnableDisableQueryParameter", "Switch an ignored part of a web address on or off, without removing it from the list.", {
    siteUrl,
    queryParameter: z.string().min(1).describe("The name, as bing_webmaster.get_query_parameters shows it"),
    isEnabled: z.boolean().describe("true to have Bing ignore it, false to leave it on the list but not act on it"),
  }),
};
