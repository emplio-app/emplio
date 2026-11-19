// Payment links (PayU calls them invoices): a link the customer opens to pay, sent by PayU by email or SMS or
// shared by hand, and taking one back. These run on the merchant key and salt; PayU's newer Payment Links API
// needs a separate client id and secret (COVERAGE.md).
import { z } from "zod";
import type { OwnAction } from "../index";
import { cmd, jsonCmd } from "./client";
import { txnid } from "./transactions";

export const paymentLinkActions: Record<string, OwnAction> = {
  create_payment_link: jsonCmd(
    "create_invoice",
    "Make a payment link for a customer to pay a set amount. PayU can email and text it to them itself; the answer has the link (URL) to share otherwise. Asks for money from a customer, so it's checked with the person first.",
    z.object({
      txnid: txnid.describe("A new unique order id of the business's own for this link, e.g. INV-2026-118; the payment arrives under it"),
      amount: z.string().regex(/^\d+(\.\d{1,2})?$/).describe("Amount in rupees, like 1500 or 1499.99"),
      productinfo: z.string().min(1).max(100).describe("What it's for, shown to the customer, e.g. 'November tuition fee'"),
      firstname: z.string().min(1).max(60).describe("The customer's name"),
      email: z.string().email().describe("The customer's email (PayU sends the link here when send_email_now is 1)"),
      phone: z.string().regex(/^\d{10}$/).describe("The customer's 10-digit mobile number, no +91"),
      validation_period: z.number().int().min(1).max(365).optional().describe("How many days the link stays payable (PayU's default when left out)"),
      send_email_now: z.enum(["0", "1"]).optional().describe("1 to have PayU email the link to the customer now, 0 not to"),
      send_sms: z.enum(["0", "1"]).optional().describe("1 to have PayU text the link to the customer's phone, 0 not to"),
      address1: z.string().optional().describe("Customer's address line"),
      city: z.string().optional().describe("Customer's city"),
      state: z.string().optional().describe("Customer's state"),
      country: z.string().optional().describe("Customer's country"),
      zipcode: z.string().optional().describe("Customer's PIN code"),
      template_id: z.string().optional().describe("A PayU email template id, if the business has set one up in PayU"),
    }),
    false,
  ),
  expire_payment_link: cmd(
    "expire_invoice",
    "Turn off a payment link so it can no longer be paid.",
    z.object({ txnid: txnid.describe("The link's order id, as given to payu.create_payment_link") }),
    (i) => [i.txnid],
    false,
  ),
};
