// Fathom: what the generator (../openapi-actions.ts) can't tell from its spec. Names follow Composio's Fathom toolkit.
import type { AppConfig } from "../openapi-actions";

export default {
  spec: "https://developers.fathom.ai/api-reference/openapi.yaml",
  out: "src/integrations/own/fathom/actions.json",
  rename: {
    create_recording_download: "download_recording",
  },
  // starting a recording's download only prepares a file of it; nothing in Fathom changes
  reads: ["download_recording"],
  params: {
    recording_id: "The recording's id: recording_id on each meeting from list_meetings (not the number in a fathom.video link)",
    cursor: "next_cursor from the previous page, for the next one",
  },
} satisfies AppConfig;
