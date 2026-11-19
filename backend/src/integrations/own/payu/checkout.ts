// Before a customer pays: which payment methods and banks are working right now, card details from its first
// digits, EMI plans and their monthly amounts, the full list of methods this account can take, and whether a
// UPI id is real. All lookups.
import { z } from "zod";
import type { OwnAction } from "../index";
import { cmd, creds, jsonCmd, offers } from "./client";

const bin = z.string().regex(/^\d{6}$/, "the first 6 digits of the card").describe("The first 6 digits of the card number (its BIN), e.g. 512345");

export const checkoutActions: Record<string, OwnAction> = {
  get_payment_options_status: cmd(
    "getNetbankingStatus",
    "Whether payment methods are working right now: all net banking banks, wallets and UPI at once, or one by its code. Use it when customers say payments are failing.",
    z.object({
      code: z.string().min(1).describe('"default" for every method, or one code: a bank (AXIB, SBIB, HDFB), a wallet (PHONEPE, OLAM) or UPI'),
      performance: z.boolean().optional().describe("true to also flag methods that are up but failing often (up_status 3)"),
    }),
    (i) => [i.code, i.performance ? "1" : undefined],
    true,
  ),
  get_issuing_bank_status: cmd("getIssuingBankStatus", "Whether the bank that issued a card is working right now, from the card's first 6 digits.", z.object({ bin }), (i) => [i.bin], true),
  get_issuing_bank_down_bins: cmd(
    "getIssuingBankDownBins",
    "Card number ranges (BINs) whose bank is fully or partly down right now.",
    z.object({
      bank: z.string().min(1).describe('A bank code PayU gave the business, or "default" for all banks'),
      partly: z.boolean().optional().describe("true for ranges that are partly down; false or left out for fully down"),
    }),
    (i) => [i.bank, i.partly ? "1" : "0"],
    true,
  ),
  get_bin_info: cmd(
    "getBinInfo",
    "Card details from its first digits: credit or debit, Visa/Mastercard/RuPay, issuing bank, domestic or international, and whether it supports OTP-on-page or recurring. Also lists BINs by feature.",
    z.object({
      type: z.enum(["1", "2", "3"]).describe("1: one card's details (give bin); 2: BINs with a feature (give feature); 3: every BIN, in pages"),
      bin: z.string().regex(/^\d{6,9}$/).optional().describe("With type 1: the card's first 6–9 digits"),
      feature: z.enum(["1", "2"]).optional().describe("With type 2: 1 for ATM PIN support, 2 for OTP-on-the-fly support"),
      start: z.number().int().min(0).optional().describe("Paging: where to start"),
      count: z.number().int().min(1).optional().describe("Paging: how many (default 100)"),
      extra: z.boolean().optional().describe("true to also say whether the card supports zero-redirect and recurring (SI) payments"),
    }),
    (i) => [i.type, i.type === "1" ? i.bin : i.type === "2" ? i.feature : "", i.start, i.count, i.extra ? "1" : undefined],
    true,
  ),
  check_card_domestic: cmd("check_isDomestic", "Whether a card is Indian or international, with its type and issuing bank, from its first 6 digits.", z.object({ bin }), (i) => [i.bin], true),
  get_emi_eligible_bins: cmd(
    "eligibleBinsForEMI",
    "Whether a card can pay in EMI instalments, and with which banks' plans.",
    z.object({
      kind: z.enum(["bin", "NET"]).describe('"bin" for a card number\'s first digits, "NET" for a network token'),
      digits: z.string().regex(/^\d{6,9}$/).describe("The first 6, 8 or 9 digits of the card number or network token"),
    }),
    (i) => [i.kind, i.digits],
    true,
  ),
  get_emi_options: cmd(
    "getEmiAmountAccordingToInterest",
    "Every EMI plan for an amount: each bank and tenure (3, 6, 9, 12 months…) with its interest rate, monthly instalment and total paid. For telling a customer what they'd pay per month.",
    z.object({ amount: z.string().regex(/^\d+(\.\d{1,2})?$/).describe("The price in rupees, like 45000") }),
    (i) => [i.amount],
    true,
  ),
  get_checkout_details: jsonCmd(
    "get_checkout_details",
    "Every payment method this PayU account can take for an amount, with which are up, EMI and pay-later (BNPL) plans, offers, and optionally whether one customer is eligible for cardless EMI or pay-later.",
    z.object({
      requestId: z.string().min(1).describe("Any unique reference for this question, e.g. chk-1001"),
      transactionDetails: z.object({ amount: z.number().positive().describe("Amount in rupees") }).describe('{"amount": 8000}'),
      customerDetails: z.object({ mobile: z.string().optional().describe("Customer's 10-digit mobile") }).loose().optional().describe("For customer eligibility checks: {\"mobile\": \"9876543210\"}"),
      useCase: z
        .record(z.string(), z.boolean())
        .optional()
        .describe('What to include, e.g. {"getExtendedPaymentDetails": true}, {"checkCustomerEligibility": true}, {"getAdditionalCharges": true}, {"getPaymentDetailsWithExtraFields": true}'),
      filters: z.record(z.string(), z.unknown()).optional().describe('Narrow the answer, e.g. {"paymentOptions": {"emi": {"dc": "all", "cc": "all", "cardless": "all"}, "bnpl": "all"}}'),
    }),
    true,
  ),
  list_offers: {
    description: "The discount and cashback offers live on this PayU account (set up in the PayU Dashboard), with each one's terms and, given an amount, the discount it would give.",
    input: z.object({
      amount: z.number().positive().optional().describe("Order amount in rupees, to get each offer's discount worked out"),
      user_id: z.string().optional().describe("The customer's id on the business's site, for offers personalised to them"),
      autoApply: z.boolean().optional().describe("true to have PayU pick the best offer"),
    }),
    readOnly: true,
    run: (i: { amount?: number; user_id?: string; autoApply?: boolean }, key: string) =>
      offers(key, "/offers/transactions", { amount: i.amount, autoApply: i.autoApply, userToken: i.user_id ? `${creds(key).key}:${i.user_id}` : undefined }),
  },
  validate_offer: {
    description: "Whether an offer applies to a payment (amount and payment method), and the discount it gives, without applying it.",
    input: z.object({
      amount: z.number().positive().describe("Order amount in rupees"),
      offerKeys: z.array(z.string()).min(1).describe("Offer keys from payu.list_offers, e.g. [\"SummerSpecialOffer2021@07qIdabo1AHl\"]"),
      paymentDetail: z
        .object({
          category: z.string().optional().describe("CREDITCARD, DEBITCARD, NETBANKING, UPI, WALLET, EMI…"),
          paymentCode: z.string().optional().describe("PayU's method or bank code, e.g. CC, AXIB, UPI"),
          vpa: z.string().optional().describe("The UPI id, for UPI"),
        })
        .loose()
        .optional()
        .describe("How the customer will pay"),
      userDetail: z.record(z.string(), z.unknown()).optional().describe('The customer, e.g. {"email": "a@b.in", "phoneNo": "9876543210"}'),
    }),
    readOnly: true,
    run: (i: Record<string, unknown>, key: string) => offers(key, "/offers/transactions/validate", i),
  },
  validate_upi_id: cmd(
    "validateVPA",
    "Whether a UPI id (like name@okicici) exists, with the account holder's name, before asking a customer to pay with it. Can also check that it supports UPI AutoPay.",
    z.object({
      upi_id: z.string().regex(/^[\w.\-]+@[\w.\-]+$/, "like name@bank").describe("The UPI id (VPA), e.g. asha@okhdfcbank"),
      autopay: z.boolean().optional().describe("true to also check it can be used for UPI AutoPay (recurring)"),
    }),
    (i) => [i.upi_id, i.autopay ? { validateAutoPayVPA: "1" } : undefined],
    true,
  ),
};
