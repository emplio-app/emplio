import { afterEach, beforeAll, expect, test } from "bun:test";
import { AppsError } from "../../types";
import { meetgeek as polls } from "../../polls/meetgeek";
import { meetgeek } from "./index";
import { hookToken } from "./triggers";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});
beforeAll(() => {
  process.env.ENCRYPTION_KEY ??= "test-key";
  process.env.WEBHOOK_URL = "https://api.test";
});
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
type Call = { url: string; method: string; body: string; headers: Record<string, string> };
const stub = (answer: (c: Call) => Response) => {
  const calls: Call[] = [];
  globalThis.fetch = (async (url: string, init: RequestInit = {}) => {
    const c = { url: String(url), method: init.method ?? "GET", body: String(init.body ?? ""), headers: init.headers as Record<string, string> };
    calls.push(c);
    return answer(c);
  }) as typeof fetch;
  return calls;
};
const run = (action: string, input: Record<string, unknown>, key = "k1", connection?: string) => {
  const a = meetgeek.actions[action]!;
  return a.run(a.input.parse(input), key, connection);
};
const delivery = (body: unknown, token = hookToken("c1")) => ({ body: JSON.stringify(body), headers: {}, connection: "c1", rest: token });

test("the key is checked with Bearer, a US key goes to the US host, a bad one is dead", async () => {
  const calls = stub(() => json({ share_access: [], view_access: [] }));
  await meetgeek.check("k1");
  expect(calls[0]!.url).toBe("https://api.meetgeek.ai/v1/teams");
  expect(calls[0]!.headers.Authorization).toBe("Bearer k1");
  await meetgeek.check("us:k2");
  expect(calls[1]!.url).toBe("https://api-us.meetgeek.ai/v1/teams");
  expect(calls[1]!.headers.Authorization).toBe("Bearer k2");
  stub(() => json({ message: "unauthorized", reason: "invalid api key" }, 401));
  const refused = await meetgeek.check("nope").catch((e) => e);
  expect(refused).toBeInstanceOf(AppsError);
  expect(refused.expired).toBe(true);
});

test("calls follow the reference: paging in the query, uploads and the bot in the body", async () => {
  const calls = stub(() => json({ ok: true }));
  await run("get_transcript", { meetingId: "m1", limit: 100, cursor: "abc" });
  expect(calls[0]!.url).toBe("https://api.meetgeek.ai/v1/meetings/m1/transcript?limit=100&cursor=abc");
  await run("upload_recording", { download_url: "https://files.test/call.mp4", template_name: "Product demo" });
  expect(JSON.parse(calls[1]!.body)).toEqual({ download_url: "https://files.test/call.mp4", template_name: "Product demo" });
  await run("join_meeting_bot", { join_link: "https://meet.google.com/abc-defg-hij" });
  expect(`${calls[2]!.method} ${calls[2]!.url}`).toBe("POST https://api.meetgeek.ai/v1/bot/join");
  await run("list_team_meetings", { teamId: 101437 });
  expect(calls[3]!.url).toBe("https://api.meetgeek.ai/v1/teams/101437/meetings");
});

test("reads run unasked, writes ask", () => {
  for (const a of ["list_meetings", "get_meeting", "get_transcript", "get_summary", "get_highlights", "get_insights", "download_recording", "list_teams", "list_team_meetings", "get_webhook_setup"]) expect(meetgeek.actions[a]?.readOnly).toBe(true);
  for (const a of ["delete_meeting", "upload_recording", "join_meeting_bot"]) expect(meetgeek.actions[a]?.readOnly).toBeFalsy();
});

test("the webhook address is handed to the owner, and triggers wait on the connection", async () => {
  const setup = (await run("get_webhook_setup", {}, "k1", "c1")) as { webhook_url: string };
  expect(setup.webhook_url).toBe(`https://api.test/webhooks/app/meetgeek/c1/${hookToken("c1")}`);
  expect(await meetgeek.push!.start("k1", "c1", "File analyzed successfully", {})).toBe("meetgeek:c1");
});

test("a wrong token is refused; a finished meeting comes with its summary and highlights; a failure starts its own trigger", async () => {
  expect(await meetgeek.push!.receive!(delivery({ meeting_id: "m1" }, "wrong"), "k1")).toBeNull();
  const calls = stub((c) =>
    json(c.url.endsWith("/summary") ? { summary: "Agreed on pricing", ai_insights: "Clear" } : c.url.endsWith("/highlights") ? { highlights: [{ label: "Task", highlightText: "Sarah sends the quote" }] } : { title: "Northwind demo" }),
  );
  const [ok] = await (await meetgeek.push!.receive!(delivery({ message: "File analyzed successfully", meeting_id: "m1" }), "k1"))!.events();
  expect(ok).toEqual({
    id: "meetgeek:c1:m1",
    triggers: ["meeting_analyzed"],
    data: { meeting_id: "m1", meeting: { title: "Northwind demo" }, summary: "Agreed on pricing", ai_insights: "Clear", highlights: [{ label: "Task", highlightText: "Sarah sends the quote" }] },
  });
  expect(calls.every((c) => c.headers.Authorization === "Bearer k1")).toBe(true);
  const [failed] = await (await meetgeek.push!.receive!(delivery({ message: "File analyzed failed" }), "k1"))!.events();
  expect(failed!.triggers).toEqual(["analysis_failed"]);
});

test("the poll reports meetings that ended in the last day, for one team when asked", async () => {
  const now = new Date().toISOString();
  const asked: [string, unknown][] = [];
  const pollRun = async (action: string, input: unknown) => {
    asked.push([action, input]);
    return { meetings: [{ meeting_id: "new", timestamp_end_utc: now }, { meeting_id: "old", timestamp_end_utc: "2020-01-01T00:00:00Z" }] };
  };
  expect((await polls.new_meeting!.poll({}, pollRun)).map((i) => i.id)).toEqual(["new"]);
  await polls.new_meeting!.poll({ team_id: 7 }, pollRun);
  expect(asked[1]).toEqual(["meetgeek.list_team_meetings", { teamId: 7, limit: 50 }]);
});
