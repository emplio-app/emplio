// The usual OAuth code flow, for an app's `oauth` field: its client id and secret from the environment, a code for a
// login that runs out, and a refresh token for the next one. Apps that differ write their own (Slack, Zoho).
import { AppsError } from "../types";
import type { OAuthTokens, OwnApp } from "./index";

export type TokenAnswer = { access_token?: string; refresh_token?: string; expires_in?: number | string; error?: string; error_description?: string; reason?: string };

export const tokensFrom = (name: string, out: TokenAnswer | null): OAuthTokens => {
  if (!out?.access_token) throw new AppsError(out?.error_description ?? out?.reason ?? out?.error ?? `${name} didn't finish the sign-in. Try again.`, out?.error === "invalid_grant");
  return { token: out.access_token, refreshToken: out.refresh_token, expiresIn: out.expires_in ? Number(out.expires_in) : undefined };
};

export async function postToken(name: string, url: string, form: Record<string, string>, headers: Record<string, string> = {}) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json", ...headers },
    body: new URLSearchParams(form).toString(),
    signal: AbortSignal.timeout(30_000),
  });
  return tokensFrom(name, (await res.json().catch(() => null)) as TokenAnswer | null);
}

export function codeFlow(o: {
  name: string;
  // the environment variables holding the client id and secret
  idVar: string;
  secretVar: string;
  authorize: string;
  token: string;
  // left out where the app takes its scopes from its developer settings (Zoom)
  scope?: string;
  // more query on the sign-in page
  params?: Record<string, string>;
  // send the client's id and secret as HTTP Basic, not in the form
  basic?: boolean;
}): NonNullable<OwnApp["oauth"]> {
  const client = () => {
    const id = process.env[o.idVar]!;
    const secret = process.env[o.secretVar]!;
    const form: Record<string, string> = o.basic ? {} : { client_id: id, client_secret: secret };
    const headers: Record<string, string> = o.basic ? { Authorization: `Basic ${Buffer.from(`${id}:${secret}`).toString("base64")}` } : {};
    return { form, headers };
  };
  return {
    ready: () => Boolean(process.env[o.idVar] && process.env[o.secretVar]),
    authorizeUrl: (redirect, state) =>
      `${o.authorize}?${new URLSearchParams({ response_type: "code", client_id: process.env[o.idVar]!, redirect_uri: redirect, state, ...(o.scope && { scope: o.scope }), ...o.params })}`,
    exchange: (code, redirect) => {
      const c = client();
      return postToken(o.name, o.token, { grant_type: "authorization_code", code, redirect_uri: redirect, ...c.form }, c.headers);
    },
    refresh: (refreshToken) => {
      const c = client();
      return postToken(o.name, o.token, { grant_type: "refresh_token", refresh_token: refreshToken, ...c.form }, c.headers);
    },
  };
}
