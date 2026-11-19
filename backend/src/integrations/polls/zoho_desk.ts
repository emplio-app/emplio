import { z } from "zod";
import type { PollTrigger, Run } from "./index";

// What Zoho Desk has no webhook event for: a ticket going overdue, and new products and contracts. The rest are webhooks (own/zoho_desk/triggers.ts).
// ponytail: newest 100 per check; more than 100 new in one check would miss some
const every = { every: 15, min: 5 };
const org = { org_id: z.string().optional().describe("Which Zoho Desk organisation (leave out when the login has just one)") };
const department = { department_id: z.string().optional().describe("Only this department (its id)") };
// Desk answers an empty list with no body at all
const rows = async (run: Run, action: string, input: object) => {
  const out = (await run(`zoho_desk.${action}`, { limit: 100, ...input })) as { data?: Record<string, any>[] } | string | undefined;
  return out && typeof out === "object" ? (out.data ?? []) : [];
};
const LOOK_BACK_MS = 7 * 86_400_000;
const closed = (t: Record<string, any>) => /closed/i.test(String(t.statusType ?? t.status ?? ""));

export const zoho_desk: Record<string, PollTrigger> = {
  ticket_overdue: {
    description: "A ticket that isn't closed has gone past its due date.",
    config: z.object({ ...org, ...department }),
    output: [{ name: "ticket", type: "object", required: true, description: "The ticket: id, ticketNumber, subject, status, dueDate, assigneeId, departmentId, contactId, webUrl" }],
    ...every,
    async poll({ org_id, department_id }, run) {
      const now = new Date();
      // due within the last week and now past: the due date is in the id, so a ticket given a new date and missed again comes back
      const tickets = await rows(run, "search_tickets", { org_id, departmentId: department_id, dueDateRange: `${new Date(now.getTime() - LOOK_BACK_MS).toISOString()},${now.toISOString()}`, sortBy: "dueDate" });
      return tickets.filter((t) => !closed(t) && t.dueDate && Date.parse(t.dueDate) <= now.getTime()).map((ticket) => ({ id: `${ticket.id}:${ticket.dueDate}`, item: { ticket } }));
    },
  },
  product_added: {
    description: "A product is added to Zoho Desk.",
    config: z.object({ ...org, ...department }),
    output: [{ name: "product", type: "object", required: true, description: "The product: id, productName, productCode, unitPrice, departmentIds, createdTime" }],
    ...every,
    async poll({ org_id, department_id }, run) {
      const products = await rows(run, "get_products", { org_id, departmentId: department_id, sortBy: "-createdTime" });
      return products.map((product) => ({ id: String(product.id), item: { product } }));
    },
  },
  contract_added: {
    description: "A support contract is added to Zoho Desk.",
    config: z.object({ ...org, ...department, account_id: z.string().optional().describe("Only this account's contracts") }),
    output: [{ name: "contract", type: "object", required: true, description: "The contract: id, contractName, accountId, contractStartDate, contractEndDate, departmentId, createdTime" }],
    ...every,
    async poll({ org_id, department_id, account_id }, run) {
      const contracts = await rows(run, "list_contracts", { org_id, accountId: account_id, ...(department_id && { departmentIds: [department_id] }), sortBy: "-createdTime" });
      return contracts.map((contract) => ({ id: String(contract.id), item: { contract } }));
    },
  },
};
