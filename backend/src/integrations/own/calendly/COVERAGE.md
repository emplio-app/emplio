# Calendly coverage

Source: Calendly's OpenAPI spec (the Stoplight project behind developer.calendly.com), generated 2026-11-09 by
`bun scripts/openapi-actions.ts calendly`. Every operation is an action (84). The spec's webhook list covers every event
Composio has plus more, so all 14 triggers are webhooks and nothing is polled.

## Deliberately left out

| What | Why |
| --- | --- |
| Nothing in the spec | — |

## Composio names not matched, and why

| Composio's | Status |
| --- | --- |
| create_event_invitee | `post_invitee`, the same call |
| create_single_use_scheduling_link | `create_scheduling_link`, the same call |
| list_events | `list_scheduled_events`, the same call |
| list_user_s_event_types | `list_event_types`, the same call |
| remove_user_from_organization | `delete_organization_membership`, the same call |
| who_am_i | `get_current_user`, the same call |

## Hand adjustments (scripts/openapi/calendly.ts)

- Named with Composio's names (`namer`), plus four renames for summaries that didn't reach them.
- `organization` and `user` say to get the URI from get_current_user.

## Auth

| Method | Status |
| --- | --- |
| Personal access token, sent as a Bearer token | done |
| OAuth | not in this job |

## Triggers

Webhook (`triggers.ts`): meeting_scheduled, meeting_canceled, invitee_marked_no_show, invitee_no_show_cleared, routing_form_submitted, event_type_created, event_type_updated, event_type_deleted, contact_created, contact_updated, contact_deleted, meeting_recap_created, meeting_recap_updated, meeting_recap_deleted. Webhooks need a paid Calendly plan. One subscription per connection at organization scope, or user scope when the person is a member; recap events are only offered per user, so they get a second subscription at `<connection>/user`. Events can't be edited, so a new event deletes and remakes the subscription with the union. The signing key is worked out from ENCRYPTION_KEY and the connection, never stored; signatures are checked over `<t>.<body>` and anything older than five minutes is refused.

## Actions by group (* asks first)

**Activity Log** (1): list_activity_log_entries

**Availability** (11): list_user_busy_times, list_user_availability_schedules, create_user_availability_schedule*, get_user_availability_schedule, update_user_availability_schedule*, update_holiday_set*, list_user_holiday_sets, creates_holiday_set_for_current_user*, list_supported_holidays, get_event_type_availability, update_event_type_availability*

**Calendar Events** (2): list_external_calendar_events_for_user, list_reserved_events_for_user

**Contacts** (7): list_contacts, create_contact*, list_contact_custom_field_definitions, get_contact_custom_field_definition, get_contact, update_contact*, delete_contact*

**Data Compliance** (2): delete_invitee_data*, delete_scheduled_event_data*

**Event Types** (7): list_event_types, create_event_type*, get_event_type, update_event_type*, list_event_type_available_times, list_event_type_memberships, create_one_off_event_type*

**Groups** (4): get_group, list_group_relationships, get_group_relationship, list_groups

**Invitees** (1): list_recent_invitees

**Locations** (1): list_user_locations

**Notetaker** (5): list_recaps, get_transcript, get_recap, update_recap*, delete_recap*

**Organizations** (10): list_organization_invitations, organization_invitation*, revoke_user_s_organization_invitation*, get_organization_invitation, get_organization_membership, delete_organization_membership*, list_organization_memberships, get_organization, list_teams, get_team

**Outgoing Communications** (1): list_outgoing_communications

**Polls** (2): update_poll*, get_specific_poll_invitee

**Routing Forms** (4): list_routing_forms, get_routing_form, list_routing_form_submissions, get_routing_form_submission

**Scheduled Events** (9): list_event_invitees, list_scheduled_events, get_event_invitee, post_invitee*, get_event, get_invitee_no_show, delete_invitee_no_show*, invitee_no_show*, cancel_scheduled_event*

**Scheduling Links** (1): create_scheduling_link*

**Shares** (5): list_shares, create_share*, get_share, update_share*, delete_share*

**Subscriptions** (1): list_subscriptions

**Super Admin Roles** (1): get_super_admin_roles

**Trials** (1): list_trials

**Users** (3): get_user, get_current_user, delete_current_user*

**Webhooks** (5): create_webhooks*, list_webhook_subscriptions, get_webhook_subscription, delete_webhook_subscription*, get_sample_webhook_data

