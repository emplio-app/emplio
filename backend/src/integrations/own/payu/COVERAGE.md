# PayU coverage

Sources, swept 19 Nov 2026: docs.payu.in (its llms.txt index, and the `.md` copy of every API Reference page,
353 pages, most with an embedded OpenAPI fragment), Context7's copy of the same docs, and PayU's own SDKs on GitHub
(payu-india/web-sdk-python, web-sdk-go, sdk-java, payu-sdk-php, payu-sdk-node), which list the merchant commands and
`create_invoice` / `expire_invoice` / `get_settlement_details`, which the docs no longer show. No OpenAPI spec for the
whole API exists. Composio has no PayU toolkit (404). n8n has no PayU node.

Every merchant command that runs on the key and salt is an action, except those below: 57 actions.

## How it's called

- **Commands**: POST `https://info.payu.in/merchant/postservice.php?form=2` (test: `test.payu.in`), form fields
  `key`, `command`, `var1…varN`, `hash = sha512(key|command|var1|salt)`. Written by hand in `client.ts` (`cmd`,
  `jsonCmd`), since `own/openapi.ts` can't sign a body.
- **Settlement reports** (`get_transaction_settlement`, `list_settlements`, `get_upcoming_settlements`): GET on
  `info.payu.in/settlement/...` (test: `apitest.payu.in`, `test.payu.in` for upcoming), headers `Date`, `mid` and
  `Authorization: hmac username="<key>", algorithm="sha512", headers="date", signature="sha512(<body>|<date>|<salt>)"`.
  They need the numeric Merchant ID, which is an input on those three.
- **Offers** (`list_offers`, `validate_offer`): JSON POST on `api.payu.in/offers/...` (test: `sandbox.payu.in`),
  headers `Date`, `Digest: base64(sha256(body))`, `Authorization: hmac username="<key>", algorithm="hmac-sha256",
  headers="date digest", signature=base64(hmac_sha256("<date>\n<digest>", salt))`. The docs call the HMAC secret
  "merchant secret"; taking it to be the salt is unverified.
- **Errors**: PayU answers most failures with a 200 and `status: 0, msg`. Those come back as the answer for the agent to
  read, except a refused key or salt ("Invalid Hash", "Sorry, some problem occurred"), which asks for reconnecting.

## Sign-in

| Method | Status |
| --- | --- |
| Merchant key and salt, pasted `KEY:SALT` (live) or `KEY:SALT:test` (test.payu.in), labelled "Live · KEY" / "Test mode · KEY" | done |
| OAuth | PayU has none for merchants |

`check` runs `verify_payment` on an order id that can't exist: any answer needs a correct key and salt.

## Not covered

| What | Why |
| --- | --- |
| Payment Links API v2 (oneapi.payu.in/payment-links), Payouts, BBPS, Chargeback API, Partner/KYC, POS devices | Each needs a separate client id and secret (OAuth client credentials) or partner credentials, not the merchant key and salt. Payment links are covered by `create_payment_link` (`create_invoice`) on the key and salt. A second key field can add them later. |
| Taking a payment (`_payment`, S2S cards/UPI/net banking, OTP submit, consent/registration transactions, card mandate modify or RuPay/AMEX cancel through `_payment`) | These are the customer's checkout: they need the customer's card or UPI approval on the spot. Emplio asks for money through payment links and QR codes instead. |
| Saving or editing a card (`save_payment_instrument`, `edit_payment_instrument`), card cryptograms (`get_payment_details`) | Full card numbers and cryptograms: PCI data that shouldn't pass through a chat. Listing and deleting saved cards are in. |
| `opgsp_upload_invoice_awb` (cross-border invoice upload) | The page doesn't say how the file is sent; add when an exporter needs it. `update_transaction_udf` covers the PAN/DOB/IEC part. |
| `s2sEligibleBins`, `save card BIN info` | Server-to-server checkout variants of `get_bin_info`, which is in. |
| `check_action_status_txnid` | Undocumented vars; `list_order_refunds` answers the same question by order id. |
| `generate_invoice_qr`, `send_sdk_message` | For PayU's Android POS devices. |
| Sodexo `check_balance`, rewards balance | Need the customer's meal or reward card. |
| `get_TDR` for many payments, `getIssuingBankStatus` lists | One payment / one BIN per call is all PayU offers. |

Unverified: no live test was possible (no keys). The docs mark `create_invoice` / `expire_invoice` only in the SDKs;
if PayU has retired them for an account, the newer Payment Links API above is the replacement.

## Triggers

Webhooks: PayU has no API to register them. The owner creates them in PayU Dashboard → Developers → Webhooks
(Type: Payments; events Successful, Failed, Refund, Dispute), all pointed at the address `get_webhook_setup` gives:
`<WEBHOOK_URL>/webhooks/app/payu/<connection>/<token>`, served by the shared `/webhooks/app/` route.

- The token is an HMAC of `ENCRYPTION_KEY` and the connection id, checked timing-safe. It's the only check refund
  and dispute events have, since PayU sends them as JSON with no hash.
- Payment events (form-encoded) are also checked against PayU's reverse hash with the salt, and their `key` must be ours.
- Delivery ids: `payment:<mihpayid>:<status>`, `refund:<request_id>:<status>:<bank_arn>`, `dispute:<cb_id>:<cb_status>:<updated_at>`.

| Trigger | Event | Settings |
| --- | --- | --- |
| payment_successful | Successful | min_amount, mode, product |
| payment_failed | Failed | min_amount, mode, product |
| payment_event | Successful / Failed (also pending) | min_amount, mode, product |
| refund_successful | Refund (also the later ARN update) | |
| refund_failed | Refund | |
| dispute_update | Dispute | status |
| new_payment (polled, polls/payu.ts) | `get_Transaction_Details` for yesterday and today, every 5 minutes; no setup | status (success/failed/all), min_amount |

## Actions by group (* asks first)

**Payments** (9): verify_payment, check_payment, get_tdr, list_transactions, get_transaction_info,
update_transaction_udf*, get_additional_charges, capture_payment*, cancel_authorized_payment*

**Refunds** (5): refund_payment*, get_refund_status, list_payment_refunds, list_order_refunds, get_split_refund_status

**Payment links** (2): create_payment_link*, expire_payment_link*

**Settlements** (4): get_settlement_details, get_transaction_settlement, list_settlements, get_upcoming_settlements

**Split payments** (5): split_payment*, release_settlement*, get_split_info, list_aggregator_transactions, list_split_transactions

**Recurring payments** (10): send_pre_debit_notice*, charge_recurring_payment*, verify_recurring_payment,
get_card_mandate_status, get_netbanking_mandate_status, get_upi_mandate_status, cancel_mandate*, cancel_upi_mandate*,
modify_upi_mandate*, update_card_mandate*

**Saved cards** (3): list_saved_cards, list_tokenized_cards, delete_saved_card*

**UPI QR and links** (7): create_upi_qr*, create_upi_payment_link*, expire_upi_payment_links*, check_qr_payment,
cancel_qr_payment*, create_static_qr*, deactivate_static_qr*

**Checkout lookups** (11): get_payment_options_status, get_issuing_bank_status, get_issuing_bank_down_bins, get_bin_info,
check_card_domestic, get_emi_eligible_bins, get_emi_options, get_checkout_details, list_offers, validate_offer, validate_upi_id

**Setup** (1): get_webhook_setup
