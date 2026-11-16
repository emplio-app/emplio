// Domains: the list, details, availability, registering, renewing, reactivating, contacts (WHOIS details),
// registrar lock, and moving domains in from another registrar (transfers).
import { z } from "zod";
import type { OwnAction } from "../index";
import { cmd, country, domain, extra, page, phone, promo, years, yesNo } from "./client";

const contact = z
  .object({
    FirstName: z.string().describe("First name"),
    LastName: z.string().describe("Last name"),
    OrganizationName: z.string().optional().describe("Company name, if the domain belongs to a business"),
    JobTitle: z.string().optional().describe("Job title"),
    Address1: z.string().describe("Street address"),
    Address2: z.string().optional().describe("Second address line"),
    City: z.string().describe("City"),
    StateProvince: z.string().describe("State or province, e.g. Maharashtra or CA"),
    PostalCode: z.string().describe("PIN or ZIP code"),
    Country: country,
    Phone: phone("Phone number"),
    PhoneExt: z.string().optional().describe("Phone extension"),
    Fax: z.string().optional().describe("Fax number, same format as the phone"),
    EmailAddress: z.string().describe("Email address"),
  })
  .describe("A contact person for the domain (shown in WHOIS unless privacy is on)");
const contacts = {
  Registrant: contact.describe("The domain's owner"),
  Tech: contact.optional().describe("Technical contact (default: same as the owner)"),
  Admin: contact.optional().describe("Administrative contact (default: same as the owner)"),
  AuxBilling: contact.optional().describe("Billing contact (default: same as the owner)"),
};
// the four contacts as Namecheap's flat fields (RegistrantFirstName, TechCity, …), each defaulting to the registrant
function flatContacts({ Registrant, Tech, Admin, AuxBilling, ExtendedAttributes, ...rest }: Record<string, any>) {
  const out: Record<string, unknown> = { ...rest, ...ExtendedAttributes };
  for (const [role, c] of Object.entries({ Registrant, Tech: Tech ?? Registrant, Admin: Admin ?? Registrant, AuxBilling: AuxBilling ?? Registrant }))
    for (const [k, v] of Object.entries(c as Record<string, unknown>)) out[`${role}${k}`] = v;
  return out;
}

const premium = {
  IsPremiumDomain: z.boolean().optional().describe("true when this is a premium domain (namecheap.check_domain_availability says IsPremiumName)"),
  PremiumPrice: z.number().optional().describe("For a premium domain: its price, exactly as namecheap.check_domain_availability gave it"),
};
const transferId = z.number().int().describe("The transfer's TransferID (namecheap.list_transfers)");

export const domainActions: Record<string, OwnAction> = {
  list_domains: cmd(
    "namecheap.domains.getList",
    "The domains in the account, with created and expiry dates, whether expired, locked, on auto-renew, with privacy on, premium, and using Namecheap's DNS.",
    {
      ListType: z.enum(["ALL", "EXPIRING", "EXPIRED"]).optional().describe("ALL (default), only EXPIRING soon, or only EXPIRED"),
      SearchTerm: z.string().optional().describe("Only domains containing this text"),
      SortBy: z.enum(["NAME", "NAME_DESC", "EXPIREDATE", "EXPIREDATE_DESC", "CREATEDATE", "CREATEDATE_DESC"]).optional().describe("Order: by name, expiry date or creation date; _DESC for newest/last first"),
      ...page,
    },
    { readOnly: true, lists: ["Domain"] },
  ),
  get_domain_info: cmd(
    "namecheap.domains.getInfo",
    "One domain's details: status, owner, created and expiry dates, privacy (WhoisGuard) status and its ID, nameservers, DNS provider, email type, premium DNS.",
    { DomainName: domain, HostName: z.string().optional().describe("Only for domains hosted with Namecheap: the hosted name to ask about") },
    { readOnly: true, lists: ["Nameserver", "Rights"] },
  ),
  get_domain_contacts: cmd("namecheap.domains.getContacts", "A domain's contacts (owner, technical, admin, billing) as registered in WHOIS.", { DomainName: domain }, { readOnly: true }),
  set_domain_contacts: cmd(
    "namecheap.domains.setContacts",
    "Change a domain's contacts (owner, technical, admin, billing). Contacts left out are set to the owner's details. Changing the owner of some domain endings starts a confirmation email to the old owner.",
    { DomainName: domain, ...contacts, ExtendedAttributes: extra },
    { params: flatContacts },
  ),
  check_domain_availability: cmd(
    "namecheap.domains.check",
    "Whether domains are free to register, and premium prices where a name is premium. Up to 50 at once.",
    { DomainList: z.array(z.string()).min(1).max(50).describe('Domains to check, e.g. ["mybrand.com", "mybrand.in"]') },
    { readOnly: true, lists: ["DomainCheckResult"] },
  ),
  register_domain: cmd(
    "namecheap.domains.create",
    "Register (buy) a new domain, paid from the Namecheap account balance. Check it's available first. Free privacy is added by default.",
    {
      DomainName: z.string().describe("The domain to register, e.g. mybrand.com"),
      Years: years("register it"),
      ...contacts,
      Nameservers: z.array(z.string()).optional().describe("Custom nameservers, e.g. [\"ns1.vercel-dns.com\", \"ns2.vercel-dns.com\"]; left out, Namecheap's own DNS is used"),
      AddFreeWhoisguard: yesNo("Add free domain privacy (default yes)"),
      WGEnabled: yesNo("Turn domain privacy on right away (default no)"),
      PromotionCode: promo,
      ...premium,
      EapFee: z.number().optional().describe("For a premium domain in its early access period: the EAP fee namecheap.check_domain_availability gave"),
      ExtendedAttributes: extra,
    },
    { params: flatContacts },
  ),
  list_tlds: cmd(
    "namecheap.domains.getTldList",
    "Every domain ending Namecheap sells (.com, .in, .io…), with the years it can be registered, renewed or transferred for, and whether that works through the API.",
    {},
    { readOnly: true, lists: ["Tld"] },
  ),
  renew_domain: cmd(
    "namecheap.domains.renew",
    "Renew a domain for more years, paid from the account balance. Answers with the new expiry date.",
    { DomainName: domain, Years: years("renew it"), PromotionCode: promo, ...premium },
  ),
  reactivate_domain: cmd(
    "namecheap.domains.reactivate",
    "Bring back a domain that has expired (in its grace period), paid from the account balance.",
    { DomainName: domain, YearsToAdd: z.number().int().min(1).max(10).optional().describe("Years to add after reactivating (default 1)"), PromotionCode: promo, ...premium },
  ),
  get_registrar_lock: cmd("namecheap.domains.getRegistrarLock", "Whether a domain is locked against being transferred away.", { DomainName: domain }, { readOnly: true }),
  set_registrar_lock: cmd(
    "namecheap.domains.setRegistrarLock",
    "Lock a domain so it can't be transferred away, or unlock it (needed before moving it to another registrar).",
    { DomainName: domain, LockAction: z.enum(["LOCK", "UNLOCK"]).optional().describe("LOCK (default) or UNLOCK") },
  ),

  // ── transfers in
  create_transfer: cmd(
    "namecheap.domains.transfer.create",
    "Move a domain from another registrar to Namecheap, paid from the account balance (includes 1 year). Unlock it at the old registrar and get its EPP/auth code first.",
    {
      DomainName: z.string().describe("The domain to bring over, e.g. mybrand.com"),
      Years: z.literal(1).optional().default(1).describe("Always 1 year"),
      EPPCode: z.string().describe("The EPP / auth / transfer code from the current registrar"),
      PromotionCode: promo,
      AddFreeWhoisguard: yesNo("Add free domain privacy (default yes)"),
      WGenable: yesNo("Turn domain privacy on (default no)"),
    },
  ),
  get_transfer_status: cmd("namecheap.domains.transfer.getStatus", "Where one domain transfer stands.", { TransferID: transferId }, { readOnly: true }),
  update_transfer_status: cmd(
    "namecheap.domains.transfer.updateStatus",
    "Send a stuck transfer again, e.g. after the domain was unlocked at the old registrar.",
    { TransferID: transferId, Resubmit: z.literal(true).optional().default(true).describe("Always true: resubmit the transfer") },
  ),
  list_transfers: cmd(
    "namecheap.domains.transfer.getList",
    "Domain transfers into the account and their status.",
    {
      ListType: z.enum(["ALL", "INPROGRESS", "CANCELLED", "COMPLETED"]).optional().describe("Which ones (default ALL)"),
      SearchTerm: z.string().optional().describe("Only transfers of domains containing this text"),
      SortBy: z.enum(["DOMAINNAME", "DOMAINNAME_DESC", "TRANSFERDATE", "TRANSFERDATE_DESC", "STATUSDATE", "STATUSDATE_DESC"]).optional().describe("Order of the list"),
      ...page,
    },
    { readOnly: true, lists: ["Transfer"] },
  ),
};
