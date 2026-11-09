# Zoho Mail coverage

Source: Zoho Mail has no OpenAPI spec, so `scripts/openapi/zoho_mail.ts` builds one from its API docs (zoho.com/mail/help/api, generated 2026-11-09): one action per call page, including the ones with separate group and personal addresses.

## Left out

| What | Why |
| --- | --- |
| Partner calls (child organisations) | Need a Zoho reseller account |
| GET organisation subscription info | Served from mailadmin.zoho.com, not the mail API |

## Sign-in

Sign in with Zoho only (no key). Scopes: every family the actions need, each `.ALL` (see `SCOPES` in index.ts). Tokens last an hour and are renewed by `zohoOAuth`.

`accountId` and `zoid` are filled in when left out: the login's only mailbox and its organisation; with several mailboxes the error lists them. The list is cached for 10 minutes per login. `check` labels the connection with the mailbox address.

## Hand adjustments

- Calls that share a path and differ by a `mode` value (mark read, flag, move...) are one action each, with the mode filled in. `messages_update_messages` and `messages_update_emails` take any mode, Composio's way.
- `mode` values come from each page's text; a page that doesn't say keeps `mode` as a plain field.
- Composio's bundled domain and account actions (domain_operations, manage_domain_*, verify_domain_records, update_organization_account) are covered by the individual calls.
- Failures sent with a 200 (`status.code` 4xx) become errors; a dead login marks the connection expired.

## Triggers (polled, polls/zoho_mail.ts)

new_message (folderId, sender filters). Each check looks at the newest 200 in the folder.

## Actions by group (* asks first)

**accounts** (60): accounts_list_accounts, accounts_update_display_name*, add_email_alias*, add_email_forwarding*, add_send_mail_details*, add_user_to_organization*, add_vacation_reply_for_account*, change_active_sync_status*, change_imap_status_for_user*, change_incoming_status_for_user*, change_outgoing_status*, change_pop_status_for_user*, change_tfa_status_of_user*, change_user_role*, delete_copy_while_email_forwarding*, delete_user_account*, disable_email_forwarding*, disable_external_account_imap_pop*, disable_user*, enable_email_forwarding_for_account*, enable_external_account_imap_pop*, enabling_users_using_api_zoho_mail*, fetch_specific_user_details, get_child_organization_details, get_org_details_1, get_single_user_0, get_specific_account_details, list_organization_accounts, organization_update_spam_process_type*, put_add_email_forwarding_0*, put_add_vacation_reply_0*, put_delete_email_forwarding_0*, put_delete_vacation_reply_0*, put_delete_zoho_mail_copy_in_email_forwarding_0*, put_disable_email_forwarding_0*, put_disable_user_account_0*, put_enable_email_forwarding_0*, put_enable_user_account_0*, put_resend_verification_for_email_forwarding_0*, put_resend_verification_for_reply_to_address_0*, put_to_add_send_mail_details_0*, put_update_display_name_0*, put_update_display_name_and_email_address_0*, put_update_email_address_0*, put_update_mail_account_sequence_0*, put_update_reply_to_address_0*, put_update_vacation_reply_0*, put_verify_email_forwarding_0*, remove_email_alias*, remove_email_forwarding*, remove_vacation_reply*, resend_verification_email_for_email_forwarding*, resend_verification_for_reply_to_address*, reset_user_password*, update_display_name_and_email_address_of_user*, update_email_address_of_user_zoho_mail*, update_mail_account_sequence_of_user*, update_reply_to_address*, update_vacation_reply*, verify_email_forwarding*

**activity** (2): get_audit_constants, get_audit_records

**allowedIps** (3): allowed_ips_api*, allowed_ips_list_api, delete_allowed_ips_api*

**antispam** (11): add_update_spam_listing_info*, get_dkim_fail_option, get_dmarc_fail_option, get_spf_fail_option, get_spf_soft_fail_option, organization_spam_listing_info, remove_organization_spam_info*, update_dkim_fail_option*, update_dmarc_fail_option*, update_spf_fail_option*, update_spf_soft_fail_option*

**domains** (22): add_catch_address*, add_dkim_details_to_domain*, add_domain_alias*, add_domain_to_organization*, add_notification_address*, delete_catch_address*, delete_dkim_detail*, delete_notification_address*, disable_sub_domain_stripping*, enable_email_hosting_for_domain*, enable_sub_domain_stripping*, fetch_specific_domain, list_organization_domains, regenerate_dkim_public_key*, remove_domain_alias*, remove_domain_from_organization*, set_as_primary_domain*, set_dkim_detail_as_default*, verify_dkim_public_key*, verify_domain*, verify_mx_record*, verify_spf_record*

**folders** (15): download_inline_image_api, empty_folder*, folders_create_folder*, folders_delete_folder*, folders_get_folder, folders_list_folders, folders_update_folder*, mark_folder_as_read*, messages_delete_email*, messages_download_attachment, messages_get_attachment_info, messages_get_message_content, messages_get_message_headers, messages_get_message_metadata, move_folder*

**groups** (19): add_email_aliases_to_group*, add_members_to_group*, create_group*, delete_group_members*, enable_streams_to_specific_group*, get_content_of_email_held_for_moderation, get_groups, groups_delete_group_bulk*, groups_delete_group_by_zgid*, groups_get_group, groups_list_moderation_emails, groups_moderate_messages*, remove_email_alias_from_group*, update_group_member_role*, update_group_member_settings*, update_group_name*, update_group_settings*, update_member_status*, update_threshlod_limit*

**labels** (5): delete_label*, get_specific_label_details, labels_create_label*, labels_list_labels, update_label*

**links** (32): add_bookmark_personal*, create_bookmark*, create_collection*, delete_bookmark*, delete_bookmark_personal*, delete_collection*, delete_collection_personal*, edit_bookmark*, edit_bookmark_personal*, edit_collection*, get_all_bookmarks_in_trash_api_personal, get_all_collections_personal, get_bookmark_details, get_bookmark_details_personal, get_bookmarks, get_bookmarks_in_collection, get_bookmarks_in_collection_personal, get_bookmarks_in_trash, get_collections, get_collections_in_groups, get_favourite_bookmarks, get_groups_in_bookmarks, get_shared_bookmarks, list_bookmarks, mark_bookmark_as_favorite*, post_create_collection_personal*, put_edit_collection_personal*, put_favorite_bookmark_personal*, restore_a_bookmark_api_personal*, restore_bookmark*, unmark_bookmark_as_favorite*, unmark_fav_bookmark_personal*

**messages** (8): get_original_message, messages_create_draft*, messages_list_emails, messages_reply_to_email*, messages_send_email*, messages_upload_attachment*, search_messages, send_email_with_attachments*

**notes** (35): add_attachments_to_note*, create_new_book_in_notes*, create_note*, delete_attachment_in_note*, delete_attachments_personal*, delete_book_in_notes*, delete_book_personal*, delete_note*, delete_notes_personal*, delete_unmark_as_favorite_personal*, edit_book_in_notes*, edit_note*, get_all_books_personal, get_all_notes_personal, get_attachment_in_note, get_attachments_in_note, get_attachments_personal, get_books, get_favourite_notes, get_groups_in_notes, get_list_of_attachments_personal, get_note, get_note_details_personal, get_notes, get_notes_in_book, get_notes_in_book_personal, get_shared_notes, mark_note_as_favorite*, post_add_attachments_personal*, post_create_book_personal*, post_create_notes_personal*, put_edit_book_personal*, put_edit_note_personal*, put_mark_as_favorite_personal*, unmark_note_as_favorite*

**policy** (18): add_allowed_ip_address_to_access_restriction*, apply_policy_to_users_groups*, assign_access_restriction_to_policy*, assign_account_restriction_to_policy*, assign_email_restriction_to_policy*, assign_forward_restriction_to_policy*, create_access_restriction*, create_account_restriction*, create_email_restriction*, create_forward_restriction*, create_org_policy*, get_access_restrictions, get_account_restrictions, get_email_restrictions, get_forward_restrictions, get_policies, get_policy_groups, get_policy_users

**reports** (1): get_login_history_zoho_mail

**signature** (8): accounts_create_signature*, accounts_get_signatures, add_admin_added_user_signature*, delete_admin_added_user_signature*, delete_user_signature*, get_admin_added_user_signature, update_admin_added_user_signature*, update_user_signature*

**smtplogs** (1): get_smtp_logs*

**storage** (3): get_organization_subscription_details, organization_get_user_storage_details, organization_update_user_storage*

**tasks** (59): add_attachment_to_group_or_personal_task_personal*, add_attachments_to_group_personal_task*, add_custom_status_to_group_personal_task*, add_custom_status_to_task_personal*, add_new_project_under_group_task*, change_task_assignee*, change_task_description*, change_task_priority*, change_task_project*, change_task_title*, delete_attachment_from_group_or_personal_task_personal*, delete_attachments_from_group_personal_task*, delete_custom_status_of_group_personal_task*, delete_custom_status_of_task_personal*, delete_group_task*, delete_project_under_group*, download_specific_attachment_of_group_personal_task, edit_custom_status_of_group_personal_task*, edit_custom_status_of_task_personal*, edit_project_under_group*, get_all_attachments_in_task_personal, get_attachment_details_of_group_personal_task, get_custom_status_of_group_personal_task, get_custom_status_of_task_personal, get_group_details, get_members_in_group, get_projects_in_group, get_single_task_personal, get_specific_attachment_of_a_task_personal, get_specific_task, get_subtasks_personal, get_subtasks_under_task, get_tasks_assigned_to_you, get_tasks_created_by_you, get_tasks_in_group_personal_tasks, get_tasks_in_group_with_given_status, get_tasks_in_project, get_tasks_in_project_with_given_status, group_task_details, put_change_recurring_task_details_personal*, put_change_task_assignee_personal*, put_change_task_description_personal*, put_change_task_due_date_personal*, put_change_task_priority_personal*, put_change_task_project_personal*, put_change_task_reminder_by_due_date_personal*, put_change_task_reminder_personal*, put_change_task_status_personal*, put_change_task_title_personal*, restore_deleted_group_personal_task*, restore_deleted_task_personal*, set_or_change_recurring_task_options*, set_or_change_task_due_date*, set_or_change_task_reminder*, set_or_change_task_reminder_based_on_due_date*, tasks_create_group_task*, tasks_create_personal_task*, tasks_list_personal_tasks, tasks_update_group_task*

**updatemessage** (11): apply_labels*, archive_emails*, flag_emails*, mark_emails_as_read*, mark_emails_as_spam*, mark_emails_as_spam_api*, mark_emails_as_unread*, move_emails*, remove_labels_from_emails*, remove_tag_from_email*, unarchive_emails*

**updatethread** (9): apply_flag_to_thread_s*, apply_label_to_thread_s*, mark_thread_s_as_not_spam*, mark_thread_s_as_read*, mark_thread_s_as_spam*, mark_thread_s_as_unread*, move_thread_s*, remove_label_s_from_thread_s*, remove_labels_from_thread_s*
