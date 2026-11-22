// Talking to Shiprocket. There is no lasting key: the owner's API user (email and password, pasted as
// "email:password") logs in at /auth/login for a Bearer token that lasts about 10 days. Tokens are kept in memory
// per connection, under a hash of the key, and fetched again when missing, 9 days old, or turned down (401).
import { createHash } from "node:crypto";
import { z } from "zod";
import { AppFile, AppsError } from "../../types";
import type { OwnAction } from "../index";
import { type Api, call, rest } from "../openapi";

export const BASE = "https://apiv2.shiprocket.in/v1/external";
const HELP = "Shiprocket → Settings → API → Configure → Create an API user; paste its email and password as email:password";

// Shiprocket says how a call went wrong in the body of some 200s too
const failed = (b: any) => {
  if (b?.awb_assign_status === 0) return b?.response?.data?.awb_assign_error ?? b?.message ?? "the AWB wasn't assigned";
  if (typeof b?.status_code === "number" && b.status_code >= 400) return b.message ?? `error ${b.status_code}`;
};
const shared = { name: "Shiprocket", tokenHelp: HELP, failed };
export const api: Api = { ...shared, base: BASE };
// blocked pincodes live on a host of their own
export const serviceabilityApi: Api = { ...shared, base: "https://serviceability.shiprocket.in/v1/external" };

// ponytail: in-memory per process; each server logs in once per ~9 days per connection, which Shiprocket allows
const TOKEN_MS = 9 * 86_400_000;
const tokens = new Map<string, { token: Promise<string>; at: number }>();
const hash = (key: string) => createHash("sha256").update(key).digest("hex");

export function credentials(key: string) {
  const at = key.indexOf(":");
  const email = key.slice(0, at).trim();
  const password = key.slice(at + 1);
  if (at < 1 || !email.includes("@") || !password) throw new AppsError("enter the API user's email and password");
  return { email, password };
}

// The login and who it is; wrong email or password marks the connection for reconnecting
export async function login(key: string): Promise<{ token: string; name: string }> {
  const res = await fetch(`${BASE}/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(credentials(key)) });
  const body = (await res.json().catch(() => ({}))) as any;
  if (res.ok && body?.token) return { token: body.token, name: [body.first_name, body.last_name].filter(Boolean).join(" ") || body.email || "" };
  const why = body?.message ?? res.statusText;
  if (res.status === 400 || res.status === 401 || res.status === 403)
    throw new AppsError(`Shiprocket turned down that email and password; check the API user (${HELP}) and reconnect`, true, `${why} (${res.status})`);
  throw new AppsError(`Shiprocket: ${why} (${res.status})`);
}

export function token(key: string, fresh = false): Promise<string> {
  const id = hash(key);
  const had = tokens.get(id);
  if (had && !fresh && Date.now() - had.at < TOKEN_MS) return had.token;
  const t = login(key).then((l) => l.token);
  tokens.set(id, { token: t, at: Date.now() });
  // a failed login isn't kept, so the next call tries again
  t.catch(() => tokens.get(id)?.token === t && tokens.delete(id));
  return t;
}

// for tests
export const forgetTokens = () => tokens.clear();

// Runs an action with a token instead of the pasted key; a token Shiprocket turns down is replaced once
export const loggedIn = (a: OwnAction): OwnAction => ({
  ...a,
  get input() {
    return a.input;
  },
  run: async (i, key) => {
    try {
      return await a.run(i, await token(key));
    } catch (e) {
      if (!(e instanceof AppsError && e.expired)) throw e;
      return a.run(i, await token(key, true));
    }
  },
});

type Opts = { readOnly?: boolean; query?: string[]; loose?: boolean; api?: Api };

// A Shiprocket call: {names} in the path come from the input; the rest is the query (GET/DELETE) or the JSON body.
// `loose` lets the rarer fields Shiprocket takes through untouched.
export const r = (method: string, path: string, description: string, shape: z.ZodRawShape = {}, opts: Opts = {}): OwnAction =>
  loggedIn(rest(opts.api ?? api, method, path, description, opts.loose ? z.object(shape).loose() : z.object(shape), opts));

// A CSV upload (orders, products, catalog mappings): multipart with the file as "file"
export const upload = (path: string, description: string): OwnAction =>
  loggedIn({
    description,
    input: z.object({ file: z.any().describe('The .csv file from the computer: {"file": "/work/orders.csv"}. Use the matching sample action for the columns') }),
    run: (i: { file: unknown }, key: string) => {
      if (!(i.file instanceof AppFile)) throw new AppsError('file: give the CSV as {"file": "/work/..."}');
      return call(api, key, { method: "POST", path, query: [], headers: [], body: { kind: "form", fields: [["file", "file"]] } }, i);
    },
  });

// ── shared fields
export const orderId = z.number().int().describe("Shiprocket's order id (the id in shiprocket.list_orders, not your own order number)");
export const orderIds = z.array(z.number().int()).min(1).describe("Shiprocket order ids (from shiprocket.list_orders)");
export const shipmentId = z.number().int().describe("The shipment id (shipments[].id in shiprocket.get_order, or shipment_id when the order was created)");
export const shipmentIds = z.array(z.number().int()).min(1).describe("Shipment ids (from shiprocket.get_order or shiprocket.list_shipments)");
export const awb = z.string().min(1).describe("The AWB (tracking number) the courier gave the shipment");
export const page = {
  page: z.number().int().min(1).optional().describe("Page number, from 1"),
  per_page: z.number().int().min(1).optional().describe("How many per page"),
};
export const dates = {
  from: z.string().optional().describe("From this date, YYYY-MM-DD"),
  to: z.string().optional().describe("Up to this date, YYYY-MM-DD"),
};
export const sorting = (fields: string) => ({
  sort: z.enum(["ASC", "DESC"]).optional().describe("Oldest first (ASC) or newest first (DESC)"),
  sort_by: z.string().optional().describe(`Field to sort by: ${fields}`),
  filter_by: z.string().optional().describe("Field to filter on (with filter), e.g. id or sku"),
  filter: z.string().optional().describe("The value filter_by must have"),
});
const n = (what: string) => z.union([z.number(), z.string()]).describe(what);
const item = z
  .object({
    name: z.string().describe("Product name"),
    sku: z.string().describe("The product's SKU"),
    units: z.number().describe("How many units"),
    selling_price: n("Price per unit in rupees, GST included"),
    discount: n("Discount in rupees, tax included").optional(),
    tax: n("Tax rate in percent").optional(),
    hsn: n("HSN code for GST").optional(),
  })
  .loose();
export const orderItems = z
  .array(item)
  .min(1)
  .describe("The products: [{name, sku, units, selling_price, discount?, tax?, hsn?}]; returns also take qc_enable, qc_product_name, qc_product_image, qc_brand, qc_color, qc_size…");
export const parcel = {
  length: z.number().describe("Package length in cm (over 0.5)"),
  breadth: z.number().describe("Package breadth in cm (over 0.5)"),
  height: z.number().describe("Package height in cm (over 0.5)"),
  weight: z.number().describe("Package weight in kg (over 0)"),
};
const address = (who: string, prefix: string, required: boolean) => {
  const f = (s: z.ZodType) => (required ? s : s.optional());
  return {
    [`${prefix}_customer_name`]: f(z.string().describe(`${who}: first name`)),
    [`${prefix}_last_name`]: z.string().optional().describe(`${who}: last name`),
    [`${prefix}_address`]: f(z.string().describe(`${who}: address line 1`)),
    [`${prefix}_address_2`]: z.string().optional().describe(`${who}: address line 2`),
    [`${prefix}_city`]: f(z.string().describe(`${who}: city`)),
    [`${prefix}_pincode`]: f(n(`${who}: pincode`)),
    [`${prefix}_state`]: f(z.string().describe(`${who}: state`)),
    [`${prefix}_country`]: f(z.string().describe(`${who}: country, e.g. India`)),
    [`${prefix}_email`]: z.string().optional().describe(`${who}: email`),
    [`${prefix}_phone`]: f(n(`${who}: phone number`)),
  };
};
// A forward order, as the custom order, update and ship-in-one-go calls take it
export const orderFields = {
  order_id: z.string().min(1).describe("Your own order number, unique (max 50 characters)"),
  order_date: z.string().describe("Order date, YYYY-MM-DD or YYYY-MM-DD HH:MM"),
  pickup_location: z.string().describe("Name of a pickup location already in Shiprocket (shiprocket.list_pickup_locations)"),
  channel_id: n("Sales channel to put it under (shiprocket.list_channels); the Custom channel when left out").optional(),
  comment: z.string().optional().describe("Note; 'Reseller: <name>' prints that name as the sender"),
  reseller_name: z.string().optional().describe("Sender name to print on the label"),
  company_name: z.string().optional().describe("Customer's company"),
  ...address("Customer billed", "billing", true),
  billing_alternate_phone: n("Customer's other phone number").optional(),
  billing_isd_code: z.string().optional().describe("Phone country code, e.g. +91"),
  shipping_is_billing: z.boolean().describe("true when it ships to the billing address; false needs the shipping_* fields"),
  ...address("Ship to (when not the billing address)", "shipping", false),
  order_items: orderItems,
  payment_method: z.string().describe("COD (cash on delivery) or Prepaid"),
  shipping_charges: n("Shipping charged to the customer, rupees").optional(),
  giftwrap_charges: n("Gift wrap charges, rupees").optional(),
  transaction_charges: n("Transaction charges, rupees").optional(),
  total_discount: n("Discount on the whole order, rupees").optional(),
  sub_total: n("Order total in rupees after discounts"),
  ...parcel,
  ewaybill_no: z.string().optional().describe("E-way bill number (needed above ₹50,000)"),
  customer_gstin: z.string().optional().describe("Customer's GSTIN"),
  invoice_number: z.string().optional().describe("Your invoice number"),
  order_type: z.string().optional().describe("ESSENTIALS or NON ESSENTIALS"),
  is_insurance_opt: z.boolean().optional().describe("Insure the shipment (orders above ₹2,500)"),
  is_document: z.number().int().optional().describe("1 for a documents-only shipment"),
  order_tag: z.string().optional().describe("Tags for the order, comma separated"),
};
const returnPickup = (who: string) => ({
  pickup_customer_name: z.string().describe(`${who}: first name`),
  pickup_last_name: z.string().optional().describe(`${who}: last name`),
  pickup_address: z.string().describe(`${who}: address line 1`),
  pickup_address_2: z.string().optional().describe(`${who}: address line 2`),
  pickup_city: z.string().describe(`${who}: city`),
  pickup_state: z.string().describe(`${who}: state`),
  pickup_country: z.string().describe(`${who}: country`),
  pickup_pincode: n(`${who}: pincode`),
  pickup_email: z.string().describe(`${who}: email`),
  pickup_phone: n(`${who}: phone`),
  pickup_isd_code: z.string().optional().describe("Phone country code, e.g. 91"),
});
// A return: picked up from the customer, shipped back to you
export const returnFields = {
  order_id: z.string().min(1).describe("Your number for the return order, unique"),
  order_date: z.string().describe("Date, YYYY-MM-DD"),
  channel_id: n("Sales channel (shiprocket.list_channels); Custom when left out").optional(),
  company_name: z.string().optional().describe("Customer's company"),
  ...returnPickup("Customer it's picked up from"),
  ...address("Your warehouse it goes back to", "shipping", true),
  shipping_isd_code: z.string().optional().describe("Phone country code, e.g. 91"),
  order_items: orderItems,
  payment_method: z.string().describe("Prepaid (returns are always prepaid)"),
  total_discount: n("Discount, rupees").optional(),
  sub_total: n("Value in rupees"),
  ...parcel,
};
