// A business's settings for how its AI employee behaves (the list is SETTING_FIELDS in shared). Stored on
// the workspace as only what was changed; read once per reply, so a change applies from the next message.
import { KEY_MASK, SETTING_FIELDS, type Settings, type SettingsResponse } from "@emplio/shared";
import { cloud } from "./cloud";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { context } from "./auth";
import { db } from "./db";
import { record } from "./activity";
import { users, workspaces } from "./db/schema";
import { customModelProblem, listModels } from "./models";
import { decrypt, encrypt } from "./secrets";

// the env vars these used to be still move the defaults, for every business
const env = process.env;
export const DEFAULTS = {
  ...(Object.fromEntries(SETTING_FIELDS.map((f) => [f.key, f.default])) as Settings),
  ...(Number(env.COMPACT_AT_TOKENS) && { compactAt: Number(env.COMPACT_AT_TOKENS) }),
  ...(env.VISUAL_REPLIES && { visualReplies: env.VISUAL_REPLIES === "true" }),
} satisfies Settings;

// A stored value that no longer fits its field (the list changed) falls back to the default.
const check = (key: string, value: unknown): string | null => {
  const f = SETTING_FIELDS.find((f) => f.key === key);
  if (!f) return `There's no setting called "${key}".`;
  if (f.type === "number")
    return typeof value === "number" && Number.isInteger(value) && value >= f.min && value <= f.max
      ? null
      : `${f.label}: pick a whole number from ${f.min.toLocaleString()} to ${f.max.toLocaleString()}.`;
  if (f.type === "toggle") return typeof value === "boolean" ? null : `${f.label}: must be on or off.`;
  if (f.type === "key") return typeof value === "string" && value.length <= 500 && !value.startsWith(KEY_MASK) ? null : `${f.label}: paste the whole key.`;
  // only the shape here: whether OpenRouter still offers it is checked on save (a model it drops later
  // fails that reply with OpenRouter's own error rather than silently switching brains)
  if (f.type === "model") return value === "auto" || (typeof value === "string" && /^[\w.-]+\/[\w.:-]+$/.test(value)) ? null : `${f.label}: not a model.`;
  // the env default may be a model not offered on the list
  return f.options.some((o) => o.value === value) || value === DEFAULTS[f.key] ? null : `${f.label}: not one of the choices.`;
};

const KEYS = new Set<string>(SETTING_FIELDS.filter((f) => f.type === "key").map((f) => f.key));
// the per-job model picks, which a Quality choice puts back on Auto
const MODEL_FIELD_KEYS = SETTING_FIELDS.filter((f) => f.type === "model").map((f) => f.key);

// A key that won't decrypt (ENCRYPTION_KEY changed) counts as not set.
const opened = (k: string, v: unknown) => {
  if (!KEYS.has(k)) return v;
  try {
    return decrypt(v as string);
  } catch {
    return undefined;
  }
};

// As saved, with keys in the clear: what Settings shows and changes.
async function savedSettings(workspaceId: string): Promise<Settings> {
  const row = await db.query.workspaces.findFirst({ where: eq(workspaces.id, workspaceId), columns: { settings: true } });
  const saved = Object.entries(row?.settings ?? {})
    .map(([k, v]) => [k, opened(k, v)] as const)
    .filter(([k, v]) => v !== undefined && !check(k, v));
  return { ...DEFAULTS, ...Object.fromEntries(saved) };
}

// What the business runs on: as saved, unless the cloud holds it to a Quality choice (the free trial) and it isn't
// paying for its AI with its own key. For the server's own use only, never sent anywhere (forPeople masks keys).
export async function settingsFor(workspaceId: string): Promise<Settings> {
  const s = await savedSettings(workspaceId);
  const lock = s.openrouterKey ? null : await cloud.models.lock(workspaceId);
  return lock ? { ...s, modelSet: lock.modelSet, ...Object.fromEntries(MODEL_FIELD_KEYS.map((k) => [k, "auto"])) } : s;
}

const masked = (k: string, v: unknown) => (KEYS.has(k) && v ? `${KEY_MASK}${String(v).slice(-4)}` : v);
const forPeople = (s: Settings) => Object.fromEntries(Object.entries(s).map(([k, v]) => [k, masked(k, v)])) as Settings;

// ponytail: OpenRouter is the only key there is; look the checker up by field when a second one comes
async function keyWorks(key: string) {
  const res = await fetch("https://openrouter.ai/api/v1/key", { headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(15_000) }).catch(() => null);
  return res?.ok ?? false;
}

const canEdit = (role: string) => role !== "member";

// body: the settings to change; null (or the default) puts one back to the default. What's wrong with them, or null.
// Shared by Settings and the console.
export async function changeSettings(who: { workspaceId: string; userId: string }, body: Record<string, unknown>): Promise<string | null> {
  const errors = Object.entries(body).flatMap(([k, v]) => (v === null ? [] : (check(k, v) ?? [])));
  const picked = SETTING_FIELDS.filter((f) => f.type === "model" && typeof body[f.key] === "string" && body[f.key] !== "auto");
  if (picked.length && !errors.length) {
    const offered = new Set((await listModels()).map((m) => m.id));
    // one from the picker's list, or any other OpenRouter model typed in by name (Custom) that can use tools
    for (const f of picked) {
      const id = body[f.key] as string;
      const problem = offered.has(id) ? null : await customModelProblem(id);
      if (problem) errors.push(`${f.label}: ${problem}`);
    }
  }
  for (const k of KEYS)
    if (typeof body[k] === "string" && body[k] && !errors.length && !(await keyWorks((body[k] as string).trim())))
      errors.push(`${SETTING_FIELDS.find((f) => f.key === k)!.label}: OpenRouter didn't accept that key.`);
  if (errors.length) return errors.join(" ");
  // ponytail: read-then-write, so two admins saving at once can lose one's change; jsonb || in SQL if that bites
  const row = await db.query.workspaces.findFirst({ where: eq(workspaces.id, who.workspaceId), columns: { settings: true } });
  const next: Record<string, unknown> = { ...row?.settings };
  for (const [k, v] of Object.entries(body))
    if (v === null || v === DEFAULTS[k as keyof Settings]) delete next[k];
    else next[k] = KEYS.has(k) ? encrypt((v as string).trim()) : v;
  await db.update(workspaces).set({ settings: next }).where(eq(workspaces.id, who.workspaceId));
  // keys only as "changed", never their value, even encrypted
  const shown = (s: Record<string, unknown>) => Object.fromEntries(Object.entries(s).map(([k, v]) => [k, KEYS.has(k) ? "(set)" : v]));
  const changed = Object.keys(body).map((k) => `${SETTING_FIELDS.find((f) => f.key === k)?.label ?? k}: ${KEYS.has(k) ? (body[k] ? "new key" : "removed") : (body[k] ?? "default")}`);
  record({ workspaceId: who.workspaceId, userId: who.userId, kind: "settings", summary: `Changed settings: ${changed.join(", ")}`, detail: { before: shown(row?.settings ?? {}), after: shown(next) } });
  return null;
}

export const settingsForPeople = async (workspaceId: string) => forPeople(await savedSettings(workspaceId));

// what the Settings dialog gets, after a read or a save
async function settingsResponse(workspaceId: string, role: string): Promise<SettingsResponse> {
  const saved = await savedSettings(workspaceId);
  const lock = saved.openrouterKey ? null : await cloud.models.lock(workspaceId);
  return { values: forPeople(saved), defaults: DEFAULTS, canEdit: canEdit(role), modelLock: lock?.why };
}

export async function settingsRoutes(app: FastifyInstance) {
  app.get("/settings", async (req, reply) => {
    const ctx = await context(req, reply);
    if (!ctx) return;
    return settingsResponse(ctx.workspaceId, ctx.role);
  });

  // body: the settings to change; null (or the default) puts one back to the default
  app.put<{ Body: Record<string, unknown> }>("/settings", { schema: { body: { type: "object" } } }, async (req, reply) => {
    const ctx = await context(req, reply);
    if (!ctx) return;
    if (!canEdit(ctx.role)) return reply.code(403).send({ error: "Only the owner or an admin can change settings." });
    const problem = await changeSettings(ctx, req.body);
    if (problem) return reply.code(400).send({ error: problem });
    return settingsResponse(ctx.workspaceId, ctx.role);
  });
}

// `emplio settings`: Emplio reads and changes the business's settings and name (owner and admin chats: what they could
// change in Settings themselves) and the person's own name (anyone's chat). Every change waits for a tap on an Allow
// card (`allow`, which never offers "Always allow"), so nothing it read in an email or on a page can change them, and
// runs nobody is watching can't. Keys only ever in Settings.
const SETTINGS_USAGE = `usage: emplio settings                          every setting: its value and what it can be
       emplio settings set <setting> <value>    change one ("default" puts it back); they tap Allow first
       emplio settings set name "<name>"        rename the business (e.g. once you learn its real name in setup)
       emplio settings set my-name "<name>"     the person's own name, as the team sees it`;

const shownValue = (k: string, v: unknown) => (KEYS.has(k) ? (v ? "(set)" : "(none)") : typeof v === "boolean" ? (v ? "on" : "off") : String(v));

function parseValue(f: (typeof SETTING_FIELDS)[number], raw: string): unknown {
  if (raw === "default") return null;
  if (f.type === "number") return Number(raw.replace(/[,_]/g, ""));
  if (f.type === "toggle") return /^(on|true|yes)$/i.test(raw) ? true : /^(off|false|no)$/i.test(raw) ? false : raw;
  return raw;
}

type Allow = (title: string, input: unknown, run: () => Promise<unknown>) => Promise<string | null>;
// asks, then does it: what to tell the agent
async function asked(allow: Allow, title: string, input: unknown, run: () => Promise<unknown>, done: string) {
  const refused = await allow(title, input, run);
  if (refused) return refused;
  try {
    await run();
  } catch (e) {
    return `error: ${(e as Error).message}`;
  }
  return done;
}

type Who = { workspaceId: string; userId: string; role: string };
export async function settingsCommand(who: Who, args: string[], allow: Allow) {
  const [sub, key, ...rest] = args;
  const [w, me] = await Promise.all([
    db.query.workspaces.findFirst({ where: eq(workspaces.id, who.workspaceId), columns: { name: true } }),
    db.query.users.findFirst({ where: eq(users.id, who.userId), columns: { name: true } }),
  ]);
  if (!sub || sub === "list") {
    const s = forPeople(await savedSettings(who.workspaceId));
    const lock = s.openrouterKey ? null : await cloud.models.lock(who.workspaceId);
    const lines = SETTING_FIELDS.map((f) => {
      const can = f.type === "choice" ? f.options.map((o) => (o.value === o.label.toLowerCase() ? o.value : `${o.value} (${o.label})`)).join(" | ") : f.type === "number" ? `${f.min}–${f.max} ${f.unit}` : f.type === "toggle" ? "on | off" : f.type === "model" ? "auto | <provider/model>" : "set in Settings only";
      return `${f.key}: ${shownValue(f.key, s[f.key as keyof Settings])}   ${f.label}. ${f.help} (${can})`;
    });
    return [
      `my-name: ${me?.name}   This person's own name (they can change it)`,
      `name: ${w?.name}   The business's name`,
      ...lines,
      ...(canEdit(who.role) ? [] : ["Only the owner or an admin can change the business's settings and name."]),
      ...(lock ? [`Note: ${lock.why} Until then the models run as "save" (Standard), whatever these say.`] : []),
    ].join("\n");
  }
  if (sub !== "set" || !key || !rest.length) return SETTINGS_USAGE;
  const raw = rest.join(" ").trim();
  const text = raw.replace(/^["']|["']$/g, "").trim().slice(0, 100);

  if (key === "my-name") {
    if (!text) return "error: give the name";
    const run = async () => {
      await db.update(users).set({ name: text }).where(eq(users.id, who.userId));
      record({ workspaceId: who.workspaceId, userId: who.userId, kind: "settings", summary: `Changed their name from ${me?.name} to ${text}` });
    };
    return asked(allow, `Change your name to ${text}`, { "your name": `${me?.name} → ${text}` }, run, `Their name is now ${text}.`);
  }
  if (!canEdit(who.role)) return "error: only the owner or an admin can change the business's settings. Tell them what you'd change and why.";
  if (key === "name") {
    if (!text) return "error: give the business's name";
    const run = async () => {
      await db.update(workspaces).set({ name: text }).where(eq(workspaces.id, who.workspaceId));
      record({ workspaceId: who.workspaceId, userId: who.userId, kind: "settings", summary: `Renamed the business from ${w?.name} to ${text}` });
    };
    return asked(allow, `Rename the business to ${text}`, { business: `${w?.name} → ${text}` }, run, `The business is now called ${text}.`);
  }
  const f = SETTING_FIELDS.find((f) => f.key === key);
  if (!f) return `error: there's no setting called "${key}". emplio settings lists them.`;
  if (f.type === "key") return `error: ${f.label} is pasted in Settings by the owner, never in a chat.`;
  const value = parseValue(f, raw);
  const bad = value === null ? null : check(key, value);
  if (bad) return `error: ${bad}`;
  const to = value === null ? `default (${shownValue(key, DEFAULTS[key as keyof Settings])})` : shownValue(key, value);
  const from = shownValue(key, (await savedSettings(who.workspaceId))[key as keyof Settings]);
  const run = async () => {
    const problem = await changeSettings(who, { [key]: value });
    if (problem) throw new Error(problem);
  };
  return asked(allow, `Change ${f.label} to ${to}`, { setting: f.label, from, to }, run, `${f.label} is now ${to}. It applies from the next message.`);
}
