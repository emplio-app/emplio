// The one Google sign-in behind Calendar, Docs, Sheets, Meet, Search Console, Analytics and Business Profile: each app
// asks for its own scopes, and only ones Google
// classes as sensitive or non-sensitive. Restricted scopes (Gmail, full Drive) would need a yearly security audit.
import type { OwnApp } from "./index";
import { codeFlow } from "./oauth";
import { type Api, call } from "./openapi";

const AUTH = "https://www.googleapis.com/auth/";
export const GOOGLE_SCOPES: Record<"googlecalendar" | "googledocs" | "googlesheets" | "googlemeet" | "googlesearchconsole" | "googleanalytics" | "googlebusiness", string[]> = {
  googlecalendar: [`${AUTH}calendar.events`, `${AUTH}calendar.readonly`],
  googledocs: [`${AUTH}documents`, `${AUTH}drive.file`],
  googlesheets: [`${AUTH}spreadsheets`, `${AUTH}drive.file`],
  googlemeet: [`${AUTH}meetings.space.created`, `${AUTH}meetings.space.readonly`, `${AUTH}meetings.space.settings`],
  // the one scope behind every Business Profile API; Google classes it sensitive, not restricted
  googlebusiness: [`${AUTH}business.manage`],
  googlesearchconsole: [`${AUTH}webmasters`],
  googleanalytics: [`${AUTH}analytics.readonly`, `${AUTH}analytics.edit`, `${AUTH}analytics.manage.users`],
};

export const googleOAuth = (name: string, app: keyof typeof GOOGLE_SCOPES) => ({
  ...codeFlow({
    name,
    idVar: "GOOGLE_CLIENT_ID",
    secretVar: "GOOGLE_CLIENT_SECRET",
    authorize: "https://accounts.google.com/o/oauth2/v2/auth",
    token: "https://oauth2.googleapis.com/token",
    scope: ["openid", "email", ...GOOGLE_SCOPES[app]].join(" "),
    params: { access_type: "offline", prompt: "consent", include_granted_scopes: "false" },
  }),
  // a refresh token's revoke ends the whole grant at Google; it then leaves Emplio's entry in the person's Google account
  async revoke(token: string) {
    const res = await fetch("https://oauth2.googleapis.com/revoke", { method: "POST", body: new URLSearchParams({ token }), signal: AbortSignal.timeout(10_000) });
    // 400 invalid_token: already gone (revoked in Google's settings, or expired)
    if (!res.ok && res.status !== 400) throw new Error(`Google revoke failed: ${res.status}`);
  },
});

export const googleApi = (name: string, base: string): Api => ({ name, base, tokenHelp: "connect it again in Integrations" });

const identity = googleApi("Google", "https://www.googleapis.com");
export const googleCheck: OwnApp["check"] = async (key) =>
  ((await call(identity, key, { method: "GET", path: "/oauth2/v3/userinfo", query: [], headers: [] }, {})) as { email?: string }).email;
