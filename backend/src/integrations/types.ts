import type { ActionDetail, ActionInfo, AppInfo, Connection } from "@emplio/shared";

// a trigger's settings (input) and what each event carries (output)
export type TriggerDetail = ActionDetail & { output: ActionDetail["input"] };

// What a supplier of app integrations must do. Composio is one; our own integrations (own/) are another.
// Names are always ours ("gmail", "gmail.send_email"): each provider maps them to its own, so
// connections, run history, skills and the CLI don't change when an app moves between providers.
export type Provider = {
  name: string;
  // apps it has a login set up for, so people can connect them now
  readyApps(): Promise<Set<string>>;
  // its name and logo for an app, and the key field when it's connected by pasting a key
  getApp(app: string): Promise<AppInfo | null>;
  listActions(app: string, words?: string): Promise<ActionInfo[]>;
  getAction(action: string): Promise<ActionDetail | null>;
  // Apps signed in on the provider's page. `owner` is a stable id for the person, for providers
  // that group sign-ins by user.
  startSignIn(app: string, owner: string, returnUrl: string): Promise<{ externalId: string; url: string }>;
  // A sign-in we finish ourselves (own OAuth): the waiting connection and where to go next, from the signed state
  // the app's page handed back (null: forged or too old); then the login its code is worth, and whose account it is.
  readSignIn?(app: string, state: string): { externalId: string; back: string } | null;
  finishSignIn?(app: string, code: string, back: string): Promise<{ secret: string; label: string | null; refreshToken?: string; expiresAt?: Date }>;
  // Apps connected with a key the person pastes: checks it works, and returns what to keep (encrypted).
  connectWithKey?(app: string, key: string): Promise<{ secret: string; label?: string }>;
  signInStatus(externalId: string): Promise<Connection["status"]>;
  // which account a sign-in is (an email address), to label the connection; null when it can't tell
  accountName?(externalId: string): Promise<string | null>;
  removeSignIn(externalId: string): Promise<void>;
  // login null: an app that needs no sign-in; never use a login our database doesn't hold.
  // secret: the decrypted key, for apps connected with one.
  run(action: string, input: unknown, login: { externalId: string; secret: string | null } | null, owner: string): Promise<unknown>;
  // Events an app can start an automation with (a new email, ...), named like actions: gmail.new_gmail_message.
  // Providers without them leave these out.
  listTriggers?(app: string, words?: string): Promise<ActionInfo[]>;
  getTrigger?(trigger: string): Promise<TriggerDetail | null>;
  // Start watching for the event on this login; events then arrive at our webhook carrying the returned id.
  startTrigger?(trigger: string, config: unknown, login: { externalId: string }, owner: string): Promise<string>;
  stopTrigger?(externalId: string): Promise<void>;
  // An app that tells us about this event itself, set up on this login: the id events arrive under. Null: it doesn't.
  startPush?(trigger: string, login: { externalId: string; secret: string | null }, config?: unknown): Promise<string | null>;
};

// A file attached to an action: {"file": "<path>"} in its input becomes one of these. Each provider hands it
// to the app its own way (Composio: uploaded to its storage first).
export class AppFile {
  constructor(
    readonly name: string,
    readonly mimetype: string,
    readonly bytes: Uint8Array,
  ) {}
  // as the run history stores it: not the bytes
  toJSON() {
    return { name: this.name, mimetype: this.mimetype, size: this.bytes.length };
  }
}

// Rebuilds a JSON-like value: f's answer replaces a value; undefined means look inside it.
export async function mapDeep(v: unknown, f: (v: unknown) => Promise<unknown>): Promise<unknown> {
  const r = await f(v);
  if (r !== undefined) return r;
  if (Array.isArray(v)) return Promise.all(v.map((x) => mapDeep(x, f)));
  if (v && typeof v === "object")
    return Object.fromEntries(await Promise.all(Object.entries(v).map(async ([k, x]) => [k, await mapDeep(x, f)])));
  return v;
}

// A failure to tell the person about, not a server bug. `expired`: only signing in again fixes it.
export class AppsError extends Error {
  constructor(message: string, readonly expired = false) {
    super(message);
  }
}
