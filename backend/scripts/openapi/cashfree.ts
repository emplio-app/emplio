// Cashfree Payments (Payment Gateway): what the generator (../openapi-actions.ts) can't tell from the spec.
// The spec is the one Cashfree's own docs are built from. Three things in it trip the generator, so it's tidied into a
// temp file first: request bodies are all $refs (the generator reads only inline ones), one path carries a query string
// (/customers/{id}/instruments?instrument_type=card), and two operations share the id SubsFetchSubscription.
// Payouts is a separate product with its own keys, left out: own/cashfree/COVERAGE.md.
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AppConfig } from "../openapi-actions";

const SOURCE = "https://www.cashfree.com/docs/openapi/payments/v2026-01-01.yaml";
const spec: Record<string, any> = Bun.YAML.parse(await (await fetch(SOURCE)).text()) as Record<string, any>;
const bodies = spec.components?.requestBodies ?? {};
for (const ops of Object.values<Record<string, any>>(spec.paths))
  for (const op of Object.values<any>(ops)) {
    const ref = op?.requestBody?.$ref as string | undefined;
    if (ref) op.requestBody = bodies[ref.split("/").pop()!];
  }
spec.paths["/customers/{customer_id}/instruments"] = spec.paths["/customers/{customer_id}/instruments?instrument_type=card"];
delete spec.paths["/customers/{customer_id}/instruments?instrument_type=card"];
spec.paths["/subscriptions/charge/{payment_id}/transaction-return-summary/generate"].post.operationId = "SubsGenerateTransactionReturnSummary";
const file = join(tmpdir(), "cashfree-pg-openapi.json");
await Bun.write(file, JSON.stringify(spec));

// Every operation's action name, by call: Composio has no Cashfree toolkit to match, and the summaries make long names.
const NAMES: Record<string, string> = {
  "POST /customers": "create_customer",
  "GET /customers/{customer_id}/instruments": "list_saved_cards",
  "GET /customers/{customer_id}/instruments/{instrument_id}": "get_saved_card",
  "DELETE /customers/{customer_id}/instruments/{instrument_id}": "delete_saved_card",
  "GET /customers/{customer_id}/instruments/{instrument_id}/cryptogram": "get_saved_card_cryptogram",
  "POST /eligibility/cardlessemi": "get_eligible_cardless_emi",
  "POST /eligibility/offers": "get_eligible_offers",
  "POST /eligibility/paylater": "get_eligible_paylater",
  "POST /eligibility/payment_methods": "get_eligible_payment_methods",
  "POST /links": "create_payment_link",
  "GET /links/{link_id}": "get_payment_link",
  "POST /links/{link_id}/cancel": "cancel_payment_link",
  "GET /links/{link_id}/orders": "list_payment_link_orders",
  "POST /offers": "create_offer",
  "GET /offers/{offer_id}": "get_offer",
  "POST /orders": "create_order",
  "POST /orders/pay/authenticate/{cf_payment_id}": "submit_payment_otp",
  "POST /orders/sessions": "pay_order",
  "GET /orders/{order_id}": "get_order",
  "PATCH /orders/{order_id}": "terminate_order",
  "GET /orders/{order_id}/extended": "get_order_extended",
  "PUT /orders/{order_id}/extended": "update_order_extended",
  "POST /orders/{order_id}/authorization": "capture_or_void_payment",
  "GET /orders/{order_id}/payments": "list_order_payments",
  "GET /orders/{order_id}/payments/{cf_payment_id}": "get_payment",
  "POST /orders/{order_id}/refunds": "create_refund",
  "GET /orders/{order_id}/refunds": "list_order_refunds",
  "GET /orders/{order_id}/refunds/{refund_id}": "get_refund",
  "PUT /orders/{order_id}/refunds/{refund_id}": "update_refund",
  "GET /orders/{order_id}/settlements": "get_order_settlement",
  "POST /orders/settlements": "mark_order_for_settlement",
  "GET /easy-split/vendors/{vendor_id}": "get_vendor",
  "PATCH /easy-split/vendors/{vendor_id}": "update_vendor",
  "POST /easy-split/vendors": "create_vendor",
  "GET /easy-split/vendor-docs/{vendor_id}": "get_vendor_documents_status",
  "POST /easy-split/vendor-docs/{vendor_id}": "upload_vendor_document",
  "GET /easy-split/vendor-docs/{vendor_id}/download/{doc_type}": "download_vendor_document",
  "GET /easy-split/vendors/{vendor_id}/balances": "get_vendor_balance",
  "GET /easy-split/amount/{amount}/charges": "get_vendor_transfer_charges",
  "POST /easy-split/vendors/{vendor_id}/transfer": "create_vendor_transfer",
  "POST /easy-split/orders/{order_id}/split": "split_order_after_payment",
  "POST /easy-split/static-split": "create_static_split",
  "POST /easy-split/vendors/{vendor_id}/adjustment": "create_vendor_adjustment",
  "GET /easy-split/orders/{order_id}": "get_order_split_details",
  "POST /split/order/vendor/recon": "list_order_split_details",
  "POST /recon": "list_transactions",
  "GET /orders/{order_id}/disputes": "list_order_disputes",
  "GET /payments/{cf_payment_id}/disputes": "list_payment_disputes",
  "GET /disputes/{dispute_id}": "get_dispute",
  "PUT /disputes/{dispute_id}/accept": "accept_dispute",
  "PUT /disputes/{dispute_id}/contest-arbitration": "contest_dispute_arbitration",
  "POST /disputes/{dispute_id}/documents": "submit_dispute_evidence",
  "POST /settlement/recon": "list_settlement_transactions",
  "POST /settlements": "list_settlements",
  "POST /recon/vendor": "list_vendor_transactions",
  "POST /terminal": "create_terminal",
  "POST /terminal/payments": "list_terminal_transactions",
  "GET /terminal/qrcodes": "get_terminal_qr_codes",
  "POST /terminal/transactions": "create_terminal_transaction",
  "POST /terminal/soundbox": "onboard_soundbox",
  "PATCH /terminal/{cf_terminal_id}/soundbox": "update_soundbox",
  "POST /terminal/demap/soundbox": "unlink_soundbox",
  "GET /terminal/soundbox/qrcodes": "get_soundbox_vpa",
  "GET /terminal/{cf_terminal_id}/payments": "get_terminal_transaction",
  "PATCH /terminal/{cf_terminal_id}": "update_terminal",
  "PATCH /terminal/{cf_terminal_id}/status": "update_terminal_status",
  "GET /terminal/{terminal_phone_no}": "get_terminal",
  "POST /terminal/{cf_terminal_id}/docs": "upload_terminal_document",
  "POST /simulate": "simulate_payment",
  "GET /simulate/{simulation_id}": "get_simulation",
  "POST /simulate/settlement": "simulate_settlement",
  "GET /simulate/settlement/{simulation_id}": "get_settlement_simulation",
  "POST /simulate/settlement/vendor": "simulate_vendor_settlement",
  "POST /simulate/easy-split/enable": "enable_easy_split_sandbox",
  "GET /simulate/easy-split/status": "get_easy_split_sandbox_status",
  "GET /subscriptions/{subscription_id}": "get_subscription",
  "POST /subscriptions": "create_subscription",
  "POST /subscriptions/{subscription_id}/manage": "manage_subscription",
  "GET /plans/{plan_id}": "get_plan",
  "POST /plans": "create_plan",
  "GET /subscriptions/{subscription_id}/payments": "list_subscription_payments",
  "GET /subscriptions/{subscription_id}/payments/{payment_id}": "get_subscription_payment",
  "POST /subscriptions/{subscription_id}/payments/{payment_id}/manage": "manage_subscription_payment",
  "GET /subscriptions/{subscription_id}/refunds/{refund_id}": "get_subscription_refund",
  "POST /subscriptions/{subscription_id}/refunds": "create_subscription_refund",
  "POST /subscriptions/pay": "charge_subscription",
  "POST /subscriptions/pay/controlled/notify-mandate": "send_subscription_debit_notice",
  "GET /subscriptions/payments/{payment_id}/controlled/notifications/{notification_id}": "get_subscription_debit_notice",
  "GET /subscriptions/payments/{payment_id}/controlled/notifications": "list_subscription_debit_notices",
  "POST /subscriptions/pay/controlled/execute-mandate": "execute_subscription_debit",
  "GET /subscriptions/payments/{payment_id}/controlled/executions/{execution_id}": "get_subscription_debit",
  "GET /subscriptions/payments/{payment_id}/controlled/executions": "list_subscription_debits",
  "POST /subscriptions/pay/documents/{payment_id}": "upload_physical_nach_form",
  "POST /subscriptions/eligibility/payment_methods": "get_subscription_payment_methods",
  "POST /subscriptions/charge/{payment_id}/transaction-return-summary/generate": "generate_transaction_return_summary",
  "POST /utilities/cardbin": "get_card_bin",
  "POST /utilities/pars": "get_card_par",
  "GET /incident": "list_downtimes",
  "GET /incident/{id}": "get_downtime",
};

export default {
  spec: file,
  out: "src/integrations/own/cashfree/actions.json",
  name: (_id, method, path) => {
    const name = NAMES[`${method} ${path}`];
    if (!name) throw new Error(`no name for ${method} ${path}: add it to scripts/openapi/cashfree.ts`);
    return name;
  },
  skip: {
    // needs 3-D Secure results from a card network's authentication server, which only a checkout page has, and a flag
    // Cashfree switches on per account
    PGPayOrderAuthorizeOnly: "card authorisation with 3-D Secure data only a checkout page has (AUTHORIZE_ONLY accounts)",
  },
  // the version goes with every call (own/cashfree/index.ts); a request id is Cashfree's tracing nicety; the x-client-*
  // headers describe a shopper's browser, which Emplio isn't
  drop: { "*": ["x-api-version", "x-request-id", "Content-Type", "Accept", "x-client-device", "x-client-os", "x-client-rendering-type", "x-client-browser"] },
  // POSTs that only look things up
  reads: [
    "get_eligible_cardless_emi",
    "get_eligible_offers",
    "get_eligible_paylater",
    "get_eligible_payment_methods",
    "list_order_split_details",
    "list_transactions",
    "list_settlement_transactions",
    "list_settlements",
    "list_vendor_transactions",
    "list_terminal_transactions",
    "get_subscription_payment_methods",
    "generate_transaction_return_summary",
    "get_card_bin",
    "get_card_par",
  ],
  // a card's one-time cryptogram is a card credential
  secrets: ["get_saved_card_cryptogram"],
  params: {
    "x-idempotency-key": "Any unique text (a UUID) to make retries safe: sending the same key again within a day returns the first answer instead of doing it twice. Use one for refunds and anything that moves money.",
  },
} satisfies AppConfig;
