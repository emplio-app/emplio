import { createECDH, createDecipheriv, createPublicKey, hkdfSync, randomBytes, verify } from "node:crypto";
import { expect, test } from "bun:test";
import { plain, route, type Senders } from "./push";
import { encrypt, vapidHeader } from "./webpush";

test("a lock screen shows plain words", () => {
  expect(plain("**Done.** See [the report](https://x.y/z)\n\n# Next")).toBe("Done. See the report Next");
  expect(plain("a".repeat(400))).toHaveLength(180);
});

const note = (body = "Done") => ({ title: "Emplio", body, path: "/chat/c1" });
function senders(o: { mac?: boolean | "throws"; looking?: boolean } = {}) {
  const got: string[] = [];
  const s: Senders = {
    app: () => (o.looking ? (got.push("app"), true) : false),
    desktop: async () => {
      if (o.mac === "throws") throw new Error("app too old");
      got.push("mac");
      return o.mac === true;
    },
    web: async () => void got.push("web"),
    phone: async () => void got.push("phone"),
  };
  return { s, got };
}

test("with the Mac app connected, it gets the event and the browser doesn't; the phone still does", async () => {
  const { s, got } = senders({ mac: true });
  await route("u1", note(), s);
  expect(got.sort()).toEqual(["mac", "phone"]);
});

test("without the Mac app (or one that can't show it), the browser and the phone get it", async () => {
  for (const mac of [false, "throws"] as const) {
    const { s, got } = senders({ mac });
    await route(`u-${mac}`, note(), s);
    expect(got.filter((g) => g !== "mac").sort()).toEqual(["phone", "web"]);
  }
});

test("looking at Emplio: it shows there and nowhere else", async () => {
  const { s, got } = senders({ mac: true, looking: true });
  await route("u4", note(), s);
  expect(got).toEqual(["app"]);
});

test("a sender that fails doesn't stop the others", async () => {
  const got: string[] = [];
  await route("u2", note(), { app: () => false, desktop: async () => false, web: async () => Promise.reject(new Error("x")), phone: async () => void got.push("phone") });
  expect(got).toEqual(["phone"]);
});

test("the same event twice within seconds goes out once; later, or a different one, again", async () => {
  const { s, got } = senders({ mac: true });
  await route("u3", note(), s, 1000);
  await route("u3", note(), s, 5000);
  expect(got).toHaveLength(2);
  await route("u3", note("Other"), s, 5000);
  await route("u3", note(), s, 20_000);
  expect(got).toHaveLength(6);
});

test("web push: what we encrypt is what the browser decrypts, and the sender's proof checks out", () => {
  const ua = createECDH("prime256v1");
  const uaPub = ua.generateKeys();
  const auth = randomBytes(16);
  const body = encrypt(JSON.stringify(note("héllo")), { p256dh: uaPub.toString("base64url"), auth: auth.toString("base64url") });
  const salt = body.subarray(0, 16);
  const asPub = body.subarray(21, 21 + body[20]!);
  const key = Buffer.from(hkdfSync("sha256", ua.computeSecret(asPub), auth, Buffer.concat([Buffer.from("WebPush: info\0"), uaPub, asPub]), 32));
  const cek = Buffer.from(hkdfSync("sha256", key, salt, Buffer.from("Content-Encoding: aes128gcm\0"), 16));
  const nonce = Buffer.from(hkdfSync("sha256", key, salt, Buffer.from("Content-Encoding: nonce\0"), 12));
  const rest = body.subarray(21 + asPub.length);
  const d = createDecipheriv("aes-128-gcm", cek, nonce);
  d.setAuthTag(rest.subarray(rest.length - 16));
  const plain = Buffer.concat([d.update(rest.subarray(0, rest.length - 16)), d.final()]);
  expect(plain.at(-1)).toBe(2);
  expect(JSON.parse(plain.subarray(0, -1).toString()).body).toBe("héllo");

  const vapid = createECDH("prime256v1");
  const pub = vapid.generateKeys();
  const header = vapidHeader("https://fcm.googleapis.com/fcm/send/abc", pub.toString("base64url"), vapid.getPrivateKey().toString("base64url"), "mailto:a@b.c");
  const jwt = /t=([^,]+),/.exec(header)![1]!;
  const [h, c, sig] = jwt.split(".");
  expect(JSON.parse(Buffer.from(c!, "base64url").toString()).aud).toBe("https://fcm.googleapis.com");
  const spki = createPublicKey({ key: { kty: "EC", crv: "P-256", x: pub.subarray(1, 33).toString("base64url"), y: pub.subarray(33).toString("base64url") }, format: "jwk" });
  expect(verify("sha256", Buffer.from(`${h}.${c}`), { key: spki, dsaEncoding: "ieee-p1363" }, Buffer.from(sig!, "base64url"))).toBe(true);
});
