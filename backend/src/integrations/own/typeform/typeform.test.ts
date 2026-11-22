import { afterEach, beforeAll, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { AppFile, AppsError } from "../../types";
import { own } from "../index";
import { pollTrigger } from "../../polls/index";
import { typeform } from "./index";

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
    const c = { url: String(url), method: init.method ?? "GET", body: init.body instanceof Uint8Array ? "bytes" : String(init.body ?? ""), headers: init.headers as Record<string, string> };
    calls.push(c);
    return answer(c);
  }) as typeof fetch;
  return calls;
};
const login = { externalId: "c1", secret: "tfp_tok" };
const secret = () => createHmac("sha256", process.env.ENCRYPTION_KEY!).update("typeform-webhook:c1").digest("hex");
const sign = (body: string, key = secret()) => `sha256=${createHmac("sha256", key).update(body).digest("base64")}`;
const delivery = (body: unknown, signature?: string) => {
  const raw = JSON.stringify(body);
  return { body: raw, headers: { "typeform-signature": signature ?? sign(raw) }, connection: "c1", rest: "abc123" };
};
const response = {
  form_id: "abc123",
  token: "r1",
  submitted_at: "2026-11-22T10:00:00Z",
  hidden: { customer: "northwind" },
  calculated: { score: 4 },
  definition: { title: "Feedback", fields: [{ id: "f1", title: "Your name?" }, { id: "f2", title: "Which plan?" }, { id: "f3", title: "Which days?" }] },
  answers: [
    { field: { id: "f1", type: "short_text", ref: "name" }, type: "text", text: "Sarah" },
    { field: { id: "f2", type: "multiple_choice" }, type: "choice", choice: { label: "Pro" } },
    { field: { id: "f3", type: "multiple_choice" }, type: "choices", choices: { labels: ["Mon", "Tue"] } },
  ],
};
const fire = async (body: unknown) => (await (await typeform.push!.receive!(delivery(body), "k"))!.events())[0];

test("a token is checked with Bearer on /me and labelled, a bad one is refused as dead, an EU one goes to the EU host", async () => {
  const calls = stub(() => json({ alias: "Sarah", email: "sarah@northwind.com" }));
  expect(await own.connectWithKey!("typeform", " tfp_tok ")).toEqual({ secret: "tfp_tok", label: "Sarah" });
  expect(calls[0]!.url).toBe("https://api.typeform.com/me");
  expect(calls[0]!.headers.Authorization).toBe("Bearer tfp_tok");
  await own.connectWithKey!("typeform", "eu:tfp_eu");
  expect(calls[1]!.url).toBe("https://api.eu.typeform.com/me");
  expect(calls[1]!.headers.Authorization).toBe("Bearer tfp_eu");
  stub(() => json({ code: "AUTHENTICATION_FAILED", description: "Authentication credentials not found on the Request Headers" }, 401));
  const refused = await own.connectWithKey!("typeform", "nope").catch((e) => e);
  expect(refused).toBeInstanceOf(AppsError);
  expect(refused.expired).toBe(true);
});

test("calls follow the reference: forms, responses, JSON patches", async () => {
  const calls = stub(() => json({ items: [] }));
  await own.run("typeform.get_form_responses", { form_id: "abc123", page_size: 5 }, login, "o");
  expect(calls[0]!.url).toBe("https://api.typeform.com/forms/abc123/responses?page_size=5");
  await own.run("typeform.patch_form", { form_id: "abc123", body: [{ op: "replace", path: "/title", value: "New" }] }, login, "o");
  expect(calls[1]!.method).toBe("PATCH");
  expect(JSON.parse(calls[1]!.body)).toEqual([{ op: "replace", path: "/title", value: "New" }]);
  await own.run("typeform.delete_responses", { form_id: "abc123", included_response_ids: "r1,r2" }, login, "o");
  expect(calls[2]!.url).toBe("https://api.typeform.com/forms/abc123/responses?included_response_ids=r1%2Cr2");
  stub(() => json({ code: "FORM_NOT_FOUND", description: "Non existing form with uid abc123" }, 404));
  await expect(own.run("typeform.get_form", { form_id: "abc123" }, login, "o")).rejects.toThrow(/Non existing form/);
});

test("reads run unasked, writes ask, and webhook details (with their secret) ask first", async () => {
  for (const a of ["list_forms", "get_form", "get_form_responses", "search_responses", "get_about_me", "get_response_file"]) expect((await own.getAction(`typeform.${a}`))?.readOnly).toBe(true);
  for (const a of ["create_form", "delete_form", "delete_responses", "update_workspace", "upload_video", "list_webhooks", "get_webhook"]) expect((await own.getAction(`typeform.${a}`))?.readOnly).toBeFalsy();
});

test("a respondent's file comes back as a file, and a video goes up in one go", async () => {
  stub(() => new Response(new Uint8Array([37, 80, 68, 70]), { headers: { "content-type": "application/pdf" } }));
  const got = (await own.run("typeform.get_response_file", { form_id: "a", response_id: "r", field_id: "f", filename: "cv.pdf" }, login, "o")) as AppFile;
  expect(got.mimetype).toBe("application/pdf");
  const calls = stub((c) => (c.url.endsWith("/media/videos") ? json({ id: "v1", upload_url: "https://upload.test/v1" }) : json({ ok: true })));
  const video = new AppFile("clip.mp4", "video/mp4", new Uint8Array([1, 2]));
  expect(await own.run("typeform.upload_video", { file: video, form_id: "a", field_id: "f" }, login, "o")).toEqual({ id: "v1" });
  expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual(["POST https://api.typeform.com/media/videos", "PUT https://upload.test/v1", "POST https://api.typeform.com/media/videos/v1/master"]);
});

test("the first automation on a form makes its signed webhook, the next event joins it, the last removes it", async () => {
  const none = stub((c) => (c.method === "GET" ? json({ items: [{ tag: "someone_else", url: "https://other", enabled: true }] }) : json({})));
  expect(await own.startPush!("typeform.new_response", login, { form_id: "https://northwind.typeform.com/to/abc123" })).toBe("typeform:c1:abc123");
  expect(none[0]!.url).toBe("https://api.typeform.com/forms/abc123/webhooks");
  expect(`${none[1]!.method} ${none[1]!.url}`).toBe("PUT https://api.typeform.com/forms/abc123/webhooks/emplio_c1");
  expect(JSON.parse(none[1]!.body)).toEqual({ url: "https://api.test/webhooks/app/typeform/c1/abc123", enabled: true, verify_ssl: true, secret: secret(), event_types: { form_response: true } });
  const ours = { tag: "emplio_c1", url: "https://api.test/webhooks/app/typeform/c1/abc123", enabled: true, event_types: { form_response: true } };
  const same = stub(() => json({ items: [ours] }));
  await own.startPush!("typeform.new_response", login, { form_id: "abc123" });
  expect(same).toHaveLength(1);
  const more = stub((c) => (c.method === "GET" ? json({ items: [ours] }) : json({})));
  await own.startPush!("typeform.new_partial_response", login, { form_id: "abc123" });
  expect(JSON.parse(more[1]!.body).event_types).toEqual({ form_response: true, form_response_partial: true });
  await expect(own.startPush!("typeform.new_response", login, { form_id: "not a form!" })).rejects.toThrow(/form_id/);
  const gone = stub((c) => (c.method === "GET" ? json({ items: [ours] }) : json({})));
  await typeform.push!.stop!("tfp_tok", "typeform:c1:abc123");
  expect(gone.slice(1).map((c) => `${c.method} ${c.url}`)).toEqual(["DELETE https://api.typeform.com/forms/abc123/webhooks/emplio_c1"]);
});

test("a wrong or missing signature is refused", async () => {
  const body = { event_id: "e1", event_type: "form_response", form_response: response };
  expect(await typeform.push!.receive!(delivery(body, sign(JSON.stringify(body), "wrong")), "k")).toBeNull();
  expect(await typeform.push!.receive!(delivery(body, ""), "k")).toBeNull();
});

test("each event starts only its trigger, with plain answers, and a retry has the same id", async () => {
  const full = await fire({ event_id: "e1", event_type: "form_response", form_response: response });
  expect(full!.triggers).toEqual(["new_response"]);
  expect(full!.id).toBe("typeform:c1:e1");
  expect(full!.data).toMatchObject({
    form_id: "abc123",
    form_title: "Feedback",
    response_id: "r1",
    hidden: { customer: "northwind" },
    score: 4,
    answers: [
      { question: "Your name?", ref: "name", type: "short_text", answer: "Sarah" },
      { question: "Which plan?", type: "multiple_choice", answer: "Pro" },
      { question: "Which days?", type: "multiple_choice", answer: ["Mon", "Tue"] },
    ],
  });
  expect((await fire({ event_id: "e1", event_type: "form_response", form_response: response }))!.id).toBe(full!.id);
  expect((await fire({ event_id: "e2", event_type: "form_response_partial", form_response: response }))!.triggers).toEqual(["new_partial_response"]);
  expect(await fire({ event_id: "e3", event_type: "something_new", form_response: response })).toBeUndefined();
});

test("polls report forms made or changed in the last day", async () => {
  const now = new Date().toISOString();
  const run = async () => ({ items: [{ id: "a", created_at: now, last_updated_at: now }, { id: "b", created_at: "2020-01-01T00:00:00Z", last_updated_at: now }, { id: "c", created_at: "2020-01-01T00:00:00Z", last_updated_at: "2020-01-02T00:00:00Z" }] });
  expect((await pollTrigger("typeform.new_form")!.poll({}, run)).map((i) => i.id)).toEqual(["a"]);
  expect((await pollTrigger("typeform.form_updated")!.poll({}, run)).map((i) => i.id)).toEqual([`b:${now}`]);
});
