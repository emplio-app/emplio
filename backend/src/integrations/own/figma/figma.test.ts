import { afterEach, beforeAll, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { AppFile, AppsError } from "../../types";
import { own } from "../index";
import { pollTrigger } from "../../polls/index";
import { triggers, wanted } from "./triggers";
import { figma } from "./index";

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
    const c = { url: String(url), method: init.method ?? "GET", body: String(init.body ?? ""), headers: (init.headers ?? {}) as Record<string, string> };
    calls.push(c);
    return answer(c);
  }) as typeof fetch;
  return calls;
};
const login = { externalId: "c1", secret: "tok" };
const spot = "file-AbC123-FILE_COMMENT";
const target = `https://api.test/webhooks/app/figma/c1/${spot}`;
const passcode = (s = spot) => createHmac("sha256", process.env.ENCRYPTION_KEY!).update(`figma-webhook:c1:${s}`).digest("hex");
const delivery = (body: unknown, s = spot) => ({ body: JSON.stringify(body), headers: {}, connection: "c1", rest: s });
const fire = async (body: Record<string, unknown>, s = spot) => (await (await figma.push!.receive!(delivery({ passcode: passcode(s), ...body }, s), "k"))!.events())[0]?.triggers ?? [];

test("a token is checked with X-Figma-Token and labelled, and a bad one is refused as dead", async () => {
  const calls = stub(() => json({ id: "1", handle: "Sarah", email: "sarah@northwind.com" }));
  expect(await own.connectWithKey!("figma", " tok ")).toEqual({ secret: "tok", label: "Sarah (sarah@northwind.com)" });
  expect(calls[0]!.url).toBe("https://api.figma.com/v1/me");
  expect(calls[0]!.headers["X-Figma-Token"]).toBe("tok");
  stub(() => json({ status: 403, err: "Invalid token" }, 403));
  const refused = await own.connectWithKey!("figma", "nope").catch((e) => e);
  expect(refused).toBeInstanceOf(AppsError);
  expect(refused.expired).toBe(true);
});

test("reads run unasked, writes ask, and calls go to api.figma.com", async () => {
  expect((await own.getAction("figma.get_file_json"))?.readOnly).toBe(true);
  expect((await own.getAction("figma.get_comments_in_a_file"))?.readOnly).toBe(true);
  expect((await own.getAction("figma.download_figma_images"))?.readOnly).toBe(true);
  expect((await own.getAction("figma.add_a_comment_to_a_file"))?.readOnly).toBe(false);
  expect((await own.getAction("figma.create_modify_delete_variables"))?.readOnly).toBe(false);
  const calls = stub(() => json({ id: "9" }));
  await own.run("figma.add_a_comment_to_a_file", { file_key: "AbC123", message: "Looks good" }, login, "o");
  expect(`${calls[0]!.method} ${calls[0]!.url}`).toBe("POST https://api.figma.com/v1/files/AbC123/comments");
  expect(JSON.parse(calls[0]!.body)).toEqual({ message: "Looks good" });
});

test("rendered layers come back as files", async () => {
  const calls = stub((c) =>
    c.url.startsWith("https://api.figma.com") ? json({ err: null, images: { "1:2": "https://s3.test/a.png", "3:4": null } }) : new Response(new Uint8Array([137, 80, 78, 71]), { headers: { "content-type": "image/png" } }),
  );
  const got = (await own.run("figma.download_figma_images", { file_key: "AbC123", ids: ["1:2", "3:4"], scale: 2 }, login, "o")) as { images: { id: string; file?: AppFile; error?: string }[] };
  expect(calls[0]!.url).toBe("https://api.figma.com/v1/images/AbC123?ids=1%3A2%2C3%3A4&scale=2&format=png");
  expect(got.images[0]!.file).toBeInstanceOf(AppFile);
  expect(got.images[0]!.file!.name).toBe("1-2.png");
  expect(got.images[1]!.error).toBeDefined();
});

test("the first automation makes the webhook with our passcode, the next reuses it, a paused one is resumed", async () => {
  const none = stub((c) => (c.method === "GET" ? json({ webhooks: [] }) : json({ id: "w1" })));
  expect(await own.startPush!("figma.new_comment", login, { file: "https://www.figma.com/design/AbC123/Homepage?node-id=1-2" })).toBe(`figma:c1:${spot}`);
  expect(none[0]!.url).toBe("https://api.figma.com/v2/webhooks?context=file&context_id=AbC123");
  expect(none[1]!.method).toBe("POST");
  expect(JSON.parse(none[1]!.body)).toEqual({ event_type: "FILE_COMMENT", context: "file", context_id: "AbC123", endpoint: target, passcode: passcode(), description: "Emplio automations" });
  const live = { id: "w1", endpoint: target, status: "ACTIVE" };
  const same = stub(() => json({ webhooks: [live, { ...live, id: "w2", endpoint: "https://other" }] }));
  await own.startPush!("figma.new_comment", login, { file: "AbC123" });
  expect(same).toHaveLength(1);
  const paused = stub((c) => (c.method === "GET" ? json({ webhooks: [{ ...live, status: "PAUSED" }] }) : json({})));
  await own.startPush!("figma.new_comment", login, { file: "AbC123" });
  expect(`${paused[1]!.method} ${paused[1]!.url}`).toBe("PUT https://api.figma.com/v2/webhooks/w1");
  expect(JSON.parse(paused[1]!.body)).toEqual({ status: "ACTIVE" });
});

test("folders and teams are watched from their links, deletes share the edit webhook, and one place must be given", async () => {
  const calls = stub((c) => (c.method === "GET" ? json({ webhooks: [] }) : json({ id: "w1" })));
  expect(await own.startPush!("figma.file_deleted", login, { team_id: "https://www.figma.com/files/team/1170245155647481265/Northwind" })).toBe("figma:c1:team-1170245155647481265-FILE_UPDATE");
  expect(JSON.parse(calls[1]!.body)).toMatchObject({ event_type: "FILE_UPDATE", context: "team", context_id: "1170245155647481265" });
  expect(await own.startPush!("figma.file_version_created", login, { folder_id: "https://www.figma.com/files/project/987/Brand" })).toBe("figma:c1:project-987-FILE_VERSION_UPDATE");
  await expect(own.startPush!("figma.new_comment", login, {})).rejects.toThrow(/exactly one/);
  await expect(own.startPush!("figma.new_comment", login, { file: "a", team_id: "1" })).rejects.toThrow(/exactly one/);
});

test("the last automation removes only our webhook", async () => {
  const calls = stub((c) => (c.method === "GET" ? json({ webhooks: [{ id: "w2", endpoint: "https://other" }, { id: "w1", endpoint: target }] }) : json({})));
  await figma.push!.stop!("k", `figma:c1:${spot}`);
  expect(calls[0]!.url).toBe("https://api.figma.com/v2/webhooks?context=file&context_id=AbC123");
  expect(calls.slice(1).map((c) => `${c.method} ${c.url}`)).toEqual(["DELETE https://api.figma.com/v2/webhooks/w1"]);
});

test("a wrong or missing passcode is refused (the route answers 401)", async () => {
  expect(await figma.push!.receive!(delivery({ passcode: "nope", event_type: "FILE_COMMENT" }), "k")).toBeNull();
  expect(await figma.push!.receive!(delivery({ event_type: "FILE_COMMENT" }), "k")).toBeNull();
  // a passcode for another place doesn't pass here
  expect(await figma.push!.receive!(delivery({ passcode: passcode("file-Other-FILE_COMMENT"), event_type: "FILE_COMMENT" }), "k")).toBeNull();
});

test("each event starts only the right triggers, and a ping starts none", async () => {
  const s = "team-1-FILE_UPDATE";
  expect(await fire({ event_type: "PING" })).toEqual([]);
  expect(await fire({ event_type: "FILE_UPDATE", file_key: "k" }, s)).toEqual(["file_updated"]);
  expect(await fire({ event_type: "FILE_DELETE", file_key: "k" }, s)).toEqual(["file_deleted"]);
  expect(await fire({ event_type: "FILE_VERSION_UPDATE", file_key: "k" })).toEqual(["file_version_created"]);
  expect(await fire({ event_type: "FILE_COMMENT", file_key: "k" })).toEqual(["new_comment"]);
  expect(await fire({ event_type: "LIBRARY_PUBLISH", file_key: "k" })).toEqual(["library_published"]);
  expect(await fire({ event_type: "DEV_MODE_STATUS_UPDATE", file_key: "k" })).toEqual(["dev_mode_status_changed"]);
});

test("a comment comes as plain text without the passcode, and a retry has the same id", async () => {
  const body = { passcode: passcode(), event_type: "FILE_COMMENT", file_key: "AbC123", comment_id: "5", comment: [{ text: "Can " }, { mention: "42" }, { text: " check this?" }], timestamp: "2026-11-22T10:00:00Z" };
  const [a] = await (await figma.push!.receive!(delivery(body), "k"))!.events();
  const [b] = await (await figma.push!.receive!(delivery(body), "k"))!.events();
  expect(a!.id).toBe(b!.id!);
  expect(a!.id).toStartWith("figma:c1:");
  expect(a!.data).toMatchObject({ text: "Can @42 check this?", comment_id: "5" });
  expect(a!.data).not.toHaveProperty("passcode");
});

test("filters narrow what runs", () => {
  expect(wanted({}, { file_key: "AbC123" })).toBe(true);
  expect(wanted({ file_key: "https://www.figma.com/design/AbC123/x" }, { file_key: "AbC123" })).toBe(true);
  expect(wanted({ file_key: "Other" }, { file_key: "AbC123" })).toBe(false);
  expect(wanted({ status: "ready_for_dev" }, { file_key: "k", status: "READY_FOR_DEV" })).toBe(true);
  expect(wanted({ status: "COMPLETED" }, { file_key: "k", status: "READY_FOR_DEV" })).toBe(false);
});

test("every Figma webhook event has a trigger", () => {
  for (const t of ["file_updated", "file_deleted", "file_version_created", "new_comment", "library_published", "dev_mode_status_changed"]) expect(triggers[t]).toBeDefined();
});

test("polls report new folders, and an edited file is news again", async () => {
  const now = new Date().toISOString();
  const run = async (action: string) =>
    action === "figma.get_projects_in_a_team"
      ? { folders: [{ id: "1", created_at: now }, { id: "2", created_at: "2020-01-01T00:00:00Z" }] }
      : { files: [{ key: "AbC", last_modified: now }, { key: "Old", last_modified: "2020-01-01T00:00:00Z" }] };
  expect((await pollTrigger("figma.new_project_in_team")!.poll({ team_id: "https://www.figma.com/files/team/77/x" }, run)).map((i) => i.id)).toEqual(["1"]);
  expect((await pollTrigger("figma.file_changed_in_project")!.poll({ folder_id: "9" }, run)).map((i) => i.id)).toEqual([`AbC:${now}`]);
});
