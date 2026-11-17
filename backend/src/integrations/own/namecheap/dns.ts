// DNS: which nameservers a domain uses, its host records (A, CNAME, MX, TXT, URL redirects…), email forwarding,
// and the domain's own nameservers (ns1.mybrand.com) registered at the registry.
// Namecheap's setHosts replaces every record at once, so adding or removing one record means reading them all,
// changing the list and writing it back: add_dns_records and delete_dns_records do that, keeping the email setting.
import { z } from "zod";
import { AppsError } from "../../types";
import type { OwnAction } from "../index";
import { cmd, domain, nc, sldTld, split } from "./client";

const TYPES = ["A", "AAAA", "ALIAS", "CAA", "CNAME", "MX", "MXE", "NS", "TXT", "URL", "URL301", "FRAME"] as const;
const record = z.object({
  HostName: z.string().describe('The name before the domain: "@" for the domain itself, "www", "shop", "*" for everything'),
  RecordType: z.enum(TYPES).describe("A (IPv4 address), AAAA (IPv6), CNAME (another name), MX (mail server), TXT (text, e.g. verification), CAA, NS, ALIAS, URL/URL301 (redirect), FRAME (masked redirect), MXE (mail to an IP)"),
  Address: z.string().describe('What it points to: an IP, a hostname, a URL for redirects, the text of a TXT record, or for CAA e.g. 0 issue "letsencrypt.org"'),
  MXPref: z.number().int().optional().describe("For MX records: the priority, lower is tried first (default 10)"),
  TTL: z.number().int().min(60).max(60000).optional().describe("Seconds other servers may remember it (60-60000, default 1800)"),
});
type Rec = z.infer<typeof record>;
const EMAIL = ["NONE", "MXE", "MX", "FWD", "OX", "GMAIL"] as const;
const emailType = z
  .enum(EMAIL)
  .optional()
  .describe("Email setup: MX (your own MX records, e.g. Google Workspace or Zoho), FWD (Namecheap email forwarding), OX (Namecheap Private Email), GMAIL, MXE, NONE. Left out, stays as it is. MX records are only kept when this is MX");

// records as setHosts wants them: HostName1, RecordType1, Address1, …
function numbered(hosts: Rec[]) {
  const out: Record<string, unknown> = {};
  hosts.forEach((h, n) => {
    const i = n + 1;
    out[`HostName${i}`] = h.HostName;
    out[`RecordType${i}`] = h.RecordType;
    out[`Address${i}`] = h.Address;
    if (h.MXPref !== undefined || h.RecordType === "MX") out[`MXPref${i}`] = h.MXPref ?? 10;
    if (h.TTL !== undefined) out[`TTL${i}`] = h.TTL;
  });
  return out;
}

// the domain's records now, in setHosts' shape, and its email type
async function current(key: string, DomainName: string) {
  const out = await nc(key, "namecheap.domains.dns.getHosts", split(DomainName), ["host"]);
  const r = out.DomainDNSGetHostsResult ?? {};
  if (r.IsUsingOurDNS === false) throw new AppsError(`${DomainName} doesn't use Namecheap's DNS, so its records are managed wherever its nameservers point (namecheap.get_dns_servers)`);
  const hosts: Rec[] = (r.host ?? []).map((h: any) => ({
    HostName: String(h.Name),
    RecordType: h.Type,
    Address: String(h.Address),
    ...(h.Type === "MX" && { MXPref: Number(h.MXPref) }),
    TTL: Number(h.TTL),
  }));
  return { hosts, emailType: r.EmailType as string | undefined };
}
// Namecheap's getHosts says "No Email Service" etc. where setHosts wants NONE; anything unknown is left for Namecheap to keep
const asEmailType = (t?: string) => ((EMAIL as readonly string[]).includes(t ?? "") ? t : undefined);
const same = (a: Rec, b: Partial<Rec>) =>
  a.HostName.toLowerCase() === b.HostName?.toLowerCase() && a.RecordType === b.RecordType && (b.Address === undefined || a.Address.replace(/\.$/, "") === b.Address.replace(/\.$/, ""));

async function write(key: string, DomainName: string, hosts: Rec[], EmailType?: string) {
  return nc(key, "namecheap.domains.dns.setHosts", { ...split(DomainName), ...numbered(hosts), EmailType });
}

export const dnsActions: Record<string, OwnAction> = {
  get_dns_servers: cmd(
    "namecheap.domains.dns.getList",
    "Which nameservers a domain uses, and whether they're Namecheap's own (needed for records, email forwarding and redirects managed here).",
    { DomainName: domain },
    { readOnly: true, params: sldTld, lists: ["Nameserver"] },
  ),
  set_default_dns: cmd(
    "namecheap.domains.dns.setDefault",
    "Point a domain back at Namecheap's own nameservers, so its records, redirects and email forwarding are managed in Namecheap. Records kept at another DNS host stop working.",
    { DomainName: domain },
    { params: sldTld },
  ),
  set_custom_nameservers: cmd(
    "namecheap.domains.dns.setCustom",
    "Point a domain at another DNS host's nameservers (Cloudflare, Vercel, a web host…). Namecheap's records, redirects and email forwarding then stop applying.",
    { DomainName: domain, Nameservers: z.array(z.string()).min(2).describe('The nameservers, e.g. ["ana.ns.cloudflare.com", "bob.ns.cloudflare.com"]') },
    { params: sldTld },
  ),
  get_dns_hosts: cmd(
    "namecheap.domains.dns.getHosts",
    "A domain's DNS records (A, CNAME, MX, TXT, redirects…) and its email type. Only for domains on Namecheap's DNS.",
    { DomainName: domain },
    { readOnly: true, params: sldTld, lists: ["host"] },
  ),
  set_dns_hosts: cmd(
    "namecheap.domains.dns.setHosts",
    "Replace ALL of a domain's DNS records with this list: any record not in it is deleted. To add or remove a few, use namecheap.add_dns_records or namecheap.delete_dns_records instead.",
    { DomainName: domain, hosts: z.array(record).min(1).describe("Every record the domain should have"), EmailType: emailType },
    { params: ({ DomainName, hosts, EmailType }) => ({ ...split(DomainName), ...numbered(hosts), EmailType }) },
  ),
  add_dns_records: {
    description:
      "Add DNS records to a domain, keeping all the others. A record with the same name, type and value is replaced (e.g. to change its TTL). Adding an MX record switches the domain's email to MX (custom mail servers).",
    input: z.object({ DomainName: domain, records: z.array(record).min(1).describe("The records to add"), EmailType: emailType }),
    async run({ DomainName, records, EmailType }: { DomainName: string; records: Rec[]; EmailType?: string }, key: string) {
      const { hosts, emailType } = await current(key, DomainName);
      const kept = hosts.filter((h) => !records.some((r) => same(h, r)));
      const mail = EmailType ?? (records.some((r) => r.RecordType === "MX") ? "MX" : asEmailType(emailType));
      await write(key, DomainName, [...kept, ...records], mail);
      return { added: records.length, records: [...kept, ...records] };
    },
  },
  delete_dns_records: {
    description: "Remove DNS records from a domain, keeping all the others. Matches by name and type, and by value when given.",
    input: z.object({
      DomainName: domain,
      records: z
        .array(z.object({ HostName: record.shape.HostName, RecordType: record.shape.RecordType, Address: z.string().optional().describe("Only the record with this value; left out, every record with that name and type") }))
        .min(1)
        .describe("The records to remove"),
    }),
    async run({ DomainName, records }: { DomainName: string; records: Partial<Rec>[] }, key: string) {
      const { hosts, emailType } = await current(key, DomainName);
      const kept = hosts.filter((h) => !records.some((r) => same(h, r)));
      if (kept.length === hosts.length) throw new AppsError("none of those records exist on the domain (namecheap.get_dns_hosts lists them)");
      // ponytail: Namecheap's setHosts can't take an empty list, so the very last record can't be removed this way
      if (!kept.length) throw new AppsError("that would remove every record, which Namecheap doesn't allow; keep at least one");
      await write(key, DomainName, kept, asEmailType(emailType));
      return { removed: hosts.length - kept.length, records: kept };
    },
  },
  get_email_forwarding: cmd(
    "namecheap.domains.dns.getEmailForwarding",
    "A domain's email forwards: which addresses at the domain (info@, sales@) are passed on to which inboxes.",
    { DomainName: domain },
    { readOnly: true, lists: ["Forward"] },
  ),
  set_email_forwarding: cmd(
    "namecheap.domains.dns.setEmailForwarding",
    "Replace ALL of a domain's email forwards with this list. The domain must use Namecheap's DNS with email set to forwarding (FWD).",
    {
      DomainName: domain,
      forwards: z
        .array(z.object({ MailBox: z.string().describe('The part before @ at the domain, e.g. "info" for info@mybrand.com'), ForwardTo: z.string().describe("The inbox it goes to, e.g. owner@gmail.com") }))
        .min(1)
        .describe("Every forward the domain should have"),
    },
    {
      params: ({ DomainName, forwards }) =>
        Object.fromEntries([["DomainName", DomainName], ...forwards.flatMap((f: { MailBox: string; ForwardTo: string }, n: number) => [[`MailBox${n + 1}`, f.MailBox], [`ForwardTo${n + 1}`, f.ForwardTo]])]),
    },
  ),

  // ── the domain's own nameservers (child nameservers / glue records)
  create_nameserver: cmd(
    "namecheap.domains.ns.create",
    "Register a nameserver under the domain (e.g. ns1.mybrand.com) with its IP, so it can be used as a nameserver by any domain.",
    { DomainName: domain, Nameserver: z.string().describe("The nameserver's full name, e.g. ns1.mybrand.com"), IP: z.string().describe("Its IPv4 address") },
    { params: sldTld },
  ),
  get_nameserver_info: cmd(
    "namecheap.domains.ns.getInfo",
    "A nameserver registered under the domain, with its IP.",
    { DomainName: domain, Nameserver: z.string().describe("The nameserver's full name, e.g. ns1.mybrand.com") },
    { readOnly: true, params: sldTld },
  ),
  update_nameserver: cmd(
    "namecheap.domains.ns.update",
    "Change the IP of a nameserver registered under the domain.",
    { DomainName: domain, Nameserver: z.string().describe("The nameserver's full name, e.g. ns1.mybrand.com"), OldIP: z.string().describe("Its current IP"), IP: z.string().describe("The new IP") },
    { params: sldTld },
  ),
  delete_nameserver: cmd(
    "namecheap.domains.ns.delete",
    "Remove a nameserver registered under the domain.",
    { DomainName: domain, Nameserver: z.string().describe("The nameserver's full name, e.g. ns1.mybrand.com") },
    { params: sldTld },
  ),
};
