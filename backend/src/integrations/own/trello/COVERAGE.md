# Trello coverage

Source: Atlassian's OpenAPI spec for Trello (developer.atlassian.com/cloud/trello/swagger.v3.json), generated 2026-11-22
by `bun scripts/openapi-actions.ts trello`. Every operation is an action (259), plus 7 by hand (below). Composio slug: `trello`.

## Deliberately left out

| What | Why |
| --- | --- |
| POST /boards/{id}/boardPlugins, DELETE /boards/{id}/boardPlugins/{idPlugin} | Marked deprecated by Trello; Power-Ups are switched with call_api if ever needed |

Composio's names are its old path-based ones (`get_boards_cards_by_id_board`); `name` in scripts/openapi/trello.ts
rebuilds that name from each path and keeps it wherever Composio has it (Composio cuts long names at 53 characters, and so do
we). The rest are named after the spec's summary. Coverage still lists 169 Composio names as unmatched:

- **The same call under another name** (most of them): e.g. `add_card_vote` = add_member_vote_to_card,
  `set_card_custom_field_value` = update_custom_field_item_on_card, `create_custom_field` = create_new_custom_field_on_board.
- **Single-field updates** Trello's spec no longer lists (`update_boards_name_by_id_board`, `update_cards_due_by_id_card`,
  `update_boards_label_names_green_by_id_board`, member and saved-search fields...): the main update of each object takes
  the same fields (update_boards_by_id_board, update_cards_by_id_card...). `update_cards_id_list_by_id_card` is kept by hand
  because moving a card is the most common job.
- **Older read routes** Trello still answers but no longer documents (deltas, display, entities, membersInvited,
  `.../{field}` on nested objects, `get_types_by_id`), and the Power-Up switches: reached with `call_api_get` / `call_api`.
- **Sessions** (`create_session`, `get_sessions_socket`, `update_sessions_*`): Trello's old live-update sockets, gone from the API.

No capability Composio has is missing. Triggers: 0 unmatched.

## By hand (own/trello/index.ts, scripts/openapi/trello.ts)

- `get_members_me`, `who_am_i`, `get_members_me_boards`, `update_cards_id_list_by_id_card`*: Composio's names for common calls.
- `call_api_get` (reads, runs unasked) and `call_api`* (POST/PUT/DELETE): any route under api.trello.com/1; paths are
  checked so they can't leave Trello's API.
- `download_card_attachment`: an uploaded file on a card comes back as a file (Trello's download needs the auth header);
  a link attachment comes back as its address.
- Uploads (`file` on attachments, avatars, logos, stickers, emoji, backgrounds; `fileSource` on add_cards): the spec lists
  them as query params; `after` sends them as multipart instead.
- `/tokens/{token}/...` and `/applications/{key}/...`: the token and key are filled in from the connection and taken out of
  the input, so no agent sees or types them.
- The spec's `/enterprises/${id}/enterpriseJoinRequest/bulk` typo is fixed, and `idOrganizations` is a list of ids (the spec
  describes whole organizations).
- Most POST/PUT parameters go in the query string, as the spec says; Trello reads them there. Defaults in the spec
  (keepFromSource=all, setCover=false) are sent as given.

## Auth

| Method | Status |
| --- | --- |
| API key + token, pasted as `KEY:TOKEN`, sent as `Authorization: OAuth oauth_consumer_key="KEY", oauth_token="TOKEN"` | done |
| OAuth (Atlassian 3LO / OAuth 1.0a) | not in this job |

Help text walks through trello.com/power-ups/admin → New → API key → Token. `check` calls GET /members/me and labels the
connection with the person's name. A pasted value without a colon is refused before calling Trello.

## Triggers

Webhook per board (or workspace) and connection: POST /webhooks with `idModel` and callback
`/webhooks/app/trello/<connection>/<model>/<token>`. Found again by its callback URL in GET /tokens/{token}/webhooks; one
Trello switched off is switched back on; removed with the last automation. Trello checks the callback with a HEAD, which the
shared route's GET answers (Fastify serves HEAD for GET routes).

Trello signs each delivery in `X-Trello-Webhook` with base64 HMAC-SHA1 of body + callback URL, keyed with the Power-Up's
**OAuth secret**. A key and token don't give us that secret, so the signature isn't checked: the URL holds an unguessable
token instead (HMAC of ENCRYPTION_KEY, connection and model), compared timing-safe; a wrong one gets 401. Delivery id: the
Trello action's id. `board_id` takes a board link, short link or id; `workspace_id` an id or short name; both are resolved
to Trello's id (which also proves the login can see it). Payload is trimmed to type, date, member_creator, data,
translation_key.

Filters on card triggers: `list_id` (for a move, the list it went to), `card_id`; `board_activity` also `action_type`.
`updateCard` with a list change starts both card_moved_between_lists and card_updated.

| Trigger | Watches | Trello action types |
| --- | --- | --- |
| card_created | board | createCard, emailCard |
| card_updated | board | updateCard |
| card_moved_between_lists | board | updateCard |
| card_moved_in_from_another_board | board | moveCardToBoard |
| card_moved_out_to_another_board | board | moveCardFromBoard |
| card_copied | board | copyCard |
| card_created_from_checklist_item | board | convertToCardFromCheckItem |
| card_deleted | board | deleteCard |
| card_vote_changed | board | voteOnCard |
| card_custom_field_changed | board | updateCustomFieldItem |
| comment_added_to_card | board | commentCard |
| comment_copied_to_card | board | copyCommentCard |
| comment_edited_on_card | board | updateComment |
| comment_deleted_from_card | board | deleteComment |
| attachment_added_to_card | board | addAttachmentToCard |
| attachment_removed_from_card | board | deleteAttachmentFromCard |
| checklist_added_to_card | board | addChecklistToCard |
| checklist_removed_from_card | board | removeChecklistFromCard |
| checklist_updated | board | updateChecklist |
| checklist_item_added | board | createCheckItem |
| checklist_item_updated | board | updateCheckItem |
| checklist_item_state_changed | board | updateCheckItemStateOnCard |
| checklist_item_deleted | board | deleteCheckItem |
| label_added_to_card | board | addLabelToCard |
| label_removed_from_card | board | removeLabelFromCard |
| member_assigned_to_card | board | addMemberToCard |
| member_unassigned_from_card | board | removeMemberFromCard |
| list_created | board | createList |
| list_updated | board | updateList |
| list_moved_in_from_another_board | board | moveListToBoard |
| list_moved_out_to_another_board | board | moveListFromBoard |
| board_updated | board | updateBoard |
| board_label_created | board | createLabel |
| board_label_updated | board | updateLabel |
| board_label_deleted | board | deleteLabel |
| board_custom_field_changed | board | createCustomField, updateCustomField, deleteCustomField |
| board_power_up_changed | board | enablePlugin, disablePlugin, enablePowerUp, disablePowerUp |
| member_added_to_board | board | addMemberToBoard |
| member_invited_to_board | board | unconfirmedBoardInvitation, createBoardInvitation |
| member_removed_from_board | board | removeMemberFromBoard |
| board_member_role_changed | board | makeAdminOfBoard, makeNormalMemberOfBoard, makeObserverOfBoard |
| board_activity | board | any action |
| board_added_to_workspace | workspace | addToOrganizationBoard |
| board_removed_from_workspace | workspace | removeFromOrganizationBoard |
| board_created_in_workspace | workspace | createBoard, copyBoard |
| member_added_to_workspace | workspace | addMemberToOrganization, makeNormalMemberOfOrganization, makeAdminOfOrganization |
| member_invited_to_workspace | workspace | unconfirmedOrganizationInvitation, createOrganizationInvitation |
| member_removed_from_workspace | workspace | removeMemberFromOrganization |
| workspace_updated | workspace | updateOrganization |

Nothing is polled (polls/trello.ts is empty): every event comes by webhook.

Not tried live. No real account, key or token was used.

## Actions by path (* asks first)

**/actions** (16): get_actions_by_id_action, update_actions_by_id_action*, delete_action*, get_actions_by_id_action_by_field, get_actions_board_by_id_action, get_actions_card_by_id_action, get_actions_list_by_id_action, get_actions_member_by_id_action, get_actions_member_creator_by_id_action, get_actions_organization_by_id_action, update_actions_text_by_id_action*, get_actions_reactions_by_id_action, create_action_reaction*, get_action_s_reaction, delete_action_s_reaction*, list_action_s_summary_of_reactions

**/applications** (1): get_application_s_compliance_data

**/batch** (1): get_batch

**/boards** (39): get_boards_memberships_by_id_board, get_boards_by_id_board, update_boards_by_id_board*, delete_board*, get_boards_by_id_board_by_field, get_actions_of_board, get_board_stars_on_board, get_boards_checklists_by_id_board, get_boards_cards_by_id_board, get_boards_cards_by_id_board_by_filter, get_custom_fields_for_board, get_boards_labels_by_id_board, create_board_label*, get_boards_lists_by_id_board, add_boards_lists_by_id_board*, get_boards_lists_by_id_board_by_filter, get_boards_members_by_id_board, update_boards_members_by_id_board*, update_boards_members_by_id_board_by_id_member*, remove_board_member*, update_membership_of_member_on_board*, update_boards_my_prefs_email_position_by_id_board*, update_boards_my_prefs_id_email_list_by_id_board*, update_boards_my_prefs_show_sidebar_by_id_board*, update_show_sidebar_activity_pref_on_board*, update_show_sidebar_board_actions_pref_on_board*, update_show_sidebar_members_pref_on_board*, add_boards*, create_calendar_key_for_board*, create_email_key_for_board*, create_tag_for_board*, mark_board_as_viewed*, get_enabled_power_ups_on_board, get_boards_plugins_by_id_board, create_export_for_board*, get_export_for_board, delete_export_for_board*, download_export_for_board, get_board_s_most_recent_export

**/cards** (42): add_cards*, get_cards_by_id_card, update_cards_by_id_card*, delete_cards_by_id_card*, get_cards_by_id_card_by_field, get_cards_actions_by_id_card, get_cards_attachments_by_id_card, add_cards_attachments_by_id_card*, get_cards_attachments_by_id_card_by_id_attachment, delete_card_attachment*, get_cards_board_by_id_card, get_cards_check_item_states_by_id_card, get_cards_checklists_by_id_card, add_cards_checklists_by_id_card*, get_check_item_on_card, update_check_item_on_card*, delete_card_check_item*, get_cards_list_by_id_card, get_cards_members_by_id_card, get_cards_members_voted_by_id_card, add_member_vote_to_card*, get_plugin_data_on_card, get_cards_stickers_by_id_card, create_card_sticker*, get_cards_stickers_by_id_card_by_id_sticker, delete_cards_stickers_by_id_card_by_id_sticker*, update_cards_stickers_by_id_card_by_id_sticker*, update_cards_actions_comments_by_id_card_by_id_action*, delete_card_comment*, update_custom_field_item_on_card*, update_multiple_custom_field_items_on_card*, get_cards_custom_field_items_by_id_card, add_cards_actions_comments_by_id_card*, add_cards_id_labels_by_id_card*, add_member_to_card*, create_card_label*, mark_card_s_notifications_as_read*, remove_label_from_card*, remove_member_from_card*, delete_cards_members_voted_by_id_card_by_id_member*, update_checkitem_on_checklist_on_card*, delete_card_checklist*

**/checklists** (12): add_checklists*, get_checklists_by_id_checklist, update_checklists_by_id_checklist*, delete_checklists_by_id_checklist*, get_checklists_by_id_checklist_by_field, update_checklists_by_id_checklist_by_field*, get_checklists_board_by_id_checklist, get_checklists_cards_by_id_checklist, get_checklists_check_items_by_id_checklist, add_checklists_check_items_by_id_checklist*, get_checkitem_on_checklist, delete_checkitem_from_checklist*

**/customFields** (8): create_new_custom_field_on_board*, get_custom_field, update_custom_field_definition*, delete_custom_field_definition*, add_option_to_custom_field_dropdown*, get_options_of_custom_field_drop_down, get_option_of_custom_field_dropdown, delete_option_of_custom_field_dropdown*

**/emoji** (1): list_available_emoji

**/enterprises** (21): get_enterprise, get_auditlog_data_for_enterprise, get_enterprise_admin_members, get_signup_url_for_enterprise, get_users_of_enterprise, get_members_of_enterprise, get_member_of_enterprise, get_whether_organization_can_be_transferred_to_enterprise, get_bulk_list_of_organizations_that_can_be_transferred_to_enterprise, decline_enterprise_join_requests_from_one_organization_or_bulk_list_of_organizations*, get_claimable_organizations_of_enterprise, get_pending_organizations_of_enterprise, create_auth_token_for_enterprise*, get_organizations_of_enterprise, transfer_organization_to_enterprise*, update_member_s_licensed_status*, deactivate_member_of_enterprise*, update_member_to_be_admin_of_enterprise*, remove_member_as_admin_from_enterprise*, delete_organization_from_enterprise*, bulk_accept_set_of_organizations_to_enterprise

**/labels** (5): get_labels_by_id_label, update_labels_by_id_label*, delete_labels_by_id_label*, update_labels_by_id_label_by_field*, add_labels*

**/lists** (11): get_lists_by_id_list, update_lists_by_id_list*, add_lists*, archive_all_list_cards*, move_all_list_cards*, update_lists_closed_by_id_list*, update_lists_id_board_by_id_list*, update_field_on_list*, get_lists_actions_by_id_list, get_lists_board_by_id_list, get_lists_cards_by_id_list

**/members** (45): get_members_by_id_member, update_members_by_id_member*, get_members_by_id_member_by_field, get_members_actions_by_id_member, get_members_board_backgrounds_by_id_member, upload_new_board_background_for_member*, get_member_board_background, update_members_board_backgrounds_by_id_member_by_id_b*, delete_member_s_custom_board_background*, get_members_board_stars_by_id_member, create_star_for_board*, get_board_star_of_member, update_position_of_board_star_of_member*, remove_board_star*, get_members_boards_by_id_member, get_members_boards_invited_by_id_member, get_members_cards_by_id_member, get_members_custom_board_backgrounds_by_id_member, create_new_custom_board_background*, get_custom_board_background_of_member, update_members_custom_board_backgrounds_by_id_member_*, delete_custom_board_background_of_member*, get_members_custom_emoji_by_id_member, create_member_custom_emoji*, get_member_s_custom_emoji, get_members_custom_stickers_by_id_member, create_member_custom_sticker*, get_members_custom_stickers_by_id_member_by_id_sticke, delete_member_s_custom_sticker*, get_members_notifications_by_id_member, get_members_organizations_by_id_member, get_members_organizations_invited_by_id_member, get_members_saved_searches_by_id_member, create_member_saved_search*, get_saved_search, update_saved_search*, delete_saved_search*, get_members_tokens_by_id_member, create_avatar_for_member*, dismiss_member_message*, get_member_s_notification_channel_settings, update_blocked_notification_keys_of_member_on_channel*, get_blocked_notification_keys_of_member_on_this_channel, put_members_id_notification_channel_settings_channel*, put_members_id_notification_channel_settings_channel_blocked_keys*

**/notifications** (11): get_notifications_by_id_notification, update_notifications_by_id_notification*, get_notifications_by_id_notification_by_field, mark_notifications_as_read*, update_notifications_unread_by_id_notification*, get_notifications_board_by_id_notification, get_notifications_card_by_id_notification, get_notifications_list_by_id_notification, get_notifications_member_by_id_notification, get_notifications_member_creator_by_id_notification, get_notifications_organization_by_id_notification

**/organizations** (26): create_organization*, get_organizations_by_id_org, update_organizations_by_id_org*, delete_organizations_by_id_org*, get_organizations_by_id_org_by_field, get_organizations_actions_by_id_org, get_organizations_boards_by_id_org, create_export_for_organizations*, retrieve_organization_s_exports, get_organizations_members_by_id_org, update_organizations_members_by_id_org*, get_organizations_memberships_by_id_org, get_membership_of_organization, get_plugin_data_scoped_to_organization, get_tags_of_organization, create_tag_in_organization*, update_organizations_members_by_id_org_by_id_member*, delete_organizations_members_by_id_org_by_id_member*, deactivate_or_reactivate_member_of_organization*, update_organization_logo*, delete_organizations_logo_by_id_org*, remove_member_from_organization_and_organization_boards*, remove_associated_google_apps_domain_from_workspace*, delete_email_domain_restriction_on_who_can_be_invited_to_workspace*, delete_organization_s_tag*, get_organizations_new_billable_guests

**/plugins** (5): get_plugin, update_plugin*, create_listing_for_plugin*, get_plugin_s_member_privacy_compliance, updating_plugin_s_listing*

**/search** (2): get_search, get_search_members

**/tokens** (8): get_tokens_by_token, get_tokens_member_by_token, get_tokens_webhooks_by_token, create_webhooks_for_token*, get_tokens_webhooks_by_token_by_id_webhook, delete_tokens_webhooks_by_token_by_id_webhook*, update_webhook_created_by_token*, delete_tokens_by_token*

**/webhooks** (5): create_webhook*, get_webhooks_by_id_webhook, update_webhooks_by_id_webhook*, delete_webhooks_by_id_webhook*, get_webhooks_by_id_webhook_by_field

Plus by hand: get_members_me, who_am_i, get_members_me_boards, update_cards_id_list_by_id_card*, call_api_get, call_api*,
download_card_attachment.
