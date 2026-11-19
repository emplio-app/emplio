# Cashfree coverage

Source: Cashfree's Payment Gateway OpenAPI spec, version 2026-01-01, the one its docs are built from
(`https://www.cashfree.com/docs/openapi/payments/v2026-01-01.yaml`), generated 2026-11-19 by
`bun scripts/openapi-actions.ts cashfree`. Webhook events read from the docs' webhook pages the same day. Composio has
no Cashfree toolkit (docs.composio.dev/toolkits/cashfree is a 404), so there's no benchmark to match. n8n: no node.

99 actions from the spec, 1 hand-written (get_webhook_setup), 40 triggers, 1 sign-in method.

## Deliberately left out

| What | Why |
| --- | --- |
| Payouts (transfers, beneficiaries, batch transfers, Cashgram) | A separate Cashfree product with its own spec (`openapi/payouts/payoutsv2extra.yaml`, 7 v2 calls), its own base (`/payout`) and **its own key pair**, made in the Payouts dashboard, not the Payment Gateway one. Production calls also need the server's IP whitelisted or an RSA signature (`X-Cf-Signature`) from a public key the business downloads. So it can't share this connection's key; it needs its own connection with a key and either a public key or Emplio's fixed IP. Build it as a `cashfree_payouts` app when someone asks; every call that sends money asks first |
| POST /orders/sessions/authorize (Order Pay Authorise Only) | Takes 3-D Secure results from a card network's authentication server, which only a checkout page has, and works only on accounts Cashfree flags AUTHORIZE_ONLY |
| Polled triggers | Cashfree has no list of payments, orders or links to compare. Its reconciliation report (list_transactions) is by date and lags, so everything is a webhook |
| Registering webhooks by API | Cashfree has no webhook API: they're set in the dashboard. get_webhook_setup tells the owner what to add |
| Partner (x-partner-apikey) sign-in | For Cashfree platform partners acting for merchants, not a business on its own account |
| Global Collections, VBA, Cross-border imports | Separate specs and products (`openapi/cb-imports`, `openapi/pgvba`), switched on only for some merchants |

## Hand adjustments

- `scripts/openapi/cashfree.ts` tidies the spec before generating: request bodies are `$ref`s (inlined), one path
  carries `?instrument_type=card` (moved to the query), and `SubsFetchSubscription` names two operations (the second
  renamed). Every action is named by hand (`NAMES`), since there's no Composio list and the summaries are long.
- Dropped from every input: `x-api-version` (sent on every call as 2026-01-01), `x-request-id`, and the shopper-browser
  headers. `x-idempotency-key` stays, with a plain description, for refunds and anything that moves money.
- POSTs that only look things up run without asking: eligibility, reconciliation, settlements, terminal transactions,
  card BIN/PAR, subscription payment methods, transaction return summary.
- `get_saved_card_cryptogram` asks first (a card credential).
- Descriptions added to list_transactions (how to see recent payments), list_settlements, create_payment_link,
  create_order and create_refund (amounts in rupees, not paise).

## Auth

| Method | Status |
| --- | --- |
| Client ID + Client Secret (Payment Gateway → Developers → API Keys), pasted as `CLIENT_ID:CLIENT_SECRET`, sent as `x-client-id` / `x-client-secret` with `x-api-version` | done |
| Sandbox vs production | From the key: a client ID starting `TEST` or a `cfsk_ma_test_` secret is sandbox (sandbox.cashfree.com/pg), else production (api.cashfree.com/pg). `:sandbox` / `:production` at the end overrides. The check tries the other mode when the guess fails and says what to add. The connection is labelled "Production · CF12345a…" or "Sandbox (test) · TEST1234…" |
| OAuth | Cashfree offers none to merchants |

## Triggers (webhooks, set up once in the dashboard)

At `/webhooks/app/cashfree/<connection>`. Signature: base64(HMAC-SHA256(`x-webhook-timestamp` + raw body, client
secret)) in `x-webhook-signature`, checked with the stored key. Delivery id: `x-idempotency-key` (webhook version
2025-01-01 on), else a hash of the body. Filters: `order_id` on payment, refund and dispute triggers, `link_id` on link
triggers, `subscription_id` on subscription triggers.

| Group | Triggers | Cashfree event |
| --- | --- | --- |
| Payments | payment_success, payment_failed, payment_user_dropped, payment_charges | PAYMENT_SUCCESS / FAILED / USER_DROPPED / CHARGES_WEBHOOK |
| Refunds | refund_status_changed, refund_processed, refund_cancelled, auto_refund_processed | REFUND_STATUS_WEBHOOK (by refund_status), AUTO_REFUND_STATUS_WEBHOOK |
| Settlements | settlement_initiated, settlement_success, settlement_failed, settlement_reversed | SETTLEMENT_* |
| Disputes | dispute_created, dispute_updated, dispute_closed | DISPUTE_* |
| Payment links | payment_link_event, payment_link_paid, payment_link_partially_paid, payment_link_expired, payment_link_cancelled | PAYMENT_LINK_EVENT (by link_status) |
| Payment forms | payment_form_paid | PAYMENT_FORM_ORDER_WEBHOOK |
| Saved cards | saved_card_active, saved_card_failed | INSTRUMENT_ACTIVE / FAILED_WEBHOOK |
| Subscriptions | subscription_status_changed, subscription_auth_status, subscription_payment_notification, subscription_payment_success, subscription_payment_failed, subscription_payment_cancelled, subscription_refund_status, subscription_card_expiry_reminder, subscription_debit_notice_status, subscription_debit_status | SUBSCRIPTION_* |
| Easy Split | vendor_settlement_initiated, vendor_settlement_success, vendor_settlement_failed, vendor_settlement_reversed, vendor_status_changed | VENDOR_SETTLEMENT_*, VENDOR_STATUS_UPDATE |
| Downtime | payment_downtime | HEALTH_ALERT |
| SoftPOS | terminal_status_changed | TERMINAL_STATUS_UPDATE |

Not seen: TRANSACTION_WISE_SETTLEMENT_SUCCESS appears once in a docs sample but in no event list; left out until
Cashfree documents it.

## Actions by group (* asks first)

**Orders** (5): create_order*, get_order, terminate_order*, get_order_extended, update_order_extended*

**Payment Links** (4): create_payment_link*, get_payment_link, cancel_payment_link*, list_payment_link_orders

**Payments** (5): pay_order*, submit_payment_otp*, capture_or_void_payment*, list_order_payments, get_payment

**Refunds** (4): create_refund*, list_order_refunds, get_refund, update_refund*

**Settlements and reconciliation** (6): get_order_settlement, mark_order_for_settlement*, list_settlements, list_settlement_transactions, list_transactions, list_vendor_transactions

**Disputes** (6): list_order_disputes, list_payment_disputes, get_dispute, accept_dispute*, contest_dispute_arbitration*, submit_dispute_evidence*

**Customers and saved cards** (5): create_customer*, list_saved_cards, get_saved_card, delete_saved_card*, get_saved_card_cryptogram*

**Eligibility** (4): get_eligible_cardless_emi, get_eligible_offers, get_eligible_paylater, get_eligible_payment_methods

**Offers** (2): create_offer*, get_offer

**Easy Split** (14): create_vendor*, get_vendor, update_vendor*, get_vendor_documents_status, upload_vendor_document*, download_vendor_document, get_vendor_balance, get_vendor_transfer_charges, create_vendor_transfer*, split_order_after_payment*, create_static_split*, create_vendor_adjustment*, get_order_split_details, list_order_split_details

**Subscriptions** (20): create_plan*, get_plan, create_subscription*, get_subscription, manage_subscription*, list_subscription_payments, get_subscription_payment, manage_subscription_payment*, charge_subscription*, create_subscription_refund*, get_subscription_refund, send_subscription_debit_notice*, get_subscription_debit_notice, list_subscription_debit_notices, execute_subscription_debit*, get_subscription_debit, list_subscription_debits, upload_physical_nach_form*, get_subscription_payment_methods, generate_transaction_return_summary

**SoftPOS** (13): create_terminal*, get_terminal, update_terminal*, update_terminal_status*, upload_terminal_document*, get_terminal_qr_codes, create_terminal_transaction*, list_terminal_transactions, get_terminal_transaction, onboard_soundbox*, update_soundbox*, unlink_soundbox*, get_soundbox_vpa

**Sandbox simulation** (7): simulate_payment*, get_simulation, simulate_settlement*, get_settlement_simulation, simulate_vendor_settlement*, enable_easy_split_sandbox*, get_easy_split_sandbox_status

**Utilities and downtime** (4): get_card_bin, get_card_par, list_downtimes, get_downtime

**Hand-written** (1): get_webhook_setup

## Not tried live

No Cashfree keys were available: the key check (a made-up order answering 404), the sandbox/production guess, and
the webhook signature are built from Cashfree's docs and tested with faked responses only. Worth confirming on a
sandbox account: that a wrong key answers 401 (not 403), and that Payment Link and Subscription webhooks sign the same
way as payment ones (the docs say so).
