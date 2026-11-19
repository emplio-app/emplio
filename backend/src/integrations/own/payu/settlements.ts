// Settlements: when PayU paid the money into the business's bank, which payments were in each payout (UTR), and
// what's still to come. The three newer reports are signed REST calls that also need the merchant's numeric MID.
import { z } from "zod";
import type { OwnAction } from "../index";
import { cmd, settlement } from "./client";
import { txnid } from "./transactions";

const mid = z.string().regex(/^\d+$/, "digits only").describe("The business's PayU Merchant ID (MID), a number shown at the top of the PayU Dashboard and in Account settings, e.g. 8759546");
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DD");

export const settlementActions: Record<string, OwnAction> = {
  get_settlement_details: cmd(
    "get_settlement_details",
    "The payouts PayU made to the business's bank on one day, or one payout by its bank reference (UTR): amount, fees, and the payments it covered.",
    z.object({ date_or_utr: z.string().min(1).describe("A day as YYYY-MM-DD, or a payout's UTR number from the bank statement") }),
    (i) => [i.date_or_utr],
    true,
  ),
  get_transaction_settlement: {
    description: "Whether one payment has been paid out to the business yet: settlement status, UTR, settled amount and fees, by the business's order id.",
    input: z.object({ mid, txnid }),
    readOnly: true,
    run: (i: { mid: string; txnid: string }, key: string) => settlement(key, "/settlement/transactionDetails", i.mid, { merchantTransactionId: i.txnid }),
  },
  list_settlements: {
    description: "Payment by payment, what PayU settled to the business over up to 3 days: UTR, settled amount, fees and dates. Pages of up to 50,000 rows.",
    input: z.object({
      mid,
      from: day.describe("First day, YYYY-MM-DD"),
      to: day.optional().describe("Last day, YYYY-MM-DD, at most 3 days after `from` (defaults to `from`)"),
      page: z.number().int().min(1).optional().describe("Page number, from 1"),
      page_size: z.number().int().min(1).max(50000).optional().describe("Rows per page (default 100)"),
    }),
    readOnly: true,
    run: (i: { mid: string; from: string; to?: string; page?: number; page_size?: number }, key: string) =>
      settlement(key, "/settlement/range", i.mid, { dateFrom: i.from, dateTo: i.to, page: i.page, pageSize: i.page_size }),
  },
  get_upcoming_settlements: {
    description: "Money PayU still owes the business: the next payout's amount and date, what's pending or on hold, and the last payout made. For cash-flow questions.",
    input: z.object({ mid }),
    readOnly: true,
    run: (i: { mid: string }, key: string) => settlement(key, "/settlement/v1/merchantUpcomingSettlement", i.mid),
  },
};
