import { afterEach, beforeAll, expect, test } from "bun:test";
import { AppFile, AppsError } from "../../types";
import { wordpress as polls } from "../../polls/wordpress";
import { APPS, own } from "../index";
import { parseKey, wordpress } from "./index";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  delete process.env.WORDPRESS_CLIENT_ID;
  delete process.env.WORDPRESS_CLIENT_SECRET;
});
beforeAll(() => {
  process.env.ENCRYPTION_KEY ??= "test-key";
  // until it's listed in own/index.ts
  APPS.wordpress ??= wordpress;
});
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
type Seen = { url: string; init: RequestInit };
const fake = (answer: (s: Seen) => Response) => {
  const seen: Seen[] = [];
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    const s = { url: String(url), init };
    seen.push(s);
    return answer(s);
  }) as typeof fetch;
  return seen;
};
const KEY = "https://example.com admin abcd EFGH 1234 ijkl MNOP 5678";
const login = { externalId: "c1", secret: KEY };
const auth = (s: Seen) => (s.init.headers as Record<string, string>).Authorization;

test("the key: address, username (spaces allowed) and the password as WordPress shows it", () => {
  expect(parseKey(KEY)).toEqual({ kind: "site", site: "https://example.com", user: "admin", password: "abcdEFGH1234ijklMNOP5678" });
  expect(parseKey("example.com/blog/wp-admin/ Jane Doe abcdEFGH1234ijklMNOP5678")).toEqual({ kind: "site", site: "https://example.com/blog", user: "Jane Doe", password: "abcdEFGH1234ijklMNOP5678" });
  expect(parseKey("wpcom 123 tok")).toEqual({ kind: "wpcom", blog: "123", token: "tok" });
  for (const bad of ["https://example.com admin", "http://example.com admin pass", "https://localhost a b", "https://192.168.1.5 a b", "https://169.254.169.254 a b", "https://[::1] a b"])
    expect(() => parseKey(bad)).toThrow(AppsError);
});

test("a pasted key is checked on the site, and labelled with whose it is", async () => {
  const seen = fake(() => json({ id: 1, name: "Admin" }));
  expect(await own.connectWithKey!("wordpress", ` ${KEY} `)).toEqual({ secret: KEY, label: "Admin on example.com" });
  expect(seen[0]!.url).toBe("https://example.com/wp-json/wp/v2/users/me?context=edit");
  expect(auth(seen[0]!)).toBe(`Basic ${Buffer.from("admin:abcdEFGH1234ijklMNOP5678").toString("base64")}`);
});

test("a wrong password is refused, and a site with no REST API says what to change", async () => {
  fake(() => json({ code: "incorrect_password", message: "The provided password is an invalid application password." }, 401));
  await expect(own.connectWithKey!("wordpress", KEY)).rejects.toThrow(/Application Password/);
  fake(() => new Response("<html>not found</html>", { status: 404, headers: { "content-type": "text/html" } }));
  await expect(own.connectWithKey!("wordpress", KEY)).rejects.toThrow(/Permalinks/);
  fake(() => new Response("<html>a page</html>", { headers: { "content-type": "text/html" } }));
  await expect(own.connectWithKey!("wordpress", KEY)).rejects.toThrow(/didn't answer like a WordPress site/);
});

test("WordPress.com sign-in: offered only with the app's settings, round trip, can't be forged", async () => {
  const BACK = "https://api.test/connections/abc/done?popup=1";
  expect((await own.getApp("wordpress"))?.signIn).toBeUndefined();
  process.env.WORDPRESS_CLIENT_ID = "id";
  process.env.WORDPRESS_CLIENT_SECRET = "shh";
  expect((await own.getApp("wordpress"))?.signIn).toBe(true);
  const { url } = await own.startSignIn("wordpress", "o", BACK);
  const sent = new URL(url);
  expect(`${sent.origin}${sent.pathname}`).toBe("https://public-api.wordpress.com/oauth2/authorize");
  expect(sent.searchParams.get("redirect_uri")).toBe("https://api.test/oauth/wordpress/callback");
  const state = sent.searchParams.get("state")!;
  expect(own.readSignIn!("wordpress", `${state.split(".")[0]}.forged`)).toBeNull();

  const seen = fake((s) => (s.url.endsWith("/oauth2/token") ? json({ access_token: "tok", blog_id: 123, blog_url: "https://x.wordpress.com" }) : json({ name: "Jane" })));
  expect(await own.finishSignIn!("wordpress", "code1", BACK)).toMatchObject({ secret: "wpcom 123 tok", label: "Jane" });
  expect(String(seen[0]!.init.body)).toContain("grant_type=authorization_code");
  expect(seen[1]!.url).toBe("https://public-api.wordpress.com/wp/v2/sites/123/users/me?context=edit");
  expect(auth(seen[1]!)).toBe("Bearer tok");
});

test("actions: reads run unasked, writes ask", async () => {
  for (const r of ["list_posts", "get_site_settings", "list_plugins", "call_api_get", "get_visit_stats"]) expect((await own.getAction(`wordpress.${r}`))?.readOnly).toBe(true);
  for (const w of ["create_post", "update_site_settings", "update_plugin", "delete_comment", "create_media", "call_api", "create_user_application_password"])
    expect((await own.getAction(`wordpress.${w}`))?.readOnly).toBeFalsy();
});

test("calls: lists go comma-separated, plugin ids keep their slash, WordPress.com goes through its API", async () => {
  const seen = fake(() => json([]));
  await own.run("wordpress.list_posts", { categories: [1, 2], per_page: 5 }, login, "o");
  const list = new URL(seen[0]!.url);
  expect(`${list.origin}${list.pathname}`).toBe("https://example.com/wp-json/wp/v2/posts");
  expect(list.searchParams.get("categories")).toBe("1,2");
  expect(list.searchParams.get("per_page")).toBe("5");
  await own.run("wordpress.update_plugin", { plugin: "akismet/akismet", status: "active" }, login, "o");
  expect(seen[1]!.url).toBe("https://example.com/wp-json/wp/v2/plugins/akismet/akismet");
  expect(seen[1]!.init.method).toBe("POST");
  expect(JSON.parse(String(seen[1]!.init.body))).toEqual({ status: "active" });
  await own.run("wordpress.update_post", { id: 7, title: "Hello", status: "publish" }, { externalId: "c2", secret: "wpcom 123 tok" }, "o");
  expect(seen[2]!.url).toBe("https://public-api.wordpress.com/wp/v2/sites/123/posts/7");
});

test("a new media item is uploaded as a file", async () => {
  const seen = fake(() => json({ id: 9, source_url: "https://example.com/a.png" }, 201));
  await own.run("wordpress.create_media", { file: new AppFile("a.png", "image/png", new Uint8Array([1, 2])), alt_text: "logo" }, login, "o");
  const form = seen[0]!.init.body as FormData;
  expect(form.get("file")).toBeInstanceOf(Blob);
  expect(form.get("alt_text")).toBe("logo");
});

test("any route, for plugins; stats need the WordPress.com sign-in", async () => {
  const seen = fake(() => json({ ok: 1 }));
  await own.run("wordpress.call_api_get", { path: "/wc/v3/orders?status=processing", query: { per_page: 5 } }, login, "o");
  expect(seen[0]!.url).toBe("https://example.com/wp-json/wc/v3/orders?status=processing&per_page=5");
  await own.run("wordpress.call_api", { method: "POST", path: "/wc/v3/products", body: { name: "Tea" } }, login, "o");
  expect(JSON.parse(String(seen[1]!.init.body))).toEqual({ name: "Tea" });
  await expect(own.run("wordpress.call_api_get", { path: "/../wp-login.php" }, login, "o")).rejects.toBeInstanceOf(AppsError);
  await expect(own.run("wordpress.get_visit_stats", {}, login, "o")).rejects.toThrow(/WordPress.com/);
  await own.run("wordpress.get_stats_report", { report: "top-posts", period: "week" }, { externalId: "c2", secret: "wpcom 123 tok" }, "o");
  expect(seen.at(-1)!.url).toBe("https://public-api.wordpress.com/rest/v1.1/sites/123/stats/top-posts?period=week");
});

test("polls: new items by id, changes by id and modified time, filters sent to WordPress", async () => {
  const calls: [string, any][] = [];
  const run = async (action: string, input: any) => (calls.push([action, input]), [{ id: 1, modified_gmt: "2026-11-16T08:00:00" }]);
  expect(await polls.new_post!.poll({}, run)).toEqual([{ id: "1", item: { post: { id: 1, modified_gmt: "2026-11-16T08:00:00" } } }]);
  expect((await polls.post_updated!.poll({ status: ["publish"] }, run))[0]!.id).toBe("1:2026-11-16T08:00:00");
  expect(calls[1]).toEqual(["wordpress.list_posts", { status: ["publish"], orderby: "modified", order: "desc", per_page: 50, context: "edit" }]);
  await polls.new_comment!.poll({ post: 4 }, run);
  expect(calls[2]![1]).toMatchObject({ status: "all", post: [4] });
  // every action a poll calls exists
  for (const [action] of calls) expect(await own.getAction(action)).not.toBeNull();
  for (const a of ["wordpress.list_pages", "wordpress.list_users", "wordpress.list_media"]) expect(await own.getAction(a)).not.toBeNull();
});
