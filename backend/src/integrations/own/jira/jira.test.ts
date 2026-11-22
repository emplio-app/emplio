import { afterEach, beforeAll, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { AppFile, AppsError } from "../../types";
import { pollConfig, pollOnce } from "../../polls";
import { own } from "../index";
import { triggers, wanted } from "./triggers";
import { jira, parseKey } from "./index";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});
beforeAll(() => {
  process.env.ENCRYPTION_KEY ??= "test-key";
  process.env.WEBHOOK_URL = "https://api.test";
});
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
type Call = { url: string; method: string; body: BodyInit | null | undefined; headers: Record<string, string> };
const stub = (answer: (c: Call) => Response) => {
  const calls: Call[] = [];
  globalThis.fetch = (async (url: string, init: RequestInit = {}) => {
    const c = { url: String(url), method: init.method ?? "GET", body: init.body, headers: init.headers as Record<string, string> };
    calls.push(c);
    return answer(c);
  }) as typeof fetch;
  return calls;
};
const KEY = "acme.atlassian.net asha@acme.com tok123";
const login = { externalId: "c1", secret: KEY };
const run = (a: string, i: unknown) => own.run(a, i as Record<string, unknown>, login, "o");
const token = () => createHmac("sha256", process.env.ENCRYPTION_KEY!).update("jira-webhook:c1").digest("hex");
const target = () => `https://api.test/webhooks/app/jira/c1/${token()}`;

test("the key is the site, email and token, in any order; a site outside Atlassian is refused", () => {
  expect(parseKey(KEY)).toEqual({ site: "acme.atlassian.net", email: "asha@acme.com", token: "tok123" });
  expect(parseKey(" tok123  https://acme.atlassian.net/jira/your-work asha@acme.com ")).toEqual(parseKey(KEY));
  expect(() => parseKey("evil.com asha@acme.com tok")).toThrow(AppsError);
  expect(() => parseKey("acme.atlassian.net tok")).toThrow(/site .*email .*API token/);
});

test("a login is checked against the site with basic auth and labelled; a bad one is refused as dead", async () => {
  const calls = stub(() => json({ displayName: "Asha", accountId: "a1" }));
  expect(await own.connectWithKey!("jira", KEY)).toEqual({ secret: KEY, label: "Asha (acme.atlassian.net)" });
  expect(calls[0]!.url).toBe("https://acme.atlassian.net/rest/api/3/myself");
  expect(calls[0]!.headers.Authorization).toBe(`Basic ${btoa("asha@acme.com:tok123")}`);
  stub(() => json({ errorMessages: ["Client must be authenticated"] }, 401));
  const refused = await own.connectWithKey!("jira", KEY).catch((e) => e);
  expect(refused).toBeInstanceOf(AppsError);
  expect(refused.expired).toBe(true);
});

test("reads run unasked, writes ask, and searching by POST is a read", async () => {
  expect((await own.getAction("jira.get_issue"))?.readOnly).toBe(true);
  expect((await own.getAction("jira.list_sprints"))?.readOnly).toBe(true);
  expect((await own.getAction("jira.search_for_issues_using_jql_post"))?.readOnly).toBe(true);
  for (const a of ["create_issue", "transition_issue", "delete_issue", "add_comment", "load_project_avatar", "update_plan"]) expect((await own.getAction(`jira.${a}`))?.readOnly).toBeFalsy();
});

test("plain text in a new issue or comment is turned into Jira's document format", async () => {
  const calls = stub(() => json({ id: "1", key: "S-1" }));
  await run("jira.create_issue", { fields: { summary: "Call Ravi", project: { key: "S" }, issuetype: { name: "Task" }, description: "first\n\nsecond" } });
  expect(calls[0]!.url).toStartWith("https://acme.atlassian.net/rest/api/3/issue?");
  expect(JSON.parse(String(calls[0]!.body)).fields.description).toEqual({
    type: "doc",
    version: 1,
    content: [
      { type: "paragraph", content: [{ type: "text", text: "first" }] },
      { type: "paragraph", content: [{ type: "text", text: "second" }] },
    ],
  });
  await run("jira.add_comment", { issueIdOrKey: "S-1", body: "done" });
  expect(calls[1]!.url).toBe("https://acme.atlassian.net/rest/api/3/issue/S-1/comment");
  expect(JSON.parse(String(calls[1]!.body)).body.content[0].content[0].text).toBe("done");
});

test("attachments go up as files under 'file', with the header Jira demands", async () => {
  const calls = stub(() => json([{ id: "9" }]));
  await run("jira.add_attachment", { issueIdOrKey: "S-1", file: [new AppFile("a.txt", "text/plain", new TextEncoder().encode("hi"))] });
  expect(calls[0]!.headers["X-Atlassian-Token"]).toBe("no-check");
  const form = calls[0]!.body as FormData;
  expect((form.get("file") as File).name).toBe("a.txt");
});

test("an avatar is sent as the picture itself, and a plan change as JSON Patch", async () => {
  const calls = stub(() => json({ id: "5" }));
  await run("jira.load_project_avatar", { projectIdOrKey: "S", size: 64, file: new AppFile("l.png", "image/png", new Uint8Array([1, 2])) });
  expect(calls[0]!.url).toBe("https://acme.atlassian.net/rest/api/3/project/S/avatar2?size=64");
  expect(calls[0]!.headers["Content-Type"]).toBe("image/png");
  await run("jira.update_plan", { planId: 3, operations: [{ op: "replace", path: "/name", value: "Q3" }] });
  expect(calls[1]!.method).toBe("PUT");
  expect(calls[1]!.headers["Content-Type"]).toBe("application/json-patch+json");
  expect(JSON.parse(String(calls[1]!.body))).toEqual([{ op: "replace", path: "/name", value: "Q3" }]);
});

const now = new Date().toISOString();
const old = "2020-01-01T00:00:00.000+0000";
test("new and changed issues are polled by JQL, and only real changes count", async () => {
  const calls = stub(() =>
    json({ issues: [{ id: "1", key: "S-1", fields: { created: now, updated: now } }, { id: "2", key: "S-2", fields: { created: old, updated: now } }] }),
  );
  const { config } = pollConfig("jira.issue_created", { project: 'SA"LES', jql: "priority = High" });
  const first = await pollOnce("jira.issue_created", config, [], run);
  const jql = new URL(calls[0]!.url).searchParams.get("jql");
  expect(jql).toBe('created >= -1d AND project = "SALES" AND (priority = High) ORDER BY created DESC');
  expect(first.fresh).toHaveLength(2);
  const changed = await pollOnce("jira.issue_updated", {}, [], run);
  expect(changed.fresh.map((i: any) => i.issue.key)).toEqual(["S-2"]);
});

test("comments are found on recently updated issues; an edit is a new event", async () => {
  stub(() =>
    json({
      issues: [{ id: "1", key: "S-1", fields: { summary: "x", comment: { comments: [{ id: "c1", created: now, updated: now }, { id: "c2", created: old, updated: now }, { id: "c3", created: old, updated: old }] } } }],
    }),
  );
  const made = await pollOnce("jira.comment_created", {}, [], run);
  expect(made.fresh.map((i: any) => i.comment.id)).toEqual(["c1"]);
  expect((made.fresh[0] as any).issue).toEqual({ id: "1", key: "S-1", fields: { summary: "x" } });
  const edited = await pollOnce("jira.comment_updated", {}, [], run);
  expect(edited.fresh.map((i: any) => i.comment.id)).toEqual(["c2"]);
});

test("a board's sprints are read page by page; starting and closing are their own events", async () => {
  const calls = stub((c) => {
    const at = Number(new URL(c.url).searchParams.get("startAt"));
    return json(at === 0 ? { isLast: false, values: [{ id: 1, state: "active" }] } : { isLast: true, values: [{ id: 2, state: "closed", completeDate: now }] });
  });
  const { config } = pollConfig("jira.sprint_closed", { board_id: "7" });
  const out = await pollOnce("jira.sprint_closed", config, [], run);
  expect(calls.map((c) => new URL(c.url).pathname)).toEqual(["/rest/agile/1.0/board/7/sprint", "/rest/agile/1.0/board/7/sprint"]);
  expect(new URL(calls[0]!.url).searchParams.get("state")).toBe("closed");
  expect(out.fresh.map((i: any) => i.sprint.id)).toEqual([2]);
  const seen = (await pollOnce("jira.sprint_started", config, null, run)).seen;
  expect(seen).toEqual(["1:started", "2:started"]);
});

test("a version being released is noticed once", async () => {
  stub(() => json([{ id: "10", name: "1.0", released: false }]));
  const first = await pollOnce("jira.version_released", { project: "S" }, null, run);
  stub(() => json([{ id: "10", name: "1.0", released: true }]));
  const next = await pollOnce("jira.version_released", { project: "S" }, first.seen, run);
  expect(next.fresh).toEqual([{ version: { id: "10", name: "1.0", released: true } }]);
  expect((await pollOnce("jira.version_released", { project: "S" }, next.seen, run)).fresh).toEqual([]);
});

test("the first webhook trigger registers one webhook for the connection, the next reuses it, and the last removes it", async () => {
  const none = stub((c) => (c.method === "GET" ? json([]) : json({ self: "https://acme.atlassian.net/rest/webhooks/1.0/webhook/42" })));
  expect(await own.startPush!("jira.issue_deleted", login, {})).toBe("jira:c1");
  expect(none[1]!.method).toBe("POST");
  expect(none[1]!.url).toBe("https://acme.atlassian.net/rest/webhooks/1.0/webhook");
  const body = JSON.parse(String(none[1]!.body));
  expect(body.url).toBe(target());
  expect(body.events).toContain("jira:issue_deleted");
  expect(body.events).toContain("comment_deleted");
  const hooks = [{ self: "https://acme.atlassian.net/rest/webhooks/1.0/webhook/7", url: "https://other" }, { self: "https://acme.atlassian.net/rest/webhooks/1.0/webhook/42", url: target() }];
  const same = stub(() => json(hooks));
  await own.startPush!("jira.version_deleted", login, {});
  expect(same).toHaveLength(1);
  const gone = stub((c) => (c.method === "GET" ? json(hooks) : new Response(null, { status: 204 })));
  await jira.push!.stop!(KEY, "jira:c1");
  expect(gone[1]!.method).toBe("DELETE");
  expect(gone[1]!.url).toBe("https://acme.atlassian.net/rest/webhooks/1.0/webhook/42");
});

test("someone who isn't a Jira admin is told so", async () => {
  stub((c) => (c.method === "GET" ? json({ errorMessages: ["no"] }, 403) : json({})));
  await expect(own.startPush!("jira.issue_deleted", login, {})).rejects.toThrow(/admin/);
});

const delivery = (body: unknown, rest = token(), headers: Record<string, string> = { "x-atlassian-webhook-identifier": "d1" }) => ({ body: JSON.stringify(body), headers, connection: "c1", rest });
test("a delivery with the wrong token is refused", async () => {
  expect(await jira.push!.receive!(delivery({ webhookEvent: "jira:issue_deleted" }, "nope"), KEY)).toBeNull();
  expect(await jira.push!.receive!(delivery({ webhookEvent: "jira:issue_deleted" }, ""), KEY)).toBeNull();
});

test("each event starts only its trigger, without Jira's link clutter, and a retry has the same id", async () => {
  const cases: [string, string][] = [
    ["jira:issue_deleted", "issue_deleted"],
    ["comment_deleted", "comment_deleted"],
    ["jira:version_deleted", "version_deleted"],
    ["jira:version_merged", "version_merged"],
    ["jira:version_moved", "version_moved"],
    ["jira:version_unreleased", "version_unreleased"],
  ];
  for (const [event, want] of cases) {
    const [out] = await (await jira.push!.receive!(delivery({ webhookEvent: event, issue: { key: "S-1", self: "https://x" } }), KEY))!.events();
    expect(out!.triggers).toEqual([want]);
    expect(out!.id).toBe("c1:d1");
    expect((out!.data as any).issue).toEqual({ key: "S-1" });
  }
  expect(await (await jira.push!.receive!(delivery({ webhookEvent: "jira:issue_created" }), KEY))!.events()).toEqual([]);
});

test("a project filter matches an issue's project key or id, or a version's project", () => {
  const issue = { issue: { fields: { project: { id: "100", key: "SALES" } } } };
  expect(wanted({}, issue)).toBe(true);
  expect(wanted({ project: "sales" }, issue)).toBe(true);
  expect(wanted({ project: "100" }, issue)).toBe(true);
  expect(wanted({ project: "OPS" }, issue)).toBe(false);
  expect(wanted({ project: "100" }, { version: { projectId: 100 } })).toBe(true);
});

test("webhook and polled triggers don't overlap, and between them cover Composio's", async () => {
  const polled = (await import("../../polls/jira")).jira;
  for (const t of Object.keys(triggers)) expect(polled[t]).toBeUndefined();
  expect([...Object.keys(triggers), ...Object.keys(polled)].sort()).toEqual(
    ["comment_created", "comment_deleted", "comment_updated", "issue_created", "issue_deleted", "issue_updated", "sprint_closed", "sprint_created", "sprint_started", "sprint_updated", "version_created", "version_deleted", "version_merged", "version_moved", "version_released", "version_unreleased", "version_updated"],
  );
});
