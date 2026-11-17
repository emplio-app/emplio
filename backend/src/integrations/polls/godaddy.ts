// GoDaddy sends no webhooks to account holders (Domains v2 has a notification queue, which must be acknowledged one by
// one and would be taken from anyone else reading it), so every trigger compares GoDaddy's lists between checks.
// Its rate limit is 60 calls a minute per endpoint, so every 15 minutes is plenty.
import { z } from "zod";
import { recent, type PollTrigger, type Run } from "./index";

type Domain = { domain: string; domainId?: number; status: string; expires?: string; createdAt?: string; renewAuto?: boolean };
const DAY = 86_400_000;

// ponytail: the first 1000 domains; past that, use marker paging
const domains = async (run: Run) => ((await run("godaddy.v1_list_domains", { limit: 1000 })) as Domain[]) ?? [];
const one = z.string().optional().describe("Only this domain, e.g. example.com");
const domainOut = [{ name: "domain", type: "object", required: true, description: "The GoDaddy domain: domain, status, expires, createdAt, renewAuto, locked, privacy, nameServers" }];

const daysAhead = (days: number) => z.number().int().min(1).max(365).default(days).describe(`How many days before the date to start telling (default ${days})`);
const within = (iso: string | undefined, days: number) => Boolean(iso) && Date.parse(iso!) - Date.now() < days * DAY && Date.parse(iso!) > Date.now() - DAY;

export const godaddy: Record<string, PollTrigger> = {
  new_domain: {
    description: "A domain is added to the GoDaddy account (registered or transferred in).",
    config: z.object({}),
    output: domainOut,
    every: 15,
    min: 5,
    poll: async (_c, run) => (await domains(run)).filter((d) => recent(d.createdAt)).map((domain) => ({ id: domain.domain, item: { domain } })),
  },
  domain_status_changed: {
    description: "A GoDaddy domain's status changes (for example ACTIVE, PENDING_TRANSFER, EXPIRED, CANCELLED). Optionally one domain.",
    config: z.object({ domain: one }),
    output: domainOut,
    every: 15,
    min: 5,
    poll: async ({ domain }, run) =>
      (await domains(run)).filter((d) => !domain || d.domain === domain).map((d) => ({ id: `${d.domain}:${d.status}`, item: { domain: d } })),
  },
  domain_expiring_soon: {
    description: "A GoDaddy domain will expire within the chosen number of days (once per expiry date). Optionally only domains without auto-renew.",
    config: z.object({
      days: daysAhead(30),
      domain: one,
      only_manual_renewal: z.boolean().optional().describe("Only domains whose auto-renew is off"),
    }),
    output: domainOut,
    every: 360,
    min: 60,
    poll: async ({ days = 30, domain, only_manual_renewal }, run) =>
      (await domains(run))
        .filter((d) => d.status === "ACTIVE" && within(d.expires, days))
        .filter((d) => !domain || d.domain === domain)
        .filter((d) => !only_manual_renewal || !d.renewAuto)
        .map((d) => ({ id: `${d.domain}:${d.expires}`, item: { domain: d } })),
  },
  dns_record_changed: {
    description:
      "A DNS record on one GoDaddy domain is added or changed (needs a personal access token with Domains & DNS). Optionally only one record type.",
    config: z.object({
      domain: z.string().describe("The domain whose DNS to watch, e.g. example.com"),
      type: z.string().optional().describe("Only this record type: A, AAAA, CNAME, MX, TXT, NS, SRV, CAA"),
    }),
    output: [{ name: "record", type: "object", required: true, description: "The DNS record: recordId, name, type, data, ttl, priority" }],
    every: 15,
    min: 5,
    async poll({ domain, type }, run) {
      // ponytail: the first 500 records of the zone
      const records: any[] = [];
      for (let page = 1; page <= 5; page++) {
        const out = (await run("godaddy.list_dns_records", { zone: domain, page, pageSize: 100, ...(type && { type }) })) as { items?: any[] };
        records.push(...(out.items ?? []));
        if ((out.items?.length ?? 0) < 100) break;
      }
      return records.map((r) => ({ id: `${r.recordId ?? `${r.type}:${r.name}`}:${r.data}:${r.ttl}:${r.priority ?? ""}`, item: { record: { ...r, domain } } }));
    },
  },
  new_order: {
    description: "A purchase is made on the GoDaddy account (domains, hosting, renewals…). Needs the classic key.",
    config: z.object({}),
    output: [{ name: "order", type: "object", required: true, description: "The order: orderId, createdAt, items, pricing, payments" }],
    every: 15,
    min: 5,
    async poll(_c, run) {
      const out = (await run("godaddy.list_orders", { limit: 100 })) as { orders?: any[] };
      return (out.orders ?? []).filter((o) => recent(o.createdAt)).map((order) => ({ id: String(order.orderId), item: { order } }));
    },
  },
  new_subscription: {
    description: "A product or service is added to the GoDaddy account (a new subscription). Needs the classic key.",
    config: z.object({}),
    output: [{ name: "subscription", type: "object", required: true, description: "The subscription: subscriptionId, label, product, status, createdAt, expiresAt, renewAuto" }],
    every: 15,
    min: 5,
    async poll(_c, run) {
      // ponytail: the first 250 subscriptions in GoDaddy's order; an account with more may miss a new one
      const out = (await run("godaddy.list_subscriptions", { limit: 250 })) as { subscriptions?: any[] };
      return (out.subscriptions ?? []).filter((s) => recent(s.createdAt)).map((subscription) => ({ id: subscription.subscriptionId, item: { subscription } }));
    },
  },
  subscription_expiring_soon: {
    description: "A GoDaddy product or service (hosting, email, SSL…) will expire within the chosen number of days, once per expiry date. Needs the classic key.",
    config: z.object({ days: daysAhead(30), only_manual_renewal: z.boolean().optional().describe("Only those whose auto-renew is off") }),
    output: [{ name: "subscription", type: "object", required: true, description: "The subscription: subscriptionId, label, product, status, expiresAt, renewAuto" }],
    every: 360,
    min: 60,
    async poll({ days = 30, only_manual_renewal }, run) {
      // soonest to expire first
      const out = (await run("godaddy.list_subscriptions", { limit: 250, sort: "expiresAt" })) as { subscriptions?: any[] };
      return (out.subscriptions ?? [])
        .filter((s) => s.status === "ACTIVE" && within(s.expiresAt, days))
        .filter((s) => !only_manual_renewal || !s.renewAuto)
        .map((subscription) => ({ id: `${subscription.subscriptionId}:${subscription.expiresAt}`, item: { subscription } }));
    },
  },
  new_store_order: {
    description: "An order comes in on a GoDaddy online store (Commerce; needs a token with commerce.order:read).",
    config: z.object({ store_id: z.string().describe("The store's id (a UUID), from the store's Commerce settings") }),
    output: [{ name: "order", type: "object", required: true, description: "The store order: id, number, numberDisplay, createdAt, customerId, paidAt, tags" }],
    every: 10,
    min: 5,
    async poll({ store_id }, run) {
      // ponytail: the latest 50 orders the subgraph hands back
      const out = (await run("godaddy.commerce_orders_graphql", {
        x_store_id: store_id,
        query: "query { orders(first: 50) { edges { node { id number numberDisplay createdAt updatedAt customerId paidAt tags } } } }",
      })) as { data?: { orders?: { edges?: { node: any }[] } } };
      return (out.data?.orders?.edges ?? []).map((e) => e.node).filter((o) => recent(o.createdAt)).map((order) => ({ id: order.id, item: { order } }));
    },
  },
};
