// Refunds: starting one, and following it until the money is back with the customer.
import { z } from "zod";
import type { OwnAction } from "../index";
import { cmd } from "./client";
import { amount, payuId, txnid } from "./transactions";

const requestId = z.string().min(1).describe("PayU's id for the refund request (request_id), from payu.refund_payment's answer or a refund event");

export const refundActions: Record<string, OwnAction> = {
  refund_payment: cmd(
    "cancel_refund_transaction",
    "Refund a payment, fully or in part. Moves money back to the customer. Several partial refunds may add up to the amount paid. The answer has PayU's request_id for following it with payu.get_refund_status.",
    z.object({
      payu_id: payuId,
      reference: z.string().min(1).max(23).describe("A new unique id of the business's own for this refund (at most 23 characters), e.g. RF-1001-1. Re-using one makes PayU refuse the refund"),
      amount: amount.describe("Amount to refund in rupees: the whole payment for a full refund, less for a partial one"),
      callback_url: z.string().url().optional().describe("Optional web address PayU should tell when this refund finishes"),
      split_info: z.record(z.string(), z.unknown()).optional().describe("Only for split (marketplace) payments: how the refund is shared between the sub-merchants, in PayU's var8 format"),
      notes: z.record(z.string(), z.unknown()).optional().describe("Optional notes kept with the refund for later tracking (PayU's var9), e.g. {\"reason\": \"damaged item\"}"),
    }),
    (i) => [i.payu_id, i.reference, i.amount, undefined, i.callback_url, undefined, undefined, i.split_info, i.notes],
    false,
  ),
  get_refund_status: cmd(
    "check_action_status",
    "Where one refund is: queued, success or failure, with the bank reference (ARN) the customer can quote to their bank.",
    z.object({ request_id: requestId }),
    (i) => [i.request_id],
    true,
  ),
  list_payment_refunds: cmd(
    "check_action_status",
    "Every refund and cancellation made on one payment, by PayU's payment id, with each one's status and amount.",
    z.object({ payu_id: payuId }),
    (i) => [i.payu_id, "payuid"],
    true,
  ),
  list_order_refunds: cmd(
    "getAllRefundsFromTxnIds",
    "Every refund made against one of the business's order ids, with status, amount and bank reference.",
    z.object({ txnid }),
    (i) => [i.txnid],
    true,
  ),
  get_split_refund_status: cmd(
    "aggregator_check_action_status_txnid",
    "For split (marketplace) payments: the refunds on a payment and how each was shared between the sub-merchants.",
    z.object({ payu_id: payuId }),
    (i) => [i.payu_id],
    true,
  ),
};
