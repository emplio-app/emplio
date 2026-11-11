// The one Google sign-in behind Calendar, Docs, Sheets and Meet: each app asks for its own scopes, and only ones Google
// classes as sensitive or non-sensitive. Restricted scopes (Gmail, full Drive) would need a yearly security audit.
import type { OwnApp } from "./index";
import { codeFlow } from "./oauth";
import { type Api, call } from "./openapi";

const AUTH = "https://www.googleapis.com/auth/";
export const GOOGLE_SCOPES: Record<"googlecalendar" | "googledocs" | "googlesheets" | "googlemeet" | "googlebusiness", string[]> = {
  googlecalendar: [`${AUTH}calendar`],
  googledocs: [`${AUTH}documents`, `${AUTH}drive.file`],
  googlesheets: [`${AUTH}spreadsheets`, `${AUTH}drive.file`],
  googlemeet: [`${AUTH}meetings.space.created`, `${AUTH}meetings.space.readonly`, `${AUTH}meetings.space.settings`],
  // the one scope behind every Business Profile API; Google classes it sensitive, not restricted
  googlebusiness: [`${AUTH}business.manage`],
};

export const googleOAuth = (name: string, app: keyof typeof GOOGLE_SCOPES) =>
  codeFlow({
    name,
    idVar: "GOOGLE_CLIENT_ID",
    secretVar: "GOOGLE_CLIENT_SECRET",
    authorize: "https://accounts.google.com/o/oauth2/v2/auth",
    token: "https://oauth2.googleapis.com/token",
    scope: ["openid", "email", ...GOOGLE_SCOPES[app]].join(" "),
    params: { access_type: "offline", prompt: "consent", include_granted_scopes: "false" },
  });

export const googleApi = (name: string, base: string): Api => ({ name, base, tokenHelp: "connect it again in Integrations" });

const identity = googleApi("Google", "https://www.googleapis.com");
export const googleCheck: OwnApp["check"] = async (key) =>
  ((await call(identity, key, { method: "GET", path: "/oauth2/v3/userinfo", query: [], headers: [] }, {})) as { email?: string }).email;
