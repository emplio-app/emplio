import { afterEach, expect, test } from "bun:test";
import { z } from "zod";
import { pollOnce } from "../../polls/index";
import { own } from "../index";
import { googlemeet } from "./index";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});
const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
const stub = (answer: (u: URL) => unknown) => {
  const urls: URL[] = [];
  globalThis.fetch = (async (url: string) => {
    const u = new URL(String(url));
    urls.push(u);
    return json(answer(u));
  }) as typeof fetch;
  return urls;
};
const login = { externalId: "c1", secret: "tok" };
const run = (a: string, i: unknown) => own.run(a, i, login, "o");

test("reads run unasked, writes ask, every input is a usable schema", async () => {
  for (const r of ["get_meet", "list_conference_records", "get_conference_record_by_name", "list_recordings", "get_recording", "list_transcript_entries", "list_participants", "list_members", "get_smart_note", "get_recordings_by_conference_record_id"]) expect((await own.getAction(`googlemeet.${r}`))?.readOnly, r).toBe(true);
  for (const w of ["create_meet", "update_space", "end_active_conference", "create_member", "delete_member", "batch_update_members", "update_member"]) expect((await own.getAction(`googlemeet.${w}`))?.readOnly, w).toBeFalsy();
  for (const a of Object.values(googlemeet.actions)) z.toJSONSchema(a.input, { io: "input" });
});

test("a resource's full name or just its id both reach the right address", async () => {
  const urls = stub(() => ({ name: "spaces/abc" }));
  await run("googlemeet.get_meet", { spacesId: "spaces/abc" });
  await run("googlemeet.get_transcript", { conferenceRecordsId: "conferenceRecords/c1", transcriptsId: "conferenceRecords/c1/transcripts/t1" });
  expect(urls[0]!.pathname).toBe("/v2/spaces/abc");
  expect(urls[1]!.pathname).toBe("/v2/conferenceRecords/c1/transcripts/t1");
});

test("what a recording gives is honest: a link, not the file", async () => {
  expect((await own.getAction("googlemeet.get_recording"))!.description).toContain("can't be fetched");
  expect((await own.getAction("googlemeet.list_recordings"))!.description).toContain("can't be fetched");
});

test("polled: a call that ended is reported once, one still running isn't", async () => {
  const end = new Date().toISOString();
  let records: any[] = [{ name: "conferenceRecords/old", endTime: end }];
  const urls = stub(() => ({ conferenceRecords: records }));
  const first = await pollOnce("googlemeet.conference_ended", { meeting_code: "abc-mnop-xyz" }, null, run);
  expect(first.fresh).toEqual([]);
  expect(urls[0]!.searchParams.get("filter")).toBe('space.meeting_code = "abc-mnop-xyz"');
  records = [...records, { name: "conferenceRecords/running" }, { name: "conferenceRecords/new", endTime: end }];
  const later = await pollOnce("googlemeet.conference_ended", {}, first.seen, run);
  expect(later.fresh.map((f: any) => f.conference.name)).toEqual(["conferenceRecords/new"]);
});
