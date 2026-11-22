// The catalog and the account: products, channel listings and their mapping, sales channels, inventory,
// countries and pincodes, wallet, statement, weight disputes, file import results, international KYC and bank.
import { z } from "zod";
import type { OwnAction } from "../index";
import { dates, page, r, sorting, upload } from "./client";

const productId = z.number().int().describe("The product's id (shiprocket.list_products)");
const qc = {
  product_image: z.string().optional().describe("Product photo link the pickup agent compares with (needed for quality-checked returns)"),
  brand: z.string().optional().describe("Brand name visible on the item"),
  brand_tag: z.string().optional().describe("Brand on the item's tag"),
  color: z.string().optional().describe("Colour"),
  size: z.string().optional().describe("Size, as on the label"),
  product_imei: z.string().optional().describe("15-digit IMEI, for phones and devices"),
  serial_no: z.string().optional().describe("Serial number"),
};

export const catalogActions: Record<string, OwnAction> = {
  // products
  list_products: r("GET", "/products", "Products in your Shiprocket catalog with SKU, price, size, weight and stock.", { ...page, ...sorting("id, sku, created_at") }),
  get_product: r("GET", "/products/show/{product_id}", "One product's details.", { product_id: productId }),
  add_product: r(
    "POST",
    "/products",
    "Add a product to the catalog (SKU must be new).",
    {
      name: z.string().describe("Product name"),
      sku: z.string().describe("Unique SKU"),
      type: z.enum(["Single", "Multiple"]).describe("Single product or a multi-product bundle"),
      qty: z.number().int().describe("Stock quantity"),
      category_code: z.string().default("default").describe("Category code from Shiprocket (default)"),
      HSN: z.string().optional().describe("HSN code for GST"),
      tax_code: z.string().optional().describe("Tax rate in percent"),
      low_stock: z.string().optional().describe("Warn when stock falls to this"),
      description: z.string().optional().describe("Description"),
      weight: z.number().optional().describe("Weight in kg"),
      length: z.number().optional().describe("Length in cm"),
      width: z.number().optional().describe("Width in cm"),
      height: z.number().optional().describe("Height in cm"),
      ean: z.string().optional().describe("13-digit EAN barcode"),
      upc: z.string().optional().describe("12-digit UPC barcode"),
      isbn: z.string().optional().describe("ISBN, for books"),
      imei_serialnumber: z.string().optional().describe("IMEI or serial number"),
      cost_price: z.number().optional().describe("Your cost, rupees"),
      mrp: z.string().optional().describe("MRP, rupees"),
      image_url: z.string().optional().describe("Product image link"),
      brand: z.string().optional().describe("Brand"),
      color: z.string().optional().describe("Colour"),
      size: z.string().optional().describe("Size"),
      qc_details: z.object(qc).optional().describe("Quality-check details for returns: {product_image, brand, brand_tag, color, size, product_imei, serial_no}"),
    },
    { loose: true },
  ),
  convert_to_qc_product: r(
    "POST",
    "/products/qc-product-update/{product_id}",
    "Turn a product into one whose returns are quality-checked at pickup, with the details the agent checks.",
    { product_id: productId, sku: z.string().describe("The product's SKU"), ...qc, product_image: z.string().describe("Product photo link (required)"), brand_box: z.string().optional().describe("Brand on the box or tag") },
  ),
  import_products: upload("/products/import", "Add many products from a CSV file (columns as in shiprocket.get_product_import_sample). Answers an import id for shiprocket.get_import_result."),
  get_product_import_sample: r("GET", "/products/sample", "The sample CSV for importing products."),

  // channel listings
  list_listings: r("GET", "/listings", "Products as listed on your sales channels (store catalogs), and whether they're linked to your Shiprocket catalog.", {
    ...page,
    ...sorting("id, sku, created_at"),
  }),
  map_listing: r("POST", "/listings/link", "Link a store listing to a product in your Shiprocket catalog.", {
    product_id: z.number().int().describe("The catalog product (shiprocket.list_products)"),
    listing_id: z.number().int().describe("The store listing (shiprocket.list_listings)"),
  }),
  import_listing_mappings: upload("/listings/import", "Link many store listings to catalog products from a CSV (format in shiprocket.get_listing_import_sample)."),
  export_mapped_listings: r("GET", "/listings/export/mapped", "Link to a CSV of store listings linked to catalog products."),
  export_unmapped_listings: r("GET", "/listings/export/unmapped", "Link to a CSV of store listings not linked to any catalog product."),
  get_listing_import_sample: r("GET", "/listings/sample", "The sample CSV for linking listings."),

  // channels and inventory
  list_channels: r("GET", "/channels", "Sales channels connected to Shiprocket (stores, marketplaces, Custom) with their ids."),
  create_channel: r("POST", "/channels", "Add a custom sales channel. Shiprocket must have switched this on for the account first.", {
    name: z.string().max(12).describe("Channel name, unique, up to 12 characters"),
    brand_name: z.string().max(50).optional().describe("Brand printed on invoices and labels"),
  }),
  list_inventory: r("GET", "/inventory", "Stock per product.", { ...page, sort: z.enum(["ASC", "DESC"]).optional().describe("ASC or DESC"), sort_by: z.string().optional().describe("id, sku, created_at") }),
  update_inventory: r("PUT", "/inventory/{product_id}/update", "Change a product's stock: add, remove, or replace the quantity.", {
    product_id: z.number().int().describe("The product's id (shiprocket.list_inventory)"),
    quantity: z.number().int().describe("How many"),
    action: z.enum(["add", "remove", "replace"]).describe("add to, remove from, or replace the stock"),
  }),

  // places
  list_countries: r("GET", "/countries", "Countries Shiprocket ships to, with their ids and codes."),
  list_country_zones: r("GET", "/countries/show/{country_id}", "States and zones of a country.", { country_id: z.number().int().describe("The country's id (shiprocket.list_countries)") }),
  get_postcode_details: r("GET", "/open/postcode/details", "City, state and area of a pincode.", { postcode: z.union([z.number(), z.string()]).describe("The pincode") }),

  // account and billing
  get_wallet_balance: r("GET", "/account/details/wallet-balance", "Money left in the Shiprocket wallet that pays for shipping."),
  get_statement: r("GET", "/account/details/statement", "Wallet statement: recharges and shipping charges.", { ...page, ...dates }),
  get_discrepancies: r("GET", "/billing/discrepancy", "Weight disputes: shipments the courier charged at a different weight than declared."),
  get_import_result: r("GET", "/errors/{import_id}/check", "How a CSV import went (orders, products or listings): rows that failed and why.", {
    import_id: z.number().int().describe("The import id an import action answered"),
  }),
  submit_international_kyc: r(
    "POST",
    "/international/settings/international_kyc",
    "Send the business's KYC documents for international shipping. Answers the KYC status.",
    {
      organization_type: z.string().describe("Kind of business, e.g. Sole Proprietor, company"),
      ip_address: z.string().describe("The seller's IP address"),
      documents: z.array(z.record(z.string(), z.unknown())).describe("The documents as Shiprocket takes them: [{attachment: [{file: <base64 image under 3 MB>}], …}]"),
    },
    { loose: true },
  ),
  add_bank_details: r("POST", "/international/settings/add-bank-details", "Add the bank account international payouts go to.", {
    bank_account_type: z.enum(["saving", "current"]).describe("saving or current"),
    beneficiary_name: z.string().describe("Account holder's name, letters and spaces"),
    bank_ifsc_code: z.string().describe("IFSC code"),
    bank_account_number: z.string().describe("Account number, 9 to 18 digits"),
  }),
};
