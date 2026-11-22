// Shipping: couriers and rates, AWBs, pickups, shipments, labels/manifests/invoices, ship-in-one-go, tracking,
// failed deliveries (NDR), pickup locations, blocked pincodes, and international shipping.
import { z } from "zod";
import type { OwnAction } from "../index";
import { awb, dates, orderFields, orderIds, page, r, returnFields, serviceabilityApi, shipmentId, shipmentIds, sorting } from "./client";

const serviceability = {
  pickup_postcode: z.union([z.number(), z.string()]).describe("Pincode it's picked up from"),
  delivery_postcode: z.union([z.number(), z.string()]).describe("Pincode it's delivered to"),
  order_id: z.number().int().optional().describe("A Shiprocket order id; then cod and weight come from the order"),
  cod: z.number().int().optional().describe("1 cash on delivery, 0 prepaid (needed without order_id)"),
  weight: z.union([z.number(), z.string()]).optional().describe("Weight in kg (needed without order_id)"),
  length: z.number().optional().describe("Length in cm"),
  breadth: z.number().optional().describe("Breadth in cm"),
  height: z.number().optional().describe("Height in cm"),
  declared_value: z.number().optional().describe("Value of the goods in rupees (needed for returns)"),
  mode: z.enum(["Surface", "Air"]).optional().describe("Surface or Air"),
  is_return: z.number().int().optional().describe("1 for a return pickup"),
  couriers_type: z.number().int().optional().describe("1: only couriers for documents"),
  only_local: z.number().int().optional().describe("1: only hyperlocal (same-city) couriers"),
  qc_check: z.number().int().optional().describe("1: only couriers that check quality at return pickup (with is_return 1)"),
};
const vendor = z
  .object({
    email: z.string(),
    phone: z.union([z.number(), z.string()]),
    name: z.string(),
    address: z.string(),
    address_2: z.string().optional(),
    city: z.string(),
    state: z.string(),
    country: z.string(),
    pin_code: z.union([z.number(), z.string()]),
    pickup_location: z.string(),
  })
  .loose()
  .optional()
  .describe("A new pickup location to add and use: {name, email, phone, address, address_2?, city, state, country, pin_code, pickup_location (same as pickup_location above)}");
const oneGo = {
  mode: z.enum(["Surface", "Air"]).optional().describe("Surface or Air"),
  courier_id: z.number().int().optional().describe("Courier to use (from shiprocket.check_serviceability); Shiprocket picks when left out"),
  request_pickup: z.boolean().optional().describe("Book the pickup too (default true)"),
  print_label: z.boolean().optional().describe("Make the label too (default true)"),
  generate_manifest: z.boolean().optional().describe("Make the manifest too (default true)"),
};

export const shippingActions: Record<string, OwnAction> = {
  // couriers and rates
  list_couriers: r("GET", "/courier/courierListWithCounts", "Couriers on the account and how many there are.", {
    type: z.enum(["active", "inactive", "all"]).optional().describe("Which couriers (default all)"),
  }),
  check_serviceability: r(
    "GET",
    "/courier/serviceability/",
    "Which couriers deliver between two pincodes, with rates, delivery days and ratings: use it to compare shipping prices or pick a courier_id. Give order_id, or cod and weight.",
    serviceability,
  ),
  assign_awb: r(
    "POST",
    "/courier/assign/awb",
    "Book a courier for a shipment and get its AWB (tracking number); this charges the Shiprocket wallet. status 'reassign' switches courier (once a day); is_return 1 for a return.",
    {
      shipment_id: shipmentId,
      courier_id: z.number().int().optional().describe("Courier (from shiprocket.check_serviceability); the recommended one when left out"),
      status: z.literal("reassign").optional().describe("'reassign' to change the courier of a shipment that has one"),
      is_return: z.number().int().optional().describe("1 for a return shipment"),
    },
  ),
  request_pickup: r(
    "POST",
    "/courier/generate/pickup",
    "Ask the courier to collect a shipment that has an AWB. Answers the pickup date; then shiprocket.generate_manifest.",
    {
      shipment_id: shipmentIds.describe("The shipment id, in a list: [123] (one at a time)"),
      status: z.literal("retry").optional().describe("'retry' when an earlier pickup request failed"),
      pickup_date: z.array(z.string()).optional().describe('Pickup on a later day: ["YYYY-MM-DD"]'),
    },
  ),
  list_blocked_pincodes: r(
    "GET",
    "/block-pincodes/get",
    "Pincodes you've blocked deliveries to: a page of them, a prefix search, or a CSV link of all (is_download 1).",
    {
      search: z.string().optional().describe("Pincodes starting with this (4+ digits)"),
      is_download: z.number().int().optional().describe("1: a link to a CSV of all of them"),
      per_page: z.number().int().min(1).max(15).optional().describe("How many per page (at most 15)"),
      current_page: z.number().int().min(1).optional().describe("Page number, from 1"),
    },
    { api: serviceabilityApi },
  ),
  update_blocked_pincodes: r(
    "POST",
    "/blocked-pincodes/upload",
    "Block or unblock deliveries to pincodes.",
    {
      action: z.enum(["block", "unblock"]).describe("block or unblock"),
      postcode: z.object({ delivery_blocked: z.array(z.string()).min(1) }).describe('{"delivery_blocked": ["110001", "560034"]}'),
    },
    { api: serviceabilityApi },
  ),

  // shipments
  list_shipments: r("GET", "/shipments", "List shipments with their status, courier and AWB.", { ...page, ...sorting("id") }),
  get_shipment: r("GET", "/shipments/{shipment_id}", "One shipment's details.", { shipment_id: shipmentId }),
  cancel_shipments: r("POST", "/orders/cancel/shipment/awbs", "Cancel shipments by AWB before they're out for pickup (up to 2000).", {
    awbs: z.array(z.string()).min(1).describe("AWBs to cancel"),
  }),

  // labels, manifests, invoices
  generate_label: r("POST", "/courier/generate/label", "Make shipping labels for shipments that have an AWB. Answers a PDF link to print.", { shipment_id: shipmentIds }),
  generate_manifest: r("POST", "/manifests/generate", "Make the manifest (handover sheet for the courier) for shipments with a pickup booked. Answers a PDF link.", { shipment_id: shipmentIds }),
  print_manifest: r("POST", "/manifests/print", "Link to the manifest already made for orders.", { order_ids: orderIds }, { readOnly: true }),
  print_invoice: r("POST", "/orders/print/invoice", "Link to the invoice PDF for orders.", { ids: orderIds }, { readOnly: true }),
  generate_label_and_invoice: r(
    "POST",
    "/courier/generate/label-invoice",
    "One PDF with each shipment's label followed by its invoice (up to 200). Check success_count and error_count in the answer.",
    { shipment_ids: shipmentIds },
  ),

  // in one go
  ship_order: r(
    "POST",
    "/shipments/create/forward-shipment",
    "Create an order and ship it in one step: order, AWB, pickup, label and manifest. Same fields as shiprocket.create_order, plus courier and what to skip. Charges the Shiprocket wallet.",
    { ...orderFields, ...oneGo, vendor_details: vendor, isd_code: z.string().optional().describe("Phone country code, e.g. 91") },
    { loose: true },
  ),
  ship_return: r(
    "POST",
    "/shipments/create/return-shipment",
    "Create a return and book its pickup in one step (order, AWB and pickup). Same fields as shiprocket.create_return_order. Charges the Shiprocket wallet.",
    returnFields,
    { loose: true },
  ),

  // tracking
  track_awb: r("GET", "/courier/track/awb/{awb_code}", "Where a shipment is, by AWB: current status, expected delivery and every scan.", { awb_code: awb }),
  track_awbs: r("POST", "/courier/track/awbs", "Track up to 50 shipments at once by AWB.", { awbs: z.array(z.string()).min(1).max(50).describe("AWBs") }, { readOnly: true }),
  track_shipment: r("GET", "/courier/track/shipment/{shipment_id}", "Where a shipment is, by shipment id.", { shipment_id: shipmentId }),
  track_order: r("GET", "/courier/track", "Where an order's shipment is, by your own order number (the store's).", {
    order_id: z.string().describe("Your order number, as in your store"),
    channel_id: z.number().int().optional().describe("The channel, when the same number is in more than one"),
  }),
  track_international_orders: r("GET", "/international/orders/track", "Tracking for international orders."),

  // failed deliveries (NDR)
  list_ndr: r("GET", "/ndr/all", "Shipments whose delivery failed (NDR): reason, attempts, customer and courier.", {
    ...page,
    ...dates,
    search: z.string().optional().describe("An AWB"),
  }),
  get_ndr: r("GET", "/ndr/{awb}", "One failed delivery's details and attempt history, by AWB.", { awb }),
  act_on_ndr: r(
    "POST",
    "/ndr/{awb}/action",
    "Decide what happens to a failed delivery: try again (re-attempt), report the courier's attempt as fake (fake-attempt, with proof), or send it back to you (return, i.e. RTO).",
    {
      awb,
      action: z.enum(["re-attempt", "fake-attempt", "return"]).describe("What to do"),
      comments: z.string().describe("Why, e.g. what the customer said"),
      phone: z.string().optional().describe("New phone number for the courier (re-attempt, fake-attempt)"),
      address1: z.string().optional().describe("New address line 1 (re-attempt, fake-attempt)"),
      address2: z.string().optional().describe("New address line 2"),
      deferred_date: z.string().optional().describe("Preferred delivery date, YYYY-MM-DD"),
      proof_audio: z.string().optional().describe("Link to an audio recording (fake-attempt)"),
      proof_image: z.string().optional().describe("Link to an image (fake-attempt)"),
      remarks: z.string().optional().describe("Remarks (fake-attempt)"),
    },
  ),

  // pickup locations
  list_pickup_locations: r("GET", "/settings/company/pickup", "Your pickup locations (warehouses) with their names, addresses and ids."),
  add_pickup_location: r("POST", "/settings/company/addpickup", "Add a pickup location (warehouse or vendor address). New ones may need a phone check in Shiprocket before use.", {
    pickup_location: z.string().max(36).describe("A short name for it, used on orders"),
    name: z.string().describe("Contact person"),
    email: z.string().describe("Contact email"),
    phone: z.union([z.number(), z.string()]).describe("Contact phone"),
    address: z.string().max(80).describe("Address line 1 (with house or building number)"),
    address_2: z.string().optional().describe("Address line 2"),
    city: z.string().describe("City"),
    state: z.string().describe("State"),
    country: z.string().describe("Country"),
    pin_code: z.union([z.number(), z.string()]).describe("Pincode"),
    lat: z.number().optional().describe("Latitude"),
    long: z.number().optional().describe("Longitude"),
    address_type: z.literal("vendor").optional().describe("'vendor' when it's another vendor's address"),
    vendor_name: z.string().optional().describe("The vendor's name (address_type vendor)"),
    gstin: z.string().optional().describe("The vendor's GSTIN"),
  }),

  // international
  check_international_serviceability: r("GET", "/international/courier/serviceability", "Couriers and rates for shipping abroad.", {
    delivery_country: z.string().length(2).describe("Destination country, 2-letter code, e.g. US"),
    weight: z.number().describe("Weight in kg"),
    cod: z.literal(0).default(0).describe("Always 0: no cash on delivery abroad"),
    order_id: z.number().int().optional().describe("A Shiprocket order id"),
    pickup_postcode: z.union([z.number(), z.string()]).optional().describe("Another pickup pincode than your main one"),
  }),
  assign_international_awb: r("POST", "/international/courier/assign/awb", "Book a courier for an international shipment and get its AWB; charges the wallet.", {
    shipment_id: shipmentId,
    courier_id: z.number().int().optional().describe("Courier (shiprocket.check_international_serviceability)"),
    status: z.literal("reassign").optional().describe("'reassign' to change courier (once a day)"),
  }),
  generate_international_manifest: r("POST", "/international/manifests/generate", "Make the manifest for an international shipment.", {
    shipment_id: shipmentId,
    status: z.literal("retry").optional().describe("'retry' after a failure"),
  }),
  ship_international_order: r(
    "POST",
    "/international/shipments/create/forward-shipment",
    "Create an international order and ship it in one step (order, AWB, pickup, label, manifest). Fields as shiprocket.create_international_order.",
    { ...orderFields, ...oneGo, currency: z.string().optional().describe("Order currency, e.g. USD"), vendor_details: vendor },
    { loose: true },
  ),
};
