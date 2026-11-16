// WordPress on the business's own website: every route of the core REST API (posts, pages, media, comments,
// categories and tags, users, menus, settings, plugins, themes, templates, site health...), generated from a fresh
// install's /wp-json/ index by `bun scripts/openapi/wordpress.ts` + `bun scripts/openapi-actions.ts wordpress`.
// Two ways in, one set of actions (COVERAGE.md says why):
// - a self-hosted site (Hostinger, GoDaddy, any host): its address, a username and an Application Password, sent as
//   Basic auth to <site>/wp-json/...
// - WordPress.com, or a Jetpack site, signed in through our WordPress.com app: the same routes through
//   public-api.wordpress.com/<namespace>/sites/<blog>/..., plus Jetpack's stats.
// Plugins' own routes (WooCommerce, Yoast...) are reached with call_api_get / call_api.
import { isIP } from "node:net";
import { z } from "zod";
import { AppsError } from "../../types";
import type { OwnAction, OwnApp } from "../index";
import { type Api, call, specActions } from "../openapi";

const WPCOM = "https://public-api.wordpress.com";
const HELP = "In your WordPress admin, Users → Profile → Application Passwords: type Emplio as the name and press Add New Application Password";

type Site = { kind: "site"; site: string; user: string; password: string } | { kind: "wpcom"; blog: string; token: string };

// a self-hosted site must be a public https address: WordPress only offers Application Passwords over https, and the
// password must never go out in the clear or to a machine on our own network
// ponytail: checks the address as typed, not where its name resolves; a resolver check if anyone points a domain inward
function publicHttps(raw: string) {
  let u: URL;
  try {
    u = new URL(/^[a-z]+:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch {
    throw new AppsError(`"${raw}" isn't a website address. Start with your site's address, like https://example.com`);
  }
  if (u.protocol !== "https:") throw new AppsError("the site's address must start with https:// (WordPress only allows Application Passwords on https sites)");
  const host = u.hostname.replace(/^\[|\]$/g, "");
  const inside =
    host === "localhost" ||
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    (isIP(host) === 4 && /^(0|10|127|169\.254|172\.(1[6-9]|2\d|3[01])|192\.168|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7]))\./.test(host)) ||
    (isIP(host) === 6 && /^(::1?$|f[cd]|fe80|::ffff:)/i.test(host));
  if (inside) throw new AppsError("that address isn't a public website");
  // the admin or API address works too: what's before /wp-admin or /wp-json is the site (it may sit in a folder)
  return `${u.origin}${u.pathname.replace(/\/(wp-admin|wp-json|wp-login\.php).*$/, "").replace(/\/+$/, "")}`;
}

// The key is one line: "<site address> <username> <application password>". The password is shown in groups of four
// with spaces ("abcd EFGH 1234 ..."), and usernames may hold spaces too, so the password is taken from the end.
// A sign-in through WordPress.com is stored as "wpcom <blog id> <token>".
export function parseKey(key: string): Site {
  const parts = key.trim().split(/\s+/);
  if (parts[0] === "wpcom" && parts.length === 3) return { kind: "wpcom", blog: parts[1]!, token: parts[2]! };
  const bad = (why: string) =>
    new AppsError(`${why}. Paste the site's address, your username and the Application Password on one line, separated by spaces, like "https://example.com admin abcd EFGH 1234 ijkl MNOP 5678" (${HELP})`);
  if (parts.length < 3) throw bad(`expected the address, username and password, got ${parts.length} part${parts.length === 1 ? "" : "s"}`);
  const grouped = parts.length >= 8 && parts.slice(-6).every((p) => /^[A-Za-z0-9]{4}$/.test(p));
  const password = grouped ? parts.slice(-6).join("") : parts.at(-1)!;
  const user = parts.slice(1, grouped ? -6 : -1).join(" ");
  if (!user) throw bad("the username is missing");
  return { kind: "site", site: publicHttps(parts[0]!), user, password };
}

// "/wp/v2/posts" on WordPress.com is "/wp/v2/sites/<blog>/posts"
const wpcomPath = (blog: string, path: string) => (path === "/" ? `/wp/v2/sites/${blog}` : path.replace(/^(\/[^/]+\/[^/]+)/, `$1/sites/${blog}`));

const api: Api = {
  name: "WordPress",
  base: "",
  tokenHelp: HELP,
  auth: (key) => {
    const s = parseKey(key);
    return s.kind === "wpcom" ? { Authorization: `Bearer ${s.token}` } : { Authorization: `Basic ${Buffer.from(`${s.user}:${s.password}`).toString("base64")}` };
  },
  // plugin and template ids hold a slash (akismet/akismet, theme//home), which the route wants as it is
  url: (key, _base, path) => {
    const s = parseKey(key);
    const p = path.replace(/%2F/gi, "/");
    return s.kind === "wpcom" ? `${WPCOM}${wpcomPath(s.blog, p)}` : `${s.site}/wp-json${p}`;
  },
};

// Jetpack's stats and the site's overview, only through WordPress.com
const stats: Api = {
  ...api,
  url: (key, _base, path) => {
    const s = parseKey(key);
    if (s.kind !== "wpcom")
      throw new AppsError("Visitor stats come from Jetpack through WordPress.com. Connect this site with “Sign in with WordPress.com” (the site needs Jetpack if it isn't on WordPress.com)");
    return `${WPCOM}/rest/v1.1/sites/${s.blog}${path}`;
  },
};

const statsCall = (path: string) => (input: Record<string, unknown>, key: string) => call(stats, key, { method: "GET", path, query: Object.keys(input), headers: [] }, input);

const PERIOD = z.enum(["day", "week", "month", "year"]).optional().describe("How the numbers are grouped (default day)");
const DATE = z.string().optional().describe("The last day covered, YYYY-MM-DD (default today, in the site's timezone)");

// any route, for what plugins add: the path is under /wp-json, like /wc/v3/orders or /yoast/v1/...
function anyRoute(method: string, input: { path: string; query?: Record<string, unknown>; body?: unknown }, key: string) {
  const [path = "", search = ""] = input.path.split("?");
  if (!path.startsWith("/") || path.includes("..") || /[{}]/.test(path)) throw new AppsError('path: a route under /wp-json, starting with "/", like /wc/v3/orders (get_api_index lists them)');
  const query = { ...Object.fromEntries(new URLSearchParams(search)), ...input.query };
  return call(api, key, { method, path, query: Object.keys(query), headers: [], body: input.body === undefined ? undefined : { kind: "whole", field: "__body" } }, { ...query, "__body": input.body });
}
const ROUTE = {
  path: z.string().describe("The route under /wp-json, like /wc/v3/orders, /wp/v2/posts/12 or /yoast/v1/get_head. get_api_index lists every route the site has"),
  query: z.record(z.string(), z.any()).optional().describe('Query parameters, like {"per_page": 20, "status": "processing"}'),
};

const extra: Record<string, OwnAction> = {
  call_api_get: {
    description:
      "Read from any REST route of the site, including the ones plugins add (WooCommerce orders and products, Yoast SEO, Jetpack, forms, bookings...). get_api_index lists them with their arguments.",
    readOnly: true,
    input: z.object(ROUTE),
    run: (i, key) => anyRoute("GET", i, key),
  },
  call_api: {
    description: "Change something through any REST route of the site, including plugins' (create a WooCommerce product, update an order...). Use call_api_get to read.",
    input: z.object({
      method: z.enum(["POST", "PUT", "PATCH", "DELETE"]).describe("POST creates or updates (WordPress takes POST for updates too); DELETE removes"),
      ...ROUTE,
      body: z.any().optional().describe("The JSON body, as the route's arguments describe it"),
    }),
    run: (i, key) => anyRoute(i.method, i, key),
  },
  get_site_overview: {
    description: "The site's name, address, plan, language, post and subscriber counts and options, from WordPress.com. Needs the WordPress.com sign-in.",
    readOnly: true,
    input: z.object({}),
    run: statsCall(""),
  },
  get_detailed_site_stats: {
    description: "Visitor stats summary: views and visitors today, best day ever, all-time totals, and the top posts and referrers. From Jetpack, through the WordPress.com sign-in.",
    readOnly: true,
    input: z.object({}),
    run: statsCall("/stats"),
  },
  get_visit_stats: {
    description: "Views and visitors over time, one row per day, week, month or year. From Jetpack, through the WordPress.com sign-in.",
    readOnly: true,
    input: z.object({ unit: PERIOD, quantity: z.number().int().min(1).max(365).optional().describe("How many periods back (default 30)"), date: DATE }),
    run: statsCall("/stats/visits"),
  },
  get_stats_report: {
    description: "One visitor report: the most viewed posts and pages, where visitors came from, what they searched for, which links they clicked, their countries, files downloaded or videos played. From Jetpack, through the WordPress.com sign-in.",
    readOnly: true,
    input: z.object({
      report: z.enum(["top-posts", "referrers", "search-terms", "clicks", "country-views", "top-authors", "file-downloads", "video-plays", "tags", "comments", "followers", "publicize", "post"]).describe("Which report"),
      period: PERIOD,
      date: DATE,
      num: z.number().int().optional().describe("How many periods the report covers (default 1)"),
      max: z.number().int().optional().describe("Most rows to return (default 10, 0 for all)"),
      post_id: z.number().int().optional().describe("report post only: the post whose views to get"),
    }),
    run: ({ report, post_id, ...rest }, key) => statsCall(report === "post" ? `/stats/post/${post_id ?? ""}` : `/stats/${report}`)(rest, key),
  },
};

export const wordpress: OwnApp = {
  app: "wordpress",
  name: "WordPress",
  logo: "/logos/wordpress.svg",
  keyField: {
    label: "Site address, username and Application Password",
    help: `${HELP}. Then paste your site's address, your WordPress username and the password it shows, on one line separated by spaces. Use an Administrator account so Emplio can manage plugins, users and settings; an Editor can handle posts, pages and comments. On WordPress.com, sign in instead.`,
    placeholder: "https://example.com admin abcd EFGH 1234 ijkl MNOP 5678",
  },
  // whose login it is, on which site; a wrong password gets a 401, which marks the connection for reconnecting
  async check(key) {
    const s = parseKey(key);
    let me: { name?: string };
    try {
      me = (await call(api, key, { method: "GET", path: "/wp/v2/users/me", query: ["context"], headers: [] }, { context: "edit" })) as typeof me;
    } catch (e) {
      if (!(e instanceof AppsError) || s.kind !== "site") throw e;
      if (e.expired || /\(403\)$/.test(e.message))
        throw new AppsError(`${s.site} refused that login. Check the username and the Application Password (not your usual password). If both are right, the host may be dropping the login header, or a security plugin is blocking the REST API`);
      throw new AppsError(`couldn't reach the WordPress REST API at ${s.site}/wp-json/ (${e.message}). Check the address; if the site uses plain permalinks, switch Settings → Permalinks to "Post name"`);
    }
    if (typeof me !== "object" || !me?.name) throw new AppsError(`${s.kind === "site" ? s.site : "that site"} didn't answer like a WordPress site. Check the address`);
    return s.kind === "site" ? `${me.name} on ${new URL(s.site).host}` : me.name;
  },
  // WordPress.com and Jetpack sites, on a server with our WordPress.com app's client id and secret
  oauth: {
    ready: () => Boolean(process.env.WORDPRESS_CLIENT_ID && process.env.WORDPRESS_CLIENT_SECRET),
    // no scope: the person picks one site on the consent screen, and the token works for that site only
    authorizeUrl: (redirect, state) =>
      `${WPCOM}/oauth2/authorize?${new URLSearchParams({ client_id: process.env.WORDPRESS_CLIENT_ID!, redirect_uri: redirect, response_type: "code", state })}`,
    // WordPress.com tokens don't run out
    async exchange(code, redirect) {
      const res = await fetch(`${WPCOM}/oauth2/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
        body: new URLSearchParams({ client_id: process.env.WORDPRESS_CLIENT_ID!, client_secret: process.env.WORDPRESS_CLIENT_SECRET!, code, redirect_uri: redirect, grant_type: "authorization_code" }),
        signal: AbortSignal.timeout(30_000),
      });
      const out = (await res.json().catch(() => null)) as { access_token?: string; blog_id?: string | number; error_description?: string } | null;
      if (!out?.access_token || !out.blog_id) throw new AppsError(out?.error_description ?? "WordPress.com didn't finish the sign-in. Try again, and pick one site.");
      return `wpcom ${out.blog_id} ${out.access_token}`;
    },
  },
  actions: { ...(await specActions(new URL("./actions.json", import.meta.url), api)), ...extra },
};
