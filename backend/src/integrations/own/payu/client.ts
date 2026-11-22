// Talking to PayU India with the business's merchant key and salt. Nearly everything is one form POST to
// /merchant/postservice.php?form=2 carrying `command`, var1…varN and hash = sha512(key|command|var1|salt). The
// settlement reports are REST GETs signed with sha512(body|date|salt) in an Authorization header, plus the
// merchant's numeric MID; the offers lookups are JSON POSTs signed with HMAC-SHA256. Test keys live on test.payu.in / apitest.payu.in, live keys on info.payu.in.
import { createHash, createHmac } from "node:crypto";
import type { z } from "zod";
import { AppsError } from "../../types";
import type { OwnAction } from "../index";

export type Creds = { key: string; salt: string; test: boolean };

const FORMAT = "enter the merchant key and the salt (and pick Test for test-mode keys)";

// The saved login: KEY:SALT for the live account, KEY:SALT:test for PayU's test environment.
export function creds(secret: string): Creds {
  const parts = secret.trim().split(":");
  const test = parts.length === 3 && parts[2]!.toLowerCase() === "test";
  if (!(parts.length === 2 || test)) throw new AppsError(FORMAT);
  const [key, salt] = parts as [string, string];
  if (!key || !salt) throw new AppsError(FORMAT);
  return { key, salt, test };
}

export const sha512 = (s: string) => createHash("sha512").update(s).digest("hex");
export const apiHash = (c: Creds, command: string, var1: string) => sha512(`${c.key}|${command}|${var1}|${c.salt}`);

const HELP = "PayU Dashboard → Developers (or Payment Gateway → Settings) → Merchant Key and Salt";
const postUrl = (c: Creds) => `${c.test ? "https://test.payu.in" : "https://info.payu.in"}/merchant/postservice.php?form=2`;

// PayU answers a wrong key or salt with a 200 and words, not a 401
const REFUSED = /invalid hash|invalid key|invalid merchant|sorry, some problem occurred|merchant key is not valid|unauthori[sz]ed/i;
const refused = (why: string) => new AppsError(`PayU didn't accept the merchant key and salt; check them (${HELP}) and reconnect`, true, why);

// One postservice command. Vars left out at the end are dropped; a gap in the middle is sent empty.
export async function command(secret: string, name: string, vars: (string | undefined)[]) {
  const c = creds(secret);
  while (vars.length && vars.at(-1) === undefined) vars.pop();
  const var1 = vars[0] ?? "";
  const form = new URLSearchParams({ key: c.key, command: name, hash: apiHash(c, name, var1) });
  vars.forEach((v, i) => form.append(`var${i + 1}`, v ?? ""));
  const res = await fetch(postUrl(c), { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" }, body: form.toString() });
  const text = await res.text();
  let out: any = text;
  try {
    out = JSON.parse(text);
  } catch {}
  const msg = typeof out === "string" ? out : String(out?.msg ?? out?.message ?? "");
  if (REFUSED.test(msg) || res.status === 401) throw refused(msg.slice(0, 200));
  if (!res.ok) throw new AppsError(`PayU: ${msg.slice(0, 300) || res.statusText} (${res.status})`);
  return out;
}

// A settlement report: GET on info.payu.in (apitest.payu.in in test) signed with the salt.
export async function settlement(secret: string, path: string, mid: string, query: Record<string, string | number | undefined> = {}) {
  const c = creds(secret);
  const date = new Date().toUTCString();
  // the body is part of the signature; these are GETs, so it's empty
  const authorization = `hmac username="${c.key}", algorithm="sha512", headers="date", signature="${sha512(`|${date}|${c.salt}`)}"`;
  const q = new URLSearchParams(Object.entries(query).flatMap(([k, v]) => (v === undefined ? [] : [[k, String(v)]])));
  const base = c.test ? (path.startsWith("/settlement/v1") ? "https://test.payu.in" : "https://apitest.payu.in") : "https://info.payu.in";
  const res = await fetch(`${base}${path}${q.size ? `?${q}` : ""}`, { headers: { Date: date, mid, Authorization: authorization, Accept: "application/json" } });
  const text = await res.text();
  let out: any = text;
  try {
    out = JSON.parse(text);
  } catch {}
  const msg = typeof out === "string" ? out : String(out?.message ?? out?.msg ?? "");
  if (res.status === 401 || /invalid signature|unauthori[sz]ed/i.test(msg)) throw refused(msg.slice(0, 200));
  if (!res.ok) throw new AppsError(`PayU: ${msg.slice(0, 300) || res.statusText} (${res.status})`);
  return out;
}

// The Offers API: a JSON POST on api.payu.in (sandbox.payu.in in test), signed with HMAC-SHA256 over
// "<date>\n<digest>" where digest = base64(sha256(body)); PayU's docs call the HMAC secret the merchant secret (the salt).
export async function offers(secret: string, path: string, body: unknown) {
  const c = creds(secret);
  const json = JSON.stringify(body);
  const date = new Date().toUTCString();
  const digest = createHash("sha256").update(json).digest("base64");
  const signature = createHmac("sha256", c.salt).update(`${date}\n${digest}`).digest("base64");
  const res = await fetch(`${c.test ? "https://sandbox.payu.in" : "https://api.payu.in"}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Date: date,
      Digest: digest,
      platformId: "1",
      Authorization: `hmac username="${c.key}", algorithm="hmac-sha256", headers="date digest", signature="${signature}"`,
    },
    body: json,
  });
  const text = await res.text();
  let out: any = text;
  try {
    out = JSON.parse(text);
  } catch {}
  const msg = typeof out === "string" ? out : String(out?.message ?? out?.msg ?? "");
  if (res.status === 401 || res.status === 403) throw refused(msg.slice(0, 200));
  if (!res.ok) throw new AppsError(`PayU: ${msg.slice(0, 300) || res.statusText} (${res.status})`);
  return out;
}

const text = (v: unknown) => (v === undefined || v === null ? undefined : typeof v === "object" ? JSON.stringify(v) : String(v));

// An action that runs one command: `vars` turns the checked input into var1, var2…
export const cmd = (name: string, description: string, input: z.ZodObject, vars: (i: any) => unknown[], readOnly: boolean): OwnAction => ({
  description,
  input,
  readOnly,
  run: (i: Record<string, unknown>, key: string) => command(key, name, vars(i).map(text)),
});

// A command whose var1 is the whole input as JSON (the recurring-payment, QR and checkout commands)
const defined = (i: Record<string, unknown>) => Object.fromEntries(Object.entries(i).filter(([, v]) => v !== undefined));
export const jsonCmd = (name: string, description: string, input: z.ZodObject, readOnly: boolean) => cmd(name, description, input, (i) => [defined(i)], readOnly);
