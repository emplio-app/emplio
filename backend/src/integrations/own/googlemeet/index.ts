// Google Meet on sign-in: every method of its API from its Discovery document (`bun scripts/openapi-actions.ts googlemeet`).
// Recording files can't be fetched: downloading them needs Drive's restricted scope. COVERAGE.md says exactly what works.
import { googleApi, googleCheck, googleOAuth } from "../google-login";
import type { OwnAction, OwnApp } from "../index";
import { specActions } from "../openapi";

const api = googleApi("Google Meet", "https://meet.googleapis.com");
const NO_FILE = " The recording's file itself can't be fetched; this gives its Google Drive link, which the person opens signed in.";

// the API's own answers name things "spaces/abc", which is what people paste back; only the last part goes in the address
const shortIds = (a: OwnAction): OwnAction => ({
  ...a,
  run: (i, key) => a.run(Object.fromEntries(Object.entries(i).map(([f, v]) => [f, /Id$/.test(f) && typeof v === "string" ? v.split("/").pop() : v])), key),
});

const generated = await specActions(new URL("./actions.json", import.meta.url), api);
const actions = Object.fromEntries(Object.entries(generated).map(([n, a]) => [n, shortIds(a)])) as Record<string, OwnAction>;
for (const n of ["list_recordings", "get_recording"]) actions[n] = { ...actions[n]!, description: `${actions[n]!.description}${NO_FILE}` };

export const googlemeet: OwnApp = {
  app: "googlemeet",
  name: "Google Meet",
  logo: "/logos/googlemeet.svg",
  check: googleCheck,
  oauth: googleOAuth("Google Meet", "googlemeet"),
  // Composio had this twice
  actions: { ...actions, get_recordings_by_conference_record_id: actions.list_recordings! },
};
