// Supernormal on the business's own API key: who the key belongs to, recorded meetings with their AI notes and
// transcripts, and upcoming calendar meetings, which can be set to be captured or not. Supernormal's REST API is small
// (https://docs.supernormal.com, OpenAPI at /api-reference/openapi.json); COVERAGE.md says what's where and what's left out.
import { z } from "zod";
import type { OwnAction, OwnApp } from "../index";
import { type Api, call, rest } from "../openapi";

export const api: Api = {
  name: "Supernormal",
  base: "https://api.supernormal.com/api/v1",
  tokenHelp: "app.supernormal.com/settings → API keys → Create API key",
  auth: (key) => ({ "X-API-TOKEN": key }),
};

const recordingId = z.string().min(1).describe("The recording's id, from supernormal.list_recordings");

export const actions: Record<string, OwnAction> = {
  get_user: rest(api, "GET", "/user", "Who the API key belongs to: id, first and last name, email, avatar.", z.object({})),
  list_recordings: rest(
    api,
    "GET",
    "/recordings",
    "Recorded meetings, a page at a time: id, title, status, when recorded and finished, length in seconds, number of people, a short summary, owner. meta.next_page in the answer is the next page (null on the last).",
    z.object({
      visibility: z
        .enum(["all", "organization", "shared_with_me"])
        .optional()
        .describe("Which meetings: all (default), organization (the whole team's), or shared_with_me (ones others shared)"),
      page: z.number().int().min(1).optional().describe("Page number, from 1 (default 1)"),
    }),
  ),
  get_recording: rest(
    api,
    "GET",
    "/recordings/{id}",
    "One recorded meeting in full: everything list_recordings gives plus its notes and the AI meeting summary.",
    z.object({ id: recordingId }),
  ),
  get_transcript: rest(
    api,
    "GET",
    "/recordings/{id}/transcript",
    "Everything said in a recorded meeting, piece by piece: start and end in seconds, the words, and who said them (author_name).",
    z.object({ id: recordingId }),
  ),
  list_upcoming_meetings: rest(
    api,
    "GET",
    "/user/calendar_events",
    "Upcoming meetings on the key owner's connected calendar: id, name, start, end, meeting link, platform (google_meet, teams, zoom), recurring or not, and whether Supernormal will record it (scheduled_to_record) or is blocked from it.",
    z.object({
      from: z.string().optional().describe("Only meetings from this time, ISO 8601, e.g. 2026-11-25T00:00:00Z"),
      to: z.string().optional().describe("Only meetings until this time, ISO 8601"),
    }),
  ),
  set_meeting_capture: {
    description: "Turn Supernormal's notetaker on or off for an upcoming calendar meeting: record true sends it in to take notes, false keeps it out.",
    input: z.object({
      id: z.string().min(1).describe("The calendar meeting's id, from supernormal.list_upcoming_meetings"),
      record: z.boolean().describe("true: record and take notes; false: don't"),
    }),
    run: (i, key) => call(api, key, { method: "POST", path: "/calendar_events/{id}/record", query: ["record"], headers: [] }, i),
  },
};

export const supernormal: OwnApp = {
  app: "supernormal",
  name: "Supernormal",
  logo: "/logos/supernormal.png",
  keyField: {
    label: "API key",
    help: "In Supernormal: Settings (app.supernormal.com/settings) → API keys → Create API key. Name it Emplio and tick the scopes user:read, recordings:read, calendar_events:read and calendar_events:write, then copy the key (it's shown once). API keys come with the Business and Enterprise plans; if you don't see API keys, ask Supernormal support to turn on API access for your team.",
    placeholder: "Your Supernormal API key",
  },
  // whose key it is; a wrong key gets a 401, which marks the connection for reconnecting
  async check(key) {
    const u = (await call(api, key, { method: "GET", path: "/user", query: [], headers: [] }, {})) as { first_name?: string; last_name?: string; email?: string };
    return [u.first_name, u.last_name].filter(Boolean).join(" ") || u.email;
  },
  actions,
};
