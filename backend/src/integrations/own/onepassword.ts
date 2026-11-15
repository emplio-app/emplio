// 1Password as a place saved logins live (logins.ts). The owner makes a service account in 1Password that can read
// only the vaults Emplio may use, and pastes its token like any app key (encrypted in `connections`). Its logins and
// keys then show in Passwords & keys beside the ones saved in Emplio, and are used the same way: by name, filled by
// the server. Values are read from 1Password at the moment they're used and never stored; only the list of names,
// sites and usernames is kept in memory for a minute.
// ponytail: logins, API credentials and passwords that have a website; one-time codes (TOTP) and items with no
// website are left out (a value with no site can't be kept to its own site).
import { createClient, ItemCategory, ItemFieldType, type Client, type Item } from "@1password/sdk";
import { and, eq } from "drizzle-orm";
import { db } from "../../db";
import { connections } from "../../db/schema";
import { decrypt } from "../../secrets";
import { AppsError } from "../types";
import type { OwnApp } from "./index";

type Who = { workspaceId: string; userId: string };
// what Passwords & keys shows for one item: never a value
export type OnePasswordItem = { id: string; title: string; kind: "login" | "key"; site: string; username: string | null; fields: string[] };

const clients = new Map<string, Promise<Client>>();
function client(token: string) {
  let c = clients.get(token);
  if (!c) {
    c = createClient({ auth: token, integrationName: "Emplio", integrationVersion: "1" });
    clients.set(token, c);
    c.catch(() => clients.delete(token));
  }
  return c;
}

// 1Password's own errors as one the owner can act on
async function op<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/service account token|unauthori[sz]ed|authenticat|revoked|expired/i.test(message))
      throw new AppsError("1Password didn't accept that token. Make a new one in 1Password (Developer → Service accounts) and paste it again.", true);
    throw new AppsError(`1Password: ${message}`);
  }
}

const hostOf = (url: string) => {
  try {
    return new URL(url.includes("://") ? url : `https://${url}`).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
};

const KEYS = [ItemCategory.ApiCredentials, ItemCategory.Password];
const TYPED = [ItemFieldType.Text, ItemFieldType.Email, ItemFieldType.Phone, ItemFieldType.Concealed];

// The site an item is kept to: its first website, or an API credential's hostname field
const siteOf = (item: Item) => hostOf(item.websites[0]?.url ?? item.fields.find((f) => f.id === "hostname" || /^host(name)?$/i.test(f.title))?.value ?? "");

// A login's boxes as its sign-in page would label them, with what goes in each. 1Password's "username" is often an
// email, so it's labelled for both (logins.ts finds the box by these words).
function loginFields(item: Item) {
  const out: [string, string][] = [];
  for (const f of item.fields) {
    if (!f.value || !TYPED.includes(f.fieldType) || /^(notesPlain|hostname)$/.test(f.id)) continue;
    const label = f.id === "username" ? "Email or username" : f.id === "password" ? "Password" : f.title.trim();
    if (label && !out.some(([l]) => l === label)) out.push([label, f.value]);
  }
  return out.slice(0, 6);
}

// An API credential's or password item's one secret value
const keyValue = (item: Item) => item.fields.find((f) => f.fieldType === ItemFieldType.Concealed && f.value)?.value ?? "";

function describe(item: Item): OnePasswordItem | null {
  const site = siteOf(item);
  const kind = item.category === ItemCategory.Login ? "login" : KEYS.includes(item.category) ? "key" : null;
  if (!kind || !site) return null;
  const fields = kind === "login" ? loginFields(item) : [];
  if (kind === "login" ? !fields.length : !keyValue(item)) return null;
  return {
    id: `op:${item.vaultId}:${item.id}`,
    title: item.title,
    kind,
    site,
    username: kind === "login" ? (fields.find(([l]) => l !== "Password" && !/pass|pin|secret/i.test(l))?.[1] ?? null) : null,
    fields: fields.map(([l]) => l),
  };
}

// This person's 1Password tokens (one per connected account)
async function tokens(w: Who) {
  const rows = await db
    .select()
    .from(connections)
    .where(and(eq(connections.workspaceId, w.workspaceId), eq(connections.userId, w.userId), eq(connections.app, "onepassword"), eq(connections.status, "active")));
  return rows.filter((r) => r.secret).map((r) => decrypt(r.secret!));
}

// ponytail: per process, a minute; edits in 1Password show up within that
const listed = new Map<string, { at: number; items: Promise<{ items: OnePasswordItem[]; skipped: number }> }>();
const FRESH_MS = 60_000;

async function itemsFor(token: string) {
  const c = await op(() => client(token));
  const items: OnePasswordItem[] = [];
  let skipped = 0;
  for (const vault of await op(() => c.vaults.list())) {
    const overviews = await op(() => c.items.list(vault.id));
    if (!overviews.length) continue;
    const { individualResponses } = await op(() => c.items.getAll(vault.id, overviews.map((o) => o.id)));
    for (const r of individualResponses) {
      const item = r.content ? describe(r.content) : null;
      if (item) items.push(item);
      else skipped++;
    }
  }
  return { items, skipped };
}

// Everything usable in this person's connected 1Password vaults, and how many items were left out (no website, or
// a kind Emplio doesn't fill). Null: 1Password isn't connected. Throws AppsError when it can't be read.
export async function onePasswordItems(w: Who) {
  const all = await tokens(w);
  if (!all.length) return null;
  const out = { items: [] as OnePasswordItem[], skipped: 0 };
  for (const token of all) {
    let hit = listed.get(token);
    if (!hit || Date.now() - hit.at > FRESH_MS) {
      hit = { at: Date.now(), items: itemsFor(token) };
      listed.set(token, hit);
      hit.items.catch(() => listed.delete(token));
    }
    const { items, skipped } = await hit.items;
    out.items.push(...items);
    out.skipped += skipped;
  }
  return out;
}

// One item's values, read from 1Password now: a login's fields (label → text), or a key as { "the key": … }
export async function onePasswordValues(w: Who, id: string): Promise<Record<string, string>> {
  const [, vaultId, itemId] = id.split(":");
  for (const token of await tokens(w)) {
    const c = await op(() => client(token));
    const item = await c.items.get(vaultId!, itemId!).catch(() => null);
    if (!item) continue;
    if (item.category === ItemCategory.Login) return Object.fromEntries(loginFields(item));
    return { "the key": keyValue(item) };
  }
  throw new AppsError("that item isn't in 1Password any more, or Emplio's access to its vault was taken away");
}

export const onepassword: OwnApp = {
  app: "onepassword",
  name: "1Password",
  logo: "/logos/onepassword.svg",
  keyField: {
    label: "Service account token",
    help: "In 1Password, make a vault called Emplio and move in the logins it may use. Then Developer → Service accounts → New, give it read access to that vault only, and paste the token here. Your passwords stay in 1Password.",
    placeholder: "ops_…",
  },
  // the vaults it can read name the connection
  async check(key) {
    if (!key.trim().startsWith("ops_")) throw new AppsError("That isn't a service account token; it starts with ops_");
    const c = await op(() => client(key.trim()));
    const vaults = await op(() => c.vaults.list());
    if (!vaults.length) throw new AppsError("That token can't open any vault. Give the service account read access to your Emplio vault.");
    listed.delete(key.trim());
    return vaults.map((v) => v.title).join(", ");
  },
  // nothing to run: its logins are used through Passwords & keys (emplio logins)
  actions: {},
};

if (import.meta.main) {
  const item = (category: ItemCategory, fields: Partial<Item["fields"][number]>[], url = "https://www.Vercel.com/login") =>
    ({ id: "i1", vaultId: "v1", title: "Vercel", category, websites: url ? [{ url }] : [], fields: fields.map((f) => ({ id: "", title: "", fieldType: ItemFieldType.Text, value: "", ...f })) }) as unknown as Item;
  const login = describe(
    item(ItemCategory.Login, [
      { id: "username", title: "username", value: "me@shop.in" },
      { id: "password", title: "password", fieldType: ItemFieldType.Concealed, value: "s3cret" },
      { id: "totp", title: "one-time password", fieldType: ItemFieldType.Totp, value: "otpauth://x" },
    ]),
  );
  console.assert(login?.site === "vercel.com" && login.kind === "login", "login with its site");
  console.assert(login?.username === "me@shop.in" && login.fields.join() === "Email or username,Password", "fields, no one-time code", login);
  console.assert(describe(item(ItemCategory.Login, [{ id: "password", fieldType: ItemFieldType.Concealed, value: "x" }], "")) === null, "no website: left out");
  const key = describe(item(ItemCategory.ApiCredentials, [{ id: "credential", fieldType: ItemFieldType.Concealed, value: "rzp_live_x" }, { id: "hostname", title: "hostname", value: "api.razorpay.com" }], ""));
  console.assert(key?.kind === "key" && key.site === "api.razorpay.com" && key.username === null, "API credential kept to its hostname", key);
  console.assert(describe(item(ItemCategory.SecureNote, [{ value: "x" }])) === null, "notes left out");
  console.log("ok");
}
