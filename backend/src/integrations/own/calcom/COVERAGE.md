# Cal.com coverage

Source: Cal.com's official OpenAPI spec for API v2, cal.com/docs/api-reference/v2/openapi.json, generated 2026-11-22 by
`bun scripts/openapi-actions.ts calcom`. Every operation in it is an action (419), except the 29 below: the
person's own calls, their teams', and their organization's (those need an organization admin's key; Cal.com answers
403 otherwise).

Compared with Composio's `cal` toolkit (177 tools, no triggers): `coverage.ts calcom cal` shows 0 unmatched triggers
and 149 unmatched action names. They are renames (our names come from Cal.com's own summaries: retrieve_my_information =
get_my_profile, post_new_booking_request = create_booking, retrieve_webhooks_list = get_my_webhooks...), Platform
OAuth-client calls (left out, below), and calls Cal.com has since dropped from its API (get/delete destination calendars,
selected calendar by id, Google Calendar sync status, provider access tokens). Cal.com was never a Composio app in Emplio,
so no saved automation depends on Composio's names.

## Deliberately left out

| What | Why |
| --- | --- |
| GET /v2/organizations/{orgId}/teams/{teamId}/conferencing/{app}/oauth/callback | where a sign-in page sends the browser back; not a call a person makes |
| GET /v2/organizations/{orgId}/conferencing/{app}/oauth/callback | where a sign-in page sends the browser back; not a call a person makes |
| GET /v2/organizations/{orgId}/teams/{teamId}/stripe/save | where a sign-in page sends the browser back; not a call a person makes |
| POST /v2/api-keys/refresh | replaces the API key Emplio signs in with, which would lock Emplio out |
| GET /v2/calendars/{calendar}/save | where the calendar's own sign-in page sends the browser back; not a call a person makes |
| GET /v2/conferencing/{app}/oauth/callback | where the video app's sign-in page sends the browser back; not a call a person makes |
| GET /v2/oauth-clients/{clientId}/users | Platform (OAuth client) calls: need the client's secret, not an API key; Cal.com marks them deprecated |
| POST /v2/oauth-clients/{clientId}/users | Platform (OAuth client) calls: need the client's secret, not an API key; Cal.com marks them deprecated |
| GET /v2/oauth-clients/{clientId}/users/{userId} | Platform (OAuth client) calls: need the client's secret, not an API key; Cal.com marks them deprecated |
| PATCH /v2/oauth-clients/{clientId}/users/{userId} | Platform (OAuth client) calls: need the client's secret, not an API key; Cal.com marks them deprecated |
| DELETE /v2/oauth-clients/{clientId}/users/{userId} | Platform (OAuth client) calls: need the client's secret, not an API key; Cal.com marks them deprecated |
| POST /v2/oauth-clients/{clientId}/users/{userId}/force-refresh | Platform (OAuth client) calls: need the client's secret, not an API key; Cal.com marks them deprecated |
| POST /v2/oauth/{clientId}/refresh | Platform (OAuth client) calls: need the client's secret, not an API key; Cal.com marks them deprecated |
| POST /v2/oauth-clients/{clientId}/webhooks | Platform (OAuth client) calls: need the client's secret, not an API key; Cal.com marks them deprecated |
| GET /v2/oauth-clients/{clientId}/webhooks | Platform (OAuth client) calls: need the client's secret, not an API key; Cal.com marks them deprecated |
| DELETE /v2/oauth-clients/{clientId}/webhooks | Platform (OAuth client) calls: need the client's secret, not an API key; Cal.com marks them deprecated |
| PATCH /v2/oauth-clients/{clientId}/webhooks/{webhookId} | Platform (OAuth client) calls: need the client's secret, not an API key; Cal.com marks them deprecated |
| GET /v2/oauth-clients/{clientId}/webhooks/{webhookId} | Platform (OAuth client) calls: need the client's secret, not an API key; Cal.com marks them deprecated |
| DELETE /v2/oauth-clients/{clientId}/webhooks/{webhookId} | Platform (OAuth client) calls: need the client's secret, not an API key; Cal.com marks them deprecated |
| POST /v2/oauth-clients | Platform (OAuth client) calls: need the client's secret, not an API key; Cal.com marks them deprecated |
| GET /v2/oauth-clients | Platform (OAuth client) calls: need the client's secret, not an API key; Cal.com marks them deprecated |
| GET /v2/oauth-clients/{clientId} | Platform (OAuth client) calls: need the client's secret, not an API key; Cal.com marks them deprecated |
| PATCH /v2/oauth-clients/{clientId} | Platform (OAuth client) calls: need the client's secret, not an API key; Cal.com marks them deprecated |
| DELETE /v2/oauth-clients/{clientId} | Platform (OAuth client) calls: need the client's secret, not an API key; Cal.com marks them deprecated |
| POST /v2/notifications/subscriptions/app-push | registers a phone for Cal.com's own mobile app |
| DELETE /v2/notifications/subscriptions/app-push | unregisters a phone from Cal.com's own mobile app |
| GET /v2/auth/oauth2/clients/{clientId} | OAuth sign-in for Cal.com apps; Emplio connects with an API key |
| POST /v2/auth/oauth2/token | OAuth sign-in for Cal.com apps; Emplio connects with an API key |
| GET /v2/stripe/save | where Stripe's sign-in page sends the browser back; not a call a person makes |
| OAuth sign-in | Not in this job: key sign-in only |

## Hand adjustments (scripts/openapi/calcom.ts, own/calcom/index.ts)

- Base `https://api.cal.com`; every path starts with /v2. The key goes in `Authorization: Bearer`. A 401 means the key is dead.
- Self-hosted Cal.com: the key may be `<https API address> <key>`; the address (with or without its /v2) replaces the base.
  Plain http, localhost, .local/.internal names and private or link-local IPs are refused.
- `cal-api-version`: each operation that needs one has it on the action (`version` in actions.json, taken from the
  spec) and it's sent for it; it's not in any input. The `Authorization`, `x-cal-client-id` and `x-cal-secret-key`
  header params are dropped from inputs.
- `{"status": "error"}` counts as a failure even on a 200.
- Names: Cal.com reuses one summary for the person's, team's and organization's call ("Get all webhooks"); the later ones
  say whose (get_my_webhooks, get_team_event_type_webhooks); the organization's webhook calls are renamed
  get_organization_webhooks and friends.
- Lookups that are POSTs run without asking: the insights calls and calculate_slots_based_on_routing_form_response.
- Calls that show a webhook's signing secret or a delegation credential's key ask first: the get_*webhook(s) calls and
  get_delegation_credential(s)_of_organization.

## Auth

| Method | Status |
| --- | --- |
| API key (Settings → Developer → API keys, starts with cal_live_), sent as Authorization: Bearer | done |
| Self-hosted Cal.com: API address + key | done |
| OAuth (Cal.com OAuth clients) | not built: key sign-in only |

## Triggers

By webhook (own/calcom/triggers.ts): one webhook per connection on POST /v2/webhooks (the person's own, covering every
event type they host), at /webhooks/app/calcom/<connection>, holding every event an automation asked for (an event is
added with PATCH when a new automation needs it). Signed with X-Cal-Signature-256, an HMAC-SHA256 of the body under a
secret worked out from ENCRYPTION_KEY and the connection (never stored). Removed when the last automation goes; a
switched-off webhook is switched back on. The no-show events are checked 15 minutes after the start.

Every event Cal.com's webhooks have (37), each under its own name: booking_created, booking_requested,
booking_rescheduled, booking_cancelled, booking_rejected, booking_payment_initiated, booking_paid,
booking_no_show_updated, booking_location_updated, booking_title_updated, booking_reassigned, booking_seat_accepted,
booking_seat_rejected, sequence_booking_created, meeting_started, meeting_ended, recording_ready,
recording_transcription_generated, instant_meeting, instant_meeting_accepted, after_hosts_cal_video_no_show,
after_guests_cal_video_no_show, form_submitted, form_submitted_no_event, routing_form_fallback_hit,
wrong_assignment_report, ooo_created, calendar_entry_rejected, event_registration_requested / confirmed / waitlisted /
declined / cancelled, delegation_credential_error / rotation_required / secret_rotated / secret_rotation_failed.

Filters: event_type_id and attendee_email on booking and meeting events, form_id on form events.

Not covered by the person's webhook: bookings of team event types they don't host, and organization-wide events. Those
need a team or organization webhook (create_webhook_for_team_event_type, create_organization_webhook are actions).

Polled (polls/calcom.ts): booking_starting_soon (a booking starts within N minutes, default 60; checked every 5 minutes;
a moved booking is news again). Cal.com has no webhook for "before a meeting".

## Actions by group (* asks first)

**Orgs / Attributes** (5): get_attributes, create_attribute*, get_attribute, update_attribute*, delete_attribute*

**Orgs / Attributes / Options** (11): create_attribute_option*, get_attribute_options, delete_attribute_option*, update_attribute_option*, get_assigned_attribute_options_by_attribute_id, get_assigned_attribute_options_by_attribute_slug, assign_attribute_to_user*, get_attribute_options_for_user, update_attribute_assignment_for_user*, unassign_attribute_from_user*, get_attribute_assignment_history_for_user

**Orgs / Attributes / Sync History** (2): get_attribute_sync_history, get_sync_history_for_specific_user

**Orgs / Bookings** (3): get_organization_bookings_cursor_pagination, report_organization_booking*, block_organization_booking_attendee*

**Orgs / Calendar Invites** (2): get_organization_calendar_invite_defaults, update_organization_calendar_invite_defaults*

**Orgs / Delegation Credentials** (7): get_delegation_credentials_of_organization*, save_delegation_credentials_for_organization*, get_delegation_credential_of_organization*, update_delegation_credentials_of_organization*, delete_delegation_credentials_of_organization*, reset_blocked_delegation_credential_s_secret_rotation_state*, verify_delegation_credential_s_workspace_setup*

**Orgs / Memberships** (5): get_memberships, create_membership*, get_membership, delete_membership*, update_membership*

**Orgs / Roles** (5): create_new_organization_role*, get_organization_roles, get_specific_organization_role, update_organization_role*, delete_organization_role*

**Orgs / Roles / Permissions** (5): add_permissions_to_organization_role_single_or_batch*, list_permissions_for_organization_role, replace_permissions_for_organization_role*, remove_multiple_permissions_from_organization_role*, remove_permission_from_organization_role*

**Orgs / Routing forms** (4): get_organization_routing_forms, get_routing_form_responses, create_routing_form_response_and_get_available_slots*, update_routing_form_response*

**Orgs / Schedules** (1): get_schedules

**Orgs / Secondary Domains** (5): get_secondary_domains_of_organization, add_secondary_domain_to_organization*, get_secondary_domain_of_organization, remove_secondary_domain_from_organization*, verify_secondary_domain_of_organization*

**Orgs / Teams** (6): get_teams, create_team*, get_teams_membership_for_user, get_team, delete_team*, update_team*

**Orgs / Teams / Bookings** (2): get_organization_team_bookings, get_booking_references

**Orgs / Teams / Conferencing** (9): connect_conferencing_application_to_team*, get_oauth_conferencing_app_s_auth_url_for_team, list_team_conferencing_applications, set_team_default_conferencing_application*, get_team_default_conferencing_application, disconnect_team_conferencing_application*, get_oauth_conferencing_app_s_auth_url_for_organization, list_organization_conferencing_applications, disconnect_organization_conferencing_application*

**Orgs / Teams / Event Type Sequences** (5): create_event_type_sequence*, list_event_type_sequences, get_event_type_sequence, update_event_type_sequence*, delete_event_type_sequence*

**Orgs / Teams / Event Types / Private Links** (4): create_private_link_for_team_event_type*, get_private_links_for_team_event_type, update_private_link_for_team_event_type*, delete_private_link_for_team_event_type*

**Orgs / Teams / Invite** (1): create_team_invite_link*

**Orgs / Teams / Memberships** (5): get_organization_team_memberships, create_organization_team_membership*, get_organization_team_membership, delete_organization_team_membership*, update_organization_team_membership*

**Orgs / Teams / Roles** (5): create_new_organization_team_role*, get_organization_team_roles, get_specific_organization_team_role, update_organization_team_role*, delete_organization_team_role*

**Orgs / Teams / Roles / Permissions** (5): add_permissions_to_organization_team_role_single_or_batch*, list_permissions_for_organization_team_role, replace_permissions_for_organization_team_role*, remove_multiple_permissions_from_organization_team_role*, remove_permission_from_organization_team_role*

**Orgs / Teams / Routing forms** (6): get_team_routing_forms, create_team_routing_form*, get_team_routing_form, get_team_routing_form_history, edit_team_routing_form_routes*, edit_team_routing_form_fields*

**Orgs / Teams / Routing forms / Responses** (3): get_organization_team_routing_form_responses, create_organization_team_routing_form_response_and_get_available_slots*, update_organization_team_routing_form_response*

**Orgs / Teams / Schedules** (1): get_team_member_schedules

**Orgs / Teams / Stripe** (2): get_stripe_connect_url_for_team, check_team_stripe_connection

**Orgs / Teams / Users / Schedules** (1): get_schedules_of_team_member

**Orgs / Teams / Workflows** (11): get_organization_team_routing_form_workflows, create_organization_team_workflow_for_routing_forms*, get_organization_team_routing_form_workflow, update_organization_routing_form_team_workflow*, delete_organization_team_routing_form_workflow*, get_organization_team_workflows, create_organization_team_workflow_for_event_types*, get_organization_team_workflow, update_organization_team_workflow*, delete_organization_team_workflow*, get_organization_team_workflow_condition_fields

**Orgs / Users** (4): get_users, create_user*, update_user*, delete_user*

**Orgs / Users / Bookings** (1): get_bookings_for_organization_user

**Orgs / Users / Conferencing** (2): list_conferencing_apps_of_organization_user, set_default_conferencing_app_for_organization_user*

**Orgs / Users / OOO** (5): get_out_of_office_entries_for_user, create_out_of_office_entry_for_user*, update_out_of_office_entry_for_user*, delete_out_of_office_entry_for_user*, get_out_of_office_entries_for_organization_users

**Orgs / Users / Schedules** (5): create_schedule*, get_organization_schedules, get_schedule, update_schedule*, delete_schedule*

**Orgs / Webhooks** (5): get_organization_webhooks*, create_organization_webhook*, get_organization_webhook*, delete_organization_webhook*, update_organization_webhook*

**Allowlists** (2): get_cal_com_ip_allowlists, get_cal_com_ip_allowlist_of_one_service

**Bookings** (20): create_booking*, fetch_all_bookings, get_booking_by_seat_uid, get_booking, get_recordings_for_booking, get_cal_video_real_time_transcript_download_links_for_booking, reschedule_booking*, cancel_booking*, mark_booking_absence*, reassign_booking*, reassign_booking_to_specific_host*, confirm_booking*, confirm_booking_seats*, decline_booking_seats*, decline_booking*, request_to_reschedule_booking*, get_add_to_calendar_links_for_booking, get_my_booking_references, get_video_meeting_sessions_only_supported_for_cal_video, update_booking_location_for_existing_booking*

**Bookings - Email Verification** (3): send_email_verification_code*, check_if_email_verification_is_required, verify_email_with_code*

**Bookings / Attendees** (3): get_attendees_for_booking, add_attendee_to_booking*, get_specific_attendee_for_booking

**Bookings / Guests** (1): add_guests_to_existing_booking*

**Bookings / Routing Trace** (1): get_routing_trace_for_booking

**Cal Unified Calendars** (2): get_meeting_details_from_calendar, update_meeting_details_in_calendar*

**Calendars** (8): save_ics_feed*, check_ics_feed, get_busy_times, get_calendars, get_oauth_connect_url, save_apple_calendar_credentials*, check_calendar_connection, disconnect_calendar*

**Conferencing** (6): connect_conferencing_application*, get_oauth_conferencing_app_auth_url, list_conferencing_applications, set_default_conferencing_application*, get_default_conferencing_application, disconnect_conferencing_application*

**Contacts** (12): list_personal_contacts, add_personal_contact*, get_personal_contact_s_meeting_history, get_personal_contact_s_note, list_contact_tags, create_contact_tag*, update_personal_contact*, remove_personal_contact*, add_tag_to_contact*, remove_tag_from_contact*, list_suggested_contacts, dismiss_suggested_contact*

**Credits** (2): check_available_credits, charge_credits*

**Destination Calendars** (1): update_destination_calendars*

**Discover** (6): list_discover_favorites, get_discover_listings_by_id, search_discover_listings, call_web_found_business_to_book*, book_web_found_business_online*, ask_to_be_told_when_discover_provider_joins*

**Event Type Sequences** (2): get_sequence_s_booking_page, get_sequence_s_available_start_times

**Event Types** (15): get_event_type_calendar_invite_templates, update_event_type_calendar_invite_templates*, create_event_type*, list_event_types, get_event_type_history, get_scheduling_configuration, list_crm_sync_errors_for_event_type, get_event_type, update_event_type*, delete_event_type*, get_booking_fields, replace_booking_fields*, add_custom_booking_fields*, update_booking_fields*, delete_custom_booking_field*

**Event Types / Webhooks** (6): create_event_type_webhook*, get_event_type_webhooks*, delete_webhooks*, update_event_type_webhook*, get_event_type_webhook*, delete_event_type_webhook*

**Event Types Private Links** (4): create_private_link_for_event_type*, get_event_type_private_links, update_private_link_for_event_type*, delete_private_link_for_event_type*

**Events** (33): list_events_cursor_pagination, create_event*, get_event, update_event*, delete_event*, publish_event*, cancel_event*, list_event_s_bookings, check_in_guest_by_registration_id*, undo_guest_s_check_in*, check_in_guest_by_scanned_qr_token*, approve_every_pending_guest*, approve_guest*, decline_guest*, count_event_s_guests, list_event_s_co_hosts, invite_co_host_to_event*, reorder_event_s_co_hosts*, remove_co_host_from_event*, search_team_members_who_can_host_event, get_event_s_coordinates, update_event_s_coordinates*, upload_event_cover_image*, remove_event_cover_image*, get_event_s_locations, add_location_to_event*, remove_location_from_event*, edit_event_s_location*, upload_event_person_avatar*, message_event_s_guests*, list_messages_sent_to_event_s_guests, cancel_scheduled_message*, invite_guests_to_event*

**Feedback** (1): report_mcp_feedback*

**Insights** (11): get_booking_limits_usage, get_booking_kpi_stats, get_booking_event_trends, get_average_booking_duration, get_booking_member_stats, get_routing_forms_by_status, get_my_routing_form_responses, get_routing_form_field_options, get_routing_form_response_headers, get_failed_bookings_by_routing_field, get_routed_to_users_per_period

**Links** (2): get_link, delete_link*

**Managed Orgs** (5): create_organization_within_organization*, get_organizations_within_organization, get_organization_within_organization, update_organization_within_organization*, delete_organization_within_organization*

**Me** (5): get_my_profile, update_my_profile*, get_my_booking_limits, update_my_booking_limits*, clear_my_booking_limits*

**Notifications** (8): create_slack_push_linking_intent*, create_telegram_push_linking_intent*, create_i_message_push_linking_intent*, remove_slack_push_subscription*, remove_telegram_push_subscription*, remove_i_message_push_subscription*, get_agent_notification_channel_selection, enable_or_disable_agent_notification_channel*

**Organization Event Types** (15): create_organization_team_event_type*, list_organization_team_event_types, get_organization_team_event_type, update_organization_team_event_type*, delete_team_event_type_in_organization*, get_organization_team_event_type_calendar_invite_templates, update_organization_team_event_type_calendar_invite_templates*, create_phone_call_for_organization_team_event_type*, retrieve_team_event_types, get_organization_team_booking_fields, replace_organization_team_booking_fields*, add_custom_organization_team_booking_fields*, update_organization_team_booking_fields*, delete_custom_organization_team_booking_field*, duplicate_organization_team_event_type*

**Organization Team Verified Resources** (8): request_email_verification_code*, request_phone_number_verification_code*, verify_email_for_org_team*, verify_phone_number_for_org_team*, get_list_of_verified_emails_of_org_team, get_list_of_verified_phone_numbers_of_org_team, get_verified_email_of_org_team_by_id, get_verified_phone_number_of_org_team_by_id

**Out of Office** (4): get_out_of_office_entries_for_authenticated_user, create_out_of_office_entry_for_authenticated_user*, update_out_of_office_entry_for_authenticated_user*, delete_out_of_office_entry_for_authenticated_user*

**Routing forms** (1): calculate_slots_based_on_routing_form_response

**Schedules** (6): create_my_schedule*, get_my_schedules, get_default_schedule, get_my_schedule, update_my_schedule*, delete_my_schedule*

**Selected Calendars** (2): add_selected_calendar*, delete_selected_calendar*

**Slots** (5): get_available_time_slots_for_event_type, reserve_slot*, get_reserved_slot, update_reserved_slot*, delete_reserved_slot*

**Stripe** (2): get_stripe_connect_url, check_stripe_connection

**Team Event Types** (13): create_team_event_type*, list_team_event_types, get_team_event_type, update_team_event_type*, delete_event_type_in_team*, get_team_event_type_calendar_invite_templates, update_team_event_type_calendar_invite_templates*, create_phone_call_for_team_event_type*, get_team_booking_fields, replace_team_booking_fields*, add_custom_team_booking_fields*, update_team_booking_fields*, delete_custom_team_booking_field*

**Teams** (4): get_my_team, update_my_team*, delete_my_team*, get_my_teams

**Teams / Booking limit pools** (8): list_booking_limit_pools, create_booking_limit_pool*, update_booking_limit_pool*, delete_booking_limit_pool*, list_pool_s_hosts_and_their_limits, set_host_s_limit_for_pool*, replace_host_s_limit_for_pool*, clear_host_s_limit_for_pool*

**Teams / Bookings** (1): get_team_bookings

**Teams / Event Types / Webhooks** (6): create_webhook_for_team_event_type*, get_team_event_type_webhooks*, delete_all_team_event_type_webhooks*, update_team_event_type_webhook*, get_team_event_type_webhook*, delete_webhook_for_team_event_type*

**Teams / Events** (2): list_team_s_events_cursor_pagination, create_team_event*

**Teams / Invite** (1): create_my_team_invite_link*

**Teams / Memberships** (5): create_team_membership*, get_team_memberships, get_team_membership, update_team_membership*, delete_team_membership*

**Teams / Routing forms / Responses** (1): create_team_routing_form_response_and_get_available_slots*

**Teams / Schedules** (1): get_my_team_member_schedules

**Teams / Users / OOO** (4): get_out_of_office_entries_for_team_member, create_out_of_office_entry_for_team_member*, update_out_of_office_entry_for_team_member*, delete_out_of_office_entry_for_team_member*

**Teams Verified Resources** (8): request_team_email_verification_code*, request_team_phone_number_verification_code*, verify_email_for_team*, verify_team_phone_number_for_org*, get_list_of_verified_emails_of_team, get_list_of_verified_phone_numbers_of_team, get_verified_email_of_team_by_id, get_verified_phone_number_of_team_by_id

**Timezones** (1): get_all_timezones

**Verified Resources** (8): request_my_email_verification_code*, request_my_phone_number_verification_code*, verify_email*, verify_phone_number*, get_list_of_verified_emails, get_list_of_verified_phone_numbers, get_verified_email_by_id, get_verified_phone_number_by_id

**Webhooks** (5): create_my_webhook*, get_my_webhooks*, update_my_webhook*, get_my_webhook*, delete_my_webhook*

**Workflows** (6): get_workflows, create_workflow*, get_workflow, update_workflow*, delete_workflow*, get_fields_workflow_s_conditions_can_read
