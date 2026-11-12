// Integrations we write ourselves, as a provider like Composio. Each app is connected with a key the person
// pastes (kept encrypted in our database) and its actions are plain functions. Add one: write it next to
// indiamart.ts, list it in APPS, and add it to catalog.ts with provider "own".
import { actionTitle, type ActionDetail, type KeyField } from "@emplio/shared";
import { createHmac, timingSafeEqual } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "../../db";
import { connections } from "../../db/schema";
import { decrypt, encrypt } from "../../secrets";
import { AppsError, type Provider } from "../types";
import { anthropic, google, openai, openrouter } from "./ai";
import { airtable } from "./airtable";
import { bing_webmaster } from "./bing_webmaster";
import { notion } from "./notion";
import { asana } from "./asana";
import { calendly } from "./calendly";
import { clickup } from "./clickup";
import { exa } from "./exa";
import { fireflies } from "./fireflies";
import { fly } from "./fly";
import { github } from "./github";
import { googlebusiness } from "./googlebusiness";
import { googlecalendar } from "./googlecalendar";
import { googledocs } from "./googledocs";
import { googleanalytics } from "./googleanalytics";
import { googlemeet } from "./googlemeet";
import { googlesearchconsole } from "./googlesearchconsole";
import { googlesheets } from "./googlesheets";
import { hostinger } from "./hostinger";
import { hubspot } from "./hubspot";
import { indiamart } from "./indiamart";
import { livekit } from "./livekit";
import { msg91 } from "./msg91";
import { neon } from "./neon";
import { plivo } from "./plivo";
import { razorpay } from "./razorpay";
import { sarvam } from "./sarvam";
import { slack } from "./slack";
import { stripe } from "./stripe";
import { swipe } from "./swipe";
import { todoist } from "./todoist";
import { vercel } from "./vercel";
import { zoom } from "./zoom";
import { zoho } from "./zoho";
import { zoho_books } from "./zoho_books";
import { zoho_invoice } from "./zoho_invoice";
import { zoho_mail } from "./zoho_mail";

export type OwnAction = {
  description: string;
  input: z.ZodObject;
  // input already checked against `input`; key is the decrypted login, connection the id its webhooks arrive under
  run(input: any, key: string, connection?: string): Promise<unknown>;
  // only looks things up: runs without asking the person first
  readOnly?: boolean;
};
// a login that runs out, and how to get the next one (seconds it lasts, as the app says)
export type OAuthTokens = { token: string; refreshToken?: string; expiresIn?: number };
// One delivery to /webhooks/app/<app>/<connection>[/<rest>], with the body as sent.
export type Delivery = { body: string; headers: Record<string, string | string[] | undefined>; connection: string; rest: string };
export type WebhookEvent = {
  // the app's delivery id, so a retry doesn't run twice
  id?: string;
  // the triggers it starts, by short name
  triggers: string[];
  // what the automation sees, and what its settings are checked against
  data: unknown;
  // the id automations are stored under, on an app-wide webhook
  watch?: string;
};
export type OwnApp = {
  app: string;
  name: string;
  logo: string;
  // how it's connected by pasting a key; left out, it's sign-in only and offered only where its OAuth app is set up
  keyField?: KeyField;
  // throws an AppsError if the key doesn't work; may answer whose account it is, to label the connection
  check(key: string): Promise<string | void>;
  // can also be signed in to on the app's own page (OAuth), where the server has our client id and secret
  oauth?: {
    ready(): boolean;
    authorizeUrl(redirect: string, state: string): string;
    // the login a finished sign-in's code is worth; a plain string never runs out. `callback`: all the app's page sent back (Zoho's data centre)
    exchange(code: string, redirect: string, callback: Record<string, unknown>): Promise<string | OAuthTokens>;
    // the app can't be told to always show its consent screen, so a sign-in only finishes in the browser that started it
    noConsentScreen?: boolean;
    // for apps whose logins run out: the next one. Throws AppsError(…, true) when the person has to sign in again
    refresh?(refreshToken: string): Promise<OAuthTokens>;
    // tells the app the person took Emplio's access away (disconnecting), so the token stops working there too
    revoke?(token: string): Promise<void>;
  };
  actions: Record<string, OwnAction>;
  // events the app tells us about the moment they happen
  push?: {
    // our trigger name → its event
    events: Record<string, string>;
    // the ones with no polled twin in polls/
    triggers: Record<string, { description: string; config?: ActionDetail["input"]; output: ActionDetail["input"] }>;
    // sets it up, and answers the id events arrive under
    start(key: string, connection: string, event: string, config: unknown): Promise<string>;
    // the last automation on that id is gone; apps that can't take a webhook back leave this out
    stop?(key: string, id: string): Promise<void>;
    // apps served by the shared webhook route. Null: not really from the app (401). `headers` and `reply` go on the
    // answer (a handshake); `events` runs after we've answered, so it may call the app.
    receive?(delivery: Delivery, key: string): Promise<{ headers?: Record<string, string>; reply?: unknown; events(): Promise<WebhookEvent[]> } | null>;
    // one address for the whole app, set in its developer settings (Slack, Zoom): /webhooks/app/<app>/events. No connection
    // is looked up, so key is "", and each event says which automations it's for in `watch`.
    appWide?: boolean;
    // whether this automation's settings want the event (default: yes)
    wanted?(config: unknown, data: unknown): boolean;
  };
};

export const APPS: Record<string, OwnApp> = { asana, clickup, indiamart, exa, fly, vercel, hostinger, fireflies, anthropic, openai, google, openrouter, sarvam, livekit, msg91, plivo, swipe, neon, razorpay, github, stripe, todoist, hubspot, calendly, notion, airtable, googlebusiness, googlecalendar, googledocs, googlesheets, googlemeet, googlesearchconsole, googleanalytics, slack, bing_webmaster, zoho_books, zoho_invoice, zoho_mail, zoho, zoom };

// An OAuth sign-in on its way: the connection waits under this id, so a sign-in can finish only once
const PENDING = "oauth-pending:";
const callbackUrl = (app: string, back: string) => `${new URL(back).origin}/oauth/${app}/callback`;
const stateSig = (payload: string) => createHmac("sha256", process.env.ENCRYPTION_KEY!).update(`oauth:${payload}`).digest("base64url");

// a login with less than this left is renewed before it's used
const MARGIN_MS = 60_000;
const untilExpiry = (t: OAuthTokens) => (t.expiresIn ? new Date(Date.now() + t.expiresIn * 1000) : null);

type Stored = { id: string; app: string; secret: string | null; refreshToken: string | null; expiresAt: Date | null };
const saveRenewed = async (id: string, values: Pick<Stored, "secret" | "refreshToken" | "expiresAt">) => {
  await db.update(connections).set({ ...values, updatedAt: new Date() }).where(eq(connections.id, id));
};

// One renewal per connection at a time: some apps cancel a refresh token the moment it's used, so a second call would log the person out.
// ponytail: per process; a lock in Postgres if the API ever runs on more than one machine
const renewing = new Map<string, Promise<string>>();

// A connection's login, decrypted, renewed first if it's about to run out.
export function freshSecret(c: Stored, save = saveRenewed): Promise<string | null> {
  const oauth = APPS[c.app]?.oauth;
  if (!c.secret) return Promise.resolve(null);
  if (!c.expiresAt || c.expiresAt.getTime() - Date.now() > MARGIN_MS || !c.refreshToken || !oauth?.refresh) return Promise.resolve(decrypt(c.secret));
  const ongoing = renewing.get(c.id);
  if (ongoing) return ongoing;
  const refreshToken = decrypt(c.refreshToken);
  const renew = oauth
    .refresh(refreshToken)
    .then(async (t) => {
      // apps that don't send a new refresh token mean the old one stays good
      await save(c.id, { secret: encrypt(t.token), refreshToken: encrypt(t.refreshToken ?? refreshToken), expiresAt: untilExpiry(t) });
      return t.token;
    })
    .finally(() => renewing.delete(c.id));
  renewing.set(c.id, renew);
  return renew;
}

const split = (action: string) => {
  const [app = "", name = ""] = action.split(".");
  return { def: APPS[app], action: APPS[app]?.actions[name] };
};

export const own: Provider = {
  name: "own",

  // sign-in-only apps need the server's OAuth app; without it they'd only be a dead button
  readyApps: async () => new Set(Object.values(APPS).filter((a) => a.keyField || a.oauth?.ready()).map((a) => a.app)),

  async getApp(app) {
    const a = APPS[app];
    return a ? { app, name: a.name, description: "", logo: a.logo, keyField: a.keyField, ...(a.oauth?.ready() && { signIn: true }) } : null;
  },

  mustStartHere: (app) => Boolean(APPS[app]?.oauth?.noConsentScreen),

  async listActions(app, words) {
    const terms = (words ?? "").toLowerCase().split(/\s+/).filter(Boolean);
    return Object.entries(APPS[app]?.actions ?? {})
      .map(([name, a]) => ({ action: `${app}.${name}`, description: a.description }))
      .filter((a) => terms.every((t) => `${a.action} ${a.description}`.toLowerCase().includes(t)));
  },

  async getAction(name) {
    const { action } = split(name);
    if (!action) return null;
    const schema = z.toJSONSchema(action.input, { io: "input" }) as { properties?: Record<string, any>; required?: string[] };
    return {
      action: name,
      app: name.split(".")[0]!,
      description: action.description,
      title: actionTitle(name),
      readOnly: action.readOnly,
      input: Object.entries(schema.properties ?? {}).map(([field, p]) => ({
        name: field,
        type: p.enum ? p.enum.join("|") : (p.type ?? "any"),
        required: schema.required?.includes(field) ?? false,
        description: p.description ?? "",
      })),
    };
  },

  async startSignIn(app, _owner, back) {
    const oauth = APPS[app]?.oauth;
    if (!oauth?.ready()) throw new AppsError(`${app} is connected with a key, in the app`);
    const nonce = crypto.randomUUID();
    const payload = Buffer.from(JSON.stringify({ app, n: nonce, back, e: Date.now() + 15 * 60_000 })).toString("base64url");
    return { externalId: `${PENDING}${nonce}`, url: oauth.authorizeUrl(callbackUrl(app, back), `${payload}.${stateSig(payload)}`) };
  },

  readSignIn(app, state) {
    const [payload = "", sig = ""] = state.split(".");
    const want = Buffer.from(stateSig(payload));
    if (Buffer.from(sig).length !== want.length || !timingSafeEqual(Buffer.from(sig), want)) return null;
    const s = JSON.parse(Buffer.from(payload, "base64url").toString()) as { app: string; n: string; back: string; e: number };
    return s.app === app && s.e > Date.now() ? { externalId: `${PENDING}${s.n}`, back: s.back } : null;
  },

  async finishSignIn(app, code, back, callback = {}) {
    const a = APPS[app]!;
    const got = await a.oauth!.exchange(code, callbackUrl(app, back), callback);
    const t = typeof got === "string" ? { token: got } : got;
    return { secret: t.token, label: (await a.check(t.token)) || null, refreshToken: t.refreshToken, expiresAt: untilExpiry(t) ?? undefined };
  },

  async connectWithKey(app, key) {
    const a = APPS[app];
    if (!a) throw new AppsError(`no app called ${app}`);
    if (!a.keyField) throw new AppsError(`${app} is connected by signing in, not with a key`);
    const trimmed = key.trim();
    if (!trimmed) throw new AppsError(`enter your ${a.keyField.label}`);
    const label = await a.check(trimmed);
    return { secret: trimmed, ...(label && { label }) };
  },

  // the key is in our database, so a connection is good until a call says otherwise
  signInStatus: async (externalId) => (externalId.startsWith(PENDING) ? "pending" : "active"),
  removeSignIn: async () => {},

  async run(name, input, login) {
    const { action } = split(name);
    // worded so a guessed name gets the closest real ones back (runAction)
    if (!action) throw new AppsError(`Tool ${name} not found`);
    if (!login?.secret) throw new AppsError("not connected");
    const parsed = action.input.safeParse(input ?? {});
    if (!parsed.success) throw new AppsError(parsed.error.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join("; "));
    return action.run(parsed.data, login.secret, login.externalId);
  },

  async listTriggers(app, words) {
    const terms = (words ?? "").toLowerCase().split(/\s+/).filter(Boolean);
    return Object.entries(APPS[app]?.push?.triggers ?? {})
      .map(([name, t]) => ({ action: `${app}.${name}`, description: t.description }))
      .filter((t) => terms.every((w) => `${t.action} ${t.description}`.toLowerCase().includes(w)));
  },

  async getTrigger(trigger) {
    const [app = "", name = ""] = trigger.split(".");
    const t = APPS[app]?.push?.triggers[name];
    return t ? { action: trigger, app, description: t.description, input: t.config ?? [], output: t.output } : null;
  },

  async startPush(trigger, login, config) {
    const [app = "", name = ""] = trigger.split(".");
    const push = APPS[app]?.push;
    const event = push?.events[name];
    return push && event && login.secret ? push.start(login.secret, login.externalId, event, config) : null;
  },

  // ids are <app>:<connection>[:...]
  async stopTrigger(id) {
    const [app = "", connection = ""] = id.split(":");
    const stop = APPS[app]?.push?.stop;
    if (!stop) return;
    const row = await db.query.connections.findFirst({ where: and(eq(connections.app, app), eq(connections.externalId, connection)) });
    const key = row && (await freshSecret(row));
    if (key) await stop(key, id);
  },
};
