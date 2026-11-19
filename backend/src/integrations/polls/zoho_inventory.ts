import { z } from "zod";
import type { PollTrigger, Run } from "./index";
import { accountingPolls } from "./zoho_books";

// Zoho Inventory's webhooks are set up by hand in its workflow rules, with no API to add them, so lists are compared at each check.
// ponytail: newest 200 per list; more than 200 new in one check would miss some
const every = { every: 15, min: 5 };
const output = (name: string, description: string): PollTrigger["output"] => [{ name, type: "object", required: true, description }];
const org = { organization_id: z.string().optional().describe("Which organisation (leave out when the login has just one)") };
const rows = async (run: Run, action: string, key: string, input: object) => {
  const out = (await run(`zoho_inventory.${action}`, { per_page: 200, ...input })) as Record<string, any[]>;
  return out[key] ?? [];
};

// A new record, or (changed) one whose last_modified_time moved. Zoho's order lists can't be sorted by change, so a change to
// an order older than the newest 200 isn't seen. `match` is the trigger's own filters.
const records = (o: { what: string; list: string; key: string; id: string; sort?: string; fields: string; config: z.ZodRawShape; match: (row: any, config: any) => boolean }) => {
  const shape = (extra: z.ZodRawShape) => z.object({ ...org, ...o.config, ...extra });
  const poll = (changed: boolean) => async (config: any, run: Run) => {
    const { organization_id } = config;
    const list = await rows(run, o.list, o.key, { organization_id, ...(o.sort && { sort_column: changed ? "last_modified_time" : o.sort, sort_order: "D" }) });
    return list.filter((r) => o.match(r, config)).map((r) => ({ id: changed ? `${r[o.id]}:${r.last_modified_time}` : String(r[o.id]), item: { [o.what]: r } }));
  };
  const name = o.what.replace(/_/g, " ");
  return {
    [`new_${o.what}`]: { description: `A new ${name} is created.`, config: shape({}), output: output(o.what, `The ${name}: ${o.fields}`), ...every, poll: poll(false) },
    [`${o.what}_changed`]: {
      description: `A ${name} is created or changed, including a change made by another automation.`,
      config: shape({}),
      output: output(o.what, `The ${name}: ${o.fields}, last_modified_time`),
      ...every,
      poll: poll(true),
    },
  } as Record<string, PollTrigger>;
};

const same = (a: unknown, b: unknown) => !b || a === b;

export const zoho_inventory: Record<string, PollTrigger> = {
  ...accountingPolls("zoho_inventory", { payments: "list_customer_payments" }, {}),
  ...records({
    what: "sales_order",
    list: "list_sales_orders",
    key: "salesorders",
    id: "salesorder_id",
    fields: "salesorder_id, salesorder_number, customer_id, customer_name, status, date, shipment_date, total",
    config: { customer_id: z.string().optional().describe("Only this customer's orders"), status: z.string().optional().describe("Only orders with this status, e.g. confirmed or draft") },
    match: (r, c) => same(r.customer_id, c.customer_id) && same(r.status, c.status),
  }),
  ...records({
    what: "purchase_order",
    list: "list_purchase_orders",
    key: "purchaseorders",
    id: "purchaseorder_id",
    fields: "purchaseorder_id, purchaseorder_number, vendor_id, vendor_name, status, date, delivery_date, total",
    config: { vendor_id: z.string().optional().describe("Only this vendor's orders"), status: z.string().optional().describe("Only orders with this status, e.g. issued or received") },
    match: (r, c) => same(r.vendor_id, c.vendor_id) && same(r.status, c.status),
  }),
  ...records({
    what: "item",
    list: "list_items",
    key: "items",
    id: "item_id",
    sort: "created_time",
    fields: "item_id, name, sku, status, rate, purchase_rate, stock_on_hand, available_stock, reorder_level",
    config: {},
    match: () => true,
  }),
  item_low_stock: {
    description: "An item's stock falls to or below its reorder level. Fires when it first goes low, and again each time its stock changes while it stays low.",
    config: z.object({ ...org, warehouse_id: z.string().optional().describe("Only stock in this warehouse or location") }),
    output: output("item", "The item: item_id, name, sku, stock_on_hand, available_stock, reorder_level, vendor_id, vendor_name"),
    ...every,
    async poll({ organization_id, warehouse_id }, run) {
      const items = await rows(run, "list_items", "items", { organization_id, warehouse_id, filter_by: "Status.Lowstock" });
      return items.map((item) => ({ id: `${item.item_id}:${item.stock_on_hand}`, item: { item } }));
    },
  },
  new_purchase_receive: {
    description: "Goods are received against a purchase order.",
    config: z.object({ ...org, vendor_id: z.string().optional().describe("Only this vendor's deliveries") }),
    output: output("purchase_receive", "The receive: purchasereceive_id, purchasereceive_number, receive_date, status, purchaseorder_id, purchaseorder_number, vendor_id, vendor_name"),
    ...every,
    async poll({ organization_id, vendor_id }, run) {
      const list = await rows(run, "list_purchase_receives", "purchasereceives", { organization_id, vendor_id, sort_column: "created_time", sort_order: "D" });
      return list.map((r) => ({ id: String(r.purchasereceive_id), item: { purchase_receive: r } }));
    },
  },
  package_changed: {
    description: "A package is created or its status changes, e.g. shipped or delivered.",
    config: z.object({ ...org, customer_id: z.string().optional().describe("Only this customer's packages"), status: z.string().optional().describe("Only packages with this status, e.g. shipped or delivered") }),
    output: output("package", "The package: package_id, package_number, salesorder_id, salesorder_number, customer_id, customer_name, status, shipment_number, tracking_number"),
    ...every,
    async poll({ organization_id, customer_id, status }, run) {
      const out = (await run("zoho_inventory.list_packages", { organization_id, customer_id, per_page: 200, sort_column: "last_modified_time", sort_order: "D" })) as Record<string, any[]>;
      // the spec calls the list `package`; the API's other lists are plural
      const list = out.packages ?? out.package ?? [];
      return list.filter((p) => same(p.status, status)).map((p) => ({ id: `${p.package_id}:${p.status}`, item: { package: p } }));
    },
  },
  new_sales_return: {
    description: "A customer return is recorded.",
    config: z.object({ ...org, customer_id: z.string().optional().describe("Only this customer's returns") }),
    output: output("sales_return", "The return: salesreturn_id, salesreturn_number, salesorder_id, salesorder_number, customer_id, customer_name, status, date"),
    ...every,
    async poll({ organization_id, customer_id }, run) {
      const list = await rows(run, "list_sales_returns", "salesreturns", { organization_id });
      return list.filter((r) => same(r.customer_id, customer_id)).map((r) => ({ id: String(r.salesreturn_id), item: { sales_return: r } }));
    },
  },
  new_bill: {
    description: "A vendor bill is recorded.",
    config: z.object({ ...org, vendor_id: z.string().optional().describe("Only this vendor's bills") }),
    output: output("bill", "The bill: bill_id, bill_number, vendor_id, vendor_name, status, date, due_date, total, balance"),
    ...every,
    async poll({ organization_id, vendor_id }, run) {
      const list = await rows(run, "list_bills", "bills", { organization_id });
      return list.filter((r) => same(r.vendor_id, vendor_id)).map((r) => ({ id: String(r.bill_id), item: { bill: r } }));
    },
  },
  new_transfer_order: {
    description: "Stock is moved between warehouses or locations with a transfer order.",
    config: z.object({ ...org }),
    output: output("transfer_order", "The transfer: transfer_order_id, transfer_order_number, date, from_warehouse_name, to_warehouse_name, status"),
    ...every,
    async poll({ organization_id }, run) {
      const list = await rows(run, "list_transfer_orders", "transfer_orders", { organization_id, sort_column: "created_time", sort_order: "D" });
      return list.map((r) => ({ id: String(r.transfer_order_id), item: { transfer_order: r } }));
    },
  },
};
