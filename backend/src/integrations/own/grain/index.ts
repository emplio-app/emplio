// Grain on the person's own access token: every operation of Grain's public API (v2, version 2026-10-01): recordings
// with their AI summaries, action items and transcripts, clips, stories, playlists, uploads, hooks, users, teams and
// meeting types. Grain has no OpenAPI spec, so the calls are listed by hand from developers.grain.com and run through
// own/openapi.ts. Everything Grain can report starts automations by its hooks (triggers.ts).
import { z } from "zod";
import { AppFile, AppsError } from "../../types";
import type { OwnAction, OwnApp } from "../index";
import { type Api, call, rest } from "../openapi";
import { events, receive, triggers, unwatch, wanted, watch } from "./triggers";

export const VERSION = "2026-10-01";
export const api: Api = {
  name: "Grain",
  base: "https://api.grain.com/_/public-api/v2",
  tokenHelp: "grain.com/app/settings/integrations?tab=api",
  auth: (key) => ({ Authorization: `Bearer ${key}`, "Public-Api-Version": VERSION }),
};

// ── shared inputs
const recordingId = z.string().min(1).describe("The recording's id, from list_recordings");
const clipId = z.string().min(1).describe("The clip's id (a highlight id), from get_recording with include.highlights");
const playlistId = z.string().min(1).describe("The playlist's id, from list_playlists");
const userId = z.string().min(1).describe("The Grain user's id, from list_users");
const teamId = z.string().min(1).describe("The team's id, from list_teams");
const uploadId = z.string().min(1).describe("The upload's id, from list_uploads or create_upload");
const hookId = z.string().min(1).describe("The hook's id, from list_hooks");
const cursor = z.string().optional().describe("Next page: the cursor the last answer gave");
const shareState = z.enum(["public", "workspace", "restricted"]).describe("Who can open it by link: public (anyone), workspace (everyone in the workspace) or restricted (only people it's shared with)");
const HOOK_TYPES = ["recording_added", "recording_updated", "recording_deleted", "highlight_added", "highlight_updated", "highlight_deleted", "story_added", "story_updated", "story_deleted", "upload_added", "upload_updated"] as const;

const recordingInclude = z
  .object({
    ai_summary: z.boolean().optional().describe("The AI summary (markdown)"),
    ai_action_items: z.boolean().optional().describe("The AI action items, with who they're for and whether they're done"),
    participants: z.boolean().optional().describe("Who was invited and who attended, with emails and internal/external"),
    highlights: z.boolean().optional().describe("The clips made from it"),
    private_notes: z.boolean().optional().describe("Your own private notes (personal tokens only)"),
    calendar_event: z.boolean().optional().describe("The calendar event it came from: scheduled start and end"),
    hubspot: z.boolean().optional().describe("Linked HubSpot companies, deals and contacts"),
    screenshares: z.boolean().optional().describe("When someone was sharing their screen"),
    sensitivity_matches: z.boolean().optional().describe("Why it was marked sensitive"),
    ai_template_sections: z
      .object({
        format: z.enum(["json", "markdown", "text"]).optional().describe("How the sections come back (default json)"),
        allowed_sections: z.array(z.string()).optional().describe("Only sections with these titles (any case)"),
      })
      .optional()
      .describe("The AI notes template's sections (like Next steps, Pain points)"),
  })
  .optional()
  .describe("Extra details to add to each recording; leave out for the basics (title, time, link, who recorded)");
const uploadInclude = z
  .object({
    attributes: z.boolean().optional().describe("The upload's details (title, time, participants), without the transcript"),
    transcript: z.boolean().optional().describe("The transcript sent with it"),
  })
  .optional()
  .describe("Extra details to add to the upload");
const participants = z
  .array(
    z.object({
      name: z.string().optional().describe("Their name"),
      email: z.string().optional().describe("Their email"),
      phone: z.string().optional().describe("Their phone number"),
      speaker_key: z.string().optional().describe("Matches their lines in transcript.segments, like s1"),
    }),
  )
  .optional()
  .describe("Who was in the meeting; each needs a name, email or phone");
const transcript = z
  .object({
    language: z.string().optional().describe("Language code, like en"),
    segments: z
      .array(
        z.object({
          speaker_key: z.string().describe("Who spoke, matching a participant's speaker_key"),
          start: z.number().int().describe("Start, in milliseconds from the beginning"),
          end: z.number().int().describe("End, in milliseconds from the beginning"),
          text: z.string().describe("What was said"),
        }),
      )
      .describe("The transcript, line by line"),
  })
  .optional()
  .describe("The transcript (required when media_type is transcript)");
const attributes = z
  .object({
    title: z.string().optional().describe("The recording's title"),
    start_datetime: z.string().optional().describe("When the meeting took place, ISO 8601 (not in the future)"),
    team_id: z.string().optional().describe("The team to put it in, from list_teams"),
    recorder_ids: z.array(z.string()).optional().describe("Grain users to credit as recorders (list_users). Required with a workspace token"),
    participants,
    transcript,
  })
  .optional()
  .describe("What the recording will say about itself");

// a POST that only looks things up
const read = (path: string, description: string, input: z.ZodRawShape) => rest(api, "POST", path, description, z.object(input), { readOnly: true });
const r = (method: string, path: string, description: string, input: z.ZodRawShape = {}) => rest(api, method, path, description, z.object(input));

const TRANSCRIPT_TYPES: Record<string, string> = { json: "", txt: ".txt", vtt: ".vtt", srt: ".srt" };

const actions: Record<string, OwnAction> = {
  // ── recordings
  list_recordings: read("/recordings", "Grain recordings (meetings it recorded or that were uploaded), newest first, with what include asks for. 50 per page; cursor in the answer gets the next.", {
    filter: z
      .object({
        title_search: z.string().optional().describe("Words in the title"),
        after_datetime: z.string().optional().describe("Only meetings that started at or after this, ISO 8601, like 2026-11-01T00:00:00Z"),
        before_datetime: z.string().optional().describe("Only meetings that started before this, ISO 8601"),
        attendance: z.enum(["hosted", "attended"]).optional().describe("Only meetings you hosted, or ones you attended (personal tokens only)"),
        participant_scope: z.enum(["internal", "external"]).optional().describe("Only internal (team) meetings, or external (customer) ones"),
        team: z.string().optional().describe("Only this team's recordings (its id, from list_teams)"),
        meeting_type: z.string().optional().describe("Only this meeting type (its id, from list_meeting_types)"),
      })
      .optional()
      .describe("Which recordings"),
    include: recordingInclude,
    cursor,
  }),
  get_recording: read("/recordings/{recording_id}", "One recording: title, time, link, who recorded it, plus what include asks for (AI summary, action items, participants, clips, notes template sections…).", {
    recording_id: recordingId,
    include: recordingInclude,
  }),
  get_recording_transcript: {
    description: "What was said in a recording. format txt (default) is 'Speaker: words' lines; json gives each line with its speaker and start/end in milliseconds; vtt and srt are subtitle files.",
    readOnly: true,
    input: z.object({ recording_id: recordingId, format: z.enum(["txt", "json", "vtt", "srt"]).default("txt").describe("txt, json, vtt or srt") }),
    run: (i: { recording_id: string; format: string }, key: string) =>
      call(api, key, { method: "GET", path: `/recordings/{recording_id}/transcript${TRANSCRIPT_TYPES[i.format] ?? ""}`, query: [], headers: [] }, i),
  },
  download_recording: r("GET", "/recordings/{recording_id}/download", "Download a recording's video or audio as a file on the computer.", { recording_id: recordingId }),
  update_recording_title: r("PATCH", "/recordings/{recording_id}", "Rename a recording.", { recording_id: recordingId, title: z.string().min(1).describe("The new title") }),
  add_recording_tag: r("PUT", "/recordings/{recording_id}/tags", "Tag a recording.", {
    recording_id: recordingId,
    tag: z.string().regex(/^[\p{L}\d][\p{L}\d-]*$/u).describe("The tag: letters and numbers joined by dashes, like q4-renewal"),
  }),
  remove_recording_tag: r("DELETE", "/recordings/{recording_id}/tags/{tag}", "Take a tag off a recording.", { recording_id: recordingId, tag: z.string().min(1).describe("The tag to remove") }),
  share_recording_with_user: r("PUT", "/recordings/{recording_id}/users", "Give a Grain user access to a recording.", { recording_id: recordingId, user_id: userId }),
  unshare_recording_from_user: r("DELETE", "/recordings/{recording_id}/users/{user_id}", "Take a Grain user's access to a recording away.", { recording_id: recordingId, user_id: userId }),
  share_recording_with_team: r("PUT", "/recordings/{recording_id}/teams", "Give a whole team access to a recording.", { recording_id: recordingId, team_id: teamId }),
  unshare_recording_from_team: r("DELETE", "/recordings/{recording_id}/teams/{team_id}", "Take a team's access to a recording away.", { recording_id: recordingId, team_id: teamId }),

  // ── clips (highlights)
  create_clip: r("POST", "/clips/create", "Make a clip (highlight) from part of a recording, to share a key moment. Grain snaps the range to whole sentences and answers with the clip's real start and length.", {
    recording_id: recordingId,
    timestamp: z.number().int().min(0).describe("Where the clip starts, in milliseconds from the beginning of the recording"),
    duration: z.number().int().min(1).describe("How long it is, in milliseconds"),
    text: z.string().optional().describe("The clip's title"),
    user_id: z.string().optional().describe("Who owns the clip (list_users). Required with a workspace token"),
  }),
  update_clip: r("PATCH", "/clips/{clip_id}", "Change a clip's title or range. A new range re-renders its video; a clip still being made can't be changed yet.", {
    clip_id: clipId,
    text: z.string().optional().describe("The new title"),
    timestamp: z.number().int().min(0).optional().describe("New start, in milliseconds from the beginning of the recording"),
    duration: z.number().int().min(1).optional().describe("New length, in milliseconds"),
  }),
  delete_clip: r("DELETE", "/clips/{clip_id}", "Delete a clip.", { clip_id: clipId }),

  // ── stories
  list_stories: read("/stories", "Grain stories (clips put together into one shareable reel), with their links and tags.", { cursor }),

  // ── playlists
  list_playlists: read("/playlists", "Playlists (collections of recordings), newest first. A workspace token sees every playlist in the workspace.", { cursor }),
  get_playlist: r("GET", "/playlists/{playlist_id}", "One playlist: title, who can open it, when it was made.", { playlist_id: playlistId }),
  list_playlist_recordings: r("GET", "/playlists/{playlist_id}/recordings", "The recordings in a playlist, newest first.", { playlist_id: playlistId, cursor }),
  create_playlist: r("POST", "/playlists/create", "Make a playlist to collect recordings in.", {
    title: z.string().min(1).describe("The playlist's title"),
    share_state: shareState.optional(),
    user_id: z.string().optional().describe("Who owns it (list_users). Required with a workspace token"),
  }),
  update_playlist: r("PATCH", "/playlists/{playlist_id}", "Rename a playlist or change who can open it. Opening it up to public or workspace opens up its recordings the same way.", {
    playlist_id: playlistId,
    title: z.string().optional().describe("The new title"),
    share_state: shareState.optional(),
  }),
  delete_playlist: r("DELETE", "/playlists/{playlist_id}", "Delete a playlist (the recordings in it stay).", { playlist_id: playlistId }),
  add_recording_to_playlist: r("PUT", "/playlists/{playlist_id}/recordings/{recording_id}", "Put a recording in a playlist. In a public or workspace playlist, the recording opens up to match.", { playlist_id: playlistId, recording_id: recordingId }),
  remove_recording_from_playlist: r("DELETE", "/playlists/{playlist_id}/recordings/{recording_id}", "Take a recording out of a playlist.", { playlist_id: playlistId, recording_id: recordingId }),
  share_playlist_with_user: r("PUT", "/playlists/{playlist_id}/users/{user_id}", "Give a Grain user access to a playlist.", { playlist_id: playlistId, user_id: userId }),
  unshare_playlist_from_user: r("DELETE", "/playlists/{playlist_id}/users/{user_id}", "Take a Grain user's access to a playlist away (not its owner's).", { playlist_id: playlistId, user_id: userId }),
  share_playlist_with_team: r("PUT", "/playlists/{playlist_id}/teams/{team_id}", "Give a whole team access to a playlist.", { playlist_id: playlistId, team_id: teamId }),
  unshare_playlist_from_team: r("DELETE", "/playlists/{playlist_id}/teams/{team_id}", "Take a team's access to a playlist away.", { playlist_id: playlistId, team_id: teamId }),

  // ── uploads
  upload_recording: {
    description:
      "Add a recording from a file on the computer: an MP4 video (H.264 with AAC sound, up to 720p) or an MP3, at least 10 seconds and up to 4 GB. Grain processes it and makes a recording; upload_updated says when it's done. To send just a transcript, use create_upload with media_type transcript.",
    input: z.object({
      file: z.any().describe('The MP4 or MP3: {"file": "/work/..."}'),
      attributes,
      auto_promote: z.boolean().optional().describe("False holds it as staged so its details can be checked first (then promote_upload). Default true"),
    }),
    async run(i: { file: unknown; attributes?: unknown; auto_promote?: boolean }, key: string) {
      const file = i.file;
      if (!(file instanceof AppFile)) throw new AppsError('file: give the file as {"file": "/work/..."}');
      const media_type = /\.mp3$/i.test(file.name) || /^audio\/(mpeg|mp3)$/.test(file.mimetype) ? "audio" : /\.mp4$/i.test(file.name) || file.mimetype === "video/mp4" ? "video" : "";
      if (!media_type) throw new AppsError("Grain takes an MP4 video or an MP3; convert the file first (ffmpeg)");
      const upload = (await call(api, key, { method: "POST", path: "/uploads/create", query: [], headers: [], body: { kind: "fields", fields: [["media_type", "media_type"], ["attributes", "attributes"], ["auto_promote", "auto_promote"]] } }, { media_type, attributes: i.attributes, auto_promote: i.auto_promote })) as {
        id: string;
        media?: { upload?: { url: string; headers?: Record<string, string> } };
      };
      const to = upload.media?.upload;
      if (!to?.url) throw new AppsError("Grain gave no address to send the file to");
      const res = await fetch(to.url, { method: "PUT", headers: { ...to.headers, "Content-Type": file.mimetype }, body: file.bytes as Uint8Array<ArrayBuffer> });
      if (!res.ok) throw new AppsError(`Grain: sending the file failed (${res.status} ${await res.text()})`);
      return { ...upload, status: "processing" };
    },
  },
  create_upload: r("POST", "/uploads/create", "Start an upload that becomes a recording. For video or audio the answer has media.upload.url to PUT the file to (upload_recording does both steps); for a transcript, send it in attributes.transcript.", {
    media_type: z.enum(["video", "audio", "transcript"]).describe("video (MP4), audio (MP3) or transcript (text sent in attributes)"),
    auto_promote: z.boolean().optional().describe("False holds it as staged so its details can be checked first (then promote_upload). Default true"),
    attributes,
    include: uploadInclude,
  }),
  list_uploads: read("/uploads", "Uploads and where each is: awaiting (file not sent), processing, staged, promoting, success (recording_id is set) or failure (failure.reason says why).", {
    filter: z.object({ media_type: z.enum(["video", "audio", "transcript"]).optional().describe("Only this kind") }).optional().describe("Which uploads"),
    include: uploadInclude,
    cursor,
  }),
  get_upload: read("/uploads/{upload_id}", "One upload and where it is: awaiting, processing, staged, promoting, success (recording_id is set) or failure.", { upload_id: uploadId, include: uploadInclude }),
  update_upload: r("PATCH", "/uploads/{upload_id}", "Change an upload's details while it's awaiting its file, or staged (made with auto_promote false).", { upload_id: uploadId, attributes, include: uploadInclude }),
  promote_upload: r("POST", "/uploads/{upload_id}/promote", "Turn a staged upload (made with auto_promote false) into a recording.", { upload_id: uploadId, include: uploadInclude }),

  // ── hooks (automations make their own; these are for anything else)
  list_hooks: read("/hooks", "The hooks this token has made: which event each sends, and where.", {
    filter: z
      .object({
        hook_type: z.enum(HOOK_TYPES).optional().describe("Only hooks for this event"),
        state: z.enum(["enabled", "disabled"]).optional().describe("Only enabled or disabled hooks"),
      })
      .optional()
      .describe("Which hooks"),
  }),
  create_hook: r("POST", "/hooks/create", "Have Grain POST an event to an https address of your own. Grain tests the address first and refuses it unless it answers 2xx. Automations don't need this: they set up their own.", {
    hook_url: z.string().url().describe("The https address to send events to"),
    hook_type: z.enum(HOOK_TYPES).describe("Which event"),
    include: z.record(z.string(), z.any()).optional().describe("Extra details on recording and highlight events, as in list_recordings' include (highlights take transcript and speakers)"),
  }),
  delete_hook: r("DELETE", "/hooks/{hook_id}", "Stop a hook.", { hook_id: hookId }),

  // ── people and settings
  get_connection_info: r("GET", "/token-info", "Who this connection is: the user or workspace, and whether the token is personal or for the whole workspace."),
  list_users: read("/users", "The people in the Grain workspace, with their ids and emails.", {}),
  list_teams: read("/teams", "The teams in the Grain workspace.", {}),
  list_meeting_types: read("/meeting_types", "The meeting types Grain sorts recordings into (like Sales, internal syncs), with their ids.", {}),
};

export const grain: OwnApp = {
  app: "grain",
  name: "Grain",
  logo: "/logos/grain.png",
  keyField: {
    label: "Access token",
    help: "In Grain: Settings → Integrations → API (grain.com/app/settings/integrations?tab=api) → create a Personal access token, then copy it. It sees what you see in Grain. A workspace admin can instead make a Workspace access token, which sees every recording in the workspace (only on Grain plans with the Workspace API).",
    placeholder: "Paste the token",
  },
  async check(key) {
    const me = (await call(api, key, { method: "GET", path: "/token-info", query: [], headers: [] }, {})) as { name?: string };
    return me.name;
  },
  push: {
    events,
    triggers,
    start: (key, connection, event) => watch(api, key, connection, event),
    stop: (key, id) => unwatch(api, key, id),
    receive,
    wanted,
  },
  actions,
};
