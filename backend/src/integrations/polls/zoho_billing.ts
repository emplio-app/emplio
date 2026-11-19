import { z } from "zod";
import type { PollTrigger, Run } from "./index";

// Zoho Billing's webhooks can only be set up in its own settings, not by a login, but it logs every happening as an event
// (kept 180 days), so most triggers read the newest 200 events and pick their kinds. New invoices and customers read their lists.
// ponytail: newest 200 per check; more than 200 in one check would miss some
const every = { every: 15, min: 5 };
const org = { organization_id: z.string().optional().describe("Which organisation (leave out when the login has just one)") };
const customer = { customer_id: z.string().optional().describe("Only this customer's") };

// Zoho's event names, from zoho.com/billing/api/v1/events
const EVENTS = [
  "subscription_created", "subscription_activation", "subscription_upgraded", "subscription_downgraded", "subscription_renewed",
  "subscription_cancelled", "subscription_cancellation_scheduled", "subscription_scheduled_cancellation_removed", "subscription_cancelling",
  "subscription_reactivated", "subscription_reactivation_scheduled", "subscription_expired", "subscription_expiring", "subscription_unpaid",
  "subscription_deleted", "subscription_ahead", "subscription_move_to_free_scheduled", "trial_expiring", "billing_date_changed",
  "payment_thankyou", "payment_declined", "payment_refunded", "payment_voided", "payment_method_added", "payment_method_updated",
  "payment_method_deleted", "card_expiring", "card_expired", "card_deleted", "invoice_notification", "invoice_updated", "invoice_voided",
  "creditnote_added", "creditnote_deleted", "creditnote_refunded", "unbilled_charges_added", "unbilled_charges_updated",
  "unbilled_charges_deleted", "unbilled_charges_invoiced",
] as const;

type Event = { event_id: string; event_type: string; event_time?: string; payload?: unknown };
const parse = (p: unknown) => {
  if (typeof p !== "string") return p ?? {};
  try {
    return JSON.parse(p);
  } catch {
    return p;
  }
};
// the payload holds the subscription, payment or invoice it's about; any of them may name the customer
const forCustomer = (payload: any, id?: string) => !id || Object.values(payload && typeof payload === "object" ? payload : {}).some((v: any) => String(v?.customer_id ?? "") === id);

async function events(run: Run, { customer_id, event_type, ...rest }: { customer_id?: string; event_type?: string }, types: readonly string[]) {
  const list = (((await run("zoho_billing.list_of_events", { per_page: 200, ...rest })) as { events?: Event[] }).events ?? []);
  return list
    .filter((e) => types.includes(e.event_type) && (!event_type || e.event_type === event_type))
    .map((e) => ({ ...e, payload: parse(e.payload) }))
    .filter((e) => forCustomer(e.payload, customer_id))
    .map((event) => ({ id: String(event.event_id), item: { event } }));
}

const eventOutput: PollTrigger["output"] = [{ name: "event", type: "object", required: true, description: "The event: event_id, event_type, event_time, and payload with what it is about (subscription, payment, invoice, customer or card)" }];
const onEvents = (description: string, types: readonly string[]): PollTrigger => ({
  description,
  config: z.object({ ...org, ...customer }),
  output: eventOutput,
  ...every,
  poll: (config, run) => events(run, config, types),
});

const rows = async (run: Run, action: string, key: string, input: object) => (((await run(action, { per_page: 200, ...input })) as Record<string, any[]>)[key] ?? []);

export const zoho_billing: Record<string, PollTrigger> = {
  new_event: {
    description: "Anything happens in Zoho Billing: a subscription starts, renews or ends, a payment goes through or fails, a card is about to expire, and so on. Pick one kind with event_type, or get them all.",
    config: z.object({ ...org, ...customer, event_type: z.enum(EVENTS).optional().describe("Only this kind of event") }),
    output: eventOutput,
    ...every,
    poll: (config, run) => events(run, config, EVENTS),
  },
  new_subscription: onEvents("A customer starts a new subscription.", ["subscription_created"]),
  subscription_activated: onEvents("A subscription becomes live, for example when its trial ends and the first payment goes through.", ["subscription_activation"]),
  subscription_cancelled: onEvents("A subscription is cancelled, by the customer, by you, or because payments kept failing.", ["subscription_cancelled"]),
  subscription_cancellation_scheduled: onEvents("A subscription is set to cancel at the end of its current term.", ["subscription_cancellation_scheduled"]),
  subscription_plan_changed: onEvents("A customer moves to a higher or lower plan.", ["subscription_upgraded", "subscription_downgraded"]),
  subscription_renewed: onEvents("A subscription renews for another term.", ["subscription_renewed"]),
  subscription_reactivated: onEvents("A cancelled subscription is started again.", ["subscription_reactivated"]),
  subscription_expired: onEvents("A subscription reaches its end date.", ["subscription_expired"]),
  subscription_unpaid: onEvents("A subscription is marked unpaid after payment attempts failed.", ["subscription_unpaid"]),
  trial_expiring: onEvents("A customer's free trial is about to end.", ["trial_expiring"]),
  payment_received: onEvents("A customer's payment goes through.", ["payment_thankyou"]),
  payment_failed: onEvents("A customer's payment fails or their card is declined.", ["payment_declined"]),
  payment_refunded: onEvents("A payment is refunded to the customer.", ["payment_refunded"]),
  card_expiring: onEvents("A customer's saved card is about to expire, or has expired.", ["card_expiring", "card_expired"]),
  new_invoice: {
    description: "A new invoice is created, whether by a renewal or by hand.",
    config: z.object({ ...org, ...customer, subscription_id: z.string().optional().describe("Only this subscription's invoices") }),
    output: [{ name: "invoice", type: "object", required: true, description: "The invoice: invoice_id, number, customer_id, customer_name, status, invoice_date, due_date, total, balance" }],
    ...every,
    async poll({ customer_id, subscription_id, ...rest }, run) {
      const invoices = await rows(run, "zoho_billing.list_invoices", "invoices", { ...rest, ...(customer_id && { customer_id }), ...(subscription_id && { subscription_id }), sort_column: "created_time", sort_order: "D" });
      return invoices.map((invoice) => ({ id: String(invoice.invoice_id), item: { invoice } }));
    },
  },
  new_customer: {
    description: "A new customer is added.",
    config: z.object(org),
    output: [{ name: "customer", type: "object", required: true, description: "The customer: customer_id, display_name, company_name, email, phone, status, created_time" }],
    ...every,
    async poll(config, run) {
      const customers = await rows(run, "zoho_billing.list_customers", "customers", { ...config, sort_column: "created_time", sort_order: "D" });
      return customers.map((customer) => ({ id: String(customer.customer_id), item: { customer } }));
    },
  },
};
