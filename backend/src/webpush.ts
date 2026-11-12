// Browser notifications (Chrome and others): the standard Web Push protocol, written with node:crypto so it needs no
// package. Off unless VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY are set (make a pair with `bun scripts/vapid-keys.ts`).
import { createECDH, createCipheriv, createPrivateKey, hkdfSync, randomBytes, sign } from "node:crypto";

export type Subscription = { endpoint: string; p256dh: string; auth: string };

const b64 = (b: Buffer | string) => Buffer.from(b as any).toString("base64url");
const unb64 = (s: string) => Buffer.from(s, "base64url");
const hkdf = (salt: Buffer, ikm: Buffer, info: Buffer, n: number) => Buffer.from(hkdfSync("sha256", ikm, salt, info, n));

// RFC 8291 (aes128gcm): the message only the person's browser can read.
export function encrypt(payload: string, sub: Pick<Subscription, "p256dh" | "auth">) {
  const ua = unb64(sub.p256dh);
  const ecdh = createECDH("prime256v1");
  const as = ecdh.generateKeys();
  const secret = ecdh.computeSecret(ua);
  const key = hkdf(unb64(sub.auth), secret, Buffer.concat([Buffer.from("WebPush: info\0"), ua, as]), 32);
  const salt = randomBytes(16);
  const cek = hkdf(salt, key, Buffer.from("Content-Encoding: aes128gcm\0"), 16);
  const nonce = hkdf(salt, key, Buffer.from("Content-Encoding: nonce\0"), 12);
  const cipher = createCipheriv("aes-128-gcm", cek, nonce);
  const data = Buffer.concat([cipher.update(Buffer.concat([Buffer.from(payload), Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
  const head = Buffer.alloc(21);
  salt.copy(head);
  head.writeUInt32BE(4096, 16);
  head.writeUInt8(as.length, 20);
  return Buffer.concat([head, as, data]);
}

// RFC 8292: proves to the browser's push service which server is sending.
export function vapidHeader(endpoint: string, publicKey: string, privateKey: string, subject: string, now = Date.now()) {
  const part = (o: object) => b64(JSON.stringify(o));
  const body = `${part({ typ: "JWT", alg: "ES256" })}.${part({ aud: new URL(endpoint).origin, exp: Math.floor(now / 1000) + 12 * 3600, sub: subject })}`;
  const pub = unb64(publicKey);
  const key = createPrivateKey({ key: { kty: "EC", crv: "P-256", d: privateKey, x: b64(pub.subarray(1, 33)), y: b64(pub.subarray(33, 65)) }, format: "jwk" });
  const signature = sign("sha256", Buffer.from(body), { key, dsaEncoding: "ieee-p1363" }).toString("base64url");
  return `vapid t=${body}.${signature}, k=${publicKey}`;
}

export const publicKey = () => (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY ? process.env.VAPID_PUBLIC_KEY : null);

// "ok", "gone" (the browser forgot this subscription: delete it) or "failed"
export async function sendWeb(sub: Subscription, message: object): Promise<"ok" | "gone" | "failed"> {
  const pub = publicKey();
  if (!pub) return "failed";
  try {
    const r = await fetch(sub.endpoint, {
      method: "POST",
      headers: {
        authorization: vapidHeader(sub.endpoint, pub, process.env.VAPID_PRIVATE_KEY!, process.env.VAPID_SUBJECT ?? "mailto:hello@emplio.app"),
        "content-encoding": "aes128gcm",
        "content-type": "application/octet-stream",
        ttl: "86400",
        urgency: "high",
      },
      body: encrypt(JSON.stringify(message), sub),
      signal: AbortSignal.timeout(10_000),
    });
    if (r.status === 404 || r.status === 410) return "gone";
    if (!r.ok) console.error("web push refused", r.status, (await r.text()).slice(0, 200));
    return r.ok ? "ok" : "failed";
  } catch (error) {
    console.error("web push failed", error);
    return "failed";
  }
}
