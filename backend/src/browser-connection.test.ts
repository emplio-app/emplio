import { afterAll, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { browserFor, browserLocal, connectionFor, pageChecked } from "./browser";
import { cloud } from "./cloud";
import { db } from "./db";
import { paidSites, workspaces } from "./db/schema";

const real = cloud.browser;
afterAll(() => void (cloud.browser = real));

let switches = 0;
cloud.browser = {
  ...real,
  listHosted: async (chat: string) => [{ id: chat, liveUrl: "https://live", cdpUrl: "http://nowhere.invalid", timeoutAt: new Date(Date.now() + 3600_000).toISOString() }],
  useProxy: async () => (switches++, true),
};

const [w] = await db.insert(workspaces).values({ name: "connection test" }).returning();
const owner = { workspaceId: w!.id, userId: crypto.randomUUID() };
const browser = async () => {
  const live = await browserFor(crypto.randomUUID(), owner);
  clearTimeout(live.timer);
  live.signedIn = new Set();
  return live;
};
const report = (page: string, blocked: boolean, signIn = false) => btoa(JSON.stringify({ page, blocked, signIn }));
const open = (site: string) => `emplio browser open https://${site}/x`;

test("a site that turns the browser away moves it once, and the next browser goes there on the paid connection first", async () => {
  switches = 0;
  const first = await browser();
  await connectionFor(first, owner, open("blocked.test"));
  expect(switches).toBe(0);

  const note = await pageChecked(first.id, owner.workspaceId, report("www.blocked.test", true));
  expect(note).toContain("Open the page again");
  expect(switches).toBe(1);
  expect(await pageChecked(first.id, owner.workspaceId, report("www.blocked.test", true))).toBeNull();
  expect(switches).toBe(1);

  const next = await browser();
  await connectionFor(next, owner, open("app.blocked.test"));
  expect(switches).toBe(2);
  expect(next.paid).toBe(true);
});

test("a password box moves it quietly, a normal page and an unknown site don't", async () => {
  switches = 0;
  const live = await browser();
  expect(await pageChecked(live.id, owner.workspaceId, report("fine.test", false))).toBeNull();
  await connectionFor(live, owner, open("fine.test"));
  expect(switches).toBe(0);
  expect(await pageChecked(live.id, owner.workspaceId, report("signin.test", false, true))).toBeNull();
  expect(switches).toBe(1);
});

test("a signed-in site goes on the paid connection before the command", async () => {
  switches = 0;
  const live = await browser();
  live.signedIn = new Set(["mine.test"]);
  await connectionFor(live, owner, open("mine.test"));
  expect(switches).toBe(1);
});

test("a site not used for 30 days is forgotten", async () => {
  switches = 0;
  await db.insert(paidSites).values({ workspaceId: owner.workspaceId, site: "old.test", seenAt: new Date(Date.now() - 31 * 86_400_000) });
  await connectionFor(await browser(), owner, open("old.test"));
  expect(switches).toBe(0);
});

test("Emplio can ask for it, and the site is remembered", async () => {
  switches = 0;
  const live = await browser();
  expect(await browserLocal(live.id, owner.workspaceId, "https://shop.asked.test/prices")).toContain("On a local connection");
  expect(switches).toBe(1);
  expect(await browserLocal(live.id, owner.workspaceId, "https://shop.asked.test/prices")).toContain("On a local connection");
  expect(switches).toBe(1);
  expect(await db.select().from(paidSites).where(and(eq(paidSites.workspaceId, owner.workspaceId), eq(paidSites.site, "asked.test")))).toHaveLength(1);
});

test("asked for in a command, it moves before the command runs and remembers the site that command opens", async () => {
  switches = 0;
  const live = await browser();
  await connectionFor(live, owner, "emplio browser local; emplio browser open https://chained.test && emplio browser snapshot");
  expect(switches).toBe(1);
  expect(live.paid).toBe(true);
  expect(await db.select().from(paidSites).where(and(eq(paidSites.workspaceId, owner.workspaceId), eq(paidSites.site, "chained.test")))).toHaveLength(1);
});

test("a browser service with no proxies stays as it is", async () => {
  cloud.browser = { ...cloud.browser, useProxy: async () => false };
  const live = await browser();
  expect(await pageChecked(live.id, owner.workspaceId, report("nope.test", true))).toBeNull();
  expect(await browserLocal(live.id, owner.workspaceId)).toContain("no other connection");
});
