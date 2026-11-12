// Notifications: the one place that decides where an event the person should hear about goes (pushTo). Their Mac, when
// the desktop app is connected (it shows it even from the menu bar); otherwise their browser (web push); and their
// iPhone as well, being another device. Each is off unless set up, so a self-hosted Emplio needs none of it:
//  - iPhone app, sent straight to Apple: APNS_KEY_ID, APNS_TEAM_ID and APNS_KEY (the .p8 file, base64)
//  - browsers: VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY (webpush.ts)
import { sign } from "node:crypto";
import { connect } from "node:http2";
import { and, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { currentUser } from "./auth";
import { db } from "./db";
import { pushDevices, sessions, webPushDevices } from "./db/schema";
import { deviceFor, rpc } from "./devices";
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

// What a lock screen can show of a markdown message.
export const plain = (markdown: string) =>
  markdown
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[*_#`>]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 180);

export type Note = { title: string; body: string; path: string };
export type Senders = {
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
  const onMac = await senders.desktop(userId, note).catch(() => false);
  await Promise.all([onMac ? undefined : senders.web(userId, note), senders.phone(userId, note)].map((p) => p?.catch((error) => console.error("push failed", error))));
}

const senders: Senders = {
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

async function pushToPhone(userId: string, note: Note) {
  const { APNS_KEY_ID: keyId, APNS_TEAM_ID: teamId, APNS_KEY: key, APNS_HOST: host = "api.push.apple.com" } = process.env;
  if (!keyId || !teamId || !key) return;
  try {
    const devices = await db.select({ token: pushDevices.token }).from(pushDevices).innerJoin(sessions, eq(pushDevices.sessionHash, sessions.tokenHash)).where(eq(sessions.userId, userId));
    if (!devices.length) return;
    const authorization = `bearer ${providerToken(keyId, teamId, key)}`;
    const payload = JSON.stringify({ aps: { alert: { title: note.title, body: note.body }, sound: "default" }, path: note.path });
    const client = connect(`https://${host}`);
    client.on("error", (error) => console.error("push connection failed", error));
    await Promise.all(devices.map((d) => deliver(client, d.token, authorization, payload)));
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
      if (status === 410 || body.includes("BadDeviceToken")) void db.delete(pushDevices).where(eq(pushDevices.token, token)).catch(() => {}).finally(done);
      else done();
    });
    request.end(payload);
  });
}

export async function pushRoutes(app: FastifyInstance) {
  // The phone's address with Apple, tied to this sign-in: signing out forgets it along with the session.
  app.post<{ Body: { token: string } }>(
    "/push/device",
    { schema: { body: { type: "object", required: ["token"], properties: { token: { type: "string", pattern: "^[0-9a-fA-F]{32,200}$" } } } } },
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
