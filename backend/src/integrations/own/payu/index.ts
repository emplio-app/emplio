// PayU India on the business's own merchant key and salt: payment status, transaction lists, refunds, payment
// links, settlements, split payments for marketplaces, recurring payments (card, net banking, UPI AutoPay), saved
// cards, UPI QR codes and links, and checkout lookups (bank uptime, card BINs, EMI plans, UPI ids). PayU has no
// OpenAPI spec for its merchant command API, so each call is written by hand from docs.payu.in; COVERAGE.md
// lists them and what's left out. Triggers come from a webhook the owner pastes into the PayU Dashboard
// (triggers.ts) or from reading the transaction list (polls/payu.ts).
import { z } from "zod";
import { AppsError } from "../../types";
import type { OwnApp } from "../index";
import { cardActions } from "./cards";
import { checkoutActions } from "./checkout";
import { command, creds } from "./client";
import { paymentLinkActions } from "./payment_links";
import { qrActions } from "./qr";
import { recurringActions } from "./recurring";
import { refundActions } from "./refunds";
import { settlementActions } from "./settlements";
import { splitActions } from "./split";
import { transactionActions } from "./transactions";
import { events, receive, triggers, wanted, watch, webhookSetup } from "./triggers";

const setup = {
  get_webhook_setup: {
    description:
      "Where to paste Emplio's address in the PayU Dashboard so PayU's instant triggers (payment_successful, payment_failed, refund_successful, dispute_update…) work. PayU takes webhooks only in its dashboard, so the owner does this once by hand; tell them the address and the events exactly as this answers. The polled new_payment trigger needs none of this.",
    input: z.object({}),
    readOnly: true,
    run: async (_input: Record<string, unknown>, _key: string, connection?: string) => webhookSetup(connection),
  },
};

export const payu: OwnApp = {
  app: "payu",
  name: "PayU",
  logo: "/logos/payu.svg",
  keyField: {
    label: "Merchant key and salt",
    help: "PayU Dashboard → Developers → API Keys (older dashboards: Payment Gateway → Settings → Key and Salt). Paste both as one line, key first, joined by a colon: KEY:SALT. For test-mode keys from test.payu.in add :test at the end: KEY:SALT:test",
    placeholder: "aBcD12:yourMerchantSalt",
  },
  // a lookup of an order id that can't exist: it needs a correct key and salt to get any answer
  async check(key) {
    const c = creds(key);
    const out = await command(key, "verify_payment", ["emplio-connection-check"]);
    if (typeof out !== "object" || out === null) {
      // a test key sent to live (or the other way round) gets a page, not JSON
      throw new AppsError(c.test ? "PayU's test site didn't recognise these; if they're live keys, leave out :test" : "PayU didn't recognise these; if they're test-mode keys, add :test at the end");
    }
    return `${c.test ? "Test mode" : "Live"} · ${c.key}`;
  },
  actions: {
    ...transactionActions,
    ...refundActions,
    ...paymentLinkActions,
    ...settlementActions,
    ...splitActions,
    ...recurringActions,
    ...cardActions,
    ...qrActions,
    ...checkoutActions,
    ...setup,
  },
  push: { events, triggers, start: (_key, connection) => watch(connection), receive, wanted },
};
