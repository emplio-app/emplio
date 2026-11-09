// Notifications on the iPhone app, sent straight to Apple. Off unless APNS_KEY_ID, APNS_TEAM_ID and APNS_KEY
// (the .p8 file, base64) are set, so a self-hosted Emplio needs none of it.
import { sign } from "node:crypto";
import { connect } from "node:http2";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { currentUser } from "./auth";
import { db } from "./db";
import { pushDevices, sessions } from "./db/schema";

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

// Never throws: a notification that can't go out mustn't get in the way of the work that wanted it sent.
export async function pushTo(userId: string, text: string, chatId: string) {
  const { APNS_KEY_ID: keyId, APNS_TEAM_ID: teamId, APNS_KEY: key, APNS_HOST: host = "api.push.apple.com" } = process.env;
  if (!keyId || !teamId || !key) return;
  try {
    const devices = await db.select({ token: pushDevices.token }).from(pushDevices).innerJoin(sessions, eq(pushDevices.sessionHash, sessions.tokenHash)).where(eq(sessions.userId, userId));
    if (!devices.length) return;
    const authorization = `bearer ${providerToken(keyId, teamId, key)}`;
    const payload = JSON.stringify({ aps: { alert: { title: "Emplio", body: plain(text) }, sound: "default" }, path: `/chat/${chatId}` });
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
}
