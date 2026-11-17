# Cloudflare coverage

Source: Cloudflare's OpenAPI spec (https://github.com/cloudflare/api-schemas, openapi.json, 3778 operations), generated 2026-11-16 by
`bun scripts/openapi-actions.ts cloudflare`. Composio's Cloudflare toolkit has 149 tools and no triggers; n8n's Cloudflare node only
manages zone certificates. Every operation a normal account's token can call is an action (2565 generated + 7 by hand = 2572);
Composio's names are kept wherever it has the same call (144 of 149, the rest below). Re-run the script when Cloudflare adds
endpoints; it fails if an override in it no longer matches an operation.

actions.json is 4.7 MB: unions of a dozen object shapes (Access apps, identity providers, DNS records) are
merged into one object with every field, which cut it from 6 MB.

## Deliberately left out

| What | Operations |
| --- | --- |
| Cloudforce One threat intelligence: enterprise subscription only | 301 |
| Deprecated | 293 |
| Magic WAN / Transit / Network Monitoring and Network Interconnect: enterprise contract only | 176 |
| Email Security (Area 1): enterprise contract only | 75 |
| Cloudflare Workload Security: private enterprise beta | 54 |
| BYOIP, address maps and regional services: enterprise only | 46 |
| Data security posture (CASB findings): enterprise Zero Trust add-on | 42 |
| Brand Protection: enterprise contract only | 39 |
| Organizations and cross-account resource sharing: enterprise organizations only | 39 |
| Secondary DNS: enterprise only | 28 |
| SCIM: an identity provider pushes users here; not something a person calls | 24 |
| Custom indicator feeds and sinkholes: enterprise threat intel only | 22 |
| Internal Workers platform (K2) endpoints, not public | 14 |
| Registrar sandbox: registrar partner testing only | 10 |
| DNS Firewall: enterprise only | 9 |
| Account custom nameservers: enterprise / partner only | 8 |
| Data Localization Suite: enterprise only | 7 |
| Keyless SSL: enterprise only | 5 |
| Takes the short-lived upload JWT a deployment session hands out, not the account token (Wrangler's direct upload) | 4 |
| Cloudflare-internal service endpoints | 4 |
| Domain Connect: for DNS providers' templates, not account owners | 4 |
| Tenants: Cloudflare partner (reseller) program only | 2 |
| Pay-per-use usage report upload (JSONL body): for crawl-monetization partners, beta | 1 |

| Composio tool | Why not |
| --- | --- |
| list_firewall_rules | Firewall Rules API is deprecated and switched off; WAF custom rules live in rulesets (get_zone_ruleset_phase_entrypoint / update_zone_ruleset_phase_entrypoint with phase http_request_firewall_custom) |
| upload_worker_assets, deploy_worker_with_assets, upload_pages_assets | Static-asset direct upload takes a short-lived upload JWT and content hashes per file (what Wrangler does). Not built yet: deploy a Worker with deploy_worker_script (its modules as files), a Pages site from Git (create_pages_project with source, or Workers Builds), or create_pages_deployment. **Gap worth a hand-written `deploy_site_files` next.** |
| inventory_developer_resources | A Composio convenience; list_workers, list_kv_namespaces, list_r2_buckets, list_d1_databases, list_queues and list_pages_projects give the same |

## Hand adjustments (scripts/openapi/cloudflare.ts, own/cloudflare/index.ts)

- Names: Composio's where it has the call (renames listed in the script); otherwise the operation's summary, or Cloudflare's SDK name (`dns_records_edit`) when several operations share a summary.
- POSTs that only look things up run without asking: analytics and log queries, browser rendering (screenshot, markdown, PDF, scrape…), registrar availability checks, KV bulk reads, Vectorize queries, AI Search, validators and previews.
- GETs that hand back a credential ask first: tunnel and mesh-node tokens, the Pages upload token, Turnstile widget details (its secret), Images signing keys, workflow subscription tokens.
- By hand (bodies the generator can't send): query_graphql_analytics (the GraphQL Analytics API, not in the spec), query_analytics_sql (Analytics Engine), query_account_logs_sql / query_zone_logs_sql (Log Explorer), update_zaraz_workflow, insert_vectors* / upsert_vectors* (NDJSON).
- Errors: Cloudflare's `{"errors":[{code,message}]}` is said plainly; code 1000/6111/6103 (bad token) asks to reconnect, 10000/9109 says the token lacks that permission.

## Auth

| Method | Status |
| --- | --- |
| API token (dash.cloudflare.com/profile/api-tokens), user- or account-owned, sent as Bearer | done; `check` verifies at /user/tokens/verify, falls back to listing accounts for account-owned tokens |
| OAuth (dash.cloudflare.com/oauth2, self-managed clients, open since June 2026) | built; needs our OAuth client registered (CLOUDFLARE_CLIENT_ID, CLOUDFLARE_CLIENT_SECRET, CLOUDFLARE_OAUTH_SCOPES), made public (needs domain verification of emplio.app). Tokens expire; refreshed with offline_access, revoked on disconnect |

## Triggers

**Webhook** (Cloudflare Notifications, all plans): one per Cloudflare alert type, named as Cloudflare names it (`pages_event_alert`,
`universal_ssl_event_type`, `health_check_status_notification`, `dos_attack_l7`, `billing_usage_alert`, `tunnel_health_event`…), read from
the spec into events.json; enterprise-product alerts (Magic, Brand Protection, Cloudforce One, Secondary DNS…) left out. Settings:
`account_id` and Cloudflare's own `filters`. One webhook destination per account and connection
(`/webhooks/app/cloudflare/<connection>/<account>`, secret in `cf-webhook-auth`, an HMAC of ENCRYPTION_KEY, never stored), one policy
per alert type and filters named `Emplio: <type> [hash]`; removed with the last automation.

**Polled** (polls/cloudflare.ts): new_zone, zone_status_changed, new_dns_record, dns_record_changed, pages_deployment_finished,
worker_deployed, ssl_certificate_expiring, domain_expiring, new_audit_log_entry. A deleted DNS record isn't seen (only new_audit_log_entry with resource_product dns_records catches it).

## Actions by product (* asks first)

**accounts** (5): list_accounts, create_account*, delete_specific_account*, get_account, update_account*

**accounts/abuse-reports** (10): list_abuse_reports_against_account, abuse_reports_list_submitted, abuse_reports_get_submitted, list_emails_sent_to_abuse_report_submitter, check_whether_report_can_be_appealed, list_abuse_report_emails, list_abuse_report_mitigations, request_review_on_mitigations*, get_abuse_report_against_account, abuse_reports_create*

**accounts/access** (130): per_portal_mcp_tool_call_timeseries, per_server_mcp_tool_call_timeseries, account_global_mcp_tool_call_timeseries, list_mcp_portals, create_new_mcp_portal*, delete_mcp_portal*, read_details_of_mcp_portal, update_mcp_portal*, resolve_mcp_server_oauth_redirect_uri, list_mcp_servers, create_new_mcp_server*, delete_mcp_server*, get_mcp_server, update_mcp_server*, sync_mcp_server_capabilities*, list_access_applications, create_access_application*, zero_trust_access_applications_short_lived_certificates_list, delete_access_application*, get_access_application, update_access_application*, zero_trust_access_applications_short_lived_certificates_delete*, zero_trust_access_applications_short_lived_certificates_get, zero_trust_access_applications_short_lived_certificates_create*, list_access_application_policies, create_access_application_policy*, delete_access_application_policy*, get_access_application_policy, update_access_application_policy*, convert_access_application_policy_to_reusable_policy*, zero_trust_access_applications_revoke_tokens*, zero_trust_access_applications_settings_edit*, zero_trust_access_applications_settings_update*, zero_trust_access_applications_user_policy_checks_list, list_authenticator_device_aaguids, zero_trust_access_mtls_certificates_list, zero_trust_access_mtls_certificates_create*, zero_trust_access_mtls_certificates_settings_get, zero_trust_access_mtls_certificates_settings_update*, zero_trust_access_mtls_certificates_delete*, zero_trust_access_mtls_certificates_get, zero_trust_access_mtls_certificates_update*, zero_trust_access_custom_pages_list, create_custom_page*, validate_custom_page_template, delete_custom_page*, zero_trust_access_custom_pages_get, zero_trust_access_custom_pages_update*, list_ssh_certificate_authorities_ca, add_new_ssh_certificate_authority_ca*, delete_ssh_certificate_authority_ca*, zero_trust_access_rule_groups_list, zero_trust_access_rule_groups_create*, zero_trust_access_rule_groups_delete*, zero_trust_access_rule_groups_get, zero_trust_access_rule_groups_update*, zero_trust_identity_providers_list, zero_trust_identity_providers_create*, zero_trust_identity_providers_delete*, zero_trust_identity_providers_get, zero_trust_identity_providers_update*, create_saml_encryption_certificate_for_identity_provider*, list_id_p_federation_grants, create_id_p_federation_grant*, delete_id_p_federation_grant*, get_id_p_federation_grant, get_access_key_configuration, update_access_key_configuration*, rotate_access_keys*, get_access_authentication_logs, list_access_jit_request_logs, get_access_jit_request_log, get_zero_trust_organization, partially_update_zero_trust_organization*, zero_trust_organization_create*, zero_trust_organization_update*, get_zero_trust_organization_do_h_settings, update_zero_trust_organization_do_h_settings*, zero_trust_access_users_revoke*, delete_zero_trust_organization_trust_settings*, get_zero_trust_organization_trust_settings, update_zero_trust_organization_trust_settings*, replace_zero_trust_organization_trust_settings*, list_access_reusable_policies, create_access_reusable_policy*, delete_access_reusable_policy*, get_access_reusable_policy, update_access_reusable_policy*, start_access_policy_test*, get_current_status_of_given_access_policy_test, get_access_policy_test_users_page, list_saml_certificate_sets, get_saml_certificate_set, download_current_certificate_in_pem_format, rotate_saml_certificate*, update_user_seat*, zero_trust_access_service_tokens_list, zero_trust_access_service_tokens_create*, zero_trust_access_service_tokens_delete*, zero_trust_access_service_tokens_get, zero_trust_access_service_tokens_update*, refresh_service_token*, rotate_service_token*, zero_trust_access_tags_list, zero_trust_access_tags_create*, zero_trust_access_tags_delete*, zero_trust_access_tags_get, zero_trust_access_tags_update*, list_user_populations, create_user_population*, delete_user_population*, get_user_population, update_user_population*, list_users_in_user_population, create_user_population_user*, delete_user_population_user*, get_user_population_user, update_user_population_user*, replace_user_population_user*, get_users, create_user*, delete_user*, get_user, update_user*, get_active_sessions, get_single_active_session, get_failed_logins, get_last_seen_identity, delete_user_authenticator*, delete_user_passkey*

**accounts/agent-memory** (14): agent_memory_list_namespaces, agent_memory_create_namespace*, agent_memory_delete_namespace*, agent_memory_get_namespace, list_profiles, delete_profile*, ingest_messages*, list_memories, delete_memory*, get_memory, recall_memories*, remember_memory*, delete_session*, get_profile_summary*

**accounts/ai** (15): author_search, list_finetunes, create_new_finetune*, list_public_finetunes, delete_finetune*, upload_finetune_asset*, download_finetune_asset, get_workers_ai_model_schema, model_search, run_ai_model_with_request_options*, run_workers_ai_model*, task_search, convert_uploaded_files_to_markdown*, list_supported_markdown_conversion_formats, search_web_through_ai_gateway*

**accounts/ai-gateway** (67): get_credit_balance, get_invoice_history, get_invoice_preview, delete_spending_limit_deprecated*, get_spending_limit_deprecated, create_top_up*, delete_auto_top_up_configuration*, get_auto_top_up_configuration, set_auto_top_up_configuration*, get_top_up_eligibility, get_account_top_up_limits, check_top_up_status, get_usage_history, list_custom_providers, create_custom_provider*, list_custom_provider_pricing_rules, create_custom_provider_pricing_rule*, delete_custom_provider_pricing_rule*, get_custom_provider_pricing_rule, update_custom_provider_pricing_rule*, delete_custom_provider*, get_custom_provider, update_custom_provider*, list_evaluator_types_deprecated, list_gateways, create_gateway*, list_custom_domains, create_custom_domain_for_gateway*, delete_custom_domain*, get_custom_domain, list_datasets_deprecated, create_dataset_deprecated*, delete_dataset_deprecated*, get_dataset_deprecated, update_dataset_deprecated*, list_evaluations_deprecated, create_evaluation_deprecated*, delete_evaluation_deprecated*, get_evaluation_deprecated, delete_gateway_logs*, list_gateway_logs, get_gateway_log_detail, patch_gateway_log*, get_gateway_log_request, get_gateway_log_response, list_provider_keys, store_provider_key*, delete_provider_key*, get_provider_key, rotate_provider_key*, check_stored_provider_credentials, list_dynamic_routes, create_dynamic_route*, delete_dynamic_route*, get_dynamic_route, rename_dynamic_route*, list_dynamic_route_deployments, deploy_dynamic_route_version*, list_dynamic_route_versions, create_dynamic_route_version*, get_dynamic_route_version, get_gateway_url, delete_gateway*, get_gateway, update_gateway*, get_ai_gateway_logging_state, migrate_ai_gateway_logging_to_workers_observability*

**accounts/ai-search** (36): ai_search_namespace_list, ai_search_namespace_create*, ai_search_list, ai_search_create*, ai_search_delete*, ai_search_get, move_instance_to_different_namespace*, ai_search_update*, ai_search_chat_completions*, items_list, upload_item*, create_or_update_item*, delete_item*, get_item, sync_item*, list_item_chunks, download_item_content, item_logs, ai_search_jobs_list, ai_search_jobs_create*, ai_search_jobs_get, ai_search_jobs_cancel*, ai_search_jobs_logs, purge_search_cache*, ai_search_search, ai_search_stats, ai_search_namespace_delete*, ai_search_namespace_get, update_namespace*, multi_instance_chat_completions*, multi_instance_search, ai_search_tokens_list, ai_search_tokens_create*, delete_token*, get_token, update_token*

**accounts/alerting** (25): get_alert_types, get_delivery_mechanism_eligibility, delete_pager_duty_services*, list_pager_duty_services, create_pager_duty_integration_token*, connect_pager_duty, list_webhooks, create_webhook*, alerting_destinations_webhooks_delete*, get_webhook, update_webhook*, list_history, list_notification_policies, create_alert_policy*, delete_notification_policy*, get_notification_policy, update_notification_policy*, show_email_unsubscribe_details, unsubscribe_email_from_notification_policy*, test_notification_policy*, list_silences, create_silences*, update_silences*, delete_silence*, get_silence

**accounts/analytics** (9): top_integrations_by_content_findings*, analytics_query_data_security_findings_summary*, analytics_query_data_security_findings_timeseries*, query_analytics_summary, query_analytics_timeseries, query_analytics_top_n, analytics_sql_accounts_get, analytics_sql_accounts_post, analytics_sql_accounts_introspection_get

**accounts/analytics_engine** (1): execute_analytics_engine_sql_query_via_query_parameter

**accounts/argo** (1): get_count_of_zones_with_argo_smart_routing_enabled_for_account

**accounts/artifacts** (19): artifacts_namespaces_list, artifacts_namespaces_create*, artifacts_namespaces_delete*, artifacts_namespaces_get, artifacts_namespaces_repos_list, create_repository*, delete_repository*, get_repository, read_git_blob, read_git_commit, read_file, fork_repository*, import_repository*, read_commit_history, read_raw_file_with_content_type, list_repository_tokens, read_git_tree, create_repository_token*, artifacts_namespaces_tokens_revoke*

**accounts/audit_logs** (1): get_account_audit_logs

**accounts/autorag** (7): ai_search, files, autorag_jobs_list, autorag_jobs_get, autorag_jobs_logs, autorag_search, sync*

**accounts/basin-catalog** (16): list_basin_catalogs, get_basin_catalog_details, basin_catalog_credentials_create*, get_basin_catalog_credential_status, delete_basin_catalog_metadata*, disable_basin_catalog*, basin_catalog_enable*, basin_catalog_maintenance_configs_get, basin_catalog_maintenance_configs_update*, basin_catalog_namespaces_list, basin_catalog_namespaces_tables_list, basin_catalog_namespaces_tables_get, basin_catalog_namespaces_tables_maintenance_configs_get, basin_catalog_namespaces_tables_maintenance_configs_update*, basin_catalog_namespaces_tables_maintenance_configs_queue*, basin_catalog_namespaces_tables_maintenance_runs_list

**accounts/billable** (3): get_account_usage_version_2_alpha_restricted, query_account_usage_version_2_alpha_restricted, list_account_billable_metrics_version_2_alpha_restricted

**accounts/billable-usage** (2): get_account_billable_usage_version_1_alpha, get_account_billable_usage_info_version_1_alpha

**accounts/billing** (18): get_account_bad_debt, get_account_credits, get_account_billing_history, delete_billing_profile*, get_billing_profile, update_billing_email*, create_billing_profile*, update_billing_profile*, create_payment_intent_for_billing_profile*, list_spend_policies, create_spend_policy*, list_spend_policy_activity, delete_spend_policy*, get_spend_policy, update_spend_policy*, list_spend_policy_audit_entries, get_unpaid_invoices, get_account_billing_usage

**accounts/botnet_feed** (4): get_daily_report, get_full_report, get_list_of_asns, delete_asn*

**accounts/browser-extension** (8): delete_browser_extension_configuration*, get_browser_extension_configuration, create_browser_extension_configuration*, update_browser_extension_configuration*, list_browser_extension_inventories, get_single_browser_extension_inventory, search_browser_extension_event_logs, query_browser_extension_event_timeseries

**accounts/browser-rendering** (29): get_accessibility_tree_page, get_html_content, crawl_websites*, cancel_crawl_job*, get_crawl_result, get_browser_session_id*, close_browser_session*, browser_run_devtools_json_get, activate_browser_target, close_browser_target, browser_run_devtools_browser_targets_list, get_target_by_id, open_new_browser_tab*, get_chrome_dev_tools_protocol_schema, get_browser_version_metadata, mint_live_view_urls_for_browser_session*, list_sessions, get_session_details, get_json, get_links, get_markdown, get_pdf, get_recording_data, get_network_recording_data, scrape_page_elements, get_screenshot, dynamic_script_execute_code_and_return_browser_session_details*, dynamic_script_execute_code_in_existing_browser_session*, capture_browser_snapshot

**accounts/builds** (40): get_account_build_limits, get_builds_by_worker_version, get_latest_builds_by_script_ids, get_workers_build, cancel_workers_build*, get_workers_build_logs, create_or_update_repository_connection*, delete_repository_connection*, get_repository_configuration_autofill, list_workers_build_tokens, builds_tokens_create*, builds_tokens_delete*, create_worker_build_trigger*, delete_build_trigger*, update_worker_build_trigger*, start_workers_build*, list_build_variables, set_build_variables*, delete_build_variable*, purge_trigger_build_cache*, create_worker_build_configuration*, list_worker_builds, start_worker_build*, list_worker_build_triggers, builds_deploy_hooks_list, builds_deploy_hooks_create*, builds_deploy_hooks_delete*, builds_deploy_hooks_get, builds_deploy_hooks_update*, delete_worker_build_configuration*, get_worker_build_configuration, update_worker_build_configuration*, builds_retry*, builds_workers_migrate_to_previews*, list_previews, get_preview, update_preview*, builds_previews_list_builds, builds_previews_create_build*, purge_worker_build_cache*

**accounts/bulk** (1): create_subscriptions*

**accounts/calls** (10): realtime_sfu_apps_list, create_sfu_app*, delete_sfu_app*, retrieve_sfu_app_details, update_sfu_app_details*, list_turn_keys, create_turn_key*, delete_turn_key*, retrieve_turn_key_details, update_turn_key_details*

**accounts/cfd_tunnel** (13): list_cloudflare_tunnels, create_cloudflare_tunnel*, delete_cloudflare_tunnel*, get_cloudflare_tunnel, update_cloudflare_tunnel*, reset_tunnel_configuration*, get_tunnel_configuration, update_tunnel_configuration*, clean_up_cloudflare_tunnel_connections*, list_cloudflare_tunnel_connections, get_cloudflare_tunnel_connector, get_cloudflare_tunnel_management_token*, get_cloudflare_tunnel_token*

**accounts/challenges** (6): list_turnstile_widgets, create_turnstile_widget*, delete_turnstile_widget*, turnstile_widget_details*, update_turnstile_widget*, rotate_secret_for_turnstile_widget*

**accounts/client-secret** (1): create_setup_intent*

**accounts/connectivity** (5): list_workers_vpc_connectivity_services, create_workers_vpc_connectivity_service*, delete_workers_vpc_connectivity_service*, get_workers_vpc_connectivity_service, update_workers_vpc_connectivity_service*

**accounts/containers** (15): list_applications_associated_with_account, create_new_application*, delete_single_application_by_id*, get_single_application_by_id, containers_applications_edit*, list_container_instances, containers_applications_instances_get, create_new_rollout_for_application*, containers_applications_versions_list, containers_images_prepare*, get_list_of_configured_registries_in_account, configure_private_external_image_registry*, delete_registry_from_account*, generate_jwt_to_interact_with_specified_image_registry*, get_live_account_usage

**accounts/custom_csrs** (4): custom_csrs_list, custom_csrs_create*, custom_csrs_delete*, custom_csrs_get

**accounts/custom_pages** (9): custom_pages_account_custom_pages_list, custom_pages_account_assets_list, custom_pages_account_assets_create*, custom_pages_account_assets_delete*, custom_pages_account_assets_get, custom_pages_account_assets_update*, custom_pages_account_custom_pages_preview_tokens_create*, custom_pages_account_custom_pages_get, custom_pages_account_custom_pages_update*

**accounts/d1** (15): list_d1_databases, create_d1_database*, delete_d1_database*, get_d1_database, update_d1_database_partially*, update_d1_database*, export_d1_database_as_sql*, import_sql_into_d1_database*, execute_d1_query*, raw_d1_database_query*, get_d1_database_bookmark, restore_d1_database_to_bookmark_or_point_in_time*, undelete_d1_database*, list_d1_databases_by_usage, list_top_d1_queries

**accounts/devices** (65): zero_trust_devices_client_versions_list, list_available_target_environments, zero_trust_devices_deployment_groups_list, zero_trust_devices_deployment_groups_create*, zero_trust_devices_deployment_groups_delete*, zero_trust_devices_deployment_groups_get, zero_trust_devices_deployment_groups_update*, zero_trust_devices_ip_profiles_list, zero_trust_devices_ip_profiles_create*, zero_trust_devices_ip_profiles_delete*, zero_trust_devices_ip_profiles_get, zero_trust_devices_ip_profiles_update*, list_device_managed_networks, create_device_managed_network*, delete_device_managed_network*, get_device_managed_network_details, update_device_managed_network*, generate_uninstall_protection_override_code*, zero_trust_devices_list, zero_trust_devices_delete*, zero_trust_devices_get, update_device*, list_device_settings_profiles, get_default_device_settings_profile, update_default_device_settings_profile*, create_device_settings_profile*, zero_trust_devices_profiles_default_excludes_delete*, get_split_tunnel_exclude_list, set_split_tunnel_exclude_list*, zero_trust_devices_profiles_default_fallback_domains_delete*, get_local_domain_fallback_list, set_local_domain_fallback_list*, get_split_tunnel_include_list, set_split_tunnel_include_list*, delete_device_settings_profile*, get_device_settings_profile_by_id, update_device_settings_profile*, zero_trust_devices_profiles_custom_excludes_delete*, get_split_tunnel_exclude_list_for_device_settings_profile, set_split_tunnel_exclude_list_for_device_settings_profile*, zero_trust_devices_profiles_custom_fallback_domains_delete*, get_local_domain_fallback_list_for_device_settings_profile, set_local_domain_fallback_list_for_device_settings_profile*, get_split_tunnel_include_list_for_device_settings_profile, set_split_tunnel_include_list_for_device_settings_profile*, list_posture_rules, create_posture_rule*, list_posture_integrations, create_posture_integration*, delete_posture_integration*, get_posture_integration, update_posture_integration*, delete_posture_rule*, get_posture_rule, update_posture_rule*, zero_trust_devices_registrations_bulk_delete*, zero_trust_devices_registrations_list, zero_trust_devices_registrations_delete*, zero_trust_devices_registrations_get, get_override_codes, get_global_disconnect, set_global_disconnect*, reset_device_settings*, get_device_settings, update_device_settings*

**accounts/dex** (34): list_cloudflare_colos, list_account_commands, create_account_commands*, list_devices_eligible_for_remote_captures, returns_account_commands_usage_quota_and_reset_time, download_command_output_file, list_device_dex_tests, create_device_dex_test*, delete_device_dex_test*, get_device_dex_test, update_device_dex_test*, get_latest_status_of_device, get_status_over_time_for_device, list_device_isps, list_details_of_devices_using_warp, get_live_aggregate_device_details_by_dimension, get_over_time_aggregate_details_for_devices_by_dimension, get_details_and_aggregate_metrics_for_http_test, get_percentiles_for_http_test, list_notification_history, create_notification*, list_notification_outcomes, zero_trust_dex_rules_list, zero_trust_dex_rules_create*, zero_trust_dex_rules_delete*, zero_trust_dex_rules_get, zero_trust_dex_rules_update*, list_dex_test_analytics, get_count_of_devices_targeted, get_details_for_specific_traceroute_test_run, get_details_and_aggregate_metrics_for_traceroute_test, get_network_path_breakdown_for_traceroute_test, get_percentiles_for_traceroute_test, zero_trust_dex_warp_change_events_list

**accounts/diagnostics** (6): list_endpoint_health_checks, endpoint_health_check*, delete_endpoint_health_check*, get_endpoint_health_check, update_endpoint_health_check*, traceroute*

**accounts/dlp** (106): list_custom_prompt_topics, create_custom_prompt_topic*, delete_custom_prompt_topic*, get_custom_prompt_topic, update_custom_prompt_topic*, retrieve_data_classes_in_account, creates_new_data_class*, delete_single_data_class*, retrieve_specific_data_class, update_attributes_of_single_data_class*, retrieve_data_tag_categories_in_account, creates_new_data_tag_category*, delete_single_data_tag_category*, retrieve_specific_data_tag_category, update_attributes_of_single_data_tag_category*, retrieve_data_tags_in_data_tag_category, creates_new_data_tag*, delete_single_data_tag*, retrieve_specific_data_tag, update_attributes_of_single_data_tag*, retrieve_data_tag_category_templates_in_account, retrieve_specific_data_tag_category_template, fetch_datasets, create_new_dataset*, zero_trust_dlp_datasets_delete*, fetch_specific_dataset, update_details_about_dataset*, prepare_to_upload_new_version_of_dataset*, upload_new_version_of_dataset*, sets_column_information_for_multi_column_upload*, upload_new_version_of_multi_column_dataset*, retrieve_data_about_document_fingerprints, creates_new_document_fingerprint*, delete_single_document_fingerprint*, retrieve_data_about_specific_document_fingerprint, update_attributes_of_single_document_fingerprint*, uploads_new_version_for_document_fingerprint*, get_mapping, create_mapping*, list_email_scanner_rules, update_email_scanner_rule_priorities*, create_email_scanner_rule*, delete_email_scanner_rule*, get_email_scanner_rule, update_email_scanner_rule*, list_entries, create_custom_entry*, update_custom_entry*, create_integration_entry*, delete_integration_entry*, update_integration_entry*, create_predefined_entry*, delete_predefined_entry*, update_predefined_entry*, delete_custom_entry*, get_dlp_entry, update_entry*, fetch_limits_associated_with_dlp_for_account, validate_dlp_regex_pattern, zero_trust_dlp_profiles_list, list_custom_profiles, create_custom_profile*, delete_custom_profile*, get_custom_profile, update_custom_profile*, delete_integration_profile*, list_integration_profile_references, zero_trust_dlp_profiles_predefined_create*, delete_predefined_profile*, get_predefined_profile, update_predefined_profile*, get_predefined_profile_config, zero_trust_dlp_profiles_predefined_config_create*, update_predefined_profile_config*, get_dlp_profile, retrieve_sensitivity_groups_in_account, creates_new_sensitivity_group*, retrieve_sensitivity_group_templates_in_account, retrieve_specific_sensitivity_group_template, delete_single_sensitivity_group*, retrieve_specific_sensitivity_group, update_attributes_of_single_sensitivity_group*, retrieve_ordered_list_of_level_ids_for_sensitivity_group, set_ordering_of_levels_within_sensitivity_group*, retrieve_sensitivity_levels_in_sensitivity_group, creates_new_sensitivity_level*, delete_single_sensitivity_level*, retrieve_specific_sensitivity_level, update_attributes_of_single_sensitivity_level*, delete_reset_dlp_account_level_settings_to_initial_values*, get_dlp_account_level_settings, partially_update_dlp_account_level_settings*, update_dlp_account_level_settings_full_replacement*, list_validators, list_proximity_word_validators, create_proximity_word_validator*, delete_proximity_word_validator*, get_proximity_word_validator, update_proximity_word_validator*, list_worker_validators, create_worker_validator*, delete_worker_validator*, get_worker_validator, update_worker_validator*, get_worker_validator_status, get_validator

**accounts/dns_records** (1): get_dns_record_usage_for_account

**accounts/dns_settings** (12): dns_settings_account_get, dns_settings_account_edit*, list_custom_nameserver_sets, create_custom_nameserver_set*, delete_custom_nameserver_set*, get_custom_nameserver_set, update_custom_nameserver_set*, list_internal_dns_views, create_internal_dns_view*, delete_internal_dns_view*, dns_internal_view_details, update_internal_dns_view*

**accounts/email** (24): list_email_domain_changes, list_email_domains, create_email_domain*, delete_email_domain*, get_email_domain, verify_email_domain*, list_email_routing_addresses, create_email_routing_address*, delete_destination_address*, get_destination_address, update_destination_address*, list_account_routing_rules, plan_account_routing_rule_changes*, get_sending_limits, fetch_email_message, get_account_reputation, send_email*, send_raw_mime_email*, list_account_email_sending_suppressions, create_account_email_sending_suppression*, bulk_import_account_email_sending_suppressions*, delete_account_email_sending_suppression*, get_account_email_sending_suppression, update_account_email_sending_suppression*

**accounts/entitlements** (1): get_account_entitlements

**accounts/event_notifications** (4): list_event_notification_rules, delete_event_notification_rules*, get_event_notification_rules_for_queue, create_event_notification_rules*

**accounts/event_subscriptions** (5): list_event_subscriptions, create_event_subscription*, delete_event_subscription*, get_event_subscription, update_event_subscription*

**accounts/field_extractors** (3): field_extractors_delete*, field_extractors_get, field_extractors_update*

**accounts/firewall** (8): firewall_access_rules_list, firewall_access_rules_create*, firewall_access_rules_delete*, firewall_access_rules_get, firewall_access_rules_edit*, firewall_payload_logging_delete*, firewall_payload_logging_get, firewall_payload_logging_update*

**accounts/flagship** (15): flagship_apps_list, create_app*, delete_app*, get_app, update_app*, get_flag_definitions, evaluate_flag_from_query_context, evaluate_flag_with_json_context*, list_flags, create_flag*, delete_flag*, get_flag, partially_update_flag*, update_flag*, list_flag_changelog_entries

**accounts/gateway** (56): get_zero_trust_account_information, create_zero_trust_account*, list_application_and_application_type_mappings, list_applications_review_statuses, update_applications_review_statuses*, get_zero_trust_ssh_settings, update_zero_trust_ssh_settings*, rotate_zero_trust_ssh_account_seed*, list_categories, list_zero_trust_certificates, create_zero_trust_certificate*, delete_zero_trust_certificate*, get_zero_trust_certificate_details, activate_zero_trust_certificate*, deactivate_zero_trust_certificate*, get_zero_trust_account_configuration, patch_zero_trust_account_configuration*, update_zero_trust_account_configuration*, list_zero_trust_gateway_dns_destination_ipv4_address_pairs, get_gateway_egress_cidrs_pairs_assigned_to_this_account, list_zero_trust_lists, create_zero_trust_list*, create_zero_trust_list_from_csv*, delete_zero_trust_list*, get_zero_trust_list_details, patch_zero_trust_list*, update_zero_trust_list*, get_zero_trust_list_items, list_zero_trust_gateway_locations, create_zero_trust_gateway_location*, delete_zero_trust_gateway_location*, get_zero_trust_gateway_location_details, update_zero_trust_gateway_location*, get_logging_settings_for_zero_trust_account, update_zero_trust_account_logging_settings*, list_zero_trust_gateway_operations, zero_trust_gateway_operation_details, list_pac_files, create_pac_file*, delete_pac_file*, get_pac_file, update_zero_trust_gateway_pac_file*, list_proxy_endpoints, create_proxy_endpoint*, delete_proxy_endpoint*, get_proxy_endpoint, update_proxy_endpoint*, list_zero_trust_gateway_rules, patch_multiple_zero_trust_gateway_rules*, create_zero_trust_gateway_rule*, list_zero_trust_gateway_rules_inherited_from_parent_account, delete_zero_trust_gateway_rule*, get_zero_trust_gateway_rule_details, patch_zero_trust_gateway_rule*, update_zero_trust_gateway_rule*, reset_expiration_of_zero_trust_gateway_rule*

**accounts/hyperdrive** (8): list_hyperdrives, hyperdrive_create*, hyperdrive_delete*, hyperdrive_get, update_hyperdrive*, replace_hyperdrive*, hyperdrive_restart*, create_database_signature*

**accounts/iam** (17): list_account_permission_groups, permission_group_details, list_resource_groups, create_resource_group*, remove_resource_group*, resource_group_details, update_resource_group*, list_user_groups, create_user_group*, remove_user_group*, user_group_details, update_user_group*, list_user_group_members, add_user_group_members*, update_user_group_members*, remove_user_group_member*, get_user_group_member

**accounts/images** (32): upload_image*, list_signing_keys*, delete_signing_key*, create_new_signing_key*, images_usage_statistics, list_variants, create_variant*, delete_variant*, variant_details, update_variant*, delete_image*, image_details, update_image*, download_image, list_images_v2, create_authenticated_direct_upload_url_v2*, list_image_metadata_keys, list_sourcing_kit_migrations, create_sourcing_kit_migration*, delete_sourcing_kit_migration*, get_sourcing_kit_migration, get_migration_progress, abort_migration*, start_migration*, list_migration_logs, list_sourcing_kit_sources, create_sourcing_kit_source*, precheck_source_connectivity*, delete_sourcing_kit_source*, get_sourcing_kit_source, update_sourcing_kit_source*, get_source_connectivity_status

**accounts/infrastructure** (8): zero_trust_access_targets_list, create_new_target*, create_new_targets*, delete_targets*, replace_tags_on_existing_targets*, delete_target*, get_target, update_target*

**accounts/intel** (12): get_asn_overview, get_asn_subnets, retrieves_security_center_issues_types, get_passive_dns_by_ip, get_domain_details, get_domain_history, get_multiple_domain_details, get_ip_overview, get_available_ip_lists, create_miscategorization*, get_url_intelligence, get_whois_record

**accounts/invoices** (1): toggle_pdf_invoices*

**accounts/load_balancers** (36): list_account_load_balancers, create_account_load_balancer*, list_monitor_groups, create_monitor_group*, delete_monitor_group*, monitor_group_details, patch_monitor_group*, update_monitor_group*, list_monitor_group_references, list_monitors, load_balancers_monitors_create*, load_balancers_monitors_delete*, load_balancers_monitors_get, load_balancers_monitors_edit*, load_balancers_monitors_update*, load_balancers_monitors_previews_create*, load_balancers_monitors_references_list, list_pools, load_balancers_pools_bulk_edit*, load_balancers_pools_create*, load_balancers_pools_delete*, load_balancers_pools_get, load_balancers_pools_edit*, load_balancers_pools_update*, load_balancers_pools_health_get, load_balancers_pools_health_create*, load_balancers_pools_references_list, load_balancers_previews_get, load_balancers_regions_list, get_region, search_resources, list_load_balancer_usage, delete_account_load_balancer*, account_load_balancer_details, patch_account_load_balancer*, update_account_load_balancer*

**accounts/logpush** (20): logpush_account_datasets_fields_get, logpush_account_datasets_jobs_get, logpush_account_jobs_list, logpush_account_jobs_create*, logpush_account_jobs_delete*, logpush_account_jobs_get, logpush_account_jobs_update*, logpush_account_ownership_create*, logpush_account_ownership_validate_create*, list_transformers, create_transformer*, preview_transformer, delete_transformer*, get_transformer, update_transformer*, get_transformer_content, list_transformer_versions, logpush_account_validate_destination_delete*, logpush_account_validate_destination_exists_delete*, logpush_account_validate_origin_create*

**accounts/logs** (14): get_account_audit_logs_version_2, list_account_audit_log_product_categories_version_2, get_resource_change_history_from_account_audit_log_entry_version_2, delete_cmb_config*, get_cmb_config, update_cmb_config*, list_account_datasets, create_account_dataset*, list_available_account_datasets, delete_account_dataset*, get_account_dataset, update_account_dataset*, list_log_files, retrieve_logs

**accounts/managed-defense** (9): managed_defense_vulnerability_discovery_repositories_list, managed_defense_vulnerability_discovery_repositories_create*, managed_defense_vulnerability_discovery_repositories_get, managed_defense_vulnerability_discovery_reports_get, create_upload_token*, managed_defense_vulnerability_discovery_scans_list, managed_defense_vulnerability_discovery_scans_create*, managed_defense_vulnerability_discovery_scans_get, managed_defense_vulnerability_discovery_scans_get_report

**accounts/media** (1): get_account_media_usage

**accounts/members** (5): list_account_members, add_member*, remove_member*, get_account_member, update_member*

**accounts/monetization** (2): get_account_monetization_eligibility, check_account_monetization_eligibility*

**accounts/moq** (8): list_relays, create_relay*, delete_relay*, get_relay, update_relay*, realtime_moq_relays_tokens_list, realtime_moq_relays_tokens_create*, realtime_moq_relays_tokens_delete*

**accounts/move** (1): move_account_to_organization*

**accounts/mtls_certificates** (5): ssl_mtls_certificates_list, upload_m_tls_certificate*, ssl_mtls_certificates_delete*, ssl_mtls_certificates_get, list_m_tls_certificate_associations

**accounts/oauth_clients** (7): list_oauth_clients, create_oauth_client*, delete_oauth_client*, oauth_client_details, update_oauth_client*, delete_rotated_oauth_client_secret*, rotate_oauth_client_secret*

**accounts/observability** (1): get_usage_limit_status

**accounts/one** (11): zero_trust_casb_applications_list, get_application_details, get_auth_methods, get_application_setup_flows, list_integrations, create_integration*, delete_integration*, get_integration_details, update_integration*, pause_integration*, resume_integration*

**accounts/pages** (23): list_pages_projects, create_pages_project*, delete_cloudflare_pages_project*, get_pages_project, update_pages_project*, list_pages_deployments, create_pages_deployment*, delete_pages_deployment*, get_pages_deployment, get_pages_deployment_logs, retry_pages_deployment*, rollback_pages_deployment*, create_deployment_tail*, delete_deployment_tail*, list_pages_project_domains, add_pages_custom_domain*, delete_pages_custom_domain*, get_pages_custom_domain, retry_custom_domain_validation*, purge_pages_build_cache*, disconnect_git_repository*, connect_git_repository*, get_pages_upload_token*

**accounts/pay-invoice** (1): pay_invoice*

**accounts/pay-per-crawl** (13): deletes_stripe_config_for_crawler*, gets_stripe_config_for_crawler, creates_stripe_config_for_crawler*, list_pay_per_crawl_crawlers, deletes_stripe_config_for_publisher*, gets_stripe_config_for_publisher, creates_stripe_config_for_publisher*, get_signed_pay_per_crawl_terms_link, get_pay_per_crawl_terms, get_pay_per_crawl_terms_signature_status, record_pay_per_crawl_terms_activity*, set_can_be_enabled_setting_on_zones*, gets_can_be_enabled_zone_setting*

**accounts/pay-per-use** (8): list_enabled_pay_per_use_domains, get_pay_per_use_operator_configuration, update_pay_per_use_operator_configuration*, set_pay_per_use_operator_configuration*, list_pay_per_use_price_proposals, decide_pay_per_use_price_proposal*, get_pay_per_use_usage_statistics, set_pay_per_use_zone_eligibility*

**accounts/payment-methods** (6): list_payment_methods, create_payment_method*, delete_payment_method*, get_payment_method, update_payment_method*, set_default_payment_method*

**accounts/pcaps** (9): list_packet_capture_requests, create_pcap_request*, list_pcaps_bucket_ownership, add_buckets_for_full_packet_captures*, validate_buckets_for_full_packet_captures*, delete_buckets_for_full_packet_captures*, get_pcap_request, download_simple_pcap, stop_full_pcap*

**accounts/pipelines** (16): list_pipelines, create_pipeline*, delete_pipeline*, get_pipeline_details, update_pipeline_tables*, list_sinks, create_sink*, delete_sink*, get_sink_details, update_sink*, list_streams, create_stream*, delete_stream*, get_stream_details, update_stream*, validate_sql

**accounts/profile** (2): get_account_profile, update_account_profile*

**accounts/queues** (21): list_queues, create_queue*, delete_queue*, get_queue, queues_edit*, queues_update*, list_queue_consumers, create_queue_consumer*, delete_queue_consumer*, get_queue_consumer, update_queue_consumer*, push_message*, acknowledge_retry_queue_messages*, push_message_batch*, extend_message_leases*, peek_queue_messages*, pull_queue_messages*, purge_peeked_queue_messages*, get_queue_metrics, get_queue_purge_status, purge_queue*

**accounts/r2** (36): list_r2_buckets, create_r2_bucket*, delete_bucket*, get_r2_bucket, patch_bucket*, create_bucket_by_name*, delete_bucket_cors_policy*, get_bucket_cors_policy, set_bucket_cors_policy*, list_custom_domains_of_bucket, attach_custom_domain_to_bucket*, remove_custom_domain_from_bucket*, get_custom_domain_settings, configure_custom_domain_settings*, get_r2_managed_domain, update_r2_dev_domain_of_bucket*, list_bucket_jobs, create_bucket_job*, get_bucket_job, get_object_lifecycle_rules, set_object_lifecycle_rules*, get_local_uploads_configuration, set_local_uploads_configuration*, delete_bucket_lock_rules*, get_r2_bucket_lock, set_bucket_lock_rules*, delete_objects*, list_r2_objects, delete_object*, get_r2_object, upload_r2_object*, disable_sippy*, get_sippy_configuration, enable_sippy*, get_account_level_metrics, create_temporary_access_credentials*

**accounts/realtime** (63): fetch_apps, realtime_kit_apps_create*, fetch_app_details, realtime_kit_apps_update*, fetch_day_wise_session_and_recording_analytics_data_for_app, fetch_day_wise_analytics_data_for_livestreams, fetch_complete_analytics_data_for_livestreams, fetch_livestreams, fetch_livestream_session_details_using_livestream_session_id, fetch_livestream_details_using_livestream_id, fetch_active_livestream_session_details, fetch_meetings_for_app, realtime_kit_meetings_create*, fetch_meeting_for_app, realtime_kit_meetings_update*, realtime_kit_meetings_replace*, fetch_active_livestreams_for_meeting, stop_livestreaming_meeting*, fetch_details_of_active_session, kick_participants_from_active_session*, kick_participants*, mute_participants_of_active_session*, mute_participants*, realtime_kit_meetings_active_polls_create*, fetch_livestream_session_details_for_meeting, start_livestreaming_meeting*, fetch_participants_of_meeting, realtime_kit_meetings_participants_create*, delete_participant*, fetch_participant_detail, edit_participant_detail*, replace_participant_detail*, revoke_participant_authentication_token*, refresh_participant_authentication_token*, fetch_presets, create_preset*, delete_preset*, fetch_details_of_preset, update_preset*, replace_preset*, fetch_recordings_for_app, start_recording_meeting*, fetch_active_recording, start_recording_participant_audio_tracks*, fetch_details_of_recording, realtime_kit_recordings_control*, fetch_sessions_of_app, fetch_details_of_peer, fetch_details_of_session, fetch_chat_messages_of_session, fetch_livestream_session_details_using_session_id, fetch_participants_list_of_session, fetch_details_of_participant, fetch_summary_of_transcripts_for_session, generate_summary_of_transcripts_for_session*, fetch_complete_transcript_for_session, fetch_webhooks_details, realtime_kit_webhooks_create*, fetch_supported_webhook_events, realtime_kit_webhooks_delete*, fetch_details_of_webhook, realtime_kit_webhooks_update*, realtime_kit_webhooks_replace*

**accounts/receipts** (1): get_receipt_pdf

**accounts/registrar** (13): check_registrar_domains, registrar_registrations_search, check_domain_transfer_eligibility, registrar_extensions_list, registrar_extensions_get, registrar_registrations_list, registrar_registrations_create*, registrar_registrations_get, registrar_registrations_update*, registrar_registrations_get_registration_status, initiate_transfer*, get_transfer_status, registrar_registrations_get_update_status

**accounts/reporting** (6): get_account_industry, update_account_industry*, list_reporting_policies, get_reporting_policy, list_generated_reports, get_generated_report

**accounts/request-tracer** (1): request_trace*

**accounts/resource-library** (8): accounts_applications_list, create_application*, look_up_applications_in_rule_sentence*, delete_application*, get_application, update_application*, list_application_categories, get_application_category

**accounts/rules** (11): get_lists, create_list*, get_bulk_operation_status, delete_list*, get_list, update_list*, delete_list_items*, list_rule_list_entries, create_list_items*, replace_list_items*, get_list_item

**accounts/rulesets** (16): rulesets_list, rulesets_create*, get_account_entry_point_ruleset, update_account_entry_point_ruleset*, list_account_entry_point_ruleset_versions, get_account_entry_point_ruleset_version, rulesets_delete*, rulesets_get, rulesets_update*, rulesets_rules_create*, rulesets_rules_delete*, rulesets_rules_update*, list_account_ruleset_versions, rulesets_versions_delete*, rulesets_versions_get, list_account_ruleset_version_rules_by_tag

**accounts/rum** (13): create_web_analytics_site*, list_rum_sites, list_web_analytics_site_tags, validate_web_analytics_site_hostname, list_web_analytics_zone_tags, delete_web_analytics_site*, get_web_analytics_site, update_web_analytics_site*, create_web_analytics_rule*, delete_web_analytics_rule*, update_web_analytics_rule*, list_rules_in_web_analytics_ruleset, update_web_analytics_rules*

**accounts/secrets_store** (12): view_secret_usage, list_account_stores, create_store*, delete_store*, get_store_by_id, delete_secrets*, list_store_secrets, create_secret*, delete_secret*, get_secret_by_id, patch_secret*, duplicate_secret*

**accounts/security-center** (18): retrieves_security_center_insights, retrieves_account_audit_log, retrieves_security_center_insight_counts_by_class, retrieves_partner_security_center_insight_count, get_recent_account_scans, start_on_demand_account_scan*, retrieves_security_center_insight_counts_by_severity, retrieves_security_center_insight_counts_by_type, retrieves_issue_audit_log, updates_security_center_insight_classification*, retrieves_security_center_insight_context, security_insights_dismiss*, retrieves_partner_integration_settings, updates_partner_integration_settings*, lists_partner_discovered_shadow_zones, lists_hosts_in_partner_discovered_shadow_zone, retrieves_account_state, updates_account_state*

**accounts/settings** (3): list_image_resizing_configurations_for_account, get_unique_transformations_billing_setting, change_unique_transformations_billing_setting*

**accounts/slurper** (12): r2_super_slurper_jobs_list, create_job*, abort_jobs*, delete_job*, r2_super_slurper_jobs_get, abort_job*, get_job_logs, pause_job*, get_job_progress, resume_job*, check_source_connectivity*, check_target_connectivity*

**accounts/sso_connectors** (6): get_sso_connectors, initialize_new_sso_connector*, iam_sso_delete*, get_single_sso_connector, iam_sso_update*, iam_sso_begin_verification*

**accounts/storage** (13): kv_namespaces_list, kv_namespaces_create*, kv_namespaces_delete*, kv_namespaces_get, rename_namespace*, bulk_write_workers_kv_entries*, kv_bulk_delete*, bulk_read_kv_values, list_kv_keys, get_key_metadata, delete_key_value_pair*, get_kv_value, write_kv_value*

**accounts/stream** (49): list_videos, initiate_video_uploads_using_tus*, clip_videos_given_start_and_end_time*, upload_videos_from_url*, upload_videos_via_direct_upload_urls*, stream_keys_list, create_signing_keys*, delete_signing_keys*, list_live_inputs, create_live_input*, delete_live_input*, retrieve_live_input, update_live_input*, disable_live_input*, enable_live_input*, list_outputs_associated_with_specified_live_input, create_new_output_connected_to_live_input*, delete_output*, update_output*, rotate_keys_for_live_input*, storage_use, get_account_stream_usage, list_watermark_profiles, create_watermark_profiles_via_basic_upload*, delete_watermark_profiles*, watermark_profile_details, delete_webhooks*, view_webhook, create_vod_webhooks*, delete_video*, retrieve_video_details, edit_video_details*, list_additional_audio_tracks_on_video, add_audio_tracks_to_video*, delete_additional_audio_tracks_on_video*, edit_additional_audio_tracks_on_video*, list_captions_or_subtitles, delete_captions_or_subtitles*, list_captions_or_subtitles_for_provided_language, upload_captions_or_subtitles*, generate_captions_or_subtitles_for_provided_language_via_ai*, return_web_vtt_captions_for_provided_language, delete_downloads*, list_downloads, create_downloads*, delete_download*, create_download*, deprecated_retrieve_legacy_embed_code_html, create_signed_url_tokens_for_videos*

**accounts/subscriptions** (9): list_account_subscriptions, create_subscription*, cancel_delayed_downgrade*, delete_subscription*, get_subscription, update_subscription*, append_subscription_action*, get_cancel_reason, create_cancel_reason*

**accounts/tags** (7): delete_tags_from_account_level_resource*, get_tags_for_account_level_resource, set_tags_for_account_level_resource*, list_tag_keys, list_tagged_resources, list_tag_key_summary, list_tag_values

**accounts/teamnet** (11): list_tunnel_routes, create_tunnel_route*, get_tunnel_route_by_ip, delete_tunnel_route*, get_tunnel_route, update_tunnel_route*, list_virtual_networks, create_virtual_network*, delete_virtual_network*, get_virtual_network, update_virtual_network*

**accounts/tokens** (8): accounts_tokens_list, create_account_api_token*, list_permission_groups, accounts_tokens_verify, delete_account_api_token*, accounts_tokens_get, accounts_tokens_update*, accounts_tokens_roll*

**accounts/triggers** (4): delete_script_triggers*, get_script_triggers, add_script_triggers*, replace_script_triggers*

**accounts/tunnels** (1): list_tunnels

**accounts/urlscanner** (8): bulk_create_url_scans*, get_url_scan_dom, url_scanner_scans_har, url_scanner_responses_get, url_scanner_scans_get, url_scanner_scans_create*, url_scanner_scans_screenshot, url_scanner_scans_list

**accounts/vectorize** (12): list_vectorize_indexes, create_vectorize_index*, delete_vectorize_index*, get_vectorize_index, delete_vectors_by_identifier*, get_vectors_by_identifier, get_vectorize_index_info, list_vectors, create_metadata_index*, delete_metadata_index*, list_metadata_indexes, query_vectors

**accounts/vuln_scanner** (22): api_security_vulnerability_scanner_credential_sets_list, api_security_vulnerability_scanner_credential_sets_create*, api_security_vulnerability_scanner_credential_sets_delete*, api_security_vulnerability_scanner_credential_sets_get, api_security_vulnerability_scanner_credential_sets_edit*, api_security_vulnerability_scanner_credential_sets_update*, api_security_vulnerability_scanner_credential_sets_credentials_list, api_security_vulnerability_scanner_credential_sets_credentials_create*, api_security_vulnerability_scanner_credential_sets_credentials_delete*, api_security_vulnerability_scanner_credential_sets_credentials_get, api_security_vulnerability_scanner_credential_sets_credentials_edit*, api_security_vulnerability_scanner_credential_sets_credentials_update*, api_security_vulnerability_scanner_scans_list, api_security_vulnerability_scanner_scans_create*, api_security_vulnerability_scanner_scans_delete*, api_security_vulnerability_scanner_scans_get, api_security_vulnerability_scanner_target_environments_list, api_security_vulnerability_scanner_target_environments_create*, api_security_vulnerability_scanner_target_environments_delete*, api_security_vulnerability_scanner_target_environments_get, api_security_vulnerability_scanner_target_environments_edit*, api_security_vulnerability_scanner_target_environments_update*

**accounts/waiting_rooms** (1): list_waiting_rooms_for_account

**accounts/warp_connector** (11): list_mesh_nodes, create_mesh_node*, delete_mesh_node*, get_mesh_node, update_mesh_node*, get_mesh_node_ha_configuration, update_mesh_node_ha_configuration*, list_mesh_node_connections, get_mesh_node_connector, trigger_manual_failover_for_mesh_node*, get_mesh_node_token*

**accounts/workers** (140): fetch_workers_account_settings, configure_workers_account_settings*, list_workers_for_platforms_dispatch_namespaces, create_workers_for_platforms_dispatch_namespace*, delete_workers_for_platforms_dispatch_namespace*, get_workers_for_platforms_dispatch_namespace, patch_workers_for_platforms_dispatch_namespace*, update_workers_for_platforms_dispatch_namespace*, delete_workers_for_platforms_scripts*, list_workers_for_platforms_scripts, delete_workers_for_platforms_script*, get_workers_for_platforms_script_details, upload_workers_for_platforms_script*, create_workers_for_platforms_assets_upload_session*, get_workers_for_platforms_script_bindings, get_workers_for_platforms_script_content, replace_workers_for_platforms_script_content*, list_workers_for_platforms_script_secrets, add_secret_to_workers_for_platforms_script*, patch_multiple_workers_for_platforms_script_secrets*, delete_workers_for_platforms_script_secret*, get_workers_for_platforms_script_secret, get_workers_for_platforms_script_settings, patch_workers_for_platforms_script_settings*, list_workers_for_platforms_script_tags, replace_workers_for_platforms_script_tags*, delete_workers_for_platforms_script_tag*, update_workers_for_platforms_script_tag*, create_workers_for_platforms_script_tag*, list_worker_domains, attach_worker_domain*, detach_worker_domain*, get_worker_domain, list_durable_object_namespaces, export_durable_object_sqlite_database, list_objects_in_durable_object_namespace, query_durable_object*, list_agent_traces, get_agent_trace, list_agent_trace_events, get_destinations, create_destination*, delete_destination*, update_destination*, list_detected_issues, list_issue_automations, create_issue_automation*, delete_issue_automation*, get_issue_automation, update_issue_automation*, create_issue_group*, dissolve_issue_group*, add_issue_group_members*, remove_issue_group_member*, summarize_detected_issues, get_issue, modify_issue*, notify_about_issue*, list_issue_occurrences, list_metrics_exports, upsert_metrics_exports*, list_queries, save_query*, delete_query*, get_query, update_query*, create_sharable_link_to_query_result*, view_query_that_has_been_shared, list_keys, prepare_live_tail*, live_tail_heartbeat*, query_worker_telemetry, list_worker_telemetry_values, get_event_count, list_workers_smart_placement_regions, list_worker_scripts, search_worker_scripts, delete_worker_script*, download_worker_script, deploy_worker_script*, start_worker_asset_upload_session*, replace_worker_script_content*, get_worker_script_content, list_worker_deployments, create_worker_deployment*, delete_worker_deployment*, get_worker_deployment, get_worker_script_schedules_cron_triggers, manage_worker_schedules*, get_worker_script_settings, update_worker_script_settings*, list_worker_secrets, upsert_worker_secret*, patch_multiple_worker_script_secrets*, delete_worker_script_secret*, get_secret_binding, get_worker_script_and_version_settings, patch_worker_script_and_version_settings*, delete_worker_script_subdomain*, get_worker_script_subdomain, update_worker_script_subdomain*, list_worker_tails, start_worker_tail*, delete_worker_tail*, get_worker_script_usage_model, replace_worker_script_usage_model*, list_worker_script_versions, upload_worker_script_version*, get_worker_script_version, get_worker_service_environment_content, replace_worker_environment_script_content*, get_worker_environment_settings, patch_worker_environment_settings*, delete_workers_subdomain*, get_workers_subdomain, create_workers_subdomain*, list_workers, create_worker*, delete_worker*, get_worker, workers_edit*, workers_update*, workers_previews_list, create_preview*, delete_preview*, workers_previews_get, edit_preview*, workers_previews_update*, list_preview_deployments, create_preview_deployment*, update_worker_preview_deployment*, delete_preview_deployment*, get_worker_preview_deployment, list_worker_versions, create_worker_version*, workers_versions_latest_get, workers_versions_latest_edit*, workers_versions_delete*, get_worker_version, workers_versions_profile*

**accounts/workflows** (27): list_workflows, list_concurrency_keys, create_concurrency_key*, delete_concurrency_key*, get_concurrency_key_details, update_concurrency_key*, get_account_settings, update_account_settings*, deletes_workflow*, get_workflow, create_modify_workflow*, list_workflow_instances, create_new_workflow_instance*, batch_create_new_workflow_instances*, batch_delete_instances_of_workflow*, batch_terminate_instances_of_workflow*, get_status_of_job_responsible_for_terminate_instances_of_workflow, delete_workflow_instance*, get_workflow_instance, send_event_to_instance*, change_status_of_instance*, get_full_step_output_from_instance, create_workflow_instance_event_subscription_token*, list_deployed_workflow_versions, get_workflow_version_details, get_workflow_version_dag, get_workflow_version_graph

**accounts/zerotrust** (20): get_zero_trust_connectivity_settings, updates_zero_trust_connectivity_settings*, clear_active_region*, get_active_region, select_region*, list_available_regions, list_hostname_routes, create_hostname_route*, delete_hostname_route*, get_hostname_route, update_hostname_route*, list_subnets, get_cloudflare_source_subnet, update_cloudflare_source_subnet*, get_initial_resolved_ip_subnet, update_initial_resolved_ip_subnet*, create_warp_ip_subnet*, delete_warp_ip_subnet*, get_warp_ip_subnet, update_warp_ip_subnet*

**accounts/zt_risk_scoring** (11): get_behaviors_and_associated_configuration, update_configuration_for_risk_behaviors*, list_risk_score_integrations_for_account, create_new_risk_score_integration*, get_risk_score_integration_by_reference_id, delete_risk_score_integration*, get_risk_score_integration_by_id, update_risk_score_integration*, get_risk_score_info_for_users_in_account, get_risk_event_score_information_for_specific_user, clear_risk_score_for_particular_user*

**analytics/sql** (3): analytics_sql_get, sql_query, sql_datasets

**billing/address-validation** (1): validate_billing_address

**billing/rate_plans** (1): get_rate_plan_by_public_key

**certificates** (2): ssl_origin_ca_certificates_list, create_certificate*

**certificates/{certificate_id}** (2): revoke_certificate*, get_certificate

**cws/categories** (6): list_category_apis, list_category_applications, zero_trust_cws_categories_versions_list, get_latest_application_version, get_application_version, list_category_operations

**cws/filter-schema** (1): get_filter_fields

**ips** (1): cloudflare_jd_cloud_ip_details

**memberships** (1): list_memberships

**memberships/{membership_id}** (3): delete_membership*, membership_details, update_membership*

**oauth/scopes** (1): list_oauth_scopes

**radar** (152): get_agent_readiness_summary, get_ai_bots_http_requests_distribution_by_dimension, get_ai_bots_http_requests_time_series, get_time_series_distribution_of_ai_bots_http_requests_by_dimension, get_workers_ai_inference_distribution_by_dimension, get_time_series_distribution_of_workers_ai_inference_by_dimension, get_ai_markdown_for_agents_reduction_ratio_summary, get_ai_markdown_for_agents_reduction_ratio_time_series, get_latest_annotations, get_latest_internet_outages_and_anomalies, get_number_of_outages_by_location, get_annotation_by_id, get_as112_summary_by_dimension, get_as112_dns_queries_time_series, get_as112_time_series_grouped_by_dimension, get_top_locations_by_as112_dns_queries, get_top_locations_by_as112_dns_queries_with_dnssec_support, get_top_locations_by_as112_dns_queries_with_edns_support, get_top_locations_by_as112_dns_queries_for_ip_version, get_layer_3_attacks_summary_by_dimension, get_layer_3_attacks_by_bytes_time_series, get_layer_3_attacks_time_series_grouped_by_dimension, get_top_layer_3_attack_pairs_origin_and_target_locations, get_top_origin_locations_of_layer_3_attacks, get_top_target_locations_of_layer_3_attacks, get_layer_7_attacks_summary_by_dimension, get_layer_7_attacks_time_series, get_layer_7_attacks_time_series_grouped_by_dimension, get_top_origin_ases_of_layer_7_attacks, get_top_layer_7_attack_pairs_origin_and_target_locations, get_top_origin_locations_of_layer_7_attacks, get_top_target_locations_of_layer_7_attacks, get_bgp_hijack_events, get_announced_ip_address_space_time_series, get_top_ases_by_announced_ip_space, get_bgp_route_leak_events, list_ases_from_global_routing_tables, get_multi_origin_as_moas_prefixes, get_tier_1_path_segments_for_as, get_prefix_to_asn_mapping, get_real_time_bgp_routes_for_prefix, get_bgp_routing_table_stats, get_upstream_composition_time_series_for_as, get_aspa_changes_over_time, get_aspa_objects_snapshot, get_aspa_count_time_series, get_rpki_roa_deployment_time_series, get_bgp_time_series, get_top_ases_by_bgp_updates, get_top_ases_by_prefix_count, get_top_prefixes_by_bgp_updates, list_bots, get_crawler_http_request_distribution_by_dimension, get_time_series_of_crawler_http_request_distribution_by_dimension, get_bots_http_requests_distribution_by_dimension, get_bots_http_requests_time_series, get_time_series_distribution_of_bots_http_requests_by_dimension, get_bot_details, list_certificate_authorities, get_certificate_authority_details, list_certificate_logs, get_certificate_log_details, get_certificate_distribution_by_dimension, get_certificates_time_series, get_time_series_of_certificate_distribution_by_dimension, radar_datasets_list, get_dataset_download_url, get_dataset_csv_stream, get_dns_summary_by_dimension, get_dns_queries_time_series, get_dns_time_series_grouped_by_dimension, get_top_ases_by_dns_queries, get_top_locations_by_dns_queries, get_email_routing_summary_by_dimension, get_email_routing_time_series_grouped_by_dimension, get_email_security_summary_by_dimension, get_email_security_time_series_grouped_by_dimension, get_top_tlds_by_email_message_volume, get_top_tlds_by_email_malicious_classification, get_top_tlds_by_email_spam_classification, get_top_tlds_by_email_spoof_classification, list_autonomous_systems, get_as_rankings_by_botnet_threat_feed_activity, get_as_details_by_ip_address, get_as_details_by_asn, get_irr_as_sets_that_as_is_member_of, get_as_level_relationships_by_asn, get_ip_address_details, list_locations, get_location_details, list_geolocations, get_geolocation_details, get_http_requests_summary_by_dimension, get_http_requests_time_series, get_http_requests_time_series_grouped_by_dimension, get_top_ases_by_http_requests, get_top_ases_by_http_requests_for_bot_class, get_top_ases_by_http_requests_for_browser_family, get_top_ases_by_http_requests_for_device_type, get_top_ases_by_http_requests_for_http_protocol, get_top_ases_by_http_requests_for_http_version, get_top_ases_by_http_requests_for_ip_version, get_top_ases_by_http_requests_for_os, get_top_ases_by_http_requests_for_tls_version, get_top_locations_by_http_requests, get_top_locations_by_http_requests_for_bot_class, get_top_locations_by_http_requests_for_browser_family, get_top_locations_by_http_requests_for_device_type, get_top_locations_by_http_requests_for_http_protocol, get_top_locations_by_http_requests_for_http_version, get_top_locations_by_http_requests_for_ip_version, get_top_locations_by_http_requests_for_os, get_top_locations_by_http_requests_for_tls_version, get_http_authentication_requests_distribution_by_dimension, get_time_series_distribution_of_http_authentication_requests_by_dimension, get_network_traffic_distribution_by_dimension, get_network_traffic_time_series, get_time_series_distribution_of_network_traffic_by_dimension, get_top_ases_by_network_traffic, get_top_locations_by_network_traffic, list_origins, get_origin_metrics_distribution_by_dimension, get_origin_metrics_time_series, get_origin_metrics_time_series_grouped_by_dimension, get_origin_details, get_origin_post_quantum_data_summary, get_origin_post_quantum_data_over_time, check_post_quantum_tls_support, get_internet_quality_index_iqi_summary, get_internet_quality_index_iqi_time_series, get_speed_tests_histogram, get_speed_tests_summary, get_top_ases_by_speed_test_results, get_top_locations_by_speed_test_results, get_domain_rank_details, list_internet_services_categories, get_internet_services_rank_time_series, get_top_internet_services, get_domains_rank_time_series, get_top_or_trending_domains, get_top_domain_categories_by_robots_txt_files_parsed, get_top_user_agents_on_robots_txt_files, search_for_locations_ases_reports_and_more, get_tcp_resets_and_timeouts_summary, get_tcp_resets_and_timeouts_time_series, list_tlds, get_tld_performance_summary, get_tld_performance_over_time, get_tld_details, get_latest_internet_traffic_anomalies, get_top_locations_by_total_traffic_anomalies, get_traffic_anomaly_by_uuid

**signed-url** (1): internal_route_for_testing_signed_urls

**user** (2): get_current_user, edit_user*

**user/argo** (1): get_count_of_zones_with_argo_smart_routing_enabled_for_user

**user/audit_logs** (1): get_user_audit_logs

**user/communication_preferences** (2): get_communication_preferences, update_communication_preferences*

**user/firewall** (5): user_firewall_access_rules_list, user_firewall_access_rules_create*, user_firewall_access_rules_delete*, user_firewall_access_rules_get, user_firewall_access_rules_edit*

**user/invites** (3): list_invitations, invitation_details, respond_to_invitation*

**user/load_balancers** (20): user_load_balancers_monitors_list, user_load_balancers_monitors_create*, user_load_balancers_monitors_delete*, user_load_balancers_monitors_get, user_load_balancers_monitors_edit*, user_load_balancers_monitors_update*, user_load_balancers_monitors_preview_create*, user_load_balancers_monitors_references_list, user_load_balancers_pools_list, user_load_balancers_pools_edit_pools_pools*, user_load_balancers_pools_create*, user_load_balancers_pools_delete*, user_load_balancers_pools_get, user_load_balancers_pools_edit_pools_pool*, user_load_balancers_pools_update*, user_load_balancers_pools_health_get, user_load_balancers_pools_preview_create*, user_load_balancers_pools_references_list, user_load_balancers_preview_get, user_load_balancers_regions_list

**user/load_balancing_analytics** (1): list_healthcheck_events

**user/memberships** (1): get_user_membership

**user/spectrum_analytics** (1): get_zones_bandwidth_report

**user/subscriptions** (4): get_user_subscriptions, create_user_subscription*, delete_user_subscription*, update_user_subscription*

**user/tokens** (8): list_user_api_tokens, create_user_api_token*, list_token_permission_groups, user_tokens_verify, delete_user_api_token*, get_user_api_token, user_tokens_update*, user_tokens_roll*

**workers/builds** (1): builds_deploy_hooks_trigger*

**zones** (5): list_zones, create_zone*, delete_zone*, get_zone, update_zone*

**zones/access** (44): zero_trust_access_zone_apps_list, zero_trust_access_zone_apps_create*, zero_trust_access_zone_apps_ca_list, zero_trust_access_zone_apps_delete*, zero_trust_access_zone_apps_get, zero_trust_access_zone_apps_update*, zero_trust_access_zone_apps_ca_delete*, zero_trust_access_zone_apps_ca_get, zero_trust_access_zone_apps_ca_create*, list_access_policies, create_access_policy*, delete_access_policy*, get_access_policy, update_access_policy*, zero_trust_access_zone_apps_revoke_tokens_create*, zero_trust_access_zone_apps_settings_edit*, zero_trust_access_zone_apps_settings_update*, zero_trust_access_zone_apps_user_policy_checks_get, zero_trust_access_zone_certificates_list, zero_trust_access_zone_certificates_create*, zero_trust_access_zone_certificates_settings_list, zero_trust_access_zone_certificates_settings_update*, zero_trust_access_zone_certificates_delete*, zero_trust_access_zone_certificates_get, zero_trust_access_zone_certificates_update*, zero_trust_access_zone_groups_list, zero_trust_access_zone_groups_create*, zero_trust_access_zone_groups_delete*, zero_trust_access_zone_groups_get, zero_trust_access_zone_groups_update*, zero_trust_access_zone_identity_providers_list, zero_trust_access_zone_identity_providers_create*, zero_trust_access_zone_identity_providers_delete*, zero_trust_access_zone_identity_providers_get, zero_trust_access_zone_identity_providers_update*, zero_trust_access_zone_organizations_get, zero_trust_access_zone_organizations_create*, zero_trust_access_zone_organizations_update*, zero_trust_access_zone_organizations_revoke_user_create*, zero_trust_access_zone_service_tokens_list, zero_trust_access_zone_service_tokens_create*, zero_trust_access_zone_service_tokens_delete*, zero_trust_access_zone_service_tokens_get, zero_trust_access_zone_service_tokens_update*

**zones/acm** (6): list_custom_origin_trust_store_details, upload_custom_origin_trust_store*, delete_custom_origin_trust_store*, acm_custom_trust_store_get, total_tls_settings_details, enable_or_disable_total_tls*

**zones/activation_check** (1): rerun_zone_activation_check*

**zones/ai-audit** (2): get_robots_txt_rules, bulk_get_robots_txt_rules*

**zones/ai-security** (4): get_ai_security_for_apps_custom_topics_of_zone, update_ai_security_for_apps_custom_topics_of_zone*, get_ai_security_for_apps_status_for_zone, update_ai_security_for_apps_status_for_zone*

**zones/analytics** (2): argo_analytics_for_zone, argo_analytics_for_zone_at_different_po_ps

**zones/api_gateway** (30): get_session_identifier_settings, update_session_identifier_settings*, export_discovered_api_operations_as_open_api_schemas, list_discovered_web_and_api_operations, edit_discovered_web_and_api_operations*, get_discovered_web_or_api_operation, edit_discovered_web_or_api_operation*, list_operation_labels, get_managed_operation_label, replace_operations_attached_to_managed_label*, delete_user_defined_operation_labels*, create_user_defined_operation_labels*, delete_user_defined_operation_label*, get_user_defined_operation_label, edit_user_defined_operation_label*, update_user_defined_operation_label*, replace_operations_attached_to_user_defined_label*, delete_web_or_api_operations*, list_web_and_api_operations, create_web_or_api_operations*, create_web_or_api_operation*, remove_labels_from_web_or_api_operations*, attach_labels_to_web_or_api_operations*, replace_labels_on_web_or_api_operations*, delete_web_or_api_operation*, get_web_or_api_operation, remove_labels_from_web_or_api_operation*, attach_labels_to_web_or_api_operation*, replace_labels_on_web_or_api_operation*, export_web_and_api_operations_as_open_api_schemas

**zones/argo** (4): get_argo_smart_routing_setting, patch_argo_smart_routing_setting*, get_tiered_cache, update_tiered_cache*

**zones/available_plans** (2): list_available_plans, available_plan_details

**zones/available_rate_plans** (1): list_available_rate_plans

**zones/bot_management** (4): get_bot_management_settings, update_zone_bot_management_config*, list_zone_feedback_reports, submit_feedback_report*

**zones/cache** (13): get_cache_reserve_setting, change_cache_reserve_setting*, cache_settings_reserve_status, cache_settings_reserve_clear*, get_regional_tiered_cache_setting, change_regional_tiered_cache_setting*, delete_smart_tiered_cache_setting*, get_smart_tiered_cache_setting, patch_smart_tiered_cache_setting*, create_smart_tiered_cache_setting*, delete_variants_setting*, get_variants_setting, change_variants_setting*

**zones/certificate_authorities** (2): ssl_certificate_authorities_hostname_associations_get, replace_hostname_associations*

**zones/client_certificates** (5): list_client_certificates, create_client_certificate*, revoke_client_certificate*, client_certificate_details, reactivate_client_certificate*

**zones/cloud_connector** (2): rules, put_rules*

**zones/content-upload-scan** (8): disable_content_scanning_for_zone*, enable_content_scanning_for_zone*, list_content_scanning_custom_expressions_of_zone, create_content_scanning_custom_expressions_for_zone*, delete_content_scanning_custom_expression_from_zone*, update_content_scanning_custom_expression_for_zone*, get_content_scanning_status_for_zone, update_content_scanning_status_for_zone*

**zones/ct** (2): get_ct_alerting_subscription, update_ct_alerting_subscription*

**zones/custom_certificates** (6): list_ssl_configurations, create_ssl_configuration*, re_prioritize_ssl_certificates*, delete_ssl_configuration*, ssl_configuration_details, edit_ssl_configuration*

**zones/custom_csrs** (4): custom_csrs_zone_list, custom_csrs_zone_create*, custom_csrs_zone_delete*, custom_csrs_zone_get

**zones/custom_hostnames** (11): list_custom_hostnames, create_custom_hostname*, delete_fallback_origin_for_custom_hostnames*, get_fallback_origin_for_custom_hostnames, update_fallback_origin_for_custom_hostnames*, get_custom_hostname_quota, delete_custom_hostname_and_any_issued_ssl_certificates*, custom_hostname_details, edit_custom_hostname*, delete_single_certificate_and_key_for_custom_hostname*, replace_custom_certificate_and_custom_key_in_custom_hostname*

**zones/custom_pages** (9): custom_pages_zone_custom_pages_list, custom_pages_zone_assets_list, custom_pages_zone_assets_create*, custom_pages_zone_assets_delete*, custom_pages_zone_assets_get, custom_pages_zone_assets_update*, custom_pages_zone_custom_pages_preview_tokens_create*, custom_pages_zone_custom_pages_get, custom_pages_zone_custom_pages_update*

**zones/dcv_delegation** (1): retrieve_dcv_delegation_unique_identifier

**zones/devices** (2): get_device_certificate_provisioning_status, update_device_certificate_provisioning_status*

**zones/dns_records** (13): list_dns_records, create_dns_record*, batch_dns_records*, export_dns_records, import_dns_records*, list_scanned_dns_records, review_scanned_dns_records*, trigger_dns_record_scan*, get_dns_record_usage, delete_dns_record*, dns_record_details, update_dns_record*, overwrite_dns_record*

**zones/dns_settings** (2): dns_settings_zone_get, dns_settings_zone_edit*

**zones/dnssec** (4): delete_dnssec_records*, dnssec_details, edit_dnssec_status*, list_dnssec_zsks

**zones/email** (27): get_dmarc_report_status, email_auth_dmarc_reports_edit*, inspect_spf_record, get_email_routing_settings, update_email_routing_settings*, apply_email_routing_settings*, email_routing_disable*, email_routing_dns_settings, unlock_email_routing_dns_records*, email_routing_enable*, list_routing_rules, create_routing_rule*, get_catch_rule, update_catch_rule*, delete_routing_rule*, get_routing_rule, update_routing_rule*, list_sending_subdomains, create_sending_subdomain*, preview_sending_subdomain_dns, delete_sending_subdomain*, get_sending_subdomain, update_sending_subdomain*, get_sending_subdomain_dns_records, fix_sending_subdomain_dns_records*, get_sending_subdomain_dns_status, get_sending_subdomain_complaint_count

**zones/entitlements** (1): get_zone_entitlements

**zones/environments** (8): list_zone_environments, partially_update_zone_environments*, create_zone_environments*, upsert_zone_environments*, delete_zone_environment*, invalidate_cached_content_by_environment*, purge_cached_content_by_environment*, roll_back_zone_environment*

**zones/firewall** (17): firewall_zone_access_rules_list, firewall_zone_access_rules_create*, firewall_zone_access_rules_delete*, firewall_zone_access_rules_edit*, list_zone_lockdown_rules, create_zone_lockdown_rule*, delete_zone_lockdown_rule*, get_zone_lockdown_rule, update_zone_lockdown_rule*, firewall_zone_payload_logging_delete*, firewall_zone_payload_logging_get, firewall_zone_payload_logging_update*, list_user_agent_blocking_rules, create_user_agent_blocking_rule*, delete_user_agent_blocking_rule*, get_user_agent_blocking_rule, update_user_agent_blocking_rule*

**zones/fraud_detection** (2): get_fraud_detection_settings, update_fraud_detection_settings*

**zones/healthchecks** (9): healthchecks_list, healthchecks_create*, create_preview_health_check*, delete_preview_health_check*, health_check_preview_details, healthchecks_delete*, healthchecks_get, healthchecks_edit*, healthchecks_update*

**zones/hold** (4): remove_zone_hold*, get_zone_hold, update_zone_hold*, create_zone_hold*

**zones/hostnames** (4): list_tls_setting_for_hostnames, delete_tls_setting_for_hostname*, get_tls_setting_for_hostname, edit_tls_setting_for_hostname*

**zones/images** (2): get_transformation_flows, update_transformation_flows*

**zones/invalidate_cache** (1): invalidate_cached_content*

**zones/leaked-credential-checks** (7): get_leaked_credential_checks_status_for_zone, update_leaked_credential_checks_status_for_zone*, list_custom_detection_locations_of_zone, create_custom_detection_location_for_zone*, delete_custom_detection_location_from_zone*, get_custom_detection_location_of_zone, update_custom_detection_location_of_zone*

**zones/load_balancers** (6): list_load_balancers, create_load_balancer*, delete_load_balancer*, load_balancer_details, patch_load_balancer*, update_load_balancer*

**zones/logpush** (14): logpush_datasets_fields_get, logpush_datasets_jobs_get, list_instant_logs_jobs, create_instant_logs_job*, logpush_jobs_list, logpush_jobs_create*, logpush_jobs_delete*, logpush_jobs_get, logpush_jobs_update*, logpush_ownership_create*, logpush_ownership_validate*, logpush_validate_destination*, logpush_validate_destination_exists*, logpush_validate_origin*

**zones/logs** (11): get_log_retention_flag, update_log_retention_flag*, list_zone_datasets, create_zone_dataset*, list_available_zone_datasets, delete_zone_dataset*, get_zone_dataset, update_zone_dataset*, get_logs_ray_ids, get_logs_received, logs_received_fields_get

**zones/managed_headers** (3): managed_transforms_delete*, managed_transforms_list, managed_transforms_update*

**zones/media** (1): get_zone_media_usage

**zones/monetization** (8): get_zone_monetization_eligibility, check_zone_monetization_eligibility*, delete_payment_rules*, list_payment_rules, deploy_payment_ruleset*, delete_payment_rule*, get_payment_rule, update_payment_rule*

**zones/observability** (6): delete_zone_trace_rules*, view_zone_trace_rules, replace_zone_trace_rules*, reset_zone_tracing_settings*, view_zone_tracing_settings, update_zone_tracing_settings*

**zones/origin** (7): cache_origin_cloud_regions_list, cache_origin_cloud_regions_bulk_delete*, batch_create_or_replace_origin_cloud_region_mappings*, cache_origin_cloud_regions_regions_list_supported, cache_origin_cloud_regions_delete*, cache_origin_cloud_regions_get, create_or_replace_origin_cloud_region_mapping*

**zones/origin_tls_client_auth** (13): ssl_origin_tls_client_auth_zone_certificates_list, upload_certificate*, ssl_origin_tls_client_auth_hostname_associations_list, enable_or_disable_hostname_for_client_authentication*, ssl_origin_tls_client_auth_hostname_certificates_list, upload_hostname_client_certificate*, delete_hostname_client_certificate*, get_hostname_client_certificate, get_hostname_status_for_client_authentication, get_enablement_setting_for_zone, set_enablement_for_zone*, delete_certificate*, get_certificate_details

**zones/page_shield** (13): get_client_side_security_settings, update_client_side_security_settings*, list_detected_connections, get_detected_connection, list_detected_cookies, get_detected_cookie, list_content_security_rules, create_content_security_rule*, delete_content_security_rule*, get_content_security_rule, update_content_security_rule*, list_detected_scripts, get_detected_script

**zones/pagerules** (6): list_page_rules, create_page_rule*, delete_page_rule*, get_page_rule, edit_page_rule*, update_page_rule*

**zones/pay-per-crawl** (4): get_pay_per_crawl_zone_eligibility, get_pay_per_crawl_config, changes_pay_per_crawl_config_for_zone*, creates_pay_per_crawl_config_for_zone*

**zones/pay-per-use** (7): get_pay_per_use_zone_eligibility, get_pay_per_use_zone_configuration, update_pay_per_use_zone_configuration*, list_pay_per_use_operators, opt_out_of_pay_per_use_operator_price*, set_pay_per_use_operator_price*, get_pay_per_use_usage_statistics_for_zone

**zones/precursor** (2): get_zone_precursor_config, update_zone_precursor_config*

**zones/purge_cache** (1): purge_cached_content*

**zones/rulesets** (16): rulesets_zone_list, rulesets_zone_create*, get_zone_ruleset_phase_entrypoint, update_zone_ruleset_phase_entrypoint*, list_zone_entry_point_ruleset_versions, get_zone_entry_point_ruleset_version, rulesets_zone_delete*, rulesets_zone_get, rulesets_zone_update*, rulesets_zone_rules_create*, rulesets_zone_rules_delete*, rulesets_zone_rules_update*, list_zone_ruleset_versions, rulesets_zone_versions_delete*, rulesets_zone_versions_get, list_zone_ruleset_version_rules_by_tag

**zones/schema_validation** (15): list_uploaded_schemas, upload_schema*, list_hosts_covered_by_uploaded_schemas, api_security_schema_validation_schemas_delete*, get_details_of_schema, set_schema_validation_state*, retrieve_operations_from_schema, get_global_schema_validation_settings, edit_global_schema_validation_settings*, update_global_schema_validation_settings*, list_per_operation_schema_validation_settings, bulk_edit_per_operation_schema_validation_settings*, delete_per_operation_schema_validation_setting*, get_per_operation_schema_validation_setting, update_per_operation_schema_validation_setting*

**zones/security-center** (15): retrieves_zone_security_center_insights, retrieves_zone_audit_log, retrieves_zone_security_center_insight_counts_by_class, retrieves_partner_zone_security_center_insight_count, get_recent_zone_scans, start_on_demand_zone_scan*, retrieves_zone_security_center_insight_counts_by_severity, retrieves_zone_security_center_insight_counts_by_type, retrieves_zone_issue_audit_log, updates_zone_security_center_insight_classification*, archives_zone_security_center_insight*, lists_partner_discovered_shadow_hosts_for_zone, deletes_security_txt*, retrieves_security_txt, updates_security_txt*

**zones/settings** (55): delete_aegis_setting*, get_aegis_setting, change_aegis_setting*, get_auto_origin_tls_kex_enrollment_status_for_given_zone, patch_auto_origin_tls_kex_enrollment_status_for_given_zone*, get_automatic_platform_optimization_setting, change_automatic_platform_optimization_setting*, get_binary_ast_setting, change_binary_ast_setting*, get_csam_scanner_setting, update_csam_scanner_setting*, get_cloudflare_fonts_setting, change_cloudflare_fonts_setting*, get_google_tag_gateway_configuration, update_google_tag_gateway_configuration*, get_http_2_prioritization_setting, change_http_2_prioritization_setting*, get_image_transformations_setting, change_image_transformations_setting*, get_nel_setting, edit_nel_setting*, disable_ohttp_gateway*, get_ohttp_gateway_enablement, enable_ohttp_gateway*, get_origin_h2_max_streams_setting, change_origin_h2_max_streams_setting*, get_origin_max_http_version_setting, change_origin_max_http_version_setting*, delete_origin_tls_compliance_modes_setting*, get_origin_tls_compliance_modes_setting, change_origin_tls_compliance_modes_setting*, replace_origin_tls_compliance_modes_setting*, get_rum_status_for_zone, toggle_rum_on_off_for_zone*, get_cloudflare_speed_brain_setting, change_cloudflare_speed_brain_setting*, get_automatic_ssl_tls_enrollment_status_for_given_zone, patch_automatic_ssl_tls_enrollment_status_for_given_zone*, get_image_transformations_allowed_origins_setting, change_image_transformations_allowed_origins_setting*, get_image_transformations_c2pa_setting, change_image_transformations_c2pa_setting*, get_transformations_configuration, change_transformations_configuration*, get_zaraz_configuration, update_zaraz_configuration*, get_default_zaraz_configuration, export_zaraz_configuration, list_zaraz_historical_configuration_records, restore_zaraz_historical_configuration_by_id*, get_zaraz_historical_configurations_by_id, publish_zaraz_preview_configuration*, get_zaraz_workflow, get_zone_setting, edit_zone_setting*

**zones/smart_shield** (10): get_smart_shield_settings, patch_smart_shield_settings*, smart_shield_cache_reserve_clear_status, smart_shield_cache_reserve_clear_clear*, smart_shield_health_checks_list, smart_shield_health_checks_create*, smart_shield_health_checks_delete*, smart_shield_health_checks_get, smart_shield_health_checks_edit*, smart_shield_health_checks_update*

**zones/snippets** (8): snippets_list, snippets_rules_delete*, snippets_rules_list, snippets_rules_update*, snippets_delete*, snippets_get, snippets_update*, snippets_content_get

**zones/spectrum** (9): get_current_aggregated_analytics, get_analytics_by_time, get_analytics_summary, list_spectrum_applications, create_spectrum_application_using_name_for_origin*, delete_spectrum_application*, get_spectrum_application_configuration, update_spectrum_application_configuration_using_name_for_origin*, list_spectrum_application_protocols

**zones/speed_api** (10): get_quota_and_availability, list_tested_webpages, delete_page_tests*, list_page_test_history, start_page_test*, get_page_test_result, list_core_web_vital_metrics_trend, delete_scheduled_page_test*, get_page_test_schedule, create_scheduled_page_test*

**zones/ssl** (11): analyze_certificate, list_certificate_packs, order_advanced_certificate_manager_certificate_pack*, get_certificate_pack_quotas, delete_advanced_certificate_manager_certificate_pack*, get_certificate_pack, restart_validation_or_update_advanced_certificate_manager_certificate_pack*, universal_ssl_settings_details, edit_universal_ssl_settings*, ssl_verification_details, edit_ssl_certificate_pack_validation_method*

**zones/stream** (1): get_zone_stream_usage

**zones/subscription** (4): zones_subscriptions_delete*, zone_subscription_details, zones_subscriptions_create*, zones_subscriptions_update*

**zones/subscriptions** (3): zones_subscriptions_delete_bulk*, zones_subscriptions_create_bulk*, zones_subscriptions_update_bulk*

**zones/tags** (3): delete_tags_from_zone_level_resource*, get_tags_for_zone_level_resource, set_tags_for_zone_level_resource*

**zones/token_validation** (15): list_token_validation_configurations, create_token_validation_configuration*, delete_token_validation_configuration*, get_token_validation_configuration, edit_token_validation_configuration*, edit_token_validation_credentials*, replace_token_validation_credentials*, list_token_validation_rules, create_token_validation_rule*, edit_token_validation_rules*, create_token_validation_rules*, preview_token_validation_rule, delete_token_validation_rule*, get_token_validation_rule, edit_token_validation_rule*

**zones/url_normalization** (3): delete_url_normalization_settings*, get_url_normalization_settings, update_url_normalization_settings*

**zones/waiting_rooms** (23): list_waiting_rooms_for_zone, create_waiting_room*, create_custom_waiting_room_page_preview*, get_zone_level_waiting_room_settings, patch_zone_level_waiting_room_settings*, update_zone_level_waiting_room_settings*, delete_waiting_room*, waiting_room_details, patch_waiting_room*, update_waiting_room*, waiting_rooms_events_list, create_event*, delete_event*, event_details, patch_event*, update_event*, preview_active_event_details, list_waiting_room_rules, create_waiting_room_rule*, replace_waiting_room_rules*, delete_waiting_room_rule*, patch_waiting_room_rule*, get_waiting_room_status

**zones/web3** (12): list_web3_hostnames, create_web3_hostname*, delete_web3_hostname*, web3_hostname_details, edit_web3_hostname*, ipfs_universal_path_gateway_content_list_details, update_ipfs_universal_path_gateway_content_list*, list_ipfs_universal_path_gateway_content_list_entries, create_ipfs_universal_path_gateway_content_list_entry*, delete_ipfs_universal_path_gateway_content_list_entry*, ipfs_universal_path_gateway_content_list_entry_details, edit_ipfs_universal_path_gateway_content_list_entry*

**zones/workers** (5): list_worker_routes, create_worker_route*, delete_worker_route*, get_worker_route, replace_worker_route*

**by hand** (7): query_graphql_analytics, query_analytics_sql, query_account_logs_sql, query_zone_logs_sql, update_zaraz_workflow*, insert_vectors*, upsert_vectors*
