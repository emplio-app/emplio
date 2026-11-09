import { spyOn, afterEach, beforeEach, expect, test } from "bun:test";
import Fastify from "fastify";
import { createHmac } from "node:crypto";
import { automationRoutes } from "../../../automations";
import { AppFile, AppsError } from "../../types";
import { own, type Delivery, type WebhookEvent } from "../index";
import { signatureOk, triggers, wanted } from "./triggers";
import { zoom } from "./index";

const realFetch = globalThis.fetch;
const SECRET = "whsec";
const BACK = "https://api.test/connections/x/done";
type Sent = { url: string; method: string; headers: Record<string, string>; body: string };
const stub = (answer: (s: Sent) => Response) => {
  const sent: Sent[] = [];
  globalThis.fetch = (async (url: string | URL, init: RequestInit = {}) => {
    const s = { url: String(url), method: init.method ?? "GET", headers: (init.headers ?? {}) as Record<string, string>, body: String(init.body ?? "") };
    sent.push(s);
    return answer(s);
  }) as typeof fetch;
  return sent;
};
const failure = (p: Promise<unknown>): Promise<any> => p.catch((e) => e);
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

beforeEach(() => {
  process.env.ENCRYPTION_KEY ??= "test-key";
  process.env.ZOOM_CLIENT_ID = "zid";
  process.env.ZOOM_CLIENT_SECRET = "zsec";
  process.env.ZOOM_WEBHOOK_SECRET = SECRET;
});
afterEach(() => {
  globalThis.fetch = realFetch;
  for (const v of ["ZOOM_CLIENT_ID", "ZOOM_CLIENT_SECRET", "ZOOM_WEBHOOK_SECRET"]) delete process.env[v];
});

const signed = (body: string, stamp = Math.floor(Date.now() / 1000), secret = SECRET) => ({
  "x-zm-request-timestamp": String(stamp),
  "x-zm-signature": `v0=${createHmac("sha256", secret).update(`v0:${stamp}:${body}`).digest("hex")}`,
});
const delivery = (body: string, headers: Delivery["headers"] = signed(body)): Delivery => ({ body, headers, connection: "events", rest: "" });
const fired = async (event: string, object: object = {}) => {
  const got = await zoom.push!.receive!(delivery(JSON.stringify({ event, event_ts: 1, payload: { account_id: "A1", object: { host_id: "U1", ...object } } })), "");
  return (await got!.events())[0]!;
};

test("offered only where the OAuth app is set up, and never with a key", async () => {
  expect((await own.readyApps()).has("zoom")).toBe(true);
  expect(await own.getApp("zoom")).toMatchObject({ signIn: true, keyField: undefined });
  await expect(own.connectWithKey!("zoom", "k")).rejects.toThrow(/signing in/);
  delete process.env.ZOOM_CLIENT_SECRET;
  expect((await own.readyApps()).has("zoom")).toBe(false);
});

test("sign-in goes to Zoom without scopes, uses Basic auth, and labels the connection", async () => {
  const { externalId, url } = await own.startSignIn("zoom", "o", BACK);
  const page = new URL(url);
  expect(page.origin + page.pathname).toBe("https://zoom.us/oauth/authorize");
  expect(page.searchParams.has("scope")).toBe(false);
  expect(page.searchParams.get("redirect_uri")).toBe("https://api.test/oauth/zoom/callback");
  const state = page.searchParams.get("state")!;
  expect(own.readSignIn!("zoom", state)).toEqual({ externalId, back: BACK });
  expect(own.readSignIn!("zoom", `${state.split(".")[0]}.forged`)).toBeNull();
  expect(own.readSignIn!("github", state)).toBeNull();

  const sent = stub((s) => (s.url.endsWith("/oauth/token") ? json({ access_token: "a1", refresh_token: "r1", expires_in: 3600 }) : json({ display_name: "Asha", account_id: "A1" })));
  const done = await own.finishSignIn!("zoom", "code", BACK, {});
  expect(done).toMatchObject({ secret: "a1", refreshToken: "r1", label: "Asha" });
  expect(done.expiresAt!.getTime()).toBeGreaterThan(Date.now());
  expect(sent[0]!.headers.Authorization).toBe(`Basic ${Buffer.from("zid:zsec").toString("base64")}`);
  expect(sent[0]!.body).not.toContain("zsec");
  expect(sent[1]!.url).toBe("https://api.zoom.us/v2/users/me");
});

test("refresh rotates the token; a dead one means signing in again; an outage doesn't", async () => {
  const sent = stub(() => json({ access_token: "a2", refresh_token: "r2", expires_in: 3600 }));
  expect(await zoom.oauth!.refresh!("r1")).toEqual({ token: "a2", refreshToken: "r2", expiresIn: 3600 });
  expect(new URLSearchParams(sent[0]!.body).get("grant_type")).toBe("refresh_token");
  stub(() => json({ reason: "Invalid Token!", error: "invalid_request" }, 400));
  expect((await zoom.oauth!.refresh!("r1").catch((e) => e)).expired).toBe(true);
  stub(() => json({ reason: "Internal error", error: "server_error" }, 500));
  expect((await zoom.oauth!.refresh!("r1").catch((e) => e)).expired).toBe(false);
});

test("reads run unasked; writes and secrets ask", async () => {
  for (const name of ["list_meetings", "get_a_meeting", "list_all_recordings", "download_recording_file", "search_files"]) expect((await own.getAction(`zoom.${name}`))?.readOnly).toBe(true);
  for (const name of ["create_a_meeting", "update_a_meeting", "delete_a_meeting", "delete_recording_file", "get_user_s_zak", "get_meeting_s_token"]) expect((await own.getAction(`zoom.${name}`))?.readOnly).toBe(false);
});

test("Clips and uploads go to the right servers", async () => {
  const sent = stub(() => json({}));
  await zoom.actions.list_clips!.run({}, "t");
  expect(sent[0]!.url).toStartWith("https://api.zoom.us/v2/clips");
  const actions = (await Bun.file(new URL("./actions.json", import.meta.url)).json()).actions as { send: { path: string; base?: string } }[];
  expect(actions.find((a) => a.send.path === "/tasks/files")!.send.base).toBe("https://fileapi.zoom.us/v2");
});

test("a missing permission is explained, and doesn't sign the person out", async () => {
  stub(() => json({ code: 4711, message: "Invalid access token, does not contain scopes:[meeting:read:meeting, meeting:read:meeting:admin]." }, 401));
  const err = await failure(zoom.actions.get_a_meeting!.run({ meetingId: "1" }, "t"));
  expect(err).toBeInstanceOf(AppsError);
  expect(err.expired).toBe(false);
  expect(err.message).toContain("Connect Zoom again");
  expect(err.message).toContain("meeting:read:meeting");
  stub(() => json({ code: 4711, message: "Invalid access token, does not contain scopes:[report:read:admin]." }, 400));
  expect((await failure(zoom.actions.get_daily_usage_report!.run({}, "t"))).message).toContain("account admin");
  stub(() => json({ code: 124, message: "Invalid access token." }, 401));
  expect((await failure(zoom.actions.get_a_meeting!.run({ meetingId: "1" }, "t"))).expired).toBe(true);
});

test("a recording comes back as a file, with our login, only from Zoom", async () => {
  const sent = stub(() => new Response("VIDEO", { headers: { "content-type": "video/mp4" } }));
  const url = "https://us02web.zoom.us/rec/download/abc";
  const file = await zoom.actions.download_recording_file!.run({ download_url: url, file_name: "call.mp4" }, "tok");
  expect(file).toBeInstanceOf(AppFile);
  expect((file as AppFile).name).toBe("call.mp4");
  expect((file as AppFile).mimetype).toBe("video/mp4");
  expect(sent[0]!.headers.Authorization).toBe("Bearer tok");
  // a transcript is text, and still a file
  stub(() => new Response("WEBVTT", { headers: { "content-type": "text/vtt", "content-disposition": 'attachment; filename="talk.vtt"' } }));
  const vtt = (await zoom.actions.download_recording_file!.run({ download_url: url }, "tok")) as AppFile;
  expect(vtt).toBeInstanceOf(AppFile);
  expect(vtt.name).toBe("talk.vtt");
  // the sign-in page, not the file
  stub(() => new Response("<html>", { headers: { "content-type": "text/html" } }));
  await expect(zoom.actions.download_recording_file!.run({ download_url: url }, "tok")).rejects.toBeInstanceOf(AppsError);
  stub(() => new Response("x", { headers: { "content-type": "video/mp4", "content-length": String(200 * 1024 * 1024) } }));
  await expect(zoom.actions.download_recording_file!.run({ download_url: url }, "tok")).rejects.toThrow(/too big/);
  const none = stub(() => json({}));
  for (const bad of ["https://evil.test/rec", "https://zoom.us.evil.test/rec", "http://zoom.us/rec", "nonsense"]) await expect(zoom.actions.download_recording_file!.run({ download_url: bad }, "tok")).rejects.toBeInstanceOf(AppsError);
  expect(none).toHaveLength(0);
});

test("the signature must be right, recent, and made with our secret", () => {
  const body = '{"event":"meeting.created"}';
  expect(signatureOk(delivery(body))).toBe(true);
  expect(signatureOk(delivery(`${body} `, signed(body)))).toBe(false);
  expect(signatureOk(delivery(body, signed(body, Math.floor(Date.now() / 1000), "wrong")))).toBe(false);
  expect(signatureOk(delivery(body, signed(body, Math.floor(Date.now() / 1000) - 301)))).toBe(false);
  expect(signatureOk(delivery(body, { ...signed(body), "x-zm-signature": "v0=short" }))).toBe(false);
  expect(signatureOk(delivery(body, {}))).toBe(false);
  delete process.env.ZOOM_WEBHOOK_SECRET;
  expect(signatureOk(delivery(body))).toBe(false);
});

test("Zoom's address check gets its token back, and starts nothing", async () => {
  const body = JSON.stringify({ event: "endpoint.url_validation", payload: { plainToken: "plain" } });
  const got = await zoom.push!.receive!(delivery(body), "");
  expect(got!.reply).toEqual({ plainToken: "plain", encryptedToken: createHmac("sha256", SECRET).update("plain").digest("hex") });
  expect(await got!.events()).toEqual([]);
  expect(await zoom.push!.receive!(delivery(body, {}), "")).toBeNull();
});

test("the real route: one address for the whole app, refusing a forged delivery", async () => {
  const app = Fastify();
  await automationRoutes(app);
  await app.ready();
  const body = JSON.stringify({ event: "endpoint.url_validation", payload: { plainToken: "p" } });
  const post = (headers: Record<string, string>) => app.inject({ method: "POST", url: "/webhooks/app/zoom/events", headers: { "content-type": "application/json", ...headers }, payload: body });
  expect((await post({ "x-zm-signature": "v0=bad", "x-zm-request-timestamp": String(Math.floor(Date.now() / 1000)) })).statusCode).toBe(401);
  const ok = await post(signed(body));
  expect(ok.statusCode).toBe(200);
  expect(ok.json().plainToken).toBe("p");
  await app.close();
});

test("each event starts only its own triggers, for its own account", async () => {
  const expected: Record<string, string[]> = {
    "meeting.created": ["new_meeting_created_trigger"],
    "meeting.updated": ["meeting_details_changed_trigger"],
    "meeting.participant_joined": ["new_meeting_participant_trigger"],
    "recording.completed": ["new_cloud_recording_trigger"],
    "recording.renamed": ["meeting_recording_changed_trigger", "recording_renamed"],
    "recording.transcript_completed": ["meeting_recording_changed_trigger", "recording_transcript_completed"],
    "meeting.summary_completed": ["meeting_summary_updated_trigger", "meeting_summary_completed"],
    "meeting.summary_updated": ["meeting_summary_updated_trigger", "meeting_summary_updated"],
    "webinar.created": ["new_webinar_created_trigger"],
    "webinar.updated": ["webinar_details_changed_trigger"],
    "webinar.participant_joined": ["new_webinar_participant_trigger"],
    "user.updated": ["user_information_changed_trigger"],
    "meeting.ended": ["meeting_ended"],
    "team_chat.channel_message_posted": ["team_chat_channel_message_posted"],
    "made.up": [],
  };
  for (const [event, names] of Object.entries(expected)) {
    const out: WebhookEvent = await fired(event);
    expect(out.triggers).toEqual(names);
    expect(out.watch).toBe("zoom:U1");
    for (const n of names) expect(triggers[n]).toBeDefined();
  }
  expect(triggers.meeting_created).toBeUndefined();
  expect(zoom.push!.appWide).toBe(true);
});

test("a retry is the same delivery, and download tokens don't reach the automation", async () => {
  const body = JSON.stringify({ event: "recording.completed", event_ts: 5, download_token: "secret", payload: { account_id: "A1", object: { id: 1, download_token: "secret" } } });
  const first = (await (await zoom.push!.receive!(delivery(body, signed(body, Math.floor(Date.now() / 1000))), ""))!.events())[0]!;
  const retry = (await (await zoom.push!.receive!(delivery(body, signed(body, Math.floor(Date.now() / 1000) - 60)), ""))!.events())[0]!;
  expect(first.id).toBe(retry.id!);
  expect(first.id).toBeTruthy();
  expect(JSON.stringify(first.data)).not.toContain("secret");
  const other = await fired("recording.completed", { id: 2 });
  expect(other.id).not.toBe(first.id);
});

test("an event with no account starts nothing", async () => {
  const body = JSON.stringify({ event: "meeting.created", event_ts: 1, payload: { object: {} } });
  expect((await (await zoom.push!.receive!(delivery(body), ""))!.events())[0]!.triggers).toEqual([]);
});

test("watching asks whose account it is, and needs the webhook secret", async () => {
  const sent = stub(() => json({ id: "U1", account_id: "A1", display_name: "Asha" }));
  expect(await own.startPush!("zoom.new_meeting_created_trigger", { externalId: "c1", secret: "tok" }, {})).toBe("zoom:U1");
  expect(sent[0]!.url).toBe("https://api.zoom.us/v2/users/me");
  expect(await own.startPush!("zoom.team_chat_channel_message_posted", { externalId: "c1", secret: "tok" }, {})).toBe("zoom:U1");
  expect(await own.startPush!("zoom.made_up", { externalId: "c1", secret: "tok" }, {})).toBeNull();
  delete process.env.ZOOM_WEBHOOK_SECRET;
  await expect(own.startPush!("zoom.new_meeting_created_trigger", { externalId: "c1", secret: "tok" }, {})).rejects.toThrow(/ZOOM_WEBHOOK_SECRET/);
});

test("filters: one meeting, one host", () => {
  const meeting = { payload: { object: { id: 123456789, uuid: "u==", host_id: "H1", host_email: "Asha@Acme.com" } } };
  const summary = { payload: { object: { meeting_id: 555, meeting_uuid: "s==", meeting_host_id: "H2", meeting_host_email: "b@acme.com" } } };
  expect(wanted({}, meeting)).toBe(true);
  expect(wanted(null, meeting)).toBe(true);
  expect(wanted({ meeting_id: "123 456 789" }, meeting)).toBe(true);
  expect(wanted({ meeting_id: 123456789 }, meeting)).toBe(true);
  expect(wanted({ meeting_id: "u==" }, meeting)).toBe(true);
  expect(wanted({ meeting_id: "999" }, meeting)).toBe(false);
  expect(wanted({ host: "asha@acme.com" }, meeting)).toBe(true);
  expect(wanted({ host: "H1" }, meeting)).toBe(true);
  expect(wanted({ host: "someone@else.com" }, meeting)).toBe(false);
  expect(wanted({ meeting_id: "555", host: "b@acme.com" }, summary)).toBe(true);
  expect(wanted({ meeting_id: "1" }, { payload: {} })).toBe(false);
  expect(triggers.new_meeting_created_trigger!.config.map((c) => c.name)).toEqual(["meeting_id", "host"]);
  expect(triggers.user_information_changed_trigger!.config).toEqual([]);
});

test("an event goes to the person it belongs to, never the whole Zoom account", async () => {
  const send = async (event: string, payload: Record<string, unknown>) => (await (await zoom.push!.receive!(delivery(JSON.stringify({ event, event_ts: 1, payload })), ""))!.events())[0]!;
  expect((await send("meeting.created", { account_id: "A1", object: { host_id: "H9" } })).watch).toBe("zoom:H9");
  expect((await send("user.updated", { account_id: "A1", object: { id: "U7" } })).watch).toBe("zoom:U7");
  expect((await send("meeting.created", { account_id: "A1", object: {} })).triggers).toEqual([]);
});

test("a sign-in only finishes in the browser that started it, since Zoom can skip its consent screen", async () => {
  process.env.ZOOM_CLIENT_ID = "id";
  process.env.ZOOM_CLIENT_SECRET = "shh";
  const { default: Fastify } = await import("fastify");
  const { integrationRoutes, startedHere } = await import("../..");
  const { db } = await import("../../../db");
  expect(startedHere("a=1; oauth_c1=1", "c1")).toBe(true);
  expect(startedHere("oauth_c2=1", "c1")).toBe(false);
  expect(startedHere(undefined, "c1")).toBe(false);

  const { url } = await own.startSignIn("zoom", "o", "https://api.test/connections/c1/done");
  const state = new URL(url).searchParams.get("state")!;
  const find = spyOn(db.query.connections, "findFirst").mockResolvedValue({ id: "c1", app: "zoom", secret: null } as never);
  const sent = stub(() => json({ access_token: "a" }));
  const app = Fastify();
  await integrationRoutes(app);
  try {
    const res = await app.inject({ method: "GET", url: `/oauth/zoom/callback?code=x&state=${encodeURIComponent(state)}` });
    expect(res.body).toContain("started somewhere else");
    expect(sent).toHaveLength(0);
  } finally {
    find.mockRestore();
    await app.close();
    delete process.env.ZOOM_CLIENT_ID;
    delete process.env.ZOOM_CLIENT_SECRET;
  }
});
