// Namecheap has no webhooks, so everything is read from its lists: a domain or certificate nearing expiry, a new
// domain, a domain's settings changing (auto-renew, lock, privacy, expired), DNS records changing, a transfer
// moving on, the balance running low. Namecheap allows 20 calls a minute and 700 an hour per account, so checks
// default to hourly and each makes one call per 100 domains.
import { createHash } from "node:crypto";
import { z } from "zod";
import type { PollTrigger, Run } from "./index";

const DAY_MS = 86_400_000;
// Namecheap's list dates are MM/DD/YYYY
export const mdy = (s: unknown) => {
  const [m, d, y] = String(s ?? "").split("/").map(Number);
  return m && d && y ? Date.UTC(y, m - 1, d) : undefined;
};
const daysLeft = (s: unknown) => {
  const t = mdy(s);
  return t === undefined ? undefined : Math.ceil((t - Date.now()) / DAY_MS);
};
const today = () => new Date().toISOString().slice(0, 10);
const arr = (v: unknown): any[] => (Array.isArray(v) ? v : v ? [v] : []);

// every domain, 100 a call. ponytail: stops at 10 pages (1000 domains); a bigger portfolio should poll with SearchTerm
async function allDomains(run: Run) {
  const out: any[] = [];
  for (let Page = 1; Page <= 10; Page++) {
    const r = (await run("namecheap.list_domains", { Page, PageSize: 100 })) as any;
    const rows = arr(r?.DomainGetListResult?.Domain);
    out.push(...rows);
    if (rows.length < 100 || out.length >= Number(r?.Paging?.TotalItems ?? 0)) break;
  }
  return out;
}
const only = (domains?: string[]) => (d: any) => !domains?.length || domains.some((n) => n.toLowerCase() === String(d.Name).toLowerCase());
const domainsFilter = z.array(z.string()).optional().describe('Only these domains, e.g. ["mybrand.com"]; left out, every domain in the account');

const DOMAIN = "The Namecheap domain: ID, Name, Created and Expires (MM/DD/YYYY), IsExpired, IsLocked, AutoRenew, WhoisGuard (privacy status), IsPremium, IsOurDNS";
const domainOut = [{ name: "domain", type: "object", required: true, description: DOMAIN }];
const hourly = { every: 60, min: 15 };

const expiring: PollTrigger = {
  description: "A domain is about to expire: it comes within the set number of days of its expiry date (30 by default). Fires once per domain per expiry date, so renewing resets it. Domains already that close when the automation is made don't fire.",
  config: z.object({
    days: z.number().int().min(1).max(365).optional().describe("How many days before expiry to tell (default 30)"),
    only_without_auto_renew: z.boolean().optional().describe("true: only domains with auto-renew off"),
    domains: domainsFilter,
  }),
  output: [...domainOut, { name: "days_left", type: "number", required: true, description: "Days until it expires (0 or less: expired)" }],
  every: 360,
  min: 15,
  async poll({ days = 30, only_without_auto_renew, domains }, run) {
    return (await allDomains(run))
      .filter(only(domains))
      .filter((d) => !only_without_auto_renew || d.AutoRenew === false)
      .map((d) => ({ d, left: daysLeft(d.Expires) }))
      .filter(({ left }) => left !== undefined && left <= days)
      .map(({ d, left }) => ({ id: `${d.ID}:${d.Expires}`, item: { domain: d, days_left: left } }));
  },
};

const newDomain: PollTrigger = {
  description: "A domain is added to the Namecheap account: registered, transferred in, or moved over from another account.",
  config: z.object({}),
  output: domainOut,
  ...hourly,
  async poll(_c, run) {
    const r = (await run("namecheap.list_domains", { SortBy: "CREATEDATE_DESC", PageSize: 100 })) as any;
    return arr(r?.DomainGetListResult?.Domain).map((d) => ({ id: String(d.ID), item: { domain: d } }));
  },
};

const changed: PollTrigger = {
  description: "A domain's settings change: auto-renew turned on or off, registrar lock, privacy (WhoisGuard) status, expired, or its expiry date (renewed). A newly added domain fires too.",
  config: z.object({ domains: domainsFilter }),
  output: domainOut,
  ...hourly,
  async poll({ domains }, run) {
    return (await allDomains(run))
      .filter(only(domains))
      .map((d) => ({ id: `${d.ID}:${d.AutoRenew}:${d.IsLocked}:${d.WhoisGuard}:${d.IsExpired}:${d.Expires}`, item: { domain: d } }));
  },
};

const dnsChanged: PollTrigger = {
  description: "A domain's DNS records change (added, removed or edited, by anyone). Only for domains using Namecheap's own DNS. The event carries all the records as they are now.",
  config: z.object({ domain: z.string().min(3).describe("The domain to watch, e.g. mybrand.com") }),
  output: [
    { name: "domain", type: "string", required: true, description: "The domain" },
    { name: "records", type: "object[]", required: true, description: "Every record now: HostId, Name, Type, Address, MXPref, TTL" },
    { name: "email_type", type: "string", required: false, description: "The domain's email setting (MX, FWD, OX…)" },
  ],
  ...hourly,
  async poll({ domain }, run) {
    const r = ((await run("namecheap.get_dns_hosts", { DomainName: domain })) as any)?.DomainDNSGetHostsResult ?? {};
    const records = arr(r.host);
    const shape = records.map((h) => [h.Name, h.Type, h.Address, h.MXPref, h.TTL].join("|")).sort().join("\n") + `\n${r.EmailType}`;
    const id = createHash("sha256").update(shape).digest("hex").slice(0, 16);
    return [{ id, item: { domain, records, email_type: r.EmailType } }];
  },
};

const transfer: PollTrigger = {
  description: "A domain transfer into Namecheap starts or moves to a new status (waiting for approval, completed, cancelled…).",
  config: z.object({}),
  output: [{ name: "transfer", type: "object", required: true, description: "The transfer: ID, DomainName, TransferDate, OrderID, StatusID, Status" }],
  ...hourly,
  async poll(_c, run) {
    const r = (await run("namecheap.list_transfers", { SortBy: "STATUSDATE_DESC", PageSize: 100 })) as any;
    return arr(r?.TransferGetListResult?.Transfer).map((t) => ({ id: `${t.ID ?? t.TransferID}:${t.StatusID}`, item: { transfer: t } }));
  },
};

const sslExpiring: PollTrigger = {
  description: "An SSL certificate bought from Namecheap is about to expire: it comes within the set number of days of its expiry date (30 by default). Once per certificate per expiry date.",
  config: z.object({ days: z.number().int().min(1).max(365).optional().describe("How many days before expiry to tell (default 30)") }),
  output: [
    { name: "certificate", type: "object", required: true, description: "The certificate: CertificateID, HostName, SSLType, PurchaseDate, ExpireDate, Status" },
    { name: "days_left", type: "number", required: true, description: "Days until it expires" },
  ],
  every: 360,
  min: 15,
  async poll({ days = 30 }, run) {
    const r = (await run("namecheap.list_ssl_certificates", { ListType: "Active", PageSize: 100 })) as any;
    return arr(r?.SSLListResult?.SSL)
      .map((c) => ({ c, left: daysLeft(c.ExpireDate) }))
      .filter(({ left }) => left !== undefined && left <= days)
      .map(({ c, left }) => ({ id: `${c.CertificateID}:${c.ExpireDate}`, item: { certificate: c, days_left: left } }));
  },
};

const lowBalance: PollTrigger = {
  description: "The Namecheap balance is below a set amount, or below what upcoming auto-renewals need (the default). Tells at most once a day while it stays low.",
  config: z.object({ below: z.number().min(0).optional().describe("Tell when the available balance drops below this (in the account's currency); left out, when it can't cover the upcoming auto-renewals") }),
  output: [{ name: "balance", type: "object", required: true, description: "Currency, AvailableBalance, AccountBalance, FundsRequiredForAutoRenew" }],
  ...hourly,
  async poll({ below }, run) {
    const b = ((await run("namecheap.get_balances", {})) as any)?.UserGetBalancesResult ?? {};
    const have = Number(b.AvailableBalance);
    const need = below ?? Number(b.FundsRequiredForAutoRenew);
    return Number.isFinite(have) && Number.isFinite(need) && have < need ? [{ id: `low:${today()}`, item: { balance: b } }] : [];
  },
};

export const namecheap: Record<string, PollTrigger> = {
  domain_expiring_soon: expiring,
  new_domain: newDomain,
  domain_changed: changed,
  dns_records_changed: dnsChanged,
  transfer_status_changed: transfer,
  ssl_expiring_soon: sslExpiring,
  low_balance: lowBalance,
};
