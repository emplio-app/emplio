// monday.com telling us about board events the moment they happen. A monday webhook is one board and one event, so ours
// is one per connection, board and event, at /webhooks/app/monday/<connection>/<board>/<event>/<token>. Trigger names
// are Composio's where it has the trigger.
import { createHmac, timingSafeEqual } from "node:crypto";
import type { ActionDetail } from "@emplio/shared";
import { AppsError } from "../../types";
import type { Delivery, WebhookEvent } from "../index";

// one GraphQL call on the connection's token (index.ts's graphql)
type Gql = (key: string, query: string, variables?: Record<string, unknown>) => Promise<Record<string, unknown>>;

const BOARD = { name: "board_id", type: "string", required: true, description: "The monday.com board to watch: the long number in its link (the boards action lists them). For subitems, the main board's." };
const GROUP = { name: "group_id", type: "string", required: false, description: "Only items in this group (its id, like topics; the board's groups list them)" };
const COLUMN = { name: "column_id", type: "string", required: false, description: "Only when this column changes (its id, like status or date4; the board's columns list them)" };
const OUTPUT: ActionDetail["input"] = [
  { name: "type", type: "string", required: true, description: "What happened, in monday's words: create_pulse, update_column_value, create_update…" },
  { name: "boardId", type: "number", required: true, description: "The board" },
  { name: "pulseId", type: "number", required: false, description: "The item (or subitem)" },
  { name: "pulseName", type: "string", required: false, description: "Its name" },
  { name: "parentItemId", type: "string", required: false, description: "On subitem events: the item it's under" },
  { name: "groupId", type: "string", required: false, description: "The item's group; destGroupId and sourceGroupId on a move" },
  { name: "columnId", type: "string", required: false, description: "On column changes: the column, with columnTitle and columnType" },
  { name: "value", type: "object", required: false, description: "On column changes: the new value, and previousValue the old one" },
  { name: "columnValues", type: "object", required: false, description: "On new items: the values they were made with" },
  { name: "updateId", type: "number", required: false, description: "On update (comment) events: the update; replyId when it's a reply" },
  { name: "textBody", type: "string", required: false, description: "On update events: what was written, as text (body is the HTML)" },
  { name: "userId", type: "number", required: false, description: "Who did it (a monday user id)" },
  { name: "triggerTime", type: "string", required: true, description: "When it happened" },
];

const trigger = (event: string, description: string, ...config: ActionDetail["input"]) => ({ event, description, config: [BOARD, ...config], output: OUTPUT });
const ALL = {
  item_created: trigger("create_item", "An item was added to the monday.com board.", GROUP),
  item_column_value_updated: trigger(
    "change_column_value",
    "A column of an item on the monday.com board changed: a status, a date, a person, any column. A run that changes the item starts this again, so say in the prompt when to stop.",
    COLUMN,
    GROUP,
  ),
  item_name_updated: trigger("change_name", "An item on the monday.com board was renamed."),
  item_moved_to_group: trigger("item_moved_to_any_group", "An item on the monday.com board moved to another group.", { ...GROUP, description: "Only moves into this group (its id)" }),
  item_archived: trigger("item_archived", "An item on the monday.com board was archived."),
  item_deleted: trigger("item_deleted", "An item on the monday.com board was deleted."),
  item_restored: trigger("item_restored", "An archived or deleted item came back to the monday.com board."),
  item_update_posted: trigger("create_update", "Someone posted an update (a comment) on an item on the monday.com board. A run that posts on the same item starts this again, so say in the prompt when not to reply."),
  item_update_reply_posted: trigger("create_update", "Someone replied to an update on an item on the monday.com board. A run that replies starts this again, so say in the prompt when not to."),
  item_update_edited: trigger("edit_update", "An update on an item on the monday.com board was edited."),
  item_update_deleted: trigger("delete_update", "An update on an item on the monday.com board was deleted."),
  column_created: trigger("create_column", "A column was added to the monday.com board."),
  subitem_created: trigger("create_subitem", "A subitem was added under an item on the monday.com board."),
  subitem_column_value_updated: trigger("change_subitem_column_value", "A column of a subitem on the monday.com board changed. A run that changes the subitem starts this again.", COLUMN),
  subitem_name_updated: trigger("change_subitem_name", "A subitem on the monday.com board was renamed."),
  subitem_moved: trigger("move_subitem", "A subitem on the monday.com board moved under another item."),
  subitem_archived: trigger("subitem_archived", "A subitem on the monday.com board was archived."),
  subitem_deleted: trigger("subitem_deleted", "A subitem on the monday.com board was deleted."),
  subitem_update_posted: trigger("create_subitem_update", "Someone posted an update (a comment) on a subitem on the monday.com board."),
};
export const triggers: Record<string, { description: string; config: ActionDetail["input"]; output: ActionDetail["input"] }> = Object.fromEntries(
  Object.entries(ALL).map(([name, { event: _, ...t }]) => [name, t]),
);
export const events: Record<string, string> = Object.fromEntries(Object.entries(ALL).map(([name, t]) => [name, t.event]));

export type EventData = { type?: string; boardId?: number; pulseId?: number; groupId?: string; destGroupId?: string; columnId?: string; updateId?: number; replyId?: number | null; triggerTime?: string; changedAt?: number };

// the triggers one monday event starts; an update and a reply to one both come as create_update
const triggersFor = (event: string, e: EventData) =>
  Object.keys(ALL).filter((t) => events[t] === event && (event !== "create_update" || (t === "item_update_reply_posted") === Boolean(e.replyId)));

export const wanted = (config: unknown, data: unknown) => {
  const want = (config ?? {}) as { column_id?: string; group_id?: string };
  const d = data as EventData;
  return (!want.column_id || d.columnId === want.column_id) && (!want.group_id || (d.destGroupId ?? d.groupId) === want.group_id);
};

// ponytail: webhooks made with a personal token aren't signed, so an unguessable URL proves the sender. Ceiling: a leaked URL can forge events
const hookToken = (connection: string, board: string, event: string) => createHmac("sha256", process.env.ENCRYPTION_KEY!).update(`monday-webhook:${connection}:${board}:${event}`).digest("hex").slice(0, 40);
const hookUrl = (connection: string, board: string, event: string) => `${process.env.WEBHOOK_URL}/webhooks/app/monday/${connection}/${board}/${event}/${hookToken(connection, board, event)}`;

type Hook = { id: string; event: string; config: string | null };
// ours: on this board, for this event, with no settings. monday doesn't say a webhook's URL, so that's as close as we can tell.
// ponytail: a webhook someone made by hand with a personal token for the same board and event looks the same: we'd send
// nothing new while it's there and remove it with ours. monday adding the URL to its webhooks query would end this
const ours = async (graphql: Gql, key: string, board: string, event: string) => {
  const { webhooks } = (await graphql(key, "query($board: ID!) { webhooks(board_id: $board) { id event config } }", { board })) as { webhooks: Hook[] | null };
  return (webhooks ?? []).filter((h) => h.event === event && (!h.config || h.config === "{}"));
};

// Make sure this board sends us this event. monday checks the URL (the challenge in receive) before this answers.
export async function watch(graphql: Gql, key: string, connection: string, event: string, config: unknown) {
  if (!process.env.WEBHOOK_URL) throw new AppsError("this server can't receive monday.com's events (WEBHOOK_URL isn't set)");
  const board = String((config as { board_id?: unknown } | null)?.board_id ?? "");
  if (!/^\d+$/.test(board)) throw new AppsError("board_id: give the monday.com board's id, the long number in its link");
  const url = hookUrl(connection, board, event);
  if (url.length > 255) throw new AppsError("this server's webhook address is too long for monday.com (it takes 255 characters)");
  const id = `monday:${connection}:${board}:${event}`;
  // already sending it here: another automation on the same board and event
  if ((await ours(graphql, key, board, event)).length) return id;
  await graphql(key, "mutation($board: ID!, $url: String!, $event: WebhookEventType!) { create_webhook(board_id: $board, url: $url, event: $event) { id } }", { board, url, event });
  return id;
}

export async function unwatch(graphql: Gql, key: string, id: string) {
  const [, , board = "", event = ""] = id.split(":");
  for (const h of await ours(graphql, key, board, event)) await graphql(key, "mutation($id: ID!) { delete_webhook(id: $id) { id } }", { id: h.id });
}

export async function receive(delivery: Delivery): Promise<{ reply?: unknown; events(): Promise<WebhookEvent[]> } | null> {
  const [board = "", event = "", token = ""] = delivery.rest.split("/");
  const want = Buffer.from(hookToken(delivery.connection, board, event));
  const got = Buffer.from(token);
  if (got.length !== want.length || !timingSafeEqual(got, want)) return null;
  const body = JSON.parse(delivery.body || "{}") as { challenge?: string; event?: EventData & Record<string, unknown> };
  if (body.challenge !== undefined) return { reply: { challenge: body.challenge }, events: async () => [] };
  const e = body.event;
  if (!e) return { events: async () => [] };
  // link clutter and monday's own bookkeeping, which mean nothing to an automation
  const { app: _a, subscriptionId: _s, triggerUuid: _t, originalTriggerUuid: _o, ...data } = e;
  // ponytail: monday's triggerUuid isn't documented as one per event, so the id is what happened and when
  const id = [delivery.connection, board, event, e.pulseId, e.updateId, e.replyId, e.columnId, e.triggerTime, e.changedAt].join(":");
  return { events: async () => [{ id, triggers: triggersFor(event, e), data, watch: `monday:${delivery.connection}:${board}:${event}` }] };
}
