// SSL certificates bought from Namecheap: buying, activating with a CSR, proving the domain is yours (DCV),
// renewing, reissuing, revoking, and reading them back.
import { z } from "zod";
import type { OwnAction } from "../index";
import { cmd, page, promo } from "./client";

const certId = z.number().int().describe("The certificate's CertificateID (namecheap.list_ssl_certificates)");
const product = z.string().describe('The certificate product, as Namecheap names it, e.g. "PositiveSSL", "PositiveSSL Wildcard", "EssentialSSL", "PositiveSSL Multi Domain", "InstantSSL", "EV SSL" (namecheap.get_pricing with ProductType SSLCERTIFICATE lists them)');
const csr = z.string().describe("The CSR (certificate signing request) made on the web server, the whole -----BEGIN CERTIFICATE REQUEST----- block");
const server = z.string().optional().describe("The web server software: apacheopenssl, apachessl, apacheraven, apachessleay, nginx, iis, iis4, iis5, tomcat, cpanel, plesk, other…");
const dcv = z
  .string()
  .optional()
  .describe('How to prove the domain is yours: an approver email (e.g. admin@mybrand.com, from namecheap.get_ssl_approver_emails), "HTTPCSRHASH" (a file on the site), "HTTPSCSRHASH", or "CNAMECSRHASH" (a DNS record)');

export const sslActions: Record<string, OwnAction> = {
  list_ssl_certificates: cmd(
    "namecheap.ssl.getList",
    "SSL certificates in the account: ID, the site they're for, type, purchase and expiry dates, status.",
    {
      ListType: z
        .enum(["ALL", "Processing", "EmailSent", "TechnicalProblem", "InProgress", "Completed", "Deactivated", "Active", "Cancelled", "NewPurchase", "NewRenewal"])
        .optional()
        .describe("Which ones (default ALL); NewPurchase = bought but not activated yet"),
      SearchTerm: z.string().optional().describe("Only certificates for names containing this"),
      SortBy: z
        .enum(["PURCHASEDATE", "PURCHASEDATE_DESC", "SSLTYPE", "SSLTYPE_DESC", "EXPIREDATETIME", "EXPIREDATETIME_DESC", "Host_Name", "Host_Name_DESC"])
        .optional()
        .describe("Order of the list"),
      ...page,
    },
    { readOnly: true, lists: ["SSL"] },
  ),
  get_ssl_certificate: cmd(
    "namecheap.ssl.getInfo",
    "One certificate: status, type, the site, issued and expiry dates, validation details, and the certificate itself when asked.",
    {
      CertificateID: certId,
      Returncertificate: z.boolean().optional().describe("true to include the issued certificate's text"),
      Returntype: z.enum(["Individual", "PKCS7"]).optional().describe("With Returncertificate: Individual (separate X.509 certificates, default) or PKCS7 (one bundle)"),
    },
    { readOnly: true },
  ),
  buy_ssl_certificate: cmd(
    "namecheap.ssl.create",
    "Buy an SSL certificate, paid from the account balance. It then needs activating with a CSR (namecheap.activate_ssl_certificate).",
    {
      Years: z.number().int().min(1).max(5).describe("For how many years (1-5)"),
      Type: product,
      SANStoADD: z.number().int().min(1).optional().describe("For multi-domain certificates: how many extra domains to add"),
      PromotionCode: promo,
    },
  ),
  parse_csr: cmd(
    "namecheap.ssl.parseCSR",
    "Read what's inside a CSR (the domain, company, country, email) before using it.",
    { csr, CertificateType: product.optional() },
    { readOnly: true },
  ),
  get_ssl_approver_emails: cmd(
    "namecheap.ssl.getApproverEmailList",
    "The email addresses that can approve a certificate for a domain (admin@, webmaster@, the WHOIS email…).",
    { DomainName: z.string().describe("The domain the certificate is for, e.g. mybrand.com"), CertificateType: product },
    { readOnly: true, lists: ["email"] },
  ),
  activate_ssl_certificate: cmd(
    "namecheap.ssl.activate",
    "Activate a bought certificate with the server's CSR and start proving the domain is yours. Answers with what to set up for validation (file content or DNS record) when not by email.",
    {
      CertificateID: certId,
      CSR: csr,
      AdminEmailAddress: z.string().describe("Where the issued certificate is emailed"),
      WebServerType: server,
      ApproverEmail: z.string().optional().describe("For email validation: the approver address (namecheap.get_ssl_approver_emails)"),
      HTTPDCValidation: z.boolean().optional().describe("true to validate with a file on the website"),
      DNSDCValidation: z.boolean().optional().describe("true to validate with a DNS record"),
      UniqueValue: z.string().optional().describe("A short unique code to tell this request apart (up to 20 letters/digits); rarely needed"),
    },
  ),
  resend_ssl_approver_email: cmd(
    "namecheap.ssl.resendApproverEmail",
    "Send the approval email again, or retry file/DNS validation after setting it up.",
    { CertificateID: certId },
  ),
  edit_ssl_dcv_method: cmd(
    "namecheap.ssl.editDCVMethod",
    "Change how the domain is proved yours for a certificate (email, file, or DNS record), or retry. For multi-domain certificates give DNSNames and DCVMethods instead of DCVMethod.",
    {
      CertificateID: certId,
      DCVMethod: dcv,
      DNSNames: z.array(z.string()).optional().describe("Multi-domain certificates: every domain on it"),
      DCVMethods: z.array(z.string()).optional().describe("Multi-domain certificates: the method for each domain in DNSNames, same order"),
    },
  ),
  renew_ssl_certificate: cmd(
    "namecheap.ssl.renew",
    "Renew a certificate, paid from the account balance. The renewal is a new certificate to activate.",
    { CertificateID: certId, Years: z.number().int().min(1).max(5).describe("For how many years (1-5)"), SSLType: product, PromotionCode: promo },
  ),
  reissue_ssl_certificate: cmd(
    "namecheap.ssl.reissue",
    "Reissue an active certificate with a new CSR (e.g. after a server move or a lost private key). Free.",
    {
      CertificateID: certId,
      CSR: csr,
      AdminEmailAddress: z.string().optional().describe("Where the certificate is emailed (can't change from the first activation)"),
      WebServerType: server,
      ApproverEmail: z.string().optional().describe("For email validation: the approver address"),
      HTTPDCValidation: z.boolean().optional().describe("true to validate with a file on the website"),
      DNSDCValidation: z.boolean().optional().describe("true to validate with a DNS record"),
      UniqueValue: z.string().optional().describe("A short unique code to tell this request apart; rarely needed"),
    },
  ),
  resend_ssl_fulfillment_email: cmd("namecheap.ssl.resendfulfillmentemail", "Email the issued certificate again.", { CertificateID: certId }),
  buy_more_ssl_domains: cmd(
    "namecheap.ssl.purchasemoresans",
    "Add more domains to a multi-domain certificate, paid from the account balance.",
    { CertificateID: certId, NumberOfSANSToAdd: z.number().int().min(1).describe("How many extra domains") },
  ),
  revoke_ssl_certificate: cmd(
    "namecheap.ssl.revokecertificate",
    "Revoke (permanently cancel) an issued certificate, e.g. when its private key leaked. Sites using it will show errors.",
    { CertificateID: certId, CertificateType: product },
  ),
};
