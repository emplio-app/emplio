// Talking to one Shopify store's Admin GraphQL API with the key its owner pasted. Two kinds of key:
// - store + an Admin API access token (shpat_...) from a custom app made in the store's admin before 2026;
// - store + Client ID + Client secret of an app made in Shopify's Dev Dashboard. Those never give a lasting token:
//   each one is swapped for a 24-hour token (the client credentials grant), kept here and renewed before it runs out.
import { AppsError } from "../../types";

export const VERSION = "2026-10";
const TOKEN_HELP = "Shopify admin → Settings → Apps → Develop apps";

export type Store = { shop: string; token?: string; clientId?: string; clientSecret?: string };

// "mystore", "mystore.myshopify.com", "https://mystore.myshopify.com/admin" or "admin.shopify.com/store/mystore"
export function storeDomain(raw: string) {
  const s = raw.trim().toLowerCase().replace(/^https?:\/\//, "");
  const admin = /^admin\.shopify\.com\/store\/([a-z0-9-]+)/.exec(s);
  const host = admin ? `${admin[1]}.myshopify.com` : s.split("/")[0]!;
  const full = host.includes(".") ? host : `${host}.myshopify.com`;
  if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(full))
    throw new AppsError(`${raw} isn't a Shopify store address: use the one ending in .myshopify.com (Shopify admin → Settings → Domains shows it), even if your shop has its own domain`);
  return full;
}

// The pasted line: the store, then either the access token, or the Client ID and secret, separated by spaces.
export function parseKey(key: string): Store {
  const [shop = "", a = "", b = ""] = key.trim().split(/\s+/);
  if (!shop || !a) throw new AppsError("paste your store's address and then its access token (or Client ID and secret), separated by spaces");
  if (/^shp(at|ca|ss)_/.test(a)) return { shop: storeDomain(shop), token: a };
  if (!b) throw new AppsError("after the Client ID, paste the app's Client secret too, separated by a space");
  return { shop: storeDomain(shop), clientId: a, clientSecret: b };
}

// a renewed token is fetched this long before the old one runs out
const MARGIN_MS = 5 * 60_000;
const tokens = new Map<string, { token: string; until: number; pending?: Promise<string> }>();

// The store's access token: the pasted one, or this Client ID's current 24-hour one (renewed when it's nearly up).
export async function accessToken(s: Store, fresh = false): Promise<string> {
  if (s.token) return s.token;
  const cacheKey = `${s.shop} ${s.clientId} ${s.clientSecret}`;
  const got = tokens.get(cacheKey);
  if (got?.pending) return got.pending;
  if (got && !fresh && got.until - MARGIN_MS > Date.now()) return got.token;
  const pending = (async () => {
    const res = await fetch(`https://${s.shop}/admin/oauth/access_token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: new URLSearchParams({ grant_type: "client_credentials", client_id: s.clientId!, client_secret: s.clientSecret! }).toString(),
    });
    const text = await res.text();
    let out: { access_token?: string; expires_in?: number; error?: string; error_description?: string } = {};
    try {
      out = JSON.parse(text);
    } catch {}
    if (!res.ok || !out.access_token) {
      const why = out.error_description ?? out.error ?? (text.slice(0, 200) || res.statusText);
      if (res.status === 404) throw new AppsError(`there's no Shopify store at ${s.shop}; check the .myshopify.com address`, true);
      if (out.error === "shop_not_permitted")
        throw new AppsError("Shopify won't give this app a token for this store: make the app in the Dev Dashboard of the same Shopify account that owns the store, and install it there", true, why);
      throw new AppsError(`Shopify turned down the Client ID and secret (${why}); copy them again from the app's Settings in the Dev Dashboard, check the app is installed on ${s.shop}, and reconnect`, true);
    }
    tokens.set(cacheKey, { token: out.access_token, until: Date.now() + (out.expires_in ?? 86_399) * 1000 });
    return out.access_token;
  })();
  tokens.set(cacheKey, { token: got?.token ?? "", until: 0, pending });
  try {
    return await pending;
  } catch (error) {
    tokens.delete(cacheKey);
    throw error;
  }
}

type GqlError = { message: string; path?: (string | number)[]; extensions?: { code?: string; cost?: number; maxCost?: number } };
type Cost = { requestedQueryCost?: number; throttleStatus?: { currentlyAvailable: number; restoreRate: number } };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// One GraphQL call. Answers `data`; when Shopify left out some fields (a scope the app wasn't given), the rest comes
// back with the reasons under _warnings rather than failing.
export async function graphql(key: string, query: string, variables: Record<string, unknown> = {}, tries = 3): Promise<any> {
  const s = parseKey(key);
  for (let attempt = 1; ; attempt++) {
    const token = await accessToken(s, attempt > 1 && !s.token);
    const res = await fetch(`https://${s.shop}/admin/api/${VERSION}/graphql.json`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": token },
      body: JSON.stringify({ query, variables }),
    });
    // a Dev Dashboard token Shopify no longer takes: get a new one once before calling the login dead
    if (res.status === 401 && !s.token && attempt === 1) continue;
    if (res.status === 403) throw new AppsError(`Shopify refused: ${(await res.text()).slice(0, 300)}. The app may be missing a permission (scope) it needs`);
    if (res.status === 401)
      throw new AppsError(
        s.token
          ? `Shopify rejected the access token for ${s.shop}; the app may have been uninstalled. Make a new token (${TOKEN_HELP}) and reconnect`
          : `Shopify rejected the app for ${s.shop}; it may have been uninstalled. Install it again from the Dev Dashboard and reconnect`,
        true,
        `${res.status} ${(await res.text()).slice(0, 200)}`,
      );
    if (res.status === 404) throw new AppsError(`there's no Shopify store at ${s.shop}; check the .myshopify.com address`, true);
    if (res.status === 402) throw new AppsError(`${s.shop} is frozen or paused, so Shopify won't answer until its bill is paid`);
    if (res.status === 423) throw new AppsError(`Shopify has locked ${s.shop}`);
    if ((res.status === 429 || res.status >= 500) && attempt < tries) {
      await sleep(Number(res.headers.get("retry-after") ?? 2) * 1000);
      continue;
    }
    const text = await res.text();
    let out: { data?: any; errors?: GqlError[] | string; extensions?: { cost?: Cost } };
    try {
      out = JSON.parse(text);
    } catch {
      throw new AppsError(`Shopify: ${text.slice(0, 300) || res.statusText} (${res.status})`);
    }
    const errors = typeof out.errors === "string" ? [{ message: out.errors }] : (out.errors ?? []);
    if (errors.some((e) => e.extensions?.code === "THROTTLED") && attempt < tries) {
      const t = out.extensions?.cost;
      const wait = t?.throttleStatus && t.requestedQueryCost ? (t.requestedQueryCost - t.throttleStatus.currentlyAvailable) / t.throttleStatus.restoreRate : 2;
      await sleep(Math.min(10, Math.max(1, Math.ceil(wait))) * 1000);
      continue;
    }
    if (errors.some((e) => e.extensions?.code === "MAX_COST_EXCEEDED"))
      throw new AppsError("Shopify: that asks for too much in one go; ask for fewer (a smaller first) or fewer fields");
    const empty = !out.data || Object.values(out.data).every((v) => v === null);
    if (errors.length && empty) throw new AppsError(`Shopify: ${errors.map((e) => e.message).join("; ")}`);
    if (!res.ok) throw new AppsError(`Shopify: ${res.statusText} (${res.status})`);
    if (errors.length) out.data._warnings = errors.map((e) => `${e.path?.join(".") ?? ""}: ${e.message}`);
    return out.data;
  }
}

// A mutation's errors, as one message; nothing when it worked
export function userErrors(payload: unknown): string | undefined {
  if (!payload || typeof payload !== "object") return;
  const list = Object.entries(payload as Record<string, unknown>)
    .filter(([k, v]) => /[uU]serErrors$/.test(k) && Array.isArray(v))
    .flatMap(([, v]) => v as { field?: string[] | null; message: string }[]);
  if (list.length) return list.map((e) => (e.field?.length ? `${e.field.join(".")}: ${e.message}` : e.message)).join("; ");
}
