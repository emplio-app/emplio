// The websites in the account: adding and verifying one, who else can see it, telling Bing a site has
// moved, and saying which country a page or folder is written for.
import { z } from "zod";
import type { OwnAction } from "../index";
import { bingDate, dateField, r, shaped, siteUrl, tag, url } from "./client";

const MOVE_SCOPE = { whole_domain: 0, one_subdomain: 1, one_folder: 2 } as const;
const MOVE_TYPE = { same_country: 0, different_country: 1 } as const;
const REGION_FOR = { page: 0, folder: 1, whole_domain: 2, subdomain: 3 } as const;
const ROLE = { administrator: 0, read_only: 1, read_and_write: 2 } as const;

export const siteActions: Record<string, OwnAction> = {
  // ── the sites themselves
  get_user_sites: r("GET", "GetUserSites", "Every website in this Bing Webmaster Tools account, with its address, whether Bing has verified ownership, and the codes used to verify it."),
  add_site: r("POST", "AddSite", "Add a website to Bing Webmaster Tools. Bing only shows its search data once ownership is verified, so follow this with verify_site.", {
    siteUrl: url("The website to add, with http:// or https://, e.g. https://example.com"),
  }),
  verify_site: r("POST", "VerifySite", "Ask Bing to check that you own a site it has been given. Bing looks for the verification file, meta tag or DNS record; the answer says whether it worked.", {
    siteUrl,
  }),
  remove_site: r("POST", "RemoveSite", "Take a website out of Bing Webmaster Tools. Its search history in Bing Webmaster Tools goes with it.", { siteUrl }),

  // ── who else can see the site
  get_site_roles: r("GET", "GetSiteRoles", "The people who can see this site in Bing Webmaster Tools, each with their email, what they're allowed to do and whether their access has run out.", {
    siteUrl,
    includeAllSubdomains: z.boolean().optional().describe("true also lists people given access to a subdomain of this site (default false)"),
  }),
  add_site_roles: r("POST", "AddSiteRoles", "Give someone else access to this site in Bing Webmaster Tools. They get an email from Bing; the authentication code comes from get_user_sites for this site.", {
    siteUrl,
    delegatedUrl: url("The exact part of the site they get access to: the whole site, or one folder like https://example.com/shop/"),
    userEmail: z.string().min(3).describe("The email address of the person to give access to"),
    authenticationCode: z.string().min(1).describe("This site's authentication code, from bing_webmaster.get_user_sites"),
    isAdministrator: z.boolean().describe("true lets them change settings and add other people; false keeps them out of settings"),
    isReadOnly: z.boolean().describe("true lets them only look at the numbers; false lets them submit pages and change things"),
  }),
  remove_site_role: shaped(
    "RemoveSiteRole",
    "Take away someone's access to this site in Bing Webmaster Tools. Use the email and role exactly as bing_webmaster.get_site_roles shows them.",
    {
      siteUrl,
      email: z.string().min(3).describe("The email address of the person losing access, as get_site_roles shows it"),
      role: z.enum(["administrator", "read_only", "read_and_write"]).describe("What they can do today, as get_site_roles shows it"),
      site: url("The site their access is on, as get_site_roles shows it"),
      verificationSite: url("The site their access was verified against, as get_site_roles shows it"),
      delegatedCode: z.string().optional().describe("The delegated code from get_site_roles, when it shows one"),
      delegatorEmail: z.string().optional().describe("Who gave them the access, from get_site_roles, when it shows one"),
      date: dateField("The date their access was given"),
    },
    (i) => ({
      siteUrl: i.siteUrl,
      siteRole: {
        ...tag("SiteRole"),
        Date: bingDate(i.date),
        Email: i.email,
        Expired: false,
        Role: ROLE[i.role as keyof typeof ROLE],
        Site: i.site,
        VerificationSite: i.verificationSite,
        DelegatedCode: i.delegatedCode ?? null,
        DelegatedCodeOwnerEmail: null,
        DelegatorEmail: i.delegatorEmail ?? null,
      },
    }),
  ),

  // ── telling Bing the site has moved
  get_site_moves: r("GET", "GetSiteMoves", "Site moves already reported to Bing for this site: where each one went from and to, and when.", { siteUrl }),
  submit_site_move: shaped(
    "SubmitSiteMove",
    "Tell Bing the site, a subdomain or a folder has moved to a new address, so Bing moves its search ranking across instead of starting again. Redirects from the old addresses must already be in place.",
    {
      siteUrl,
      sourceUrl: url("Where it moved from, with http:// or https://, e.g. https://old.example.com"),
      targetUrl: url("Where it moved to, with http:// or https://, e.g. https://example.com"),
      moveScope: z.enum(["whole_domain", "one_subdomain", "one_folder"]).describe("How much moved: the whole domain, one subdomain, or one folder"),
      moveType: z.enum(["same_country", "different_country"]).describe('"same_country" when the new address serves the same country, "different_country" when the site moved to another country\'s address'),
      date: dateField("The date the move happened or will happen"),
    },
    (i) => ({
      siteUrl: i.siteUrl,
      settings: {
        ...tag("SiteMoveSettings"),
        Date: bingDate(i.date),
        MoveScope: MOVE_SCOPE[i.moveScope as keyof typeof MOVE_SCOPE],
        MoveType: MOVE_TYPE[i.moveType as keyof typeof MOVE_TYPE],
        SourceUrl: i.sourceUrl,
        TargetUrl: i.targetUrl,
      },
    }),
  ),

  // ── which country a page is meant for
  get_country_region_settings: r("GET", "GetCountryRegionSettings", "The pages, folders or subdomains of this site that are marked as written for one particular country, and which country each is marked for.", {
    siteUrl,
  }),
  add_country_region_settings: shaped(
    "AddCountryRegionSettings",
    "Mark a page, folder, subdomain or the whole site as written for one country, so Bing shows it to people searching there.",
    {
      siteUrl,
      url: url("The page, folder, subdomain or site this is about, e.g. https://example.com/in/"),
      twoLetterIsoCountryCode: z.string().length(2).describe("The country, as a two-letter code in lower case, e.g. in, gb, us"),
      settingsType: z.enum(["page", "folder", "whole_domain", "subdomain"]).describe("Whether the address above is one page, a folder, the whole domain, or a subdomain"),
      date: dateField("The date to record against it"),
    },
    (i) => ({
      siteUrl: i.siteUrl,
      settings: {
        ...tag("CountryRegionSettings"),
        Date: bingDate(i.date),
        TwoLetterISOCountryCode: i.twoLetterIsoCountryCode,
        Type: REGION_FOR[i.settingsType as keyof typeof REGION_FOR],
        Url: i.url,
      },
    }),
  ),
  remove_country_region_settings: shaped(
    "RemoveCountryRegionSettings",
    "Stop marking a page, folder, subdomain or site as written for one country. Use the values exactly as bing_webmaster.get_country_region_settings shows them.",
    {
      siteUrl,
      url: url("The page, folder, subdomain or site to unmark, as get_country_region_settings shows it"),
      twoLetterIsoCountryCode: z.string().length(2).describe("The country code it is marked with, in lower case"),
      settingsType: z.enum(["page", "folder", "whole_domain", "subdomain"]).describe("What the address is, as get_country_region_settings shows it"),
      date: dateField("The date on the setting, from get_country_region_settings"),
    },
    (i) => ({
      siteUrl: i.siteUrl,
      settings: {
        ...tag("CountryRegionSettings"),
        Date: bingDate(i.date),
        TwoLetterISOCountryCode: i.twoLetterIsoCountryCode,
        Type: REGION_FOR[i.settingsType as keyof typeof REGION_FOR],
        Url: i.url,
      },
    }),
  ),
};
