// Zoho keeps each customer's account in one data centre, with its own sign-in and API addresses. The sign-in page says
// which in its callback (location=in). The data centre is kept at the front of the stored login, "in:<token>", so every
// call knows where to go and no new storage is needed. One client id and secret serve all four Zoho apps; the sign-in starts
// at ZOHO_ACCOUNTS_URL, which must be the data centre the client was made in until the others are enabled in Zoho's console.
import { z } from "zod";
import { AppsError } from "../types";
import type { OwnAction, OwnApp } from "./index";
import { postToken } from "./oauth";
import type { Api } from "./openapi";

const DCS: Record<string, { accounts: string; tld: string; mail?: string; upload?: string }> = {
  us: { accounts: "https://accounts.zoho.com", tld: "com" },
  eu: { accounts: "https://accounts.zoho.eu", tld: "eu" },
  in: { accounts: "https://accounts.zoho.in", tld: "in" },
  au: { accounts: "https://accounts.zoho.com.au", tld: "com.au" },
  jp: { accounts: "https://accounts.zoho.jp", tld: "jp" },
  ca: { accounts: "https://accounts.zohocloud.ca", tld: "ca", mail: "https://mail.zohocloud.ca", upload: "https://upload.zohocloud.ca" },
  sa: { accounts: "https://accounts.zoho.sa", tld: "sa" },
  uk: { accounts: "https://accounts.zoho.uk", tld: "uk" },
  ae: { accounts: "https://accounts.zoho.ae", tld: "ae" },
  sg: { accounts: "https://accounts.zoho.sg", tld: "sg" },
};

// The callback's location picks from our own table, never its accounts-server: that address would get our client secret.
const dcOf = (location: unknown) => {
  const dc = String(location ?? "").toLowerCase();
  if (!DCS[dc]) throw new AppsError(`Zoho sent back a data centre we don't know (${dc || "none"}). Try again.`);
  return dc;
};
const startDc = () => {
  const url = (process.env.ZOHO_ACCOUNTS_URL ?? DCS.us!.accounts).replace(/\/$/, "");
  return Object.keys(DCS).find((dc) => DCS[dc]!.accounts === url);
};

export const zohoSplit = (key: string) => {
  const at = key.indexOf(":");
  return { dc: key.slice(0, at), token: key.slice(at + 1) };
};
const dcEntry = (key: string) => {
  const entry = DCS[zohoSplit(key).dc];
  if (!entry) throw new AppsError("this Zoho login is missing its data centre; reconnect it", true);
  return entry;
};
export const zohoAuth = (key: string) => ({ Authorization: `Zoho-oauthtoken ${zohoSplit(key).token}` });
// the addresses a login's calls go to
export const zohoApi = (key: string) => `https://www.zohoapis.${dcEntry(key).tld}`;
export const zohoMail = (key: string) => {
  const dc = dcEntry(key);
  return dc.mail ?? `https://mail.zoho.${dc.tld}`;
};
export const zohoUpload = (key: string) => {
  const dc = dcEntry(key);
  return dc.upload ?? `https://upload.zoho.${dc.tld}`;
};
// Actions are generated with the US addresses; this puts the login's data centre in their place.
const zohoUrl = (key: string, base: string, path: string) =>
  `${base.replace("https://www.zohoapis.com", zohoApi(key)).replace("https://upload.zoho.com", zohoUpload(key)).replace("https://mail.zoho.com", zohoMail(key))}${path}`;

// What Zoho says when a login is finished, in whichever of its shapes (Books' code 57 comes with a 401). Not a scope problem: signing in again wouldn't fix that.
const DEAD = new Set(["INVALID_TOKEN", "AUTHENTICATION_FAILURE", "INVALID_OAUTHTOKEN"]);
const deadCode = (b: any) => [b?.code, b?.errorCode, b?.data?.errorCode, b?.status?.errorCode].some((c) => DEAD.has(String(c)));
const SCOPE = /SCOPE/i;
const scopeCode = (b: any) => [b?.code, b?.errorCode, b?.data?.errorCode].some((c) => SCOPE.test(String(c)));

// Zoho's failures that come with a 200: Books and Invoice {code: <not 0>, message}, CRM {status: "error"} or every row of data[] failing, Mail {status: {code: 4xx}}.
// A CRM write where only some rows failed comes back whole, so the person sees which.
export function zohoFailed(name: string, body: any): string | undefined {
  if (!body || typeof body !== "object") return;
  if (deadCode(body)) throw new AppsError(`${name} rejected the login; sign in again`, true);
  if (typeof body.code === "number" && body.code !== 0) return body.message ?? `error ${body.code}`;
  if (body.status === "error" || body.status === "failure") return body.message ?? body.code ?? "failed";
  if (typeof body.status === "object" && Number(body.status?.code) >= 400) return body.data?.moreInfo ?? body.status.description ?? `error ${body.status.code}`;
  const rows = Array.isArray(body.data) ? body.data : [];
  if (rows.length && rows.every((r: any) => r?.status === "error")) return `${rows[0].code ?? "failed"}: ${rows[0].message ?? "failed"}`;
}

export const zohoClient = (name: string, base: string): Api => ({
  name,
  base,
  tokenHelp: `sign in to ${name} again`,
  auth: (key) => zohoAuth(key),
  url: zohoUrl,
  deadToken: (status, body) => (status === 401 && !scopeCode(body)) || deadCode(body),
  failed: (body) => zohoFailed(name, body),
});

// ponytail: per process, keyed by login; a new token each hour starts fresh, so a change can take up to the ten minutes to show
const LISTED_MS = 10 * 60_000;
const listed = new Map<string, { at: number; list: { id: string; label: string }[] }>();

// One of a login's organisations or mailboxes, as a call needs it: given, or the only one there is.
export async function pickOne(input: string | undefined, key: string, what: string, field: string, list: (key: string) => Promise<{ id: string; label: string }[]>) {
  if (input) return input;
  const cacheKey = `${what}:${key}`;
  let hit = listed.get(cacheKey);
  if (!hit || Date.now() - hit.at > LISTED_MS) {
    hit = { at: Date.now(), list: await list(key) };
    if (listed.size > 2000) listed.clear();
    listed.set(cacheKey, hit);
  }
  if (hit.list.length === 1) return hit.list[0]!.id;
  if (!hit.list.length) throw new AppsError(`this Zoho login has no ${what}`);
  throw new AppsError(`this Zoho login has several ${what}s; say which with ${field}: ${hit.list.map((o) => `${o.id} (${o.label})`).join(", ")}`);
}

// Makes `input` (an organisation or mailbox id most calls need) optional, filled in by pickOne. `shown` is the name people see.
export function autoFill(actions: Record<string, OwnAction>, o: { field: string; shown?: string; what: string; describe: string; applies?: (name: string) => boolean; list: (key: string) => Promise<{ id: string; label: string }[]> }) {
  const shown = o.shown ?? o.field;
  return Object.fromEntries(
    Object.entries(actions).map(([name, a]) => {
      if (!(o.applies?.(name) ?? o.field in a.input.shape)) return [name, a];
      const { [o.field]: _drop, ...shape } = a.input.shape;
      return [name, {
        ...a,
        input: z.object({ ...shape, [shown]: z.string().optional().describe(o.describe) }).loose(),
        run: async (i: Record<string, unknown>, key: string) => {
          const { [shown]: given, ...rest } = i;
          return a.run({ ...rest, [o.field]: await pickOne(given as string | undefined, key, o.what, shown, o.list) }, key);
        },
      } as OwnAction];
    }),
  );
}

export function zohoOAuth(name: string, scope: string): NonNullable<OwnApp["oauth"]> {
  const form = () => ({ client_id: process.env.ZOHO_CLIENT_ID!, client_secret: process.env.ZOHO_CLIENT_SECRET! });
  return {
    ready: () => Boolean(process.env.ZOHO_CLIENT_ID && process.env.ZOHO_CLIENT_SECRET && startDc()),
    authorizeUrl: (redirect, state) =>
      `${DCS[startDc()!]!.accounts}/oauth/v2/auth?${new URLSearchParams({ response_type: "code", client_id: process.env.ZOHO_CLIENT_ID!, redirect_uri: redirect, scope, state, access_type: "offline", prompt: "consent" })}`,
    async exchange(code, redirect, callback) {
      const dc = dcOf(callback.location);
      const t = await postToken(name, `${DCS[dc]!.accounts}/oauth/v2/token`, { grant_type: "authorization_code", code, redirect_uri: redirect, ...form() });
      return { ...t, token: `${dc}:${t.token}`, refreshToken: t.refreshToken && `${dc}:${t.refreshToken}` };
    },
    // Zoho keeps the refresh token and sends no new one
    async refresh(stored) {
      const { dc, token } = zohoSplit(stored);
      const entry = DCS[dc];
      if (!entry) throw new AppsError("this Zoho login is missing its data centre; reconnect it", true);
      const t = await postToken(name, `${entry.accounts}/oauth/v2/token`, { grant_type: "refresh_token", refresh_token: token, ...form() });
      return { token: `${dc}:${t.token}`, expiresIn: t.expiresIn };
    },
  };
}
