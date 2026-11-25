// tl;dv: what the generator (../openapi-actions.ts) can't tell from the spec. tl;dv's spec isn't served as a file;
// it's embedded in the Redoc page at doc.tldv.io (__redoc_state), so this reads it out of there.
import { tmpdir } from "node:os";
import type { AppConfig } from "../openapi-actions";

const NAMES: Record<string, string> = {
  "ImportController.ImportMeeting": "import_meeting",
  "GetTranscriptByMeetingId.GetTranscriptByMeetingId": "get_meeting_transcript",
  "GetNotesByMeetingId.getNotesByMeetingId": "get_meeting_notes",
  "GetMeetings.GetMeetingById": "list_meetings",
  "GetMeetingById.GetMeetingById": "get_meeting",
  "GetHighlightsByMeetingId.getHighlightsByMeetingId": "get_meeting_highlights",
  "GetDownloadUrlByMeetingId.getMeetingPlaylist": "download_meeting_recording",
  "HealthController.get": "check_health",
  "GetFolders.getFolders": "search_folders",
  "UploadController.initiate": "start_recording_upload",
  "UploadController.status": "get_recording_upload",
  "UploadController.abort": "abort_recording_upload",
  "UploadController.complete": "complete_recording_upload",
};

const html = await (await fetch("https://doc.tldv.io/index.html")).text();
const state = /__redoc_state\s*=\s*(\{.*?\});\s*\n/s.exec(html)?.[1];
if (!state) throw new Error("doc.tldv.io no longer embeds its spec (__redoc_state)");
const spec = JSON.parse(state).spec.data;
for (const ops of Object.values<Record<string, any>>(spec.paths))
  for (const op of Object.values<Record<string, any>>(ops)) {
    if (!NAMES[op.operationId]) throw new Error(`tl;dv has a new call, ${op.operationId}: give it a name in NAMES`);
    op.operationId = NAMES[op.operationId];
  }
const SPEC = `${tmpdir()}/tldv-openapi.json`;
await Bun.write(SPEC, JSON.stringify(spec));

export default {
  spec: SPEC,
  out: "src/integrations/own/tldv/actions.json",
  params: {
    meetingId: "The meeting's id; list_meetings lists them (also the last part of its tldv.io link)",
    uploadId: "The upload's id, from start_recording_upload",
  },
} satisfies AppConfig;
