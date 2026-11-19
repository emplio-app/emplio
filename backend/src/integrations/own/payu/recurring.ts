// Recurring payments (PayU's standing instructions, "SI"): customers who signed up once to be charged regularly
// by card, net banking or UPI AutoPay. Telling them a charge is coming, charging them, checking and changing or
// cancelling their mandate. Each command takes its fields as one JSON var1.
import { z } from "zod";
import type { OwnAction } from "../index";
import { cmd, jsonCmd } from "./client";

const authPayuId = z.string().min(1).describe("The mandate's id: PayU's payment id (mihpayid) of the customer's sign-up (registration) payment");
const requestId = z.string().min(1).describe("A new unique reference of the business's own for this request, e.g. pdn-1001-3");
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DD");

export const recurringActions: Record<string, OwnAction> = {
  send_pre_debit_notice: jsonCmd(
    "pre_debit_SI",
    "Tell a recurring customer (through their bank) that a charge is coming, as RBI requires at least 24 hours before each recurring charge. Do this before payu.charge_recurring_payment.",
    z.object({
      authpayuid: authPayuId,
      requestId,
      debitDate: day.describe("The day the charge will be taken, YYYY-MM-DD, at least a day away"),
      amount: z.string().regex(/^\d+(\.\d{1,2})?$/).describe("Amount to be charged, in rupees"),
      invoiceDisplayNumber: z.string().min(1).describe("The bill or invoice number the customer will see"),
      mandateSeqNo: z.number().int().min(1).optional().describe("UPI only: which charge this is in the mandate's sequence (2 for the second…)"),
    }),
    false,
  ),
  charge_recurring_payment: jsonCmd(
    "si_transaction",
    "Charge a recurring customer under their existing mandate, after a pre-debit notice. Takes money from the customer.",
    z
      .object({
        authpayuid: authPayuId,
        txnid: z.string().min(1).describe("A new unique order id of the business's own for this charge, e.g. REC-1001-3"),
        amount: z.string().regex(/^\d+(\.\d{1,2})?$/).describe("Amount in rupees, up to the mandate's limit"),
        invoiceDisplayNumber: z.string().min(1).describe("The bill number given in the pre-debit notice"),
        phone: z.string().optional().describe("Customer's mobile"),
        email: z.string().optional().describe("Customer's email"),
        udf1: z.string().optional().describe("Optional extra field kept with the payment"),
        udf2: z.string().optional().describe("Optional extra field kept with the payment"),
        udf3: z.string().optional().describe("Optional extra field kept with the payment"),
        udf4: z.string().optional().describe("Optional extra field kept with the payment"),
        udf5: z.string().optional().describe("Optional extra field kept with the payment"),
      })
      .loose(),
    false,
  ),
  verify_recurring_payment: cmd(
    "verify_si_payment",
    "The status of a recurring charge, by the order id it was made with.",
    z.object({ txnid: z.string().min(1).describe("The order id the recurring charge was made with (txnid)") }),
    (i) => [i.txnid],
    true,
  ),
  get_card_mandate_status: jsonCmd(
    "check_mandate_status",
    "Whether a card mandate is still active, paused or cancelled, with its limits and dates.",
    z.object({ authPayuId, requestId }),
    true,
  ),
  get_netbanking_mandate_status: jsonCmd("NB_mandate_status", "Whether a net-banking (eNACH) mandate is still active, with its limits and dates.", z.object({ authpayuid: authPayuId, requestId }), true),
  get_upi_mandate_status: jsonCmd("upi_mandate_status", "Whether a UPI AutoPay mandate is still active, paused or revoked by the customer.", z.object({ authPayuId, requestId }), true),
  cancel_mandate: jsonCmd(
    "mandate_revoke",
    "Cancel a customer's card (Visa/Mastercard) or net-banking recurring mandate, so they're never charged under it again.",
    z.object({ authPayuId, requestId }),
    false,
  ),
  cancel_upi_mandate: jsonCmd("upi_mandate_revoke", "Cancel a customer's UPI AutoPay mandate, so they're never charged under it again.", z.object({ authPayuId, requestId }), false),
  modify_upi_mandate: jsonCmd(
    "upi_mandate_modify",
    "Change a UPI AutoPay mandate's amount or end date. The customer approves the change in their UPI app.",
    z.object({
      authPayuId,
      requestId,
      amount: z.number().positive().optional().describe("New amount in rupees"),
      endDate: day.optional().describe("New end date, YYYY-MM-DD"),
    }),
    false,
  ),
  update_card_mandate: jsonCmd(
    "update_SI",
    "Move a card mandate onto a new card token (when the customer's card was reissued or tokenised).",
    z.object({
      authPayuId,
      requestId,
      isExistingMandate: z.enum(["0", "1"]).optional().describe("1 if the mandate already exists at PayU"),
      token: z.record(z.string(), z.unknown()).describe('The new token: {"type": "network", "number": "<token>", "expiry_month": "10", "expiry_year": "2029", "tsp": "002"}'),
    }),
    false,
  ),
};
