// Notifications: the one place that decides where an event the person should hear about goes (pushTo). Inside Emplio
// when they're looking at it (a tab, the Mac app's window or the phone app in front of them), and nowhere else; otherwise
// their Mac, when the desktop app is connected (it shows it even from the menu bar), or else their browser (web push);
// and their phone as well, being another device. Each is off unless set up, so a self-hosted Emplio needs none of it:
//  - iPhone app, sent straight to Apple: APNS_KEY_ID, APNS_TEAM_ID and APNS_KEY (the .p8 file, base64)
//  - Android app, sent to Google (Firebase Cloud Messaging): FCM_SERVICE_ACCOUNT (the service account's JSON, base64)
//  - browsers: VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY (webpush.ts)
import { createHmac, sign, timingSafeEqual } from "node:crypto";
import { connect, type SecureClientSessionOptions } from "node:http2";
import { and, eq, gt } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { currentUser } from "./auth";
import { db } from "./db";
import { pushDevices, sessions, webPushDevices } from "./db/schema";
import { replyFromNotification } from "./chat";
import { apiBase, deviceFor, rpc, whenReplied } from "./devices";
import { showInApp } from "./live";
import { publicKey, sendWeb } from "./webpush";

const TOPIC = "app.emplio";

// Apple refuses a token newer than 20 minutes after the last one and older than an hour: one every 50.
let provider = { token: "", at: 0 };
function providerToken(keyId: string, teamId: string, key: string) {
  if (Date.now() - provider.at < 50 * 60_000) return provider.token;
  const part = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const at = Date.now();
  const body = `${part({ alg: "ES256", kid: keyId })}.${part({ iss: teamId, iat: Math.floor(at / 1000) })}`;
  const signature = sign("sha256", Buffer.from(body), { key: Buffer.from(key, "base64").toString(), dsaEncoding: "ieee-p1363" }).toString("base64url");
  provider = { token: `${body}.${signature}`, at };
  return provider.token;
}

// What a lock screen can show of a markdown message. The device shortens it to fit; the cut here only keeps the whole
// notification under the 4 KB Apple and browsers accept (1000 characters is at most 3000 bytes of UTF-8).
export const plain = (markdown: string) =>
  markdown
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[*_#`>]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 1000);

export type Note = { title: string; body: string; path: string };
export type Senders = {
  // true when an app they're looking at took it
  app(userId: string, note: Note): boolean;
  // true when their Mac took it (shown, or deliberately not because they're looking at that chat)
  desktop(userId: string, note: Note): Promise<boolean>;
  web(userId: string, note: Note): Promise<void>;
  phone(userId: string, note: Note): Promise<void>;
};

// Where one event goes. The Mac and the browser are usually the same computer, so the browser only hears when the Mac
// didn't; the phone is its own device. The same event again within seconds (two paths reporting one thing) is dropped.
const recent = new Map<string, number>();
export async function route(userId: string, note: Note, senders: Senders, now = Date.now()) {
  for (const [k, at] of recent) if (now - at > 10_000) recent.delete(k);
  const key = `${userId}|${note.path}|${note.body}`;
  if (recent.has(key)) return;
  recent.set(key, now);
  // they're at Emplio already: a buzz on the phone or a system banner as well would only be noise
  if (senders.app(userId, note)) return;
  const onMac = await senders.desktop(userId, note).catch(() => false);
  await Promise.all([onMac ? undefined : senders.web(userId, note), senders.phone(userId, note)].map((p) => p?.catch((error) => console.error("push failed", error))));
}

const senders: Senders = {
  app: showInApp,
  async desktop(userId, note) {
    const conn = deviceFor(userId);
    if (!conn) return false;
    await rpc(conn, "notify", note, { timeoutMs: 5000 });
    return true;
  },
  async web(userId, note) {
    if (!publicKey()) return;
    const rows = await db.select({ endpoint: webPushDevices.endpoint, p256dh: webPushDevices.p256dh, auth: webPushDevices.auth }).from(webPushDevices).innerJoin(sessions, eq(webPushDevices.sessionHash, sessions.tokenHash)).where(eq(sessions.userId, userId));
    await Promise.all(rows.map(async (r) => {
      if ((await sendWeb(r, note)) === "gone") await db.delete(webPushDevices).where(eq(webPushDevices.endpoint, r.endpoint)).catch(() => {});
    }));
  },
  phone: (userId, note) => pushToPhone(userId, note),
};

// Never throws: a notification that can't go out mustn't get in the way of the work that wanted it sent.
export async function pushTo(userId: string, text: string, chatId: string) {
  try {
    await route(userId, { title: "Emplio", body: plain(text), path: `/chat/${chatId}` }, senders);
  } catch (error) {
    console.error("push failed", error);
  }
}

// Replying from a notification. The Mac app sends what was typed back over its link; the phone can't count on the app
// being awake (or its sign-in being at hand) when someone replies from the lock screen, so each notification carries
// a token for that one chat, good for a week and only while that person still has the iPhone app signed in.
const REPLY_DAYS = 7;
const chatOf = (path: string) => /^\/chat\/([0-9a-f-]{36})$/.exec(path)?.[1];
const replySig = (body: string) => createHmac("sha256", process.env.ENCRYPTION_KEY!).update(`notification-reply:${body}`).digest();
export function replyToken(userId: string, chatId: string, now = Date.now()) {
  const body = `${userId}.${chatId}.${Math.floor(now / 1000) + REPLY_DAYS * 86_400}`;
  return `${body}.${replySig(body).toString("base64url")}`;
}
export function readReplyToken(token: string, now = Date.now()) {
  const [userId, chatId, until, sig, ...rest] = token.split(".");
  if (!userId || !chatId || !until || !sig || rest.length) return null;
  const want = replySig(`${userId}.${chatId}.${until}`);
  const got = Buffer.from(sig, "base64url");
  if (got.length !== want.length || !timingSafeEqual(got, want) || Number(until) * 1000 < now) return null;
  return { userId, chatId };
}

type Log = { error(obj: unknown, msg: string): void };
async function replied(userId: string, chatId: string | undefined, text: string, log: Log) {
  const t = text.trim().slice(0, 4000);
  if (!chatId || !t) return "Invalid message";
  return replyFromNotification(userId, chatId, t, log);
}

// An iPhone's address with Apple is hex; an Android phone's with Google never is (it has a colon in it).
// ponytail: told apart by shape, not a column; a third kind of phone would want one.
export const isApple = (token: string) => /^[0-9a-f]+$/i.test(token);
const forget = (token: string) => db.delete(pushDevices).where(eq(pushDevices.token, token)).catch(() => {});

async function pushToPhone(userId: string, note: Note) {
  try {
    const devices = await db.select({ token: pushDevices.token }).from(pushDevices).innerJoin(sessions, eq(pushDevices.sessionHash, sessions.tokenHash)).where(eq(sessions.userId, userId));
    if (!devices.length) return;
    const chatId = chatOf(note.path);
    const reply = chatId ? { reply: replyToken(userId, chatId), replyUrl: `${apiBase()}/push/reply` } : {};
    const apple = devices.filter((d) => isApple(d.token)).map((d) => d.token);
    const android = devices.filter((d) => !isApple(d.token)).map((d) => d.token);
    await Promise.all([apple.length && toApple(apple, note, chatId, reply), android.length && toAndroid(android, note, reply).catch((error) => console.error("push failed", error))]);
  } catch (error) {
    console.error("push failed", error);
  }
}

async function toApple(tokens: string[], note: Note, chatId: string | undefined, reply: object) {
  const { APNS_KEY_ID: keyId, APNS_TEAM_ID: teamId, APNS_KEY: key, APNS_HOST: host = "api.push.apple.com" } = process.env;
  if (!keyId || !teamId || !key) return;
  try {
    const authorization = `bearer ${providerToken(keyId, teamId, key)}`;
    // "reply": the category the app registers with a text field (mobile/ios/App/App/AppDelegate.swift)
    const payload = JSON.stringify({ aps: { alert: { title: note.title, body: note.body }, sound: "default", ...(chatId && { category: "reply" }) }, path: note.path, ...reply });
    // ponytail: IPv4 only. Over IPv6 the connection to Apple mostly failed ("h2 is not supported") and no iPhone got
    // its notification; a server with IPv6 only would need this lifted.
    const client = connect(`https://${host}`, { family: 4 } as SecureClientSessionOptions);
    client.on("error", (error) => console.error("push connection failed", error));
    await Promise.all(tokens.map((t) => deliver(client, t, authorization, payload)));
    client.close();
  } catch (error) {
    console.error("push failed", error);
  }
}

function deliver(client: ReturnType<typeof connect>, token: string, authorization: string, payload: string) {
  return new Promise<void>((done) => {
    const request = client.request({ ":method": "POST", ":path": `/3/device/${token}`, authorization, "apns-topic": TOPIC, "apns-push-type": "alert" });
    let status = 0;
    let body = "";
    request.setEncoding("utf8");
    request.on("response", (headers) => (status = Number(headers[":status"])));
    request.on("data", (chunk) => (body += chunk));
    request.on("error", (error) => (console.error("push failed", error), done()));
    request.on("end", () => {
      if (status === 200) return done();
      console.error("push refused", status, body);
      // the app was removed, or the token belongs to another build
      if (status === 410 || body.includes("BadDeviceToken")) void forget(token).finally(done);
      else done();
    });
    request.end(payload);
  });
}

// --- Android, through Firebase Cloud Messaging (HTTP v1) ---------------------------------------------------------------
// Data only, no "notification" part: the app draws it itself (mobile/android/.../Notifications.java), with a Reply field
// for a chat, even when the app isn't running. Google's sign-in is a token the service account signs for, good an hour.
type Account = { project_id: string; client_email: string; private_key: string };
let google = { token: "", until: 0 };
async function googleToken(account: Account, now = Date.now()) {
  if (now < google.until) return google.token;
  const part = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const iat = Math.floor(now / 1000);
  const body = `${part({ alg: "RS256", typ: "JWT" })}.${part({ iss: account.client_email, scope: "https://www.googleapis.com/auth/firebase.messaging", aud: "https://oauth2.googleapis.com/token", iat, exp: iat + 3600 })}`;
  const assertion = `${body}.${sign("sha256", Buffer.from(body), account.private_key).toString("base64url")}`;
  const res = await fetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }) });
  if (!res.ok) throw new Error(`Google sign-in for notifications failed: ${res.status} ${await res.text()}`);
  const { access_token, expires_in } = (await res.json()) as { access_token: string; expires_in: number };
  google = { token: access_token, until: now + (expires_in - 300) * 1000 };
  return access_token;
}

// What one Android notification carries (every value a string, as Google requires).
export const androidMessage = (token: string, note: Note, reply: { reply?: string; replyUrl?: string }) => ({
  message: { token, data: { title: note.title, body: note.body, path: note.path, ...reply }, android: { priority: "HIGH", ttl: "86400s" } },
});

async function toAndroid(tokens: string[], note: Note, reply: { reply?: string; replyUrl?: string }) {
  const raw = process.env.FCM_SERVICE_ACCOUNT;
  if (!raw) return;
  const account = JSON.parse(Buffer.from(raw, "base64").toString()) as Account;
  const authorization = `Bearer ${await googleToken(account)}`;
  await Promise.all(tokens.map(async (token) => {
    const res = await fetch(`https://fcm.googleapis.com/v1/projects/${account.project_id}/messages:send`, { method: "POST", headers: { authorization, "content-type": "application/json" }, body: JSON.stringify(androidMessage(token, note, reply)) }).catch((error) => (console.error("push failed", error), null));
    if (!res || res.ok) return;
    const body = await res.text();
    console.error("push refused", res.status, body);
    // the app was removed, or signed out of notifications
    if (res.status === 404 || body.includes("UNREGISTERED")) await forget(token);
  }));
}

export async function pushRoutes(app: FastifyInstance) {
  whenReplied((userId, path, text) => void replied(userId, chatOf(path), text, app.log).then((e) => e && app.log.error({ e }, "notification reply refused")));

  // What was typed into a phone notification. The token is the sign-in (readReplyToken); no cookie comes with it.
  app.post<{ Body: { token: string; text: string } }>(
    "/push/reply",
    { schema: { body: { type: "object", required: ["token", "text"], properties: { token: { type: "string", maxLength: 300 }, text: { type: "string", minLength: 1, maxLength: 4000 } } } } },
    async (req, reply) => {
      const to = readReplyToken(req.body.token);
      if (!to) return reply.code(401).send({ error: "Not signed in" });
      const [phone] = await db.select({ token: pushDevices.token }).from(pushDevices).innerJoin(sessions, eq(pushDevices.sessionHash, sessions.tokenHash)).where(and(eq(sessions.userId, to.userId), gt(sessions.expiresAt, new Date()))).limit(1);
      if (!phone) return reply.code(401).send({ error: "Not signed in" });
      const error = await replied(to.userId, to.chatId, req.body.text, req.log);
      if (error) return reply.code(error === "Not found" ? 404 : 400).send({ error });
      return { ok: true };
    },
  );

  // The phone's address with Apple or Google, tied to this sign-in: signing out forgets it along with the session.
  app.post<{ Body: { token: string } }>(
    "/push/device",
    { schema: { body: { type: "object", required: ["token"], properties: { token: { type: "string", pattern: "^[0-9A-Za-z:_-]{32,4096}$" } } } } },
    async (req, reply) => {
      const user = await currentUser(req);
      if (!user) return reply.code(401).send({ error: "Not signed in" });
      await db.insert(pushDevices).values({ token: req.body.token, sessionHash: user.tokenHash }).onConflictDoUpdate({ target: pushDevices.token, set: { sessionHash: user.tokenHash } });
      return { ok: true };
    },
  );

  // Whether browsers can be notified here, and with which key (the page asks before it offers).
  app.get("/push/web/key", async (req, reply) => {
    if (!(await currentUser(req))) return reply.code(401).send({ error: "Not signed in" });
    return { key: publicKey() };
  });

  // This browser's address with its push service, tied to this sign-in like the phone's.
  app.post<{ Body: { endpoint: string; p256dh: string; auth: string } }>(
    "/push/web",
    { schema: { body: { type: "object", required: ["endpoint", "p256dh", "auth"], properties: { endpoint: { type: "string", pattern: "^https://", maxLength: 1000 }, p256dh: { type: "string", maxLength: 200 }, auth: { type: "string", maxLength: 100 } } } } },
    async (req, reply) => {
      const user = await currentUser(req);
      if (!user) return reply.code(401).send({ error: "Not signed in" });
      const { endpoint, p256dh, auth } = req.body;
      await db.insert(webPushDevices).values({ endpoint, p256dh, auth, sessionHash: user.tokenHash }).onConflictDoUpdate({ target: webPushDevices.endpoint, set: { p256dh, auth, sessionHash: user.tokenHash } });
      return { ok: true };
    },
  );
  app.delete<{ Body: { endpoint: string } }>("/push/web", async (req, reply) => {
    const user = await currentUser(req);
    if (!user) return reply.code(401).send({ error: "Not signed in" });
    await db.delete(webPushDevices).where(and(eq(webPushDevices.endpoint, String(req.body?.endpoint)), eq(webPushDevices.sessionHash, user.tokenHash)));
    return { ok: true };
  });
}
