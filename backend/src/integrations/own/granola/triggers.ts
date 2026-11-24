// Granola telling us the moment a note's summary is written, edited or shared (a Business or Enterprise feature). One
// webhook endpoint per connection, carrying every event its automations need. Granola makes the signing secret and shows
// it only once, so it's kept in the endpoint's own address, sealed with ENCRYPTION_KEY:
// /webhooks/app/granola/<connection>/<sealed secret>. Deliveries carry only the note's id, so the note is read with the
// connection's key before the automation sees it. Signatures follow Standard Webhooks.
import type { ActionDetail } from "@emplio/shared";
import { createHmac, timingSafeEqual } from "node:crypto";
import { decrypt, encrypt } from "../../../secrets";
import { AppsError } from "../../types";
import type { Delivery, WebhookEvent } from "../index";
import { type Api, call, type Send } from "../openapi";

// our trigger → Granola's event; every event its API offers
export const events: Record<string, string> = {
  note_ready: "note.generated",
  note_edited: "note.edited",
  note_shared: "note.access_granted",
};

const FOLDER = { name: "folder_id", type: "string", required: false, description: "Only notes in this folder (fol_...; list_folders lists them), directly or in a folder inside it" };
const OUTPUT: ActionDetail["input"] = [
  { name: "event", type: "string", required: true, description: "What happened: note.generated, note.edited or note.access_granted" },
  { name: "occurred_at", type: "string", required: true, description: "When it happened" },
  { name: "note_id", type: "string", required: true, description: "The note's id (not_...); get_note and get_transcript take it" },
  { name: "note", type: "object", required: false, description: "The note: title, owner, attendees, calendar_event, folders, web_url, summary (markdown) and the owner's own notes. Missing if the key can no longer read it" },
];
const trigger = (description: string) => ({ description, config: [FOLDER], output: OUTPUT });
export const triggers: Record<string, { description: string; config: ActionDetail["input"]; output: ActionDetail["input"] }> = {
  note_ready: trigger("Granola has written the notes for a meeting (its first AI summary). The event has the note with its summary; get_transcript gives what was said."),
  note_edited: trigger("A Granola note's summary is edited or written again."),
  note_shared: trigger("A Granola note is shared with you, directly or through a folder. Notes that were already written when shared come this way, not as note_ready."),
};

const base = (connection: string) => `${process.env.WEBHOOK_URL}/webhooks/app/granola/${connection}`;
const seal = (secret: string) => Buffer.from(encrypt(secret), "base64").toString("base64url");
const unseal = (sealed: string) => decrypt(Buffer.from(sealed, "base64url").toString("base64"));
const send = (method: string, path: string, fields: string[] = []): Send => ({
  method,
  path,
  query: [],
  headers: [],
  ...(fields.length && { body: { kind: "fields" as const, fields: fields.map((f): [string, string] => [f, f]) } }),
});
const LIST = send("GET", "/v1/webhook-endpoints");
const CREATE = send("POST", "/v1/webhook-endpoints", ["url", "scopes", "events"]);
const UPDATE = send("PATCH", "/v1/webhook-endpoints/{id}", ["url", "events", "enabled"]);
const REMOVE = send("DELETE", "/v1/webhook-endpoints/{id}");

type Endpoint = { id: string; url: string; events: string[]; enabled: boolean; signing_secret?: string };
const ours = async (api: Api, key: string, connection: string) =>
  ((await call(api, key, LIST, {})) as { webhook_endpoints?: Endpoint[] }).webhook_endpoints?.find((e) => e.url.startsWith(`${base(connection)}/`));

// a personal key takes personal and public notes (or whichever its workspace allows); a workspace key only "workspace"
const SCOPES = [["personal", "public"], ["workspace"], ["personal"], ["public"]];
const refused = (e: unknown) => e instanceof AppsError && !e.expired && /\((400|403)\)$/.test(e.message);

export async function watch(api: Api, key: string, connection: string, event: string) {
  if (!process.env.WEBHOOK_URL) throw new AppsError("this server can't receive Granola's events (WEBHOOK_URL isn't set)");
  const id = `granola:${connection}`;
  try {
    const found = await ours(api, key, connection);
    if (found) {
      if (!found.enabled || !found.events.includes(event)) await call(api, key, UPDATE, { id: found.id, events: [...new Set([...found.events, event])], enabled: true });
      return id;
    }
    let made: Endpoint | undefined;
    for (const scopes of SCOPES) {
      made = (await call(api, key, CREATE, { url: `${base(connection)}/new`, scopes, events: [event] }).catch((e) => {
        if (refused(e) && scopes !== SCOPES.at(-1)) return undefined;
        throw e;
      })) as Endpoint | undefined;
      if (made) break;
    }
    // the secret only exists once it's made, so the address learns it second
    await call(api, key, UPDATE, { id: made!.id, url: `${base(connection)}/${seal(made!.signing_secret!)}` }).catch(async (e) => {
      await call(api, key, REMOVE, { id: made!.id }).catch(() => {});
      throw e;
    });
  } catch (error) {
    if (!(error instanceof AppsError) || error.expired) throw error;
    throw new AppsError(`can't watch this Granola account: automations need Granola's webhooks, on a Business or Enterprise plan (${error.message})`);
  }
  return id;
}

export async function unwatch(api: Api, key: string, id: string) {
  const found = await ours(api, key, id.split(":")[1] ?? "");
  if (found) await call(api, key, REMOVE, { id: found.id });
}

// older than this isn't a delivery
const MAX_AGE_S = 5 * 60;
const header = (d: Delivery, name: string) => String(d.headers[name] ?? "");

export function signatureOk(delivery: Delivery) {
  let secret: string;
  try {
    secret = unseal(delivery.rest.split("/")[0] ?? "");
  } catch {
    return false;
  }
  const [id, t] = [header(delivery, "webhook-id"), header(delivery, "webhook-timestamp")];
  if (!id || !Number.isFinite(Number(t)) || Math.abs(Date.now() / 1000 - Number(t)) > MAX_AGE_S) return false;
  const want = Buffer.from(createHmac("sha256", Buffer.from(secret.replace(/^whsec_/, ""), "base64")).update(`${id}.${t}.${delivery.body}`).digest("base64"));
  return header(delivery, "webhook-signature")
    .split(" ")
    .some((v) => {
      const [version, sig = ""] = v.split(",");
      const got = Buffer.from(sig);
      return version === "v1" && got.length === want.length && timingSafeEqual(got, want);
    });
}

type Note = Record<string, unknown> & { summary_markdown?: string | null; summary_text?: string; folder_membership?: { id: string; parent_folder_id?: string | null }[] };
// the note without what's long and said twice (the plain-text copies, image links)
const brief = ({ summary_text, summary_markdown, private_notes_text, attachments, transcript, object, ...rest }: Note) => ({
  ...rest,
  summary: summary_markdown ?? summary_text,
});

export async function receive(api: Api, delivery: Delivery, key: string) {
  if (!signatureOk(delivery)) return null;
  return {
    events: async (): Promise<WebhookEvent[]> => {
      const body = JSON.parse(delivery.body || "{}") as { event_id?: string; event_type?: string; note_id?: string; occurred_at?: string; data?: { changed_fields?: string[] } };
      const names = Object.keys(events).filter((t) => events[t] === body.event_type);
      if (!names.length || !body.note_id) return [];
      const note = (await call(api, key, send("GET", "/v1/notes/{note_id}"), { note_id: body.note_id }).catch(() => undefined)) as Note | undefined;
      return [
        {
          id: `granola:${delivery.connection}:${body.event_id ?? header(delivery, "webhook-id")}`,
          triggers: names,
          data: { event: body.event_type, occurred_at: body.occurred_at, note_id: body.note_id, changed_fields: body.data?.changed_fields, note: note && brief(note) },
        },
      ];
    },
  };
}

// ponytail: matches the note's own folder and that folder's parent; a folder two levels up isn't seen
export const wanted = (config: unknown, data: unknown) => {
  const folder = String((config as { folder_id?: string } | null)?.folder_id ?? "").toLowerCase();
  if (!folder) return true;
  const note = (data as { note?: Note }).note;
  return Boolean(note?.folder_membership?.some((f) => f.id.toLowerCase() === folder || f.parent_folder_id?.toLowerCase() === folder));
};
