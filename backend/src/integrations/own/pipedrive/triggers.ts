// Pipedrive telling us about changes the moment they happen. One webhook per connection, for every object and action
// ("*" and "*", webhooks v2), at /webhooks/app/pipedrive/<connection>. It proves itself with HTTP basic auth whose
// password is worked out from ENCRYPTION_KEY and the connection, never stored.
import { createHmac, timingSafeEqual } from "node:crypto";
import type { ActionDetail } from "@emplio/shared";
import { AppsError } from "../../types";
import type { Delivery } from "../index";
import { type Api, call, type Send } from "../openapi";

type Field = ActionDetail["input"][number];
const OWNER: Field = { name: "owner_id", type: "number", required: false, description: "Only items owned by this Pipedrive user (their id; get_all_users lists them)" };
const PIPELINE: Field = { name: "pipeline_id", type: "number", required: false, description: "Only deals in this pipeline (its id; get_all_pipelines lists them)" };
const STAGE: Field = { name: "stage_id", type: "number", required: false, description: "Only deals in this stage (its id; get_all_stages lists them)" };
const FIELD: Field = { name: "field", type: "string", required: false, description: "Only when this field changes, like value, stage_id, owner_id, status or a custom field's key" };
const OUTPUT: ActionDetail["input"] = [
  { name: "action", type: "string", required: true, description: "create, change or delete" },
  { name: "entity", type: "string", required: true, description: "What kind of thing: deal, person, organization, activity, lead, note, product, pipeline, stage or user" },
  { name: "id", type: "string", required: true, description: "Its id in Pipedrive" },
  { name: "data", type: "object", required: false, description: "The item as it is now (missing when deleted)" },
  { name: "previous", type: "object", required: false, description: "On a change: the old values of the fields that changed. On a delete: the item as it was" },
  { name: "meta", type: "object", required: true, description: "Who did it (user_id), when (timestamp), and from where (change_source)" },
];

type Trigger = { description: string; config: ActionDetail["input"]; output: ActionDetail["input"] };
const OBJECTS: Record<string, [label: string, extra: Field[]]> = {
  deal: ["deal", [PIPELINE, STAGE]],
  person: ["person (contact)", []],
  organization: ["organization", []],
  activity: ["activity (call, meeting, task...)", []],
  lead: ["lead", []],
  note: ["note", []],
  product: ["product", []],
  pipeline: ["pipeline", []],
  stage: ["pipeline stage", []],
  user: ["user of the company account", []],
};
const AGAIN = " A run that changes the same item starts this again, so say in the prompt when to stop.";

export const triggers: Record<string, Trigger> = {};
// trigger → [entity, action, extra test]; the extra test sees the item now and the old values
const RULES: Record<string, [string, string, ((now: any, old: any) => boolean)?]> = {};
const changed = (now: any, old: any, field: string) => old != null && typeof old === "object" && field in old && old[field] !== now?.[field];
for (const [entity, [label, extra]] of Object.entries(OBJECTS)) {
  const a = /^[aeiou]/.test(label) ? "An" : "A";
  triggers[`new_${entity}`] = { description: `${a} ${label} was added in Pipedrive.`, config: [OWNER, ...extra], output: OUTPUT };
  triggers[`${entity}_updated`] = { description: `${a} ${label} changed in Pipedrive.${AGAIN}`, config: [OWNER, ...extra, FIELD], output: OUTPUT };
  triggers[`${entity}_deleted`] = { description: `${a} ${label} was deleted in Pipedrive.`, config: [OWNER, ...extra], output: OUTPUT };
  RULES[`new_${entity}`] = [entity, "create"];
  RULES[`${entity}_updated`] = [entity, "change"];
  RULES[`${entity}_deleted`] = [entity, "delete"];
}
Object.assign(triggers, {
  deal_stage_changed: { description: "A deal moved to another stage in Pipedrive." + AGAIN, config: [OWNER, PIPELINE, STAGE], output: OUTPUT },
  deal_won: { description: "A deal was marked won in Pipedrive.", config: [OWNER, PIPELINE, STAGE], output: OUTPUT },
  deal_lost: { description: "A deal was marked lost in Pipedrive.", config: [OWNER, PIPELINE, STAGE], output: OUTPUT },
  activity_done: { description: "An activity (call, meeting, task...) was marked done in Pipedrive.", config: [OWNER], output: OUTPUT },
  // Composio's names for the same events, so automations written for it carry over
  new_deal_trigger: { ...triggers.new_deal!, description: "A deal was added in Pipedrive (same as new_deal)." },
  new_note_trigger: { ...triggers.new_note!, description: "A note was added in Pipedrive (same as new_note)." },
  new_organization_trigger: { ...triggers.new_organization!, description: "An organization was added in Pipedrive (same as new_organization)." },
});
RULES.deal_won = ["deal", "change", (now, old) => now?.status === "won" && changed(now, old, "status")];
RULES.deal_lost = ["deal", "change", (now, old) => now?.status === "lost" && changed(now, old, "status")];
RULES.activity_done = ["activity", "change", (now, old) => Boolean(now?.done) && changed(now, old, "done")];
RULES.deal_stage_changed = ["deal", "change", (now, old) => changed(now, old, "stage_id")];
RULES.new_deal_trigger = RULES.new_deal!;
RULES.new_note_trigger = RULES.new_note!;
RULES.new_organization_trigger = RULES.new_organization!;
export const events: Record<string, string> = Object.fromEntries(Object.entries(RULES).map(([t, [e, a]]) => [t, `${e}.${a}`]));

// webhooks v1 said added/updated/deleted and "object"; v2 says create/change/delete and "entity"
const ACTIONS: Record<string, string> = { added: "create", updated: "change", deleted: "delete", create: "create", change: "change", delete: "delete" };
type Meta = { id?: string; action?: string; entity?: string; object?: string; entity_id?: string | number; timestamp?: string | number; permitted_user_ids?: unknown; [k: string]: unknown };
export type EventData = { action: string; entity: string; id: string; data?: any; previous?: any; meta: Meta };

export const wanted = (config: unknown, data: unknown) => {
  const want = (config ?? {}) as { owner_id?: number | string; pipeline_id?: number | string; stage_id?: number | string; field?: string };
  const d = data as EventData;
  const item = d.data ?? d.previous ?? {};
  const owner = item.owner_id ?? item.user_id;
  const same = (want: unknown, got: unknown) => want === undefined || want === "" || String(want) === String(got && typeof got === "object" ? (got as { id?: unknown }).id ?? got : got);
  return same(want.owner_id, owner) && same(want.pipeline_id, item.pipeline_id) && same(want.stage_id, item.stage_id) && (!want.field || changed(d.data, d.previous, want.field));
};

const password = (connection: string) => createHmac("sha256", process.env.ENCRYPTION_KEY!).update(`pipedrive-webhook:${connection}`).digest("hex").slice(0, 32);
const USER = "emplio";
const hookUrl = (connection: string) => `${process.env.WEBHOOK_URL}/webhooks/app/pipedrive/${connection}`;

const V1 = "https://api.pipedrive.com/v1";
const send = (method: string, path: string, fields: string[] = []): Send => ({ method, base: V1, path, query: [], headers: [], ...(fields.length && { body: { kind: "fields" as const, fields: fields.map((f): [string, string] => [f, f]) } }) });
type Hook = { id: number; subscription_url: string; event_action: string; event_object: string; is_active: number | boolean };
const ours = async (api: Api, key: string, connection: string) => {
  const { data } = (await call(api, key, send("GET", "/webhooks"), {})) as { data?: Hook[] };
  return (data ?? []).filter((h) => h.subscription_url === hookUrl(connection));
};
const remove = (api: Api, key: string, id: number) => call(api, key, send("DELETE", "/webhooks/{id}"), { id });

// ponytail: one "*.*" webhook per connection, so every change in the account reaches us and is matched here; per-object webhooks if that traffic ever matters
export async function watch(api: Api, key: string, connection: string) {
  if (!process.env.WEBHOOK_URL) throw new AppsError("this server can't receive Pipedrive's events (WEBHOOK_URL isn't set)");
  const id = `pipedrive:${connection}`;
  const found = await ours(api, key, connection);
  const live = found.find((h) => h.event_action === "*" && h.event_object === "*" && Boolean(h.is_active));
  if (live) return id;
  // Pipedrive switches a webhook off when deliveries keep failing; a fresh one starts clean
  for (const h of found) await remove(api, key, h.id);
  await call(api, key, send("POST", "/webhooks", ["subscription_url", "event_action", "event_object", "name", "http_auth_user", "http_auth_password", "version"]), {
    subscription_url: hookUrl(connection),
    event_action: "*",
    event_object: "*",
    name: "Emplio",
    http_auth_user: USER,
    http_auth_password: password(connection),
    version: "2.0",
  });
  return id;
}

export async function unwatch(api: Api, key: string, id: string) {
  const [, connection = ""] = id.split(":");
  for (const h of await ours(api, key, connection)) await remove(api, key, h.id);
}

const authorized = (header: unknown, connection: string) => {
  const m = /^Basic (.+)$/i.exec(typeof header === "string" ? header : "");
  const got = Buffer.from(m ? Buffer.from(m[1]!, "base64").toString() : "");
  const want = Buffer.from(`${USER}:${password(connection)}`);
  return got.length === want.length && timingSafeEqual(got, want);
};

export async function receive(delivery: Delivery) {
  if (!authorized(delivery.headers.authorization, delivery.connection)) return null;
  const body = JSON.parse(delivery.body || "{}") as { meta?: Meta; data?: any; previous?: any; current?: any };
  const meta = body.meta ?? {};
  const action = ACTIONS[meta.action ?? ""];
  const entity = meta.entity ?? meta.object ?? "";
  const now = body.data ?? body.current ?? undefined;
  const old = body.previous ?? undefined;
  const names = Object.entries(RULES).filter(([, [e, a, test]]) => e === entity && a === action && (!test || test(now, old))).map(([t]) => t);
  const { permitted_user_ids: _, ...rest } = meta;
  const itemId = String(meta.entity_id ?? now?.id ?? old?.id ?? "");
  // `seen` is shared across apps, so the connection is in the id; a retry keeps Pipedrive's meta.id
  const id = [delivery.connection, meta.id ?? [entity, itemId, action, meta.timestamp].join(":")].join(":");
  const data: EventData = { action: action ?? String(meta.action ?? ""), entity, id: itemId, ...(now != null && { data: now }), ...(old != null && { previous: old }), meta: rest };
  return { events: async () => (names.length ? [{ id, triggers: names, data }] : []) };
}
