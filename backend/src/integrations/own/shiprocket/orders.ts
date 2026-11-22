// Orders: forward orders (custom and per channel), updates, cancelling, inventory and SKU mapping on an order,
// bulk CSV import and export, returns and exchanges, and international orders.
import { z } from "zod";
import type { OwnAction } from "../index";
import { dates, orderFields, orderId, orderIds, orderItems, page, r, returnFields, upload } from "./client";

const intl = {
  currency: z.string().describe("Order currency: INR, USD, GBP, EUR, AUD, CAD, SAR, AED or SGD"),
  purpose_of_shipment: z.number().int().optional().describe("0 gift, 1 sample, 2 commercial"),
  reasonOfExport: z.number().int().optional().describe("0 bonafide sample, 1 sample, 2 gift, 3 commercial"),
  igstPaymentStatus: z.string().optional().describe("A not applicable, B under LUT/bond, C IGST paid"),
  Terms_Of_Invoice: z.string().optional().describe("FOB or CIF"),
  commodity: z.boolean().optional().describe("Whether the goods are a commodity"),
  ioss: z.string().optional().describe("IOSS number, for EU deliveries"),
  eori: z.string().optional().describe("EORI number, for EU/UK deliveries"),
};

export const orderActions: Record<string, OwnAction> = {
  list_orders: r(
    "GET",
    "/orders",
    "List orders, newest first unless sorted otherwise, with their products and shipments (status, AWB, courier). Filter by date, status, payment method, channel, pickup location, or search an AWB or your own order number.",
    {
      ...page,
      sort: z.enum(["ASC", "DESC"]).optional().describe("Oldest (ASC) or newest (DESC) first"),
      sort_by: z.enum(["id", "status"]).optional().describe("Sort by id or status"),
      ...dates,
      updated_from: z.string().optional().describe("Orders changed on or after this date, YYYY-MM-DD (within the last 30 days; needs updated_to)"),
      updated_to: z.string().optional().describe("Orders changed up to this date, YYYY-MM-DD (at most 30 days after updated_from)"),
      filter_by: z.enum(["status", "payment_method", "delivery_country", "channel_order_id"]).optional().describe("Field to filter on, with filter"),
      filter: z.string().optional().describe("Value for filter_by, e.g. NEW, DELIVERED, COD"),
      search: z.string().optional().describe("An AWB or your own order number"),
      pickup_location: z.string().optional().describe("Only orders from this pickup location"),
      channel_id: z.number().int().optional().describe("Only orders from this channel (shiprocket.list_channels)"),
      fbs: z.number().int().optional().describe("1: only Shiprocket Fulfillment orders"),
      fbs_all_orders: z.number().int().optional().describe("1: Shiprocket Fulfillment and regular orders together"),
    },
  ),
  get_order: r("GET", "/orders/show/{order_id}", "One order in full: customer, address, products, shipments, AWB, charges and its history.", { order_id: orderId }),
  create_order: r(
    "POST",
    "/orders/create/adhoc",
    "Create a shipping order in Shiprocket for a sale (a quick order, products not taken from the catalog). Answers order_id and shipment_id; next, shiprocket.check_serviceability for a courier and shiprocket.assign_awb.",
    orderFields,
    { loose: true },
  ),
  create_channel_order: r(
    "POST",
    "/orders/create",
    "Create an order under one sales channel that has inventory sync on (the products come from its catalog). Same fields as shiprocket.create_order plus channel_id.",
    { ...orderFields, channel_id: z.number().int().describe("The channel (shiprocket.list_channels)"), pickup_location: orderFields.pickup_location.optional() },
    { loose: true },
  ),
  update_order: r(
    "POST",
    "/orders/update/adhoc",
    "Change an order before it's ready to ship (before an AWB): products, quantities, tax and discounts, or make it a documents order (is_document 1). Send the whole order, as for shiprocket.create_order, with the same order_id.",
    orderFields,
    { loose: true },
  ),
  update_pickup_location: r("PATCH", "/orders/address/pickup", "Move orders to another of your pickup locations (one already in Shiprocket).", {
    order_id: orderIds,
    pickup_location: z.string().describe("Name of the pickup location (shiprocket.list_pickup_locations)"),
  }),
  update_delivery_address: r("POST", "/orders/address/update", "Change the customer's name and delivery address on an order.", {
    order_id: orderId,
    shipping_customer_name: z.string().describe("Customer's name"),
    shipping_phone: z.union([z.number(), z.string()]).describe("Customer's phone"),
    shipping_address: z.string().describe("Address line 1"),
    shipping_address_2: z.string().optional().describe("Address line 2"),
    shipping_city: z.string().describe("City"),
    shipping_state: z.string().describe("State"),
    shipping_country: z.string().describe("Country"),
    shipping_pincode: z.union([z.number(), z.string()]).describe("Pincode"),
    shipping_email: z.string().optional().describe("Customer's email"),
    billing_alternate_phone: z.string().optional().describe("Customer's other phone"),
  }),
  cancel_orders: r("POST", "/orders/cancel", "Cancel orders (one or many). Shipped orders can't be cancelled this way; cancel the shipment by AWB instead.", { ids: orderIds }),
  add_order_inventory: r(
    "PATCH",
    "/orders/fulfill",
    "Add stock for products on orders that are out of stock or short (needs inventory sync on).",
    {
      data: z
        .array(
          z.object({
            order_id: z.number().int().describe("Shiprocket order id"),
            order_product_id: z.number().int().describe("The product's id on that order (products[].id in shiprocket.get_order)"),
            quantity: z.union([z.number(), z.string()]).describe("How many to add"),
            action: z.literal("add").default("add").describe("Always add"),
          }),
        )
        .min(1)
        .describe("[{order_id, order_product_id, quantity, action: 'add'}]"),
    },
  ),
  map_order_products: r(
    "PATCH",
    "/orders/mapping",
    "Link products on orders that aren't matched to your catalog to a catalog SKU (needs inventory sync on).",
    {
      data: z
        .array(
          z.object({
            order_id: z.number().int().describe("Shiprocket order id"),
            order_product_id: z.number().int().describe("The product's id on that order (products[].id in shiprocket.get_order)"),
            master_sku: z.string().describe("The catalog SKU to link it to (shiprocket.list_products)"),
          }),
        )
        .min(1)
        .describe("[{order_id, order_product_id, master_sku}]"),
    },
  ),
  import_orders: upload("/orders/import", "Import many orders at once from a CSV file (Shiprocket's bulk order format). Answers an import id; shiprocket.get_import_result shows rows that failed."),
  export_orders: r("POST", "/orders/export", "Make a CSV of all orders; Shiprocket emails the download link to the API user's email."),

  // returns and exchanges
  list_return_orders: r("GET", "/orders/processing/return", "List return orders with their status, products and pickup details.", { ...page, ...dates }),
  create_return_order: r(
    "POST",
    "/orders/create/return",
    "Create a return order: picked up from the customer and shipped back to your warehouse. Items may ask for a quality check at pickup (qc_enable with qc_product_name and qc_product_image). Then shiprocket.assign_awb with is_return 1.",
    { ...returnFields, order_items: orderItems.describe("[{name, sku, units, selling_price, discount?, hsn?, return_reason?, qc_enable?, qc_product_name?, qc_product_image?, qc_brand?, qc_color?, qc_size?, qc_serial_no?, qc_ean_barcode?, qc_product_imei?, qc_used_check?, qc_sealtag_check?, qc_brand_tag?, qc_check_damaged_product?}]") },
    { loose: true },
  ),
  update_return_order: r(
    "POST",
    "/orders/edit",
    "Change a return order: its package size and weight (action product_details) or the warehouse it returns to (action warehouse_address).",
    {
      order_id: z.string().describe("The return order's id"),
      action: z.array(z.enum(["product_details", "warehouse_address"])).min(1).describe("What to change"),
      length: z.number().optional().describe("Length in cm (product_details)"),
      breadth: z.number().optional().describe("Breadth in cm (product_details)"),
      height: z.number().optional().describe("Height in cm (product_details)"),
      weight: z.number().optional().describe("Weight in kg (product_details)"),
      return_warehouse_id: z.number().int().optional().describe("Pickup location id to return to (warehouse_address; shiprocket.list_pickup_locations)"),
    },
  ),
  create_exchange_order: r(
    "POST",
    "/orders/create/exchange",
    "Create an exchange: the customer's item is picked up and a replacement is sent (wrong size, wrong or damaged product).",
    {
      exchange_order_id: z.string().describe("Your id for the exchange (forward) order"),
      return_order_id: z.string().describe("Your id for the return leg"),
      seller_pickup_location_id: z.string().describe("Pickup location id the replacement ships from"),
      seller_shipping_location_id: z.string().describe("Pickup location id the returned item goes to"),
      order_date: z.string().describe("Date, YYYY-MM-DD"),
      payment_method: z.string().describe("prepaid"),
      ...Object.fromEntries(
        ["pickup", "shipping"].flatMap((leg) => {
          const who = leg === "pickup" ? "Customer to pick up from" : "Customer to deliver the replacement to";
          return [
            [`buyer_${leg}_first_name`, z.string().describe(`${who}: first name`)],
            [`buyer_${leg}_last_name`, z.string().optional().describe(`${who}: last name`)],
            [`buyer_${leg}_email`, z.string().optional().describe(`${who}: email`)],
            [`buyer_${leg}_address`, z.string().describe(`${who}: address line 1`)],
            [`buyer_${leg}_address_2`, z.string().optional().describe(`${who}: address line 2`)],
            [`buyer_${leg}_city`, z.string().describe(`${who}: city`)],
            [`buyer_${leg}_state`, z.string().describe(`${who}: state`)],
            [`buyer_${leg}_country`, z.string().describe(`${who}: country`)],
            [`buyer_${leg}_pincode`, z.string().describe(`${who}: pincode`)],
            [`buyer_${leg}_phone`, z.string().describe(`${who}: 10-digit phone`)],
          ];
        }),
      ),
      order_items: orderItems.describe("[{name, sku, units, selling_price, hsn, exchange_item_name, exchange_item_sku, exchange_item_id?, tax?, discount?, qc_enable?, qc_product_name?, qc_product_image?, qc_brand?, qc_color?, qc_size?…}]"),
      sub_total: z.number().describe("Value in rupees"),
      shipping_charges: z.number().optional().describe("Shipping charges, rupees"),
      giftwrap_charges: z.number().optional().describe("Gift wrap charges, rupees"),
      total_discount: z.number().optional().describe("Discount, rupees"),
      transaction_charges: z.number().optional().describe("Transaction charges, rupees"),
      return_length: z.number().describe("Returned package length, cm"),
      return_breadth: z.number().describe("Returned package breadth, cm"),
      return_height: z.number().describe("Returned package height, cm"),
      return_weight: z.number().describe("Returned package weight, kg"),
      exchange_length: z.number().describe("Replacement package length, cm"),
      exchange_breadth: z.number().describe("Replacement package breadth, cm"),
      exchange_height: z.number().describe("Replacement package height, cm"),
      exchange_weight: z.number().describe("Replacement package weight, kg"),
      return_reason: z.string().describe("Shiprocket's return reason code, e.g. 29"),
    },
    { loose: true },
  ),

  // international
  create_international_order: r(
    "POST",
    "/international/orders/create/adhoc",
    "Create an order shipping abroad (cross-border). Same fields as shiprocket.create_order plus currency and export details; needs international KYC done.",
    { ...orderFields, ...intl },
    { loose: true },
  ),
  update_international_order: r(
    "POST",
    "/international/orders/update/adhoc",
    "Change an international order before it's ready to ship. Send the whole order with the same order_id.",
    { ...orderFields, ...intl },
    { loose: true },
  ),
};
