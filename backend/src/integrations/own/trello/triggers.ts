// Trello telling us about what happens on a board or in a workspace, the moment it happens. Webhooks are per model:
// one per board (or workspace) and connection, at /webhooks/app/trello/<connection>/<model>/<token>, and every action on
// it comes down that one. Trigger names are Composio's; a few more and a catch-all cover the rest of Trello's actions.
import { createHmac, timingSafeEqual } from "node:crypto";
import type { ActionDetail } from "@emplio/shared";
import { AppsError } from "../../types";
import type { Delivery, WebhookEvent } from "../index";
import { type Api, call, type Send } from "../openapi";

type Kind = "board" | "workspace";
type Action = { id: string; type: string; date: string; data?: Record<string, any>; memberCreator?: { id: string; fullName?: string; username?: string }; display?: { translationKey?: string } };

const BOARD = { name: "board_id", type: "string", required: true, description: "The Trello board to watch: its link (trello.com/b/...) or id (get_members_boards_by_id_member with id \"me\" lists them)" };
const WORKSPACE = { name: "workspace_id", type: "string", required: true, description: "The Trello workspace to watch: its id or short name, as in its link (get_members_organizations_by_id_member with id \"me\" lists them)" };
const LIST = { name: "list_id", type: "string", required: false, description: "Only cards in this list (for a move: the list it went to). Its id; get_boards_lists_by_id_board lists them" };
const CARD = { name: "card_id", type: "string", required: false, description: "Only this card (its id)" };
const OUTPUT: ActionDetail["input"] = [
  { name: "type", type: "string", required: true, description: "Trello's name for what happened, like createCard, updateCard or commentCard" },
  { name: "date", type: "string", required: true, description: "When it happened" },
  { name: "member_creator", type: "object", required: false, description: "Who did it: id, fullName, username" },
  { name: "data", type: "object", required: true, description: "What it's about: card, list, board, checklist, checkItem, label, member, text (a comment), and old (the values before a change), as Trello sends them" },
  { name: "translation_key", type: "string", required: false, description: "Trello's finer kind, like action_move_card_from_list_to_list or action_archived_card" },
];

// trigger → the Trello action types that start it, and where it's watched
const T: Record<string, { types: string[]; on: Kind; about: string; card?: boolean; when?: (a: Action) => boolean }> = {
  card_created: { types: ["createCard", "emailCard"], on: "board", card: true, about: "A card was added to the Trello board (made there, or sent in by email)." },
  card_updated: { types: ["updateCard"], on: "board", card: true, about: "A card on the Trello board changed: its name, description, due date, list, position, cover or archived state. data.old has the values before. A run that edits the card starts this again, so say in the prompt when to stop." },
  card_moved_between_lists: { types: ["updateCard"], on: "board", card: true, when: (a) => Boolean(a.data?.listAfter), about: "A card on the Trello board went to another list (like To do → Done). data.listBefore and data.listAfter say from where to where." },
  card_moved_in_from_another_board: { types: ["moveCardToBoard"], on: "board", card: true, about: "A card was moved onto the Trello board from another board." },
  card_moved_out_to_another_board: { types: ["moveCardFromBoard"], on: "board", card: true, about: "A card was moved off the Trello board to another board." },
  card_copied: { types: ["copyCard"], on: "board", card: true, about: "A card on the Trello board was made as a copy of another." },
  card_created_from_checklist_item: { types: ["convertToCardFromCheckItem"], on: "board", card: true, about: "A checklist item on the Trello board was turned into its own card." },
  card_deleted: { types: ["deleteCard"], on: "board", card: true, about: "A card on the Trello board was deleted for good (archiving is card_updated)." },
  card_vote_changed: { types: ["voteOnCard"], on: "board", card: true, about: "Someone voted on a card on the Trello board, or took their vote back." },
  card_custom_field_changed: { types: ["updateCustomFieldItem"], on: "board", card: true, about: "A custom field's value changed on a card on the Trello board." },
  comment_added_to_card: { types: ["commentCard"], on: "board", card: true, about: "Someone commented on a card on the Trello board; data.text is the comment. A run that comments on the same card starts this again, so say in the prompt when not to reply." },
  comment_copied_to_card: { types: ["copyCommentCard"], on: "board", card: true, about: "A comment was copied onto a card on the Trello board." },
  comment_edited_on_card: { types: ["updateComment"], on: "board", card: true, about: "A comment on a card on the Trello board was edited." },
  comment_deleted_from_card: { types: ["deleteComment"], on: "board", card: true, about: "A comment on a card on the Trello board was deleted." },
  attachment_added_to_card: { types: ["addAttachmentToCard"], on: "board", card: true, about: "A file or link was attached to a card on the Trello board." },
  attachment_removed_from_card: { types: ["deleteAttachmentFromCard"], on: "board", card: true, about: "An attachment was removed from a card on the Trello board." },
  checklist_added_to_card: { types: ["addChecklistToCard"], on: "board", card: true, about: "A checklist was added to a card on the Trello board." },
  checklist_removed_from_card: { types: ["removeChecklistFromCard"], on: "board", card: true, about: "A checklist was removed from a card on the Trello board." },
  checklist_updated: { types: ["updateChecklist"], on: "board", card: true, about: "A checklist on the Trello board was renamed or moved." },
  checklist_item_added: { types: ["createCheckItem"], on: "board", card: true, about: "An item was added to a checklist on the Trello board." },
  checklist_item_updated: { types: ["updateCheckItem"], on: "board", card: true, about: "A checklist item on the Trello board was renamed, moved, given a due date or someone." },
  checklist_item_state_changed: { types: ["updateCheckItemStateOnCard"], on: "board", card: true, about: "A checklist item on the Trello board was ticked or unticked; data.checkItem.state says which." },
  checklist_item_deleted: { types: ["deleteCheckItem"], on: "board", card: true, about: "A checklist item on the Trello board was deleted." },
  label_added_to_card: { types: ["addLabelToCard"], on: "board", card: true, about: "A label was put on a card on the Trello board." },
  label_removed_from_card: { types: ["removeLabelFromCard"], on: "board", card: true, about: "A label was taken off a card on the Trello board." },
  member_assigned_to_card: { types: ["addMemberToCard"], on: "board", card: true, about: "Someone was added to a card on the Trello board." },
  member_unassigned_from_card: { types: ["removeMemberFromCard"], on: "board", card: true, about: "Someone was taken off a card on the Trello board." },
  list_created: { types: ["createList"], on: "board", about: "A list was added to the Trello board." },
  list_updated: { types: ["updateList"], on: "board", about: "A list on the Trello board was renamed, moved, archived or brought back. data.old has the values before." },
  list_moved_in_from_another_board: { types: ["moveListToBoard"], on: "board", about: "A list was moved onto the Trello board from another board." },
  list_moved_out_to_another_board: { types: ["moveListFromBoard"], on: "board", about: "A list was moved off the Trello board to another board." },
  board_updated: { types: ["updateBoard"], on: "board", about: "The Trello board's name, description, background, settings or archived state changed." },
  board_label_created: { types: ["createLabel"], on: "board", about: "A label was made on the Trello board." },
  board_label_updated: { types: ["updateLabel"], on: "board", about: "A label on the Trello board was renamed or recoloured." },
  board_label_deleted: { types: ["deleteLabel"], on: "board", about: "A label on the Trello board was deleted." },
  board_custom_field_changed: { types: ["createCustomField", "updateCustomField", "deleteCustomField"], on: "board", about: "A custom field on the Trello board was made, changed or deleted (not a card's value: that's card_custom_field_changed)." },
  board_power_up_changed: { types: ["enablePlugin", "disablePlugin", "enablePowerUp", "disablePowerUp"], on: "board", about: "A Power-Up was turned on or off on the Trello board." },
  member_added_to_board: { types: ["addMemberToBoard"], on: "board", about: "Someone joined the Trello board." },
  member_invited_to_board: { types: ["unconfirmedBoardInvitation", "createBoardInvitation"], on: "board", about: "Someone was invited to the Trello board and hasn't joined yet." },
  member_removed_from_board: { types: ["removeMemberFromBoard"], on: "board", about: "Someone was taken off the Trello board." },
  board_member_role_changed: { types: ["makeAdminOfBoard", "makeNormalMemberOfBoard", "makeObserverOfBoard"], on: "board", about: "Someone on the Trello board became an admin, a normal member or an observer." },
  board_activity: { types: [], on: "board", about: "Anything at all happened on the Trello board. Use the more specific triggers when one fits; this is for what they don't cover." },
  board_added_to_workspace: { types: ["addToOrganizationBoard"], on: "workspace", about: "A board was moved into the Trello workspace." },
  board_removed_from_workspace: { types: ["removeFromOrganizationBoard"], on: "workspace", about: "A board was taken out of the Trello workspace." },
  board_created_in_workspace: { types: ["createBoard", "copyBoard"], on: "workspace", about: "A new board was made in the Trello workspace (from scratch or as a copy)." },
  member_added_to_workspace: { types: ["addMemberToOrganization", "makeNormalMemberOfOrganization", "makeAdminOfOrganization"], on: "workspace", about: "Someone joined the Trello workspace or had their role there changed." },
  member_invited_to_workspace: { types: ["unconfirmedOrganizationInvitation", "createOrganizationInvitation"], on: "workspace", about: "Someone was invited to the Trello workspace and hasn't joined yet." },
  member_removed_from_workspace: { types: ["removeMemberFromOrganization"], on: "workspace", about: "Someone left or was taken out of the Trello workspace." },
  workspace_updated: { types: ["updateOrganization"], on: "workspace", about: "The Trello workspace's name, description, website or settings changed." },
};

export const triggers: Record<string, { description: string; config: ActionDetail["input"]; output: ActionDetail["input"] }> = Object.fromEntries(
  Object.entries(T).map(([name, t]) => [
    name,
    {
      description: t.about,
      config:
        t.on === "workspace"
          ? [WORKSPACE]
          : name === "board_activity"
            ? [BOARD, LIST, CARD, { name: "action_type", type: "string", required: false, description: "Only this kind of Trello action, like createCard, commentCard or updateCard" }]
            : t.card ? [BOARD, LIST, CARD] : [BOARD],
      output: OUTPUT,
    },
  ]),
);
// trigger → what kind of thing its webhook is on
export const events: Record<string, string> = Object.fromEntries(Object.entries(T).map(([name, t]) => [name, t.on]));

const triggersFor = (a: Action) => Object.entries(T).filter(([, t]) => (t.types.length ? t.types.includes(a.type) : true) && (!t.when || t.when(a))).map(([n]) => n);

type EventData = { type: string; data?: Record<string, any> };
export const wanted = (config: unknown, data: unknown) => {
  const want = (config ?? {}) as { list_id?: string; card_id?: string; action_type?: string };
  const d = (data as EventData).data ?? {};
  const list = d.listAfter?.id ?? d.list?.id;
  return (!want.list_id || list === want.list_id) && (!want.card_id || d.card?.id === want.card_id) && (!want.action_type || (data as EventData).type === want.action_type);
};

// ponytail: Trello signs with the Power-Up's secret, which a key and token don't give us, so an unguessable URL proves the sender. Ceiling: a leaked URL can forge events; check X-Trello-Webhook if people ever sign in with OAuth
const hookToken = (connection: string, model: string) => createHmac("sha256", process.env.ENCRYPTION_KEY!).update(`trello-webhook:${connection}:${model}`).digest("hex");
const hookUrl = (connection: string, model: string) => `${process.env.WEBHOOK_URL}/webhooks/app/trello/${connection}/${model}/${hookToken(connection, model)}`;

const send = (method: string, path: string, query: string[] = []): Send => ({ method, path, query, headers: [] });
type Hook = { id: string; idModel: string; callbackURL: string; active: boolean };
const findHook = async (api: Api, key: string, token: string, url: string) =>
  ((await call(api, key, send("GET", "/tokens/{token}/webhooks"), { token })) as Hook[]).find((h) => h.callbackURL === url);

// a board link, short link or id, or a workspace's id or name → its id, which also proves the login can see it
async function modelId(api: Api, key: string, kind: Kind, config: unknown) {
  const field = kind === "board" ? "board_id" : "workspace_id";
  const given = String((config as Record<string, unknown> | null)?.[field] ?? "").trim();
  const id = (/trello\.com\/[bw]\/([^/?#]+)/.exec(given)?.[1] ?? given).trim();
  if (!/^[\w-]+$/.test(id)) throw new AppsError(`${field}: give the Trello ${kind}'s link or id`);
  const got = (await call(api, key, send("GET", kind === "board" ? "/boards/{id}" : "/organizations/{id}", ["fields"]), { id, fields: "id" })) as { id: string };
  return got.id;
}

// Make sure this board (or workspace) has our webhook. Trello checks the URL with a HEAD before it answers.
export async function watch(api: Api, key: string, token: string, connection: string, kind: string, config: unknown) {
  if (!process.env.WEBHOOK_URL) throw new AppsError("this server can't receive Trello's events (WEBHOOK_URL isn't set)");
  const model = await modelId(api, key, kind as Kind, config);
  const url = hookUrl(connection, model);
  const id = `trello:${connection}:${model}`;
  const found = await findHook(api, key, token, url);
  // Trello switches a webhook off after deliveries keep failing; switch it back on
  if (found && !found.active) await call(api, key, send("PUT", "/webhooks/{id}", ["active"]), { id: found.id, active: true });
  if (!found) await call(api, key, send("POST", "/webhooks/", ["callbackURL", "idModel", "description"]), { callbackURL: url, idModel: model, description: "Emplio automations" });
  return id;
}

export async function unwatch(api: Api, key: string, token: string, id: string) {
  const [, connection = "", model = ""] = id.split(":");
  const found = await findHook(api, key, token, hookUrl(connection, model));
  if (found) await call(api, key, send("DELETE", "/webhooks/{id}"), { id: found.id });
}

export async function receive(delivery: Delivery) {
  const [model = "", token = ""] = delivery.rest.split("/");
  const want = Buffer.from(hookToken(delivery.connection, model));
  const got = Buffer.from(token);
  if (got.length !== want.length || !timingSafeEqual(got, want)) return null;
  const action = (JSON.parse(delivery.body || "{}") as { action?: Action }).action;
  return {
    events: async (): Promise<WebhookEvent[]> => {
      if (!action?.id) return [];
      const names = triggersFor(action);
      const data = { type: action.type, date: action.date, member_creator: action.memberCreator, data: action.data, translation_key: action.display?.translationKey };
      // the connection and model because `seen` is shared
      return [{ id: `trello:${delivery.connection}:${model}:${action.id}`, triggers: names, data }];
    },
  };
}
