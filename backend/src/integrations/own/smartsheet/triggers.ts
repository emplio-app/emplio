// Smartsheet telling us about changes on a sheet the moment they happen. Its webhooks are per sheet: one per connection
// and sheet, for every event ("*.*"), at /webhooks/app/smartsheet/<connection>/<sheet>/<token>, where the token is worked
// out from ENCRYPTION_KEY, the connection and the sheet, never stored. A new webhook is switched on with a handshake:
// Smartsheet sends a challenge and we echo it. Callbacks carry only ids, so the row, cell, comment... is read back here.
// The plan's seat changes (admins) come the same way from a plan-wide webhook.
import { createHmac, timingSafeEqual } from "node:crypto";
import type { ActionDetail } from "@emplio/shared";
import { AppsError } from "../../types";
import type { Delivery, WebhookEvent } from "../index";
import { call, type Send } from "../openapi";
import { AGENT, api } from "./api";

type Field = ActionDetail["input"][number];
const SHEET: Field = { name: "sheet_id", type: "string", required: true, description: "The sheet to watch: its id (list_sheets lists them; in Smartsheet, File → Properties → Sheet ID)" };
const ROW: Field = { name: "row_id", type: "string", required: false, description: "Only this row (its id)" };
const COLUMN: Field = { name: "column", type: "string", required: false, description: "Only cells in this column: its name, like Status, or its id" };
const VALUE: Field = { name: "value", type: "string", required: false, description: "Only when the cell's new value is this, like Done (not case sensitive)" };
const MINE: Field = { name: "include_emplio_changes", type: "boolean", required: false, description: "Also start for changes Emplio itself made (off by default, so a run that edits the sheet doesn't start itself again)" };
const PLAN: Field = { name: "plan_id", type: "string", required: false, description: "The Smartsheet plan's id (the connected admin's own plan if left out)" };
const OUTPUT: ActionDetail["input"] = [
  { name: "event", type: "string", required: true, description: "What happened, as <object>.<action>: row.created, cell.updated, comment.created, sheet.updated..." },
  { name: "sheet_id", type: "string", required: true, description: "The sheet it happened on (the plan, for seat changes)" },
  { name: "id", type: "string", required: false, description: "The row, column, comment, discussion or attachment's id" },
  { name: "row_id", type: "string", required: false, description: "The row, for row and cell events" },
  { name: "column_id", type: "string", required: false, description: "The column, for cell events" },
  { name: "column", type: "string", required: false, description: "The column's name, for cell events" },
  { name: "value", type: "any", required: false, description: "The cell's value now, for cell events" },
  { name: "row", type: "object", required: false, description: "The row as it is now: id, row_number and values by column name (missing once deleted)" },
  { name: "item", type: "object", required: false, description: "The comment, discussion, attachment or column as it is now (missing once deleted)" },
  { name: "user_id", type: "string", required: false, description: "Who did it (their Smartsheet user id)" },
  { name: "timestamp", type: "string", required: false, description: "When it happened" },
];

type Rule = { on: string[]; about: string; config: Field[] };
const AGAIN = " A run that edits the same sheet only starts this again if include_emplio_changes is on.";
const crud = (object: string, label: string, config: Field[] = []): Record<string, Rule> => ({
  [`${object}_created`]: { on: [`${object}.created`], about: `${label} was added on a Smartsheet sheet.`, config },
  [`${object}_updated`]: { on: [`${object}.updated`], about: `${label} was changed on a Smartsheet sheet.${AGAIN}`, config },
  [`${object}_deleted`]: { on: [`${object}.deleted`], about: `${label} was deleted on a Smartsheet sheet.`, config },
});
const RULES: Record<string, Rule> = {
  new_row: { on: ["row.created"], about: "A row was added to a Smartsheet sheet. The event has the row's values by column name.", config: [] },
  row_updated: { on: ["row.updated"], about: `A row on a Smartsheet sheet changed (any of its cells, its place or its format). The event has the row's values now; cell_changed says which cell.${AGAIN}`, config: [ROW] },
  row_deleted: { on: ["row.deleted"], about: "A row was deleted from a Smartsheet sheet.", config: [ROW] },
  cell_changed: { on: ["cell.created", "cell.updated", "cell.deleted"], about: `A cell on a Smartsheet sheet got a value, changed or was cleared, like a Status set to Done. Narrow it with column and value.${AGAIN}`, config: [COLUMN, VALUE, ROW] },
  cell_created: { on: ["cell.created"], about: "An empty cell on a Smartsheet sheet got a value.", config: [COLUMN, VALUE, ROW] },
  cell_updated: { on: ["cell.updated"], about: `A cell's value on a Smartsheet sheet changed.${AGAIN}`, config: [COLUMN, VALUE, ROW] },
  cell_deleted: { on: ["cell.deleted"], about: "A cell on a Smartsheet sheet was cleared.", config: [COLUMN, ROW] },
  ...crud("column", "A column"),
  ...crud("comment", "A comment (a reply in a conversation)", [ROW]),
  ...crud("discussion", "A conversation", [ROW]),
  ...crud("attachment", "A file or link attachment", [ROW]),
  sheet_updated: { on: ["sheet.updated"], about: `A Smartsheet sheet's name or settings changed.${AGAIN}`, config: [] },
  sheet_deleted: { on: ["sheet.deleted"], about: "A Smartsheet sheet was deleted.", config: [] },
  sheet_activity: { on: [], about: "Anything at all happened on a Smartsheet sheet. Use the more specific triggers when one fits; this is for what they don't cover.", config: [] },
  user_seat_type_updated: { on: ["user.seatType.updated"], about: "Someone's seat type on the Smartsheet plan changed (guest, contributor, member). Needs a System Admin's token.", config: [] },
};
const PLAN_WIDE = new Set(["user_seat_type_updated"]);

export const triggers: Record<string, { description: string; config: ActionDetail["input"]; output: ActionDetail["input"] }> = Object.fromEntries(
  Object.entries(RULES).map(([name, r]) => [name, { description: r.about, config: PLAN_WIDE.has(name) ? [PLAN] : [SHEET, ...r.config, MINE], output: OUTPUT }]),
);
// trigger → what its webhook is on
export const events: Record<string, string> = Object.fromEntries(Object.keys(RULES).map((n) => [n, PLAN_WIDE.has(n) ? "plan" : "sheet"]));

export type EventData = {
  event: string;
  sheet_id: string;
  id?: string;
  row_id?: string;
  column_id?: string;
  column?: string;
  value?: unknown;
  row?: { id: string; row_number?: number; values: Record<string, unknown> };
  item?: unknown;
  user_id?: string;
  change_agent?: string;
  timestamp?: string;
};

const same = (a: unknown, b: unknown) => String(a ?? "").trim().toLowerCase() === String(b ?? "").trim().toLowerCase();
export const wanted = (config: unknown, data: unknown) => {
  const want = (config ?? {}) as { row_id?: string | number; column?: string | number; value?: string | number; include_emplio_changes?: boolean };
  const d = data as EventData;
  const ours = String(d.change_agent ?? "").split(",").map((a) => a.trim()).includes(AGENT);
  return (
    (want.include_emplio_changes === true || !ours) &&
    (want.row_id === undefined || want.row_id === "" || same(want.row_id, d.row_id ?? d.id)) &&
    (want.column === undefined || want.column === "" || same(want.column, d.column_id) || same(want.column, d.column)) &&
    (want.value === undefined || want.value === "" || same(want.value, d.value))
  );
};

const hookToken = (connection: string, scope: string) => createHmac("sha256", process.env.ENCRYPTION_KEY!).update(`smartsheet-webhook:${connection}:${scope}`).digest("hex");
const hookUrl = (connection: string, scope: string) => `${process.env.WEBHOOK_URL}/webhooks/app/smartsheet/${connection}/${scope}/${hookToken(connection, scope)}`;

const send = (method: string, path: string, fields: string[] = [], query: string[] = []): Send => ({
  method,
  path,
  query,
  headers: [],
  ...(fields.length && { body: { kind: "fields" as const, fields: fields.map((f): [string, string] => [f, f]) } }),
});
type Hook = { id: number; callbackUrl: string; enabled: boolean; status: string };
const findHook = async (key: string, url: string) =>
  ((await call(api, key, send("GET", "/webhooks", [], ["includeAll"]), { includeAll: true })) as { data?: Hook[] }).data?.find((h) => h.callbackUrl === url);

// the connected admin's plan, when an automation doesn't name one
async function planId(key: string, config: unknown) {
  const given = String((config as { plan_id?: unknown } | null)?.plan_id ?? "").trim();
  if (given) return given;
  const me = (await call(api, key, send("GET", "/users/me"), {})) as { id: number };
  const plans = (await call(api, key, send("GET", "/users/{id}/plans"), { id: me.id })) as { data?: { planId: number }[] };
  const plan = plans.data?.[0]?.planId;
  if (!plan) throw new AppsError("plan_id: Smartsheet didn't say which plan this account is on; give the plan's id");
  return String(plan);
}

// Make sure this sheet (or plan) has our webhook, switched on. Switching on makes Smartsheet send the challenge first.
export async function watch(key: string, connection: string, kind: string, config: unknown) {
  if (!process.env.WEBHOOK_URL) throw new AppsError("this server can't receive Smartsheet's events (WEBHOOK_URL isn't set)");
  let scope: string;
  let objectId: string;
  if (kind === "plan") {
    objectId = await planId(key, config);
    scope = `plan-${objectId}`;
  } else {
    objectId = String((config as { sheet_id?: unknown } | null)?.sheet_id ?? "").trim();
    if (!/^\d+$/.test(objectId)) throw new AppsError("sheet_id: give the Smartsheet sheet's id, a long number (list_sheets lists them)");
    scope = objectId;
  }
  if (!/^\d+$/.test(objectId)) throw new AppsError("plan_id: give the Smartsheet plan's id, a long number");
  const url = hookUrl(connection, scope);
  const id = `smartsheet:${connection}:${scope}`;
  const found = await findHook(key, url);
  if (found?.enabled && found.status === "ENABLED") return id;
  const hook =
    found?.id ??
    ((await call(api, key, send("POST", "/webhooks", ["name", "callbackUrl", "scope", "scopeObjectId", "events", "version"]), {
      name: "Emplio",
      callbackUrl: url,
      scope: kind === "plan" ? "plan" : "sheet",
      scopeObjectId: Number(objectId),
      events: ["*.*"],
      version: 1,
    })) as { result: Hook }).result.id;
  // Smartsheet switches a webhook off when deliveries keep failing or it loses access; this switches it back on
  const on = (await call(api, key, send("PUT", "/webhooks/{hook}", ["enabled"]), { hook, enabled: true })) as { result?: Hook };
  if (on.result && on.result.status !== "ENABLED") throw new AppsError(`Smartsheet couldn't switch the webhook on (${on.result.status})`);
  return id;
}

export async function unwatch(key: string, id: string) {
  const [, connection = "", scope = ""] = id.split(":");
  const found = await findHook(key, hookUrl(connection, scope));
  if (found) await call(api, key, send("DELETE", "/webhooks/{hook}"), { hook: found.id });
}

type Callback = { scope?: string; scopeObjectId?: number; webhookId?: number; newWebhookStatus?: string | null; challenge?: string; events?: SmartEvent[] };
type SmartEvent = { objectType: string; eventType: string; id?: number; rowId?: number; columnId?: number; userId?: number; changeAgent?: string; timestamp?: string; [k: string]: unknown };
type Row = { id: number; rowNumber?: number; cells?: { columnId: number; value?: unknown; displayValue?: string }[]; columns?: { id: number; title: string }[] };

const header = (h: Delivery["headers"], name: string) => [h[name]].flat()[0];
const triggersFor = (e: SmartEvent, scope: string) =>
  Object.entries(RULES)
    .filter(([name, r]) => (r.on.length ? r.on.includes(`${e.objectType}.${e.eventType}`) : !scope.startsWith("plan-")) && PLAN_WIDE.has(name) === scope.startsWith("plan-"))
    .map(([n]) => n);

export async function receive(delivery: Delivery, key: string) {
  const [scope = "", token = ""] = delivery.rest.split("/");
  const want = Buffer.from(hookToken(delivery.connection, scope));
  const got = Buffer.from(token);
  if (!scope || got.length !== want.length || !timingSafeEqual(got, want)) return null;
  const body = JSON.parse(delivery.body || "{}") as Callback;
  // the handshake, when a webhook is switched on (and now and then after): echo the challenge back
  const challenge = header(delivery.headers, "smartsheet-hook-challenge") ?? body.challenge;
  if (challenge) return { headers: { "Smartsheet-Hook-Response": String(challenge) }, reply: { smartsheetHookResponse: String(challenge) }, events: async () => [] };
  return { events: () => eventsOf(body, key, delivery.connection, scope) };
}

// a row's values by column name
const values = (row: Row) => {
  const names = new Map((row.columns ?? []).map((c) => [c.id, c.title]));
  return Object.fromEntries((row.cells ?? []).filter((c) => c.value !== undefined).map((c) => [names.get(c.columnId) ?? String(c.columnId), c.displayValue ?? c.value]));
};

async function eventsOf(body: Callback, key: string, connection: string, scope: string): Promise<WebhookEvent[]> {
  // a status change (the webhook was switched off) carries no events
  if (!Array.isArray(body.events)) return [];
  const sheet = String(body.scopeObjectId ?? scope);
  const plan = scope.startsWith("plan-");
  // one read per row per callback, however many of its cells changed; anything gone by now is left as ids
  const rows = new Map<number, Promise<Row | null>>();
  const row = (rowId: number) => {
    if (!rows.has(rowId)) rows.set(rowId, call(api, key, send("GET", "/sheets/{sheet}/rows/{rowId}", [], ["include"]), { sheet, rowId, include: "columns" }).then((r) => r as Row, () => null));
    return rows.get(rowId)!;
  };
  const read = (path: string, input: Record<string, unknown>) => call(api, key, send("GET", path), { sheet, ...input }).catch(() => undefined);
  const ITEM: Record<string, string> = { comment: "/sheets/{sheet}/comments/{id}", discussion: "/sheets/{sheet}/discussions/{id}", attachment: "/sheets/{sheet}/attachments/{id}", column: "/sheets/{sheet}/columns/{id}" };
  return Promise.all(
    body.events.map(async (e): Promise<WebhookEvent> => {
      const { objectType, eventType, id, rowId, columnId, userId, changeAgent, timestamp, ...rest } = e;
      const data: EventData = { event: `${objectType}.${eventType}`, sheet_id: sheet, ...(id != null && { id: String(id) }), ...(userId != null && { user_id: String(userId) }), ...(changeAgent && { change_agent: changeAgent }), ...(timestamp && { timestamp }) };
      if (plan) Object.assign(data, rest);
      const r = objectType === "row" ? id : objectType === "cell" ? rowId : undefined;
      if (r != null) data.row_id = String(r);
      if (r != null && eventType !== "deleted" || objectType === "cell") {
        const now = r != null ? await row(r) : null;
        if (now) data.row = { id: String(now.id), row_number: now.rowNumber, values: values(now) };
        if (objectType === "cell") {
          data.column_id = String(columnId ?? "");
          const col = now?.columns?.find((c) => c.id === columnId);
          if (col) data.column = col.title;
          const cell = now?.cells?.find((c) => c.columnId === columnId);
          if (cell) data.value = cell.displayValue ?? cell.value;
        }
      }
      if (ITEM[objectType] && eventType !== "deleted" && id != null) {
        const item = await read(ITEM[objectType]!, { id });
        if (item !== undefined) data.item = item;
      }
      // the connection and scope because `seen` is shared; a retry has the same event, time and all
      return { id: [`smartsheet:${connection}:${scope}`, data.event, id ?? `${rowId}:${columnId}`, userId, timestamp].join(":"), triggers: triggersFor(e, scope), data };
    }),
  );
}
