import { afterEach, beforeAll, expect, spyOn, test } from "bun:test";
import { createHmac, randomBytes } from "node:crypto";
import Fastify from "fastify";
import { automationRoutes } from "../../../automations";
import { db } from "../../../db";
import { encrypt } from "../../../secrets";
import { AppFile, AppsError } from "../../types";
import { own } from "../index";
import { close } from "./index";
import { triggers, wanted } from "./triggers";

beforeAll(() => {
  process.env.ENCRYPTION_KEY = randomBytes(32).toString("base64");
  process.env.WEBHOOK_URL = "https://api.test";
});
const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
type Call = { url: string; method: string; body: BodyInit | null | undefined; headers: Record<string, string> };
const stub = (answer: (c: Call) => Response) => {
  const calls: Call[] = [];
  globalThis.fetch = (async (url: string | URL, init: RequestInit = {}) => {
    const c = { url: String(url), method: init.method ?? "GET", body: init.body, headers: (init.headers ?? {}) as Record<string, string> };
    calls.push(c);
    return answer(c);
  }) as typeof fetch;
  return calls;
};
const KEY = "api_test.secret";
const login = { externalId: "c1", secret: KEY };
const run = (a: string, i: unknown) => own.run(a, i as Record<string, unknown>, login, "o");
const token = () => createHmac("sha256", process.env.ENCRYPTION_KEY!).update("close-webhook:c1").digest("hex");
const target = () => `https://api.test/webhooks/app/close/c1/${token()}`;
const SIGNING = "058bfb6a3d8cfdc4da7c3be5901b16ae11da982b46a25fb2cd7016e97a140a1c";
const signed = (body: string, ts = "1544271440", key = SIGNING) => ({
  "close-sig-timestamp": ts,
  "close-sig-hash": createHmac("sha256", Buffer.from(key, "hex")).update(ts + body).digest("hex"),
});
const delivery = (event: object, sub = "whsub_1", headers?: Record<string, string>, rest = token()) => {
  const body = JSON.stringify({ subscription_id: sub, event: { organization_id: "orga_1", ...event } });
  return { body, headers: headers ?? signed(body), connection: "c1", rest };
};
// GET /webhook/<sub>/ answers our subscription with its signing key
const hookAnswer = () => stub(() => json({ id: "whsub_1", url: target(), signature_key: SIGNING }));

test("the key is the basic-auth username; it's labelled with the person and organization, and a bad one is dead", async () => {
  const calls = stub(() => json({ first_name: "Sarah", last_name: "Lee", organizations: [{ name: "Northwind" }] }));
  expect(await own.connectWithKey!("close", KEY)).toEqual({ secret: KEY, label: "Sarah Lee (Northwind)" });
  expect(calls[0]!.url).toBe("https://api.close.com/api/v1/me/");
  expect(calls[0]!.headers.Authorization).toBe(`Basic ${btoa(`${KEY}:`)}`);
  stub(() => json({ error: "Unauthorized" }, 401));
  const refused = await own.connectWithKey!("close", KEY).catch((e) => e);
  expect(refused).toBeInstanceOf(AppsError);
  expect(refused.expired).toBe(true);
  stub(() => json({ error: "inactive", error_code: "inactive_api_key" }, 403));
  expect((await own.connectWithKey!("close", KEY).catch((e) => e)).expired).toBe(true);
});

test("reads run unasked, writes ask, searching by POST is a read, and webhook keys ask", async () => {
  for (const a of ["list_leads", "get_lead", "search_data", "get_funnel_report_totals", "who_am_i", "download_file"]) expect((await own.getAction(`close.${a}`))?.readOnly).toBe(true);
  for (const a of ["create_lead", "update_opportunity", "delete_contact", "create_task", "list_webhooks", "get_webhook", "upload_file"])
    expect((await own.getAction(`close.${a}`))?.readOnly).toBeFalsy();
});

test("custom field values go to Close as custom.cf_ keys", async () => {
  const calls = stub(() => json({ id: "lead_1" }));
  await run("close.create_lead", { name: "Northwind", custom: { cf_abc: "Gold", "custom.cf_def": ["A", "B"] } });
  expect(calls[0]!.method).toBe("POST");
  expect(calls[0]!.url).toBe("https://api.close.com/api/v1/lead/");
  expect(JSON.parse(String(calls[0]!.body))).toEqual({ name: "Northwind", "custom.cf_abc": "Gold", "custom.cf_def": ["A", "B"] });
  await run("close.update_opportunity", { id: "oppo_1", value: 500 });
  expect(calls[1]!.method).toBe("PUT");
  expect(JSON.parse(String(calls[1]!.body))).toEqual({ value: 500 });
});

test("a file goes up through Close's S3 form, and comes back as a file without the key leaving Close", async () => {
  const calls = stub((c) =>
    c.url.endsWith("/files/upload/")
      ? json({ upload: { url: "https://close-prd-files.s3.amazonaws.com/", fields: { key: "k", policy: "p" } }, download: { url: "https://app.close.com/go/file/temporary/x/a.pdf/" } })
      : new Response(null, { status: 201 }),
  );
  const up = (await run("close.upload_file", { file: new AppFile("a.pdf", "application/pdf", new Uint8Array([1, 2])) })) as { url: string };
  expect(up.url).toBe("https://app.close.com/go/file/temporary/x/a.pdf/");
  expect(JSON.parse(String(calls[0]!.body))).toEqual({ filename: "a.pdf", content_type: "application/pdf" });
  const form = calls[1]!.body as FormData;
  expect(form.get("policy")).toBe("p");
  expect((form.get("file") as File).name).toBe("a.pdf");
  expect(calls[1]!.headers.Authorization).toBeUndefined();

  const down = stub((c) =>
    c.url.startsWith("https://app.close.com/") ? new Response(null, { status: 302, headers: { location: "https://s3.example/a.pdf" } }) : new Response(new Uint8Array([7]), { headers: { "content-type": "application/pdf" } }),
  );
  const file = (await run("close.download_file", { url: "https://app.close.com/go/file/x/a.pdf/" })) as AppFile;
  expect(file).toBeInstanceOf(AppFile);
  expect(file.name).toBe("a.pdf");
  expect(down[0]!.headers.Authorization).toStartWith("Basic ");
  expect(down[1]!.headers.Authorization).toBeUndefined();
  expect(await run("close.download_file", { url: "https://evil.example/x" }).catch((e) => e)).toBeInstanceOf(AppsError);
});

test("the first trigger makes one subscription for the connection, the next adds its events, and the last removes it", async () => {
  const none = stub((c) => (c.method === "GET" ? json({ data: [] }) : json({ id: "whsub_1" }, 201)));
  expect(await own.startPush!("close.lead_created", login, {})).toBe("close:c1");
  expect(none[1]!.method).toBe("POST");
  expect(none[1]!.url).toBe("https://api.close.com/api/v1/webhook/");
  expect(JSON.parse(String(none[1]!.body))).toEqual({ url: target(), events: [{ object_type: "lead", action: "created" }], verify_ssl: true });
  const hooks = { data: [{ id: "other", url: "https://elsewhere" }, { id: "whsub_1", url: target(), status: "active", events: [{ object_type: "lead", action: "created" }] }] };
  const same = stub(() => json(hooks));
  await own.startPush!("close.lead_created", login, {});
  expect(same).toHaveLength(1);
  const extend = stub((c) => (c.method === "GET" ? json(hooks) : json({})));
  await own.startPush!("close.task_completed", login, {});
  expect(extend[1]!.method).toBe("PUT");
  expect(extend[1]!.url).toBe("https://api.close.com/api/v1/webhook/whsub_1/");
  const put = JSON.parse(String(extend[1]!.body));
  expect(put.status).toBe("active");
  expect(put.events[0]).toEqual({ object_type: "lead", action: "created" });
  expect(put.events.map((e: { object_type: string }) => e.object_type)).toContain("task.lead");
  expect(put.events.map((e: { object_type: string }) => e.object_type)).toContain("task.outbound_call");
  const gone = stub((c) => (c.method === "GET" ? json(hooks) : json({})));
  await close.push!.stop!(KEY, "close:c1");
  expect(gone[1]!.method).toBe("DELETE");
  expect(gone[1]!.url).toBe("https://api.close.com/api/v1/webhook/whsub_1/");
});

test("a signed event starts only the right triggers, a retry keeps its id, and forgeries are refused", async () => {
  hookAnswer();
  const receive = close.push!.receive!;
  const won = { id: "ev_1", object_type: "opportunity", action: "updated", object_id: "oppo_1", lead_id: "lead_1", changed_fields: ["status_type"], data: { status_type: "won" } };
  const got = (await (await receive(delivery(won), KEY))!.events())[0]!;
  expect(got.triggers.sort()).toEqual(["opportunity_updated", "opportunity_won"]);
  expect(got.id).toBe("c1:ev_1");
  expect(got.watch).toBe("close:c1");
  expect(got.data).not.toHaveProperty("organization_id");
  expect((await (await receive(delivery(won), KEY))!.events())[0]!.id).toBe("c1:ev_1");
  const note = (await (await receive(delivery({ id: "ev_2", object_type: "activity.note", action: "created" }), KEY))!.events())[0]!;
  expect(note.triggers).toEqual(["note_added"]);
  const task = (await (await receive(delivery({ id: "ev_3", object_type: "task.email_followup", action: "completed" }), KEY))!.events())[0]!;
  expect(task.triggers).toEqual(["task_completed"]);
  expect(await (await receive(delivery({ id: "ev_4", object_type: "lead", action: "weird" }), KEY))!.events()).toEqual([]);
  // a wrong URL token, a wrong signature, or no signature
  expect(await receive(delivery(won, "whsub_1", undefined, "nope"), KEY)).toBeNull();
  expect(await receive(delivery(won, "whsub_1", signed("x")), KEY)).toBeNull();
  expect(await receive(delivery(won, "whsub_1", {}), KEY)).toBeNull();
  // a subscription that isn't ours doesn't lend its key
  stub(() => json({ id: "whsub_9", url: "https://elsewhere", signature_key: SIGNING }));
  expect(await receive(delivery(won, "whsub_9"), KEY)).toBeNull();
});

test("filters narrow what runs", () => {
  const data = { object_type: "opportunity", action: "updated", object_id: "oppo_1", lead_id: "lead_1", user_id: "user_1", changed_fields: ["value"], data: { pipeline_id: "pipe_1", status_id: "stat_1", user_id: "user_2" } };
  expect(wanted({}, data)).toBe(true);
  expect(wanted({ lead_id: "lead_1", user_id: "user_2", pipeline_id: "pipe_1", status_id: "stat_1", field: "value" }, data)).toBe(true);
  expect(wanted({ user_id: "user_1" }, data)).toBe(true);
  expect(wanted({ lead_id: "lead_2" }, data)).toBe(false);
  expect(wanted({ user_id: "user_9" }, data)).toBe(false);
  expect(wanted({ pipeline_id: "pipe_2" }, data)).toBe(false);
  expect(wanted({ status_id: "stat_2" }, data)).toBe(false);
  expect(wanted({ field: "note" }, data)).toBe(false);
  expect(wanted({ lead_id: "lead_7" }, { object_type: "lead", action: "created", object_id: "lead_7", data: {} })).toBe(true);
});

test("Composio's trigger names are all here", () => {
  for (const t of ["bulk_delete_completed", "bulk_email_paused", "call_logged", "comment_added", "custom_activity_logged", "email_thread_started", "lead_creation_activity_added", "lead_status_changed", "lead_status_change_entry_deleted", "note_added", "opportunity_status_changed", "sms_logged", "task_completion_logged", "task_completion_entry_deleted", "whatsapp_message_logged"])
    expect(triggers[t]).toBeDefined();
});

test("the webhook route refuses a bad signature", async () => {
  const find = spyOn(db.query.connections, "findFirst");
  const app = Fastify();
  await automationRoutes(app);
  try {
    find.mockResolvedValue({ id: "row", app: "close", secret: encrypt(KEY), refreshToken: null, expiresAt: null } as never);
    hookAnswer();
    const d = delivery({ id: "ev_9", object_type: "lead", action: "weird" }, "whsub_route");
    const post = (headers: Record<string, string>) => app.inject({ method: "POST", url: `/webhooks/app/close/c1/${token()}`, headers: { "content-type": "application/json", ...headers }, payload: d.body });
    expect((await post(signed("other"))).statusCode).toBe(401);
    // an event no trigger wants needs no database
    expect((await post(d.headers)).statusCode).toBe(200);
  } finally {
    find.mockRestore();
    await app.close();
  }
});
