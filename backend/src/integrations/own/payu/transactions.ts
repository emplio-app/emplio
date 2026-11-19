// Payments: their status, fees, lists over a date range, the extra fields on a payment, and capturing or
// releasing a card payment that was only authorised (pre-auth).
import { z } from "zod";
import type { OwnAction } from "../index";
import { cmd, jsonCmd } from "./client";

export const payuId = z.string().min(1).describe("PayU's own id for the payment (mihpayid), a long number like 403993715521937565; it's in every payment PayU reports and in payu.verify_payment's answer");
export const txnid = z.string().min(1).describe("The business's own order / transaction id (txnid) that was sent to PayU when the payment was started");
export const amount = z.string().regex(/^\d+(\.\d{1,2})?$/, "rupees, like 499 or 499.50").describe("Amount in rupees (not paise), like 499 or 499.50");
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DD");
const moment = z.string().regex(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/, "YYYY-MM-DD HH:MM:SS");

export const transactionActions: Record<string, OwnAction> = {
  verify_payment: cmd(
    "verify_payment",
    "Look up payments by the business's own order ids: status (success, failure, pending), PayU's id (mihpayid), amount, mode (UPI, card, net banking), bank reference, fees, customer and error reason. The way to confirm a payment really went through.",
    z.object({ txnids: z.array(txnid).min(1).max(100).describe('One or more of the business\'s order ids, e.g. ["ORD-1001", "ORD-1002"]') }),
    (i) => [i.txnids.join("|")],
    true,
  ),
  check_payment: cmd(
    "check_payment",
    "One payment's full details and status by PayU's id (mihpayid) rather than the order id.",
    z.object({ payu_id: payuId }),
    (i) => [i.payu_id],
    true,
  ),
  get_tdr: cmd(
    "get_TDR",
    "What PayU charged on one payment (its TDR: the gateway fee and GST on it).",
    z.object({ payu_id: payuId }),
    (i) => [i.payu_id],
    true,
  ),
  list_transactions: cmd(
    "get_Transaction_Details",
    "Every payment attempt (successful, failed, pending, refunded) between two dates, with order id, PayU id, amount, status, mode, customer and time. Long ranges come back in pages: pass the answer's page marker as `page` for the next.",
    z.object({
      from: day.describe("First day, YYYY-MM-DD (Indian dates)"),
      to: day.describe("Last day, YYYY-MM-DD; keep the range to a week or less, PayU rejects long ones"),
      page: z.string().optional().describe("For the next page of a long list: the page marker from the previous answer"),
    }),
    (i) => [i.from, i.to, i.page],
    true,
  ),
  get_transaction_info: cmd(
    "get_transaction_info",
    "Payments between two exact times, with more detail per payment than list_transactions (offers, card type, settlement fields).",
    z.object({
      from: moment.describe("Start, YYYY-MM-DD HH:MM:SS (Indian time), e.g. 2026-11-18 00:00:00"),
      to: moment.describe("End, YYYY-MM-DD HH:MM:SS (Indian time); PayU allows at most a day or so per call"),
    }),
    (i) => [i.from, i.to],
    true,
  ),
  update_transaction_udf: cmd(
    "udf_update",
    "Change the extra fields (UDF1–UDF7) saved on a payment, e.g. to add the buyer's PAN and date of birth that export or high-value payments need. Leave out the ones to keep.",
    z.object({
      txnid,
      udf1: z.string().max(255).optional().describe("New UDF1. For cross-border payments: the buyer's PAN (for UPI recurring: \"PAN||DOB\")"),
      udf2: z.string().max(255).optional().describe("New UDF2"),
      udf3: z.string().max(255).optional().describe("New UDF3. For cross-border payments: the buyer's date of birth, DD-MM-YYYY (for UPI: \"InvoiceID||MerchantName\")"),
      udf4: z.string().max(255).optional().describe("New UDF4"),
      udf5: z.string().max(255).optional().describe("New UDF5"),
      udf6: z.string().max(255).optional().describe("New UDF6"),
      udf7: z.string().max(255).optional().describe("New UDF7. For cross-border payments: the IEC (Importer-Exporter Code)"),
    }),
    // PayU's order: var2 UDF1, var3 UDF2, var4 UDF3, var5 UDF4, var6 UDF5, var7 UDF6, var8 UDF7
    (i) => [i.txnid, i.udf1, i.udf2, i.udf3, i.udf4, i.udf5, i.udf6, i.udf7],
    false,
  ),
  get_additional_charges: jsonCmd(
    "get_additional_charge",
    "The convenience fee PayU would add to a payment of this amount by this method, before the customer pays.",
    z.object({
      requestId: z.string().min(1).describe("Any unique reference for this question, e.g. chg-1001"),
      amount: z.number().positive().describe("Amount in rupees"),
      category: z.string().optional().describe("Payment category: CC (credit card), DC (debit card), NB (net banking), UPI, CASH (wallet), EMI"),
      bankCode: z.string().optional().describe("PayU's code for the method or bank, e.g. CC, VISA, AXIB, UPI"),
      bin: z.string().regex(/^\d{6,9}$/).optional().describe("For cards: the first 6–9 digits of the card number"),
    }),
    true,
  ),
  capture_payment: cmd(
    "capture_transaction",
    "Take the money from a card payment that was only authorised (pre-auth hold). Can capture the full held amount or less. Moves money.",
    z.object({
      payu_id: payuId,
      reference: z.string().min(1).describe("A unique reference of the business's own for this capture, e.g. cap-1001"),
      amount: amount.describe("Amount to capture in rupees, up to the authorised amount"),
    }),
    (i) => [i.payu_id, i.reference, i.amount],
    false,
  ),
  cancel_authorized_payment: cmd(
    "cancel_transaction",
    "Release a card or UPI hold (pre-authorised payment or UPI one-time mandate) without taking the money, so the customer's funds are freed.",
    z.object({ payu_id: payuId, reference: z.string().min(1).describe("A unique reference of the business's own for this cancellation, e.g. rel-1001") }),
    (i) => [i.payu_id, i.reference],
    false,
  ),
};
