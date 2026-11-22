import { afterEach, expect, test } from "bun:test";
// a documentation address; the real one is the server's NAMECHEAP_CLIENT_IP
process.env.NAMECHEAP_CLIENT_IP = "203.0.113.7";
import { z } from "zod";
import { AppsError } from "../../types";
import { namecheap as polls } from "../../polls/namecheap";
import { accountActions } from "./account";
import { parseXml, toJson } from "./client";
import { dnsActions } from "./dns";
import { domainActions } from "./domains";
import { namecheap } from "./index";
import { sslActions } from "./ssl";

type Call = { url: string; form: Record<string, string> };
const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const ok = (inner: string) => `<?xml version="1.0" encoding="utf-8"?>
<ApiResponse Status="OK" xmlns="http://api.namecheap.com/xml.response"><Errors /><Warnings /><RequestedCommand>x</RequestedCommand>
<CommandResponse Type="x">${inner}</CommandResponse><Server>S</Server></ApiResponse>`;
const err = (number: string, text: string) => `<?xml version="1.0" encoding="utf-8"?>
<ApiResponse Status="ERROR" xmlns="http://api.namecheap.com/xml.response"><Errors><Error Number="${number}">${text}</Error></Errors><Warnings /><CommandResponse /></ApiResponse>`;

// answers each call by its Command; anything unanswered is a test bug, not a trip to Namecheap
function stub(reply: (command: string, c: Call) => string | undefined) {
  const calls: Call[] = [];
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    const c = { url, form: Object.fromEntries(new URLSearchParams(String(init.body))) };
    calls.push(c);
    const body = reply(c.form.Command!, c);
    if (body === undefined) throw new Error(`unexpected ${c.form.Command}`);
    return new Response(body, { status: 200, headers: { "content-type": "text/xml" } });
  }) as typeof fetch;
  return calls;
}

const KEY = "apiuser:abc123";
const run = (action: string, input: unknown, key = KEY) => {
  const a = namecheap.actions[action];
  if (!a) throw new Error(`no action ${action}`);
  return a.run(a.input.parse(input), key);
};
const fails = (p: Promise<unknown>) =>
  p.then(
    () => {
      throw new Error("expected it to fail");
    },
    (e: AppsError) => e,
  );

test("every group's actions are there once, named plainly, with inputs that turn into JSON schemas", () => {
  const groups = [domainActions, dnsActions, sslActions, accountActions];
  expect(Object.keys(namecheap.actions)).toHaveLength(groups.reduce((n, g) => n + Object.keys(g).length, 0));
  for (const [name, a] of Object.entries(namecheap.actions)) {
    expect(name).toMatch(/^[a-z0-9_]+$/);
    expect(() => z.toJSONSchema(a.input, { io: "input" })).not.toThrow();
  }
});

test("reads run unasked, anything that changes or costs money asks first", () => {
  for (const r of ["list_domains", "get_domain_info", "check_domain_availability", "get_dns_hosts", "get_balances", "list_ssl_certificates", "list_domain_privacy"])
    expect(namecheap.actions[r]!.readOnly).toBe(true);
  for (const w of ["register_domain", "renew_domain", "set_dns_hosts", "add_dns_records", "delete_dns_records", "buy_ssl_certificate", "enable_domain_privacy", "change_password"])
    expect(namecheap.actions[w]!.readOnly).toBeFalsy();
});

test("the key is checked with the balance, sent as ApiUser/ApiKey/UserName with Emplio's IP, and labels the connection", async () => {
  const calls = stub(() => ok(`<UserGetBalancesResult Currency="USD" AvailableBalance="10.00" />`));
  expect(await namecheap.check("apiuser:abc123:client1")).toBe("client1");
  expect(calls[0]!.url).toBe("https://api.namecheap.com/xml.response");
  expect(calls[0]!.form).toMatchObject({ ApiUser: "apiuser", ApiKey: "abc123", UserName: "client1", ClientIp: "203.0.113.7", Command: "namecheap.users.getBalances" });
  await expect(namecheap.check("justakey")).rejects.toThrow(/username and API key/);
  expect(namecheap.keyField!.help).toContain("203.0.113.7");
});

test("a refused key marks the connection for reconnecting; an IP not on the allow-list says which IP to add", async () => {
  stub(() => err("1011102", "API Key is invalid or API access has not been enabled"));
  const dead = await fails(namecheap.check(KEY));
  expect(dead.expired).toBe(true);
  stub(() => err("1011150", "Invalid request IP: 203.0.113.7"));
  const ip = await fails(run("get_balances", {}));
  expect(ip.expired).toBe(false);
  expect(ip.message).toContain("Whitelisted IPs");
  expect(ip.message).toContain("203.0.113.7");
  stub(() => err("2019166", "Domain not found"));
  expect((await fails(run("get_domain_info", { DomainName: "nope.com" }))).message).toBe("Namecheap: Domain not found (2019166)");
});

test("XML turns into plain JSON: attributes, true/false, nested text, lists of one stay lists", async () => {
  const calls = stub(() =>
    ok(`<DomainGetListResult><Domain ID="1" Name="a.com" Expires="06/02/2027" AutoRenew="true" IsLocked="false" /></DomainGetListResult><Paging><TotalItems>1</TotalItems></Paging>`),
  );
  const out = (await run("list_domains", { ListType: "EXPIRING" })) as any;
  expect(out.DomainGetListResult.Domain).toEqual([{ ID: "1", Name: "a.com", Expires: "06/02/2027", AutoRenew: true, IsLocked: false }]);
  expect(out.Paging.TotalItems).toBe("1");
  expect(calls[0]!.form.ListType).toBe("EXPIRING");
  expect(toJson(parseXml(`<a x="1 &amp; 2"><b>t&lt;</b><b><![CDATA[<c>]]></b>tail</a>`).kids[0]!)).toEqual({ x: "1 & 2", b: ["t<", "<c>"], value: "tail" });
});

test("a command that answers OK with IsSuccess=false is a failure", async () => {
  stub(() => ok(`<DomainDNSSetHostsResult Domain="a.com" IsSuccess="false" />`));
  await expect(run("set_dns_hosts", { DomainName: "a.com", hosts: [{ HostName: "@", RecordType: "A", Address: "1.2.3.4" }], EmailType: "MX" })).rejects.toThrow(/IsSuccess/);
});

test("DNS commands split the domain into SLD and TLD, and records go numbered", async () => {
  const calls = stub(() => ok(`<DomainDNSSetHostsResult Domain="shop.co.uk" IsSuccess="true" />`));
  await run("set_dns_hosts", {
    DomainName: "Shop.co.uk",
    hosts: [
      { HostName: "@", RecordType: "A", Address: "1.2.3.4", TTL: 300 },
      { HostName: "@", RecordType: "MX", Address: "mx.zoho.in" },
    ],
    EmailType: "MX",
  });
  expect(calls[0]!.form).toMatchObject({ SLD: "shop", TLD: "co.uk", HostName1: "@", RecordType1: "A", Address1: "1.2.3.4", TTL1: "300", RecordType2: "MX", MXPref2: "10", EmailType: "MX" });
  expect(calls[0]!.form.DomainName).toBeUndefined();
  expect(calls[0]!.form.MXPref1).toBeUndefined();
});

test("adding a record keeps the others and the email setting; an MX switches email to MX", async () => {
  const hosts = `<DomainDNSGetHostsResult Domain="a.com" EmailType="FWD" IsUsingOurDNS="true">
    <host HostId="1" Name="@" Type="A" Address="1.2.3.4" MXPref="10" TTL="1800" />
    <host HostId="2" Name="www" Type="CNAME" Address="a.com." MXPref="10" TTL="1800" /></DomainDNSGetHostsResult>`;
  let calls = stub((c) => (c === "namecheap.domains.dns.getHosts" ? ok(hosts) : ok(`<DomainDNSSetHostsResult IsSuccess="true" />`)));
  await run("add_dns_records", { DomainName: "a.com", records: [{ HostName: "@", RecordType: "TXT", Address: "v=spf1 -all" }] });
  expect(calls[1]!.form).toMatchObject({ HostName1: "@", RecordType1: "A", HostName2: "www", RecordType2: "CNAME", RecordType3: "TXT", Address3: "v=spf1 -all", EmailType: "FWD" });

  calls = stub((c) => (c === "namecheap.domains.dns.getHosts" ? ok(hosts) : ok(`<DomainDNSSetHostsResult IsSuccess="true" />`)));
  await run("add_dns_records", { DomainName: "a.com", records: [{ HostName: "@", RecordType: "MX", Address: "mx.zoho.in", MXPref: 5 }] });
  expect(calls[1]!.form).toMatchObject({ RecordType3: "MX", MXPref3: "5", EmailType: "MX" });

  calls = stub((c) => (c === "namecheap.domains.dns.getHosts" ? ok(hosts) : ok(`<DomainDNSSetHostsResult IsSuccess="true" />`)));
  await run("delete_dns_records", { DomainName: "a.com", records: [{ HostName: "WWW", RecordType: "CNAME" }] });
  expect(calls[1]!.form).toMatchObject({ HostName1: "@", RecordType1: "A" });
  expect(calls[1]!.form.HostName2).toBeUndefined();
});

test("registering a domain fills every contact from the owner unless given, plus TLD extras", async () => {
  const calls = stub(() => ok(`<DomainCreateResult Domain="b.us" Registered="true" ChargedAmount="9.0" />`));
  const owner = { FirstName: "A", LastName: "B", Address1: "1 St", City: "Pune", StateProvince: "MH", PostalCode: "411001", Country: "IN", Phone: "+91.9876543210", EmailAddress: "a@b.com" };
  await run("register_domain", { DomainName: "b.us", Years: 1, Registrant: owner, Admin: { ...owner, FirstName: "Z" }, Nameservers: ["ns1.x.com", "ns2.x.com"], ExtendedAttributes: { RegistrantNexus: "C11" } });
  expect(calls[0]!.form).toMatchObject({ Command: "namecheap.domains.create", RegistrantFirstName: "A", TechFirstName: "A", AdminFirstName: "Z", AuxBillingCity: "Pune", Nameservers: "ns1.x.com,ns2.x.com", RegistrantNexus: "C11" });
  expect(calls[0]!.form.Registrant).toBeUndefined();
});

test("add funds sends the account's username and card payment type", async () => {
  const calls = stub(() => ok(`<Createaddfundsrequestresult TokenID="t1" RedirectURL="https://pay" />`));
  await run("add_funds_request", { Amount: 50, ReturnUrl: "https://emplio.app" });
  expect(calls[0]!.form).toMatchObject({ Username: "apiuser", PaymentType: "Creditcard", Amount: "50" });
});

test("polls: expiring domains, changed settings, DNS changes and a low balance", async () => {
  const soon = new Date(Date.now() + 10 * 86_400_000);
  const mdy = `${String(soon.getUTCMonth() + 1).padStart(2, "0")}/${String(soon.getUTCDate()).padStart(2, "0")}/${soon.getUTCFullYear()}`;
  const rows = { DomainGetListResult: { Domain: [{ ID: "1", Name: "a.com", Expires: mdy, AutoRenew: false }, { ID: "2", Name: "b.com", Expires: "01/01/2099", AutoRenew: true }] }, Paging: { TotalItems: "2" } };
  const run = async (action: string) => {
    if (action === "namecheap.list_domains") return rows;
    if (action === "namecheap.get_balances") return { UserGetBalancesResult: { AvailableBalance: "3.00", FundsRequiredForAutoRenew: "9.06" } };
    if (action === "namecheap.get_dns_hosts") return { DomainDNSGetHostsResult: { EmailType: "MX", host: [{ Name: "@", Type: "A", Address: "1.1.1.1" }] } };
    throw new Error(action);
  };
  const exp = await polls.domain_expiring_soon!.poll({}, run);
  expect(exp.map((e) => e.id)).toEqual([`1:${mdy}`]);
  expect((exp[0]!.item as any).days_left).toBeGreaterThanOrEqual(9);
  expect(await polls.domain_expiring_soon!.poll({ days: 5 }, run)).toEqual([]);
  expect((await polls.domain_changed!.poll({ domains: ["B.com"] }, run)).map((e) => e.id)).toEqual(["2:true:undefined:undefined:undefined:01/01/2099"]);
  expect(await polls.low_balance!.poll({}, run)).toHaveLength(1);
  expect(await polls.low_balance!.poll({ below: 1 }, run)).toEqual([]);
  const a = await polls.dns_records_changed!.poll({ domain: "a.com" }, run);
  expect(a[0]!.id).toHaveLength(16);
});
