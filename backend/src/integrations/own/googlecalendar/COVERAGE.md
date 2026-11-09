# Google Calendar coverage

Source: the Calendar API Discovery document (calendar-json.googleapis.com/$discovery/rest?version=v3), generated 2026-11-09 by `bun scripts/openapi-actions.ts googlecalendar`. 38 from the API and 11 added on top (49 actions), 7 triggers.

## Sign-in

Google sign-in only (no key), shared with Docs, Sheets and Meet: one OAuth client, `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`. Callback `/oauth/googlecalendar/callback`.

| Scope | Google's class |
| --- | --- |
| `calendar` | Sensitive (Calendar's scopes page doesn't print the class; Google's verification list has it as sensitive) |
| `openid`, `email` | Non-sensitive |

`calendar` covers every method; the narrower ones (`calendar.events`, `calendar.acls`, ...) would take six scopes for the same reach. Only scopes Google classes as sensitive or non-sensitive are asked for. The test in `own/google-login.test.ts` fails if a restricted one appears (`drive`, `drive.readonly`, `drive.metadata`, `drive.meet.readonly`...). Tokens last an hour and renew with the refresh token (`offline`, `prompt=consent`).

## Left out

| What | Why |
| --- | --- |
| `list_buildings`, `list_calendar_resources` (Composio) | Admin SDK Directory, for Workspace admins only, with its own admin scope we don't ask for. Rooms still work on events by their email address |

## Hand adjustments

- Input names are Google's (`calendarId`), since the generated actions take them straight from the API; `eventId` etc. come from Google's own lists.
- `reads`: `free_busy_query` runs without asking.
- Composio's duplicates kept as aliases: `duplicate_calendar` (its create calendar), `list_settings`.
- `batch_events` runs one event at a time, up to 100. Composio's used Google's batch endpoint for up to 1000; the batch endpoint if a bulk move ever needs it.
- `find_free_slots` works out gaps itself from `freeBusy`. `get_current_user` reads the main calendar, not the Google profile.

## Triggers (all polled, every 5 minutes)

Google's push channels (`events.watch`, available as an action) expire and need renewing per calendar, so triggers poll `events.list`.

| Trigger | How | Limits |
| --- | --- | --- |
| `google_calendar_event_created_trigger` | `updatedMin` a day back, `created` in the last day | |
| `google_calendar_event_updated_trigger` | id holds `updated`; skips events saved within 5 seconds of being made | |
| `google_calendar_event_change_trigger`, `google_calendar_event_sync_trigger` | `showDeleted`, id holds `updated` | Sync is the same check with the same full event; Composio's were one webhook and one polled |
| `event_canceled_deleted_trigger` | `status: cancelled` | |
| `event_starting_soon_trigger` | `minutes` setting (default 15), events within that window | Checked every 5 minutes, so it fires up to 5 minutes early |
| `attendee_response_changed_trigger` | The next 100 events, id per guest and answer. Unanswered invitations aren't reported | A response on an event further out than the next 100 is noticed once it comes within them |

Two changes to one event between checks are one report, with the latest state. More than 250 changes in one check may miss some.

## Actions (* asks first)

**From the API** (38): events_move*, events_watch*, update_event*, events_get, patch_event*, delete_event*, events_list, create_event*, events_import*, quick_add*, events_instances, calendar_list_delete*, calendar_list_patch*, calendar_list_get, calendar_list_update*, list_calendars, calendar_list_insert*, calendar_list_watch*, calendars_transfer_ownership*, calendars_delete*, get_calendar, patch_calendar*, calendars_update*, clear_calendar*, create_calendar*, channels_stop*, free_busy_query, settings_watch*, settings_list, settings_get, colors_get, acl_update*, acl_patch*, acl_get, acl_delete*, acl_insert*, acl_list, acl_watch*

**Added on top** (11): find_event, events_list_all_calendars, find_free_slots, get_current_user, get_calendar_profile, get_current_date_time, remove_attendee*, sync_events, batch_events*, duplicate_calendar*, list_settings
