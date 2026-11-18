// When an account is marked expired, and when it comes back: one turned-down call must not log anyone out (#219).
import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db";
import { connections, users, workspaces } from "../db/schema";
import { encrypt } from "../secrets";
import { disconnect, runAction } from "./index";
import { APPS, type OwnApp } from "./own";
import { AppsError } from "./types";

// Exa's place in the catalog, with a fake app behind it: `fail` is how its one action fails, `loginGood` whether its
// "whose account is this" check passes
let fail: AppsError | null = null;
let loginGood = true;
const real = APPS.exa!;
const fake: OwnApp = {
  ...real,
  check: async () => {
    if (!loginGood) throw new AppsError("Exa rejected the token; make a new one and reconnect", true);
  },
  actions: {
    ping: {
      description: "",
      input: z.object({}),
      run: async () => {
        if (fail) throw fail;
        return { ok: true };
      },
    },
  },
};

const tag = crypto.randomUUID().slice(0, 8);
let who: { workspaceId: string; userId: string };
beforeAll(async () => {
  process.env.ENCRYPTION_KEY ??= randomBytes(32).toString("base64");
  APPS.exa = fake;
  const [w] = await db.insert(workspaces).values({ name: `expiry-test-${tag}` }).returning();
  const [u] = await db.insert(users).values({ email: `expiry-test-${tag}@example.com` }).returning();
  who = { workspaceId: w!.id, userId: u!.id };
});
afterAll(async () => {
  APPS.exa = real;
  await db.delete(workspaces).where(eq(workspaces.id, who.workspaceId));
  await db.delete(users).where(eq(users.id, who.userId));
});

const account = async (label: string, status: "active" | "expired" = "active") => {
  const id = crypto.randomUUID();
  const [row] = await db
    .insert(connections)
    .values({ id, ...who, app: "exa", provider: "own", externalId: id, status, label, secret: encrypt("key") })
    .returning();
  return row!;
};
const stored = async (id: string) => (await db.query.connections.findFirst({ where: eq(connections.id, id) }))!;
const run = (label: string) => runAction(who, "exa.ping", {}, { account: label }).then(() => null, (e: Error) => e.message);

test("a call turned down while the login still works says so, and leaves the account connected", async () => {
  const c = await account("main");
  // an OpenRouter call that needs its management key answers 401, like a dead key would
  fail = new AppsError("Exa rejected the token; make a new one and reconnect", true, "Management key required (401)");
  const said = await run("main");
  expect(said).toContain("sign-in still works");
  expect(said).toContain("Management key required");
  expect((await stored(c.id)).status).toBe("active");
});

test("a login that really is gone is marked expired, with why", async () => {
  const c = await account("dead");
  fail = new AppsError("Exa rejected the token; make a new one and reconnect", true);
  loginGood = false;
  expect(await run("dead")).toContain("rejected the token");
  const row = await stored(c.id);
  expect(row.status).toBe("expired");
  expect(row.problem).toContain("stopped working");
  loginGood = true;
});

test("an expired account whose login works after all comes back by itself", async () => {
  const c = await account("back", "expired");
  fail = null;
  expect(await run("back")).toBeNull();
  const row = await stored(c.id);
  expect(row.status).toBe("active");
  expect(row.problem).toBeNull();
});

test("permissions left out at sign-in: the account says so, and the message points at a working one", async () => {
  const c = await account("missing");
  fail = new AppsError('Error finding files: 403. {"error": {"code": 403, "message": "Request had insufficient authentication scopes."}}');
  const said = await run("missing");
  expect(said).toContain("tick every box");
  expect(said).toContain('"main"');
  const row = await stored(c.id);
  expect(row.status).toBe("active");
  expect(row.problem).toContain("permissions");
});

test("disconnecting one Google app leaves the others on that Google account signed in; the last one ends Emplio's access", async () => {
  const google = async (app: string, token: string) => {
    const id = crypto.randomUUID();
    await db.insert(connections).values({ id, ...who, app, provider: "own", externalId: id, status: "active", label: app, secret: encrypt(token) });
    return id;
  };
  const docs = await google("googledocs", "docs-token");
  const calendar = await google("googlecalendar", "calendar-token");
  const revoked: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    if (String(url).includes("/oauth2/v3/userinfo")) return Response.json({ email: "same@example.com" });
    if (String(url).includes("/revoke")) return revoked.push(String(new URLSearchParams(String(init?.body)).get("token"))), new Response("");
    return realFetch(url, init);
  }) as typeof fetch;
  try {
    await disconnect(who, "googledocs", undefined, docs);
    expect(revoked).toEqual([]);
    await disconnect(who, "googlecalendar", undefined, calendar);
    expect(revoked).toEqual(["calendar-token"]);
  } finally {
    globalThis.fetch = realFetch;
  }
});
