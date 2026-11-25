import { afterEach, expect, test } from "bun:test";
import { AppsError } from "../../types";
import { tldv as polls } from "../../polls/tldv";
import { tldv } from "./index";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
type Call = {
  url: string;
  method: string;
  body: string;
  headers: Record<string, string>;
  redirect?: string;
};
const stub = (answer: (c: Call) => Response) => {
  const calls: Call[] = [];
  globalThis.fetch = (async (url: string, init: RequestInit = {}) => {
    const c = {
      url: String(url),
      method: init.method ?? "GET",
      body: String(init.body ?? ""),
      headers: init.headers as Record<string, string>,
      redirect: init.redirect,
    };
    calls.push(c);
    return answer(c);
  }) as typeof fetch;
  return calls;
};

const run = (action: string, input: unknown = {}) => {
  const a = tldv.actions[action]!;
  return a.run(a.input.parse(input), "tldv_key");
};
const pollRun = (action: string, input: unknown) => run(action.replace("tldv.", ""), input);
const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();

test("a key is checked with x-api-key and our own User-Agent; a bad one is refused as dead", async () => {
  const calls = stub(() => json({ page: 1, pages: 0, total: 0, pageSize: 1, results: [] }));
  await tldv.check("tldv_key");
  expect(calls[0]!.url).toBe("https://pasta.tldv.io/v1alpha1/meetings?limit=1");
  expect(calls[0]!.headers["x-api-key"]).toBe("tldv_key");
  expect(calls[0]!.headers["User-Agent"]).toStartWith("Emplio");
  stub(() => json({ name: "UnauthorizedError", message: "Invalid API key" }, 401));
  const refused = await tldv.check("nope").catch((e) => e);
  expect(refused).toBeInstanceOf(AppsError);
  expect(refused.expired).toBe(true);
});

test("every operation of the spec but the deprecated highlights is an action", () => {
  expect(Object.keys(tldv.actions).sort()).toEqual(
    [
      "abort_recording_upload",
      "check_health",
      "complete_recording_upload",
      "download_meeting_recording",
      "get_meeting",
      "get_meeting_notes",
      "get_meeting_transcript",
      "get_recording_upload",
      "import_meeting",
      "list_meetings",
      "search_folders",
      "start_recording_upload",
    ].sort(),
  );
});

test("reads run unasked; imports and uploads ask first", () => {
  const a = tldv.actions;
  for (const n of [
    "list_meetings",
    "get_meeting",
    "get_meeting_notes",
    "get_meeting_transcript",
    "download_meeting_recording",
    "search_folders",
    "check_health",
    "get_recording_upload",
  ])
    expect(a[n]!.readOnly).toBe(true);
  for (const n of ["import_meeting", "start_recording_upload", "complete_recording_upload", "abort_recording_upload"]) expect(a[n]!.readOnly).toBe(false);
});

test("meeting filters go in the query; an import posts its fields", async () => {
  const calls = stub(() => json({ success: true, jobId: "j1" }));
  await run("list_meetings", {
    query: "pricing",
    meetingType: "external",
    limit: 10,
  });
  expect(calls[0]!.url).toBe("https://pasta.tldv.io/v1alpha1/meetings?query=pricing&limit=10&meetingType=external");
  await run("import_meeting", {
    name: "Call with Sarah",
    url: "https://example.com/call.mp4",
    participants: ["sarah@northwind.com"],
  });
  expect(calls[1]!.method).toBe("POST");
  expect(JSON.parse(calls[1]!.body)).toEqual({
    name: "Call with Sarah",
    url: "https://example.com/call.mp4",
    participants: ["sarah@northwind.com"],
  });
});

test("a recording comes back as its signed link, not followed", async () => {
  const calls = stub(
    () =>
      new Response(null, {
        status: 302,
        headers: { location: "https://files.tldv.io/rec.mp4?sig=x" },
      }),
  );
  expect(await run("download_meeting_recording", { meetingId: "m1" })).toEqual({
    url: "https://files.tldv.io/rec.mp4?sig=x",
    expires_in_hours: 6,
  });
  expect(calls[0]!.redirect).toBe("manual");
  expect(calls[0]!.url).toBe("https://pasta.tldv.io/v1alpha1/meetings/m1/download");
  stub(() => json({ name: "NotFoundError", message: "Meeting not found" }, 404));
  expect(((await run("download_meeting_recording", { meetingId: "nope" }).catch((e) => e)) as AppsError).message).toBe("tl;dv: Meeting not found (404)");
});

const meetings = {
  results: [
    { id: "m1", name: "Standup", happenedAt: ago(20) },
    { id: "m2", name: "Review", happenedAt: ago(10) },
    { id: "old", name: "Last week", happenedAt: ago(9000) },
  ],
};

test("meeting_ready: the last day's meetings, with the filter passed on", async () => {
  const calls = stub(() => json(meetings));
  const items = await polls.meeting_ready!.poll({ meetingType: "internal" }, pollRun);
  expect(items.map((i) => i.id)).toEqual(["m1", "m2"]);
  expect(calls[0]!.url).toContain("meetingType=internal");
  expect(calls[0]!.url).toContain("from=");
});

test("transcript_ready: only meetings whose transcript is there, carrying it", async () => {
  stub((c) =>
    c.url.includes("/m1/transcript")
      ? json({
          id: "t1",
          meetingId: "m1",
          data: [{ speaker: "Sarah", text: "Hello", startTime: 0, endTime: 2 }],
        })
      : c.url.includes("/m2/transcript")
        ? json({ name: "NotFoundError", message: "Transcript not ready" }, 404)
        : json(meetings),
  );
  const items = await polls.transcript_ready!.poll({}, pollRun);
  expect(items.map((i) => i.id)).toEqual(["m1"]);
  expect((items[0]!.item as any).transcript.data[0].speaker).toBe("Sarah");
});
