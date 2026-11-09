import { afterEach, beforeEach, expect, test } from "bun:test";
import { pollOnce } from "../../polls";
import { AppFile } from "../../types";
import { own } from "../index";
import { BACK, clearZohoEnv, fakeZoho, zohoEnv } from "../zoho-fake";
import { SCOPES } from "./index";

const exec = (action: string, input: unknown, secret: string) => own.run(action, input, { externalId: "c", secret }, "o") as Promise<any>;
beforeEach(zohoEnv);
afterEach(clearZohoEnv);
const me = { users: [{ full_name: "Priya Rao", email: "p@acme.com" }] };

test("not offered without the client id and secret", async () => {
  clearZohoEnv();
  expect((await own.readyApps()).has("zoho")).toBe(false);
});

test("a sign-in round trip asks for the CRM scopes and can't be forged; the label is the signed-in user", async () => {
  const { url } = await own.startSignIn("zoho", "o", BACK);
  const page = new URL(url);
  expect(page.searchParams.get("scope")).toBe(SCOPES);
  expect(page.searchParams.get("redirect_uri")).toBe("https://api.test/oauth/zoho/callback");
  expect(own.readSignIn!("zoho", `${page.searchParams.get("state")!.split(".")[0]}.forged`)).toBeNull();
  const sent = fakeZoho((u) => (u.pathname.endsWith("/token") ? { access_token: "a1", refresh_token: "r1", expires_in: 3600 } : me));
  expect(await own.finishSignIn!("zoho", "c", BACK, { location: "eu" })).toMatchObject({ secret: "eu:a1", label: "Priya Rao" });
  expect(sent[1]!.url).toBe("https://www.zohoapis.eu/crm/v8/users");
  expect(sent[1]!.query.get("type")).toBe("CurrentUser");
});

test("reads run unasked and writes ask", async () => {
  expect((await own.getAction("zoho.get_zoho_records"))?.readOnly).toBe(true);
  expect((await own.getAction("zoho.list_leads"))?.readOnly).toBe(true);
  expect((await own.getAction("zoho.create_lead"))?.readOnly).toBeFalsy();
  expect((await own.getAction("zoho.get_related_records_count"))?.readOnly).toBe(true);
});

test("the wire format, and an EU or India login reaches its own host", async () => {
  let sent = fakeZoho(() => ({ data: [{ code: "SUCCESS", status: "success" }] }));
  await exec("zoho.create_lead", { record: { Last_Name: "Rao" } }, "in:t1");
  expect(sent[0]!.url).toBe("https://www.zohoapis.in/crm/v8/Leads");
  expect(sent[0]!.headers.Authorization).toBe("Zoho-oauthtoken t1");
  expect(sent[0]!.body).toEqual({ data: [{ Last_Name: "Rao" }] });
  sent = fakeZoho(() => ({ data: [] }));
  await exec("zoho.get_zoho_records", { module: "Deals", fields: "Deal_Name" }, "eu:t2");
  expect(sent[0]!.url).toBe("https://www.zohoapis.eu/crm/v8/Deals");
  expect(sent[0]!.query.get("fields")).toBe("Deal_Name");
});

test("bulk and upload calls go to their own addresses in the login's data centre", async () => {
  const sent = fakeZoho(() => ({ data: [{ status: "success" }] }));
  await exec("zoho.create_bulk_read_job", { callback: { url: "https://x.test", method: "post" }, query: { module: { api_name: "Leads" } } }, "eu:t3");
  expect(sent.at(-1)!.url).toBe("https://www.zohoapis.eu/crm/bulk/v8/read");
  await exec("zoho.upload_file_to_crm", { x_crm_org: 1, feature: "bulk-write", file: new AppFile("a.zip", "application/zip", new Uint8Array([1])) }, "in:t3b");
  expect(sent.at(-1)!.url).toBe("https://upload.zoho.in/crm/v8/upload");
});

test("a failure with a 200: every row failing is an error, some rows failing comes back whole", async () => {
  fakeZoho(() => ({ data: [{ code: "MANDATORY_NOT_FOUND", status: "error", message: "Last_Name is required" }] }));
  await expect(exec("zoho.create_lead", { record: {} }, "in:t4")).rejects.toThrow("Last_Name is required");
  fakeZoho(() => ({ data: [{ code: "SUCCESS", status: "success" }, { code: "INVALID_DATA", status: "error", message: "x" }] }));
  expect(await exec("zoho.create_lead", { record: {} }, "in:t5")).toMatchObject({ data: [{ status: "success" }, { status: "error" }] });
  fakeZoho(() => ({ code: "INVALID_REQUEST", status: "error", message: "bad call" }));
  await expect(exec("zoho.list_leads", {}, "in:t6")).rejects.toThrow("bad call");
});

test("a dead token marks the connection expired; a scope mismatch doesn't", async () => {
  fakeZoho(() => ({ $status: 401, body: { code: "INVALID_TOKEN", message: "invalid oauth token" } }));
  expect((await exec("zoho.list_leads", {}, "in:t7").catch((e) => e)).expired).toBe(true);
  fakeZoho(() => ({ $status: 401, body: { code: "OAUTH_SCOPE_MISMATCH", message: "no scope" } }));
  expect((await exec("zoho.list_leads", {}, "in:t8").catch((e) => e)).expired).toBe(false);
});

test("polled triggers: first check notes, new leads and changes come later with the right sort", async () => {
  let data = [{ id: "1", Modified_Time: "t1" }];
  const sent = fakeZoho(() => ({ data }));
  const run = (a: string, i: unknown) => exec(a, i, "in:t9");
  const first = await pollOnce("zoho.new_lead", {}, null, run);
  expect(first.fresh).toHaveLength(0);
  expect(sent[0]!.query.get("sort_by")).toBe("Created_Time");
  expect(sent[0]!.query.get("sort_order")).toBe("desc");
  data = [...data, { id: "2", Modified_Time: "t1" }];
  const next = await pollOnce("zoho.new_lead", {}, first.seen, run);
  expect((next.fresh[0] as any).lead.id).toBe("2");
  const seen = await pollOnce("zoho.deal_updated", {}, null, run);
  data = [{ id: "1", Modified_Time: "t2" }, data[1]!];
  const changed = await pollOnce("zoho.deal_updated", {}, seen.seen, run);
  expect((changed.fresh[0] as any).deal).toEqual({ id: "1", Modified_Time: "t2" });
});

test("no records comes back as none, not an error", async () => {
  globalThis.fetch = (async () => new Response(null, { status: 204 })) as unknown as typeof fetch;
  expect(await pollOnce("zoho.new_contact", {}, null, (a, i) => exec(a, i, "in:t10"))).toMatchObject({ fresh: [] });
});
