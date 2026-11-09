// The git route: which login it adds, what it refuses, and that a push waits for the person's OK. GitHub is faked.
import { afterAll, beforeAll, expect, mock, test } from "bun:test";
import Fastify from "fastify";

let logins = [{ label: "wrong", secret: "bad" }, { label: "right", secret: "good" }];
let ask = true;
let asked = 0;
// the rest of the module stays: a mock lasts for every test file in the run
const real = await import("./integrations");
mock.module("./integrations", () => ({
  ...real,
  gitLogins: async () => logins,
  appsCommand: async () => ({ text: "A Connect button shows.", card: { app: "github", name: "GitHub", path: "/connect/github" } }),
}));
const realApprovals = await import("./approvals");
mock.module("./approvals", () => ({ ...realApprovals, mustAsk: async () => ask, approve: async () => (asked++, null) }));
const realActivity = await import("./activity");
mock.module("./activity", () => ({ ...realActivity, record: () => {} }));
process.env.WEBHOOK_URL = "https://api.test";
const { gitAfter, gitForCommand, gitProxyRoutes, pushedRefs } = await import("./git-proxy");

const app = Fastify();
const s = { conversationId: "c", workspaceId: "w", role: "owner", user: { id: "u", name: "Asha" } } as never;
const sent: { url: string; auth?: string; body?: unknown }[] = [];
const realFetch = globalThis.fetch;
const pkt = (line: string) => (line.length + 4).toString(16).padStart(4, "0") + line;
const push = Buffer.from(`${pkt(`${"0".repeat(40)} ${"a".repeat(40)} refs/heads/main\0report-status`)}0000PACK`);

beforeAll(async () => {
  await app.register(gitProxyRoutes);
  globalThis.fetch = (async (url: string, init: { headers: Record<string, string>; body?: unknown }) => {
    const auth = init.headers.authorization;
    sent.push({ url, auth, body: init.body });
    const decoded = auth && Buffer.from(auth.split(" ")[1]!, "base64").toString();
    // private: only the "good" login; public/...: anyone
    const ok = url.includes("/public/") || decoded === "x-access-token:good";
    return new Response(ok ? "refs" : "no", { status: ok ? 200 : 401, headers: { "content-type": "application/x-git-upload-pack-advertisement" } });
  }) as never;
});
afterAll(() => {
  globalThis.fetch = realFetch;
});

const get = (token: string, repo: string, service = "git-upload-pack") => app.inject({ url: `/git/${token}/github.com/${repo}.git/info/refs?service=${service}` });
const post = (token: string, repo: string, body: Buffer) =>
  app.inject({ method: "POST", url: `/git/${token}/github.com/${repo}.git/git-receive-pack`, headers: { "content-type": "application/x-git-receive-pack-request" }, payload: body });

test("reads the branches a push changes", () => {
  expect(pushedRefs(push)).toEqual(["refs/heads/main"]);
  expect(pushedRefs(Buffer.from("0000"))).toEqual([]);
});

test("the command's git is rewritten to the route, in its environment only", () => {
  const { env, proxy } = gitForCommand(s)!;
  expect(env.GIT_CONFIG_COUNT).toBe("3");
  expect(env.GIT_CONFIG_KEY_0).toBe(`url.${proxy}github.com/.insteadOf`);
  expect([env.GIT_CONFIG_VALUE_0, env.GIT_CONFIG_VALUE_1, env.GIT_CONFIG_VALUE_2]).toEqual(["https://github.com/", "git@github.com:", "ssh://git@github.com/"]);
});

test("tries each connected account, and only reaches git's requests on known hosts", async () => {
  const { token } = gitForCommand(s)!;
  expect((await get(token, "me/private")).statusCode).toBe(200);
  expect(sent.at(-1)!.url).toBe("https://github.com/me/private.git/info/refs?service=git-upload-pack");
  expect(sent.length).toBe(2);
  expect((await app.inject({ url: `/git/${token}/evil.com/me/x/info/refs?service=git-upload-pack` })).statusCode).toBe(404);
  expect((await app.inject({ url: `/git/${token}/github.com/me/x/secrets?service=git-upload-pack` })).statusCode).toBe(404);
  expect((await app.inject({ url: `/git/${token}/github.com/../x/info/refs?service=git-upload-pack` })).statusCode).toBe(404);
  expect((await get("not-a-token", "me/private")).statusCode).toBe(404);
});

test("a dead token stops working after the command", async () => {
  const { token } = gitForCommand(s)!;
  await gitAfter(token, s);
  expect((await get(token, "me/private")).statusCode).toBe(404);
});

test("nothing connected: public repos still read, private ones bring the Connect button", async () => {
  logins = [];
  const { token } = gitForCommand(s)!;
  expect((await get(token, "public/x")).statusCode).toBe(200);
  expect(sent.at(-1)!.auth).toBeUndefined();
  expect((await get(token, "me/private")).statusCode).toBe(401);
  const after = await gitAfter(token, s);
  expect(after.cards.map((c) => c.app)).toEqual(["github"]);
  expect(after.notes[0]).toContain("no GitHub account is connected");
  logins = [{ label: "right", secret: "good" }];
});

test("a push waits for the OK, then goes once", async () => {
  ask = true;
  const first = gitForCommand(s)!;
  await get(first.token, "me/private", "git-receive-pack");
  const before = sent.length;
  expect((await post(first.token, "me/private", push)).statusCode).toBe(403);
  expect(sent.length).toBe(before);
  const after = await gitAfter(first.token, s);
  expect(asked).toBe(1);
  expect(after.notes[0]).toContain("Run the same git push again");

  const again = gitForCommand(s)!;
  await get(again.token, "me/private", "git-receive-pack");
  expect((await post(again.token, "me/private", push)).statusCode).toBe(200);
  expect(sent.at(-1)!.url).toBe("https://github.com/me/private.git/git-receive-pack");

  // the OK was for that one push
  const third = gitForCommand(s)!;
  await get(third.token, "me/private", "git-receive-pack");
  expect((await post(third.token, "me/private", push)).statusCode).toBe(403);
});
