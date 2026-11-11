// Bing Webmaster Tools on the business's own API key: how the website is doing in Bing and Copilot search.
// Every call of Bing's JSON service — the sites in the account and who can see them, sitemaps, asking Bing
// to look at a page, crawl figures and crawl problems, search terms and page traffic, keyword research,
// link counts, blocked pages and deep links. Bing publishes no OpenAPI spec, so the calls are listed by
// hand; COVERAGE.md says what's where. Bing sends nothing when something changes, so the triggers are
// polled, in polls/bing_webmaster.ts.
import { AppsError } from "../../types";
import type { OwnApp } from "../index";
import { blockingActions } from "./blocking";
import { crawlActions } from "./crawl";
import { linkActions } from "./links";
import { siteActions } from "./sites";
import { sitemapActions } from "./sitemaps";
import { submissionActions } from "./submission";
import { trafficActions } from "./traffic";

export const bing_webmaster: OwnApp = {
  app: "bing_webmaster",
  name: "Bing Webmaster Tools",
  logo: "/logos/bing_webmaster.svg",
  keyField: {
    label: "API key",
    help: "bing.com/webmasters → the gear (Settings) at the top right → API access → API key → Generate, then copy it. One key covers every website in that Bing account. Generating a new key stops the old one working.",
    placeholder: "32 letters and numbers",
  },
  // the account's websites: the cheapest call there is, and it labels the connection with the first site
  async check(key) {
    const sites = (await siteActions.get_user_sites!.run({}, key)) as { Url?: string }[] | undefined;
    if (!Array.isArray(sites)) throw new AppsError("Bing Webmaster Tools answered with something unexpected; check the API key and try again");
    const first = sites[0]?.Url;
    if (!first) return "no websites added yet";
    return sites.length > 1 ? `${first} and ${sites.length - 1} more` : first;
  },
  actions: { ...siteActions, ...sitemapActions, ...submissionActions, ...crawlActions, ...trafficActions, ...linkActions, ...blockingActions },
};
