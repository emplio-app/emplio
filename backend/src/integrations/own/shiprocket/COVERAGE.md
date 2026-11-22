# Shiprocket coverage

Source: Shiprocket's Postman collection behind apidocs.shiprocket.in (documenter.gw.postman.com collection
8407119/SzYW1zB2), read 2026-11-22. Shiprocket publishes no OpenAPI spec, so the calls are written by hand in
`orders.ts`, `shipping.ts` and `catalog.ts` and run through `own/openapi.ts`. Every one of the collection's 93
requests is covered: 73 actions, after removing the repeats (the Hyperlocal folder and parts of the Returns and
International folders reuse the same endpoints). Composio has no Shiprocket toolkit to compare with.

## Deliberately left out

| What | Why |
| --- | --- |
| Generate Token (`/auth/login`) | Not an action: Emplio logs in by itself (sign-in below) |
| Token Logout (`/auth/logout`) | Would only kill the token Emplio is using; nothing for the owner to gain |
| Hyperlocal folder, International "Tracking through AWB/shipment/order" and "Generate Pickup", Returns "Check serviceability" and "Generate AWB for return" | The same endpoints as track_awb, track_shipment, track_order, request_pickup, check_serviceability (is_return, qc_check) and assign_awb (is_return) |
| Webhooks | See Triggers |

## Sign-in

| Method | Status |
| --- | --- |
| API user email and password, pasted as `email:password` (Shiprocket → Settings → API → Configure → Create an API user; the password is emailed) | done |
| OAuth | Shiprocket has none |

There's no lasting key. Each call uses a Bearer token from `POST /auth/login` (valid about 10 days). Tokens are kept in
memory per connection, under a SHA-256 of the key, and fetched again when missing, older than 9 days, or turned down
(a 401 is retried once with a new login). The password is only ever sent to Shiprocket's login. `check()` logs in once
and labels the connection with the API user's name. A wrong email or password (400/401/403 from the login) marks the
connection for reconnecting.

## Hand adjustments

- Big order bodies (create/update/ship/return/international) list every documented field and are `.loose()`, so the
  rarer ones (latitude, what3words_address, checkout_shipping_method, qc_* item fields…) pass through untouched.
- Failures Shiprocket answers with a 200 (`awb_assign_status: 0`, a `status_code` of 400+ in the body) become errors.
- Blocked pincodes are on serviceability.shiprocket.in, same token.
- CSV imports (orders, products, listing mappings) upload the file as multipart `file`.
- Lookups that are POSTs run without asking: track_awbs, print_manifest, print_invoice.

## Triggers (polled, polls/shiprocket.ts)

| Trigger | How |
| --- | --- |
| new_order | newest 50 orders by id, every 10 min; filters: payment_method, channel_id |
| order_status_changed | orders changed since yesterday (updated_from/updated_to), id = order:status; filters: statuses, pickup_location |
| shipment_delivered, shipment_rto, order_cancelled | the same list, by status (DELIVERED, RTO*, CANCEL*) |
| new_ndr | failed deliveries of the last two days, id = awb:attempts, so each new attempt starts it |
| new_return_order | return orders of the last two days |

Shiprocket's webhook isn't used. It has one tracking-only URL per account, set only in its dashboard (Settings → API →
Webhooks), and it refuses any URL containing "shiprocket", "kartrocket", "sr" or "kr". Emplio's shared route
(`/webhooks/app/shiprocket/<connection>`) contains "shiprocket", and random connection ids can contain "sr"/"kr". A
webhook would need a route alias without those letters first; until then polling works with no setup.

## Actions by group (* asks first)

**orders** (18): list_orders, get_order, create_order*, create_channel_order*, update_order*, update_pickup_location*, update_delivery_address*, cancel_orders*, add_order_inventory*, map_order_products*, import_orders*, export_orders*, list_return_orders, create_return_order*, update_return_order*, create_exchange_order*, create_international_order*, update_international_order*

**shipping** (30): list_couriers, check_serviceability, assign_awb*, request_pickup*, list_blocked_pincodes, update_blocked_pincodes*, list_shipments, get_shipment, cancel_shipments*, generate_label*, generate_manifest*, print_manifest, print_invoice, generate_label_and_invoice*, ship_order*, ship_return*, track_awb, track_awbs, track_shipment, track_order, track_international_orders, list_ndr, get_ndr, act_on_ndr*, list_pickup_locations, add_pickup_location*, check_international_serviceability, assign_international_awb*, generate_international_manifest*, ship_international_order*

**catalog** (25): list_products, get_product, add_product*, convert_to_qc_product*, import_products*, get_product_import_sample, list_listings, map_listing*, import_listing_mappings*, export_mapped_listings, export_unmapped_listings, get_listing_import_sample, list_channels, create_channel*, list_inventory, update_inventory*, list_countries, list_country_zones, get_postcode_details, get_wallet_balance, get_statement, get_discrepancies, get_import_result, submit_international_kyc*, add_bank_details*
