# Zoom coverage

Source: Zoom's own OpenAPI files, one per product, from `https://developers.zoom.us/api/zoap/<product>/methods` and `/events` (the Download OpenAPI button on each docs page), generated 2026-11-09 by `bun scripts/openapi-actions.ts zoom`. 720 generated actions plus 2 by hand (quick_add_event, download_recording_file), and 260 Zoom events behind 262 webhook triggers plus 1 polled.

The rule: our Zoom app is user-managed, and Zoom says such an app "can only request scopes that allow access to an individual user's associated data". So an action exists only if the operation has a granular scope without `:admin` or `:master`. Everything else could never run.

## Deliberately left out

| What | Why |
| --- | --- |
| 677 operations in the products we cover, including all Reports but one, most of Accounts, and master-account calls | Each needs an admin scope, which a user-managed app can't hold |
| 32 operations with only classic scopes (device management, contact groups, `imchat:write`, Clips uploads) | Zoom has no granular scope for them, and an app can't mix classic and granular |
| 52 operations Zoom marks deprecated | Includes all of `/iq/*`, replaced by `/zra/*` |
| Contact Center (5 of 327 usable), Virtual Agent (5 of 13) | The usable few do nothing without the admin-only rest |
| Number Management, CRC, QSS, Commerce, Auto Dialer, AI Services, AI Companion, Healthcare, Workforce Management, Cobrowse SDK, Video SDK, SCIM2, Customer Managed Keys | No operation has a user-level scope |
| Chatbot | Sends as a bot with a client-credentials token (`imchat:bot`), not as a signed-in person |
| Websockets | Not a REST API; webhooks carry the same events |

Each skipped operation and its reason is in `skipped` in `actions.json`.

## Composio names not matched, and why

| Composio's | Status |
| --- | --- |
| create/delete/get/list/update `*_iq_*` (19) | `/iq/*` is deprecated by Zoom; the same calls are the `*_zra_*` actions, and get_conversation_content_analysis, get_deal_information |
| create/list `zra_crm_accounts`, `contacts`, `deals`, `leads`; create/delete/list `zra_crm_settings` (11) | Admin-only scope (`zra:*:crm_*:admin`) |
| list_archived_files | Admin-only (`archiving:read:list_archived_files:admin`); per-meeting archive files are available |
| list_devices | Classic admin scope only (`device:read:admin`) |
| update_classification_label | Admin-only scope |

## Hand adjustments (scripts/openapi/zoom.ts, index.ts)

- Named with Composio's names (`namer`, plus `rename`). Where products repeat a summary, the later one gets its product as a prefix.
- `get_daily_usage_report` is kept though admin-only, because Composio has a trigger on it. On a user-managed app it answers with the explanation below.
- Uploads go to `fileapi.zoom.us` (the spec says so only in prose). Clips' spec leaves `/v2` off its server.
- `quick_add_event` by hand, since the spec's request body for it is malformed.
- `download_recording_file` by hand: sends our login only to `zoom.us` hosts (fetch drops it on the redirect to the signed address), always returns a file, refuses Zoom's sign-in page and anything over 100 MB.
- `secrets`: meeting, webinar and user tokens and the ZAK ask first. `reads`: channel, file and table searches and free/busy.
- A missing permission (Zoom's "does not contain scopes") never marks the login dead, and each action says plainly what to do.

## Auth

| Method | Status |
| --- | --- |
| OAuth sign-in (`ZOOM_CLIENT_ID`, `ZOOM_CLIENT_SECRET`), Basic auth at the token endpoint | done |
| Token refresh, with rotating refresh tokens | done |
| Pasted key | Zoom has no personal key |

**Not solved:** Zoom has no way to force the consent page for a confidential client. Someone who already authorized the app goes straight back to our callback, so a sign-in link sent to them can finish by itself.

After any change to the app's scopes, everyone has to connect again: Zoom refuses the old refresh tokens (error 4711).

Sign-in link: Zoom has no setting to force its consent screen, so someone already signed in to Zoom who has already allowed Emplio goes straight through. A sign-in therefore only finishes in the browser that started it (`noConsentScreen`).

## Triggers

Webhook (`triggers.ts`), one address for the whole app, `/webhooks/app/zoom/events`, with `ZOOM_WEBHOOK_SECRET`. Signatures are checked over `v0:<ts>:<body>`, and anything over five minutes old is refused. The delivery id is a hash of the body, which a retry repeats. Automations are stored under the connected person's Zoom user id, so two people at one company don't get each other's events; an event naming no host, user or operator starts nothing. `download_token` is stripped from what automations see. Settings on meeting, webinar and recording events: `meeting_id` and `host`.

Composio's names: new_meeting_created_trigger, meeting_details_changed_trigger, new_meeting_participant_trigger, new_cloud_recording_trigger, meeting_recording_changed_trigger (renamed, trashed, deleted, recovered, transcript ready), meeting_summary_updated_trigger (ready or edited), new_webinar_created_trigger, webinar_details_changed_trigger, new_webinar_participant_trigger, user_information_changed_trigger. Every other event is its own trigger, named after the event.

Not built: `daily_usage_report_changed_trigger`. It needs `report:read:admin`, which a user-managed app can't hold, so it could never run. No saved automation used it.

Left out as events: `account.*`, `group.*`, `information_barriers.*`, Marketplace, Rooms, Contact Center, and Phone events Zoom describes as account-level. Zoom's specs don't list scopes per event, so this list is judged from the descriptions.

## Scopes to start with (21)

What Composio's Zoom offered, and meetings, webinars and recordings. A consent page with hundreds of permissions would put people off, so start here. An action whose scope isn't granted fails with Zoom's own explanation.

`cloud_recording:delete:meeting_recording`, `cloud_recording:delete:recording_file`, `cloud_recording:read:list_recording_files`, `cloud_recording:read:list_user_recordings`, `meeting:delete:meeting`, `meeting:read:list_meetings`, `meeting:read:list_past_instances`, `meeting:read:list_past_participants`, `meeting:read:meeting`, `meeting:read:summary`, `meeting:update:meeting`, `meeting:write:meeting`, `meeting:write:registrant`, `user:read:list_collaboration_devices`, `user:read:settings`, `user:read:user`, `webinar:read:list_past_participants`, `webinar:read:list_registrants`, `webinar:read:list_webinars`, `webinar:read:webinar`, `webinar:write:registrant`

Events to start with: `meeting.created`, `meeting.updated`, `meeting.participant_joined`, `meeting.summary_completed`, `meeting.summary_updated`, `recording.completed`, `recording.renamed`, `recording.trashed`, `recording.deleted`, `recording.recovered`, `recording.transcript_completed`, `webinar.created`, `webinar.updated`, `webinar.participant_joined`, `user.updated`.

## Every scope the actions could use (647)

One user-level granular scope per operation, grouped by product. Mark everything outside Meetings, Users and recordings as optional if the consent page gets too long.

**meetings** (126): archiving:read:archived_files, archiving:update:archived_file_auto_delete_status, cloud_recording:delete:meeting_recording, cloud_recording:delete:meeting_transcript, cloud_recording:delete:recording_file, cloud_recording:read:list_recording_files, cloud_recording:read:list_recording_registrants, cloud_recording:read:list_user_recordings, cloud_recording:read:meeting_transcript, cloud_recording:read:recording_analytics_details, cloud_recording:read:recording_analytics_summary, cloud_recording:read:recording_settings, cloud_recording:read:registration_questions, cloud_recording:update:recording_settings, cloud_recording:update:recover_meeting_recordings, cloud_recording:update:recover_single_recording, cloud_recording:update:registrant_status, cloud_recording:update:registration_questions, cloud_recording:write:recording_registrant, meeting:delete:live_meeting_chat_message, meeting:delete:meeting, meeting:delete:open_app, meeting:delete:poll, meeting:delete:registrant, meeting:delete:summary, meeting:delete:survey, meeting:read:invitation, meeting:read:list_meetings, meeting:read:list_past_instances, meeting:read:list_past_participants, meeting:read:list_poll_results, meeting:read:list_polls, meeting:read:list_registrants, meeting:read:list_registration_questions, meeting:read:list_summaries, meeting:read:list_templates, meeting:read:list_upcoming_meetings, meeting:read:live_streaming_token, meeting:read:livestream, meeting:read:local_recording_token, meeting:read:meeting, meeting:read:past_meeting, meeting:read:past_qa, meeting:read:poll, meeting:read:registrant, meeting:read:summary, meeting:read:survey, meeting:read:token, meeting:update:in_meeting_controls, meeting:update:live_meeting_chat_message, meeting:update:livestream, meeting:update:livestream_status, meeting:update:meeting, meeting:update:participant_rtms_app_status, meeting:update:poll, meeting:update:registrant_status, meeting:update:registration_question, meeting:update:status, meeting:update:survey, meeting:write:batch_polls, meeting:write:batch_registrants, meeting:write:invite_links, meeting:write:meeting, meeting:write:open_app, meeting:write:poll, meeting:write:registrant, meeting:write:sip_dialing, meeting:write:template, pac:read:list_pac_accounts, tsp:delete:tsp_account, tsp:read:list_tsp_accounts, tsp:read:tsp_account, tsp:update:tsp_account, tsp:update:tsp_settings, tsp:write:tsp_account, webinar:delete:branding_name_tag, webinar:delete:branding_virtual_background, webinar:delete:branding_wallpaper, webinar:delete:live_webinar_chat_message, webinar:delete:panelist, webinar:delete:poll, webinar:delete:registrant, webinar:delete:survey, webinar:delete:webinar, webinar:read:branding, webinar:read:list_absentees, webinar:read:list_panelists, webinar:read:list_past_instances, webinar:read:list_past_participants, webinar:read:list_past_polls, webinar:read:list_polls, webinar:read:list_registrants, webinar:read:list_registration_questions, webinar:read:list_templates, webinar:read:list_tracking_sources, webinar:read:list_webinars, webinar:read:live_streaming_token, webinar:read:livestream, webinar:read:local_recording_token, webinar:read:past_qa, webinar:read:poll, webinar:read:registrant, webinar:read:survey, webinar:read:token, webinar:read:webinar, webinar:update:branding_name_tag, webinar:update:branding_virtual_background, webinar:update:livestream, webinar:update:livestream_status, webinar:update:poll, webinar:update:registrant_status, webinar:update:registration_question, webinar:update:status, webinar:update:survey, webinar:update:webinar, webinar:write:batch_registrants, webinar:write:branding_name_tag, webinar:write:branding_virtual_background, webinar:write:branding_wallpaper, webinar:write:invite_links, webinar:write:panelist, webinar:write:poll, webinar:write:registrant, webinar:write:sip_dialing, webinar:write:template, webinar:write:webinar

**users** (27): user:delete:assistant, user:delete:scheduler, user:delete:token, user:delete:user, user:delete:virtual_background_files, user:read:collaboration_device, user:read:email, user:read:list_assistants, user:read:list_collaboration_devices, user:read:list_permissions, user:read:list_schedulers, user:read:pm_room, user:read:presence_status, user:read:settings, user:read:token, user:read:user, user:read:zak, user:update:email, user:update:password, user:update:presence_status, user:update:settings, user:update:status, user:update:user, user:write:assistant, user:write:profile_picture, user:write:virtual_background_files, user:write:waiting_room_branding

**accounts** (8): role:delete:member, role:delete:role, role:read:list_members, role:read:list_roles, role:read:role, role:update:role, role:write:member, role:write:role

**chat** (69): contact:read:list_contacts, team_chat:delete:batch_members, team_chat:delete:channel, team_chat:delete:channels, team_chat:delete:custom_emoji, team_chat:delete:file, team_chat:delete:member, team_chat:delete:mention_group, team_chat:delete:reminder, team_chat:delete:scheduled_message, team_chat:delete:shared_space, team_chat:delete:shared_space_administrators, team_chat:delete:shared_space_members, team_chat:delete:user_channel, team_chat:delete:user_message, team_chat:read:channel, team_chat:read:contact, team_chat:read:file, team_chat:read:list_bookmarks, team_chat:read:list_contacts, team_chat:read:list_custom_emojis, team_chat:read:list_members, team_chat:read:list_pinned_messages, team_chat:read:list_reminders, team_chat:read:list_scheduled_messages, team_chat:read:list_shared_space_channels, team_chat:read:list_shared_space_members, team_chat:read:list_shared_spaces, team_chat:read:list_user_channels, team_chat:read:list_user_messages, team_chat:read:list_user_sessions, team_chat:read:mention_group, team_chat:read:shared_space, team_chat:read:thread_message, team_chat:read:user_channel, team_chat:read:user_message, team_chat:update:archive_channels, team_chat:update:bookmark, team_chat:update:channel, team_chat:update:chat_control, team_chat:update:mention_group, team_chat:update:message_emoji, team_chat:update:message_status, team_chat:update:pin_message, team_chat:update:shared_space, team_chat:update:shared_space_channels, team_chat:update:shared_space_owner, team_chat:update:user_channel, team_chat:update:user_message, team_chat:write:contact_information, team_chat:write:custom_emoji, team_chat:write:files, team_chat:write:member, team_chat:write:members, team_chat:write:mention_group, team_chat:write:message_files, team_chat:write:reminder, team_chat:write:search_channels, team_chat:write:shared_space, team_chat:write:shared_space_administrators, team_chat:write:shared_space_members, team_chat:write:user_channel, team_chat:write:user_message, zoom_chat:delete:chat_tab, zoom_chat:delete:personal_contact, zoom_chat:update:chat_tab, zoom_chat:update:personal_contact, zoom_chat:write:chat_tab, zoom_chat:write:personal_contact

**whiteboard** (37): whiteboard:delete:collaborator, whiteboard:delete:content, whiteboard:delete:project, whiteboard:delete:project_collaborator, whiteboard:delete:project_whiteboard, whiteboard:delete:whiteboard, whiteboard:delete:whiteboard_classification, whiteboard:read:archived_file, whiteboard:read:content, whiteboard:read:export, whiteboard:read:file, whiteboard:read:import, whiteboard:read:list_classification_labels, whiteboard:read:list_collaborators, whiteboard:read:list_projects, whiteboard:read:list_sessions, whiteboard:read:list_whiteboards, whiteboard:read:project, whiteboard:read:project_collaborator, whiteboard:read:session, whiteboard:read:subproject, whiteboard:read:whiteboard, whiteboard:update:collaborator, whiteboard:update:project, whiteboard:update:project_collaborator, whiteboard:update:share_setting, whiteboard:update:whiteboard_classification, whiteboard:write:collaborator, whiteboard:write:content, whiteboard:write:export, whiteboard:write:file, whiteboard:write:import, whiteboard:write:project, whiteboard:write:project_collaborator, whiteboard:write:project_whiteboard, whiteboard:write:subproject, whiteboard:write:whiteboard

**iq** (22): zra:delete:conversation_comment, zra:delete:conversations, zra:delete:deal_activity, zra:read:conversation_analysis, zra:read:conversation_participants, zra:read:conversation_scorecards, zra:read:conversations, zra:read:deal, zra:read:indicator, zra:read:list_conversation_comments, zra:read:list_conversation_playlists, zra:read:list_conversations, zra:read:list_deal_activities, zra:read:list_deals, zra:read:team_list, zra:read:team_managers, zra:read:team_members, zra:read:user, zra:update:conversation_comment, zra:update:conversation_host, zra:write:conversation, zra:write:file

**marketplace** (7): marketplace:read:app, marketplace:read:custom_fields, marketplace:read:list_user_app_requests, marketplace:read:list_user_entitlements, marketplace:update:client_secret, marketplace:write:app, marketplace:write:notifications

**calendar** (27): calendar:delete:acl, calendar:delete:calendar, calendar:delete:calendar_list, calendar:delete:event, calendar:read:acl, calendar:read:calendar, calendar:read:calendar_list, calendar:read:color, calendar:read:event, calendar:read:instance_event, calendar:read:list_acl, calendar:read:list_calendar_lists, calendar:read:list_events, calendar:read:list_settings, calendar:read:setting, calendar:update:acl, calendar:update:calendar, calendar:update:calendar_list, calendar:update:event, calendar:update:setting, calendar:write:acl, calendar:write:calendar, calendar:write:calendar_list, calendar:write:event, calendar:write:import_event, calendar:write:move_event, calendar:write:quick_add_event

**mail** (40): email:delete:draft, email:delete:label, email:delete:msg, email:delete:setting_delegate, email:delete:setting_filter, email:delete:thread, email:read:attachment, email:read:draft, email:read:history, email:read:label, email:read:list_drafts, email:read:list_labels, email:read:list_msgs, email:read:list_setting_delegates, email:read:list_setting_filters, email:read:list_threads, email:read:msg, email:read:profile, email:read:setting_delegate, email:read:setting_filter, email:read:setting_vacation, email:read:thread, email:update:draft, email:update:label, email:update:setting_vacation, email:write:batch_delete_msgs, email:write:batch_modify_msgs, email:write:draft, email:write:label, email:write:modify_msg, email:write:msg, email:write:send_draft, email:write:send_msg, email:write:setting_delegate, email:write:setting_filter, email:write:thread, email:write:trash_msg, email:write:trash_thread, email:write:untrash_msg, email:write:untrash_thread

**scheduler** (21): scheduler:delete:availability, scheduler:delete:delete_schedule, scheduler:delete:scheduled_event, scheduler:read:analytics, scheduler:read:availability, scheduler:read:get_schedule, scheduler:read:list_availability, scheduler:read:list_schedule, scheduler:read:list_scheduled_events, scheduler:read:routing, scheduler:read:scheduled_event, scheduler:read:scheduled_event_attendee, scheduler:read:user, scheduler:update:availability, scheduler:update:patch_schedule, scheduler:update:scheduled_event, scheduler:write:availability, scheduler:write:insert_schedule, scheduler:write:scheduled_event, scheduler:write:share, scheduler:write:single_use_link

**tasks** (17): tasks:delete:assignees, tasks:delete:collaborator, tasks:delete:comment, tasks:delete:task, tasks:read:assignees, tasks:read:comments, tasks:read:import, tasks:read:list_collaborators, tasks:read:list_tasks, tasks:read:task, tasks:update:task, tasks:write:assignees, tasks:write:collaborators, tasks:write:comment, tasks:write:file, tasks:write:import, tasks:write:task

**clips** (16): clips:delete:clip, clips:delete:collaborators, clips:delete:comment, clips:read:chapters, clips:read:clip, clips:read:download_clip, clips:read:list_collaborator, clips:read:list_comments, clips:read:list_user_clips, clips:update:clip, clips:update:share_setting, clips:write:chapters, clips:write:collaborators, clips:write:duplicate, clips:write:star_clips, clips:write:uploadTempFile

**canvas** (29): canvas:delete:comment, canvas:delete:data_table, canvas:read:comment, canvas:read:data_table, canvas:update:comment, canvas:update:data_table, canvas:write:comment, canvas:write:data_table, canvas:write:file_search, docs:delete:collaborator, docs:delete:content, docs:delete:file, docs:read:export, docs:read:file, docs:read:general_access, docs:read:import, docs:read:list_children, docs:read:list_file_collaborators, docs:update:collaborator, docs:update:content, docs:update:file, docs:update:file_owner, docs:update:general_access, docs:write:collaborator, docs:write:content, docs:write:export, docs:write:file, docs:write:file_uploads, docs:write:import

**my-notes** (2): my_notes:read:content, my_notes:read:note

**events** (83): zoom_events:delete:access_links, zoom_events:delete:event, zoom_events:delete:exhibitor, zoom_events:delete:hub_host, zoom_events:delete:session, zoom_events:delete:session_reservations, zoom_events:delete:speaker, zoom_events:delete:ticket, zoom_events:delete:ticket_type, zoom_events:delete:vod_channel, zoom_events:delete:vod_channel_videos, zoom_events:read:access_links, zoom_events:read:attendee_engagement, zoom_events:read:chat_transcripts, zoom_events:read:custom_report, zoom_events:read:event, zoom_events:read:event_attendance, zoom_events:read:event_registration, zoom_events:read:exhibitor, zoom_events:read:list_access_links, zoom_events:read:list_all_vod_channels, zoom_events:read:list_attendee_actions, zoom_events:read:list_coeditors, zoom_events:read:list_email_types, zoom_events:read:list_emails_status, zoom_events:read:list_events, zoom_events:read:list_exhibitors, zoom_events:read:list_hub_hosts, zoom_events:read:list_hub_videos, zoom_events:read:list_hubs, zoom_events:read:list_registrants, zoom_events:read:list_registration_questions, zoom_events:read:list_session_attendee_actions, zoom_events:read:list_session_attendees, zoom_events:read:list_session_interpreters, zoom_events:read:list_session_polls, zoom_events:read:list_session_reservations, zoom_events:read:list_session_surveys, zoom_events:read:list_sessions, zoom_events:read:list_speakers, zoom_events:read:list_sponsor_tiers, zoom_events:read:list_ticket_types, zoom_events:read:list_tickets, zoom_events:read:list_vod_channel_videos, zoom_events:read:session, zoom_events:read:session_attendance, zoom_events:read:session_livestream_config, zoom_events:read:session_token, zoom_events:read:speaker, zoom_events:read:ticket, zoom_events:read:video_metadata, zoom_events:read:vod_channel, zoom_events:read:vod_registration_questions, zoom_events:read:vod_registrations, zoom_events:update:access_links, zoom_events:update:batch_attendee_actions, zoom_events:update:batch_session_attendee_actions, zoom_events:update:event, zoom_events:update:exhibitor, zoom_events:update:registraion_question, zoom_events:update:session, zoom_events:update:session_interpreter, zoom_events:update:session_livestream_config, zoom_events:update:session_poll, zoom_events:update:speaker, zoom_events:update:ticket_type, zoom_events:update:video_metadata, zoom_events:update:vod_channel, zoom_events:update:vod_registration_questions, zoom_events:write:access_links, zoom_events:write:coeditor, zoom_events:write:event, zoom_events:write:exhibitor, zoom_events:write:file_upload, zoom_events:write:hub_host, zoom_events:write:session, zoom_events:write:session_reservations, zoom_events:write:speaker, zoom_events:write:ticket, zoom_events:write:ticket_type, zoom_events:write:vod_channel, zoom_events:write:vod_channel_videos, zoom_events:write:vod_registration

**hub** (8): hub:delete:shared_folder, hub:read:content, hub:read:file_duplicate_task, hub:read:shared_folder, hub:update:shared_folder, hub:write:content, hub:write:move, hub:write:shared_folder

**quality-management** (5): zoom_quality_management:read:calibrations, zoom_quality_management:read:cases, zoom_quality_management:read:evaluations, zoom_quality_management:read:interactions, zoom_quality_management:write:interactions

**phone** (60): phone:delete:audio, phone:delete:call_log, phone:delete:call_recording, phone:delete:extension_inbound_block_rule, phone:delete:fax_log, phone:delete:line_keys, phone:delete:shared_setting, phone:delete:user_call_handling_setting, phone:delete:user_customized_number, phone:delete:user_number, phone:delete:user_setting, phone:delete:users_calling_plan, phone:delete:voicemail, phone:read:ai_call_summary, phone:read:audio, phone:read:call_recording, phone:read:device_line_keys, phone:read:fax_cover_page, phone:read:fax_log, phone:read:line_keys, phone:read:list_audios, phone:read:list_call_logs, phone:read:list_extension_inbound_block_rules, phone:read:list_fax_log, phone:read:list_recordings, phone:read:list_sms_sessions, phone:read:list_user_customized_number, phone:read:list_voicemails, phone:read:list_whatsapp_sessions, phone:read:recording_transcript, phone:read:sms_campaign_number_opt_status, phone:read:sms_message, phone:read:sms_session, phone:read:user, phone:read:user_call_handling_setting, phone:read:user_setting, phone:read:voicemail, phone:read:whatsapp_message, phone:read:whatsapp_session, phone:update:audio, phone:update:call_recording, phone:update:calling_plan, phone:update:device_line_keys, phone:update:line_keys, phone:update:shared_setting, phone:update:user, phone:update:user_call_handling_setting, phone:update:user_setting, phone:update:voicemail, phone:write:audio, phone:write:batch_audios, phone:write:calling_plan, phone:write:extension_inbound_block_rule, phone:write:send_fax, phone:write:shared_setting, phone:write:user_call_handling_setting, phone:write:user_customized_number, phone:write:user_number, phone:write:user_setting, phone:write:whatsapp_message

**rooms** (17): visitor_management:delete:invitation, visitor_management:read:invitation_details, visitor_management:read:list_invitations, visitor_management:update:invitation, visitor_management:write:check_in, visitor_management:write:invitation, workspace:delete:reservation, workspace:read:assignment, workspace:read:list_reservations, workspace:read:list_workspaces, workspace:read:location, workspace:read:reservation, workspace:read:usage, workspace:update:reservation, workspace:write:events, workspace:write:location, workspace:write:reservation

**video-management** (26): video_mgmt:delete:channel, video_mgmt:delete:channel_playlists, video_mgmt:delete:channel_videos, video_mgmt:delete:permissions, video_mgmt:delete:playlist, video_mgmt:delete:playlist_videos, video_mgmt:read:channel, video_mgmt:read:list_channel_playlists, video_mgmt:read:list_channel_videos, video_mgmt:read:list_channels, video_mgmt:read:list_permissions, video_mgmt:read:list_playlist_videos, video_mgmt:read:list_playlists, video_mgmt:read:list_videos, video_mgmt:read:video_metadata, video_mgmt:update:channel, video_mgmt:update:permissions, video_mgmt:update:playlist, video_mgmt:update:video_metadata, video_mgmt:write:channel, video_mgmt:write:channel_playlists, video_mgmt:write:channel_videos, video_mgmt:write:file, video_mgmt:write:permissions, video_mgmt:write:playlist, video_mgmt:write:playlist_videos

## Events to subscribe to (260)

Event notification endpoint: `https://api.emplio.app/webhooks/app/zoom/events`

**calendar** (11): calendar.acl_create, calendar.acl_delete, calendar.acl_update, calendar.calendarlist_create, calendar.calendarlist_delete, calendar.calendarlist_update, calendar.event_create, calendar.event_delete, calendar.event_update, calendar.setting_create, calendar.setting_update

**canvas** (1): canvas.file_edited

**chat_channel** (7): chat_channel.created, chat_channel.deleted, chat_channel.member_invited, chat_channel.member_joined, chat_channel.member_left, chat_channel.member_removed, chat_channel.updated

**chat_message** (4): chat_message.deleted, chat_message.replied, chat_message.sent, chat_message.updated

**docs** (4): docs.data_table_row_created, docs.data_table_row_updated, docs.data_table_user_mentioned, docs.file_created

**mail** (1): mail.history_event

**meeting** (63): meeting.ai_companion_assets_deleted, meeting.ai_companion_started, meeting.ai_companion_stopped, meeting.aic_transcript_completed, meeting.alert, meeting.breakout_room_sharing_ended, meeting.breakout_room_sharing_started, meeting.chat_message_file_downloaded, meeting.chat_message_file_sent, meeting.chat_message_sent, meeting.converted_to_webinar, meeting.created, meeting.deleted, meeting.device_tested, meeting.ended, meeting.invitation_accepted, meeting.invitation_dispatched, meeting.invitation_rejected, meeting.invitation_timeout, meeting.live_streaming_started, meeting.live_streaming_stopped, meeting.participant_admitted, meeting.participant_bind, meeting.participant_data_connection_established, meeting.participant_feedback, meeting.participant_jbh_joined, meeting.participant_jbh_waiting, meeting.participant_jbh_waiting_left, meeting.participant_joined, meeting.participant_joined_breakout_room, meeting.participant_joined_waiting_room, meeting.participant_left, meeting.participant_left_breakout_room, meeting.participant_left_waiting_room, meeting.participant_phone_callout_accepted, meeting.participant_phone_callout_failed, meeting.participant_phone_callout_missed, meeting.participant_phone_callout_rejected, meeting.participant_phone_callout_ringing, meeting.participant_put_in_waiting_room, meeting.participant_role_changed, meeting.participant_room_system_callout_accepted, meeting.participant_room_system_callout_failed, meeting.participant_room_system_callout_missed, meeting.participant_room_system_callout_rejected, meeting.participant_room_system_callout_ringing, meeting.permanently_deleted, meeting.recovered, meeting.registration_approved, meeting.registration_cancelled, meeting.registration_created, meeting.registration_denied, meeting.risk_alert, meeting.sharing_ended, meeting.sharing_started, meeting.started, meeting.summary_completed, meeting.summary_deleted, meeting.summary_recovered, meeting.summary_shared, meeting.summary_trashed, meeting.summary_updated, meeting.updated

**my_notes** (3): my_notes.note_completed, my_notes.note_generated, my_notes.transcript_generated

**phone** (10): phone.sms_campaign_number_opt_in, phone.sms_campaign_number_opt_out, phone.sms_etiquette_block, phone.sms_etiquette_warn, phone.sms_received, phone.sms_sent, phone.sms_sent_failed, phone.whatsapp_message_received, phone.whatsapp_message_sent, phone.whatsapp_message_sent_failed

**quality_management** (2): quality_management.evaluation_completed, quality_management.interaction_analysis_completed

**recording** (18): recording.archive_files_completed, recording.batch_deleted, recording.batch_recovered, recording.batch_trashed, recording.cloud_storage_usage_updated, recording.completed, recording.deleted, recording.paused, recording.recovered, recording.registration_approved, recording.registration_created, recording.registration_denied, recording.renamed, recording.resumed, recording.started, recording.stopped, recording.transcript_completed, recording.trashed

**revenue_accelerator** (7): revenue_accelerator.conversation_analysis_completed, revenue_accelerator.conversation_crm_associations_changed, revenue_accelerator.playlist_add_moment, revenue_accelerator.playlist_create, revenue_accelerator.playlist_delete, revenue_accelerator.playlist_remove_moment, revenue_accelerator.post_comment_completed

**scheduler** (3): scheduler.routing_form_submission_created, scheduler.scheduled_event_canceled, scheduler.scheduled_event_created

**task** (8): task.assignee_updated, task.collaborator_updated, task.comment_updated, task.completed, task.created, task.deleted, task.reopened, task.updated

**team_chat** (43): team_chat.bookmark_added, team_chat.bookmark_removed, team_chat.channel_app_added, team_chat.channel_app_removed, team_chat.channel_archived, team_chat.channel_invitation_accepted, team_chat.channel_invitation_approval_requested, team_chat.channel_invitation_approved, team_chat.channel_invitation_created, team_chat.channel_invitation_declined, team_chat.channel_invitation_rejected, team_chat.channel_invitation_removed, team_chat.channel_join_approval_requested, team_chat.channel_join_approved, team_chat.channel_join_declined, team_chat.channel_join_requested, team_chat.channel_message_deleted, team_chat.channel_message_posted, team_chat.channel_message_updated, team_chat.channel_pin_added, team_chat.channel_pin_removed, team_chat.channel_reaction_added, team_chat.channel_reaction_removed, team_chat.channel_unarchived, team_chat.dm_message_deleted, team_chat.dm_message_posted, team_chat.dm_message_updated, team_chat.dm_reaction_added, team_chat.dm_reaction_removed, team_chat.emoji_added, team_chat.emoji_removed, team_chat.file_changed, team_chat.file_deleted, team_chat.file_downloaded, team_chat.file_shared, team_chat.file_unshared, team_chat.file_uploaded, team_chat.shared_spaces_edited, team_chat.shared_spaces_member_invited, team_chat.shared_spaces_member_left, team_chat.shared_spaces_member_removed, team_chat.starred, team_chat.unstarred

**user** (15): user.activated, user.created, user.deactivated, user.deleted, user.disassociated, user.invitation_accepted, user.personal_notes_updated, user.presence_status_updated, user.settings_updated, user.signed_in, user.signed_out, user.tsp_created, user.tsp_deleted, user.tsp_updated, user.updated

**video_management** (7): video_management.channel_deleted, video_management.channel_owner_changed, video_management.channel_published, video_management.channel_unpublished, video_management.channel_video_added, video_management.channel_video_removed, video_management.video_quiz_completed

**webinar** (24): webinar.alert, webinar.chat_message_file_downloaded, webinar.chat_message_file_sent, webinar.chat_message_sent, webinar.converted_to_meeting, webinar.created, webinar.deleted, webinar.ended, webinar.participant_bind, webinar.participant_data_connection_established, webinar.participant_feedback, webinar.participant_joined, webinar.participant_left, webinar.participant_role_changed, webinar.permanently_deleted, webinar.recovered, webinar.registration_approved, webinar.registration_cancelled, webinar.registration_created, webinar.registration_denied, webinar.sharing_ended, webinar.sharing_started, webinar.started, webinar.updated

**whiteboard** (8): whiteboard.archive_available, whiteboard.created, whiteboard.deleted, whiteboard.file_added, whiteboard.opened, whiteboard.share_settings_updated, whiteboard.shared, whiteboard.sharing_updated

**zoom_events** (21): zoom_events.event_cancelled, zoom_events.event_duplicated, zoom_events.event_published, zoom_events.event_updated, zoom_events.exhibitor_created, zoom_events.exhibitor_deleted, zoom_events.exhibitor_updated, zoom_events.session_created, zoom_events.session_deleted, zoom_events.session_ended, zoom_events.session_updated, zoom_events.speaker_created, zoom_events.speaker_deleted, zoom_events.speaker_updated, zoom_events.ticket_created, zoom_events.ticket_deleted, zoom_events.ticket_type_created, zoom_events.ticket_type_deleted, zoom_events.ticket_type_updated, zoom_events.ticket_updated, zoom_events.vod_registration_created

## Actions by group (* asks first)

**Accounts** (1): list_zra_settings_indicators

**acl** (5): list_acl_rules_of_specified_calendar, create_new_acl_rule*, get_specified_acl_rule, delete_existing_acl_rule*, update_specified_acl_rule*

**analytics** (1): report_analytics

**App** (9): send_app_notifications*, list_marketplace_app_custom_fields, create_apps*, get_information_about_app, deletes_app*, rotate_client_secret*, get_app_user_entitlements, get_marketplace_user_apps, get_marketplace_user_entitlements

**Archiving** (5): update_archived_file_s_auto_delete_status*, get_meeting_s_archived_files, list_whiteboards_sessions, download_whiteboard_session_activity, get_whiteboard_session

**Assignee** (3): get_assignees_of_task, add_assignees_to_task*, remove_assignee_from_task*

**Attendee Actions** (4): list_event_attendee_actions, update_event_attendee_actions*, list_session_attendee_actions, update_session_attendee_actions*

**Audio Library** (6): get_audio_item, delete_audio_item*, update_audio_item*, list_audio_items, add_audio_item_for_text_to_speech_conversion*, add_audio_items*

**availability** (5): list_availability, insert_availability*, get_availability, delete_availability*, patch_availability*

**Calendar (by hand)** (1): quick_add_event*

**calendar list** (5): list_calendars_in_user_s_own_calendar_list, insert_existing_calendar_to_user_s_own_calendar_list*, get_specified_calendar_from_user_s_own_calendar_list, delete_existing_calendar_from_user_s_own_calendar_list*, update_existing_calendar_in_user_s_own_calendar_list*

**calendars** (4): create_new_secondary_calendar*, get_specified_calendar, delete_calendar_owned_by_user*, update_specified_calendar*

**Calibrations** (2): list_calibrations, get_calibration_detail

**Call Logs** (5): get_user_ai_call_summary_detail, download_transcript_for_ai_call_summary, get_user_s_call_history, sync_user_s_call_history, delete_user_s_call_history*

**Cases** (2): list_cases, get_case_details

**Channels** (6): list_video_channels, channels_create_channel*, get_channel_details, channels_delete_channel*, update_video_channel*, channel_actions*

**Chat Channel Mention Group** (7): list_channel_mention_groups, create_channel_mention_group*, delete_channel_mention_group*, update_channel_mention_group_information*, list_members_of_mention_group, add_channel_members_to_mention_group*, remove_channel_mention_group_members*

**Chat Channels** (15): perform_operations_on_channels*, get_channel, delete_channel*, update_channel*, list_channel_members, invite_channel_members*, batch_remove_members_from_channel*, join_channel*, leave_channel*, remove_member*, list_user_s_channels, create_channel*, add_chat_session_content_tab*, remove_chat_session_content_tab*, update_chat_session_content_tab*

**Chat Channels (Account-level)** (7): batch_delete_channels*, search_user_s_or_account_s_channels, chat_channels_account_level__get_channel, chat_channels_account_level__delete_channel*, chat_channels_account_level__update_channel*, chat_channels_account_level__list_channel_members, chat_channels_account_level__invite_channel_members*

**Chat Emoji** (3): list_custom_emojis, add_custom_emoji*, delete_custom_emoji*

**Chat Files** (4): get_file_info, delete_chat_file*, upload_chat_file*, send_chat_file*

**Chat Messages** (15): perform_operations_on_message_of_channel*, list_pinned_history_messages_of_channel, get_forwarded_message, list_bookmarks, add_or_remove_bookmark*, list_scheduled_messages, delete_scheduled_message*, list_user_s_chat_messages, send_chat_message*, get_message, update_message*, delete_message*, react_to_chat_message*, mark_message_read_or_unread*, retrieve_thread

**Chat Reminder** (3): create_reminder_message*, delete_reminder_for_message*, list_reminders

**Chat Sessions** (2): star_or_unstar_channel_or_contact_user*, list_user_s_chat_sessions

**Classification Labels** (3): list_classification_labels, apply_classification_to_whiteboard*, remove_whiteboard_classification*

**Clips** (3): list_clips, batch_star_clips*, get_collaborators_of_clip

**Cloud Recording** (16): get_meeting_recordings, delete_meeting_recordings*, get_meeting_or_webinar_recording_s_analytics_details, get_meeting_or_webinar_recording_s_analytics_summary, list_recording_registrants, create_recording_registrant*, get_registration_questions, update_registration_questions*, update_registrant_s_status*, get_meeting_recording_settings, update_meeting_recording_settings*, delete_recording_file*, recover_single_recording*, recover_meeting_recordings*, list_all_recordings, download_recording_file

**Co Editors** (2): list_coeditors, add_or_remove_event_co_editors*

**Collaborator** (13): get_collaborators_of_whiteboard, add_whiteboard_collaborator*, update_whiteboard_collaborator*, delete_whiteboard_collaborator*, get_collaborators_of_task, add_collaborators_to_task*, remove_collaborator_from_task*, share_clip_with_new_users*, remove_collaborator_from_clip*, list_collaborators_of_file, add_collaborators_for_file*, remove_collaborator_from_file*, modify_collaborator_s_role_on_file*

**colors** (1): get_color_definitions_for_calendars_and_events

**Comment** (10): get_task_s_comments, add_comment_to_task*, delete_task_s_comment*, list_clip_comments, delete_comment*, list_comments, create_comment*, get_comment, comment_delete_comment*, update_comment*

**Contacts** (6): list_user_s_contacts, get_user_s_contact_details, search_company_contacts, create_user_managed_contact*, delete_user_managed_contact*, update_user_managed_contact*

**Content** (3): get_whiteboard_content, save_whiteboard_content*, delete_whiteboard_content*

**Conversations** (17): list_zra_conversations, create_zra_conversation*, get_conversation_information, delete_zra_conversation*, get_zra_conversation_comments, create_zra_conversation_comment*, delete_zra_conversation_comment*, update_zra_conversation_comment*, get_conversation_content_analysis, get_zra_conversation_interactions, get_zra_conversation_scorecards, update_zra_conversation_host*, upload_iq_file*, upload_iq_multipart_file*, initiate_and_complete_multipart_upload*, create_zra_user_conversation*, list_zra_user_conversation_playlists

**DataTable Content** (12): create_data_table*, list_data_tables_in_file, update_table_metadata*, list_columns, create_column*, delete_column*, update_column*, update_form*, create_table_rows*, delete_rows*, update_rows*, search_rows

**Deals** (4): list_zra_deals, get_deal_information, get_zra_deal_activities, delete_zra_deal_activities*

**Device Line Keys** (2): get_device_line_keys_information, batch_update_device_line_key_position*

**Doc Content** (4): insert_blocks_into_document*, replace_range_of_blocks*, delete_specific_block*, update_specific_block*

**Document** (4): list_whiteboards, create_whiteboard*, get_whiteboard, delete_whiteboard*

**Download** (1): download_clip

**Drafts** (6): list_emails_from_draft_folder, create_new_draft_email*, send_out_draft_email*, get_specified_draft_email, update_specified_draft_email*, delete_existing_draft_email*

**Emails** (2): list_event_email_types, list_event_emails_sent_status

**Evaluations** (3): list_automated_evaluations, list_evaluations, view_evaluation_detail

**Event Access** (5): list_event_access_links, create_event_access_link*, get_event_access_link, delete_event_access_link*, update_event_access*

**events** (8): list_events_on_specified_calendar, insert_new_event_to_specified_calendar*, import_event_to_specified_calendar*, get_specified_event_on_specified_calendar, delete_existing_event_from_specified_calendar*, update_specified_event_on_specified_calendar*, list_instances_of_specified_recurring_event, move_specified_event_from_calendar_to_another_specified_calendar*

**Events** (6): list_events, create_event*, get_event, delete_event*, update_event*, event_actions*

**Exhibitors** (6): list_exhibitors, create_exhibitor*, get_exhibitor, delete_exhibitor*, update_exhibitor_for_event*, list_sponsor_tiers

**Export** (7): create_whiteboard_export*, download_whiteboard_export, get_whiteboard_export_status, create_file_export*, get_file_export_status, get_file_content, gethubcontent

**Fax** (8): upload_fax_file*, get_extension_s_fax_logs, get_fax_cover_pages, download_fax_cover_page_preview_image, send_fax*, delete_fax_log*, update_fax_log_read_status*, download_fax_file

**File** (3): upload_whiteboard_file*, download_imported_whiteboard_file, upload_file_in_tasks*

**File Management** (9): create_new_file*, get_metadata_of_file, delete_file*, modify_metadata_of_file*, list_children_of_file, transfer_ownership_of_file*, get_file_duplicate_task_status, duplicate_file*, move_file*

**File Uploads** (1): create_file_upload_for_docs_import_or_attachments*

**Files** (4): upload_events_file*, upload_events_multipart_files*, initiate_and_complete_multipart_file_upload*, upload_file_for_video_management*

**freebusy** (1): query_freebusy_information_for_set_of_calendars

**General Access** (2): get_general_access_setting_of_file, modify_general_access_setting_of_file*

**History** (1): list_history_of_events_for_mailbox

**Hubs** (5): list_hubs, list_hub_hosts, creates_new_hub_host*, remove_hub_host*, list_hub_videos

**Import** (8): import_whiteboard*, get_whiteboard_import_status, submit_task_import_job*, get_import_job_status, create_new_file_from_content*, create_new_file_by_import*, get_file_import_status, create_new_file_with_content*

**In-Meeting Apps** (2): add_meeting_app*, delete_meeting_app*

**In-Meeting Features** (5): delete_live_meeting_message*, update_live_meeting_message*, in_meeting_controls*, get_meeting_s_join_token_for_local_recording*, get_meeting_s_token*

**Inbound Blocked List** (3): list_extension_s_inbound_block_rules, add_extension_s_inbound_block_rule*, delete_extension_s_inbound_block_rule*

**Insights** (1): get_attendee_engagement_data

**Interactions** (3): list_interactions, add_interaction*, view_interaction_detail

**Invitation & Registration** (10): perform_batch_registration*, get_meeting_invitation, create_meeting_s_invite_links*, list_meeting_registrants, add_a_meeting_registrant*, list_registration_questions, meeting_registrant_question_update*, meeting_registrant_status*, get_meeting_registrant, delete_meeting_registrant*

**Invitations** (1): send_new_contact_invitation*

**Labels** (6): list_labels_in_mailbox, create_new_label_in_mailbox*, get_specified_label_in_mailbox, update_specified_label_in_mailbox*, delete_existing_label_from_mailbox*, patch_specified_label_in_mailbox*

**Line Keys** (3): get_line_key_position_and_settings_information, batch_update_line_key_position_and_settings_information*, delete_line_key_setting*

**Live streaming** (4): get_meeting_s_join_token_for_live_streaming*, get_livestream_details, update_livestream*, update_livestream_status*

**Mailbox** (1): get_mailbox_profile

**Manifest** (3): validate_marketplace_app_manifest*, export_app_manifest_from_existing_app, update_app_by_manifest*

**Meeting Transcript** (2): get_meeting_transcript, delete_meeting_or_webinar_transcript*

**Meetings** (13): update_participant_real_time_media_streams_rtms_app_status*, get_a_meeting, delete_a_meeting*, update_a_meeting*, get_meeting_sip_uri_with_passcode*, update_meeting_status*, get_past_meeting_details, list_past_meeting_instances, get_past_meeting_participants, list_past_meetings_q, list_meetings, create_a_meeting*, list_upcoming_meetings

**Messages** (10): list_emails_from_mailbox, create_new_email*, batch_delete_specified_emails*, batch_modify_specified_emails*, send_out_email*, get_specified_email, delete_existing_email*, update_specified_email*, move_specified_email_to_trash_folder*, move_specified_email_out_of_trash_folder*

**Messages.Attachments** (1): get_specified_attachment_for_email

**My Notes Management** (2): list_my_notes, get_my_notes_content_and_transcript

**PAC** (1): list_user_s_pac_accounts

**Permissions** (4): list_channel_permissions, create_channel_permissions*, delete_channel_permissions*, update_channel_permissions*

**Phone Numbers** (2): assign_phone_number_to_user*, unassign_phone_number*

**Playlists** (7): list_channel_playlists, add_channel_playlists*, delete_channel_playlists*, list_playlists, create_playlist*, delete_playlist*, update_playlist*

**Polls** (7): perform_batch_poll_creation*, list_meeting_polls, create_meeting_poll*, get_meeting_poll, update_meeting_poll*, delete_meeting_poll*, list_past_meeting_s_poll_results

**Project** (13): list_projects, create_project*, get_project, delete_project*, update_project*, list_project_collaborators, add_project_collaborators*, update_project_collaborators*, delete_project_collaborator*, list_subprojects, create_subproject*, move_whiteboards_to_project*, remove_whiteboards_from_project*

**Recordings** (7): get_recording_by_call_element_id, download_phone_recording, download_phone_recording_transcript, delete_call_recording*, update_auto_delete_field*, update_recording_status*, get_user_s_recordings

**Registrants** (2): list_registrants, list_session_attendees

**Reports** (8): get_daily_usage_report, get_chat_transcripts_report, get_custom_report, get_event_attendance_live_or_lobby_report, get_session_attendance_report, get_event_survey_report, get_event_registrations_report, get_vod_channel_registration_report

**Roles** (8): list_roles, create_role*, get_role_information, delete_role*, update_role_information*, list_members_in_role, assign_role*, unassign_role*

**Routing Forms** (2): get_routing_response, list_account_routing_response

**scheduled events** (6): create_event_for_attendee*, list_scheduled_events, get_scheduled_events, delete_scheduled_events*, patch_scheduled_events*, get_scheduled_event_attendee

**ScheduleMeetings** (1): list_zra_scheduled

**schedules** (6): list_schedules, insert_schedules*, get_schedules, delete_schedules*, patch_schedules*, list_schedule_available_times

**scheduling links** (1): single_use_link*

**Search** (1): search_files

**Sessions** (15): list_sessions, create_session*, get_session_information, delete_session*, update_session*, list_session_interpreters, create_or_update_session_interpreters*, get_ticket_session_join_token_by_event_id_and_session_id*, get_session_livestream_configuration, update_session_livestream_configuration*, list_session_polls, create_or_update_session_polls*, list_session_reservations, add_session_reservations*, delete_session_reservations*

**Settings** (3): update_whiteboard_share_settings*, get_mailbox_vacation_response_setting, update_mailbox_vacation_response_setting*

**settings** (3): list_user_calendar_settings_of_authenticated_user, get_specified_user_calendar_settings_of_authenticated_user, patch_specified_user_calendar_settings_of_authenticated_user*

**Settings.Delegates** (4): list_delegates_on_mailbox, grant_new_delegate_access_on_mailbox*, get_specified_delegate_on_mailbox, revoke_existing_delegate_access_from_mailbox*

**Settings.Filters** (4): list_email_filters, create_email_filter*, get_specified_email_filter, delete_specified_email_filter*

**Shared folder** (5): list_shared_folders, create_shared_folder*, get_metadata_of_shared_folder, delete_shared_folder*, modify_metadata_of_shared_folder*

**Shared Spaces** (13): list_shared_spaces, create_shared_space*, get_shared_space, delete_shared_space*, update_shared_space_settings*, promote_shared_space_members_to_administrators*, demote_shared_space_administrators_to_members*, list_shared_space_channels, move_shared_space_channels*, list_shared_space_members, add_members_to_shared_space*, remove_members_from_shared_space*, transfer_shared_space_ownership*

**shares** (1): create_shares*

**Single** (7): get_clip, delete_clip_soft_delete*, update_clip_s_basic_info*, get_clip_chapters, create_clip_chapters*, duplicate_clips*, update_clips_share_setting*

**SMS** (7): post_sms_message*, get_account_s_sms_sessions, get_sms_session_details, get_sms_by_message_id, sync_sms_by_session_id, get_user_s_sms_sessions, list_user_s_sms_sessions_in_descending_order

**SMS Campaign** (1): list_user_s_opt_statuses_of_phone_numbers

**Speakers** (5): list_speakers, create_speaker*, get_speaker, delete_speaker*, update_speaker*

**Summaries** (3): get_a_meeting_summary, delete_meeting_or_webinar_summary*, list_user_s_meeting_or_webinar_summaries

**Surveys** (3): get_meeting_survey, delete_meeting_survey*, update_meeting_survey*

**Tasks** (5): list_tasks, create_new_task*, get_task_details, delete_task*, update_task_fields*

**team** (1): list_team

**Teams** (3): list_team_managers, list_team_members, list_account_teams

**Templates** (2): list_meeting_templates, create_meeting_template_from_existing_meeting*

**Threads** (6): list_email_threads_from_mailbox, get_specified_email_thread, delete_existing_email_thread*, update_specified_thread*, move_specified_thread_to_trash_folder*, move_specified_thread_out_of_trash_folder*

**Ticket Types** (8): list_registration_questions_for_event, update_registration_questions_for_event*, list_ticket_types, create_event_ticket_type*, delete_ticket_type*, update_ticket_type_for_event*, list_registration_questions_for_ticket_type, update_registration_questions_for_ticket_type*

**Tickets** (5): list_tickets, create_tickets*, get_ticket, delete_ticket*, update_ticket*

**TSP** (6): list_user_s_tsp_accounts, add_user_s_tsp_account*, set_global_dial_in_url_for_tsp_user*, get_user_s_tsp_account, delete_user_s_tsp_account*, update_tsp_account*

**Upload** (1): temporary_file_upload_api_for_clips*

**Users** (51): check_user_email, get_user_s_zak*, check_user_s_pm_room, get_user, delete_user*, update_user*, list_user_assistants, add_assistants*, delete_user_assistants*, delete_user_assistant*, list_users_collaboration_devices, get_collaboration_device_detail, update_user_s_email*, list_meeting_summary_templates, update_user_s_password*, get_user_permissions, upload_user_s_profile_picture*, get_user_presence_status, update_user_s_presence_status*, list_user_schedulers, delete_user_schedulers*, delete_scheduler*, list_users_settings, update_user_settings*, update_meeting_waiting_room_branding*, upload_virtual_background_files*, delete_virtual_background_files*, update_webinar_waiting_room_branding*, update_user_status*, get_user_s_token*, revoke_user_s_sso_token*, get_user_info, get_user_s_profile, update_user_s_profile*, add_user_call_forward_setting*, delete_user_call_forward_setting*, get_user_call_handling_setting, update_user_call_handling_setting*, update_user_s_calling_plan*, assign_calling_plan_to_user*, unassign_user_s_calling_plan*, list_users_phone_numbers_for_customized_outbound_caller_id, add_phone_numbers_for_users_customized_outbound_caller_id*, remove_users_customized_outbound_caller_id_phone_numbers*, add_user_s_profile_setting*, delete_user_s_profile_setting*, get_user_s_profile_settings, update_user_s_profile_settings*, add_user_s_shared_access_setting*, delete_user_s_shared_access_setting*, update_user_s_shared_access_setting*

**users** (1): users_get_user

**Video On-Demand** (9): list_channels, create_vod_channel*, get_vod_channel_details, delete_vod_channel*, update_vod_channel*, vod_channel_actions*, list_vod_channel_videos, add_vod_channel_videos*, delete_vod_channel_video*

**Video On-Demand Registrations** (4): get_vod_registration_questions, update_vod_channel_registration_questions*, list_vod_registration, vod_channel_registration*

**Videos** (11): get_metadata_for_specific_video, update_metadata_for_specific_video*, list_channel_videos, add_channel_videos*, delete_channel_videos*, list_playlist_videos, add_playlist_videos*, delete_playlist_videos*, list_videos, get_video_metadata, update_video_metadata*

**Visitor Management** (6): get_list_of_visitors_by_location, send_invitation*, invitation_details_by_invitation_id, delete_invitation*, update_invitation*, check_in_visitor*

**Voicemails** (6): get_voicemail_by_call_element_id, get_user_s_voicemails, download_phone_voicemail, get_voicemail_details, delete_voicemail*, update_voicemail_read_status*

**Webinars** (52): delete_live_webinar_message*, get_webinar_absentees, list_past_webinar_instances, list_webinar_participants, list_past_webinar_poll_results, list_q_as_of_past_webinar, list_webinar_templates, create_webinar_template*, list_webinars, create_webinar*, get_a_webinar, delete_webinar*, update_webinar*, add_batch_webinar_registrants*, get_webinar_s_session_branding, create_webinar_s_branding_name_tag*, delete_webinar_s_branding_name_tag*, update_webinar_s_branding_name_tag*, upload_webinar_s_branding_virtual_background*, delete_webinar_s_branding_virtual_backgrounds*, set_webinar_s_default_branding_virtual_background*, upload_webinar_s_branding_wallpaper*, delete_webinar_s_branding_wallpaper*, create_webinar_s_invite_links*, get_webinar_s_join_token_for_live_streaming*, get_webinar_s_join_token_for_local_recording*, get_live_stream_details, update_live_stream*, update_live_stream_status*, list_panelists, add_panelists*, remove_panelists*, remove_panelist*, list_webinar_s_polls, create_webinar_s_poll*, get_webinar_poll, update_webinar_poll*, delete_webinar_poll*, list_webinar_registrants, add_a_webinar_registrant*, webinar_registrants_questions_get, webinar_registrant_question_update*, webinar_registrant_status*, get_webinar_registrant, delete_webinar_registrant*, get_webinar_sip_uri_with_passcode*, update_webinar_status*, get_webinar_survey, delete_webinar_survey*, update_webinar_survey*, get_webinar_s_token*, get_webinar_tracking_sources

**WhatsApp Messages** (5): get_user_s_whats_app_sessions, send_whats_app_message*, get_account_s_whats_app_sessions, get_whats_app_session_details, get_whats_app_message_by_message_id

**Workspaces** (14): list_workspaces, list_workspace_additional_information_with_time_range, check_in_out_of_reservation*, add_or_update_workspace_floor_map*, get_workspace_location_floor_map, get_location_s_hot_desk_usage, delete_workspace_floor_map*, get_workspace, get_desk_assignment, get_workspace_s_reservations, create_reservation*, get_workspace_reservation_by_reservation_id, delete_reservation*, update_reservation*
