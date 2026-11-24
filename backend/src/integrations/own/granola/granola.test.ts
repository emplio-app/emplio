import { afterEach, beforeAll, expect, test } from "bun:test";
import { createHmac, randomBytes } from "node:crypto";
import { AppsError } from "../../types";
import type { Delivery } from "../index";
import { granola } from "./index";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});
beforeAll(() => {
  process.env.ENCRYPTION_KEY ??= randomBytes(32).toString("base64");
  process.env.WEBHOOK_URL = "https://api.test";
});
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
type Call = { url: string; method: string; body: any; headers: Record<string, string> };
const stub = (answer: (c: Call) => Response) => {
  const calls: Call[] = [];
  globalThis.fetch = (async (url: string, init: RequestInit = {}) => {
    const c = { url: String(url), method: init.method ?? "GET", body: init.body ? JSON.parse(String(init.body)) : undefined, headers: init.headers as Record<string, string> };
    calls.push(c);
    return answer(c);
  }) as typeof fetch;
  return calls;
};
// what the app does when it isn't yet in APPS: check the input, then run
const run = (name: string, input: unknown) => {
  const a = granola.actions[name]!;
  return a.run(a.input.parse(input), "grn_key", "c1");
};
const push = granola.push!;
const base = "https://api.test/webhooks/app/granola/c1";

test("a key is checked with Bearer on /v1/notes; a refused one asks for reconnecting", async () => {
  const calls = stub(() => json({ notes: [], hasMore: false, cursor: null }));
  await granola.check("grn_key");
  expect(calls[0]!.url).toBe("https://public-api.granola.ai/v1/notes?page_size=1");
  expect(calls[0]!.headers.Authorization).toBe("Bearer grn_key");
  stub(() => json({ message: "Invalid API key" }, 401));
  const e = (await granola.check("nope").catch((x) => x)) as AppsError;
  expect(e).toBeInstanceOf(AppsError);
  expect(e.expired).toBe(true);
});

test("calls follow the spec: a note with its transcript, a search as a POST", async () => {
  const calls = stub(() => json({ ok: 1 }));
  await run("get_note", { note_id: "not_1d3tmYTlCICgjy", include: "transcript" });
  expect(calls[0]!.url).toBe("https://public-api.granola.ai/v1/notes/not_1d3tmYTlCICgjy?include=transcript");
  await run("search_notes", { keywords: ["pricing"], page_size: 5 });
  expect(calls[1]!.method).toBe("POST");
  expect(calls[1]!.body).toEqual({ keywords: ["pricing"], page_size: 5 });
});

test("reads (searches too) run unasked; changes ask first", () => {
  const a = granola.actions;
  for (const n of ["list_notes", "get_note", "get_transcript", "search_notes", "search_transcripts", "list_folders", "list_audit_events"]) expect(a[n]!.readOnly).toBe(true);
  for (const n of ["create_webhook_endpoint", "delete_webhook_endpoint", "create_legal_hold", "release_legal_hold"]) expect(a[n]!.readOnly).toBeFalsy();
});

test("the first automation makes the endpoint and seals its secret into the address; the next event joins it; the last removes it", async () => {
  let secret = "";
  const made = stub((c) => {
    if (c.method === "GET") return json({ webhook_endpoints: [{ id: "whe_other", url: "https://elsewhere.test/x", events: [], enabled: true }] });
    if (c.method === "POST") return json({ id: "whe_2mKr8fQxLp7Ta3", url: c.body.url, events: c.body.events, enabled: true, signing_secret: "whsec_" + randomBytes(24).toString("base64") }, 201);
    return json({});
  });
  expect(await push.start("grn_key", "c1", "note.generated", {})).toBe("granola:c1");
  expect(made[1]!.body).toEqual({ url: `${base}/new`, scopes: ["personal", "public"], events: ["note.generated"] });
  expect(made[2]!.method).toBe("PATCH");
  expect(made[2]!.url).toBe("https://public-api.granola.ai/v1/webhook-endpoints/whe_2mKr8fQxLp7Ta3");
  expect(made[2]!.body.url).toStartWith(`${base}/`);
  secret = made[2]!.body.url;

  const ours = { id: "whe_2mKr8fQxLp7Ta3", url: secret, events: ["note.generated"], enabled: true };
  const same = stub(() => json({ webhook_endpoints: [ours] }));
  await push.start("grn_key", "c1", "note.generated", {});
  expect(same).toHaveLength(1);
  const more = stub((c) => (c.method === "GET" ? json({ webhook_endpoints: [ours] }) : json({})));
  await push.start("grn_key", "c1", "note.edited", {});
  expect(more[1]!.body).toEqual({ events: ["note.generated", "note.edited"], enabled: true });

  const gone = stub((c) => (c.method === "GET" ? json({ webhook_endpoints: [ours] }) : json({})));
  await push.stop!("grn_key", "granola:c1");
  expect(gone.slice(1).map((c) => `${c.method} ${c.url}`)).toEqual(["DELETE https://public-api.granola.ai/v1/webhook-endpoints/whe_2mKr8fQxLp7Ta3"]);
});

test("a workspace key falls back to the workspace scope; a plan without webhooks says so", async () => {
  const calls = stub((c) => {
    if (c.method === "GET") return json({ webhook_endpoints: [] });
    if (c.method === "POST") return c.body.scopes[0] === "workspace" ? json({ id: "whe_x", url: c.body.url, events: [], enabled: true, signing_secret: "whsec_c2VjcmV0" }, 201) : json({ message: "scope not allowed" }, 400);
    return json({});
  });
  await push.start("grn_key", "c1", "note.generated", {});
  expect(calls.filter((c) => c.method === "POST").map((c) => c.body.scopes)).toEqual([["personal", "public"], ["workspace"]]);
  stub((c) => (c.method === "GET" ? json({ message: "The webhooks API is not available for this workspace" }, 404) : json({})));
  await expect(push.start("grn_key", "c1", "note.generated", {})).rejects.toThrow(/Business or Enterprise/);
});

// a signed delivery to the sealed address, as Granola sends it (Standard Webhooks)
async function sealedAddress(secret: string) {
  const calls = stub((c) =>
    c.method === "GET" ? json({ webhook_endpoints: [] }) : c.method === "POST" ? json({ id: "whe_x", url: c.body.url, events: [], enabled: true, signing_secret: secret }, 201) : json({}),
  );
  await push.start("grn_key", "c1", "note.generated", {});
  return calls[2]!.body.url.slice(base.length + 1) as string;
}
const deliver = (rest: string, secret: string, body: unknown, opts: { t?: number; sig?: string } = {}): Delivery => {
  const raw = JSON.stringify(body);
  const t = String(opts.t ?? Math.floor(Date.now() / 1000));
  const sig = createHmac("sha256", Buffer.from(secret.slice(6), "base64")).update(`ev1.${t}.${raw}`).digest("base64");
  return { body: raw, headers: { "webhook-id": "ev1", "webhook-timestamp": t, "webhook-signature": opts.sig ?? `v1,${sig}` }, connection: "c1", rest };
};

test("signatures: right one accepted, wrong, stale or unsealed refused", async () => {
  const secret = "whsec_" + randomBytes(24).toString("base64");
  const rest = await sealedAddress(secret);
  const body = { event_id: "ev1", event_type: "note.generated", note_id: "not_1d3tmYTlCICgjy", occurred_at: "2026-11-24T10:00:00Z" };
  expect(await push.receive!(deliver(rest, secret, body), "grn_key")).not.toBeNull();
  expect(await push.receive!(deliver(rest, secret, body, { sig: "v1,AAAA" }), "grn_key")).toBeNull();
  expect(await push.receive!(deliver(rest, secret, body, { t: Math.floor(Date.now() / 1000) - 3600 }), "grn_key")).toBeNull();
  expect(await push.receive!(deliver("forged", secret, body), "grn_key")).toBeNull();
});

test("each event starts only its trigger, with the note read in; the folder filter applies", async () => {
  const secret = "whsec_" + randomBytes(24).toString("base64");
  const rest = await sealedAddress(secret);
  const note = { id: "not_1d3tmYTlCICgjy", object: "note", title: "Northwind pricing", summary_text: "plain", summary_markdown: "## Pricing", attachments: [{ url: "x" }], folder_membership: [{ id: "fol_AAAAAAAAAAAAAA", parent_folder_id: "fol_BBBBBBBBBBBBBB" }] };
  const calls = stub(() => json(note));
  const fire = async (event_type: string) =>
    (await (await push.receive!(deliver(rest, secret, { event_id: "ev1", event_type, note_id: note.id, occurred_at: "2026-11-24T10:00:00Z" }), "grn_key"))!.events())[0];
  const ready = await fire("note.generated");
  expect(calls[0]!.url).toBe("https://public-api.granola.ai/v1/notes/not_1d3tmYTlCICgjy");
  expect(ready!.triggers).toEqual(["note_ready"]);
  expect(ready!.id).toBe("granola:c1:ev1");
  expect(ready!.data).toMatchObject({ event: "note.generated", note_id: note.id, note: { title: "Northwind pricing", summary: "## Pricing" } });
  expect((ready!.data as any).note.attachments).toBeUndefined();
  expect((await fire("note.edited"))!.triggers).toEqual(["note_edited"]);
  expect((await fire("note.access_granted"))!.triggers).toEqual(["note_shared"]);
  expect(await fire("note.deleted")).toBeUndefined();
  expect(push.wanted!({ folder_id: "fol_bbbbbbbbbbbbbb" }, ready!.data)).toBe(true);
  expect(push.wanted!({ folder_id: "fol_CCCCCCCCCCCCCC" }, ready!.data)).toBe(false);
  expect(push.wanted!({}, ready!.data)).toBe(true);
});
