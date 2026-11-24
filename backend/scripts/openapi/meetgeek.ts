// MeetGeek: what the generator (../openapi-actions.ts) can't tell from its spec. The spec
// (docs.meetgeek.ai/api-reference/openapi.json) has no operation ids, so they're given here, under Composio's names.
import { tmpdir } from "node:os";
import type { AppConfig } from "../openapi-actions";

type Schema = Record<string, any>;

const NAMES: Record<string, string> = {
  "GET /v1/meetings": "list_meetings",
  "GET /v1/meetings/{meetingId}": "get_meeting",
  "DELETE /v1/meetings/{meetingId}": "delete_meeting",
  "GET /v1/meetings/{meetingId}/transcript": "get_transcript",
  "GET /v1/meetings/{meetingId}/highlights": "get_highlights",
  "GET /v1/meetings/{meetingId}/summary": "get_summary",
  "GET /v1/meetings/{meetingId}/insights": "get_insights",
  "POST /v1/meetings/{meetingId}/download": "download_recording",
  "POST /v1/upload": "upload_recording",
  "GET /v1/teams": "list_teams",
  "GET /v1/teams/{teamId}/meetings": "list_team_meetings",
};

// not in the published spec, but live (it answers 400, not 404) and in Composio's toolkit; fields as Composio sends them
const EXTRA: Schema = {
  "/v1/bot/join": {
    post: {
      summary: "Send MeetGeek's notetaker into a meeting now",
      description: "MeetGeek's bot joins a live online meeting (Google Meet, Zoom, Teams) right away, records it and makes its notes. Paid plans only. Not in MeetGeek's published spec, so its fields follow Composio's.",
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              required: ["join_link"],
              properties: {
                join_link: { type: "string", description: "The meeting's join link, e.g. https://meet.google.com/abc-defg-hij" },
                meeting_name: { type: "string", description: "A title for the meeting, instead of the one MeetGeek makes up" },
                language_code: { type: "string", description: "The language spoken, e.g. en-US (docs.meetgeek.ai/api/api-reference/v1/appendix-language-codes)" },
                template_name: { type: "string", description: "Which notes template to use", enum: ["1:1 Meeting", "Board meeting", "Brainstorming session", "Customer discovery call", "Customer onboarding", "General meeting", "Product demo", "Screening interview", "Startup discovery call", "Weekly team meetin"] },
              },
            },
          },
        },
      },
    },
  },
};

async function build() {
  const spec = (await (await fetch("https://docs.meetgeek.ai/api-reference/openapi.json")).json()) as Schema;
  Object.assign(spec.paths, EXTRA);
  for (const [path, ops] of Object.entries<Schema>(spec.paths))
    for (const [method, op] of Object.entries<Schema>(ops)) {
      const call = `${method.toUpperCase()} ${path}`;
      if (path === "/v1/bot/join") op.operationId = "join_meeting_bot";
      else if (!NAMES[call]) throw new Error(`MeetGeek has a new call, ${call}: give it a name in NAMES`);
      else op.operationId = NAMES[call];
    }
  return spec;
}

const SPEC = `${tmpdir()}/meetgeek-openapi.json`;
await Bun.write(SPEC, JSON.stringify(await build()));

export default {
  spec: SPEC,
  out: "src/integrations/own/meetgeek/actions.json",
  // a POST that only makes a temporary download link
  reads: ["download_recording"],
  params: {
    meetingId: "The meeting's id; list_meetings lists them",
    teamId: "The team's id; list_teams lists them",
    template_name: "Which notes template to use: 1:1 Meeting, Board meeting, Brainstorming session, Customer discovery call, Customer onboarding, General meeting, Product demo, Screening interview, Startup discovery call or Weekly team meetin (MeetGeek's spelling)",
    language_code: "The language spoken, e.g. en-US (docs.meetgeek.ai/api/api-reference/v1/appendix-language-codes)",
  },
} satisfies AppConfig;
