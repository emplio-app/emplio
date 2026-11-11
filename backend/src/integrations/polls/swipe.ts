// What Swipe can't tell us itself. Swipe only pushes two events, document and inventory, and only to a webhook the
// business sets up by hand in its dashboard (own/swipe/triggers.ts), so everything an owner actually waits on is
// read from Swipe's own lists instead: a new invoice, one that gets paid, a payment, an invoice gone past its due
// date, a new customer, a purchase or expense, stock running low. These need nothing set up.
// Swipe's quirks are all here: one request a second (so a check makes one call, two at most), dates DD-MM-YYYY,
// and a rejection can arrive as a 200 with success:false (own/swipe/index.ts turns that into an error).
import { z } from "zod";
import type { PollTrigger } from "./index";

const DAY_MS = 86_400_000;
const pad = (n: number) => String(n).padStart(2, "0");
// Swipe wants DD-MM-YYYY, day first
const dmy = (ms: number) => {
  const d = new Date(ms);
  return `${pad(d.getUTCDate())}-${pad(d.getUTCMonth() + 1)}-${d.getUTCFullYear()}`;
};
const midnight = () => Math.floor(Date.now() / DAY_MS) * DAY_MS;
// end_date is tomorrow: India runs 5½ hours ahead of the server, so "today" there can already be tomorrow here
const window = (days: number) => ({ start_date: dmy(Date.now() - days * DAY_MS), end_date: dmy(Date.now() + DAY_MS) });
const dueMs = (date: unknown) => {
  const [d, m, y] = String(date ?? "").split("-").map(Number);
  return d && m && y ? Date.UTC(y, m - 1, d) : undefined;
};

// Every Swipe list wraps its rows in {success, data: {transactions | customers | items | ...}}; the rows are the
// one array in there. ponytail: first array wins, which is right for every list Swipe has today.
const rows = (out: unknown): Record<string, any>[] => {
  const data = (out as { data?: unknown })?.data ?? out;
  if (Array.isArray(data)) return data;
  return (Object.values((data ?? {}) as Record<string, unknown>).find(Array.isArray) as Record<string, any>[]) ?? [];
};
const total = (out: unknown) => Number((out as { data?: { total_records?: unknown } })?.data?.total_records ?? 0);

const PAGE = 100;
// Swipe's spec types num_records as text on the document, customer and item lists and as a number on payments
const PAGE_TEXT = String(PAGE);
// one request per second per key
const GAP_MS = 1100;
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

const DOCUMENT =
  "The Swipe document: hash_id, serial_number, document_date, due_date, customer, payment_status, total_amount, amount_paid, amount_pending, tax_amount, notes. Amounts are in rupees, dates DD-MM-YYYY.";
const days = (fallback: number) =>
  z.object({
    days: z.number().int().min(1).max(365).optional().describe(`How far back to look each time, in days (default ${fallback}). Swipe's lists are filtered by the document's own date, so a document dated longer ago than this is never seen.`),
  });

// A document appearing in one of Swipe's lists. The newest 100 of the window, so a business writing more than that
// between two checks loses the rest. ponytail: raise `days` rather than paging, Swipe allows one call a second
const documents = (description: string, document_type: string, o: { payment_status?: string; back?: number; overdue?: boolean } = {}): PollTrigger => ({
  description: `${description}.`,
  config: days(o.back ?? 7),
  output: [{ name: "document", type: "object", required: true, description: DOCUMENT }],
  every: 10,
  min: 5,
  async poll(config: { days?: number }, run) {
    const out = await run("swipe.list_documents", { document_type, payment_status: o.payment_status ?? "all", num_records: PAGE_TEXT, ...window(config.days ?? o.back ?? 7) });
    const today = midnight();
    return rows(out)
      .filter((r) => !o.overdue || (dueMs(r.due_date) ?? Number.POSITIVE_INFINITY) < today)
      .map((r) => ({ id: `${r.hash_id}${o.overdue ? ":overdue" : ""}`, item: { document: r } }));
  },
});

export const swipe: Record<string, PollTrigger> = {
  new_invoice: documents("An invoice is raised in Swipe", "invoice"),
  invoice_paid: documents("An invoice in Swipe is paid in full", "invoice", { payment_status: "paid", back: 90 }),
  // an invoice can be paid long after it was raised, so this looks back further than a new one does
  invoice_overdue: documents("An invoice in Swipe is past its due date and still not paid", "invoice", { payment_status: "pending", back: 90, overdue: true }),
  new_purchase: documents("A purchase (a bill from a supplier) is recorded in Swipe", "purchase", { back: 14 }),

  payment_received: {
    description: "A customer's payment is recorded in Swipe.",
    config: days(2),
    output: [
      {
        name: "payment",
        type: "object",
        required: true,
        description: "The Swipe payment: total_amount, payment_date, payment_mode, payment_type, customer, linked_docs, amount_remaining, notes. Amounts are in rupees, dates DD-MM-YYYY.",
      },
    ],
    every: 10,
    min: 5,
    // Swipe's payment list carries no id of its own, so one is built from the row. ponytail: two payments of the
    // same amount, mode and day against the same customer and balance count as one
    async poll(config: { days?: number }, run) {
      const out = await run("swipe.list_payments", { status: "success", num_records: PAGE, ...window(config.days ?? 2) });
      return rows(out).map((r) => ({
        id: [r.customer?.customer_id ?? r.customer?.name ?? "", r.payment_date ?? "", r.total_amount ?? "", r.payment_mode ?? "", r.amount_remaining ?? ""].join("|"),
        item: { payment: r },
      }));
    },
  },

  new_expense: {
    description: "An expense (rent, salary, a utility bill: money out that isn't a purchase document) is recorded in Swipe.",
    config: days(14),
    output: [{ name: "expense", type: "object", required: true, description: "The Swipe expense: hash_id, category, party, document_date, amounts and what's still pending. Read it in full with swipe.get_expense." }],
    every: 10,
    min: 5,
    async poll(config: { days?: number }, run) {
      const out = await run("swipe.list_expenses", { document_type: "purchase", payment_status: "all", num_records: PAGE, ...window(config.days ?? 14) });
      return rows(out).map((r) => ({ id: String(r.hash_id ?? ""), item: { expense: r } }));
    },
  },

  new_customer: {
    description: "A customer is added in Swipe.",
    config: z.object({}),
    output: [{ name: "customer", type: "object", required: true, description: "The Swipe customer: customer_id (the business's own), swipe_id, name, phone, email, gstin." }],
    every: 15,
    min: 5,
    // Swipe's customer list has no date filter and no sort, and doesn't say which end is newest, so both ends are
    // read: the first page always, the last one as well once there are more than a page of customers.
    async poll(_config, run) {
      const first = await run("swipe.list_customers", { num_records: PAGE_TEXT, page: 1 });
      const pages = Math.ceil(total(first) / PAGE);
      let all = rows(first);
      if (pages > 1) {
        await sleep(GAP_MS);
        all = [...all, ...rows(await run("swipe.list_customers", { num_records: PAGE_TEXT, page: pages }))];
      }
      return all.map((r) => ({ id: String(r.swipe_id ?? r.customer_id ?? ""), item: { customer: r } }));
    },
  },

  low_stock: {
    description: "An item's stock in Swipe falls to or below the level you set.",
    config: z.object({
      threshold: z.number().min(0).optional().describe("Tell me when an item's quantity is this or lower (default 5)"),
    }),
    output: [{ name: "item", type: "object", required: true, description: "The Swipe item: id (the business's own), swipe_id, name, quantity, unit, category, unit_price, price_with_tax, tax_rate, hsn_code." }],
    every: 30,
    min: 5,
    // the 100 lowest-stocked items, so a big catalogue still costs one call
    async poll(config: { threshold?: number }, run) {
      const limit = config.threshold ?? 5;
      const out = await run("swipe.list_products", { num_records: PAGE_TEXT, page: 1, sort_by: "quantity", sort_order: "asc" });
      return rows(out)
        .filter((r) => typeof r.quantity === "number" && r.quantity <= limit)
        .map((r) => ({ id: `${r.id ?? r.swipe_id}:${r.quantity}`, item: { item: r } }));
    },
  },
};
