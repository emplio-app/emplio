import { z } from "zod";
import type { PollTrigger, Run } from "./index";

// Zoho Books and Zoho Invoice have no webhooks this login can set up, so the newest 200 are compared at each check.
// ponytail: newest 200 per list; more than 200 new in one check would miss some
const every = { every: 15, min: 5 };
const output = (name: string, description: string): PollTrigger["output"] => [{ name, type: "object", required: true, description }];
const org = { organization_id: z.string().optional().describe("Which organisation (leave out when the login has just one)") };
const rows = async (run: Run, action: string, key: string, input: object) => (((await run(action, { per_page: 200, ...input })) as Record<string, any[]>)[key] ?? []);

// `lists`: Books and Invoice call the same lists differently
export const accountingPolls = (app: string, lists: { payments: string }, contactFilter: object): Record<string, PollTrigger> => ({
  new_invoice: {
    description: "A new invoice is created.",
    config: z.object({ ...org, customer_id: z.string().optional().describe("Only this customer's invoices"), status: z.string().optional().describe("Only invoices with this status, e.g. sent or draft") }),
    output: output("invoice", "The invoice: invoice_id, invoice_number, customer_id, customer_name, status, date, due_date, total, balance"),
    ...every,
    async poll({ customer_id, status, ...rest }, run) {
      const invoices = await rows(run, `${app}.list_invoices`, "invoices", { ...rest, sort_column: "created_time", sort_order: "D" });
      return invoices.filter((i) => (!customer_id || i.customer_id === customer_id) && (!status || i.status === status)).map((invoice) => ({ id: String(invoice.invoice_id), item: { invoice } }));
    },
  },
  customer_changed: {
    description: "A customer is added or changed. Anything that updates the customer's record counts, including a change made by another automation.",
    config: z.object({ ...org, new_only: z.boolean().optional().describe("Only new customers, not changes") }),
    output: output("customer", "The customer: contact_id, contact_name, company_name, email, phone, status, last_modified_time"),
    ...every,
    async poll({ new_only, ...rest }, run) {
      const customers = (await rows(run, `${app}.list_contacts`, "contacts", { ...rest, ...contactFilter, sort_column: new_only ? "created_time" : "last_modified_time", sort_order: "D" })).filter((c) => (c.contact_type ?? "customer") === "customer");
      return customers.map((customer) => ({ id: new_only ? String(customer.contact_id) : `${customer.contact_id}:${customer.last_modified_time}`, item: { customer } }));
    },
  },
  payment_received: {
    description: "A customer payment is recorded.",
    config: z.object({ ...org, customer_id: z.string().optional().describe("Only this customer's payments") }),
    output: output("payment", "The payment: payment_id, customer_id, customer_name, date, amount, payment_mode, reference_number"),
    ...every,
    async poll({ customer_id, ...rest }, run) {
      const payments = await rows(run, `${app}.${lists.payments}`, "customerpayments", { ...rest, sort_column: "created_time", sort_order: "D" });
      return payments.filter((p) => !customer_id || p.customer_id === customer_id).map((payment) => ({ id: String(payment.payment_id), item: { payment } }));
    },
  },
});

export const zoho_books = accountingPolls("zoho_books", { payments: "list_customer_payments" }, { contact_type: "customer" });
