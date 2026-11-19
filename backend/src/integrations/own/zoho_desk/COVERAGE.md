# Zoho Desk coverage

Source: Zoho's own OpenAPI files (github.com/zoho/zohodesk-oas, v1.0, read 2026-11-19 by `bun scripts/openapi-actions.ts zoho_desk`). Every operation in them is an action: 1066 in all. Composio's zoho_desk toolkit (49 tools, no triggers) is matched name for name.

## Left out

| What | Why |
| --- | --- |
| getAllCountries, getAllLanguages, getAllTimeZones, getOrganizationFavicon, getOrganizationLogo, getIntegrationConfigParamsComputedOptions | Zoho marks them cookie-only: they work from Zoho's own pages, not with a sign-in |
| The five organizationFields calls | Deprecated by Zoho (the Field calls replace them) |

## Sign-in

Sign in with Zoho only (no key), through the shared Zoho client (`zohoOAuth`); the callback is `<API address>/oauth/zoho_desk/callback`. Tokens last an hour and are renewed. Each call goes to the login's own data centre's Desk host (desk.zoho.com, .eu, .in, .com.au, .jp, desk.zohocloud.ca …).

Scopes: every operation's scope from Zoho's files, as the .ALL scope wherever Zoho lists one:
`Desk.tickets.ALL,Desk.contacts.ALL,Desk.accounts.ALL,Desk.tasks.ALL,Desk.events.ALL,Desk.calls.ALL,Desk.activities.tasks.ALL,Desk.activities.events.ALL,Desk.activities.calls.ALL,Desk.agents.ALL,Desk.departments.ALL,Desk.teams.READ,Desk.teams.CREATE,Desk.teams.UPDATE,Desk.teams.DELETE,Desk.basic.ALL,Desk.search.READ,Desk.articles.ALL,Desk.products.ALL,Desk.contracts.ALL,Desk.custommodule.ALL,Desk.modules.ALL,Desk.fields.ALL,Desk.layouts.ALL,Desk.templates.ALL,Desk.automations.ALL,Desk.settings.ALL,Desk.webhooks.ALL,Desk.channels.email.ALL,Desk.channels.helpcenter.ALL,Desk.community.ALL,Desk.forums.ALL,Desk.InstantMessages.ALL,Desk.integrations.ALL,Desk.organization.READ,Desk.organization.UPDATE,Desk.permissions.READ,Desk.permissions.CREATE,Desk.permissions.UPDATE,Desk.permissions.DELETE,Desk.featuresettings.READ,Desk.featuresettings.UPDATE,Desk.sandbox.READ,Desk.sandbox.CREATE,Desk.sandbox.UPDATE,Desk.imports.CUSTOM,Desk.exports.CUSTOM`

Not asked for, because Zoho's files name them on a few calls but Zoho's own scope list doesn't, and one unknown scope would make Zoho refuse the whole sign-in: Desk.qaautomation.*, Desk.recyclebin.*, Desk.privacysettings.READ, Desk.sandbox.deploy.CUSTOM, Desk.automation.CREATE. The recycle bin, subject access request and rule group calls also accept Desk.settings.*, which is asked for. These four may answer with a scope error until checked live: get_dependent_child_field_values (Desk.qaautomation.READ), create_im_channel and update_channel_logo (Desk.qaautomation.*), deploy_sandbox_changesets (Desk.sandbox.deploy).

Every call but list_organizations needs `orgId`, sent as a header: left out, the login's only organisation is used; with several, the error lists them. The list is cached for 10 minutes per login. `check` labels the connection with the organisation name(s).

## Hand adjustments

- Zoho's files point into each other (`./Common.json#/...`); they are joined into one spec, with each component named after its file.
- `orgId` goes in a header (Desk's docs), not the query as the files say; and it is added to the dozen calls the files forgot it on (dashboard counts, logos, portal users).
- Request bodies given by reference are read in place.
- list_contracts' sortBy also takes the descending values (`-createdTime`) its own description allows.
- Names follow Composio's for the same 49 calls (list_tickets, list_ticket_threads, search, upload_ticket_attachment …).
- download_ticket_attachment is written by hand: Desk has the call, Zoho's files leave it out. Files come back as files.
- POSTs that only read run unasked (validate_transition_field_updates, preview_article, validate_permalink, get_import_mappings, get_session_last_messages and three subject access counts). get_jwt_secret_key asks first: it shows a secret.
- A dead login (401 except scope errors) marks the connection expired.

## Triggers

**Webhooks** (own/zoho_desk/triggers.ts): all 56 events Desk's webhooks offer, named after them (Ticket_Add → ticket_added, Ticket_Thread_Add → ticket_thread_added, IM_Session_Status → im_session_status_changed). One webhook per connection and organisation, made by API when the first automation needs it, extended with each new event, removed with the last. Needs a Zoho Desk administrator's login. Desk signs nothing on API-made webhooks, so the address carries a 16-character token worked out from the connection and organisation; Desk caps the address at 100 characters. Change events ask Desk for the previous state, so `field` can filter on what changed. Filters on every trigger: org_id, department_id; ticket events also ticket_id; ticket_thread_added also direction (in = from the customer, so Emplio's own replies don't start it again).

**Polled** (polls/zoho_desk.ts), for what has no event: ticket_overdue (due within the last week and past, not closed; the due date is in the id), product_added, contract_added. Newest 100 each check.

Not tried live: sign-in, the webhook's handshake and delivery format (array of eventType, orgId, eventTime, payload, prevState, from Desk's docs), and the four calls above.

## Actions by group (* asks first)

**Account** (15): associate_products_with_account*, create_account*, delete_accounts*, get_account, get_account_history, get_account_statistics, get_contracts, list_accounts, list_accounts_associated_with_product, list_accounts_count, list_contact_accounts, list_tickets_by_account, merge_accounts*, update_account*, update_many_accounts*

**AccountAttachment** (3): create_account_attachment*, delete_account_attachment*, get_account_attachments

**AccountComments** (5): create_account_comment*, delete_account_comment*, get_account_comment, get_account_comments, update_account_comment*

**AccountContactMappingInfo** (1): update_account_contact_mapping*

**AccountDeduplication** (4): get_default_field_name, get_duplicate_account_details, get_duplicate_accounts, set_default_field*

**AccountFollowers** (3): add_account_followers*, get_account_followers, remove_account_followers*

**AccountSla** (2): associate_or_dissociate_sla_from_account*, list_account_slas

**AccountTimeEntry** (2): get_summation_of_account_time_entries, list_account_time_entries

**Activity** (3): delete_spam_activities*, list_activities, list_ticket_activities

**ActorsAPI** (2): get_actor, get_actors

**Agent** (25): activate_agents*, anonymize_deleted_agent*, create_agent*, deactivate_agent*, delete_confirmed_agent*, delete_my_photo*, delete_unconfirmed_agents*, get_agent, get_agent_by_email_id, get_agent_by_zuid, get_agent_photo, get_agent_types_counts, get_agents_by_agent_ids, get_agents_count, get_deleted_agents, get_my_entity_preferences, get_my_information, get_my_preferences, list_agents, reinvite_unconfirmed_agents*, schedule_agent_reassignment*, update_agent*, update_my_entity_preferences*, update_my_preferences*, upload_my_photo*

**AgentPresence** (5): get_agent_availability_configuration, get_current_availability, get_offline_agents, get_online_agents, update_agent_availability_configuration*

**AgentSignatures** (3): get_agent_signatures, update_agent_signature*, update_customized_signatures_of_agent*

**AgentTimeEntry** (3): get_agent_time_entry, get_summation_of_agent_time_entries, list_agent_time_entries

**Article** (19): create_article*, get_article, get_article_count, get_article_count_by_category_ids, get_article_history, get_article_insights, get_suggested_articles_for_ticket, get_tags_associated_with_articles, import_file_from_cloud*, list_articles, migrate_external_images_to_kb_gallery*, move_articles_to_trash*, preview_article, restart_article_auto_translation*, share_docs_workspace*, stop_article_auto_translation*, update_article*, update_articles*, validate_permalink

**ArticleAttachment** (7): attach_files_to_article_translation*, get_article_translation_attachments, get_docs_resources_info, remove_file_attachments_from_article_translation*, upload_and_associate_attachments*, upload_and_attach_file_to_article_translation*, upload_article_attachments*

**ArticleComment** (10): approve_article_translation_comments*, convert_article_translation_comment_to_ticket*, create_article_translation_comment*, delete_article_translation_comment*, get_article_translation_comment, get_article_translation_comments, get_moderated_kb_comment_count, get_moderated_kb_comments, move_kb_comments_to_recycle_bin*, update_article_translation_comment*

**ArticleFeedback** (10): convert_article_feedback_to_ticket*, convert_feedback_comment_into_ticket*, create_article_feedback*, delete_article_feedback*, delete_feedback_comment*, get_article_feedback_comments, get_article_translation_feedback_comments, get_details_of_feedback_comment, patch_convert_solutions_feedback_to_ticket*, update_article_feedback*

**ArticleFeedbackResolution** (1): add_article_feedback_resolution*

**ArticleStatistics** (13): generate_top_articles_report*, get_article_interacted_users, get_article_translation_action_counts, get_article_translation_interacted_users, get_article_translation_interacted_users_by_action_source, get_article_translation_interacted_users_count, get_article_trend, get_kb_article_statistics, get_keyword_metrics, get_knowledge_base_trend, get_top_article_translations, reset_metrics_of_article_translation*, reset_metrics_of_article_translations*

**ArticleTranslation** (31): add_translation*, clone_article_translation*, delete_article_translation_redirection_permalink*, discard_article_translation_draft*, dislike_article_translation*, download_article_translation_attachment, extract_translation_external_image_urls, generate_article_translation_version_difference, get_article_translation, get_article_translation_answer, get_article_translation_by_permalink, get_article_translation_by_translation_id, get_article_translation_count, get_article_translation_history, get_article_translation_insights, get_concurrent_edit_status, get_multiple_article_translations, get_permalinks_of_translation, get_translations_of_article, like_article_translation*, migrate_translation_external_images_to_kb_gallery*, restore_article_translation_version*, search_tags, search_translations, trash_article_translation*, undo_article_translation_vote*, update_article_translation*, update_article_translation_permalink*, update_article_translation_permalinks*, update_article_translations*, update_published_version_of_translation*

**ArticleVersion** (1): get_article_translation_versions

**ArticleViews** (2): get_article_view_display_preference, update_article_view_display_preference*

**AutomationFeatureCount** (1): get_automation_feature_count

**Backup** (3): download_bulk_export_file, get_bulk_export, initiate_bulk_export*

**Badge** (22): add_badge*, add_badges_to_user*, associate_users_to_badge*, associate_users_to_credit*, create_credit*, delete_badge*, delete_credit*, dissociate_users_from_badge*, dissociate_users_from_credit*, get_game_achievements, get_game_badge_status, list_available_badge_icons, list_badges, list_credits, list_custom_badge_reports, list_custom_credit_reports, list_user_badges, list_users_of_badge, list_users_of_credit, remove_badges_from_user*, update_badge*, update_credit*

**Blueprint** (3): get_blueprint_criteria_fields, get_configurable_blueprint_fields, validate_transition_field_updates

**blueprintDrafts** (3): create_draft_blueprint*, publish_draft_blueprint*, update_draft_blueprint*

**blueprints** (11): check_blueprint_applied_for_entity, create_blueprint*, delete_blueprint*, get_applied_blueprint_details_of_ticket_for_user, get_blueprint_details, list_blueprints_in_department, reorder_blueprints*, revoke_blueprint_from_blueprint_level*, revoke_blueprint_from_multiple_tickets*, revoke_blueprint_from_ticket*, update_blueprint*

**blueprintTransitions** (4): delete_attachment_of_transition_draft*, get_transition_form_details, perform_blueprint_transition_on_ticket*, view_specific_attachment_added_to_transition_draft

**BugInteg** (3): create_and_link_bug_to_ticket*, get_bug_details_for_ticket, get_linked_tickets_by_bug_id

**BusinessHour** (6): create_business_hours_set*, delete_business_hours_set*, get_associated_automation_rules, get_business_hours_set, get_business_hours_sets, update_business_hours_set*

**Call** (10): clear_live_call_mapping_from_activity*, create_call*, delete_calls*, delete_spam_calls*, empty_spam_calls*, get_call, list_calls, list_calls_by_ticket, update_call*, update_many_calls*

**CallAttachment** (3): create_call_attachment*, delete_call_attachment*, get_call_attachments

**CallComments** (6): create_call_comment*, delete_call_comment*, get_call_comment, list_call_comments, partially_update_call_comment*, update_call_comment*

**CallTimer** (2): get_call_timer, perform_call_timer_action*

**Channel** (4): get_channel_by_code, get_channel_logo, list_configured_channels, update_channel_logo*

**Community** (6): get_community_topic_comment_attachment, get_reply_attachment, get_topic_attachment, get_topic_voters_trend, lock_topic*, move_topic_to_recycle_bin*

**CommunityAttachment** (2): get_unassociated_attachment, upload_attachment*

**CommunityCategory** (18): create_community_category_or_forum*, delete_category_or_forum_permalink*, delete_community_category_or_forum*, disable_category_or_forum*, enable_category_or_forum*, follow_category_or_forum*, get_categories, get_category_or_forum, get_category_or_forum_by_permalink, get_category_or_forum_followers, get_category_or_forum_permalinks, get_enabled_community_categories, lock_category_or_forum*, sort_categories*, sort_forums*, unfollow_category_or_forum*, update_category_or_forum*, update_category_or_forum_permalink*

**CommunityCategoryLogo** (2): get_category_logo, upload_category_logo*

**CommunityComment** (17): approve_comments*, create_comment*, create_reply*, get_comment, get_comments, get_comments_by_user, get_comments_count, get_comments_pending_moderation, move_comment_to_recycle_bin*, move_reply_to_recycle_bin*, move_unmoderated_comments_to_recycle_bin*, permanently_delete_topic_comments*, report_comment_as_spam*, report_comments_as_spam*, restore_comments*, update_comment*, update_reply*

**CommunityPreferences** (3): get_community_preferences, get_moderation_stats, set_community_preferences*

**CommunityTopic** (42): add_topic_as_ticket*, approve_topics*, associate_tags_to_topic*, create_tickets_for_topics*, create_topic*, create_topic_draft*, delete_topic_draft*, delete_topics_from_recycle_bin*, dissociate_tags_from_topic*, follow_topic*, get_moderated_topics, get_ticket_associated_with_topic, get_topic, get_topic_by_permalink, get_topic_drafts, get_topic_followers, get_topic_participants, get_topic_types, get_topic_voters, get_topics, get_topics_by_user, get_topics_count, get_topics_pending_moderation, like_topic*, moderate_topic*, move_topic*, move_unmoderated_topics_to_recycle_bin*, publish_topic_draft*, report_topic_as_spam*, report_topics_as_spam*, restore_topics*, search_community_tags, search_topics, unfollow_topic*, unlike_topic*, unlock_topic*, unmoderate_topic*, unmoderate_topics*, update_topic*, update_topic_draft*, update_topic_type_preferences*, update_topics*

**CommunityTopicTypes** (1): disable_topic_type*

**CommunityUser** (7): follow_user*, get_moderated_users, get_user, get_user_followers, unfollow_user*, unmoderate_users*, update_user_status*

**Contact** (27): approve_contact_for_help_center*, associate_accounts_with_contact*, associate_products_with_contact*, create_contact*, delete_contact_photo*, delete_contacts*, delete_spam_contacts*, dissociate_account_from_contact*, dissociate_accounts_from_contact*, get_contact, get_contact_history, get_contact_statistics, get_contacts_by_ids, get_contacts_count, get_portal_user_photo, get_status_of_contact_in_help_centers, invite_contact_to_help_center*, invite_multiple_contacts_to_help_center*, list_associated_contacts, list_contacts, list_contacts_associated_with_product, mark_contact_as_spam*, merge_contacts*, reject_contact_for_help_center*, update_contact*, update_many_contacts*, update_tickets_account_for_contact*

**ContactAttachment** (3): create_contact_attachment*, delete_contact_attachment*, get_contact_attachments

**ContactComments** (5): create_contact_comment*, delete_contact_comment*, get_contact_comment, get_contact_comments, update_contact_comment*

**ContactDeduplication** (4): get_default_deduplication_field_name, get_duplicate_contact_details, get_duplicate_contact_groups, update_default_deduplication_field*

**ContactFollowers** (3): add_contact_followers*, get_contact_followers, remove_contact_followers*

**ContactProfile** (1): get_contact_profiles

**Contacts** (1): get_associated_accounts_count_for_contact

**ContactTimeEntry** (2): get_summation_of_contact_time_entries, list_contact_time_entries

**Contract** (7): create_contract*, get_contract, get_contracts_count, list_contracts, update_contract*, update_contract_contracts*, update_contracts*

**ContractComments** (7): create_contract_comment*, delete_contract_comment*, download_contract_comment_attachment_content, get_contract_comment, get_contract_comments, patch_contract_comment*, update_contract_comment*

**CustomerHappiness** (2): get_customer_feedback_placeholder_link, get_customer_happiness_setup

**CustomTheme** (8): apply_or_draft_custom_theme*, delete_custom_theme*, get_custom_theme, get_custom_theme_tabs, get_custom_themes, get_theme_default_content, publish_draft_custom_theme*, update_custom_theme*

**CustomView** (3): get_last_accessed_view, list_views, update_last_accessed_view*

**DashboardMetrics** (8): get_closed_tickets_count, get_created_tickets_count, get_on_hold_tickets_count, get_reopened_tickets_count, get_resolution_times, get_response_times, get_total_response_count, get_unresolved_tickets_count

**Department** (17): associate_agents_to_department*, check_for_duplicate_departments, create_department*, delete_department_logo*, disable_department*, dissociate_agents_from_department*, enable_department*, get_agents_in_department, get_associable_agents_in_department, get_department, get_department_logo, get_departments_by_ids, get_departments_count, get_my_departments, list_departments, update_department*, upload_department_logo*

**DependencyMappings** (8): create_dependency_mapping*, delete_dependency_mapping*, get_dependency_mapping, get_dependency_mappings_count_for_layout, get_dependent_child_field_values, get_possible_dependency_mappings_in_layout, list_dependency_mappings_in_layout, update_dependency_mapping*

**DirectAssignmentRules** (12): create_direct_assignment_rule*, create_direct_assignment_rule_target*, get_direct_assignment_rule, get_direct_assignment_rule_criteria_fields, get_direct_assignment_rules, get_direct_assignment_rules_execution_status, patch_direct_assignment_rule*, patch_direct_assignment_rule_target*, reorder_direct_assignment_rules*, update_direct_assignment_rule*, update_direct_assignment_rule_target*, update_direct_assignment_rules_execution_status*

**DirectAssignRuleTarget** (1): get_direct_assignment_rule_target

**DisplayEntity** (1): auto_display_entity*

**DomainMapping** (7): add_domain*, apply_domain*, delete_unused_domain*, get_domain, get_domains, reset_domain*, verify_domain*

**EmailFailureAlert** (2): clear_email_delivery_failure_alerts*, list_email_delivery_failure_alerts

**EmailTemplates** (9): clone_template_attachments*, create_template*, delete_template*, get_placeholders, get_template, get_templates, patch_template*, render_template*, update_template*

**EntityBlueprints** (2): delete_during_actions_transition_draft*, save_during_actions_transition_draft*

**Event** (9): create_event*, delete_events*, delete_spam_events*, empty_spam_events*, get_event, list_events, list_events_by_ticket, update_event*, update_many_events*

**EventAttachment** (4): create_event_attachment*, delete_event_attachment*, download_event_attachment, get_event_attachments

**EventComments** (5): create_event_comment*, delete_event_comment*, get_event_comment, list_event_comments, update_event_comment*

**EventTimer** (2): get_event_timer, perform_event_timer_action*

**FederatedLogin** (3): delete_federated_login_configuration*, get_federated_login_configuration, update_federated_login_configuration*

**Field** (5): create_field*, delete_field*, get_field, get_fields, update_field*

**FieldOld** (1): get_custom_field_count

**FieldPermissions** (2): get_field_permissions, update_field_permissions*

**Finance** (6): get_estimates, get_invoices, get_tickets_for_invoice, mark_invoices_as_sent*, update_estimate_status*, update_invoice_status*

**Followers** (5): follow_entity*, get_entity_followers, get_entity_followers_count, get_my_followed_entities, un_follow_entity*

**GenericAction** (1): execute_action*

**Help_Center_MFAPolicy** (3): add_mfa_policy*, delete_mfa_policy*, get_mfa_policy

**Help_Center_OIDC_Authentication** (5): create_oidc_authentication*, delete_oidc_authentication*, get_oidc_authentication, get_oidc_metadata, update_oidc_authentication*

**Helpcenter** (6): delete_help_center_sitemaps*, download_help_center_sitemaps, generate_help_center_sitemaps*, get_help_center, get_help_center_sitemaps, get_help_centers

**HelpCenterApp** (6): create_help_center_app*, delete_help_center_app*, get_employee_self_service_app_details, get_help_center_app, retrieves_list_of_asaps_employee_self_service_apps_and_feedback_widgets_with_pagination_support, update_help_center_app*

**HelpcenterGroups** (8): add_users_to_group*, create_user_groups*, delete_helpcenter_user_group*, get_details_of_group, list_helpcenter_groups, list_users_in_group, remove_users_from_group*, update_group*

**HelpCenterPages** (3): get_help_center_page, get_help_center_pages, update_help_center_page*

**HelpcenterUpload** (1): upload_image*

**HolidayList** (4): create_holiday_list*, get_holiday_list, get_holiday_lists, update_holiday_list*

**IM_AddOn** (2): get_add_on_package_details, get_im_payment_statement

**IM_Bot** (2): get_im_bot, get_im_bots

**IM_Channel** (3): create_im_channel*, get_channel, get_channels

**IM_Integration** (9): add_or_update_whats_app_sandbox_testers*, get_template_credit_exhaust_status, get_whats_app_integration_details, get_whats_app_sandbox_testers, list_whats_app_phone_numbers, list_whats_app_template_supported_languages, list_whats_app_template_tag_categories, request_whats_app_phone_number_otp, submit_whats_app_phone_number_otp*

**IM_IntegrationService** (2): get_integration_service_by_id, list_available_im_integration_services

**IM_Message** (10): add_outgoing_message*, get_attachment_content, get_message_full_content, get_session_attachments, get_session_last_messages, get_session_message, get_session_messages, initiate_session*, send_attachment_message*, start_facebook_messenger_session*

**IM_Metrics** (2): get_agents_metrics, get_session_time_series_metrics

**IM_Search** (1): search_im_messages

**IM_Session** (5): get_session, get_session_metrics, get_session_tickets, list_sessions, update_session*

**IM_TimeSeriesMetrics** (3): get_conversation_time_series_metrics, get_message_time_series_metrics, get_payment_time_series_metrics

**IMCannedMessage** (3): apply_template_message*, get_im_template_message, get_im_template_messages

**Import** (3): create_import*, get_import, get_import_mappings

**JiraInteg** (1): get_linked_tickets

**JWT** (5): create_jwt_configuration*, delete_jwt_configuration*, get_jwt_configuration, get_jwt_secret_key*, update_jwt_configuration*

**KbCategory** (2): get_articles_for_manual_sorting, update_article_position*

**KBCategory** (1): delete_category*

**KbCategoryLogo** (1): upload_kb_logo_image*

**KBRecycleBin** (10): delete_trashed_article_translations*, delete_trashed_kb_comments*, get_trashed_article_translations, get_trashed_article_translations_count, get_trashed_kb_categories, get_trashed_kb_categories_count, get_trashed_kb_comments, get_trashed_kb_comments_count, restore_trashed_article_translations*, restore_trashed_kb_comments*

**KBRootCategory** (14): add_moderators*, add_review_owner*, create_root_category*, create_root_category_permalink*, delete_root_category_permalink*, get_category_tree, get_category_tree_by_permalink, get_kb_root_categories_sections_count, get_review_owners, get_root_category, list_root_categories, remove_moderators*, remove_review_owner*, reorder_root_categories*

**KBRootCategoryTranslation** (1): delete_root_category_translation*

**KBSection** (10): create_kb_section*, create_section_permalink*, create_section_under_root_category*, create_section_under_section*, delete_section_permalink*, delete_section_translation*, get_kb_section, reorder_sections*, update_kb_section*, update_section_permalinks*

**Label** (9): assign_label_to_users*, create_label*, delete_label*, delete_labels*, get_details_of_label, list_labels, list_users_under_label, remove_users_under_label*, update_label*

**Layout** (17): activate_layout*, associate_profiles_to_layout*, clone_fields_to_other_layouts*, clone_layout*, create_layout*, deactivate_layout*, delete_layout*, export_pick_list_values, get_layout, get_layout_profiles, get_layouts, get_my_form, get_standard_layout_format, remove_field_from_layout*, replace_picklist_value*, update_layout*, update_layout_field*

**LayoutRuleCriteria** (1): get_criteria_fields_for_layout_rules

**LayoutRules** (5): create_layout_rule*, delete_layout_rule*, get_layout_rule, get_layout_rules, update_layout_rule*

**Level** (4): create_level*, delete_level*, list_levels, update_level*

**License** (2): get_license_feature_details, get_license_plan_details

**MailConfigurations** (6): list_department_mail_configurations, list_organization_mail_configurations, update_department_mail_configurations*, update_mail_configurations*, update_mail_configurations_for_org*, update_organization_mail_configurations*

**MailReplyAddress** (6): add_new_from_address*, delete_from_address*, fetch_single_from_address, list_from_addresses, send_verification_mail*, update_existing_from_address*

**Module** (6): create_module*, get_module, get_modules, get_modules_accessible_to_current_user_profile, get_modules_organizationModules, update_module*

**NewTicketHistory** (1): list_ticket_history

**Organization** (9): delete_organization_favicon*, delete_organization_logo*, get_accessible_organizations, get_organization, list_organizations, update_default_organization*, update_organization*, update_organization_favicon*, update_organization_logo*

**Organization Usage Stats** (1): get_organization_usage_stats

**OrganizationFields** (1): get_organization_custom_fields_criteria_references

**PendingApproval** (1): get_my_pending_approvals

**Permalink** (3): check_topic_permalink_availability, get_topic_permalinks, update_topic_permalinks*

**PinnedConversation** (3): create_pin_on_ticket*, get_pins_of_ticket, unpin_ticket_s_pin*

**PortalUser** (1): update_portal_user_details*

**Product** (10): associate_accounts_with_product*, associate_contacts_with_product*, create_product*, delete_products*, get_product, get_products, list_products_by_account, list_products_by_contact, search_duplicate_products, update_product*

**ProductAttachment** (3): create_product_attachment*, delete_product_attachment*, list_product_attachments

**Profile** (10): clone_profile*, delete_profile*, get_agents_by_profile, get_light_agent_profile, get_my_profile_details, get_my_profile_permissions, get_profile, get_profile_count, get_profiles, update_profile*

**RecentItem** (2): list_recent_items, mark_recent_item*

**Records** (8): create_record*, delete_record*, get_record, get_record_count, get_records, move_records_to_recycle_bin*, update_field_in_multiple_records*, update_record*

**Recyclebin** (5): delete_all_entities*, delete_resources_from_recycle_bin*, list_deleted_resources, restore_deleted_resources*, restore_resources_from_recycle_bin*

**Role** (9): create_role*, delete_role*, get_agents_by_role, get_personal_role, get_role, get_role_count, list_roles, list_roles_by_ids, update_role*

**RoundRobin** (12): create_round_robin_rule*, create_round_robin_rule_target*, get_round_robin_rule, get_round_robin_rule_criteria_fields, get_round_robin_rules, get_round_robin_rules_execution_status, patch_round_robin_rule*, patch_round_robin_rule_target*, reorder_round_robin_rules*, update_round_robin_rule*, update_round_robin_rule_target*, update_round_robin_rules_execution_status*

**RoundRobinTarget** (2): get_round_robin_rule_target, reorder_round_robin_rule_targets*

**RoutingPreference** (2): get_routing_preferences, update_routing_preferences*

**RuleGroup** (4): create_rule_group*, get_rule_groups, update_rule_group*, update_rule_group_status*

**RuleGroupExecutionLog** (2): get_execution_log, get_execution_logs

**Saml** (6): create_saml_configuration*, delete_saml_configuration*, disable_saml_user_registration*, enable_saml_user_registration*, get_saml_configuration, get_saml_configuration_metadata

**Sandbox** (5): create_sandbox*, get_sandbox, get_sandboxes, rebuild_sandbox*, update_sandbox*

**SandboxChangeset** (2): get_sandbox_changeset_count, get_sandbox_changesets

**SandboxDeployment** (2): deploy_sandbox_changesets*, validate_sandbox_changesets

**SandboxDeploymentLogs** (1): get_sandbox_deployment_logs

**Search** (12): search, search_accounts, search_activities, search_articles, search_calls, search_contacts, search_events, search_products, search_records, search_solutions, search_tasks, search_tickets

**SharingRule** (2): get_data_sharing_rules, update_data_sharing_rules*

**Skill** (12): create_skill*, delete_skill*, execute_skill_based_ticket_assignment*, get_criteria_fields_for_skill_in_department, get_skill, get_skills, get_skills_of_agent, list_associated_automation_rules, map_skills_in_department_with_agent*, recalculate_ticket_skills*, reorder_skills_in_department*, update_skill*

**SkillConfiguration** (2): get_skill_configuration, update_skill_configuration*

**SkillType** (5): create_skill_type*, delete_skill_type*, get_skill_type, get_skill_types, update_skill_type*

**SLA** (12): create_sla*, create_sla_target*, delete_sla*, delete_sla_target*, get_sla, get_sla_criteria_fields, get_sla_escalation_status, get_slas, reorder_slas*, update_sla*, update_sla_escalation_status*, update_sla_target*

**StarredView** (4): add_star_view*, get_starred_views, remove_star_view*, reorder_starred_views*

**SubjectAccessRequest** (9): erase_specific_resources*, erase_subject_data_from_zoho_desk*, export_specific_resources*, export_subject_data_from_zoho_desk*, get_count_of_resources_related_to_request, get_fields_and_conditions, get_subject_access_request, list_subject_access_request_entities, list_subject_access_requests

**SupportEmailDomain** (2): get_support_email_address_domain, update_support_email_address_domain*

**SupportPlan** (5): create_support_plan*, delete_support_plan*, get_support_plan, get_support_plans, update_support_plan*

**Task** (10): create_task*, delete_spam_tasks*, delete_tasks*, empty_spam_tasks*, get_task, list_tasks, list_tasks_count, list_ticket_tasks, update_many_tasks*, update_task*

**TaskAttachment** (4): create_task_attachment*, delete_task_attachment*, list_task_attachments, view_task_attachment

**TaskComments** (5): create_task_comment*, delete_task_comment*, get_task_comment, list_task_comments, update_task_comment*

**TaskTimeEntry** (6): add_task_time_entry*, delete_task_time_entry*, get_summation_of_task_time_entries, get_task_time_entry, list_task_time_entries, update_task_time_entry*

**TaskTimer** (3): get_task_timer, get_task_timers, perform_task_timer_action*

**Team** (10): create_team*, delete_team*, get_associable_teams, get_team, get_team_members, get_teams_for_role, get_teams_from_associated_departments, get_teams_of_agent, list_teams_in_department, update_team*

**TemplateFolders** (6): create_template_folder*, delete_template_folder*, get_template_folder, get_template_folders, patch_template_folder*, update_template_folder*

**Theme** (2): get_themes, upload_theme_image*

**Thread** (15): create_ticket_email_reply_draft*, delete_attachment*, delete_draft*, download_thread_attachment, get_full_thread_content, get_original_mail_content, get_ticket_latest_thread, get_ticket_thread, list_ticket_conversations, list_ticket_threads, resend_failed_thread*, send_draft*, send_email_reply*, send_for_review*, update_draft*

**Ticket** (28): close_tickets*, create_ticket*, delete_all_spam_tickets*, delete_spam_tickets*, delete_ticket_resolution*, delete_tickets*, download_ticket_attachment, get_agent_followed_tickets, get_agents_tickets_count, get_archived_tickets, get_ticket, get_ticket_metrics, get_ticket_resolution, get_ticket_resolution_history, list_contact_tickets, list_ticket_queue_view_count, list_tickets, list_tickets_by_products, map_articles_to_tickets*, mark_ticket_as_read*, mark_ticket_as_unread*, mark_tickets_as_spam*, merge_tickets*, move_ticket*, split_tickets*, update_field_in_multiple_tickets*, update_ticket*, update_ticket_resolution*

**TicketApprovals** (4): create_approval*, get_approval, list_approvals, update_approval*

**TicketAttachment** (4): delete_ticket_attachment*, list_ticket_attachments, update_ticket_attachment*, upload_ticket_attachment*

**TicketComment** (6): add_ticket_comment*, delete_ticket_comment*, get_ticket_comment, get_ticket_comment_history, list_ticket_comments, update_ticket_comment*

**TicketCount** (2): get_ticket_count_by_field, get_tickets_count

**TicketFollowers** (3): add_ticket_followers*, get_ticket_followers, remove_ticket_followers*

**TicketTag** (12): associate_ticket_tags*, delete_tag*, dissociate_tag*, get_recent_tags, get_tags_in_ticket, get_ticket_count_by_tag, get_tickets_by_tag, list_ticket_tags, rename_tag*, replace_tag*, search_tags_search, update_recent_tags*

**TicketTemplate** (5): create_ticket_template*, delete_ticket_template*, get_ticket_template, list_ticket_templates, update_ticket_template*

**TicketTimeEntry** (7): add_ticket_time_entry*, delete_ticket_time_entry*, get_summation_of_ticket_time_entries, get_ticket_time_entries_by_billing_type, get_ticket_time_entry, list_ticket_time_entries, update_ticket_time_entry*

**TicketTimer** (5): get_active_timer_for_agent, get_active_timers, get_ticket_timer, get_ticket_timers, perform_ticket_timer_actions*

**TimeTracking** (4): create_time_tracking_settings*, get_time_tracking_settings, get_time_tracking_settings_billing_history, update_time_tracking_settings*

**Upload** (1): upload_file*

**User** (12): assign_labels_to_user*, associate_groups_to_users*, delete_end_user*, delete_groups_from_users*, get_user_details, get_user_groups, get_user_labels, get_users, remove_labels_from_user*, remove_portal_user*, reset_mfa_for_portal_user*, update_user_details*

**UserAuthentication** (2): get_user_authentication_types, update_user_authentication_status*

**UserPresence** (4): get_availability_status_of_agents_in_different_channels, get_channel_online_preferences_of_current_agent, update_overall_availability_of_agents_across_channels*, update_overall_preference_of_agent_in_available_channels*

**ValidationRuleCriteria** (1): get_validation_rule_criteria

**ValidationRules** (5): create_validation_rule*, delete_validation_rule*, get_layout_validation_rule, get_layout_validation_rules_for_department_or_layout, update_layout_validation_rule*

**Webhook** (5): create_webhook*, delete_webhook*, get_webhook, get_webhooks, update_webhook*

**Widget** (11): create_widget*, create_widget_translation*, delete_widget_translation*, get_custom_theme_widgets, get_widget, get_widget_translation, get_widget_translations, get_widget_translations_by_language, get_widgets, update_widget*, update_widget_translation*
