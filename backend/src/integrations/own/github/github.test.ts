import { afterEach, beforeAll, expect, test } from "bun:test";
import { AppFile, AppsError } from "../../types";
import { own } from "../index";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  delete process.env.GITHUB_CLIENT_ID;
  delete process.env.GITHUB_CLIENT_SECRET;
});
beforeAll(() => {
  process.env.ENCRYPTION_KEY ??= "test-key";
});
const oauthOn = () => {
  process.env.GITHUB_CLIENT_ID = "id";
  process.env.GITHUB_CLIENT_SECRET = "shh";
};
const BACK = "https://api.test/connections/abc/done?popup=1";
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

test("a pasted token is checked, and labelled with whose it is", async () => {
  const seen: Record<string, string>[] = [];
  globalThis.fetch = (async (_url: string, init: RequestInit) => (seen.push(init.headers as Record<string, string>), json({ login: "octo" }))) as typeof fetch;
  expect(await own.connectWithKey!("github", " ghp_x ")).toEqual({ secret: "ghp_x", label: "octo" });
  expect(seen[0]!.Authorization).toBe("Bearer ghp_x");
});

test("a bad token is refused", async () => {
  globalThis.fetch = (async () => json({ message: "Bad credentials" }, 401)) as unknown as typeof fetch;
  await expect(own.connectWithKey!("github", "nope")).rejects.toBeInstanceOf(AppsError);
});

test("sign-in is offered only with the OAuth app's settings", async () => {
  expect((await own.getApp("github"))?.signIn).toBeUndefined();
  await expect(own.startSignIn("github", "o", BACK)).rejects.toBeInstanceOf(AppsError);
  oauthOn();
  expect((await own.getApp("github"))?.signIn).toBe(true);
});

test("a sign-in round trip: waits, comes back on the same address, can't be forged", async () => {
  oauthOn();
  const { externalId, url } = await own.startSignIn("github", "o", BACK);
  expect(await own.signInStatus(externalId)).toBe("pending");
  const sent = new URL(url);
  expect(sent.origin).toBe("https://github.com");
  expect(sent.searchParams.get("redirect_uri")).toBe("https://api.test/oauth/github/callback");
  expect(sent.searchParams.get("prompt")).toBe("select_account");
  expect(sent.searchParams.get("scope")).toContain("repo");

  const state = sent.searchParams.get("state")!;
  expect(own.readSignIn!("github", state)).toEqual({ externalId, back: BACK });
  expect(own.readSignIn!("gmail", state)).toBeNull();
  const [payload] = state.split(".");
  expect(own.readSignIn!("github", `${payload}.forged`)).toBeNull();

  const bodies: any[] = [];
  globalThis.fetch = (async (u: string, init: RequestInit) => {
    if (u.includes("/login/oauth/access_token")) return bodies.push(JSON.parse(init.body as string)), json({ access_token: "gho_real" });
    return json({ login: "octo" });
  }) as typeof fetch;
  expect(await own.finishSignIn!("github", "code1", BACK)).toEqual({ secret: "gho_real", label: "octo" });
  expect(bodies[0]).toEqual({ client_id: "id", client_secret: "shh", code: "code1", redirect_uri: "https://api.test/oauth/github/callback" });
  expect(await own.signInStatus("some-connection-id")).toBe("active");
});

test("a refused code says why", async () => {
  oauthOn();
  globalThis.fetch = (async () => json({ error: "bad_verification_code", error_description: "The code is incorrect." })) as unknown as typeof fetch;
  await expect(own.finishSignIn!("github", "old", BACK)).rejects.toThrow("The code is incorrect.");
});

test("actions: reads run unasked, writes ask, a file comes back under its own name", async () => {
  expect((await own.getAction("github.get_a_tree"))?.readOnly).toBe(true);
  expect((await own.getAction("github.create_a_pull_request"))?.readOnly).toBe(false);
  let accept = "";
  let at = "";
  globalThis.fetch = (async (u: string, init: RequestInit) => {
    at = u;
    accept = (init.headers as Record<string, string>).Accept!;
    return new Response("X=1", { headers: { "content-type": "application/vnd.github.raw" } });
  }) as typeof fetch;
  const file = await own.run("github.get_raw_repository_content", { owner: "o", repo: "r", path: "backend/.env.example", ref: "main" }, { externalId: "x", secret: "t" }, "o");
  expect(file).toBeInstanceOf(AppFile);
  expect((file as AppFile).name).toBe(".env.example");
  expect(accept).toBe("application/vnd.github.raw");
  expect(at).toBe("https://api.github.com/repos/o/r/contents/backend%2F.env.example?ref=main");
});

test("a guessed action name is worded so the closest real ones come back", async () => {
  await expect(own.run("github.nope", {}, { externalId: "x", secret: "t" }, "o")).rejects.toThrow(/^Tool \S+ not found/);
});
