# Swipe coverage

Source: Swipe's OpenAPI spec (https://developers.getswipe.in/api-reference/openapi.json), generated 2026-10-26
by `bun scripts/openapi-actions.ts swipe`, plus the earlier businessos `getswipe` integration for the expense
calls. n8n has no Swipe node. Webhooks read from Swipe's own docs (https://developers.getswipe.in/webhooks) on
2026-11-11. 41 actions, 15 triggers, 1 login method: every /v2 operation (35 from the spec), the 5 expense calls
and get_webhook_setup.

## By hand (index.ts)

Expenses dropped out of Swipe's spec but still answer (a key-less call gets 401, an unknown path 404):
list_expenses, get_expense, update_expense, cancel_expense, get_expense_pdf. update_expense sends the expense in
the query (items, party and payment_details as JSON text) and the receipts as a multipart body, as Swipe reads it.

get_webhook_setup is ours, not Swipe's: it answers the webhook address for this business and where in Swipe to paste
it, because Swipe's webhook can only be set up by hand (see Triggers).

## Deliberately left out

| What | Why |
| --- | --- |
| POST /v1/customer (post_customer) | identical to its /v2 twin |
| PUT /v1/customer (put_customer) | identical to its /v2 twin |
| GET /v1/customer/ledger (get_customer_ledger) | identical to its /v2 twin |
| GET /v1/customer/list (get_customer_list) | identical to its /v2 twin |
| POST /v1/customer/list (post_customer_list) | identical to its /v2 twin |
| GET /v1/customer/{customer_id} (get_customer) | identical to its /v2 twin |
| DELETE /v1/customer/{customer_id} (delete_customer) | identical to its /v2 twin |
| POST /v1/doc (post_invoice_resource) | identical to its /v2 twin |
| GET /v1/doc/pdf/{doc_hash_id} (get_pdf) | identical to its /v2 twin |
| DELETE /v1/doc/{doc_hash_id} (delete_cancel_invoice) | identical to its /v2 twin |
| POST /v1/payment (post_payment) | identical to its /v2 twin |
| GET /v1/product/list (get_item_list) | identical to its /v2 twin |
| POST /v1/product/list (post_item_list) | identical to its /v2 twin |
| GET /v1/product/{item_id} (get_product) | identical to its /v2 twin |
| DELETE /v1/product/{item_id} (delete_product) | identical to its /v2 twin |
| GET /v1/subscriptions/list (get_transactions) | identical to its /v2 twin |
| GET /v1/subscriptions/{subscription_hash_id} (get_subscription) | identical to its /v2 twin |
| GET /v1/utils/gstin/{gstin} (get_utils) | identical to its /v2 twin |
| POST /v2/product (post_product) | the spec gives only product_images for its body; the identical v1 call (JSON) is used instead |
| PUT /v2/product (put_product) | the spec gives only product_images for its body; the identical v1 call (JSON) is used instead |
| Product images | Only v2 takes them, and its declared body has nothing else; add them in the Swipe app |
| Registering a webhook by API | Swipe has no call for it: its webhook is one address per company, set by hand in the dashboard (see Triggers) |
| Removing a webhook | Same reason, so `push.stop` is left out: the address stays until the business takes it out of Swipe |
| Create expense | Swipe has no such call; expenses are raised in the Swipe app |
| OAuth | Swipe only offers API keys |

## Triggers

### Swipe tells us at once (webhook)

Swipe pushes two event types, `document` and `inventory`, to one address per company. **It has no API for this: the
business owner pastes the address into Swipe by hand, once.** `get_webhook_setup` answers exactly what to paste:

- **Where:** Swipe → Settings → API Integration (app.getswipe.in/user?tab=api_integration), the Webhooks part.
- **URL:** `https://api.emplio.app/webhooks/app/swipe/<connection>` (the connection's own id; `get_webhook_setup`
  fills it in).
- **Events:** tick `document` and `inventory`.
- **Secret:** the same Swipe API key the business is connected with. Swipe lets the secret be anything, so using the
  key means nothing extra is stored and no secret of ours is ever shown: `receive` checks `X-Signature` (an HMAC-SHA256
  of the raw body, hex) against the connection's key with a timing-safe compare, and a bad one is a 401. Deliveries are
  de-duplicated on Swipe's `event_id`. A business that regenerates its Swipe key reconnects Emplio and pastes the new
  key as the secret too.

Until that's pasted these stay quiet, which each trigger's description says. The polled triggers below need none of it.

| Trigger | Swipe event | Starts when | Settings |
| --- | --- | --- | --- |
| new_document | document | the message reads "created" | document_type |
| document_updated | document | any other message | document_type |
| document_cancelled | document | the message reads cancelled, deleted or void | document_type |
| document_event | document | always | document_type |
| stock_in | inventory | movement `in` | product_id |
| stock_out | inventory | movement `out` | product_id |
| stock_moved | inventory | always | product_id, movement |

Swipe publishes no codes for what happened to a document, only the English `message`, so that's what `new_document`,
`document_updated` and `document_cancelled` read. A document event carries no amounts and no customer: `hash_id` plus
`swipe.get_document` gets those. `push.stop` is left out, since the address is the business's dashboard setting.

### Emplio checks (polled, `polls/swipe.ts`)

No setup, every 5 minutes at the most often. Each check is one request (Swipe allows one a second); `new_customer`
takes two when there is more than a page of customers. `days` on each says how far back to look, since Swipe's lists
filter on the document's own date; `end_date` is sent as tomorrow because India runs ahead of the server.

| Trigger | List | Waits for | Look-back | Id it remembers |
| --- | --- | --- | --- | --- |
| new_invoice | list_documents (invoice) | any | 7 days | hash_id |
| invoice_paid | list_documents (invoice) | payment_status paid | 90 days | hash_id |
| invoice_overdue | list_documents (invoice) | pending, due_date passed | 90 days | hash_id:overdue |
| new_purchase | list_documents (purchase) | any | 14 days | hash_id |
| new_expense | list_expenses | any | 14 days | hash_id |
| payment_received | list_payments | status success | 2 days | customer, date, amount, mode and balance together |
| new_customer | list_customers | any | — | swipe_id |
| low_stock | list_products | quantity at or below `threshold` (default 5) | — | item id and quantity |

Swipe's payment list carries no id of its own, so `payment_received` builds one from the row: two payments of the same
amount and mode on the same day against the same customer and balance count as one. `low_stock` folds the quantity
into the id, so a further drop is a new event; it reads the 100 lowest-stocked items, so a catalogue where more than
100 items sit under the level loses the rest. `new_customer` has no date filter or sort in Swipe and Swipe doesn't say
which end of the list is newest, so both the first page and the last are read.

## Quirks

- Every answer is `{success, message, error_code, errors, data}`; `success: false` with a 200 is an error.
- 401 `FORBIDDEN` means the plan can't do it, not a dead key, so it doesn't ask to reconnect.
- Dates are DD-MM-YYYY everywhere. 1 request per second.
- Ids on parties and items are the business's own; an unknown one creates the record. map_* relinks them.
- E-invoices (`einvoice: true` on create_document) and e-way bills are a paid add-on.

Not verified against the live API: no Swipe key. No webhook delivery has been received from Swipe, and no list
answer has been seen from a real company; both are built from Swipe's documented payloads and schemas.
