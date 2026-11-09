import { afterEach, beforeAll, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { decrypt, encrypt } from "../../secrets";
import { AppsError } from "../types";
import { APPS, freshSecret, own, type OAuthTokens, type OwnApp } from "./index";

beforeAll(() => {
  process.env.ENCRYPTION_KEY = randomBytes(32).toString("base64");
});
afterEach(() => {
  delete APPS.fakeoauth;
});

const app = (refresh: (r: string) => Promise<OAuthTokens>, exchange: () => Promise<string | OAuthTokens> = async () => "t"): OwnApp =>
  (APPS.fakeoauth = {
    app: "fakeoauth",
    name: "Fake",
    logo: "",
    keyField: { label: "", help: "", placeholder: "" },
    check: async (key) => `account of ${key}`,
    oauth: { ready: () => true, authorizeUrl: () => "", exchange, refresh },
    actions: {},
  });

const row = (over: Partial<{ secret: string | null; refreshToken: string | null; expiresAt: Date | null }> = {}) => ({
  id: crypto.randomUUID(),
  app: "fakeoauth",
  secret: encrypt("old"),
  refreshToken: encrypt("r1"),
  expiresAt: new Date(Date.now() - 1000),
  ...over,
});
type Saved = { secret: string | null; refreshToken: string | null; expiresAt: Date | null };
const recorder = () => {
  const saves: Saved[] = [];
  return { saves, save: async (_id: string, v: Saved) => void saves.push(v) };
};

test("a sign-in keeps the refresh token and when the login ends; a plain string never runs out", async () => {
  app(async () => ({ token: "n" }), async () => ({ token: "a1", refreshToken: "r1", expiresIn: 3600 }));
  const got = await own.finishSignIn!("fakeoauth", "code", "https://api.test/connections/x/done");
  expect(got.secret).toBe("a1");
  expect(got.label).toBe("account of a1");
  expect(got.refreshToken).toBe("r1");
  expect(Math.abs(got.expiresAt!.getTime() - (Date.now() + 3_600_000))).toBeLessThan(2000);

  app(async () => ({ token: "n" }), async () => "forever");
  const plain = await own.finishSignIn!("fakeoauth", "code", "https://api.test/connections/x/done");
  expect(plain.refreshToken).toBeUndefined();
  expect(plain.expiresAt).toBeUndefined();
});

test("a login with time left is used as it is", async () => {
  let asked = 0;
  app(async () => (asked++, { token: "n" }));
  const { save, saves } = recorder();
  expect(await freshSecret(row({ expiresAt: new Date(Date.now() + 600_000) }), save)).toBe("old");
  expect(asked).toBe(0);
  expect(saves).toEqual([]);
});

test("one about to run out is renewed, and what's saved is encrypted", async () => {
  const seen: string[] = [];
  app(async (r) => (seen.push(r), { token: "new", refreshToken: "r2", expiresIn: 3600 }));
  const { save, saves } = recorder();
  expect(await freshSecret(row({ expiresAt: new Date(Date.now() + 10_000) }), save)).toBe("new");
  expect(seen).toEqual(["r1"]);
  expect(saves[0]!.secret).not.toBe("new");
  expect(decrypt(saves[0]!.secret!)).toBe("new");
  expect(decrypt(saves[0]!.refreshToken!)).toBe("r2");
  expect(saves[0]!.expiresAt!.getTime()).toBeGreaterThan(Date.now() + 3_500_000);
});

test("an app that sends no new refresh token keeps the old one", async () => {
  app(async () => ({ token: "new", expiresIn: 60 }));
  const { save, saves } = recorder();
  await freshSecret(row(), save);
  expect(decrypt(saves[0]!.refreshToken!)).toBe("r1");
});

test("two at once share one renewal, so a single-use refresh token isn't spent twice", async () => {
  let asked = 0;
  let finish!: (t: OAuthTokens) => void;
  app(() => (asked++, new Promise<OAuthTokens>((r) => (finish = r))));
  const { save, saves } = recorder();
  const c = row();
  const both = [freshSecret(c, save), freshSecret(c, save)];
  finish({ token: "new", expiresIn: 3600 });
  expect(await Promise.all(both)).toEqual(["new", "new"]);
  expect(asked).toBe(1);
  expect(saves).toHaveLength(1);
});

test("a revoked refresh token surfaces as needing to sign in again, and nothing is saved", async () => {
  app(async () => {
    throw new AppsError("Sign in again", true);
  });
  const { save, saves } = recorder();
  const failed = await freshSecret(row(), save).catch((e) => e);
  expect(failed).toBeInstanceOf(AppsError);
  expect(failed.expired).toBe(true);
  expect(saves).toEqual([]);
});

test("a key, or an old login with no way to renew, is decrypted and left alone", async () => {
  const { save, saves } = recorder();
  expect(await freshSecret(row({ refreshToken: null, expiresAt: null }), save)).toBe("old");
  expect(await freshSecret(row({ secret: null }), save)).toBeNull();
  expect(saves).toEqual([]);
});
