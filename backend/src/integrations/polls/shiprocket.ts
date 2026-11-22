import { z } from "zod";
import type { PollTrigger, Run } from "./index";

// YYYY-MM-DD, n days ago (Shiprocket's dates are India time; a day either side is enough for a poll)
const day = (ago = 0) => new Date(Date.now() + 5.5 * 3_600_000 - ago * 86_400_000).toISOString().slice(0, 10);

// ponytail: first 100 orders changed since yesterday; a busier account can miss some changes (page further then)
const changed = async (run: Run) =>
  ((await run("shiprocket.list_orders", { updated_from: day(1), updated_to: day(), per_page: 100, sort: "DESC", sort_by: "id" })) as { data?: any[] }).data ?? [];

const order = [{ name: "order", type: "object", required: true, description: "The Shiprocket order: id, channel_order_id, customer_name, customer_phone, status, total, payment_method, products, shipments (id, awb, courier)" }];
const statusIs = (o: any, want?: string[]) => !want?.length || want.some((s) => String(o.status ?? "").toUpperCase() === s.toUpperCase());

const orderStatus = (description: string, keep: (status: string) => boolean): PollTrigger => ({
  description,
  config: z.object({ pickup_location: z.string().optional().describe("Only orders from this pickup location") }),
  output: order,
  every: 10,
  min: 5,
  async poll({ pickup_location }, run) {
    return (await changed(run))
      .filter((o) => keep(String(o.status ?? "").toUpperCase()))
      .filter((o) => !pickup_location || o.pickup_location === pickup_location)
      .map((o) => ({ id: `${o.id}:${o.status}`, item: { order: o } }));
  },
});

export const shiprocket: Record<string, PollTrigger> = {
  new_order: {
    description: "A new order arrives in Shiprocket, from any store or channel (checked every 10 minutes). Optionally only COD or prepaid, or one channel.",
    config: z.object({
      payment_method: z.enum(["cod", "prepaid"]).optional().describe("Only cash-on-delivery or only prepaid orders"),
      channel_id: z.number().int().optional().describe("Only orders from this channel (shiprocket.list_channels)"),
    }),
    output: order,
    every: 10,
    min: 5,
    // the newest 50 by id; the first check only notes what's there
    async poll({ payment_method, channel_id }, run) {
      const out = (await run("shiprocket.list_orders", { per_page: 50, sort: "DESC", sort_by: "id", ...(channel_id && { channel_id }) })) as { data?: any[] };
      return (out.data ?? [])
        .filter((o) => !payment_method || String(o.payment_method).toLowerCase() === payment_method)
        .map((o) => ({ id: String(o.id), item: { order: o } }));
    },
  },
  order_status_changed: {
    description: "An order's shipping status changes in Shiprocket (e.g. READY TO SHIP, PICKED UP, IN TRANSIT, OUT FOR DELIVERY, DELIVERED, CANCELED, RTO INITIATED). Optionally only some statuses.",
    config: z.object({
      statuses: z.array(z.string()).optional().describe('Only these statuses, as Shiprocket writes them, e.g. ["OUT FOR DELIVERY", "DELIVERED"]'),
      pickup_location: z.string().optional().describe("Only orders from this pickup location"),
    }),
    output: order,
    every: 10,
    min: 5,
    async poll({ statuses, pickup_location }, run) {
      return (await changed(run))
        .filter((o) => statusIs(o, statuses))
        .filter((o) => !pickup_location || o.pickup_location === pickup_location)
        .map((o) => ({ id: `${o.id}:${o.status}`, item: { order: o } }));
    },
  },
  shipment_delivered: orderStatus("A shipment is delivered to the customer.", (s) => s === "DELIVERED"),
  shipment_rto: orderStatus("A shipment is being returned to you (RTO): the courier couldn't deliver it and it's coming back, or it has arrived back.", (s) => s.startsWith("RTO")),
  order_cancelled: orderStatus("An order is cancelled in Shiprocket.", (s) => s.startsWith("CANCEL")),
  new_ndr: {
    description: "A delivery fails (NDR): the courier couldn't deliver, e.g. customer not reachable or asked for another day. Starts again on each new attempt. Decide with shiprocket.act_on_ndr.",
    config: z.object({}),
    output: [{ name: "ndr", type: "object", required: true, description: "The failed delivery: awb_code, shipment_id, customer_name, customer_phone, customer_city, reason, attempts, courier, payment_method, product_name, history" }],
    every: 15,
    min: 5,
    async poll(_c, run) {
      const out = (await run("shiprocket.list_ndr", { from: day(2), to: day(), per_page: 100 })) as { data?: any[] };
      return (out.data ?? []).map((n) => ({ id: `${n.awb_code ?? n.id}:${n.attempts ?? ""}`, item: { ndr: n } }));
    },
  },
  new_return_order: {
    description: "A return order is created in Shiprocket (a customer is sending something back).",
    config: z.object({}),
    output: [{ name: "return", type: "object", required: true, description: "The return order: id, channel_order_id, customer_name, customer_phone, status, total, products, shipments" }],
    every: 15,
    min: 5,
    async poll(_c, run) {
      const out = (await run("shiprocket.list_return_orders", { from: day(2), to: day(), per_page: 100 })) as { data?: any[] };
      return (out.data ?? []).map((o) => ({ id: String(o.id), item: { return: o } }));
    },
  },
};
