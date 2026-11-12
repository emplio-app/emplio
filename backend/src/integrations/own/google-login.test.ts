import { afterEach, beforeEach, expect, test } from "bun:test";
import { GOOGLE_SCOPES } from "./google-login";
import { APPS, own } from "./index";

const realFetch = globalThis.fetch;
const BACK = "https://api.test/settings";
const AUTH = "https://www.googleapis.com/auth/";
// restricted per each API's scopes page, checked 2026-11-09
const RESTRICTED = [`${AUTH}drive`, `${AUTH}drive.readonly`, `${AUTH}drive.metadata`, `${AUTH}drive.metadata.readonly`, `${AUTH}drive.activity`, `${AUTH}drive.activity.readonly`, `${AUTH}drive.scripts`, `${AUTH}drive.meet.readonly`, "https://mail.google.com/"];
const EXPECTED: Record<keyof typeof GOOGLE_SCOPES, string[]> = {
  googlecalendar: [`${AUTH}calendar.events`, `${AUTH}calendar.readonly`],
  googledocs: [`${AUTH}documents`, `${AUTH}drive.file`],
  googlesheets: [`${AUTH}spreadsheets`, `${AUTH}drive.file`],
  googlemeet: [`${AUTH}meetings.space.created`, `${AUTH}meetings.space.readonly`, `${AUTH}meetings.space.settings`],
  googlebusiness: [`${AUTH}business.manage`],
  googlesearchconsole: [`${AUTH}webmasters`],
  googleanalytics: [`${AUTH}analytics.readonly`, `${AUTH}analytics.edit`, `${AUTH}analytics.manage.users`],
};

beforeEach(() => {
  process.env.GOOGLE_CLIENT_ID = "gid";
  process.env.GOOGLE_CLIENT_SECRET = "gsec";
  process.env.ENCRYPTION_KEY ??= "test-key-for-state-signing-only!!";
});
afterEach(() => {
  globalThis.fetch = realFetch;
  delete process.env.GOOGLE_CLIENT_ID;
  delete process.env.GOOGLE_CLIENT_SECRET;
});

const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });

test("no app asks for a restricted scope", () => {
  for (const [app, scopes] of Object.entries(GOOGLE_SCOPES)) {
    expect(scopes, app).toEqual(EXPECTED[app as keyof typeof GOOGLE_SCOPES]);
    for (const s of scopes) expect(RESTRICTED, `${app} asks for ${s}`).not.toContain(s);
  }
});

for (const app of Object.keys(EXPECTED) as (keyof typeof EXPECTED)[]) {
  test(`${app}: signs in for offline access with exactly its scopes, plus openid and email`, async () => {
    const { url } = await own.startSignIn!(app, "o", BACK);
    const page = new URL(url);
    expect(page.origin + page.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    const q = Object.fromEntries(page.searchParams);
    expect(q).toMatchObject({ response_type: "code", client_id: "gid", redirect_uri: `https://api.test/oauth/${app}/callback`, access_type: "offline", prompt: "consent", include_granted_scopes: "false" });
    expect(q.scope!.split(" ").sort()).toEqual(["openid", "email", ...EXPECTED[app]].sort());
    for (const r of RESTRICTED) expect(q.scope).not.toContain(r === `${AUTH}drive` ? `${r} ` : r);

    const seen: { url: string; form?: URLSearchParams }[] = [];
    globalThis.fetch = (async (u: string, init: RequestInit) => {
      seen.push({ url: String(u), form: init.body ? new URLSearchParams(String(init.body)) : undefined });
      return String(u).includes("oauth2.googleapis.com") ? json({ access_token: "a1", refresh_token: "r1", expires_in: 3599 }) : json({ email: "owner@acme.co" });
    }) as typeof fetch;
    const done = await own.finishSignIn!(app, "code1", BACK);
    expect(done).toMatchObject({ secret: "a1", refreshToken: "r1", label: "owner@acme.co" });
    expect(done.expiresAt!.getTime()).toBeGreaterThan(Date.now() + 3_500_000);
    expect(seen[0]!.form!.get("code")).toBe("code1");
    expect(seen[0]!.form!.get("client_secret")).toBe("gsec");
    expect(seen[1]!.url).toBe("https://www.googleapis.com/oauth2/v3/userinfo");
  });

  test(`${app}: a forged or foreign state is refused`, async () => {
    const { url } = await own.startSignIn!(app, "o", BACK);
    const state = new URL(url).searchParams.get("state")!;
    expect(own.readSignIn!(app, state)).toMatchObject({ back: BACK });
    expect(own.readSignIn!(app === "googledocs" ? "googlesheets" : "googledocs", state)).toBeNull();
    expect(own.readSignIn!(app, `${state.split(".")[0]}.forged`)).toBeNull();
  });

  test(`${app}: an expired login is renewed with the refresh token, and keeps it`, async () => {
    const forms: URLSearchParams[] = [];
    globalThis.fetch = (async (_u: string, init: RequestInit) => {
      forms.push(new URLSearchParams(String(init.body)));
      return json({ access_token: "a2", expires_in: 3599 });
    }) as typeof fetch;
    const t = await APPS[app]!.oauth!.refresh!("r1");
    expect(t).toEqual({ token: "a2", refreshToken: undefined, expiresIn: 3599 });
    expect(Object.fromEntries(forms[0]!)).toMatchObject({ grant_type: "refresh_token", refresh_token: "r1", client_id: "gid", client_secret: "gsec" });
  });

  test(`${app}: not offered without the client id and secret`, async () => {
    expect((await own.readyApps()).has(app)).toBe(true);
    delete process.env.GOOGLE_CLIENT_SECRET;
    expect((await own.readyApps()).has(app)).toBe(false);
    expect(await own.getApp(app)).toMatchObject({ keyField: undefined });
    await expect(own.startSignIn!(app, "o", BACK)).rejects.toThrow();
  });
}

test("disconnecting a Google app revokes Emplio's access at Google", async () => {
  const sent: string[] = [];
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    sent.push(`${url} ${init?.body}`);
    return new Response(null, { status: sent.length === 1 ? 200 : 400 });
  }) as typeof fetch;
  for (const app of Object.keys(GOOGLE_SCOPES)) expect(APPS[app]!.oauth!.revoke, app).toBeFunction();
  await APPS.googlecalendar!.oauth!.revoke!("refresh-1");
  // already revoked in Google's own settings: not an error
  await APPS.googledocs!.oauth!.revoke!("refresh-2");
  expect(sent).toEqual(["https://oauth2.googleapis.com/revoke token=refresh-1", "https://oauth2.googleapis.com/revoke token=refresh-2"]);
});
