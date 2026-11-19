// Calls to Emplio's WhatsApp server (the whatsapp/ folder at the top of the repo), which holds the linked accounts.
// WHATSAPP_URL: where it is (http://whatsapp:4200 in Docker); WHATSAPP_TOKEN: the secret it shares with us.
import { AppsError } from "../../types";

export const whatsappReady = () => Boolean(process.env.WHATSAPP_URL && process.env.WHATSAPP_TOKEN);

const ACCOUNT = /^[0-9a-f-]{36}$/;
// the login we keep for a connection is the WhatsApp server's id for the account
export function account(key: string) {
  if (!ACCOUNT.test(key)) throw new AppsError("this WhatsApp link isn't valid; link WhatsApp again", true);
  return key;
}

// The account is gone or was unlinked from the phone: the connection has to be linked again.
const GONE = /no such account|unlinked|link it again/;

export async function wa(method: string, path: string, body?: unknown): Promise<any> {
  const res = await waRaw(method, path, body);
  const out = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new AppsError(out.error ?? `the WhatsApp server answered ${res.status}`, GONE.test(out.error ?? ""));
  return out;
}

export async function waRaw(method: string, path: string, body?: unknown) {
  if (!whatsappReady()) throw new AppsError("WhatsApp isn't set up on this server");
  return fetch(new URL(path, process.env.WHATSAPP_URL), {
    method,
    headers: { authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`, ...(body !== undefined && { "content-type": "application/json" }) },
    ...(body !== undefined && { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(90_000),
  }).catch(() => {
    throw new AppsError("Emplio's WhatsApp server can't be reached right now. Try again in a few minutes.");
  });
}
