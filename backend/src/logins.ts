// Saved passwords and keys: a person types them into
// our own form (in the web chat, or a private link from Telegram), they're kept encrypted (secrets.ts), and the
// AI only ever knows their names. The server types a password into the chat's browser (`emplio logins fill`) or
// swaps a key into a request (`emplio http`, `{{NAME}}`), and only on the site it was saved for (or a subdomain).
// The value is never handed to the sandbox, the chat or the model, and anything a site echoes back is scrubbed. But once
// it's typed into a page, the agent can read it back from that browser (the field, or the cookies the sign-in left).
// Logins and keys in the person's connected 1Password (integrations/own/onepassword.ts) are listed and used the same
// way, read from 1Password each time; a saved one wins a clash of names (the 1Password one gets _1PASSWORD).
// ponytail: each person's own; shared company keys (an admin saves one for everyone) when someone needs them.
// Top frame only: a login form inside an iframe from another site isn't filled.
import { and, desc, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { networkInterfaces } from "node:os";
import { DEFAULT_LOGIN_FIELDS, isSecretField, type Login, type LoginInput, type LoginKind, type OnePasswordStatus, type SaveLoginCard } from "@emplio/shared";
import { record } from "./activity";
import { context } from "./auth";
import { devtools, openBrowser } from "./browser";
import { isDeviceBrowser } from "./device-browser";
import { db } from "./db";
import { connections, logins } from "./db/schema";
import { onepassword, onePasswordItems, onePasswordValues } from "./integrations/own/onepassword";
import { decrypt, encrypt } from "./secrets";

// The web app's address as a phone can open it. In dev FRONTEND_URL is localhost, which on a phone means the
// phone itself, so swap in this Mac's wifi address (the phone must be on the same wifi). Production sets a real one.
// ponytail: wifi only in dev; the tunnel can't carry the app because dev login uses a fixed code.
export function phoneAppUrl(url = process.env.FRONTEND_URL ?? "http://localhost:3000") {
  const lan = Object.values(networkInterfaces()).flat().find((a) => a && a.family === "IPv4" && !a.internal)?.address;
  return lan ? url.replace(/\/\/(localhost|127\.0\.0\.1)(?=[:/]|$)/, `//${lan}`) : url;
}

type Who = { workspaceId: string; userId: string };
type Row = typeof logins.$inferSelect;

const own = (w: Who) => and(eq(logins.workspaceId, w.workspaceId), eq(logins.userId, w.userId));
const toLogin = (r: Row): Login => ({
  id: r.id,
  name: r.name,
  kind: r.kind,
  site: r.site,
  username: r.username,
  fields: r.fields,
  usedAt: r.usedAt?.toISOString() ?? null,
  createdAt: r.createdAt.toISOString(),
});

// "vercel password" → VERCEL_PASSWORD; "https://www.Vercel.com/login" → vercel.com
export const nameOf = (s: string) => s.trim().toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 64);
export function siteOf(s: string) {
  const t = s.trim().toLowerCase();
  try {
    return new URL(t.includes("://") ? t : `https://${t}`).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}
const onSite = (host: string, site: string) => host === site || host.endsWith(`.${site}`);

const savedLogins = async (w: Who) => (await db.select().from(logins).where(own(w)).orderBy(desc(logins.updatedAt))).map(toLogin);

// The person's 1Password items as logins, named so they don't clash with saved ones or each other. Null: not connected.
async function onePassword(w: Who, saved: Login[]) {
  const found = await onePasswordItems(w);
  if (!found) return null;
  const taken = new Set(saved.map((l) => l.name));
  const named: Login[] = [];
  for (const item of found.items) {
    const base = nameOf(item.title) || "ITEM";
    let name = taken.has(base) ? `${base}_1PASSWORD` : base;
    for (let n = 2; taken.has(name); n++) name = `${base}_${n}`;
    taken.add(name);
    named.push({ id: item.id, name, kind: item.kind, site: item.site, username: item.username, fields: item.fields, usedAt: null, createdAt: "", from: "1password" });
  }
  return { logins: named, skipped: found.skipped };
}

// Saved ones first, then 1Password's (left out, with the reason, when it can't be read)
async function allLogins(w: Who) {
  const saved = await savedLogins(w);
  try {
    const op = await onePassword(w, saved);
    return { all: [...saved, ...(op?.logins ?? [])], op, error: null };
  } catch (error) {
    return { all: saved, op: null, error: error instanceof Error ? error.message : String(error) };
  }
}

export async function listLogins(w: Who) {
  return (await allLogins(w)).all;
}

export async function onePasswordStatus(w: Who): Promise<OnePasswordStatus> {
  const [row] = await db
    .select()
    .from(connections)
    .where(and(eq(connections.workspaceId, w.workspaceId), eq(connections.userId, w.userId), eq(connections.app, "onepassword"), eq(connections.status, "active")));
  const keyField = onepassword.keyField!;
  if (!row) return { connection: null, label: null, items: 0, skipped: 0, error: null, keyField };
  const { op, error } = await allLogins(w);
  return { connection: row.id, label: row.label, items: op?.logins.length ?? 0, skipped: op?.skipped ?? 0, error, keyField };
}

// Saving one under a name that's taken replaces it (a changed password).
export async function saveLogin(w: Who, input: LoginInput) {
  const name = nameOf(input.name);
  const site = siteOf(input.site);
  if (!name) return { ok: false as const, error: "give it a name, like VERCEL" };
  if (!site) return { ok: false as const, error: "the website should look like vercel.com" };
  // a login: whichever fields that site asks for, empty ones left out
  const fields = Object.entries(input.fields ?? {}).filter(([label, text]) => label.trim() && text);
  if (input.kind === "login" ? !fields.length : !input.value) return { ok: false as const, error: input.kind === "login" ? "fill in at least one field" : "the key is empty" };
  const values =
    input.kind === "login"
      ? {
          kind: input.kind,
          site,
          username: fields.find(([label]) => !isSecretField(label))?.[1].trim() ?? null,
          fields: fields.map(([label]) => label.trim()),
          value: encrypt(JSON.stringify(Object.fromEntries(fields))),
          updatedAt: new Date(),
        }
      : { kind: input.kind, site, username: null, fields: [], value: encrypt(input.value!), updatedAt: new Date() };
  const [row] = await db
    .insert(logins)
    .values({ workspaceId: w.workspaceId, userId: w.userId, name, ...values })
    .onConflictDoUpdate({ target: [logins.workspaceId, logins.userId, logins.name], set: values })
    .returning();
  record({ workspaceId: w.workspaceId, userId: w.userId, kind: "connection", summary: `Saved ${input.kind === "login" ? "the login" : "the key"} ${name} for ${site}` });
  return { ok: true as const, login: toLogin(row!) };
}

export async function removeLogin(w: Who, idOrName: string) {
  const match = /^[0-9a-f-]{36}$/.test(idOrName) ? eq(logins.id, idOrName) : eq(logins.name, nameOf(idOrName));
  const [row] = await db.delete(logins).where(and(own(w), match)).returning();
  if (row) record({ workspaceId: w.workspaceId, userId: w.userId, kind: "connection", summary: `Removed the saved ${row.kind} ${row.name}` });
  return !!row;
}

// A login or key by name, wherever it's kept: what it's for, and its values only when asked for
type Entry = { name: string; kind: LoginKind; site: string; values(): Promise<Record<string, string>>; used(): Promise<unknown> };
const savedEntry = (row: Row): Entry => ({
  name: row.name,
  kind: row.kind,
  site: row.site,
  values: async () => (row.kind === "key" ? { "the key": decrypt(row.value) } : JSON.parse(decrypt(row.value))),
  used: () => db.update(logins).set({ usedAt: new Date() }).where(eq(logins.id, row.id)),
});
async function find(w: Who, name: string): Promise<Entry | undefined> {
  const row = await db.query.logins.findFirst({ where: and(own(w), eq(logins.name, nameOf(name))) });
  if (row) return savedEntry(row);
  const op = (await allLogins(w)).all.find((l) => l.from === "1password" && l.name === nameOf(name));
  return op && { name: op.name, kind: op.kind, site: op.site, values: () => onePasswordValues(w, op.id), used: async () => {} };
}

// --- typing into the chat's browser, over its DevTools connection -------------------------------------------

// Runs in the page: focus the field for a saved login's `label` ("Email", "Phone", "Password"), or with no label
// the focused one, and select what's in it so typing replaces it. Fields already typed into are skipped.
const FOCUS = (label: string | null) => `(() => {
  const want = ${JSON.stringify(label?.toLowerCase() ?? null)};
  const ok = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && !e.disabled && !e.readOnly && getComputedStyle(e).visibility !== "hidden"; };
  let el = document.activeElement;
  if (want !== null) {
    const inputs = [...document.querySelectorAll("input")].filter((e) => ok(e) && !e.dataset.ezFilled && !["hidden", "checkbox", "radio", "submit", "button"].includes(e.type));
    const about = (e) => [e.name, e.id, e.placeholder, e.getAttribute("aria-label"), e.autocomplete, e.type, ...[...(e.labels ?? [])].map((l) => l.textContent)].join(" ").toLowerCase();
    const words = want.split(/[^a-z0-9]+/).filter((w) => w.length > 2 && w !== "the" && w !== "your");
    const hint = (e) => /pass/.test(want) ? e.type === "password"
      : /mail/.test(want) ? e.type === "email" || /email|username/.test(e.autocomplete)
      : /phone|mobile/.test(want) ? e.type === "tel" || /tel/.test(e.autocomplete)
      : /user|login|account|id\\b/.test(want) ? /username/.test(e.autocomplete) : false;
    const score = (e) => (hint(e) ? 5 : 0) + words.filter((w) => about(e).includes(w)).length * 2 - (e.type === "password" && !/pass|pin|secret/.test(want) ? 10 : 0);
    el = inputs.map((e) => [e, score(e)]).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1])[0]?.[0];
  }
  if (!el || !("value" in el)) return false;
  el.focus();
  // empty it first, through the native setter so React-style pages see the change: a refill must never leave
  // the old text in (select-and-type alone didn't reliably replace it)
  const proto = el instanceof HTMLInputElement ? HTMLInputElement.prototype : el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : null;
  if (proto) {
    Object.getOwnPropertyDescriptor(proto, "value")?.set?.call(el, "");
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }
  if (el.dataset) el.dataset.ezFilled = "1";
  return true;
})()`;

type Cdp = Awaited<ReturnType<typeof devtools>>;
// Where a login's boxes can be: the page and the frames in it on the same site (Apple's sign-in sits in an
// idmsa.apple.com frame on appstoreconnect.apple.com). Frames of other sites never get a saved login typed into them.
// Same-process frames are reached through a world of our own in them; frames in their own process (another site's
// process, as the browser decides) through their own DevTools session.
// ponytail: "same company" is the site's parent domain unless that looks like a country's suffix (co.uk); a public
// suffix list would be exact if a login ever lands on a shared host
const parentOf = (site: string) => {
  const base = site.split(".").slice(1).join(".");
  return base.includes(".") && !/^(co|com|net|org|gov|edu|ac|ne|or)\.[a-z]{2}$/.test(base) ? base : site;
};
async function framesOnSite(cdp: Cdp, sessionId: string, loginSite: string) {
  const site = parentOf(loginSite);
  const at = (session: string, contextId?: number) => ({
    run: async (expression: string) => (await cdp.send("Runtime.evaluate", { expression, returnByValue: true, ...(contextId ? { contextId } : {}) }, session)).result?.value,
  });
  const frames = [at(sessionId)];
  type Frame = { frame: { id: string; url: string; parentId?: string }; childFrames?: Frame[] };
  const walk = (n: Frame): Frame["frame"][] => [n.frame, ...(n.childFrames ?? []).flatMap(walk)];
  const { frameTree } = await cdp.send("Page.getFrameTree", {}, sessionId);
  for (const f of walk(frameTree).filter((f) => f.parentId && onSite(siteOf(f.url), site))) {
    const made = await cdp.send("Page.createIsolatedWorld", { frameId: f.id, worldName: "emplio-fill" }, sessionId).catch(() => null);
    if (made) frames.push(at(sessionId, made.executionContextId));
  }
  const children: string[] = [];
  cdp.on((method, p) => {
    if (method === "Target.attachedToTarget" && p.targetInfo?.type === "iframe" && onSite(siteOf(p.targetInfo.url), site)) children.push(p.sessionId);
  });
  await cdp.send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }, sessionId).catch(() => {});
  await Bun.sleep(300);
  for (const child of children) frames.push(at(child));
  return frames;
}

// The browser in the Mac app is refused by some sites' robot checks (GoDaddy: the button does nothing, or "your browser
// is a bit unusual"); the real Chrome its toolbar opens is not. Retrying only makes the site surer it's a robot.
const MAC_SIGN_IN = ` If the sign-in still doesn't go through after 2 tries (the button does nothing, it keeps loading, or the site says the browser is unusual or there were too many attempts), stop trying and ask the person to press "Take control", then "Sign in with Chrome" at the top of the browser, sign in in the Chrome window that opens, then press "Done signing in"; their sign-in comes back to this browser.`;

// Fill a saved login into the chat's open tab on its site: each of its fields the page has a box for. Sites that
// ask on two pages: fill, press Next, fill again. With `field`, only that one, typed into the box that has focus
// (for a page whose boxes can't be told apart). A key is always typed into the focused box.
export async function fill(w: Who, conversationId: string, name: string, field?: string) {
  const row = await find(w, name);
  if (!row) return `error: nothing saved as ${nameOf(name)} (emplio logins list)`;
  const live = await openBrowser(conversationId);
  if (!live) return `error: no browser is open in this chat; open ${row.site} with emplio browser first`;
  const cdp = await devtools(live.cdpUrl);
  try {
    const { targetInfos } = await cdp.send("Target.getTargets");
    const pages = (targetInfos as { targetId: string; type: string; url: string }[]).filter((t) => t.type === "page");
    const tab = pages.find((t) => onSite(siteOf(t.url), row.site));
    if (!tab) return `error: ${nameOf(name)} is for ${row.site}, and no open tab is on it (${pages.map((t) => siteOf(t.url) || t.url).join(", ") || "none"})`;
    const { sessionId } = await cdp.send("Target.attachToTarget", { targetId: tab.targetId, flatten: true });
    const run = async (expression: string) => (await cdp.send("Runtime.evaluate", { expression, returnByValue: true }, sessionId)).result?.value;
    // the page itself, not just the tab's address: it could have moved on
    if (!onSite(String(await run("location.hostname")), row.site)) return `error: that tab has left ${row.site}`;
    const frames = await framesOnSite(cdp, sessionId, row.site);
    const inFrames = async (expression: string) => {
      for (const f of frames) if (await f.run(expression).catch(() => false)) return true;
      return false;
    };
    const saved = await row.values().catch((error: Error) => error);
    if (saved instanceof Error) return `error: ${saved.message}`;
    const pick = field && Object.keys(saved).find((label) => label.toLowerCase() === field.toLowerCase());
    if (field && !pick) return `error: ${nameOf(name)} has no field "${field}"; it has ${Object.keys(saved).join(", ")}`;
    const filled: string[] = [];
    await inFrames(`document.querySelectorAll("[data-ez-filled]").forEach((e) => delete e.dataset.ezFilled), false`);
    for (const [label, text] of Object.entries(saved)) {
      if (pick ? label !== pick : false) continue;
      if (!(await inFrames(FOCUS(row.kind === "key" || pick ? null : label)))) continue;
      // typed into whichever frame has focus, by the page's own keyboard
      await cdp.send("Input.insertText", { text }, sessionId);
      filled.push(label);
    }
    const missed = Object.keys(saved).filter((label) => !filled.includes(label));
    if (!filled.length)
      return `error: found no box for ${row.kind === "key" || pick ? "it; click into the box first" : `${missed.join(", ")} on ${siteOf(tab.url)}; go to the sign-in page, or click into a box and use emplio logins fill ${nameOf(name)} "<field>"`}`;
    await row.used();
    record({ workspaceId: w.workspaceId, userId: w.userId, conversationId, kind: "connection", summary: `Filled ${nameOf(name)} on ${row.site}` });
    return `filled ${filled.join(", ")} on ${siteOf(tab.url)}${missed.length && !pick ? ` (no box yet for ${missed.join(", ")}: press Next, then fill again)` : ""}. Now press the sign-in or next button yourself.${isDeviceBrowser(live.id) ? MAC_SIGN_IN : ""}`;
  } finally {
    cdp.close();
  }
}

// --- requests with a key in them -------------------------------------------------------------------------

// `emplio http [-X METHOD] <url> [-H "Name: value"]... [-d body]`, with {{NAME}} anywhere: the server makes the request,
// swapping each name for its value, only when the address is on that key's site. The answer comes back with the
// values blanked out again.
export async function http(w: Who, conversationId: string, args: string[]) {
  let method = "GET";
  let url = "";
  let body: string | undefined;
  const headers = new Headers();
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "-X") method = (args[++i] ?? "GET").toUpperCase();
    else if (a === "-H") {
      const h = args[++i] ?? "";
      const at = h.indexOf(":");
      if (at > 0) headers.append(h.slice(0, at).trim(), h.slice(at + 1).trim());
    } else if (a === "-d") {
      body = args[++i] ?? "";
      if (method === "GET") method = "POST";
    } else if (!url) url = a;
  }
  if (!/^https:\/\//.test(url)) return `error: give an https address. ${HTTP_USAGE}`;
  const host = siteOf(url);
  const keys = await withKeys(w, host, [url, body ?? "", ...[...headers].map(([k, v]) => `${k}${v}`)]);
  if (typeof keys === "string") return keys;
  const { put, scrub, wanted, swaps } = keys;
  const sent = new Headers();
  for (const [k, v] of headers) sent.append(k, put(v));
  const r = await fetch(put(url), { method, headers: sent, body: body === undefined ? undefined : put(body), redirect: "manual", signal: AbortSignal.timeout(60_000) }).catch(
    (error: Error) => error,
  );
  if (r instanceof Error) return `error: ${scrub(r.message)}`;
  if (swaps.length) record({ workspaceId: w.workspaceId, userId: w.userId, conversationId, kind: "connection", summary: `Used ${wanted.join(", ")} on ${host}` });
  const location = r.headers.get("location");
  return scrub(`HTTP ${r.status}${location ? `\nlocation: ${location}` : ""}\n${await r.text()}`);
}

// The {{NAME}}s in these texts, swapped for this person's saved keys (only ones saved for `host`): `put` fills
// them in, `scrub` blanks the values out of whatever comes back. A string: why not (nothing saved, wrong site).
export async function withKeys(w: Who, host: string, texts: string[]) {
  const named = (text: string) => [...text.matchAll(/\{\{([A-Z0-9_]+)\}\}/g)].map((m) => m[1]!);
  const wanted = [...new Set(texts.flatMap(named))];
  if (!wanted.length) return { put: (t: string) => t, scrub: (t: string) => t, wanted, swaps: [] as [string, string][] };
  const swaps: [string, string][] = [];
  for (const name of wanted) {
    const row = await find(w, name);
    if (!row) return `error: nothing saved as ${name} (emplio logins list)`;
    if (!onSite(host, row.site)) return `error: ${name} is only for ${row.site}, not ${host}`;
    const values = await row.values().catch((error: Error) => error);
    if (values instanceof Error) return `error: ${values.message}`;
    swaps.push([`{{${name}}}`, row.kind === "key" ? values["the key"]! : JSON.stringify(values)]);
    await row.used();
  }
  const put = (text: string) => swaps.reduce((t, [k, v]) => t.replaceAll(k, v), text);
  const scrub = (text: string) => swaps.reduce((t, [k, v]) => (v ? t.replaceAll(v, k) : t), text);
  return { put, scrub, wanted, swaps };
}

// --- the emplio command --------------------------------------------------------------------------------------

const HTTP_USAGE = `usage: emplio http [-X METHOD] <https url> [-H "Header: value"]... [-d body]   with {{NAME}} for a saved key`;
const USAGE = `usage: emplio logins list                     saved logins and keys (names, sites, usernames; never the values)
       emplio logins ask <NAME> --site <site> --fields "Email,Password"
                                          a button (web) or private link (phone) for the person to save one, with
                                          the boxes that site's sign-in page has, labelled as there ("Phone",
                                          "Username,Password,PIN"); never one-time codes. Saving a taken name replaces it.
       emplio logins ask <NAME> --site <api host> --key   the same for an API key or token
       emplio logins fill <NAME> ["<field>"]  type it into this chat's browser tab on its site (then press the button);
                                          with a field, just that one into the box you clicked
       emplio logins remove <NAME>           delete it
${HTTP_USAGE}`;

export async function loginsCommand(w: Who, conversationId: string, channel: string | undefined, args: string[]): Promise<string | { text: string; card: SaveLoginCard }> {
  const [sub, ...rest] = args;
  const words = rest.filter((a, i) => !a.startsWith("--") && !["--site", "--fields"].includes(rest[i - 1] ?? ""));
  const site = rest[rest.indexOf("--site") + 1];
  const fields = rest.includes("--fields") ? (rest[rest.indexOf("--fields") + 1] ?? "").split(",").map((f) => f.trim()).filter(Boolean).slice(0, 6) : [];
  if (sub === "list") {
    const { all, op, error } = await allLogins(w);
    const notes = [
      error && `(1Password couldn't be read: ${error})`,
      op?.skipped && `(${op.skipped} more in 1Password have no website or aren't a login or key; the person can add a website to an item there to use it)`,
    ].filter(Boolean);
    if (!all.length) return ["Nothing saved yet.", ...notes].join("\n");
    return [
      ...all.map((l) =>
        [l.name, l.kind, l.site, l.kind === "login" ? `${l.username ?? ""} (${l.fields.join(", ")})` : "", l.from === "1password" ? "in 1Password" : l.usedAt ? `last used ${l.usedAt.slice(0, 10)}` : "never used"].join("\t"),
      ),
      ...notes,
    ].join("\n");
  }
  if (sub === "ask" && words[0] && rest.includes("--site") && site) {
    const kind: LoginKind = rest.includes("--key") ? "key" : "login";
    const card: SaveLoginCard = { name: nameOf(words[0]), kind, site: siteOf(site), ...(kind === "login" ? { fields: fields.length ? fields : DEFAULT_LOGIN_FIELDS } : {}) };
    if (!card.name || !card.site) return USAGE;
    if (channel && channel !== "web") {
      const q = new URLSearchParams({ save: card.name, site: card.site, kind: card.kind, ...(card.fields ? { fields: card.fields.join(",") } : {}) });
      return `Send them this private link to save it (they sign in to the web app first): ${phoneAppUrl()}/logins?${q}. Once they say it's saved, use it.`;
    }
    return { text: `A "Save ${card.kind === "key" ? "key" : "login"} for ${card.site}" button is now in the chat. Once they say it's saved, use it.`, card };
  }
  if (sub === "fill" && words[0]) return fill(w, conversationId, words[0], words[1]);
  if (sub === "remove" && words[0]) return (await removeLogin(w, words[0])) ? "removed" : `error: nothing saved as ${nameOf(words[0])}`;
  return USAGE;
}

export async function loginRoutes(app: FastifyInstance) {
  app.get("/logins", async (req, reply) => {
    const ctx = await context(req, reply);
    if (!ctx) return;
    return listLogins(ctx);
  });

  app.get("/logins/onepassword", async (req, reply) => {
    const ctx = await context(req, reply);
    if (!ctx) return;
    return onePasswordStatus(ctx);
  });

  app.post<{ Body: LoginInput }>(
    "/logins",
    {
      schema: {
        body: {
          type: "object",
          required: ["name", "kind", "site"],
          properties: {
            name: { type: "string", maxLength: 100 },
            kind: { type: "string", enum: ["login", "key"] },
            site: { type: "string", maxLength: 300 },
            fields: { type: "object", maxProperties: 6, propertyNames: { maxLength: 60 }, additionalProperties: { type: "string", maxLength: 1000 } },
            value: { type: "string", maxLength: 4000 },
          },
        },
      },
    },
    async (req, reply) => {
      const ctx = await context(req, reply);
      if (!ctx) return;
      const r = await saveLogin(ctx, req.body);
      return r.ok ? r.login : reply.code(400).send({ error: r.error });
    },
  );

  app.delete<{ Params: { id: string } }>("/logins/:id", async (req, reply) => {
    const ctx = await context(req, reply);
    if (!ctx) return;
    return (await removeLogin(ctx, req.params.id)) ? { ok: true } : reply.code(404).send({ error: "Not found" });
  });
}

if (import.meta.main) {
  console.assert(nameOf("vercel password") === "VERCEL_PASSWORD");
  console.assert(siteOf("https://www.Vercel.com/login") === "vercel.com");
  console.assert(siteOf("api.vercel.com") === "api.vercel.com");
  console.assert(onSite("api.vercel.com", "vercel.com") && !onSite("evilvercel.com", "vercel.com"));
  // the page script parses, and the marks it sets (dataset.ezFilled) are the ones fill() clears
  new Function(FOCUS("Password"));
  console.assert(FOCUS(null).includes("dataset.ezFilled") && fill.toString().includes("[data-ez-filled]"), "fill clears the marks FOCUS sets");
  console.assert(phoneAppUrl("https://app.example.com") === "https://app.example.com");
  console.assert(!phoneAppUrl("http://localhost:3000").includes("localhost") || !Object.values(networkInterfaces()).flat().some((a) => a && !a.internal && a.family === "IPv4"));
  console.log("ok");
}
