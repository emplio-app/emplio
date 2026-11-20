// Composio as a provider: it holds the sign-ins and runs its ready-made actions for hundreds of apps.
// Only the REST API, no SDK.
// Its names map to ours mechanically: toolkit "zoho_books" = app "zoho_books",
// tool "ZOHO_BOOKS_CREATE_INVOICE" = action "zoho_books.create_invoice".
import type { Connection } from "@emplio/shared";
import { createHash } from "node:crypto";
import { AppFile, AppsError, mapDeep, type Provider } from "./types";

const BASE = "https://backend.composio.dev/api/v3.1";
type Json = Record<string, any>;

async function call(method: string, path: string, body?: unknown): Promise<Json> {
  if (!process.env.COMPOSIO_API_KEY) throw new AppsError("apps aren't set up on this server (COMPOSIO_API_KEY)");
  const res = await fetch(BASE + path, {
    method,
    headers: { "x-api-key": process.env.COMPOSIO_API_KEY, ...(body !== undefined && { "content-type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  });
  const data = await res.json().catch(() => null);
  if (res.ok) return data ?? {};
  // no JSON: its firewall refused it before its API saw it; happened to a commit of several code files at once
  if (!data) throw new AppsError(`Composio's firewall refused the request (HTTP ${res.status}); if it carries files or code, send them one at a time`);
  const message: string = data.error?.message ?? `HTTP ${res.status}`;
  // a bad API key is our problem, not the person's sign-in
  if (res.status === 401 || res.status === 403) throw new Error(`Composio: ${message}`);
  if (/no connected account/i.test(message)) throw new AppsError("not connected");
  throw new AppsError(message, mayBeSignedOut(message));
}

// Words that may mean the login is gone. Only a hint: the connection is marked expired only once Composio's own
// status for it says so (runAction), since "the file may have expired" or a 401 from one call says nothing about the login.
const mayBeSignedOut = (message: string) => /expired|inactive|revoked|unauthori[sz]ed|invalid.{0,20}(credential|token|grant|auth)|\b401\b/i.test(message);

const toSlug = (action: string) => action.replace(".", "_").toUpperCase();

// Composio's actions take files from its own storage: upload each, then pass where it went.
const uploadFiles = (input: unknown, action: string) =>
  mapDeep(input, async (v) => {
    if (!(v instanceof AppFile)) return undefined;
    const up = await call("POST", "/files/upload/request", {
      toolkit_slug: action.split(".")[0],
      tool_slug: toSlug(action),
      filename: v.name,
      mimetype: v.mimetype,
      md5: createHash("md5").update(v.bytes).digest("hex"),
    });
    const put = await fetch(up.new_presigned_url, { method: "PUT", headers: { "content-type": v.mimetype }, body: new Blob([new Uint8Array(v.bytes)]) });
    if (!put.ok) throw new AppsError(`uploading ${v.name} failed (HTTP ${put.status})`);
    return { name: v.name, mimetype: v.mimetype, s3key: up.key };
  });
// ...and hand files back the same way (an email attachment): a link to its storage, fetched here.
const MAX_FILE = 25 * 1024 * 1024;
const downloadFiles = (output: unknown) =>
  mapDeep(output, async (v) => {
    const f = v as { name?: unknown; mimetype?: unknown; s3url?: unknown } | null;
    if (!f || typeof f !== "object" || typeof f.s3url !== "string" || typeof f.name !== "string") return undefined;
    const res = await fetch(f.s3url);
    if (!res.ok) throw new AppsError(`downloading ${f.name} failed (HTTP ${res.status})`);
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.length > MAX_FILE) throw new AppsError(`${f.name} is over 25 MB`);
    return new AppFile(f.name, typeof f.mimetype === "string" ? f.mimetype : "application/octet-stream", bytes);
  });
// ponytail: untagged tools fall back to the verb in their name (GMAIL_SEARCH_PEOPLE, NOTION_LIST_...)
const READ_VERB = /_(GET|LIST|SEARCH|FETCH|FIND|READ|QUERY|RETRIEVE|DESCRIBE|COUNT|WHO_AM_I)(_|$)/;
const readOnly = (slug: string, tags: string[]) =>
  tags.includes("readOnlyHint") || (!tags.some((t) => /^(create|update|destructive)Hint$/.test(t)) && READ_VERB.test(slug));
const toAction = (slug: string, app: string) => `${app}.${slug.slice(app.length + 1).toLowerCase()}`;
const firstLine = (s = "") => s.split(/(?<=\.)\s|\n/)[0]!.slice(0, 160);
const toApp = (t: Json) => ({ app: t.slug as string, name: t.name as string, description: firstLine(t.meta?.description), logo: t.meta?.logo as string | undefined });

// The app's login setup from Composio's dashboard: your own one (your OAuth app or keys) wins over
// Composio's, newest first. None: the app isn't offered (see catalog.ts), so it can't be connected. Looked up on every sign-in, so a change in the
// dashboard applies to the next connect or reconnect; existing logins keep the setup they were made with.
async function authConfigFor(app: string) {
  const { items = [] } = await call("GET", `/auth_configs?${new URLSearchParams({ toolkit_slug: app })}`);
  const enabled = (items as Json[])
    .filter((c) => c.status !== "DISABLED")
    .sort((x, y) => Number(x.is_composio_managed) - Number(y.is_composio_managed) || String(y.created_at).localeCompare(String(x.created_at)));
  if (!enabled[0]) throw new AppsError(`${app} isn't set up for connecting yet`);
  return enabled[0].id as string;
}

const STATUS: Record<string, Connection["status"]> = { ACTIVE: "active", EXPIRED: "expired", FAILED: "failed", INACTIVE: "expired" };

export const composio: Provider = {
  name: "composio",

  async readyApps() {
    // no account here is normal on a self-hosted install: no apps from Composio, and the apps with a pasted key still show
    if (!process.env.COMPOSIO_API_KEY) return new Set<string>();
    // ponytail: first 200 login setups; page through next_cursor if a project ever has more
    const { items = [] } = await call("GET", "/auth_configs?limit=200");
    return new Set((items as Json[]).filter((c) => c.status !== "DISABLED").map((c) => c.toolkit?.slug));
  },

  async getApp(app) {
    const t = await call("GET", `/toolkits/${encodeURIComponent(app)}`).catch((e) => {
      if (e instanceof AppsError) return null;
      throw e;
    });
    return t?.slug ? toApp(t) : null;
  },

  async listActions(app, words) {
    const query = new URLSearchParams({ toolkit_slug: app, limit: "100", ...(words && { search: words }) });
    const { items = [] } = await call("GET", `/tools?${query}`);
    return items.map((t: Json) => ({ action: toAction(t.slug, app), description: firstLine(t.description) }));
  },

  async getAction(action) {
    const t = await call("GET", `/tools/${encodeURIComponent(toSlug(action))}`).catch((e) => {
      if (e instanceof AppsError) return null;
      throw e;
    });
    if (!t) return null;
    return {
      action: toAction(t.slug, t.toolkit.slug),
      app: t.toolkit.slug,
      description: t.description,
      input: fields(t.input_parameters),
      title: t.name,
      readOnly: readOnly(t.slug, t.tags ?? []),
    };
  },

  async startSignIn(app, owner, returnUrl) {
    const out = await call("POST", "/connected_accounts/link", { auth_config_id: await authConfigFor(app), user_id: owner, callback_url: returnUrl });
    return { externalId: out.connected_account_id, url: out.redirect_url };
  },

  async signInStatus(externalId) {
    const { status } = await call("GET", `/connected_accounts/${encodeURIComponent(externalId)}`);
    return STATUS[status] ?? "pending";
  },

  // Google and some others report the account's address; most apps don't
  async accountName(externalId) {
    const account = await call("GET", `/connected_accounts/${encodeURIComponent(externalId)}`);
    const name = account.data?.displayName ?? account.state?.val?.displayName ?? account.params?.displayName;
    return typeof name === "string" && name.trim() ? name.trim() : null;
  },

  async removeSignIn(externalId) {
    await call("DELETE", `/connected_accounts/${encodeURIComponent(externalId)}`);
  },

  async run(action, input, login, owner) {
    const externalId = login?.externalId;
    if (externalId) owner = await accountUser(externalId, owner);
    const execute = async (args: unknown) => {
      const out = await call("POST", `/tools/execute/${encodeURIComponent(toSlug(action))}`, {
        // without a connection of ours, a user Composio has no logins for: it must never fall back to
        // a login it holds for this person that our database doesn't know about
        user_id: externalId ? owner : "employee0-no-sign-in",
        ...(externalId && { connected_account_id: externalId }),
        arguments: await uploadFiles(args, action),
      });
      if (!out.successful) throw new AppsError(String(out.error ?? "the action failed"), mayBeSignedOut(String(out.error ?? "")));
      return out.data as Json;
    };
    if (action !== "gmail.fetch_emails") return downloadFiles(await execute(input));
    return downloadFiles(await execute(input).catch((e) => (tooLarge(e) ? fetchInPages(execute, input as Json) : Promise.reject(e))));
  },

  async listTriggers(app, words) {
    const { items = [] } = await call("GET", `/triggers_types?${new URLSearchParams({ toolkit_slugs: app, limit: "100" })}`);
    const terms = (words ?? "").toLowerCase().split(/\s+/).filter(Boolean);
    return (items as Json[])
      .map((t) => ({ action: toAction(t.slug, app), description: firstLine(t.description) }))
      .filter((t) => terms.every((w) => `${t.action} ${t.description}`.toLowerCase().includes(w)));
  },

  async getTrigger(trigger) {
    const t = await call("GET", `/triggers_types/${encodeURIComponent(toSlug(trigger))}`).catch((e) => {
      if (e instanceof AppsError) return null;
      throw e;
    });
    if (!t?.slug) return null;
    return {
      action: toAction(t.slug, t.toolkit.slug),
      app: t.toolkit.slug,
      description: t.description,
      input: fields(t.config),
      output: fields(t.payload),
    };
  },

  async startTrigger(trigger, config, login, owner) {
    const out = await call("POST", `/trigger_instances/${encodeURIComponent(toSlug(trigger))}/upsert`, {
      user_id: await accountUser(login.externalId, owner),
      connected_account_id: login.externalId,
      trigger_config: config ?? {},
    });
    return out.trigger_id;
  },

  async stopTrigger(externalId) {
    await call("DELETE", `/trigger_instances/manage/${encodeURIComponent(externalId)}`);
  },
};

// Composio refuses an answer past its size limit: ten whole emails came to 3.5 MB, and asking for 30 failed. A Gmail
// fetch that hits it is asked again in smaller pages, joined into one answer, so asking for many just works; an email
// too big even alone comes without its body, and the answer says so.
// ponytail: only for Composio's Gmail; goes with it once our own Gmail (no such limit) has Google's approval
const tooLarge = (e: unknown) => e instanceof Error && /payload is too large/i.test(e.message);

export async function fetchInPages(execute: (args: Json) => Promise<Json>, input: Json) {
  const want = Math.max(1, Number(input.max_results ?? 1));
  const messages: Json[] = [];
  let size = Math.max(1, Math.floor(want / 2));
  let page: string | undefined = input.page_token;
  let bodiless = 0;
  let last: Json = {};
  while (messages.length < want) {
    const ask = { ...input, max_results: Math.min(size, want - messages.length), ...(page && { page_token: page }) };
    let data: Json;
    try {
      data = await execute(ask);
    } catch (e) {
      if (!tooLarge(e)) throw e;
      if (ask.max_results > 1) {
        size = Math.max(1, Math.floor(ask.max_results / 2));
        continue;
      }
      data = await execute({ ...ask, include_payload: false, verbose: false });
      bodiless++;
    }
    messages.push(...(data?.messages ?? []));
    last = data ?? {};
    page = last.nextPageToken || undefined;
    if (!page) break;
  }
  return {
    ...last,
    messages,
    nextPageToken: page,
    ...(bodiless && { note: `${bodiless} email(s) were too big to come with their body; read one by its id with gmail.fetch_message_by_message_id` }),
  };
}

// The user a login was made under. Usually `owner`, but a login made before its workspace got a new id
// keeps the old one, and Composio refuses a run under any other.
const accountUsers = new Map<string, string>();
async function accountUser(externalId: string, owner: string) {
  if (!accountUsers.has(externalId)) {
    const account = await call("GET", `/connected_accounts/${encodeURIComponent(externalId)}`).catch(() => null);
    if (!account?.user_id) return owner;
    accountUsers.set(externalId, account.user_id);
  }
  return accountUsers.get(externalId)!;
}

const fields = (schema: Json = {}) => {
  const required = new Set<string>(schema.required ?? []);
  return Object.entries<Json>(schema.properties ?? {}).map(([name, v]) => ({
    name,
    type: v.type ?? "any",
    required: required.has(name),
    description: firstLine(v.description),
  }));
};

// Point the project's webhook at our server (once per start) and return the secret its events are signed with.
// ponytail: one subscription per Composio project, so each server (dev, prod) needs its own project
export async function ensureWebhook(url: string): Promise<string> {
  const { items = [] } = await call("GET", "/webhook_subscriptions");
  const events = ["composio.trigger.message", "composio.trigger.disabled"];
  const [sub] = items as Json[];
  if (!sub) return (await call("POST", "/webhook_subscriptions", { webhook_url: url, enabled_events: events, version: "V3" })).secret;
  if (sub.webhook_url !== url || sub.version !== "V3" || events.some((e) => !sub.enabled_events?.includes(e))) {
    // a server that isn't production may share its Composio project with one that is: moving the webhook here would take that server's trigger events away
    if (process.env.NODE_ENV !== "production") {
      console.warn(`Composio webhook stays at ${sub.webhook_url}; trigger automations won't fire on this server`);
      return sub.secret;
    }
    console.warn(`Composio webhook moved from ${sub.webhook_url} to ${url}`);
    return (await call("PATCH", `/webhook_subscriptions/${sub.id}`, { webhook_url: url, enabled_events: events, version: "V3" })).secret ?? sub.secret;
  }
  return sub.secret;
}
