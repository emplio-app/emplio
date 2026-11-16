// The account: balance, prices, profile, adding funds, saved addresses, sub-accounts made through the API,
// and domain privacy (WhoisGuard / Withheld for Privacy) subscriptions.
import { z } from "zod";
import type { OwnAction } from "../index";
import { cmd, country, page, parseKey, phone, promo } from "./client";

const person = {
  FirstName: z.string().describe("First name"),
  LastName: z.string().describe("Last name"),
  JobTitle: z.string().optional().describe("Job title"),
  Organization: z.string().optional().describe("Company name"),
  Address1: z.string().describe("Street address"),
  Address2: z.string().optional().describe("Second address line"),
  City: z.string().describe("City"),
  StateProvince: z.string().describe("State or province"),
  Zip: z.string().describe("PIN or ZIP code"),
  Country: country,
  Phone: phone("Phone number"),
  PhoneExt: z.string().optional().describe("Phone extension"),
  Fax: z.string().optional().describe("Fax number, same format as the phone"),
  EmailAddress: z.string().describe("Email address"),
};
const address = {
  AddressName: z.string().max(20).describe('A name for this address, e.g. "Office"'),
  DefaultYN: z.union([z.literal(0), z.literal(1)]).optional().describe("1 to make it the default address, 0 not to"),
  ...person,
  StateProvinceChoice: z.string().describe('"S" when StateProvince is a state, "P" for a province (Namecheap\'s form field; use S if unsure)'),
};
const addressId = z.number().int().min(0).describe("The address's AddressId (namecheap.list_addresses); 0 is the account's main address");
const privacyId = z.number().int().describe("The privacy subscription's ID (namecheap.list_domain_privacy, or Whoisguard.ID in namecheap.get_domain_info)");

export const accountActions: Record<string, OwnAction> = {
  get_balances: cmd(
    "namecheap.users.getBalances",
    "The account balance: available funds and currency, money earned from Marketplace sales, and how much is needed to cover upcoming auto-renewals.",
    {},
    { readOnly: true },
  ),
  get_pricing: cmd(
    "namecheap.users.getPricing",
    "Namecheap's prices for this account: domains (register, renew, transfer, reactivate per ending), SSL certificates, privacy. Narrow it down, the full list is long.",
    {
      ProductType: z.enum(["DOMAIN", "SSLCERTIFICATE", "WHOISGUARD"]).describe("What to price"),
      ProductCategory: z.string().optional().describe('For DOMAIN: "DOMAINS"; for SSLCERTIFICATE: "COMODO"'),
      ActionName: z.enum(["REGISTER", "RENEW", "REACTIVATE", "TRANSFER", "PURCHASE"]).optional().describe("Only this kind of purchase"),
      ProductName: z.string().optional().describe('Only this product: a domain ending without the dot, e.g. "com" or "in", or an SSL name like "PositiveSSL"'),
      PromotionCode: promo,
    },
    { readOnly: true, lists: ["ProductCategory", "Product", "Price"] },
  ),
  update_account: cmd(
    "namecheap.users.update",
    "Change the account holder's profile details (name, address, phone, email). Every required field must be given, even unchanged ones; namecheap.get_address with AddressId 0 shows the current values.",
    person,
  ),
  change_password: cmd(
    "namecheap.users.changePassword",
    "Change the Namecheap account password, with the old password or a reset code from namecheap.reset_password.",
    {
      OldPassword: z.string().optional().describe("The current password (or give ResetCode)"),
      ResetCode: z.string().optional().describe("The code from a password reset email (or give OldPassword)"),
      NewPassword: z.string().describe("The new password"),
    },
  ),
  add_funds_request: cmd(
    "namecheap.users.createaddfundsrequest",
    "Start adding money to the account balance by card. Answers with a payment page link (RedirectURL) the owner opens to pay.",
    {
      Amount: z.number().positive().describe("How much to add, in the account's currency (usually USD)"),
      ReturnUrl: z.string().describe("Where the payment page sends the owner back to afterwards, e.g. https://emplio.app"),
    },
    // this command wants the account's username again, beside the one every call carries
    { params: (i, key) => ({ ...i, PaymentType: "Creditcard", Username: parseKey(key).userName }) },
  ),
  get_add_funds_status: cmd(
    "namecheap.users.getAddFundsStatus",
    "Whether an add-funds payment went through: CREATED, SUBMITTED, COMPLETED, FAILED or EXPIRED.",
    { TokenId: z.string().describe("The TokenID namecheap.add_funds_request answered with") },
    { readOnly: true },
  ),
  create_user: cmd(
    "namecheap.users.create",
    "Make a new Namecheap account under this one (for resellers). Accepts Namecheap's terms for it.",
    {
      NewUserName: z.string().max(20).describe("Username for the new account"),
      NewUserPassword: z.string().describe("Password for the new account"),
      IgnoreDuplicateEmailAddress: z.enum(["yes", "no"]).optional().describe("yes (default) allows an email already used by another account"),
      AcceptNews: z.union([z.literal(0), z.literal(1)]).optional().describe("1 to sign it up for Namecheap's newsletter"),
      ...person,
    },
    { params: (i) => ({ ...i, AcceptTerms: 1 }) },
  ),
  login_user: cmd(
    "namecheap.users.login",
    "Check a password for an account made with namecheap.create_user (not for accounts made on namecheap.com).",
    { Password: z.string().describe("The password to check") },
    { readOnly: true },
  ),
  reset_password: cmd(
    "namecheap.users.resetPassword",
    "Email a password reset link to an account found by email, domain or username.",
    {
      FindBy: z.enum(["EMAILADDRESS", "DOMAINNAME", "USERNAME"]).describe("How to find the account"),
      FindByValue: z.string().describe("The email, domain or username"),
      EmailFromName: z.string().optional().describe("Sender name on the email (default namecheap.com)"),
      EmailFrom: z.string().optional().describe("Sender address (default support@namecheap.com)"),
      URLPattern: z.string().optional().describe("The reset link, with [RESETCODE] where the code goes"),
    },
  ),

  // ── saved addresses (used as domain contacts)
  list_addresses: cmd("namecheap.users.address.getList", "The account's saved addresses: AddressId, name, and which is the default.", {}, { readOnly: true, lists: ["List"] }),
  get_address: cmd("namecheap.users.address.getInfo", "One saved address in full.", { AddressId: addressId }, { readOnly: true }),
  create_address: cmd("namecheap.users.address.create", "Save a new address to the account.", address),
  update_address: cmd("namecheap.users.address.update", "Change a saved address. Every required field must be given, even unchanged ones.", { AddressId: addressId, ...address }),
  delete_address: cmd("namecheap.users.address.delete", "Delete a saved address.", { AddressId: addressId }),
  set_default_address: cmd("namecheap.users.address.setDefault", "Make a saved address the default one.", { AddressId: addressId }),

  // ── domain privacy (hides the owner's details in WHOIS)
  list_domain_privacy: cmd(
    "namecheap.whoisguard.getlist",
    "Domain privacy subscriptions: ID, the domain each protects, created and expiry dates, status (ENABLED, DISABLED, FREE = not used by any domain).",
    {
      ListType: z.enum(["ALL", "ALLOTED", "FREE", "DISCARD"]).optional().describe("ALL (default), ALLOTED (on a domain), FREE (unused), DISCARD (thrown away)"),
      Page: page.Page,
      PageSize: z.number().int().min(2).max(100).optional().describe("How many per page, 2-100 (default 20)"),
    },
    { readOnly: true, lists: ["Whoisguard"] },
  ),
  enable_domain_privacy: cmd(
    "namecheap.whoisguard.enable",
    "Turn domain privacy on, hiding the owner's name, address and email in WHOIS. Mail sent to the privacy address is forwarded to ForwardedToEmail.",
    { WhoisguardID: privacyId, ForwardedToEmail: z.string().describe("Where mail to the domain's privacy address is forwarded") },
  ),
  disable_domain_privacy: cmd("namecheap.whoisguard.disable", "Turn domain privacy off, showing the owner's real details in WHOIS.", { WhoisguardID: privacyId }),
  change_domain_privacy_email: cmd(
    "namecheap.whoisguard.changeemailaddress",
    "Give the domain a fresh privacy email address (the one shown in WHOIS), e.g. when the old one gets spam.",
    { WhoisguardID: privacyId },
  ),
  renew_domain_privacy: cmd(
    "namecheap.whoisguard.renew",
    "Renew a privacy subscription, paid from the account balance (free privacy renews by itself with the domain).",
    { WhoisguardID: privacyId, Years: z.number().int().min(1).max(10).describe("For how many years"), PromotionCode: promo },
  ),
  allot_domain_privacy: cmd(
    "namecheap.whoisguard.allot",
    "Attach an unused privacy subscription to a domain. It's off until turned on with namecheap.enable_domain_privacy.",
    { WhoisguardID: privacyId, DomainName: z.string().describe("The domain to attach it to") },
  ),
  unallot_domain_privacy: cmd("namecheap.whoisguard.unallot", "Detach a privacy subscription from its domain, keeping it for another domain.", { WhoisguardID: privacyId }),
  discard_domain_privacy: cmd("namecheap.whoisguard.discard", "Throw away an unused privacy subscription for good.", { WhoisguardID: privacyId }),
};
