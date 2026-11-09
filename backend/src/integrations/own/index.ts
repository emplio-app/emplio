// Integrations we write ourselves, as a provider like Composio. Each app is connected with a key the person
// pastes (kept encrypted in our database) and its actions are plain functions. Add one: write it next to
// indiamart.ts, list it in APPS, and add it to catalog.ts with provider "own".
import type { ActionDetail, KeyField } from "@emplio/shared";
import { createHmac, timingSafeEqual } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "../../db";
import { connections } from "../../db/schema";
import { decrypt } from "../../secrets";
import { AppsError, type Provider } from "../types";
import { anthropic, google, openai, openrouter } from "./ai";
import { exa } from "./exa";
import { fireflies } from "./fireflies";
import { fly } from "./fly";
import { github } from "./github";
import { hostinger } from "./hostinger";
import { indiamart } from "./indiamart";
import { livekit } from "./livekit";
import { msg91 } from "./msg91";
import { neon } from "./neon";
import { plivo } from "./plivo";
import { razorpay } from "./razorpay";
import { sarvam } from "./sarvam";
import { swipe } from "./swipe";
import { vercel } from "./vercel";

export type OwnAction = {
  description: string;
  input: z.ZodObject;
  // input already checked against `input`; key is the decrypted login
  run(input: any, key: string): Promise<unknown>;
  // only looks things up: runs without asking the person first
  readOnly?: boolean;
};
export type OwnApp = {
  app: string;
  name: string;
  logo: string;
  keyField: KeyField;
  // throws an AppsError if the key doesn't work; may answer whose account it is, to label the connection
  check(key: string): Promise<string | void>;
  // can also be signed in to on the app's own page (OAuth), where the server has our client id and secret
  oauth?: {
    ready(): boolean;
    authorizeUrl(redirect: string, state: string): string;
    // the login a finished sign-in's code is worth
    exchange(code: string, redirect: string): Promise<string>;
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
  };
};

const APPS: Record<string, OwnApp> = { indiamart, exa, fly, vercel, hostinger, fireflies, anthropic, openai, google, openrouter, sarvam, livekit, msg91, plivo, swipe, neon, razorpay, github };

// An OAuth sign-in on its way: the connection waits under this id, so a sign-in can finish only once
const PENDING = "oauth-pending:";
const callbackUrl = (app: string, back: string) => `${new URL(back).origin}/oauth/${app}/callback`;
const stateSig = (payload: string) => createHmac("sha256", process.env.ENCRYPTION_KEY!).update(`oauth:${payload}`).digest("base64url");

const split = (action: string) => {
  const [app = "", name = ""] = action.split(".");
  return { def: APPS[app], action: APPS[app]?.actions[name] };
};

export const own: Provider = {
  name: "own",

  readyApps: async () => new Set(Object.keys(APPS)),

  async getApp(app) {
    const a = APPS[app];
    return a ? { app, name: a.name, description: "", logo: a.logo, keyField: a.keyField, ...(a.oauth?.ready() && { signIn: true }) } : null;
  },

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

  async finishSignIn(app, code, back) {
    const a = APPS[app]!;
    const secret = await a.oauth!.exchange(code, callbackUrl(app, back));
    return { secret, label: (await a.check(secret)) || null };
  },

  async connectWithKey(app, key) {
    const a = APPS[app];
    if (!a) throw new AppsError(`no app called ${app}`);
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
    return action.run(parsed.data, login.secret);
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
    if (row?.secret) await stop(decrypt(row.secret), id);
  },
};
