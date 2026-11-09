import { afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { createHmac, randomBytes } from "node:crypto";
import Fastify from "fastify";
import { automationRoutes } from "../../../automations";
import { AppFile, AppsError } from "../../types";
import { own } from "../index";
import { slack } from "./index";
import { wanted } from "./triggers";

const realFetch = globalThis.fetch;
beforeAll(() => {
  process.env.ENCRYPTION_KEY = randomBytes(32).toString("base64");
});
beforeEach(() => {
  process.env.SLACK_CLIENT_ID = "cid";
  process.env.SLACK_CLIENT_SECRET = "csec";
  process.env.SLACK_SIGNING_SECRET = "sign";
});
afterEach(() => {
  globalThis.fetch = realFetch;
  for (const v of ["SLACK_CLIENT_ID", "SLACK_CLIENT_SECRET", "SLACK_SIGNING_SECRET"]) delete process.env[v];
});

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
type Call = { url: string; body: string; headers: Record<string, string>; raw: unknown };
const stub = (answer: (c: Call) => Response) => {
  const calls: Call[] = [];
  globalThis.fetch = (async (url: string, init: RequestInit = {}) => {
    const c = { url: String(url), body: String(init.body ?? ""), headers: (init.headers ?? {}) as Record<string, string>, raw: init.body };
    calls.push(c);
    return answer(c);
  }) as typeof fetch;
  return calls;
};
const form = (c: Call) => Object.fromEntries(new URLSearchParams(c.body));
const login = { externalId: "c1", secret: "xoxb-bot|xoxp-user" };
const botOnly = { externalId: "c1", secret: "xoxb-bot|" };

test("isn't offered without the client id and secret", async () => {
  expect((await own.readyApps()).has("slack")).toBe(true);
  expect(await own.getApp("slack")).toMatchObject({ signIn: true, keyField: undefined });
  delete process.env.SLACK_CLIENT_SECRET;
  expect((await own.readyApps()).has("slack")).toBe(false);
});

test("sign-in asks for bot and user scopes, and stores both tokens", async () => {
  const back = "https://api.test/apps";
  const { url } = await own.startSignIn!("slack", "owner", back);
  const page = new URL(url);
  expect(page.origin + page.pathname).toBe("https://slack.com/oauth/v2/authorize");
  expect(page.searchParams.get("redirect_uri")).toBe("https://api.test/oauth/slack/callback");
  expect(page.searchParams.get("scope")).toContain("chat:write");
  expect(page.searchParams.get("user_scope")).toContain("search:read");
  expect(own.readSignIn!("slack", page.searchParams.get("state")!)).toMatchObject({ back });

  const calls = stub((c) => (c.url.endsWith("oauth.v2.access") ? json({ ok: true, access_token: "xoxb-1", authed_user: { access_token: "xoxp-1" }, team: { id: "T1", name: "Acme" } }) : json({ ok: true, team: "Acme", team_id: "T1" })));
  const done = await own.finishSignIn!("slack", "code1", back, {});
  expect(done).toMatchObject({ secret: "xoxb-1|xoxp-1", label: "Acme" });
  expect(form(calls[0]!)).toEqual({ client_id: "cid", client_secret: "csec", code: "code1", redirect_uri: "https://api.test/oauth/slack/callback" });
  expect(calls[1]!.headers.Authorization).toBe("Bearer xoxb-1");
});

test("a forged state is refused, and a failed sign-in says so", async () => {
  expect(own.readSignIn!("slack", "e30.notasignature")).toBeNull();
  stub(() => json({ ok: false, error: "bad_redirect_uri" }));
  await expect(own.finishSignIn!("slack", "c", "https://api.test/x", {})).rejects.toThrow(/bad_redirect_uri/);
});

test("a person's sign-in without a user token still connects", async () => {
  stub((c) => (c.url.endsWith("oauth.v2.access") ? json({ ok: true, access_token: "xoxb-1" }) : json({ ok: true, team: "Acme" })));
  expect((await own.finishSignIn!("slack", "c", "https://api.test/x", {})).secret).toBe("xoxb-1|");
});

test("posts use the bot token; search uses the person's", async () => {
  const calls = stub(() => json({ ok: true }));
  await own.run("slack.send_message", { channel: "C1", text: "hi", blocks: [{ type: "section" }] }, login, "o");
  expect(calls[0]!.url).toBe("https://slack.com/api/chat.postMessage");
  expect(calls[0]!.headers.Authorization).toBe("Bearer xoxb-bot");
  expect(form(calls[0]!)).toEqual({ channel: "C1", text: "hi", blocks: '[{"type":"section"}]' });
  await own.run("slack.search_messages", { query: "invoice" }, login, "o");
  expect(calls[1]!.url).toBe("https://slack.com/api/search.messages");
  expect(calls[1]!.headers.Authorization).toBe("Bearer xoxp-user");
});

test("a user-only action says so plainly when there's no user token", async () => {
  const calls = stub(() => json({ ok: true }));
  await expect(own.run("slack.search_messages", { query: "x" }, botOnly, "o")).rejects.toThrow(/connect Slack again and allow it/);
  expect(calls).toHaveLength(0);
});

test("ok:false with a 200 is a failure, in words; a missing permission names it", async () => {
  stub(() => json({ ok: false, error: "channel_not_found" }));
  const lost = await own.run("slack.send_message", { channel: "C9", text: "x" }, login, "o").catch((e) => e as AppsError) as AppsError;
  expect(lost).toBeInstanceOf(AppsError);
  expect(lost.expired).toBe(false);
  expect(lost.message).toContain("channel_not_found");
  stub(() => json({ ok: false, error: "missing_scope", needed: "chat:write" }));
  await expect(own.run("slack.send_message", { channel: "C9", text: "x" }, login, "o")).rejects.toThrow(/chat:write/);
  stub(() => json({ ok: false, error: "not_in_channel" }));
  await expect(own.run("slack.fetch_conversation_history", { channel: "C9" }, login, "o")).rejects.toThrow(/invite it/);
});

test("a dead token marks the connection expired", async () => {
  for (const error of ["invalid_auth", "token_revoked", "account_inactive", "token_expired"]) {
    stub(() => json({ ok: false, error }));
    const dead = await own.run("slack.list_all_channels", {}, login, "o").catch((e) => e as AppsError) as AppsError;
    expect(dead).toBeInstanceOf(AppsError);
    expect(dead.expired).toBe(true);
  }
});

test("reads run unasked, writes ask", async () => {
  for (const read of ["list_all_channels", "fetch_conversation_history", "retrieve_conversation_information", "search_messages", "test_auth", "download_slack_file", "find_users"]) expect((await own.getAction(`slack.${read}`))?.readOnly).toBe(true);
  for (const write of ["send_message", "updates_a_slack_message", "delete_file", "archive_conversation", "reserve_file_upload", "upload_or_create_a_file_in_slack", "leave_conversation"]) expect((await own.getAction(`slack.${write}`))?.readOnly).toBeFalsy();
});

test("every action has a described input, and history warns about Slack's limit", async () => {
  expect((await own.getAction("slack.fetch_conversation_history"))?.description).toContain("1 call a minute");
  expect((await own.getAction("slack.fetch_message_thread_from_a_conversation"))?.description).toContain("15 messages");
  for (const { action } of await own.listActions("slack")) for (const f of (await own.getAction(action))!.input) expect(`${action}.${f.name}: ${f.description}`).not.toEndWith(": ");
});

test("a file comes back as a file, fetched with the bot's token", async () => {
  const calls = stub((c) => (c.url.includes("files.info") ? json({ ok: true, file: { name: "a.pdf", mimetype: "application/pdf", url_private_download: "https://files.slack.com/a.pdf" } }) : new Response(new Uint8Array([1, 2]), { headers: { "content-type": "application/pdf" } })));
  const file = (await own.run("slack.download_slack_file", { file: "F1" }, login, "o")) as AppFile;
  expect(file).toBeInstanceOf(AppFile);
  expect(file.name).toBe("a.pdf");
  expect(calls[1]!.headers.Authorization).toBe("Bearer xoxb-bot");
});

test("a sign-in page instead of the file is an error, not a file", async () => {
  stub((c) => (c.url.includes("files.info") ? json({ ok: true, file: { name: "a", mimetype: "x", url_private: "https://files.slack.com/a" } }) : new Response("<html>", { headers: { "content-type": "text/html" } })));
  await expect(own.run("slack.download_slack_file", { file: "F1" }, login, "o")).rejects.toThrow(/wouldn't hand over/);
});

test("an upload reserves, sends the bytes, then shares", async () => {
  const calls = stub((c) => (c.url.includes("getUploadURLExternal") ? json({ ok: true, upload_url: "https://files.slack.com/up/1", file_id: "F1" }) : c.url.includes("/up/") ? new Response("OK") : json({ ok: true, files: [{ id: "F1" }] })));
  await own.run("slack.upload_or_create_a_file_in_slack", { file: new AppFile("a.txt", "text/plain", new Uint8Array([104, 105])), channel_id: "C1" }, login, "o");
  expect(form(calls[0]!)).toEqual({ filename: "a.txt", length: "2" });
  expect(calls[1]!.url).toBe("https://files.slack.com/up/1");
  expect(form(calls[2]!)).toEqual({ files: '[{"id":"F1","title":"a.txt"}]', channel_id: "C1" });
});

test("a photo goes as multipart", async () => {
  const calls = stub(() => json({ ok: true }));
  await own.run("slack.set_profile_photo", { image: new AppFile("me.png", "image/png", new Uint8Array([1])) }, login, "o");
  expect(calls[0]!.raw).toBeInstanceOf(FormData);
  expect(calls[0]!.headers.Authorization).toBe("Bearer xoxp-user");
});

test("find_channels pages through the list and matches words", async () => {
  const calls = stub((c) => (form(c).cursor ? json({ ok: true, channels: [{ id: "C2", name: "sales-india" }], response_metadata: { next_cursor: "" } }) : json({ ok: true, channels: [{ id: "C1", name: "general" }], response_metadata: { next_cursor: "n" } })));
  expect(await own.run("slack.find_channels", { query: "SALES" }, login, "o")).toEqual({ channels: [{ id: "C2", name: "sales-india" }] });
  expect(calls).toHaveLength(2);
});

test("an automation starts on the workspace, and can't without the signing secret", async () => {
  const calls = stub(() => json({ ok: true, team_id: "T1" }));
  expect(await own.startPush!("slack.receive_message", login, {})).toBe("slack:T1");
  expect(calls[0]!.url).toBe("https://slack.com/api/auth.test");
  delete process.env.SLACK_SIGNING_SECRET;
  await expect(own.startPush!("slack.receive_message", login, {})).rejects.toThrow(/SLACK_SIGNING_SECRET/);
});

const signed = (body: string, ts = Math.floor(Date.now() / 1000), secret = "sign") => ({
  body,
  connection: "events",
  rest: "",
  headers: { "x-slack-request-timestamp": String(ts), "x-slack-signature": `v0=${createHmac("sha256", secret).update(`v0:${ts}:${body}`).digest("hex")}` },
});
const receive = slack.push!.receive!;
const envelope = (event: object, extra: object = {}) => JSON.stringify({ type: "event_callback", event_id: "Ev1", team_id: "T1", api_app_id: "A1", authorizations: [{ user_id: "UBOT", is_bot: true }], event, ...extra });
const eventsOf = async (event: object, extra?: object) => (await (await receive(signed(envelope(event, extra)), ""))!.events())[0];

test("a good signature passes; a bad or old one doesn't", async () => {
  const body = envelope({ type: "message", channel_type: "channel" });
  expect(await receive(signed(body), "")).not.toBeNull();
  expect(await receive(signed(body, undefined, "wrong"), "")).toBeNull();
  expect(await receive(signed(body, Math.floor(Date.now() / 1000) - 301), "")).toBeNull();
  expect(await receive({ body, connection: "events", rest: "", headers: {} }, "")).toBeNull();
  const tampered = signed(body);
  expect(await receive({ ...tampered, body: `${body} ` }, "")).toBeNull();
  delete process.env.SLACK_SIGNING_SECRET;
  expect(await receive(signed(body), "")).toBeNull();
});

test("the URL check gets its challenge back", async () => {
  const got = await receive(signed(JSON.stringify({ type: "url_verification", challenge: "abc" })), "");
  expect(got!.reply).toEqual({ challenge: "abc" });
  expect(await got!.events()).toEqual([]);
});

const human = { type: "message", user: "U1", text: "hello", ts: "1.1", channel: "C1", channel_type: "channel", blocks: [{}], client_msg_id: "x" };

test("each event starts only the right triggers, with clutter gone", async () => {
  const room = await eventsOf(human);
  expect(room).toMatchObject({ id: "Ev1", watch: "slack:T1", triggers: ["receive_message", "channel_message_received"] });
  expect(room!.data).toMatchObject({ channel: "C1", user: "U1", text: "hello", team_id: "T1" });
  expect(room!.data).not.toHaveProperty("blocks");
  expect(room!.data).not.toHaveProperty("client_msg_id");

  expect((await eventsOf({ ...human, channel_type: "mpim" }))!.triggers).toEqual(["receive_message", "channel_message_received"]);
  expect((await eventsOf({ ...human, channel_type: "im" }))!.triggers).toEqual(["receive_message", "direct_message_received"]);
  expect((await eventsOf({ ...human, user: undefined, bot_id: "B9", subtype: "bot_message" }))!.triggers).toEqual(["receive_bot_message"]);
  expect((await eventsOf({ ...human, subtype: "file_share", files: [{ id: "F1", name: "a", extra: 1 }] }))!.data).toMatchObject({ files: [{ id: "F1", name: "a" }] });

  expect((await eventsOf({ type: "channel_created", channel: { id: "C2", name: "new", creator: "U1", created: 5 } }))).toMatchObject({ triggers: ["channel_created"], data: { channel: "C2", name: "new", user: "U1" } });
  const added = await eventsOf({ type: "reaction_added", user: "U1", reaction: "tada", item_user: "U2", item: { type: "message", channel: "C1", ts: "1.1" } });
  expect(added!.triggers).toEqual(["message_reaction_added", "reaction_added"]);
  expect(added!.data).toMatchObject({ reaction: "tada", channel: "C1", user: "U1" });
  expect((await eventsOf({ type: "reaction_removed", user: "U1", reaction: "tada", item: { type: "message", channel: "C1", ts: "1" } }))!.triggers).toEqual(["message_reaction_removed", "reaction_removed"]);
});

test("edits, joins, Emplio's own posts and other events start nothing", async () => {
  expect(await eventsOf({ ...human, subtype: "message_changed" })).toBeUndefined();
  expect(await eventsOf({ ...human, subtype: "channel_join" })).toBeUndefined();
  expect(await eventsOf({ ...human, bot_id: "B1", app_id: "A1" })).toBeUndefined();
  expect(await eventsOf({ ...human, user: "UBOT" })).toBeUndefined();
  expect(await eventsOf({ type: "reaction_added", user: "UBOT", reaction: "eyes", item: {} })).toBeUndefined();
  expect(await eventsOf({ type: "team_join", user: {} })).toBeUndefined();
  expect((await (await receive(signed(JSON.stringify({ type: "app_rate_limited" })), ""))!.events())).toEqual([]);
});

test("another app's bot still counts", async () => {
  expect((await eventsOf({ ...human, user: undefined, bot_id: "B2", app_id: "A2", subtype: "bot_message" }))!.triggers).toEqual(["receive_bot_message"]);
});

test("the channel and user settings narrow what runs", () => {
  const data = { channel: "C1", user: "U1" };
  expect(wanted({}, data)).toBe(true);
  expect(wanted(null, data)).toBe(true);
  expect(wanted({ channel: "C1" }, data)).toBe(true);
  expect(wanted({ channel: "C2" }, data)).toBe(false);
  expect(wanted({ user: "U2" }, data)).toBe(false);
  expect(wanted({ channel: "C1", user: "U1" }, data)).toBe(true);
});

test("the real route: bad signature is 401, the URL check answers, no connection needed", async () => {
  const app = Fastify();
  await automationRoutes(app);
  const post = (payload: string, headers: Record<string, string>) => app.inject({ method: "POST", url: "/webhooks/app/slack/events", headers: { "content-type": "application/json", ...headers }, payload });
  try {
    expect((await post("{}", {})).statusCode).toBe(401);
    const body = JSON.stringify({ type: "url_verification", challenge: "abc" });
    const res = await post(body, signed(body).headers);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ challenge: "abc" });
  } finally {
    await app.close();
  }
});
