// Google Calendar: every method in its Discovery document, under Composio's names. Convenience actions are in own/googlecalendar/index.ts.
import { GOOGLE_SCOPES } from "../../src/integrations/own/google-login";
import type { AppConfig } from "../openapi-actions";
import { composioNames, namer } from "./composio-names";
import { discovery } from "./google-discovery";

export default {
  spec: await discovery("https://calendar-json.googleapis.com/$discovery/rest?version=v3", "googlecalendar", GOOGLE_SCOPES.googlecalendar),
  out: "src/integrations/own/googlecalendar/actions.json",
  name: namer(await composioNames("googlecalendar")),
  rename: {
    calendar_list_list: "list_calendars",
    calendars_get: "get_calendar",
    calendars_insert: "create_calendar",
    calendars_patch: "patch_calendar",
    calendars_clear: "clear_calendar",
    events_insert: "create_event",
    events_delete: "delete_event",
    events_update: "update_event",
    events_patch: "patch_event",
    events_quick_add: "quick_add",
    freebusy_query: "free_busy_query",
  },
  reads: ["free_busy_query"],
} satisfies AppConfig;
