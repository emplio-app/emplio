# Google Analytics 4 coverage

Source: Google's own Discovery documents, generated 2026-11-11 by `bun scripts/openapi-actions.ts googleanalytics`:

- Analytics Admin API `v1alpha` (`https://analyticsadmin.googleapis.com/$discovery/rest?version=v1alpha`) — the setup.
  v1alpha holds every method v1beta has and 110 more (audiences, channel groups, calculated metrics, BigQuery and
  AdSense links, subproperties, reporting annotations), so v1alpha alone is read.
- Analytics Data API `v1beta` and `v1alpha` (`analyticsdata.googleapis.com`) — the numbers. Each version has methods
  the other hasn't, so both are read; the two that appear in both (`runReport`, `getMetadata`) are taken from v1beta,
  the stable one.

185 actions from the specs plus 5 written by hand = **190** (listed as 192, with the two extra Composio names below),
against Composio's 69 tools and 0 triggers. There are 9 triggers here. Every tool Composio lists is covered — the four
`coverage.ts` reports as unmatched by name are the deprecated conversion events, Composio's duplicate `list_accounts`
and its two short Display & Video 360 names, all explained above.

## Deliberately left out

| What | Why |
| --- | --- |
| `properties.chat` (Data API v1alpha) | The Analytics data chat needs the `analytics.chatbot.read` scope, which this app does not ask for. Emplio answers questions about the numbers itself, from `website_report` and `run_report` |
| `properties.conversionEvents.*` (5 methods) | Google marks them deprecated in its own document: key events replaced them. `list_key_events`, `get_key_event`, `create_key_event`, `update_key_event` and `delete_key_event` are the same thing under the new name |
| Universal Analytics (the old `analytics/v3` Management and Reporting APIs) | Google switched Universal Analytics off in July 2024; only GA4 properties still collect data |
| `list_accounts_v1_beta` (Composio has it) | The same call as `list_accounts`, which Composio lists twice because it reads both API versions |
| `list_properties_filtered` and `list_sk_ad_network_conversion_value_schemas` (Composio's names) | Kept as extra names for `list_properties` and `list_sk_ad_network_conversion_value_schema`, so a skill written against Composio still works |
| Google Tag Manager, Google Ads, Looker Studio | Separate products with separate APIs, not part of Analytics |

## Naming

Google's own method ids read resource-first and verb-last (`properties.customDimensions.archive`), which makes for
backwards action names. `scripts/openapi/googleanalytics.ts` puts the verb in front, drops the `properties`/`accounts`
the whole API hangs off, and tidies Google's spelling (`bigquery`, `adsense`, `sk_ad_network`), which lands on
Composio's name for every call it has. Two names differ on purpose, because access bindings and the access report
exist on both an account and a property: the account ones are `*_account_access_binding(s)` and
`run_account_access_report`.

`list_dv360_ad_links` and `list_dv360_link_proposals` (Composio's names) are here as
`list_display_video360_advertiser_links` and `list_display_video360_advertiser_link_proposals`, which is Google's own
wording and matches the create, get, update and delete actions beside them.

## Hand adjustments (own/googleanalytics/index.ts)

- A property can be given as `properties/123456` or just `123456` — Google's answers use the long form, which is what
  people paste back.
- The Admin API and the Data API are different hosts; the generated actions carry the right one.
- Reading a measurement protocol secret hands over a key anyone can send events with, so
  `get_measurement_protocol_secret` and `list_measurement_protocol_secrets` ask first.
- Reports that only look things up (`run_report`, `run_pivot_report`, the batch and realtime and funnel ones,
  `check_compatibility`, `search_change_history_events`, the access report, the `query_*` exports) run without asking.
- Written by hand on top: `website_report` (days instead of dates, one plain-language breakdown instead of Google's
  parallel header and value lists, and `metricAggregations: TOTAL` so the totals cover the whole period and not just
  the rows returned), `compare_website_report` (the same against the period before, biggest movers first) and
  `live_visitors` (the last half hour).
- `send_events` and `validate_events` are the Measurement Protocol, which has no Discovery document and no OAuth: they
  go to `google-analytics.com/mp/collect` with the data stream's measurement id and its own secret, so something that
  happened off the website (an order taken on the phone) still shows up in the reports. `validate_events` posts to the
  debug address, which records nothing and answers with what is wrong — worth knowing, because the real address
  answers 204 whether the events were right or not.

## Auth

| Method | Status |
| --- | --- |
| Sign in with Google (the one Google OAuth client, `own/google-login.ts`), scopes `analytics.readonly`, `analytics.edit`, `analytics.manage.users` | done |
| Pasted key | not offered: Analytics has no API keys. The measurement protocol secret is per data stream and only sends events in, so it is an action's input, not a way to connect |

All three are sensitive scopes, not restricted ones, so they need Google's OAuth consent-screen review but no yearly
security audit. Every method of both APIs is callable with these three (checked by `google-discovery.ts`, which stops
the build if a method needs a scope the app doesn't ask for). The Analytics Admin API and the Analytics Data API both
have to be turned on in the Google Cloud project behind the client.

## Triggers (polled; Analytics has no webhooks)

| Trigger | What starts it |
| --- | --- |
| new_property_trigger | A new property is set up under an account |
| new_data_stream_trigger | A new data stream is added to a property |
| new_key_event_trigger | A new conversion (key event) is set up |
| new_audience_trigger | A new audience is created |
| new_custom_dimension_trigger | A new custom dimension is added |
| setup_changed_trigger | Someone changes the setup — property, stream, conversion, audience or access (Google's change history) |
| live_visitors_trigger | The number of people on the site right now goes above (or below) a figure; once per quiet period |
| traffic_change_trigger | Visitors, sessions or conversions move more than a set share against the period before; at most once a day |
| key_events_threshold_trigger | Conversions today pass a figure; once per quiet period |

The three threshold triggers put the quiet period into the item's id, so one busy afternoon is reported once rather
than at every check. `traffic_change_trigger`'s id carries the day, so a move that lasts a week is reported once a day.

## Actions by group (* asks first)

**Accounts** (17): get_data_sharing_settings, list_accounts, run_account_access_report, update_account*, get_account, delete_account*, provision_account_ticket*, batch_get_account_access_bindings, batch_update_account_access_bindings*, batch_delete_account_access_bindings*, delete_account_access_binding*, get_account_access_binding, update_account_access_binding*, batch_create_account_access_bindings*, create_account_access_binding*, list_account_access_bindings, list_account_summaries

**Properties** (22): list_properties, provision_subproperty*, submit_user_deletion*, acknowledge_user_data_collection*, create_property*, update_property*, get_property, delete_property*, create_rollup_property*, get_subproperty_event_filter, update_subproperty_event_filter*, delete_subproperty_event_filter*, list_subproperty_event_filters, create_subproperty_event_filter*, list_rollup_property_source_links, create_rollup_property_source_link*, get_rollup_property_source_link, delete_rollup_property_source_link*, get_subproperty_sync_config, update_subproperty_sync_config*, list_subproperty_sync_configs, get_property_quotas_snapshot

**Property settings** (13): update_attribution_settings*, get_attribution_settings, get_google_signals_settings, update_google_signals_settings*, get_reporting_identity_settings, update_reporting_identity_settings*, get_user_provided_data_settings, update_data_retention_settings*, get_data_retention_settings, get_data_redaction_settings, update_data_redaction_settings*, update_enhanced_measurement_settings*, get_enhanced_measurement_settings

**Data streams** (27): get_data_stream, update_data_stream*, delete_data_stream*, create_data_stream*, list_data_streams, get_global_site_tag, update_event_create_rule*, get_event_create_rule, delete_event_create_rule*, list_event_create_rules, create_event_create_rule*, delete_sk_ad_network_conversion_value_schema*, update_sk_ad_network_conversion_value_schema*, get_sk_ad_network_conversion_value_schema, create_sk_ad_network_conversion_value_schema*, list_sk_ad_network_conversion_value_schema, update_event_edit_rule*, get_event_edit_rule, delete_event_edit_rule*, list_event_edit_rules, create_event_edit_rule*, reorder_event_edit_rule*, create_measurement_protocol_secret*, list_measurement_protocol_secrets*, get_measurement_protocol_secret*, delete_measurement_protocol_secret*, update_measurement_protocol_secret*

**Conversions, dimensions and groupings** (35): create_custom_dimension*, list_custom_dimensions, update_custom_dimension*, get_custom_dimension, archive_custom_dimension*, list_custom_metrics, create_custom_metric*, get_custom_metric, update_custom_metric*, archive_custom_metric*, create_reporting_data_annotation*, list_reporting_data_annotations, update_reporting_data_annotation*, delete_reporting_data_annotation*, get_reporting_data_annotation, update_calculated_metric*, get_calculated_metric, delete_calculated_metric*, create_calculated_metric*, list_calculated_metrics, list_channel_groups, create_channel_group*, delete_channel_group*, get_channel_group, update_channel_group*, list_expanded_data_sets, create_expanded_data_set*, get_expanded_data_set, delete_expanded_data_set*, update_expanded_data_set*, update_key_event*, delete_key_event*, get_key_event, create_key_event*, list_key_events

**Audiences** (16): update_audience*, get_audience, create_audience*, list_audiences, archive_audience*, query_audience_export, get_audience_export, list_audience_exports, create_audience_export*, list_audience_lists, create_audience_list*, get_audience_list, query_audience_list, list_recurring_audience_lists, create_recurring_audience_list*, get_recurring_audience_list

**Links to other Google products** (32): update_display_video360_advertiser_link*, get_display_video360_advertiser_link, delete_display_video360_advertiser_link*, create_display_video360_advertiser_link*, list_display_video360_advertiser_links, delete_display_video360_advertiser_link_proposal*, get_display_video360_advertiser_link_proposal, create_display_video360_advertiser_link_proposal*, list_display_video360_advertiser_link_proposals, cancel_display_video360_advertiser_link_proposal*, approve_display_video360_advertiser_link_proposal*, create_google_ads_link*, list_google_ads_links, update_google_ads_link*, delete_google_ads_link*, list_firebase_links, create_firebase_link*, delete_firebase_link*, create_search_ads360_link*, list_search_ads360_links, delete_search_ads360_link*, update_search_ads360_link*, get_search_ads360_link, list_adsense_links, create_adsense_link*, get_adsense_link, delete_adsense_link*, delete_bigquery_link*, get_bigquery_link, update_bigquery_link*, list_bigquery_links, create_bigquery_link*

**Who has access** (10): run_access_report, update_access_binding*, delete_access_binding*, get_access_binding, create_access_binding*, list_access_bindings, batch_get_access_bindings, batch_update_access_bindings*, batch_delete_access_bindings*, batch_create_access_bindings*

**Reports** (16): search_change_history_events, run_realtime_report, run_report, get_metadata, batch_run_reports, run_pivot_report, check_compatibility, batch_run_pivot_reports, run_funnel_report, get_report_task, list_report_tasks, create_report_task*, query_report_task, website_report, compare_website_report, live_visitors

**Events sent in** (2): send_events*, validate_events
