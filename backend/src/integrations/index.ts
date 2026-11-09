// Apps people connect (Gmail, Calendar, Zoho, ...): connections and every action run live in our
// database; a provider (Composio today) only holds the logins and does the calls. The web app (routes
// below) and the agent (`emplio apps`, see appsCommand) go through the same functions.
// A person can connect several accounts of one app (work and personal Gmail); each has a label (the
// account's address, renamable), and whatever uses the app says which with `account` when there are several.
// ponytail: connections are per person; company-wide ones (for routines) need a null userId and a rule for who may use them.
// ponytail: an expired login is noticed when an action fails; wire Composio's expiry webhook to flag it sooner.
// ponytail: the four gated actions (money out, messages to customers, deletes) aren't enforced here yet, only asked for in the prompt.
import { and, desc, eq } from "drizzle-orm";
import { record } from "../activity";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { APP_CATEGORIES, type ActionRun, type AppCategory, type AppInfo, type ConnectCard, type Connection } from "@emplio/shared";
import { CATALOG, catalogApp } from "./catalog";
import { context, currentUser, type Ctx } from "../auth";
import { db } from "../db";
import { actionRuns, connections } from "../db/schema";
import { composio } from "./composio";
import { freshSecret, own } from "./own";
import { listPolls, pollConfig, pollDetail, pollTrigger } from "./polls";
import { decrypt, encrypt } from "../secrets";
import { basename } from "node:path";
import { createHmac, timingSafeEqual } from "node:crypto";
import { AppFile, AppsError, mapDeep, type Provider } from "./types";

type Who = Pick<Ctx, "workspaceId" | "userId">;

// which one runs an app is set per app in catalog.ts
const providers: Record<string, Provider> = { composio, own };
type Workspace = Pick<Ctx, "workspaceId">;
const envList = (name: string) => (process.env[name] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
// KEEP_ON_COMPOSIO: apps still waiting on their maker's review. Everyone stays on Composio with them, except the workspaces
// in OWN_APP_TESTERS, which get ours (reviewers need it working). Take an app off the list once it's approved.
// ponytail: delete this with the env vars once the list is empty. Anywhere `who` isn't passed answers as a customer would.
const heldBack = (app: string, who?: Workspace) => envList("KEEP_ON_COMPOSIO").includes(app) && !(who && envList("OWN_APP_TESTERS").includes(who.workspaceId));
export const providerFor = (app: string, who?: Workspace) => (heldBack(app, who) ? composio : (providers[catalogApp(app)?.provider ?? "composio"] ?? composio));
const providerOf = (c: { provider: string }) => providers[c.provider] ?? composio;

const APP = /^[a-z0-9_]+$/;
const ACTION = /^[a-z0-9_]+\.[a-z0-9_]+$/;
const appOf = (action: string) => action.split(".")[0]!;
// the person, as providers know them
const owner = (who: Who) => `${who.workspaceId}:${who.userId}`;
const API_URL = () => process.env.PUBLIC_API_URL ?? `http://localhost:${process.env.PORT ?? 4000}`;
// Where a sign-in started from the web app comes back to: this server as the person's device reaches it. Live has
// only WEBHOOK_URL (without it sign-ins came back to a localhost page); on a laptop, the address it was opened on
// (the dev WEBHOOK_URL tunnel lets only webhooks in). Same rule as MCP sign-ins.
const returnBase = (req: FastifyRequest) => {
  const here = `${req.protocol}://${req.headers.host}`;
  return process.env.PUBLIC_API_URL ?? (/^(localhost|127\.0\.0\.1)(:|$)/.test(req.headers.host ?? "") ? here : (process.env.WEBHOOK_URL ?? here));
};
const FRONTEND_URL = () => process.env.FRONTEND_URL ?? "http://localhost:3000";

// The provider's logo and key field for an app.
// ponytail: cached per process forever; they barely change
const fromProvider = new Map<string, Promise<AppInfo | null>>();
const providerApp = (app: string) => {
  if (!fromProvider.has(app)) fromProvider.set(app, providerFor(app).getApp(app).catch(() => (fromProvider.delete(app), null)));
  return fromProvider.get(app)!;
};

// Apps with a login set up at their provider, asked at most once a minute.
let ready: { at: number; apps: Promise<Map<string, Set<string>>> } | null = null;
const readyApps = () => {
  if (!ready || Date.now() - ready.at > 60_000) {
    const apps = Promise.all(Object.values(providers).map(async (p) => [p.name, await p.readyApps()] as const)).then((sets) => new Map(sets));
    ready = { at: Date.now(), apps };
    apps.catch(() => (ready = null));
  }
  return ready.apps;
};

// What we offer right now: our catalog, minus apps whose login isn't set up yet.
export async function availableApps(who?: Workspace): Promise<AppInfo[]> {
  const ok = await readyApps();
  return Promise.all(
    CATALOG.filter((a) => ok.get(providerFor(a.app, who).name)?.has(a.app)).map(async (a) => {
      const p = await providerApp(a.app);
      return { app: a.app, name: a.name, description: a.description, category: a.category, logo: p?.logo, keyField: p?.keyField, signIn: p?.signIn };
    }),
  );
}

// The app, if we offer it now; otherwise a reason the agent or person can act on.
async function offered(app: string, who?: Workspace): Promise<AppInfo> {
  if (!APP.test(app)) throw new AppsError(`"${app}" isn't an app name`);
  const found = (await availableApps(who)).find((a) => a.app === app);
  if (!found) throw new AppsError(`${app} isn't offered; see the apps that are with emplio apps search`);
  return found;
}

type Row = typeof connections.$inferSelect;
const appName = (app: string) => catalogApp(app)?.name ?? app;
// signed in through the provider an app has since left (GitHub moved off Composio): it has to be connected again
const moved = (c: Row) => c.provider !== providerFor(c.app, c).name;

const toConnection = async (c: Row): Promise<Connection> => ({
  id: c.id,
  app: c.app,
  name: appName(c.app),
  label: c.label ?? appName(c.app),
  ...(await providerApp(c.app).then((p) => ({ logo: p?.logo, keyField: p?.keyField, signIn: p?.signIn }))),
  status: moved(c) ? "expired" : c.status,
  createdAt: c.createdAt.toISOString(),
});

// This person's connections of one app, oldest first.
const accounts = (who: Who, app: string) =>
  db
    .select()
    .from(connections)
    .where(and(eq(connections.workspaceId, who.workspaceId), eq(connections.userId, who.userId), eq(connections.app, app)))
    .orderBy(connections.createdAt);

const labelOf = (c: Row) => c.label ?? appName(c.app);

// `name`, or "name 2", "name 3"... if another of the person's accounts of this app already has it
function uniqueLabel(name: string, others: Row[]) {
  const taken = new Set(others.map((o) => labelOf(o).toLowerCase()));
  let label = name;
  for (let n = 2; taken.has(label.toLowerCase()); n++) label = `${name} ${n}`;
  return label;
}

// The connection to use for an app: the account named (label or id), or the only one. Several and none
// named is an error listing them, so the agent asks or picks instead of guessing. Undefined: none at all.
async function findConnection(who: Who, app: string, account?: string) {
  const rows = await accounts(who, app);
  const names = rows.map((r) => `"${labelOf(r)}"`).join(", ");
  if (account) {
    const want = account.trim().toLowerCase();
    const found = rows.find((r) => r.id === account || labelOf(r).toLowerCase() === want);
    if (!found) throw new AppsError(rows.length ? `no ${app} account "${account}"; connected: ${names}` : `${app} isn't connected`);
    return found;
  }
  const current = rows.filter((r) => !moved(r));
  const usable = current.length ? current : rows;
  if (usable.length > 1) throw new AppsError(`several ${app} accounts are connected (${usable.map((r) => `"${labelOf(r)}"`).join(", ")}); say which with --account "<name>"`);
  return usable[0];
}

// The logins plain git can use for an app (git-proxy.ts): this person's working accounts, whose login we hold ourselves.
export async function gitLogins(who: Who, app: string) {
  const rows = (await accounts(who, app)).filter((r) => r.status === "active" && r.secret && !moved(r));
  return Promise.all(rows.map(async (r) => ({ label: labelOf(r), secret: (await freshSecret(r))! })));
}

const loginOf = async (c: Row) => ({ externalId: c.externalId, secret: await freshSecret(c) });

// Ask the provider how a sign-in went and store it. Kept as is when the provider can't be reached.
// Once it's signed in, it gets its label: the account's name (an email address) or the app's name.
async function refresh(c: Row) {
  const status = await providerOf(c).signInStatus(c.externalId).catch(() => c.status);
  const label =
    status === "active" && !c.label
      ? uniqueLabel(
          (await providerOf(c).accountName?.(c.externalId).catch(() => null)) ?? appName(c.app),
          (await accounts(c, c.app)).filter((o) => o.id !== c.id),
        )
      : c.label;
  if (status === c.status && label === c.label) return c;
  const [updated] = await db.update(connections).set({ status, label, updatedAt: new Date() }).where(eq(connections.id, c.id)).returning();
  return updated ?? c;
}

// Offered apps matching every word (name, app name, description) and the category, if given.
export async function searchApps(words: string, category?: AppCategory, who?: Workspace) {
  const terms = words.toLowerCase().split(/\s+/).filter(Boolean);
  return (await availableApps(who)).filter(
    (a) => (!category || a.category === category) && terms.every((t) => `${a.app} ${a.name} ${a.description}`.toLowerCase().includes(t)),
  );
}

// A Connect button for the chat: our own link, which starts the sign-in for whoever opens it
// (logged in), so nothing provider-made is shown and a stale link never expires.
// connection: reconnect that account instead of adding another.
export async function connectCard(app: string, conversationId?: string, connection?: string, who?: Workspace): Promise<ConnectCard> {
  const info = await offered(app, who);
  const query = new URLSearchParams({ ...(conversationId && { chat: conversationId }), ...(connection && { connection }) });
  return { app, name: info.name, logo: info.logo, keyField: info.keyField, signIn: info.signIn, path: `/connect/${app}${query.size ? `?${query}` : ""}`, connection };
}

export async function listActions(app: string, words?: string, who?: Workspace) {
  await offered(app, who);
  return providerFor(app, who).listActions(app, words);
}

// real actions near a made-up name (gmail.search_emails → gmail.fetch_emails…): search by its words, then by each word alone
async function closestActions(action: string, who: Workspace) {
  const app = appOf(action);
  const words = action.slice(app.length + 1).split("_").filter((w) => w.length > 2);
  const found = new Set<string>();
  for (const search of [words.join(" "), ...words]) {
    for (const a of await providerFor(app, who).listActions(app, search).catch(() => [])) found.add(a.action);
    if (found.size >= 5) break;
  }
  return [...found].slice(0, 5);
}

export async function getAction(action: string, who?: Workspace) {
  if (!ACTION.test(action)) throw new AppsError(`"${action}" isn't an action name (they look like gmail.send_email)`);
  await offered(appOf(action), who);
  return providerFor(appOf(action), who).getAction(action);
}

// This person's connections; sign-ins still pending are checked on the way.
export async function listConnections(who: Who): Promise<Connection[]> {
  const rows = await db
    .select()
    .from(connections)
    .where(and(eq(connections.workspaceId, who.workspaceId), eq(connections.userId, who.userId)))
    .orderBy(connections.app, connections.createdAt);
  return Promise.all(rows.map(async (c) => toConnection(c.status === "pending" || !c.label ? await refresh(c) : c)));
}

// One of this person's connections by id (the app's routes), or a reason.
async function ownConnection(who: Who, id: string, app?: string) {
  const row = /^[0-9a-f-]{36}$/.test(id)
    ? await db.query.connections.findFirst({
        where: and(eq(connections.id, id), eq(connections.workspaceId, who.workspaceId), eq(connections.userId, who.userId)),
      })
    : undefined;
  if (!row || (app && row.app !== app)) throw new AppsError("no such connection");
  return row;
}

// Rename an account (its label), unique among the person's accounts of that app.
export async function renameConnection(who: Who, id: string, label: string): Promise<Connection> {
  const row = await ownConnection(who, id);
  const name = label.trim();
  if (!name || name.length > 80) throw new AppsError("the name must be 1 to 80 characters");
  const others = (await accounts(who, row.app)).filter((o) => o.id !== row.id);
  if (others.some((o) => labelOf(o).toLowerCase() === name.toLowerCase())) throw new AppsError(`another ${row.app} account is already called "${name}"`);
  const [updated] = await db.update(connections).set({ label: name, updatedAt: new Date() }).where(eq(connections.id, row.id)).returning();
  return toConnection(updated!);
}

// Start a sign-in for another account, or a fresh one for `connectionId` (replacing its old login). The
// link goes to the provider and back to our server, which records the result, then on to the chat.
export async function connect(
  who: Who,
  app: string,
  conversationId?: string,
  popup = false,
  connectionId?: string,
  // where the sign-in comes back to: this server as the person's device reaches it
  base = API_URL(),
): Promise<{ connection: Connection; url: string }> {
  const info = await offered(app, who);
  if (info.keyField && !info.signIn) throw new AppsError(`${app} is connected by entering a key in the app`);
  const provider = providerFor(app, who);
  const existing = connectionId ? await ownConnection(who, connectionId, app) : undefined;
  const id = existing?.id ?? crypto.randomUUID();
  const back = new URL(`/connections/${id}/done`, base);
  if (conversationId) back.searchParams.set("chat", conversationId);
  if (popup) back.searchParams.set("popup", "1");
  const { externalId, url } = await provider.startSignIn(app, owner(who), back.href);
  if (existing) await providerOf(existing).removeSignIn(existing.externalId).catch(() => {});
  const values = { provider: provider.name, externalId, status: "pending" as const, updatedAt: new Date() };
  const [row] = existing
    ? await db.update(connections).set(values).where(eq(connections.id, id)).returning()
    : await db.insert(connections).values({ id, workspaceId: who.workspaceId, userId: who.userId, app, ...values }).returning();
  record({ ...who, conversationId, kind: "connection", summary: `Started connecting ${appName(app)}${existing ? ` (reconnecting ${existing.label ?? "it"})` : ""}` });
  return { connection: await toConnection(row!), url };
}

// Connect another account of an app that takes a pasted key, or replace `connectionId`'s key: the
// provider checks the key works, then it's stored encrypted. The key never goes to the agent; only the
// web app sends it here.
export async function connectWithKey(who: Who, app: string, key: string, connectionId?: string): Promise<Connection> {
  if (!(await offered(app, who)).keyField) throw new AppsError(`${app} is connected by signing in, not with a key`);
  const provider = providerFor(app, who);
  const { secret, label } = await provider.connectWithKey!(app, key);
  const existing = connectionId ? await ownConnection(who, connectionId, app) : undefined;
  if (existing && existing.provider !== provider.name) await providerOf(existing).removeSignIn(existing.externalId).catch(() => {});
  const id = existing?.id ?? crypto.randomUUID();
  const values = { provider: provider.name, externalId: id, secret: encrypt(secret), refreshToken: null, expiresAt: null, status: "active" as const, updatedAt: new Date() };
  const [row] = existing
    ? await db.update(connections).set(values).where(eq(connections.id, id)).returning()
    : await db
        .insert(connections)
        .values({ id, workspaceId: who.workspaceId, userId: who.userId, app, label: uniqueLabel(label ?? appName(app), await accounts(who, app)), ...values })
        .returning();
  record({ ...who, kind: "connection", summary: `${existing ? "Replaced the key for" : "Connected"} ${appName(app)} (${row!.label ?? "key"})` });
  return toConnection(row!);
}

// account: which one, by label (needed when there are several); connectionId: by id, from the app
export async function disconnect(who: Who, app: string, account?: string, connectionId?: string) {
  const existing = connectionId ? await ownConnection(who, connectionId) : await findConnection(who, app, account);
  if (!existing) throw new AppsError(`${app} isn't connected`);
  // best effort: a provider outage mustn't block removing it here
  await providerOf(existing).removeSignIn(existing.externalId).catch((error) => console.warn("removing sign-in failed", error));
  await db.delete(connections).where(eq(connections.id, existing.id));
  record({ ...who, kind: "connection", summary: `Disconnected ${appName(app)}${existing.label ? ` (${existing.label})` : ""}` });
}

// Run an action as this person, and record it whatever happens.
// account: which of the person's accounts of the app (label), when they have several
// quiet: only failures go in the run history (polling triggers call every few minutes)
const MAX_FILE = 25 * 1024 * 1024;

// {"file": "<path>"} anywhere in an action's input: that file from the agent's computer, read by `read`.
// ponytail: an app input that is itself an object with only a string "file" key would be taken for one
const attachFiles = (input: unknown, read?: (path: string) => Promise<Uint8Array>) =>
  mapDeep(input, async (v) => {
    if (!v || typeof v !== "object" || Array.isArray(v) || Object.keys(v).join() !== "file") return undefined;
    const path = (v as { file: unknown }).file;
    if (typeof path !== "string") return undefined;
    if (!read) throw new AppsError("files can only be attached from a chat");
    const bytes = await read(path).catch(() => {
      throw new AppsError(`no file ${path} (give its full path, like /work/tmp/report.xlsx)`);
    });
    if (bytes.length > MAX_FILE) throw new AppsError(`${path} is over 25 MB`);
    const name = basename(path);
    return new AppFile(name, Bun.file(name).type.split(";")[0]!, bytes);
  });

// readFile: reads a file from the agent's computer, for files attached to the input
export async function runAction(
  who: Who,
  action: string,
  input: unknown,
  {
    conversationId,
    quiet = false,
    account,
    readFile,
  }: { conversationId?: string; quiet?: boolean; account?: string; readFile?: (path: string) => Promise<Uint8Array> } = {},
) {
  if (!ACTION.test(action)) throw new AppsError(`"${action}" isn't an action name (they look like gmail.send_email)`);
  const app = appOf(action);
  await offered(app, who);
  let connection = await findConnection(who, app, account);
  // before anything runs: its actions are the old provider's, and only the new provider's can be checked for an OK
  if (connection && moved(connection)) throw new AppsError(`${app} has to be connected again: emplio apps reconnect ${app}`);
  if (connection?.status === "pending") connection = await refresh(connection);
  if (connection && connection.status !== "active")
    throw new AppsError(
      connection.status === "pending" ? `${app} sign-in isn't finished yet` : `${app} needs signing in again (${connection.status})`,
    );

  const sent = await attachFiles(input, readFile);
  const started = Date.now();
  // no connection: fine for apps that need no sign-in; the provider says so otherwise
  const provider = connection ? providerOf(connection) : providerFor(app, who);
  const run = await (connection ? loginOf(connection) : Promise.resolve(null)).then((login) => provider.run(action, sent, login, owner(who))).then(
    (output) => ({ ok: true as const, output }),
    (error: unknown) => ({ ok: false as const, error }),
  );
  const message = run.ok ? null : run.error instanceof AppsError ? run.error.message : "something went wrong on our side";
  if (!(quiet && run.ok))
    record({
      ...who,
      conversationId,
      kind: "app",
      summary: `${action}${connection?.label ? ` (${connection.label})` : ""}${run.ok ? "" : `: failed, ${message}`}`,
      detail: { input: input ?? {} },
    });
  if (!(quiet && run.ok)) await db.insert(actionRuns).values({
    workspaceId: who.workspaceId,
    userId: who.userId,
    conversationId: conversationId ?? null,
    connectionId: connection?.id ?? null,
    action,
    input: input ?? {},
    output: run.ok ? (run.output ?? null) : null,
    ok: run.ok,
    error: message,
    ms: Date.now() - started,
  });
  if (run.ok) return run.output;
  if (run.error instanceof AppsError && run.error.expired && connection)
    await db.update(connections).set({ status: "expired", updatedAt: new Date() }).where(eq(connections.id, connection.id));
  if (run.error instanceof AppsError && run.error.message === "not connected") throw new AppsError(`${app} isn't connected`);
  // a guessed action name: point at the real ones instead of leaving the agent to guess again
  if (message && /^Tool \S+ not found/.test(message)) {
    const close = await closestActions(action, who);
    if (close.length) throw new AppsError(`there's no ${action}. Closest: ${close.join(", ")}`);
  }
  throw run.error;
}

// Triggers: events that start an automation. Same names and checks as actions.
// Polled triggers are written against our own actions, so an app held back on Composio has none.
const pollsRun = (app: string, who?: Workspace) => providerFor(app, who).name === "own";
export async function listTriggers(app: string, words?: string, who?: Workspace) {
  await offered(app, who);
  const terms = (words ?? "").toLowerCase().split(/\s+/).filter(Boolean);
  const ours = (pollsRun(app, who) ? listPolls(app) : []).filter((t) => terms.every((w) => `${t.action} ${t.description}`.toLowerCase().includes(w)));
  return [...ours, ...((await providerFor(app, who).listTriggers?.(app, words)) ?? [])];
}

export async function getTrigger(trigger: string, who?: Workspace) {
  if (!ACTION.test(trigger)) throw new AppsError(`"${trigger}" isn't a trigger name (they look like gmail.new_gmail_message)`);
  await offered(appOf(trigger), who);
  return (pollsRun(appOf(trigger), who) ? pollDetail(trigger) : null) ?? (await providerFor(appOf(trigger), who).getTrigger?.(trigger)) ?? null;
}

// Start watching for a trigger's event on this person's login. Its events come back to our webhook with
// the returned externalId.
// account: which of the person's accounts of the app, when they have several.
export async function startTrigger(who: Who, trigger: string, config: unknown, account?: string) {
  const detail = await getTrigger(trigger, who);
  if (!detail) throw new AppsError(`no trigger ${trigger}; list them with emplio automations triggers <app>`);
  const app = appOf(trigger);
  let connection = await findConnection(who, app, account);
  // before anything runs: its actions are the old provider's, and only the new provider's can be checked for an OK
  if (connection && moved(connection)) throw new AppsError(`${app} has to be connected again: emplio apps reconnect ${app}`);
  if (connection?.status === "pending") connection = await refresh(connection);
  if (connection?.status !== "active") throw new AppsError(`${app} isn't connected for the person who saved it`);
  const polled = pollsRun(appOf(trigger), who) ? pollTrigger(trigger) : undefined;
  if (polled) {
    try {
      pollConfig(trigger, config);
    } catch (error) {
      throw new AppsError((error as Error).message);
    }
  }
  const provider = providerOf(connection);
  // the app tells us itself, at once. If that can't be set up here, a trigger we can poll still works, just later.
  const login = await loginOf(connection);
  const pushed = await provider.startPush?.(trigger, login, config).catch((error) => {
    if (!polled) throw error;
    console.warn(`${trigger}: falling back to polling: ${(error as Error).message}`);
    return null;
  });
  if (pushed) return { provider: provider.name, externalId: pushed };
  // ours: the automations timer polls it; nothing to start at the provider
  if (polled) return { provider: "poll", externalId: null };
  const externalId = await provider.startTrigger!(trigger, config, { externalId: connection.externalId }, owner(who));
  return { provider: provider.name, externalId };
}

export const stopTrigger = (provider: string, externalId: string) => providers[provider]?.stopTrigger?.(externalId);

// Recent runs: owners and admins see the whole business, others their own.
export async function listRuns(who: Who & Pick<Ctx, "role">, limit = 50): Promise<ActionRun[]> {
  const rows = await db
    .select()
    .from(actionRuns)
    .where(
      who.role === "member"
        ? and(eq(actionRuns.workspaceId, who.workspaceId), eq(actionRuns.userId, who.userId))
        : eq(actionRuns.workspaceId, who.workspaceId),
    )
    .orderBy(desc(actionRuns.createdAt))
    .limit(Math.min(limit, 200));
  return rows.map((r) => ({
    id: r.id,
    action: r.action,
    ok: r.ok,
    error: r.error,
    conversationId: r.conversationId,
    createdAt: r.createdAt.toISOString(),
  }));
}

const APPS_USAGE = `usage: emplio apps list                       accounts connected for this person: app, account name, status
       emplio apps search <words>            find apps that can be connected
       emplio apps add <app>                 a Connect button for the person: connects an account (another one if it's connected)
       emplio apps reconnect <app>           a fresh sign-in, for an expired or broken one
       emplio apps rename <app> <new name>   rename an account (its name in emplio apps list)
       emplio apps remove <app>              disconnect it
       emplio apps actions <app> [words]     what an app can do
       emplio apps info <action>             what an action takes
       emplio apps run <action> '<json>'     run it (or: emplio apps run <action> - <<'JSON' ... JSON)
       emplio apps history                   recent runs
Several accounts of one app (work and personal Gmail): add --account "<name>" (from emplio apps list) to
reconnect, rename, remove and run, e.g. emplio apps run gmail.send_email --account "me@work.com" '<json>'.
Files (email attachments, uploads): put {"file": "/work/tmp/report.xlsx"} (full path) where the action
takes a file, e.g. "attachment": {"file": "/work/tmp/report.xlsx"}; the file is sent to the app for you.
Files an action gives back (an attachment you fetched) are saved under /work/tmp/apps/files/ and show in
the result as {"file": "<path>"}, ready to attach to another action as is.`;

// `emplio apps ...` from a chat, as text for the agent, plus a Connect card for the chat when it asks for
// one. `park` saves a big result to a file in its computer.
export async function appsCommand(
  who: Who & Pick<Ctx, "role">,
  conversationId: string,
  args: string[],
  park: (name: string, text: string) => Promise<string>,
  // asks the person before an action that sends or changes something; null: go ahead
  approve?: (action: string, input: unknown, account?: string) => Promise<string | null>,
  // reads a file from its computer, for {"file": "<path>"} in an action's input
  readFile?: (path: string) => Promise<Uint8Array>,
  // saves a file an action gave back into its computer; returns the path
  saveFile?: (name: string, bytes: Uint8Array) => Promise<string>,
): Promise<string | { text: string; card: ConnectCard }> {
  // --account "<name>": which account, anywhere after the subcommand
  const at = args.indexOf("--account");
  const account = at > 0 ? args[at + 1] : undefined;
  if (at > 0) args = args.filter((_, i) => i !== at && i !== at + 1);
  const [sub, first = "", ...rest] = args;
  const name = first.toLowerCase();
  try {
    switch (sub) {
      case undefined:
      case "list": {
        const list = await listConnections(who);
        if (!list.length) return "No apps connected. Find one with emplio apps search <words>, connect with emplio apps add <app>.";
        const label = { pending: "waiting for sign-in", active: "connected", expired: "expired: reconnect", failed: "failed: reconnect" };
        return list.map((c) => `${c.app}\t"${c.label}"\t${label[c.status]}\tsince ${c.createdAt.slice(0, 10)}`).join("\n");
      }
      case "search": {
        const apps = await searchApps([first, ...rest].join(" "), undefined, who);
        return apps.length ? apps.map((a) => `${a.app}\t${a.name}: ${a.description}`).join("\n") : "No app matches.";
      }
      case "add":
      case "reconnect": {
        if (!name) break;
        // reconnect: that account (the only one, or --account); add: another account
        const target = sub === "reconnect" ? await findConnection(who, name, account) : undefined;
        if (sub === "reconnect" && !target) return `error: ${name} isn't connected; use emplio apps add ${name}.`;
        const card = { ...(await connectCard(name, conversationId, target?.id, who)), existing: (await accounts(who, name)).map((c) => c.id) };
        const how = card.keyField ? ` They'll ${card.signIn ? "sign in or " : ""}paste their ${card.keyField.label} into it; never ask for the key in chat.` : "";
        return {
          card,
          text: `A Connect button for ${card.name} now shows in the chat.${how} Ask the person to use it and tell you when they're done (then check with emplio apps list). Don't write a link.`,
        };
      }
      case "rename": {
        const label = rest.join(" ").trim();
        if (!name || !label) break;
        const target = await findConnection(who, name, account);
        if (!target) return `error: ${name} isn't connected.`;
        const renamed = await renameConnection(who, target.id, label);
        return `Renamed: ${name} "${renamed.label}".`;
      }
      case "remove":
        if (!name) break;
        await disconnect(who, name, account);
        return `Disconnected ${name}${account ? ` "${account}"` : ""}.`;
      case "actions": {
        if (!name) break;
        const actions = await listActions(name, rest.join(" ") || undefined, who);
        return actions.length
          ? actions.map((a) => `${a.action}\t${a.description}`).join("\n")
          : `No actions found for ${name}. Check the app name with emplio apps search.`;
      }
      case "info": {
        if (!name) break;
        const a = await getAction(name, who);
        if (!a) return `error: no action ${name}. List them with emplio apps actions <app>.`;
        const input = a.input.map((p) => `  ${p.name}${p.required ? " (required)" : ""}: ${p.type}. ${p.description}`);
        return [`${a.action}: ${a.description}`, "Input:", ...(input.length ? input : ["  none"])].join("\n");
      }
      case "run": {
        if (!name) break;
        let input: unknown;
        try {
          input = JSON.parse(rest[0] || "{}");
        } catch {
          return "error: the input isn't valid JSON.";
        }
        // which account first, so an Allow card is never shown for a run that can't happen
        await findConnection(who, appOf(name), account);
        const refused = await approve?.(name, input, account);
        if (refused) return refused;
        const output = await mapDeep(await runAction(who, name, input, { conversationId, account, readFile }), async (v) =>
          v instanceof AppFile && saveFile ? { file: await saveFile(v.name, v.bytes), mimetype: v.mimetype, size: v.bytes.length } : undefined,
        );
        const text = JSON.stringify(output) ?? "done";
        if (text.length <= 4000) return text;
        const path = await park(name.replace(".", "-"), text);
        return `Result is ${text.length} characters, saved in full to ${path} (read it with jq or python). Start:\n${text.slice(0, 1000)}`;
      }
      case "history": {
        const runs = await listRuns(who, 20);
        return runs.length
          ? runs.map((r) => `${r.createdAt.slice(0, 16).replace("T", " ")}\t${r.action}\t${r.ok ? "ok" : `failed: ${r.error}`}`).join("\n")
          : "No runs yet.";
      }
    }
    return APPS_USAGE;
  } catch (error) {
    if (!(error instanceof AppsError)) throw error;
    // the sign-in let through fewer permissions than the app needs: Google's tick boxes, left unticked
    const hint = /isn't connected|signing in again/.test(error.message)
      ? " Connect it with emplio apps add <app> (or reconnect)."
      : /scope|insufficient.{0,30}(auth|permission)/i.test(error.message)
        ? " The account was connected without some permissions: emplio apps reconnect <app>, and tell them to allow every permission (tick all the boxes) on the sign-in screen."
        : "";
    return `error: ${error.message}.${hint}`;
  }
}

// The same functions, for the web app.
// A sign-in link that works without being logged in to the web app, for channels (Telegram) where the
// person taps it on their phone. Good for an hour; null when this server has no public address.
// ponytail: anyone given the link within the hour can connect their own account to this person
const linkSig = (payload: string) => createHmac("sha256", process.env.ENCRYPTION_KEY!).update(`connect:${payload}`).digest("base64url");
// `path`: another sign-in page that reads the same token (an MCP server's, mcp.ts)
export function connectLink(who: Who, app: string, connection?: string, path = `/connect/${app}`) {
  if (!process.env.WEBHOOK_URL) return null;
  const payload = Buffer.from(JSON.stringify({ w: who.workspaceId, u: who.userId, c: connection, e: Date.now() + 3600_000 })).toString("base64url");
  return `${process.env.WEBHOOK_URL}${path}?t=${payload}.${linkSig(payload)}`;
}
export function fromLink(token: string) {
  const [payload = "", sig = ""] = token.split(".");
  const want = Buffer.from(linkSig(payload));
  if (Buffer.from(sig).length !== want.length || !timingSafeEqual(Buffer.from(sig), want)) return null;
  const t = JSON.parse(Buffer.from(payload, "base64url").toString()) as { w: string; u: string; c?: string; e: number };
  return t.e > Date.now() ? t : null;
}

export const esc = (t: string) => t.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
// The page a phone link opens for an app connected with a key: the key box, or `done` (a result) instead of it.
// t: the link's token, for the sign-in button of an app that also signs in on its own page.
async function keyPage(app: string, error?: string | null, done?: string, t?: string) {
  const info = done ? null : await offered(app).catch(() => null);
  const body = done
    ? `<p>${done}</p>`
    : info?.keyField
      ? `<h1>${info.logo ? `<img src="${esc(new URL(info.logo, FRONTEND_URL()).href)}" alt="">` : ""}Connect ${esc(info.name)}</h1>${info.signIn && t ? `<a class="b" href="/connect/${esc(app)}?t=${encodeURIComponent(t)}&amp;signin=1">Sign in with ${esc(info.name)}</a><p class="m">Or paste a key instead.</p>` : ""}<p class="m">${esc(info.keyField.help)}</p>
<form method="post"><label>${esc(info.keyField.label)}<input name="key" type="password" autocomplete="off" required autofocus placeholder="${esc(info.keyField.placeholder ?? "")}"></label>
${error ? `<p class="e">${esc(error)}</p>` : ""}<button onclick="this.textContent='Checking…'">Connect</button></form><p class="m">Stored encrypted. Emplio uses it but never sees it.</p>`
      : "<p>This app can't be connected here.</p>";
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><title>Connect</title>
<style>body{font:15px system-ui;max-width:420px;margin:0 auto;padding:24px 16px;color:#111;background:#fff}h1{font-size:18px;display:flex;gap:10px;align-items:center}h1 img{width:28px;height:28px;object-fit:contain}
.m{color:#666;font-size:13px}.e{color:#c00}label{display:grid;gap:6px;font-weight:500}input{font:inherit;padding:10px;border:1px solid #ccc;border-radius:8px}
button,.b{display:block;box-sizing:border-box;text-align:center;text-decoration:none;font:inherit;margin-top:12px;width:100%;padding:11px;border:0;border-radius:8px;background:#111;color:#fff}
@media(prefers-color-scheme:dark){body{background:#111;color:#eee}input{background:#1c1c1c;color:#eee;border-color:#333}button,.b{background:#eee;color:#111}.m{color:#999}}</style>${body}`;
}

// Marks this browser as the one that started the sign-in. Only we can set a cookie on this address.
const startCookie = (id: string) => `oauth_${id}=1; Path=/oauth; HttpOnly; SameSite=Lax; Max-Age=900${process.env.WEBHOOK_URL?.startsWith("https") ? "; Secure" : ""}`;
export const startedHere = (cookies: string | undefined, id: string) => (cookies ?? "").split(/;\s*/).includes(`oauth_${id}=1`);
const toSignIn = (reply: FastifyReply, started: { connection: Connection; url: string }) => reply.header("set-cookie", startCookie(started.connection.id)).redirect(started.url);

export async function integrationRoutes(app: FastifyInstance) {
  // AppsError is the person's problem (400); anything else is ours (500, logged by Fastify)
  const handle = async <T>(reply: { code(n: number): { send(b: unknown): unknown } }, fn: () => Promise<T>) => {
    try {
      return await fn();
    } catch (error) {
      if (error instanceof AppsError) return reply.code(400).send({ error: error.message });
      throw error;
    }
  };

  app.get<{ Querystring: { search?: string; category?: string } }>("/apps", async (req, reply) => {
    const ctx = await context(req, reply);
    if (!ctx) return;
    const category = APP_CATEGORIES.find((c) => c.key === req.query.category)?.key;
    return handle(reply, () => searchApps(req.query.search ?? "", category, ctx));
  });

  app.get<{ Params: { app: string }; Querystring: { search?: string } }>("/apps/:app/actions", async (req, reply) => {
    const ctx = await context(req, reply);
    if (!ctx) return;
    return handle(reply, () => listActions(req.params.app, req.query.search, ctx));
  });

  app.get<{ Params: { action: string } }>("/actions/:action", async (req, reply) => {
    const ctx = await context(req, reply);
    if (!ctx) return;
    return handle(reply, async () => (await getAction(req.params.action, ctx)) ?? reply.code(404).send({ error: "Not found" }));
  });

  app.post<{ Params: { action: string }; Body: { input?: unknown } }>("/actions/:action/run", async (req, reply) => {
    const ctx = await context(req, reply);
    if (!ctx) return;
    return handle(reply, async () => ({ output: await runAction(ctx, req.params.action, req.body?.input ?? {}) }));
  });

  app.get<{ Querystring: { limit?: string } }>("/action-runs", async (req, reply) => {
    const ctx = await context(req, reply);
    if (!ctx) return;
    return listRuns(ctx, Number(req.query.limit) || 50);
  });

  app.get("/connections", async (req, reply) => {
    const ctx = await context(req, reply);
    if (!ctx) return;
    return listConnections(ctx);
  });

  // Connect another account. key: for apps connected by pasting a key; otherwise this starts a sign-in and
  // returns its link. connection: replace that account's login instead (reconnect).
  app.post<{ Body: { app: string; key?: string; connection?: string } }>(
    "/connections",
    {
      schema: {
        body: {
          type: "object",
          required: ["app"],
          properties: { app: { type: "string", maxLength: 100 }, key: { type: "string", maxLength: 2000 }, connection: { type: "string", maxLength: 40 } },
        },
      },
    },
    async (req, reply) => {
      const ctx = await context(req, reply);
      if (!ctx) return;
      const { app: name, key, connection } = req.body;
      return handle(reply, async () =>
        key === undefined ? connect(ctx, name, undefined, false, connection, returnBase(req)) : { connection: await connectWithKey(ctx, name, key, connection) },
      );
    },
  );

  // rename an account
  app.patch<{ Params: { id: string }; Body: { label: string } }>(
    "/connections/:id",
    { schema: { body: { type: "object", required: ["label"], properties: { label: { type: "string", maxLength: 200 } } } } },
    async (req, reply) => {
      const ctx = await context(req, reply);
      if (!ctx) return;
      return handle(reply, () => renameConnection(ctx, req.params.id, req.body.label));
    },
  );

  app.delete<{ Params: { id: string } }>("/connections/:id", async (req, reply) => {
    const ctx = await context(req, reply);
    if (!ctx) return;
    return handle(reply, async () => (await disconnect(ctx, "", undefined, req.params.id), { ok: true }));
  });

  // A Connect button opened: start the sign-in for whoever is logged in, then off to the provider's page.
  // popup=1: opened in a small window from the app, which closes itself when done
  // connection: reconnect that account; otherwise it adds one
  app.get<{ Params: { app: string }; Querystring: { chat?: string; popup?: string; connection?: string; t?: string; signin?: string } }>("/connect/:app", async (req, reply) => {
    // a link from a channel: signs in for its person, and ends on a "you can close this" page
    const link = req.query.t ? fromLink(req.query.t) : null;
    if (req.query.t && !link) return reply.type("text/html").send(`<!doctype html><meta charset="utf-8"><p style="font:15px system-ui;padding:24px">This link has expired. Ask for a new one.</p>`);
    const linked = link ? await offered(req.params.app.toLowerCase()).catch(() => null) : null;
    // an app that takes both: the page offers both, and its button comes back here with signin=1
    if (linked?.keyField && !(linked.signIn && req.query.signin === "1")) return reply.type("text/html").send(await keyPage(req.params.app.toLowerCase(), null, undefined, req.query.t));
    if (link)
      return handle(reply, async () =>
        toSignIn(reply, await connect({ workspaceId: link.w, userId: link.u }, req.params.app.toLowerCase(), undefined, true, link.c, process.env.WEBHOOK_URL)),
      );
    if (!(await currentUser(req))) return reply.redirect(`${FRONTEND_URL()}/login`);
    const ctx = await context(req, reply);
    if (!ctx) return;
    const chat = /^[0-9a-f-]{36}$/.test(req.query.chat ?? "") ? req.query.chat : undefined;
    const popup = req.query.popup === "1";
    return handle(reply, async () => toSignIn(reply, await connect(ctx, req.params.app.toLowerCase(), chat, popup, req.query.connection, returnBase(req))));
  });

  // The key form above, sent: the app checks the key before it's kept, and a wrong one shows the form again
  // with why. Plain form posts, so it works in any phone browser without the web app.
  app.addContentTypeParser("application/x-www-form-urlencoded", { parseAs: "string", bodyLimit: 8192 }, (_req, body, done) =>
    done(null, Object.fromEntries(new URLSearchParams(body as string))),
  );
  app.post<{ Params: { app: string }; Querystring: { t?: string }; Body: { key?: string } }>("/connect/:app", async (req, reply) => {
    const link = req.query.t ? fromLink(req.query.t) : null;
    const name = req.params.app.toLowerCase();
    if (!link) return reply.type("text/html").send(await keyPage(name, null, "This link has expired. Ask for a new one."));
    const key = String(req.body?.key ?? "").trim();
    try {
      if (!key || key.length > 2000) throw new AppsError("Paste the key first.");
      const c = await connectWithKey({ workspaceId: link.w, userId: link.u }, name, key, link.c);
      return reply.type("text/html").send(await keyPage(name, null, `${esc(c.name)} is connected (${esc(c.label)}). Go back to the chat and tell Emplio it's done.`));
    } catch (error) {
      if (!(error instanceof AppsError)) throw error;
      return reply.type("text/html").send(await keyPage(name, error.message, undefined, req.query.t));
    }
  });

  // Back from an app's own sign-in page (own OAuth). The signed state says which waiting connection it's for, and
  // that connection stops waiting here, so it works once.
  app.get<{ Params: { app: string }; Querystring: { code?: string; state?: string } }>("/oauth/:app/callback", async (req, reply) => {
    const name = req.params.app.toLowerCase();
    const provider = own;
    const s = req.query.state ? provider.readSignIn?.(name, req.query.state) : null;
    const row = s ? await db.query.connections.findFirst({ where: and(eq(connections.app, name), eq(connections.externalId, s.externalId)) }) : null;
    if (!s || !row) return reply.type("text/html").send(await keyPage(name, null, "This sign-in has expired. Connect again from the chat."));
    // a link someone was sent can't attach their account to the sender's connection
    if (provider.mustStartHere?.(name) && !startedHere(req.headers.cookie, row.id)) return reply.type("text/html").send(await keyPage(name, null, "This sign-in was started somewhere else. Connect again from the chat."));
    // said no on the app's page: a new connection goes, a working one is left as it was
    if (!req.query.code) {
      if (row.secret) await db.update(connections).set({ externalId: row.id, status: "active", updatedAt: new Date() }).where(eq(connections.id, row.id));
      else await db.delete(connections).where(eq(connections.id, row.id));
      return reply.redirect(s.back);
    }
    try {
      const { secret, label, refreshToken, expiresAt } = await provider.finishSignIn!(name, req.query.code, s.back, req.query);
      const others = (await accounts(row, name)).filter((o) => o.id !== row.id);
      const named = row.label ?? uniqueLabel(label ?? appName(name), others);
      await db.update(connections).set({ externalId: row.id, secret: encrypt(secret), refreshToken: refreshToken ? encrypt(refreshToken) : null, expiresAt: expiresAt ?? null, status: "active", label: named, updatedAt: new Date() }).where(eq(connections.id, row.id));
      record({ workspaceId: row.workspaceId, userId: row.userId, kind: "connection", summary: `Connected ${appName(name)} (${named})` });
      return reply.redirect(s.back);
    } catch (error) {
      if (!(error instanceof AppsError)) throw error;
      return reply.type("text/html").send(await keyPage(name, null, esc(error.message)));
    }
  });

  // Back from the provider's sign-in page. No login needed: it only re-checks the true status with the
  // provider, so a stranger hitting it changes nothing. Always lands on our own frontend.
  app.get<{ Params: { id: string }; Querystring: { chat?: string; popup?: string } }>("/connections/:id/done", async (req, reply) => {
    const id = /^[0-9a-f-]{36}$/.test(req.params.id) ? req.params.id : null;
    const row = id ? await db.query.connections.findFirst({ where: eq(connections.id, id) }) : null;
    if (row) await refresh(row);
    if (req.query.popup === "1")
      return reply
        .type("text/html")
        .send(`<!doctype html><meta charset="utf-8"><title>Done</title><p style="font:15px system-ui;padding:24px">All set. You can close this window.</p><script>window.close()</script>`);
    const chat = /^[0-9a-f-]{36}$/.test(req.query.chat ?? "") ? `/${req.query.chat}` : "";
    return reply.redirect(`${FRONTEND_URL()}/chat${chat}`);
  });
}
