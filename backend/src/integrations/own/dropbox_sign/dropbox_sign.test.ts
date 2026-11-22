import { afterEach, beforeAll, expect, spyOn, test } from "bun:test";
import { createHmac, randomBytes } from "node:crypto";
import Fastify from "fastify";
import { automationRoutes } from "../../../automations";
import { db } from "../../../db";
import { encrypt } from "../../../secrets";
import { AppFile, AppsError } from "../../types";
import { own } from "../index";
import { dropbox_sign } from "./index";
import { triggers, wanted } from "./triggers";

beforeAll(() => {
  process.env.ENCRYPTION_KEY = randomBytes(32).toString("base64");
  process.env.WEBHOOK_URL = "https://api.test";
});
const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});
type Call = { url: string; method: string; body: BodyInit | null | undefined; headers: Record<string, string> };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const stub = (answer: (c: Call) => Response) => {
  const calls: Call[] = [];
  globalThis.fetch = (async (url: string, init: RequestInit = {}) => {
    const c = { url: String(url), method: init.method ?? "GET", body: init.body, headers: init.headers as Record<string, string> };
    calls.push(c);
    return answer(c);
  }) as typeof fetch;
  return calls;
};
const login = { externalId: "c1", secret: "KEY" };
const token = () => createHmac("sha256", process.env.ENCRYPTION_KEY!).update("dropbox_sign-webhook:c1").digest("hex");
const ours = () => `https://api.test/webhooks/app/dropbox_sign/c1/${token()}`;
const event = (type: string, extra: object = {}, key = "KEY", time = "1763800000") => ({
  event: { event_time: time, event_type: type, event_hash: createHmac("sha256", key).update(time + type).digest("hex"), event_metadata: { related_signature_id: "sig2" } },
  signature_request: { signature_request_id: "sr1", template_ids: ["t1"], signatures: [{ signature_id: "sig1", signer_email_address: "a@x.com" }, { signature_id: "sig2", signer_email_address: "Sarah@Northwind.com" }] },
  ...extra,
});
const form = (payload: unknown) => ({ body: new URLSearchParams({ json: JSON.stringify(payload) }).toString(), headers: { "content-type": "application/x-www-form-urlencoded" }, connection: "c1", rest: token() });

test("a key is checked as basic auth and labelled, and a bad one is refused as dead", async () => {
  const calls = stub(() => json({ account: { account_id: "a1", email_address: "owner@northwind.com" } }));
  expect(await own.connectWithKey!("dropbox_sign", " KEY ")).toEqual({ secret: "KEY", label: "owner@northwind.com" });
  expect(calls[0]!.url).toBe("https://api.hellosign.com/v3/account");
  expect(calls[0]!.headers.Authorization).toBe(`Basic ${btoa("KEY:")}`);
  stub(() => json({ error: { error_msg: "Unauthorized api key", error_name: "unauthorized" } }, 401));
  const refused = await own.connectWithKey!("dropbox_sign", "nope").catch((e) => e);
  expect(refused).toBeInstanceOf(AppsError);
  expect(refused.expired).toBe(true);
});

test("reads run unasked, writes and secrets ask", async () => {
  expect((await own.getAction("dropbox_sign.get_signature_request"))?.readOnly).toBe(true);
  expect((await own.getAction("dropbox_sign.list_templates"))?.readOnly).toBe(true);
  expect((await own.getAction("dropbox_sign.send_signature_request"))?.readOnly).toBe(false);
  expect((await own.getAction("dropbox_sign.cancel_signature_request"))?.readOnly).toBe(false);
  expect((await own.getAction("dropbox_sign.get_api_app"))?.readOnly).toBe(false);
});

test("a request with links goes as JSON, one with a file as multipart", async () => {
  const calls = stub(() => json({ signature_request: { signature_request_id: "sr1" } }));
  const signers = [{ email_address: "sarah@northwind.com", name: "Sarah" }];
  await own.run("dropbox_sign.send_signature_request", { title: "NDA", signers, file_urls: ["https://x/nda.pdf"], test_mode: true }, login, "o");
  expect(calls[0]!.url).toBe("https://api.hellosign.com/v3/signature_request/send");
  expect(JSON.parse(String(calls[0]!.body))).toMatchObject({ title: "NDA", signers, file_urls: ["https://x/nda.pdf"], test_mode: true });
  const pdf = new AppFile("nda.pdf", "application/pdf", new Uint8Array([37, 80, 68, 70]));
  await dropbox_sign.actions.send_signature_request!.run({ title: "NDA", signers, files: [pdf], test_mode: true }, "KEY");
  const sent = calls[1]!.body as FormData;
  expect(sent).toBeInstanceOf(FormData);
  expect((sent.get("files") as File).name).toBe("nda.pdf");
  expect(JSON.parse(String(sent.get("signers")))).toEqual(signers);
  expect(sent.get("title")).toBe("NDA");
});

test("a signed copy comes back as a file with its extension", async () => {
  stub(() => new Response(new Uint8Array([37, 80, 68, 70]), { headers: { "content-type": "application/pdf" } }));
  const got = await own.run("dropbox_sign.download_signature_request_files", { signature_request_id: "sr1", file_type: "pdf" }, login, "o");
  expect(got).toBeInstanceOf(AppFile);
  expect((got as AppFile).name).toBe("sr1.pdf");
});

test("the first automation points the account's callback at us, the next reuses it", async () => {
  let callback = "";
  const answer = (c: Call) => {
    if (c.method === "PUT") callback = JSON.parse(String(c.body)).callback_url;
    return json({ account: { account_id: "a1", callback_url: callback || null } });
  };
  const first = stub(answer);
  expect(await own.startPush!("dropbox_sign.signature_request_signed", login, {})).toBe("dropbox_sign:c1");
  expect(first.map((c) => c.method)).toEqual(["GET", "PUT"]);
  expect(callback).toBe(ours());
  const again = stub(answer);
  await own.startPush!("dropbox_sign.signature_request_all_signed", login, {});
  expect(again.map((c) => c.method)).toEqual(["GET"]);
});

test("someone else's callback is left alone; an older one of ours is replaced", async () => {
  stub(() => json({ account: { callback_url: "https://crm.northwind.com/hook" } }));
  await expect(own.startPush!("dropbox_sign.signature_request_signed", login, {})).rejects.toThrow(/already sends its events/);
  const calls = stub(() => json({ account: { callback_url: "https://api.test/webhooks/app/dropbox_sign/old/abc" } }));
  await own.startPush!("dropbox_sign.signature_request_signed", login, {});
  expect(calls.map((c) => c.method)).toEqual(["GET", "PUT"]);
});

test("the last automation clears the callback, only if it's still ours", async () => {
  const mine = stub(() => json({ account: { callback_url: ours() } }));
  await dropbox_sign.push!.stop!("KEY", "dropbox_sign:c1");
  expect(mine.map((c) => c.method)).toEqual(["GET", "PUT"]);
  expect(JSON.parse(String(mine[1]!.body))).toEqual({ callback_url: "" });
  const theirs = stub(() => json({ account: { callback_url: "https://crm.northwind.com/hook" } }));
  await dropbox_sign.push!.stop!("KEY", "dropbox_sign:c1");
  expect(theirs).toHaveLength(1);
});

test("an event starts only its own trigger, with the signer it's about, and answers as Dropbox Sign wants", async () => {
  for (const type of ["signature_request_signed", "signature_request_declined", "template_created", "fax_received"]) {
    const got = await dropbox_sign.push!.receive!(form(event(type)), "KEY");
    expect(got!.reply).toBe("Hello API Event Received");
    const [out] = await got!.events();
    expect(out!.triggers).toEqual([type]);
    expect(out!.watch).toBe("dropbox_sign:c1");
  }
  const [signed] = await (await dropbox_sign.push!.receive!(form(event("signature_request_signed")), "KEY"))!.events();
  expect((signed!.data as { signer: { signer_email_address: string } }).signer.signer_email_address).toBe("Sarah@Northwind.com");
  // a retry has the same id, another signer's event another
  const [retry] = await (await dropbox_sign.push!.receive!(form(event("signature_request_signed")), "KEY"))!.events();
  expect(retry!.id).toBe(signed!.id!);
  // the test Dropbox Sign sends when the callback is set: answered, nothing runs
  const test = await dropbox_sign.push!.receive!(form(event("callback_test")), "KEY");
  expect(test!.reply).toBe("Hello API Event Received");
  expect(await test!.events()).toEqual([]);
});

test("a plain JSON or multipart delivery reads the same", async () => {
  const body = event("signature_request_sent");
  const plain = await dropbox_sign.push!.receive!({ ...form(body), body: JSON.stringify(body), headers: { "content-type": "application/json" } }, "KEY");
  expect((await plain!.events())[0]!.triggers).toEqual(["signature_request_sent"]);
  const fd = new FormData();
  fd.append("json", JSON.stringify(body));
  const req = new Request("http://x", { method: "POST", body: fd });
  const type = req.headers.get("content-type")!;
  const multi = await dropbox_sign.push!.receive!({ ...form(body), body: await req.text(), headers: { "content-type": type } }, "KEY");
  expect((await multi!.events())[0]!.triggers).toEqual(["signature_request_sent"]);
});

test("a wrong hash, key or address is refused", async () => {
  expect(await dropbox_sign.push!.receive!(form(event("signature_request_signed", {}, "OTHER")), "KEY")).toBeNull();
  expect(await dropbox_sign.push!.receive!({ ...form(event("signature_request_signed")), rest: "nope" }, "KEY")).toBeNull();
  expect(await dropbox_sign.push!.receive!({ ...form(event("signature_request_signed")), body: "json=notjson" }, "KEY")).toBeNull();
  const forged = event("signature_request_signed");
  forged.event.event_type = "signature_request_all_signed";
  expect(await dropbox_sign.push!.receive!(form(forged), "KEY")).toBeNull();
});

test("filters narrow what runs", async () => {
  const [out] = await (await dropbox_sign.push!.receive!(form(event("signature_request_signed")), "KEY"))!.events();
  const data = out!.data;
  expect(wanted({}, data)).toBe(true);
  expect(wanted({ signature_request_id: "sr1" }, data)).toBe(true);
  expect(wanted({ signature_request_id: "sr2" }, data)).toBe(false);
  expect(wanted({ template_id: "t1" }, data)).toBe(true);
  expect(wanted({ template_id: "t2" }, data)).toBe(false);
  expect(wanted({ signer_email: "sarah@northwind.com" }, data)).toBe(true);
  expect(wanted({ signer_email: "a@x.com" }, data)).toBe(false);
});

test("every callback event but the test is a trigger", () => {
  expect(Object.keys(triggers)).toHaveLength(29);
  expect(triggers.callback_test).toBeUndefined();
});

test("the webhook route takes only Dropbox Sign's hash, and answers its words", async () => {
  const find = spyOn(db.query.connections, "findFirst");
  const app = Fastify();
  await automationRoutes(app);
  const post = (payload: unknown) =>
    app.inject({ method: "POST", url: `/webhooks/app/dropbox_sign/c1/${token()}`, headers: { "content-type": "application/x-www-form-urlencoded" }, payload: form(payload).body });
  try {
    find.mockResolvedValue({ id: "row", app: "dropbox_sign", secret: encrypt("KEY"), refreshToken: null, expiresAt: null } as never);
    expect((await post(event("callback_test", {}, "OTHER"))).statusCode).toBe(401);
    // callback_test starts nothing, so a 200 needs no database
    const ok = await post(event("callback_test"));
    expect(ok.statusCode).toBe(200);
    expect(ok.body).toBe("Hello API Event Received");
  } finally {
    find.mockRestore();
    await app.close();
  }
});
