// Split payments, for marketplaces that collect on behalf of sellers (child merchants): sharing a payment out,
// releasing a held share to a seller, and reading how payments were split.
import { z } from "zod";
import type { OwnAction } from "../index";
import { cmd } from "./client";
import { payuId } from "./transactions";

const moment = z.string().regex(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/, "YYYY-MM-DD HH:MM");
const range = {
  from: moment.describe("Start, YYYY-MM-DD HH:MM (Indian time)"),
  to: moment.optional().describe("End, YYYY-MM-DD HH:MM (Indian time)"),
  page: z.number().int().min(1).optional().describe("Page number, from 1"),
  limit: z.number().int().min(1).max(1000).optional().describe("Rows per page (default 1000)"),
};

export const splitActions: Record<string, OwnAction> = {
  split_payment: cmd(
    "payment_splity",
    "Share a payment that already happened between the marketplace and its sellers, by fixed amounts or percentages. Decides who gets paid what.",
    z.object({
      split: z
        .record(z.string(), z.unknown())
        .describe(
          'PayU\'s split request: {"type": "absolute" or "percentage", "payuId": "<mihpayid>", "splitInfo": {"<child merchant key>": {"aggregatorSubTxnId": "<your id for this share>", "aggregatorSubAmt": "<amount or percent>", "aggregatorCharges": "<marketplace fee>"}}}',
        ),
    }),
    (i) => [i.split],
    false,
  ),
  release_settlement: cmd(
    "release_settlement",
    "Let PayU pay a seller their held share of a split payment (e.g. once the order is delivered). Moves money to the seller.",
    z.object({ payu_id: payuId, child_mid: z.string().min(1).describe("The seller's (child merchant's) PayU MID") }),
    (i) => [i.payu_id, i.child_mid],
    false,
  ),
  get_split_info: cmd("get_split_info", "How one payment was split: each seller's share, fee and settlement status.", z.object({ payu_id: payuId }), (i) => [i.payu_id], true),
  list_aggregator_transactions: cmd(
    "get_aggregator_transactions",
    "The marketplace's own payments over a time range, optionally only those already split (1) or not yet split (0).",
    z.object({ ...range, split_created: z.enum(["0", "1"]).optional().describe("1: only payments already split; 0: only ones not yet split") }),
    (i) => [i.from, i.to, i.page, i.limit, i.split_created],
    true,
  ),
  list_split_transactions: cmd(
    "get_split_transactions",
    "The split shares (child payments) over a time range, for the marketplace or one seller.",
    z.object({ ...range, merchant_key: z.string().optional().describe("One seller's merchant key to see only theirs; leave out for the marketplace's own") }),
    (i) => [i.from, i.to, i.page, i.limit, i.merchant_key],
    true,
  ),
};
