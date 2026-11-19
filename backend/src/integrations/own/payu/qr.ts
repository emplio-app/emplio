// UPI QR codes and UPI payment links for in-person and phone sales: a QR for one amount (shown on a screen or
// printed), a permanent shop QR, a UPI link to text a customer, and checking or cancelling such a payment.
import { z } from "zod";
import type { OwnAction } from "../index";
import { cmd, jsonCmd } from "./client";

const transactionId = z.string().min(1).max(40).describe("A new unique id of the business's own for this payment, letters and digits, e.g. QR1001");
const transactionAmount = z.string().regex(/^\d+(\.\d{1,2})?$/).describe("Amount in rupees, at least 1, like 190 or 1042.23");
const merchantVpa = z.string().optional().describe("The business's UPI id to collect into; leave out to use the one PayU has for this account");
const expiryTime = z.string().regex(/^\d+$/).optional().describe("How many seconds it stays payable, e.g. 3600 for an hour");

export const qrActions: Record<string, OwnAction> = {
  create_upi_qr: jsonCmd(
    "generate_dynamic_bharat_qr",
    "A UPI / Bharat QR code for one amount, for a customer to scan at the counter or on delivery. The answer has the QR as text or a base64 image (outputType).",
    z
      .object({
        transactionId,
        transactionAmount,
        merchantVpa,
        expiryTime,
        qrName: z.string().optional().describe("Name shown with the QR"),
        qrCity: z.string().optional().describe("City shown with the QR"),
        qrPinCode: z.string().optional().describe("PIN code shown with the QR"),
        customerName: z.string().optional().describe("Customer's name"),
        customerPhone: z.string().optional().describe("Customer's mobile"),
        customerEmail: z.string().optional().describe("Customer's email"),
        outputType: z.enum(["string", "base64"]).optional().describe('"string" for the UPI text to draw a QR from, "base64" (default) for a QR image'),
      })
      .loose(),
    false,
  ),
  create_upi_payment_link: jsonCmd(
    "generate_upi_intent",
    "A UPI link for one amount that opens the customer's UPI app (PhonePe, GPay, Paytm) ready to pay, to text or WhatsApp them.",
    z.object({
      transactionId,
      transactionAmount,
      merchantVpa,
      expiryTime,
      txnNote: z.string().optional().describe("Note the customer sees in their UPI app, e.g. 'Order 1001'"),
      name: z.string().optional().describe("Customer's name"),
      phone: z.string().optional().describe("Customer's mobile"),
      refUrl: z.string().url().optional().describe("A web address with details of the order"),
    }),
    false,
  ),
  expire_upi_payment_links: jsonCmd(
    "expire_intent_link",
    "Stop UPI links from payu.create_upi_payment_link from being paid.",
    z.object({ transactionIds: z.string().min(1).describe('The links\' transaction ids, comma separated, e.g. "QR1001,QR1002"') }),
    false,
  ),
  check_qr_payment: cmd(
    "check_bqr_txn_status",
    "Whether a QR or UPI-link payment has been paid, by the id it was created with.",
    z.object({
      transactionId: z.string().min(1).describe("The id the QR or link was created with"),
      payment_mode: z.string().optional().describe("Optional: CARD, UPI or BQR, to narrow it down"),
      product_type: z.string().optional().describe("Optional: DBQR (amount QR) or UPI intent link, when the same id was used for both"),
    }),
    (i) => [i.transactionId, i.payment_mode, i.product_type],
    true,
  ),
  cancel_qr_payment: jsonCmd(
    "cancel_qr_payment",
    "Cancel a QR or UPI-link payment that hasn't been paid yet, so it can't be.",
    z.object({ transactionId: z.string().min(1).describe("The id the QR or link was created with"), product_type: z.string().optional().describe("DBQR, when the same id was used for more than one kind") }),
    false,
  ),
  create_static_qr: jsonCmd(
    "generate_insta_account",
    "A permanent shop UPI QR (any amount, the customer types it), with its own UPI id, for a counter or a sticker. Also re-issues one.",
    z
      .object({
        merchantVpa: z.string().min(1).describe("The UPI id to create for this QR, e.g. myshop.counter1@indus"),
        name: z.string().min(1).describe("The shop name shown to customers"),
        qrType: z.string().optional().describe('"upi" (default) or "bqr" for Bharat QR'),
        city: z.string().optional().describe("Shop's city"),
        pinCode: z.string().optional().describe("Shop's PIN code"),
        address: z.string().optional().describe("Shop's address"),
        instaProduct: z.string().optional().describe('"qr" (default)'),
        outputType: z.enum(["string", "base64"]).optional().describe('"string" for the UPI text, "base64" for a QR image'),
      })
      .loose(),
    false,
  ),
  deactivate_static_qr: jsonCmd(
    "expire_insta_account",
    "Turn off a permanent shop QR and its UPI id, so it stops taking payments.",
    z.object({ merchantVpa: z.string().min(1).describe("The QR's UPI id"), instaProduct: z.string().optional().describe('"qr" (default)') }),
    false,
  ),
};
