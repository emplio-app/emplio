import { afterEach, beforeEach, expect, test } from "bun:test";
import { pollOnce } from "../../polls";
import { own } from "../index";
import { BACK, clearZohoEnv, fakeZoho, zohoEnv } from "../zoho-fake";
import { SCOPES } from "./index";

const exec = (action: string, input: unknown, secret: string) => own.run(action, input, { externalId: "c", secret }, "o") as Promise<any>;
beforeEach(zohoEnv);
afterEach(clearZohoEnv);
const accounts = (...list: [string, string][]) => ({ status: { code: 200 }, data: list.map(([accountId, mailboxAddress]) => ({ accountId, mailboxAddress })) });
let n = 0;
const fresh = (dc = "in") => `${dc}:m${n++}`;
const route = (url: URL, more: unknown) => (url.pathname === "/api/accounts" ? accounts(["22", "me@acme.com"]) : url.pathname === "/api/organization" ? { data: { zoid: "7" } } : more);

test("not offered without the client id and secret", async () => {
  clearZohoEnv();
  expect((await own.readyApps()).has("zoho_mail")).toBe(false);
});

test("a sign-in round trip asks for the Mail scopes and can't be forged; the label is the mailbox", async () => {
  const { url } = await own.startSignIn("zoho_mail", "o", BACK);
  const page = new URL(url);
  expect(page.searchParams.get("scope")).toBe(SCOPES);
  expect(page.searchParams.get("redirect_uri")).toBe("https://api.test/oauth/zoho_mail/callback");
  expect(own.readSignIn!("zoho_mail", `${page.searchParams.get("state")!.split(".")[0]}.forged`)).toBeNull();
  const sent = fakeZoho((u) => (u.pathname.endsWith("/token") ? { access_token: "a1", refresh_token: "r1", expires_in: 3600 } : accounts(["22", "me@acme.com"])));
  expect(await own.finishSignIn!("zoho_mail", "c", BACK, { location: "eu" })).toMatchObject({ secret: "eu:a1", label: "me@acme.com" });
  expect(sent[1]!.url).toBe("https://mail.zoho.eu/api/accounts");
  expect(sent[1]!.headers.Authorization).toBe("Zoho-oauthtoken a1");
});

test("reads run unasked and writes ask", async () => {
  expect((await own.getAction("zoho_mail.messages_list_emails"))?.readOnly).toBe(true);
  expect((await own.getAction("zoho_mail.messages_send_email"))?.readOnly).toBe(false);
});

test("the wire format, with the only mailbox filled in, and an EU or India login reaches its own host", async () => {
  let sent = fakeZoho((u) => route(u, { status: { code: 200 }, data: { messageId: "m1" } }));
  await exec("zoho_mail.messages_send_email", { fromAddress: "me@acme.com", toAddress: "a@b.com", subject: "Hi", content: "Hello" }, fresh("in"));
  const call = sent.at(-1)!;
  expect(call.url).toBe("https://mail.zoho.in/api/accounts/22/messages");
  expect(call.body).toEqual({ fromAddress: "me@acme.com", toAddress: "a@b.com", subject: "Hi", content: "Hello" });
  sent = fakeZoho((u) => route(u, { status: { code: 200 }, data: [] }));
  await exec("zoho_mail.messages_list_emails", {}, fresh("eu"));
  expect(sent.at(-1)!.url).toBe("https://mail.zoho.eu/api/accounts/22/messages/view");
});

test("the fixed mode of a one-purpose action is sent for you", async () => {
  const sent = fakeZoho((u) => route(u, { status: { code: 200 } }));
  await exec("zoho_mail.mark_emails_as_read", { messageId: ["1"] }, fresh());
  expect(sent.at(-1)!.body).toMatchObject({ mode: "markAsRead", messageId: ["1"] });
});

test("several mailboxes ask which; admin calls get the organisation id", async () => {
  fakeZoho((u) => (u.pathname === "/api/accounts" ? accounts(["1", "a@x.com"], ["2", "b@x.com"]) : {}));
  await expect(exec("zoho_mail.messages_list_emails", {}, fresh())).rejects.toThrow(/1 \(a@x\.com\), 2 \(b@x\.com\)/);
  const sent = fakeZoho((u) => route(u, { status: { code: 200 }, data: [] }));
  await exec("zoho_mail.list_organization_accounts", {}, fresh());
  expect(sent.at(-1)!.url).toBe("https://mail.zoho.in/api/organization/7/accounts");
});

test("a failure with a 200, and a dead token", async () => {
  fakeZoho((u) => route(u, { status: { code: 400, description: "Invalid Input" }, data: { errorCode: "INVALID_INPUT" } }));
  await expect(exec("zoho_mail.messages_list_emails", {}, fresh())).rejects.toThrow("Invalid Input");
  fakeZoho((u) => route(u, { $status: 401, body: { status: { code: 401, description: "Invalid" }, data: { errorCode: "INVALID_OAUTHTOKEN" } } }));
  expect((await exec("zoho_mail.messages_list_emails", {}, fresh()).catch((e) => e)).expired).toBe(true);
});

test("new_message: first check notes, later ones report, the sender filter applies", async () => {
  const key = fresh();
  let data = [{ messageId: "a", fromAddress: "x@acme.com" }];
  const sent = fakeZoho((u) => route(u, { status: { code: 200 }, data }));
  const run = (a: string, i: unknown) => exec(a, i, key);
  const first = await pollOnce("zoho_mail.new_message", {}, null, run);
  expect(first.fresh).toHaveLength(0);
  expect(sent.at(-1)!.query.get("sortorder")).toBe("false");
  data = [...data, { messageId: "b", fromAddress: "y@other.com" }, { messageId: "c", fromAddress: "z@acme.com" }];
  const next = await pollOnce("zoho_mail.new_message", { sender: "acme.com" }, first.seen, run);
  expect(next.fresh).toHaveLength(1);
  expect((next.fresh[0] as any).message.messageId).toBe("c");
});
