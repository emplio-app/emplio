import { afterEach, beforeEach, expect, test } from "bun:test";
import { pollOnce } from "../../polls";
import { own } from "../index";
import { BACK, clearZohoEnv, fakeZoho, zohoEnv } from "../zoho-fake";
import { SCOPES } from "./index";

const exec = (action: string, input: unknown, secret: string) => own.run(action, input, { externalId: "c", secret }, "o") as Promise<any>;
beforeEach(zohoEnv);
afterEach(clearZohoEnv);
const ok = { status: "success", code: "0" };

test("not offered without the client id and secret", async () => {
  clearZohoEnv();
  expect((await own.readyApps()).has("zoho_campaigns")).toBe(false);
});

test("a sign-in round trip asks for the Campaigns scopes, can't be forged, and checks on the login's own data centre", async () => {
  const { url } = await own.startSignIn("zoho_campaigns", "o", BACK);
  const page = new URL(url);
  expect(page.searchParams.get("scope")).toBe(SCOPES);
  expect(page.searchParams.get("redirect_uri")).toBe("https://api.test/oauth/zoho_campaigns/callback");
  expect(own.readSignIn!("zoho_campaigns", `${page.searchParams.get("state")!.split(".")[0]}.forged`)).toBeNull();
  const sent = fakeZoho((u) => (u.pathname.endsWith("/token") ? { access_token: "a1", refresh_token: "r1", expires_in: 3600 } : { response: { code: "0", fieldname: [] } }));
  expect(await own.finishSignIn!("zoho_campaigns", "c", BACK, { location: "eu" })).toMatchObject({ secret: "eu:a1" });
  expect(sent[1]!.url).toBe("https://campaigns.zoho.eu/api/v1.1/contact/allfields");
  expect(sent[1]!.query.get("type")).toBe("json");
  expect(sent[1]!.headers.Authorization).toBe("Zoho-oauthtoken a1");
});

test("reads run unasked; writes, and sending above all, ask", async () => {
  for (const a of ["list_mailing_lists", "get_campaign_report", "list_campaign_recipients", "get_last_campaign_report", "list_tags"]) expect((await own.getAction(`zoho_campaigns.${a}`))?.readOnly).toBe(true);
  for (const a of ["send_campaign", "schedule_campaign", "subscribe_contact", "delete_campaign", "create_tag", "mark_coupon_used"]) expect((await own.getAction(`zoho_campaigns.${a}`))?.readOnly).toBe(false);
});

test("the wire format: a contact as Zoho's contactinfo, on an India login's host", async () => {
  const sent = fakeZoho(() => ok);
  await exec("zoho_campaigns.subscribe_contact", { listkey: "L1", contact_email: "a@b.com", first_name: "Asha", fields: { City: "Pune" } }, "in:t");
  const call = sent.at(-1)!;
  expect(call.method).toBe("POST");
  expect(call.url).toBe("https://campaigns.zoho.in/api/v1.1/json/listsubscribe");
  expect(call.query.get("resfmt")).toBe("JSON");
  expect(call.query.get("listkey")).toBe("L1");
  expect(JSON.parse(call.query.get("contactinfo")!)).toEqual({ "Contact Email": "a@b.com", "First Name": "Asha", City: "Pune" });
});

test("a campaign's lists go as JSON, several emails comma separated, schedules and workflows fill in their fixed parts", async () => {
  const sent = fakeZoho(() => ok);
  await exec("zoho_campaigns.create_campaign", { campaignname: "Nov", subject: "Hi", from_email: "me@acme.com", list_details: { L1: [] }, segments: ["9", "8"] }, "us:t");
  expect(JSON.parse(sent.at(-1)!.query.get("list_details")!)).toEqual({ L1: [] });
  expect(sent.at(-1)!.query.get("segments")).toBe("[9,8]");
  await exec("zoho_campaigns.add_contacts_to_mailing_list", { listkey: "L1", emailids: ["a@b.com", "c@d.com"] }, "us:t");
  expect(sent.at(-1)!.query.get("emailids")).toBe("a@b.com,c@d.com");
  await exec("zoho_campaigns.schedule_campaign", { campaignkey: "K", scheduledate: "12/01/2026", schedulehour: 9, scheduleminute: "00", am_pm: "am" }, "us:t");
  expect(sent.at(-1)!.query.get("isschedule")).toBe("true");
  await exec("zoho_campaigns.trigger_workflow_contacts", { workflow_key: "W", triggerkey: "T", listkey: "L1", lead_email: "a@b.com" }, "us:t");
  expect(sent.at(-1)!.url).toBe("https://campaigns.zoho.com/api/v1.1/workflow/W/action/trigger");
  expect(JSON.parse(sent.at(-1)!.query.get("details")!)).toEqual({ triggerkey: "T", listkey: "L1", lead_email: "a@b.com" });
});

test("a failure with a 200 is an error, an empty account isn't, and a dead login asks to reconnect", async () => {
  fakeZoho(() => ({ status: "failure", code: "9001", message: "Tag not found" }));
  await expect(exec("zoho_campaigns.delete_tag", { tagName: "x" }, "us:t")).rejects.toThrow("Tag not found");
  fakeZoho(() => ({ code: "6606", message: "No lists selected for this campaign." }));
  await expect(exec("zoho_campaigns.create_campaign", { campaignname: "a", subject: "b", from_email: "c" }, "us:t")).rejects.toThrow("No lists selected");
  fakeZoho(() => ({ status: "failure", code: "2401", message: "No mailing list has been created" }));
  expect(await exec("zoho_campaigns.list_mailing_lists", {}, "us:t")).toMatchObject({ code: "2401" });
  fakeZoho(() => ({ $status: 401, body: { code: "INVALID_OAUTHTOKEN" } }));
  expect((await exec("zoho_campaigns.list_mailing_lists", {}, "us:t").catch((e) => e)).expired).toBe(true);
});

test("new_subscriber and contact_unsubscribed: across every list, first check notes, later ones report", async () => {
  let members: Record<string, any[]> = { L1: [{ contact_email: "a@x.com" }], L2: [] };
  const sent = fakeZoho((u) =>
    u.pathname.endsWith("/getmailinglists") ? { ...ok, list_of_details: [{ listkey: "L1", listname: "News" }, { listkey: "L2", listname: "Shop" }] } : { ...ok, list_of_details: members[u.searchParams.get("listkey")!] },
  );
  const run = (a: string, i: unknown) => exec(a, i, "us:t");
  const first = await pollOnce("zoho_campaigns.new_subscriber", {}, null, run);
  expect(first.fresh).toHaveLength(0);
  expect(sent.at(-1)!.query.get("status")).toBe("active");
  members = { L1: [{ contact_email: "a@x.com" }], L2: [{ contact_email: "a@x.com" }] };
  const next = await pollOnce("zoho_campaigns.new_subscriber", {}, first.seen, run);
  expect(next.fresh).toEqual([{ contact: { contact_email: "a@x.com" }, list: { listkey: "L2", listname: "Shop" } }]);
  await pollOnce("zoho_campaigns.contact_unsubscribed", { listkey: "L1" }, null, run);
  expect(sent.at(-1)!.query.get("status")).toBe("unsub");
  expect(sent.some((s) => s.path.endsWith("/getmailinglists") && s.query.get("status"))).toBe(false);
});

test("campaign_sent reports each sent campaign once", async () => {
  let recent = [{ campaign_key: "c1", campaign_name: "Oct" }];
  const sent = fakeZoho(() => ({ ...ok, recent_campaigns: recent }));
  const run = (a: string, i: unknown) => exec(a, i, "us:t");
  const first = await pollOnce("zoho_campaigns.campaign_sent", {}, null, run);
  expect(sent.at(-1)!.query.get("status")).toBe("sent");
  recent = [{ campaign_key: "c2", campaign_name: "Nov" }, ...recent];
  const next = await pollOnce("zoho_campaigns.campaign_sent", {}, first.seen, run);
  expect(next.fresh).toEqual([{ campaign: { campaign_key: "c2", campaign_name: "Nov" } }]);
});
