// Typeform telling us the moment a form is filled in. Typeform's webhooks are per form: one per form and connection,
// tagged emplio_<connection>, at /webhooks/app/typeform/<connection>/<form>. Both events (a finished response and,
// where the plan has them, a partial one) come down that one webhook. Typeform signs each delivery with a secret
// worked out from ENCRYPTION_KEY and the connection, never stored.
import { createHmac, timingSafeEqual } from "node:crypto";
import type { ActionDetail } from "@emplio/shared";
import { AppsError } from "../../types";
import type { Delivery, WebhookEvent } from "../index";
import { type Api, call, type Send } from "../openapi";

const FORM = { name: "form_id", type: "string", required: true, description: "The form to watch: its link (https://mysite.typeform.com/to/u6nXL7) or id (u6nXL7); list_forms lists them" };
const OUTPUT: ActionDetail["input"] = [
  { name: "form_id", type: "string", required: true, description: "The form's id" },
  { name: "form_title", type: "string", required: false, description: "The form's title" },
  { name: "response_id", type: "string", required: true, description: "The response's id (Typeform calls it token); get_form_responses and delete_responses take it" },
  { name: "submitted_at", type: "string", required: false, description: "When it was sent (missing on a partial response)" },
  { name: "landed_at", type: "string", required: false, description: "When the person opened the form" },
  { name: "answers", type: "object[]", required: true, description: "Each answer: question (its title), ref, type and answer (text, number, a choice's label, a list of labels, a file's link...)" },
  { name: "hidden", type: "object", required: false, description: "The form's hidden fields, as filled in from its link (like a customer id or email)" },
  { name: "score", type: "number", required: false, description: "The quiz score, where the form keeps one" },
  { name: "variables", type: "object[]", required: false, description: "The form's variables (score, price...) at the end" },
  { name: "ending", type: "object", required: false, description: "Which ending (thank-you screen) the person reached" },
  { name: "response_url", type: "string", required: false, description: "The response in Typeform's results page" },
];

export const triggers: Record<string, { description: string; config: ActionDetail["input"]; output: ActionDetail["input"] }> = {
  new_response: { description: "Someone filled in and sent a Typeform form. The event has each question with its answer.", config: [FORM], output: OUTPUT },
  new_partial_response: {
    description: "Someone started a Typeform form and answered part of it without sending it (only on Typeform plans with partial responses). The event has the answers so far.",
    config: [FORM],
    output: OUTPUT,
  },
};
// trigger → Typeform's event type
export const events: Record<string, string> = { new_response: "form_response", new_partial_response: "form_response_partial" };

const secret = (connection: string) => createHmac("sha256", process.env.ENCRYPTION_KEY!).update(`typeform-webhook:${connection}`).digest("hex");
const tagFor = (connection: string) => `emplio_${connection.replace(/[^\w-]/g, "")}`.slice(0, 64);
const hookUrl = (connection: string, form: string) => `${process.env.WEBHOOK_URL}/webhooks/app/typeform/${connection}/${form}`;
const send = (method: string, path: string, fields: string[] = []): Send => ({ method, path, query: [], headers: [], ...(fields.length && { body: { kind: "fields" as const, fields: fields.map((f): [string, string] => [f, f]) } }) });

// a form's link or id → its id
export function formId(config: unknown) {
  const given = String((config as { form_id?: unknown } | null)?.form_id ?? "").trim();
  const id = /\/to\/([\w-]+)/.exec(given)?.[1] ?? /\/form\/([\w-]+)/.exec(given)?.[1] ?? given;
  if (!/^[\w-]+$/.test(id)) throw new AppsError("form_id: give the Typeform form's link or id (list_forms lists them)");
  return id;
}

type Hook = { tag: string; url: string; enabled: boolean; event_types?: Record<string, boolean> };
const ours = async (api: Api, key: string, connection: string, form: string) => {
  const { items } = (await call(api, key, send("GET", "/forms/{form_id}/webhooks"), { form_id: form })) as { items?: Hook[] };
  return (items ?? []).find((h) => h.tag === tagFor(connection));
};

// Make sure this form's webhook sends this event too. A PUT on the tag makes it or replaces it, switched back on.
export async function watch(api: Api, key: string, connection: string, event: string, config: unknown) {
  if (!process.env.WEBHOOK_URL) throw new AppsError("this server can't receive Typeform's events (WEBHOOK_URL isn't set)");
  const form = formId(config);
  const found = await ours(api, key, connection, form);
  const url = hookUrl(connection, form);
  const id = `typeform:${connection}:${form}`;
  if (found?.enabled && found.url === url && found.event_types?.[event]) return id;
  await call(api, key, send("PUT", "/forms/{form_id}/webhooks/{tag}", ["url", "enabled", "verify_ssl", "secret", "event_types"]), {
    form_id: form,
    tag: tagFor(connection),
    url,
    enabled: true,
    verify_ssl: true,
    secret: secret(connection),
    event_types: { ...found?.event_types, [event]: true },
  });
  return id;
}

export async function unwatch(api: Api, key: string, id: string) {
  const [, connection = "", form = ""] = id.split(":");
  if (await ours(api, key, connection, form)) await call(api, key, send("DELETE", "/forms/{form_id}/webhooks/{tag}"), { form_id: form, tag: tagFor(connection) });
}

const signed = (delivery: Delivery) => {
  const header = delivery.headers["typeform-signature"];
  const got = Buffer.from(typeof header === "string" ? header : "");
  const want = Buffer.from(`sha256=${createHmac("sha256", secret(delivery.connection)).update(delivery.body).digest("base64")}`);
  return got.length === want.length && timingSafeEqual(got, want);
};

type Answer = { field?: { id?: string; ref?: string; type?: string }; type: string; [k: string]: unknown };
type Response = {
  form_id?: string;
  token?: string;
  response_id?: string;
  submitted_at?: string;
  landed_at?: string;
  response_url?: string;
  hidden?: Record<string, unknown>;
  calculated?: { score?: number };
  variables?: unknown[];
  ending?: unknown;
  definition?: { title?: string; fields?: { id: string; title: string; ref?: string }[] };
  answers?: Answer[];
};

// an answer's value without Typeform's wrapping: a choice is its label, several choices their labels
const value = (a: Answer) => {
  const v = a[a.type] as any;
  if (v && typeof v === "object" && !Array.isArray(v)) return v.label ?? v.labels ?? v.other ?? v;
  return v;
};

export function eventData(r: Response) {
  const titles = new Map((r.definition?.fields ?? []).map((f) => [f.id, f.title]));
  return {
    form_id: r.form_id ?? "",
    form_title: r.definition?.title,
    response_id: r.token ?? r.response_id ?? "",
    submitted_at: r.submitted_at,
    landed_at: r.landed_at,
    answers: (r.answers ?? []).map((a) => ({ question: titles.get(a.field?.id ?? "") ?? a.field?.ref ?? a.field?.id, ref: a.field?.ref, type: a.field?.type ?? a.type, answer: value(a) })),
    hidden: r.hidden,
    score: r.calculated?.score,
    variables: r.variables,
    ending: r.ending,
    response_url: r.response_url,
  };
}

export async function receive(delivery: Delivery) {
  if (!signed(delivery)) return null;
  const body = JSON.parse(delivery.body || "{}") as { event_id?: string; event_type?: string; form_response?: Response; form_response_partial?: Response };
  return {
    events: async (): Promise<WebhookEvent[]> => {
      const r = body.form_response ?? body.form_response_partial;
      if (!r) return [];
      const names = Object.entries(events).filter(([, e]) => e === body.event_type).map(([t]) => t);
      // `seen` is shared across apps, so the connection is in the id; a retry keeps Typeform's event_id
      return names.length ? [{ id: `typeform:${delivery.connection}:${body.event_id ?? r.token}`, triggers: names, data: eventData(r) }] : [];
    },
  };
}
