import { afterEach, beforeAll, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { AppFile, AppsError } from "../../types";
import { own } from "../index";
import { triggers, wanted } from "./triggers";
import { trello } from "./index";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});
beforeAll(() => {
  process.env.ENCRYPTION_KEY ??= "test-key";
  process.env.WEBHOOK_URL = "https://api.test";
});
const BOARD = "5f0000000000000000000042";
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
const login = { externalId: "c1", secret: "k123:t456" };
const token = () => createHmac("sha256", process.env.ENCRYPTION_KEY!).update(`trello-webhook:c1:${BOARD}`).digest("hex");
const target = () => `https://api.test/webhooks/app/trello/c1/${BOARD}/${token()}`;
// every start and stop: the board's id, then our token's webhooks
const lookup = (hooks: unknown[]) => (c: Call) =>
  c.url.includes("/boards/") ? json({ id: BOARD }) : c.method === "GET" && c.url.includes("/tokens/t456/webhooks") ? json(hooks) : json({ id: "w9" });
const delivery = (action: object, rest = `${BOARD}/${token()}`) => ({ body: JSON.stringify({ action, model: { id: BOARD } }), headers: {}, connection: "c1", rest });
const act = (type: string, data: object = {}, extra = {}) => ({ id: `a-${type}`, type, date: "2026-11-22T10:00:00.000Z", data, memberCreator: { id: "m1", fullName: "Sarah" }, ...extra });
const fired = async (a: object) => (await (await trello.push!.receive!(delivery(a), "x"))!.events())[0]!.triggers;

test("a key and token are checked and labelled, and a bad pair is refused as dead", async () => {
  const calls = stub(() => json({ id: "m1", fullName: "Sarah Lee", username: "sarah" }));
  expect(await own.connectWithKey!("trello", " k123:t456 ")).toEqual({ secret: "k123:t456", label: "Sarah Lee" });
  expect(calls[0]!.url).toBe("https://api.trello.com/1/members/me?fields=fullName%2Cusername");
  expect(calls[0]!.headers.Authorization).toBe('OAuth oauth_consumer_key="k123", oauth_token="t456"');
  stub(() => new Response("invalid token", { status: 401, headers: { "content-type": "text/plain" } }));
  const refused = await own.connectWithKey!("trello", "k:bad").catch((e) => e);
  expect(refused).toBeInstanceOf(AppsError);
  expect(refused.expired).toBe(true);
});

test("a key without its token is refused before calling Trello", async () => {
  const calls = stub(() => json({}));
  await expect(own.connectWithKey!("trello", "k123")).rejects.toThrow(/API key and the token/);
  expect(calls).toHaveLength(0);
});

test("reads run unasked, writes ask", async () => {
  expect((await own.getAction("trello.get_boards_by_id_board"))?.readOnly).toBe(true);
  expect((await own.getAction("trello.download_card_attachment"))?.readOnly).toBe(true);
  expect((await own.getAction("trello.add_cards"))?.readOnly).toBe(false);
  expect((await own.getAction("trello.delete_board"))?.readOnly).toBe(false);
});

test("a card is made with its fields sent to Trello", async () => {
  const calls = stub(() => json({ id: "c9" }));
  await own.run("trello.add_cards", { idList: "l1", name: "Call Northwind" }, login, "o");
  expect(calls[0]!.method).toBe("POST");
  const q = new URL(calls[0]!.url).searchParams;
  expect([q.get("name"), q.get("idList")]).toEqual(["Call Northwind", "l1"]);
});

test("the connection's own token is filled in, never asked for", async () => {
  expect((await own.getAction("trello.get_tokens_by_token"))!.input.map((f) => f.name)).not.toContain("token");
  const calls = stub(() => json([]));
  await own.run("trello.get_tokens_webhooks_by_token", {}, login, "o");
  expect(calls[0]!.url).toBe("https://api.trello.com/1/tokens/t456/webhooks");
});

test("the spec's ${id} typo is fixed", async () => {
  const calls = stub(() => json({}));
  await own.run("trello.decline_enterprise_join_requests_from_one_organization_or_bulk_list_of_organizations", { id: "e1", idOrganizations: ["o1"] }, login, "o");
  expect(calls[0]!.url).toStartWith("https://api.trello.com/1/enterprises/e1/enterpriseJoinRequest/bulk");
});

test("a file is uploaded as a file, and a card's file comes back as one", async () => {
  const calls = stub(() => json({ id: "a1" }));
  await own.run("trello.add_cards_attachments_by_id_card", { id: "c9", name: "quote", file: new AppFile("q.pdf", "application/pdf", new Uint8Array([1, 2])) }, login, "o");
  expect(calls[0]!.url).toStartWith("https://api.trello.com/1/cards/c9/attachments?name=quote");
  expect(calls[0]!.url).not.toContain("file=");
  expect((calls[0]!.body as FormData).get("file")).toBeInstanceOf(Blob);
  const got = stub((c) =>
    c.url.endsWith("/download/q.pdf") ? new Response(new Uint8Array([7]), { headers: { "content-type": "application/pdf" } }) : json({ name: "q.pdf", fileName: "q.pdf", isUpload: true, mimeType: "application/pdf", url: "x" }),
  );
  const f = await own.run("trello.download_card_attachment", { id: "c9", idAttachment: "a1" }, login, "o");
  expect(f).toBeInstanceOf(AppFile);
  expect((f as AppFile).name).toBe("q.pdf");
  expect(got[1]!.headers.Authorization).toContain('oauth_token="t456"');
});

test("any route can be reached, but only on Trello's API", async () => {
  expect((await own.getAction("trello.call_api_get"))?.readOnly).toBe(true);
  expect((await own.getAction("trello.call_api"))?.readOnly).toBeFalsy();
  const calls = stub(() => json({}));
  await own.run("trello.call_api_get", { path: "/actions/a1/display", query: { fields: "name" } }, login, "o");
  expect(calls[0]!.url).toBe("https://api.trello.com/1/actions/a1/display?fields=name");
  await expect(own.run("trello.call_api_get", { path: "/../../evil" }, login, "o")).rejects.toThrow(/path/);
  await expect(own.run("trello.call_api", { method: "PUT", path: "@evil.com/x" }, login, "o")).rejects.toThrow(/path/);
});

test("the first automation makes the board's webhook, the next reuses it, and a switched-off one is switched on", async () => {
  const none = stub(lookup([]));
  expect(await own.startPush!("trello.card_created", login, { board_id: "https://trello.com/b/AbCd1234/sales" })).toBe(`trello:c1:${BOARD}`);
  expect(none[0]!.url).toStartWith("https://api.trello.com/1/boards/AbCd1234?");
  expect(none[2]!.method).toBe("POST");
  const sent = new URL(none[2]!.url).searchParams;
  expect(sent.get("callbackURL")).toBe(target());
  expect(sent.get("idModel")).toBe(BOARD);
  const same = stub(lookup([{ id: "w1", idModel: BOARD, callbackURL: target(), active: true }]));
  await own.startPush!("trello.card_updated", login, { board_id: BOARD });
  expect(same).toHaveLength(2);
  const off = stub(lookup([{ id: "w1", idModel: BOARD, callbackURL: target(), active: false }]));
  await own.startPush!("trello.card_updated", login, { board_id: BOARD });
  expect(off[2]!.method).toBe("PUT");
  expect(off[2]!.url).toBe("https://api.trello.com/1/webhooks/w1?active=true");
});

test("workspace triggers watch the workspace", async () => {
  const calls = stub((c) => (c.url.includes("/organizations/") ? json({ id: "o1" }) : c.method === "GET" ? json([]) : json({ id: "w2" })));
  expect(await own.startPush!("trello.workspace_updated", login, { workspace_id: "northwind" })).toBe("trello:c1:o1");
  expect(new URL(calls[2]!.url).searchParams.get("idModel")).toBe("o1");
});

test("a board is required and must look like one", async () => {
  await expect(own.startPush!("trello.card_created", login, {})).rejects.toThrow(/board_id/);
  await expect(own.startPush!("trello.card_created", login, { board_id: "a/../b" })).rejects.toThrow(/board_id/);
});

test("the last automation removes the webhook, found by its URL", async () => {
  const calls = stub(lookup([{ id: "other", callbackURL: "https://x", active: true }, { id: "w1", callbackURL: target(), active: true }]));
  await trello.push!.stop!("k123:t456", `trello:c1:${BOARD}`);
  expect(calls[1]!.method).toBe("DELETE");
  expect(calls[1]!.url).toBe("https://api.trello.com/1/webhooks/w1");
});

test("a bad token in the URL is refused", async () => {
  expect(await trello.push!.receive!(delivery(act("createCard"), `${BOARD}/nope`), "x")).toBeNull();
  expect(await trello.push!.receive!(delivery(act("createCard"), `other/${token()}`), "x")).toBeNull();
  expect(await trello.push!.receive!(delivery(act("createCard"), ""), "x")).toBeNull();
});

test("each event starts only the right triggers, and the catch-all", async () => {
  const cases: [object, string[]][] = [
    [act("createCard"), ["card_created"]],
    [act("updateCard", { listBefore: { id: "l1" }, listAfter: { id: "l2" } }), ["card_updated", "card_moved_between_lists"]],
    [act("updateCard", { old: { name: "x" } }), ["card_updated"]],
    [act("commentCard", { text: "hi" }), ["comment_added_to_card"]],
    [act("updateCheckItemStateOnCard"), ["checklist_item_state_changed"]],
    [act("addMemberToCard"), ["member_assigned_to_card"]],
    [act("makeObserverOfBoard"), ["board_member_role_changed"]],
    [act("updateOrganization"), ["workspace_updated"]],
    [act("somethingNew"), []],
  ];
  for (const [a, want] of cases) expect((await fired(a)).sort()).toEqual([...want, "board_activity"].sort());
});

test("a retry has the same id, and the payload is trimmed", async () => {
  const one = (await (await trello.push!.receive!(delivery(act("createCard", { card: { id: "c1" } })), "x"))!.events())[0]!;
  const two = (await (await trello.push!.receive!(delivery(act("createCard", { card: { id: "c1" } })), "x"))!.events())[0]!;
  expect(one.id).toBe(two.id!);
  expect(one.data).toEqual({ type: "createCard", date: "2026-11-22T10:00:00.000Z", member_creator: { id: "m1", fullName: "Sarah" }, data: { card: { id: "c1" } }, translation_key: undefined });
});

test("filters narrow what runs", () => {
  const moved = { type: "updateCard", data: { card: { id: "c1" }, listBefore: { id: "l1" }, listAfter: { id: "l2" } } };
  expect(wanted({ board_id: BOARD }, moved)).toBe(true);
  expect(wanted({ list_id: "l2" }, moved)).toBe(true);
  expect(wanted({ list_id: "l1" }, moved)).toBe(false);
  expect(wanted({ card_id: "c1" }, moved)).toBe(true);
  expect(wanted({ card_id: "c2" }, moved)).toBe(false);
  expect(wanted({ action_type: "updateCard" }, moved)).toBe(true);
  expect(wanted({ action_type: "createCard" }, moved)).toBe(false);
});

test("every Composio trigger is here and needs a board or workspace", () => {
  for (const [name, t] of Object.entries(triggers)) expect(["board_id", "workspace_id"]).toContain(t.config[0]!.name);
  expect(Object.keys(triggers)).toContain("card_moved_between_lists");
});
