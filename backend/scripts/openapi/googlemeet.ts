// Google Meet: every method in its Discovery document, under Composio's names.
import { GOOGLE_SCOPES } from "../../src/integrations/own/google-login";
import type { AppConfig } from "../openapi-actions";
import { composioNames, namer } from "./composio-names";
import { discovery } from "./google-discovery";

export default {
  spec: await discovery("https://meet.googleapis.com/$discovery/rest?version=v2", "googlemeet", GOOGLE_SCOPES.googlemeet),
  out: "src/integrations/own/googlemeet/actions.json",
  name: namer(await composioNames("googlemeet")),
  rename: {
    spaces_create: "create_meet",
    spaces_get: "get_meet",
    spaces_patch: "update_space",
    spaces_end_active_conference: "end_active_conference",
    spaces_members_create: "create_member",
    spaces_members_get: "get_member",
    spaces_members_list: "list_members",
    spaces_members_patch: "update_member",
    spaces_members_delete: "delete_member",
    spaces_members_batch_update: "batch_update_members",
    conference_records_list: "list_conference_records",
    conference_records_get: "get_conference_record_by_name",
    conference_records_transcripts_list: "get_transcripts_by_conference_record_id",
    conference_records_transcripts_get: "get_transcript",
    conference_records_transcripts_entries_list: "list_transcript_entries",
    conference_records_transcripts_entries_get: "get_transcript_entry",
    conference_records_recordings_list: "list_recordings",
    conference_records_recordings_get: "get_recording",
    conference_records_smart_notes_list: "list_smart_notes",
    conference_records_smart_notes_get: "get_smart_note",
    conference_records_participants_list: "list_participants",
    conference_records_participants_get: "get_participant",
    conference_records_participants_participant_sessions_list: "list_participant_sessions",
    conference_records_participants_participant_sessions_get: "get_participant_session",
  },
} satisfies AppConfig;
