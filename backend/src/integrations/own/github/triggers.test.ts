import { afterEach, beforeAll, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import Fastify from "fastify";
import { automationRoutes } from "../../../automations";
import { pollOnce } from "../../polls";
import { AppsError } from "../../types";
import { own } from "../index";
import { eventData, events, triggersFor, unwatch, wanted, watchId, webhookSecret } from "./triggers";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});
beforeAll(() => {
  process.env.ENCRYPTION_KEY = "k";
  process.env.WEBHOOK_URL = "https://api.test";
});

type Call = { url: string; method: string; body: any };
const stub = (hooks: unknown[]) => {
  const calls: Call[] = [];
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    calls.push({ url: String(url), method: init.method ?? "GET", body: init.body ? JSON.parse(init.body as string) : undefined });
    return new Response(init.method === "GET" || !init.method ? JSON.stringify(hooks) : "{}", { headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return calls;
};
const URL_ = "https://api.test/webhooks/github/c1/octo/app";
const login = { externalId: "c1", secret: "t" };
const config = { owner: "Octo", repo: "App" };

test("saving an automation puts one signed webhook on the repository, with only the event it needs", async () => {
  const calls = stub([]);
  expect(await own.startPush!("github.issue_created_trigger", login, config)).toBe(watchId("c1", "octo", "app"));
  expect(calls[1]!.method).toBe("POST");
  expect(calls[1]!.url).toBe("https://api.github.com/repos/octo/app/hooks");
  expect(calls[1]!.body).toEqual({ name: "web", active: true, events: ["issues"], config: { url: URL_, content_type: "json", secret: webhookSecret("c1") } });
});

test("the next trigger adds to that webhook, and an event it has needs no call", async () => {
  const hook = { id: 7, active: true, events: ["issues"], config: { url: URL_ } };
  const add = stub([hook]);
  await own.startPush!("github.commit_event", login, config);
  expect(add[1]!.method).toBe("PATCH");
  expect(add[1]!.url).toEndWith("/hooks/7");
  expect(add[1]!.body).toEqual({ add_events: ["push"], active: true });
  const none = stub([hook]);
  await own.startPush!("github.issue_updated_trigger", login, config);
  expect(none).toHaveLength(1);
});

test("a repository is required, and a refusal says what's needed", async () => {
  await expect(own.startPush!("github.commit_event", login, {})).rejects.toBeInstanceOf(AppsError);
  globalThis.fetch = (async () => new Response(JSON.stringify({ message: "Not Found" }), { status: 404 })) as unknown as typeof fetch;
  await expect(own.startPush!("github.commit_event", login, config)).rejects.toThrow(/must be an admin/);
});

test("the last automation gone takes the webhook off", async () => {
  const calls = stub([{ id: 7, active: true, events: ["issues"], config: { url: URL_ } }]);
  await unwatch({ name: "GitHub", base: "https://api.github.com", tokenHelp: "" }, "t", watchId("c1", "octo", "app"));
  expect(calls[1]!.method).toBe("DELETE");
  expect(calls[1]!.url).toEndWith("/repos/octo/app/hooks/7");
});

test("each event starts only the triggers it means", () => {
  expect(triggersFor("issues", { action: "opened" })).toEqual(["github.issue_created_trigger", "github.issue_added_event", "github.issue_event_occurred_trigger"]);
  expect(triggersFor("issues", { action: "closed" })).toContain("github.issue_updated_trigger");
  expect(triggersFor("issues", { action: "closed" })).not.toContain("github.issue_created_trigger");
  expect(triggersFor("create", { ref_type: "tag" })).toContain("github.repository_tag_created_trigger");
  expect(triggersFor("create", { ref_type: "tag" })).not.toContain("github.branch_created_trigger");
  expect(triggersFor("push", { commits: [{ modified: ["src/a.ts"] }] })).not.toContain("github.readme_changed_trigger");
  expect(triggersFor("push", { commits: [{ modified: ["docs/README.md"] }] })).toContain("github.readme_changed_trigger");
  expect(triggersFor("ping", {})).toEqual([]);
});

test("an automation's settings narrow what runs it", () => {
  const push = { ref: "refs/heads/main", commits: [{ added: ["src/a.ts"] }] };
  expect(wanted({ owner: "o", repo: "r" }, push)).toBe(true);
  expect(wanted({ branch: "main" }, push)).toBe(true);
  expect(wanted({ branch: "dev" }, push)).toBe(false);
  expect(wanted({ path: "src" }, push)).toBe(true);
  expect(wanted({ path: "sr" }, push)).toBe(false);
  expect(wanted({ issue_number: 5 }, { issue: { number: 5 } })).toBe(true);
  expect(wanted({ issue_number: 5 }, { issue: { number: 6 } })).toBe(false);
  expect(wanted({ prefix: "v" }, { ref: "v1.0" })).toBe(true);
});

test("the event loses GitHub's API links and keeps the page's", () => {
  expect(eventData({ issue: { html_url: "h", comments_url: "c", node_id: "n", user: [{ avatar_url: "a", login: "o" }] } })).toEqual({ issue: { html_url: "h", user: [{ login: "o" }] } });
});

test("every setting is described, and the repository is asked for", async () => {
  const t = await own.getTrigger!("github.commit_event");
  expect(t?.input.map((i) => [i.name, i.required])).toEqual([["owner", true], ["repo", true], ["branch", false], ["path", false]]);
  expect(Object.keys(events).every((n) => n.length > 0)).toBe(true);
});

test("what GitHub has no webhook for is polled", async () => {
  const run = async () => [{ id: 1, login: "a" }];
  const first = await pollOnce("github.follower_event", {}, null, run);
  expect(first.fresh).toEqual([]);
  const next = await pollOnce("github.follower_event", {}, first.seen, async () => [{ id: 2, login: "b" }, { id: 1, login: "a" }]);
  expect(next.fresh).toEqual([{ follower: { id: 2, login: "b" } }]);
});

test("the webhook route takes only GitHub's signature", async () => {
  const app = Fastify();
  await automationRoutes(app);
  const body = JSON.stringify({ zen: "hi" });
  const post = (signature: string) =>
    app.inject({ method: "POST", url: "/webhooks/github/c1/octo/app", headers: { "content-type": "application/json", "x-github-event": "ping", "x-hub-signature-256": signature }, payload: body });
  const sign = (secret: string) => `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
  expect((await post(sign(webhookSecret("c1")))).statusCode).toBe(200);
  expect((await post(sign(webhookSecret("other")))).statusCode).toBe(401);
  expect((await post("")).statusCode).toBe(401);
  await app.close();
});
