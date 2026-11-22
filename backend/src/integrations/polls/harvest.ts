// Harvest has no webhooks, so every trigger is polled: each check lists what changed in Harvest in the last day
// (updated_since) and Emplio compares with what it saw last time. "New" items are keyed by id, "changed" ones by
// id and updated_at, and state changes (paid, accepted…) by id and state, so each fires once.
import { z } from "zod";
import { recent, type PollTrigger, type Run } from "./index";

const id = (what: string) => z.number().int().optional().describe(`Only ${what} (its Harvest id)`);
const FILTERS = {
  user_id: id("this person's"),
  client_id: id("this client's"),
  project_id: id("this project's"),
  task_id: id("this task's"),
};
type Filter = keyof typeof FILTERS;

// ponytail: one page of 2000 changed in the last day; a busier account would need next_page followed
const changed = async (run: Run, action: string, field: string, query: Record<string, unknown>) =>
  (((await run(`harvest.${action}`, { updated_since: new Date(Date.now() - 86_400_000).toISOString(), per_page: 2000, ...query })) as Record<string, any[]>)[field] ?? []);

const trigger = (
  description: string,
  action: string,
  field: string,
  item: string,
  filters: Filter[],
  key: (row: any) => string | undefined,
  query: Record<string, unknown> = {},
): PollTrigger => ({
  description,
  config: z.object(Object.fromEntries(filters.map((f) => [f, FILTERS[f]]))),
  output: [{ name: item, type: "object", required: true, description: `The Harvest ${item.replace(/_/g, " ")}, as ${action} returns it` }],
  every: 5,
  min: 1,
  async poll(config, run) {
    const rows = await changed(run, action, field, { ...config, ...query });
    return rows.flatMap((row) => {
      const k = key(row);
      return k ? [{ id: k, item: { [item]: row } }] : [];
    });
  },
});

const created = (row: any) => (recent(row.created_at) ? String(row.id) : undefined);
const updated = (row: any) => (recent(row.updated_at) ? `${row.id}:${row.updated_at}` : undefined);
const inState = (state: string) => (row: any) => (row.state === state && recent(row.updated_at) ? `${row.id}:${state}` : undefined);
const AGAIN = " A run that changes it in Harvest makes this fire again.";

// [name, list action, the answer's field, filters, what it is]
const RESOURCES: [string, string, string, Filter[], string][] = [
  ["time_entry", "list_time_entries", "time_entries", ["user_id", "client_id", "project_id", "task_id"], "time entry (hours someone logged)"],
  ["invoice", "list_invoices", "invoices", ["client_id", "project_id"], "invoice"],
  ["estimate", "list_estimates", "estimates", ["client_id"], "estimate"],
  ["expense", "list_expenses", "expenses", ["user_id", "client_id", "project_id"], "expense"],
  ["project", "list_projects", "projects", ["client_id"], "project"],
  ["client", "list_clients", "clients", [], "client"],
  ["client_contact", "list_client_contacts", "contacts", ["client_id"], "client contact"],
  ["task", "list_tasks", "tasks", [], "task (a kind of work, like Design)"],
  ["user", "list_users", "users", [], "person on the Harvest team"],
  ["time_off_request", "list_time_off_requests", "pto_requests", ["user_id"], "time off request"],
];

export const harvest: Record<string, PollTrigger> = {
  ...Object.fromEntries(
    RESOURCES.flatMap(([name, action, field, filters, what]) => [
      [`new_${name}`, trigger(`A ${what} is added in Harvest.`, action, field, name, filters, created)],
      [`${name}_updated`, trigger(`A ${what} is added or changed in Harvest.${AGAIN}`, action, field, name, filters, updated)],
    ]),
  ),
  timer_started: trigger(
    "Someone starts a timer in Harvest.",
    "list_time_entries",
    "time_entries",
    "time_entry",
    ["user_id", "client_id", "project_id", "task_id"],
    (row) => (row.is_running ? `${row.id}:${row.timer_started_at}` : undefined),
    { is_running: true },
  ),
  invoice_sent: trigger("An invoice is sent (marked open) in Harvest.", "list_invoices", "invoices", "invoice", ["client_id", "project_id"], inState("open"), { state: "open" }),
  invoice_paid: trigger("An invoice is paid in full in Harvest.", "list_invoices", "invoices", "invoice", ["client_id", "project_id"], inState("paid"), { state: "paid" }),
  estimate_accepted: trigger("A client accepts an estimate in Harvest.", "list_estimates", "estimates", "estimate", ["client_id"], inState("accepted"), { state: "accepted" }),
  estimate_declined: trigger("A client declines an estimate in Harvest.", "list_estimates", "estimates", "estimate", ["client_id"], inState("declined"), { state: "declined" }),
};
