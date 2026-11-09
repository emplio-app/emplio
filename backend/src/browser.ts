// One browser per chat, from whoever runs them (browser-host.ts). The agent drives it from the sandbox with
// agent-browser (`emplio browser`); this server only starts and stops it, so no account key ever enters the box:
// the box gets this one browser's CDP link.
// Sign in to a site once and that person's later chats, tasks and automations are signed in too.
// ponytail: one person's two chats browsing at once each save on stop, last one wins; a lock per profile if
// that loses logins in practice.
import { createHmac, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { and, eq, gt, inArray, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { db } from "./db";
import { conversations, paidSites, workspaceMembers } from "./db/schema";
import { cloud } from "./cloud";
import { decrypt, encrypt } from "./secrets";
import { siteOf } from "./site-calls";
import { z } from "zod";

// stopped after this long without a browser command (billed while open); long enough for the
// user to solve a CAPTCHA or enter a code in the live view after the agent asks
const IDLE_MS = 10 * 60_000;
// how long after that the chat's Live browser button can still start it again
const REOPEN_MS = 24 * 60 * 60_000;

export const canReopen = (usedAt: Date | null, now = Date.now()) => !!usedAt && now - usedAt.getTime() < REOPEN_MS;

// owner: whose sign-ins it carries (unknown for one picked up after a restart until a command uses it)
export type LiveBrowser = { id: string; liveUrl: string; cdpUrl: string; ends: number; timer?: Timer; owner?: Owner; paid?: boolean; signedIn?: Set<string> };
const open = new Map<string, Promise<LiveBrowser>>();

// One DevTools session on a tab: send a command, wait for its answer.
export async function devtools(cdpUrl: string) {
  const { webSocketDebuggerUrl } = (await (await fetch(`${cdpUrl}/json/version`)).json()) as { webSocketDebuggerUrl: string };
  const sock = new WebSocket(webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    sock.onopen = resolve;
    sock.onerror = () => reject(new Error("couldn't reach the browser"));
  });
  let next = 0;
  const waiting = new Map<number, (m: { result?: any; error?: { message: string } }) => void>();
  let listener: ((method: string, params: any, sessionId?: string) => void) | undefined;
  sock.onmessage = (e) => {
    const m = JSON.parse(String(e.data));
    if (m.method) return listener?.(m.method, m.params, m.sessionId);
    waiting.get(m.id)?.(m);
    waiting.delete(m.id);
  };
  const send = (method: string, params: object = {}, sessionId?: string) =>
    new Promise<any>((resolve, reject) => {
      const id = ++next;
      waiting.set(id, (m) => (m.error ? reject(new Error(m.error.message)) : resolve(m.result)));
      sock.send(JSON.stringify({ id, method, params, sessionId }));
    });
  return { send, on: (fn: NonNullable<typeof listener>) => void (listener = fn), close: () => sock.close() };
}

// --- a copy of the sign-ins in our own database ---------------------------------------------------------
// So that sign-ins don't depend on who runs the browser, each stop also keeps the browser's cookies and the local storage and Indexed DB of the sites open in it, encrypted
// on the person's membership (`browser_state`). restoreState puts them into any Chromium-type browser.
// Not session storage: a browser drops that with the tab anyway.
type Cookie = Record<string, unknown> & { name: string; value: string; domain: string };
export type BrowserState = { cookies: Cookie[]; storage: Record<string, Record<string, string>>; indexedDb?: Record<string, unknown[]>; savedAt: string };

const INDEXED_DB = readFileSync(new URL("./browser-indexeddb.js", import.meta.url), "utf8");
const indexedDbJob = (job: { limit: number } | { dbs: unknown[] }) => `(${INDEXED_DB})(${JSON.stringify(job)})`;
// ponytail: small on purpose, the membership row this sits on is loaded by everyday queries. Sign-in tokens fit; a site's
// whole offline copy doesn't and is skipped. Give it its own table if sites that need more show up.
const INDEXED_DB_SITE_LIMIT = 300_000;
const INDEXED_DB_SITES = 5;

// A page that hangs mustn't cost the sign-ins already read, or hold up the browser starting.
const within5s = <T>(work: Promise<T>) => Promise.race([work, Bun.sleep(5000).then(() => undefined)]).catch(() => undefined);

// The sites read just now replace what was kept for them, emptied ones included; the newest few stay.
export const keepIndexedDb = (before: Record<string, unknown[]> = {}, now: Record<string, unknown[]> = {}) =>
  Object.fromEntries(
    [...Object.entries(before).filter(([origin]) => !now[origin]), ...Object.entries(now)].filter(([, dbs]) => dbs.length).slice(-INDEXED_DB_SITES),
  );

export async function readState(cdpUrl: string) {
  const cdp = await devtools(cdpUrl);
  try {
    const { cookies } = await cdp.send("Storage.getCookies");
    const storage: BrowserState["storage"] = {};
    // the tab in front, for the Live browser button to come back to
    let page: string | undefined;
    const sites = new Map<string, string>();
    const { targetInfos } = await cdp.send("Target.getTargets");
    for (const t of (targetInfos as { targetId: string; type: string; url: string }[]).filter((t) => t.type === "page" && /^https?:/.test(t.url))) {
      const { sessionId } = await cdp.send("Target.attachToTarget", { targetId: t.targetId, flatten: true });
      const r = await cdp.send("Runtime.evaluate", { expression: "JSON.stringify([location.origin, {...localStorage}, document.visibilityState])", returnByValue: true }, sessionId);
      const [origin, items, visibility] = JSON.parse(r.result.value) as [string, Record<string, string>, string];
      if (Object.keys(items).length) storage[origin] = items;
      sites.set(origin, sessionId);
      if (visibility === "visible" || !page) page = t.url;
    }
    const indexedDb: Record<string, unknown[]> = {};
    await Promise.all(
      [...sites].map(async ([origin, sessionId]) => {
        const r = await within5s(cdp.send("Runtime.evaluate", { expression: indexedDbJob({ limit: INDEXED_DB_SITE_LIMIT }), awaitPromise: true, returnByValue: true }, sessionId));
        if (r?.result?.value) indexedDb[origin] = JSON.parse(r.result.value);
      }),
    );
    return { cookies: cookies as Cookie[], storage, indexedDb, page };
  } finally {
    cdp.close();
  }
}

const memberWhere = ({ workspaceId, userId }: Owner) => and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, userId));

export async function savedState(owner: Owner): Promise<BrowserState | null> {
  const m = await db.query.workspaceMembers.findFirst({ where: memberWhere(owner), columns: { browserState: true } });
  return m?.browserState ? JSON.parse(decrypt(m.browserState)) : null;
}

// Cookies are the whole jar (the profile loads them all); local storage and Indexed DB add to what was kept for other sites.
async function saveState(owner: Owner, cdpUrl: string) {
  const now = await readState(cdpUrl);
  const before = await savedState(owner);
  const state: BrowserState = { cookies: now.cookies, storage: { ...before?.storage, ...now.storage }, indexedDb: keepIndexedDb(before?.indexedDb, now.indexedDb), savedAt: new Date().toISOString() };
  await db.update(workspaceMembers).set({ browserState: encrypt(JSON.stringify(state)) }).where(memberWhere(owner));
  return now.page;
}

const markUsed = (conversationId: string, page?: string) =>
  db
    .update(conversations)
    .set({ browserUsedAt: new Date(), ...(page && { browserPage: encrypt(page) }) })
    .where(eq(conversations.id, conversationId))
    .catch((e) => console.error("browser use not noted:", e));

// Put a kept state into a fresh browser: cookies, then each site's local storage and Indexed DB.
export async function restoreState(cdpUrl: string, state: BrowserState) {
  const cdp = await devtools(cdpUrl);
  try {
    await cdp.send("Storage.setCookies", { cookies: state.cookies });
    const { targetInfos } = await cdp.send("Target.getTargets");
    const tab = (targetInfos as { targetId: string; type: string }[]).find((t) => t.type === "page");
    if (!tab) return;
    const { sessionId } = await cdp.send("Target.attachToTarget", { targetId: tab.targetId, flatten: true });
    const run = async (expression: string) => (await cdp.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, sessionId)).result?.value;
    // these can only be written from a page of that site: open a tiny one (robots.txt) on each
    for (const origin of new Set([...Object.keys(state.storage), ...Object.keys(state.indexedDb ?? {})])) {
      await cdp.send("Page.navigate", { url: `${origin}/robots.txt` }, sessionId);
      for (let i = 0; i < 20 && (await run("location.origin").catch(() => null)) !== origin; i++) await Bun.sleep(250);
      const items = state.storage[origin];
      if (items) await run(`(() => { for (const [k, v] of Object.entries(${JSON.stringify(items)})) localStorage.setItem(k, v); })()`).catch(() => {});
      const dbs = state.indexedDb?.[origin];
      if (dbs) await within5s(run(indexedDbJob({ dbs })));
    }
    await cdp.send("Page.navigate", { url: "about:blank" }, sessionId);
  } finally {
    cdp.close();
  }
}

export async function stopBrowser(conversationId: string) {
  const pending = open.get(conversationId);
  if (!pending) return;
  open.delete(conversationId);
  const live = await pending.catch(() => null);
  if (!live) return;
  clearTimeout(live.timer);
  // a browser that has already ended doesn't answer: don't hold the stop up for it
  const page = live.owner
    ? await Promise.race([saveState(live.owner, live.cdpUrl), Bun.sleep(20_000).then(() => Promise.reject(new Error("timed out")))]).catch((e) => {
        console.error("browser state not kept:", e);
        return undefined;
      })
    : undefined;
  await cloud.browser.stopHosted(live.id).catch(() => {});
  await markUsed(conversationId, page);
}

// Every browser ends at its timeout; a minute early here so we never hand out a dead one.
// (its timestamps carry microseconds, which Date doesn't parse everywhere)
const toLive = (s: { id: string; liveUrl: string; cdpUrl: string; timeoutAt: string }): LiveBrowser => ({
  id: s.id,
  liveUrl: s.liveUrl,
  cdpUrl: s.cdpUrl,
  ends: new Date(s.timeoutAt.replace(/(\.\d{3})\d+/, "$1")).getTime() - 60_000,
});

// The chat's browser still running, if any: this server forgets them when it restarts,
// so look before starting another. Strays from earlier restarts are stopped.
async function find(conversationId: string) {
  const [newest, ...strays] = (await cloud.browser.listHosted(conversationId)).filter((b) => b.cdpUrl && b.liveUrl).sort((a, b) => (b.startedAt ?? "").localeCompare(a.startedAt ?? ""));
  for (const b of strays) void cloud.browser.stopHosted(b.id).catch(() => {});
  return newest ? toLive(newest) : null;
}

export type Owner = { workspaceId: string; userId: string };

const start = async (conversationId: string, owner: Owner) => {
  const live = toLive(await cloud.browser.startHosted(conversationId, owner));
  const saved = await savedState(owner).catch(() => null);
  // A browser service's own profile brings back cookies and local storage. Its docs don't promise Indexed DB, so that
  // always goes through, and only databases the browser doesn't already have get written.
  const toRestore = saved && (cloud.browser.RESTORE_SIGN_INS ? saved : { ...saved, cookies: [], storage: {} });
  if (toRestore && (toRestore.cookies.length || Object.keys(toRestore.storage).length || Object.keys(toRestore.indexedDb ?? {}).length))
    await restoreState(live.cdpUrl, toRestore).catch((e) => console.error("browser state not restored:", e));
  return live;
};

const remember = (conversationId: string, pending: Promise<LiveBrowser | null>) => {
  open.set(conversationId, pending as Promise<LiveBrowser>);
  pending.then((live) => live ?? open.delete(conversationId)).catch(() => open.delete(conversationId));
};

const idle = (conversationId: string, live: LiveBrowser) => {
  clearTimeout(live.timer);
  live.timer = setTimeout(() => void stopBrowser(conversationId), IDLE_MS);
};

// No idle stop while a person is using it with no commands coming (browser-show.ts); it counts again from the release.
export function holdOpen(conversationId: string, live: LiveBrowser) {
  clearTimeout(live.timer);
  return () => idle(conversationId, live);
}

// The chat's browser, found or started on first use; each call pushes the idle stop back.
export async function browserFor(conversationId: string, owner: Owner): Promise<LiveBrowser> {
  if (!open.has(conversationId)) {
    remember(conversationId, find(conversationId).then((found) => found ?? start(conversationId, owner)));
    await markUsed(conversationId);
  }
  const live = await open.get(conversationId)!;
  // a live-view check that found nothing may still be settling
  if (!live) {
    open.delete(conversationId);
    return browserFor(conversationId, owner);
  }
  if (Date.now() > live.ends) {
    await stopBrowser(conversationId);
    return browserFor(conversationId, owner);
  }
  live.owner = owner;
  idle(conversationId, live);
  return live;
}

// What the browser downloaded since we last looked (it saves them on its own computer, not the person's): each
// file's name and a short-lived link to its bytes. A file downloaded again under the same name counts as new.
// ponytail: first 100 files only; the seen list lasts while this server runs (a restart hands them over again)
const seen = new Map<string, Set<string>>();
export async function newDownloads(browserId: string): Promise<{ name: string; url: string; size: number }[]> {
  const files = await cloud.browser.hostedDownloads(browserId);
  const had = seen.get(browserId) ?? new Set();
  seen.set(browserId, had);
  const fresh = files.filter((f) => f.url && !had.has(`${f.path}|${f.size}|${f.lastModified}`));
  for (const f of fresh) had.add(`${f.path}|${f.size}|${f.lastModified}`);
  return fresh.map((f) => ({ name: f.path.split("/").pop()!, url: f.url!, size: f.size }));
}

// The chat's browser while it's open, without starting one (logins.ts types into it).
export async function openBrowser(conversationId: string) {
  await liveView(conversationId);
  const live = await open.get(conversationId)?.catch(() => null);
  return live && Date.now() < live.ends ? live : null;
}

// The live view link while the chat has a browser open, for the chat screen. Never starts one.
export async function liveView(conversationId: string) {
  if (!open.has(conversationId)) {
    const found = find(conversationId);
    remember(conversationId, found);
    const live = await found.catch(() => null);
    // picked up after a restart: it still needs an idle stop
    if (live) idle(conversationId, live);
  }
  const live = await open.get(conversationId)?.catch(() => null);
  return live && Date.now() < live.ends ? live.liveUrl : null;
}

// The Live browser button: the chat's browser, started again if it stopped, on the page it was on. Sign-ins come
// back with it; other tabs and anything half typed don't.
export async function reopenBrowser(conversationId: string, owner: Owner, page: string | null) {
  const running = await liveView(conversationId);
  const live = await browserFor(conversationId, owner);
  if (!running && page) {
    await connectionFor(live, owner, decrypt(page)).catch((e) => console.error("browser connection not chosen:", e));
    await goTo(live.cdpUrl, decrypt(page)).catch((e) => console.error("browser page not restored:", e));
  }
  return live.liveUrl;
}

async function goTo(cdpUrl: string, url: string) {
  const cdp = await devtools(cdpUrl);
  try {
    const { targetInfos } = await cdp.send("Target.getTargets");
    const tab = (targetInfos as { targetId: string; type: string }[]).find((t) => t.type === "page");
    if (!tab) return;
    const { sessionId } = await cdp.send("Target.attachToTarget", { targetId: tab.targetId, flatten: true });
    await cdp.send("Page.navigate", { url }, sessionId);
  } finally {
    cdp.close();
  }
}

// --- which connection the browser goes online on ---------------------------------------------------------
// It starts on the free one, which sites see as a data centre abroad. The paid one is a home connection in the
// person's country, billed by the GB, so it's used only when needed: a site turned the browser away, it takes a sign-in
// (so it always sees one kind of address), or Emplio asked. The switch keeps tabs and sign-ins, and that browser stays
// on it until it closes. A browser service with no proxies (the open app's Docker one) just stays as it is.
const REMEMBERED_MS = 30 * 86_400_000;
const LONG_LIVED_MS = 7 * 86_400_000;
const SIGN_IN_COOKIE = /auth|sess|token|login|jwt|sid$/i;
const URLS = /(?:https?:\/\/|\bopen\s+["']?)([a-z0-9-]+(?:\.[a-z0-9-]+)+)/gi;

export const sitesIn = (text: string) => [...new Set([...text.matchAll(URLS)].map((m) => siteOf(m[1]!)))];

// ponytail: a guess from cookie names, wrong now and then on sites that keep a long anonymous session; that only costs some paid data
export const signedInSites = (cookies: Cookie[], now = Date.now()) =>
  new Set(cookies.filter((c) => c.httpOnly && SIGN_IN_COOKIE.test(c.name) && Number(c.expires) * 1000 > now + LONG_LIVED_MS).map((c) => siteOf(c.domain.replace(/^\./, ""))));

const rememberPaid = (workspaceId: string, site: string) =>
  db.insert(paidSites).values({ workspaceId, site }).onConflictDoUpdate({ target: [paidSites.workspaceId, paidSites.site], set: { seenAt: sql`now()` } });

// Any of these remembered and still fresh: using one keeps it fresh.
async function anyRemembered(workspaceId: string, sites: string[]) {
  const fresh = await db
    .update(paidSites)
    .set({ seenAt: sql`now()` })
    .where(and(eq(paidSites.workspaceId, workspaceId), inArray(paidSites.site, sites), gt(paidSites.seenAt, new Date(Date.now() - REMEMBERED_MS))))
    .returning({ site: paidSites.site });
  return fresh.length > 0;
}

// True only when this call moved it.
async function goPaid(live: LiveBrowser, owner: Owner) {
  if (live.paid) return false;
  live.paid = await cloud.browser.useProxy(live.id, owner).catch((e) => (console.error("browser connection not switched:", e), false));
  return live.paid;
}

// Before a browser command: a site that's known to need it (named in the command) goes on the paid connection first.
export async function connectionFor(live: LiveBrowser, owner: Owner, text: string) {
  if (live.paid) return;
  const sites = sitesIn(text);
  if (!sites.length) return;
  live.signedIn ??= signedInSites((await savedState(owner).catch(() => null))?.cookies ?? []);
  if (sites.some((s) => live.signedIn!.has(s)) || (await anyRemembered(owner.workspaceId, sites))) await goPaid(live, owner);
}

const pageCheck = z.object({ page: z.string().min(1).max(200), blocked: z.boolean(), signIn: z.boolean() });

// What a browser command saw on the page (base64 JSON from inside the computer, so checked). Returns what to add to its output.
export async function pageChecked(conversationId: string, workspaceId: string, encoded: string) {
  const got = pageCheck.safeParse(JSON.parse(Buffer.from(encoded, "base64").toString()));
  if (!got.success || !(got.data.blocked || got.data.signIn)) return null;
  const live = await openBrowser(conversationId);
  if (!live?.owner) return null;
  await rememberPaid(workspaceId, siteOf(got.data.page));
  const moved = await goPaid(live, live.owner);
  return moved && got.data.blocked
    ? `[${got.data.page} turned this browser away, so it has moved to a local connection in the person's country. Open the page again. If it's still refused, the site refuses automated browsers: say so rather than keep trying.]`
    : null;
}

// `emplio browser local`: url is the page it's on, remembered for next time.
export async function browserLocal(conversationId: string, workspaceId: string, url?: string) {
  const live = await openBrowser(conversationId);
  if (!live?.owner) return "emplio browser local: no browser open";
  if (live.paid) return "Already on the local connection.";
  const moved = await goPaid(live, live.owner);
  if (!moved) return "This browser has no other connection to move to.";
  if (url && /^https?:/.test(url)) await rememberPaid(workspaceId, siteOf(new URL(url).host));
  return "Now on a local connection in the person's country. Open the page again to use it.";
}

// A link on our own address for signing in from a phone (Telegram has no live view beside the chat): it
// opens the chat's live browser full screen, without showing the browser service's link. Good for an hour, and only
// while that browser is open. Null when this server has no public address.
// ponytail: anyone given the link within the hour can use that browser, like the live link itself
export const sig = (payload: string) => createHmac("sha256", process.env.ENCRYPTION_KEY!).update(`browser:${payload}`).digest("base64url");
export function signInLink(conversationId: string) {
  if (!process.env.WEBHOOK_URL) return null;
  const payload = `${conversationId}.${Date.now() + 3600_000}`;
  return `${process.env.WEBHOOK_URL}/browser/${conversationId}?t=${Date.now() + 3600_000}.${sig(payload)}`;
}

const page = (title: string, body: string) =>
  `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><style>html,body{margin:0;height:100%;background:#111;color:#eee;font:15px system-ui}iframe{border:0;width:100%;height:100%;display:block}p{padding:24px}</style>${body}`;

export async function browserRoutes(app: FastifyInstance) {
  app.get<{ Params: { id: string }; Querystring: { t?: string } }>("/browser/:id", async (req, reply) => {
    const [expires = "", given = ""] = (req.query.t ?? "").split(".");
    const want = Buffer.from(sig(`${req.params.id}.${expires}`));
    const ok = Buffer.from(given).length === want.length && timingSafeEqual(Buffer.from(given), want) && Number(expires) > Date.now();
    if (!ok) return reply.type("text/html").send(page("Link expired", "<p>This link has expired. Ask for a new one.</p>"));
    const live = await liveView(req.params.id);
    if (!live) return reply.type("text/html").send(page("Browser closed", "<p>This browser has closed. Ask for a new link.</p>"));
    return reply
      .type("text/html")
      .header("Referrer-Policy", "no-referrer")
      .send(page("Sign in", `<iframe src="${live.replace(/"/g, "&quot;")}" allow="autoplay; clipboard-read; clipboard-write"></iframe>`));
  });
}
