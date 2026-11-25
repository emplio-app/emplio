// Karbon things its webhooks don't report: time logged, payments and files added to a client or job.
// Contacts, work items, notes, invoices and the rest come by webhook (own/karbon/triggers.ts).
import { z } from "zod";
import type { PollTrigger } from "./index";

const rows = (out: unknown, list = "value") => ((out as Record<string, unknown[] | undefined>)?.[list] ?? []) as any[];

// ponytail: the newest page only (100); more than that between two polls is missed. Dates here are days, not times,
// so nothing is cut by age: the newest page stays the same size and the seen list (1000) covers it
export const karbon: Record<string, PollTrigger> = {
  new_time_entry: {
    description: "Someone logs time in Karbon (checked every 5 minutes). Optionally only for one person, client or work item.",
    config: z.object({
      user_key: z.string().optional().describe("Only time logged by this colleague (their UserKey; list_users lists them)"),
      client_key: z.string().optional().describe("Only time for this client (its key)"),
      work_item_key: z.string().optional().describe("Only time on this work item (its key)"),
    }),
    output: [{ name: "entry", type: "object", required: true, description: "The time entry: IndividualTimeEntryKey, Date, Minutes, UserKey, WorkItemKey, ClientKey, RoleName, TaskTypeName, Description" }],
    every: 5,
    min: 1,
    poll: async ({ user_key, client_key, work_item_key }, run) => {
      const filter = Object.entries({ UserKey: user_key, ClientKey: client_key, WorkItemKey: work_item_key })
        .filter(([, v]) => v)
        .map(([k, v]) => `${k} eq '${String(v).replace(/'/g, "''")}'`)
        .join(" and ");
      const out = await run("karbon.list_time_entries", { $orderby: "Date desc", $top: 100, ...(filter && { $filter: filter }) });
      return rows(out).map((e) => ({ id: String(e.IndividualTimeEntryKey), item: { entry: e } }));
    },
  },
  new_payment: {
    description: "A payment is recorded in Karbon: paid online through Karbon Payments, entered by hand, or a manual payment reversed (checked every 5 minutes).",
    config: z.object({}),
    output: [{ name: "payment", type: "object", required: true, description: "The payment: PaymentKey, PaymentReference, PaymentType, PaymentDate, GrossAmount, PaymentMethod, ClientKey, and the invoices it paid" }],
    every: 5,
    min: 1,
    poll: async (_c, run) => rows(await run("karbon.list_payments", { $orderby: "PaymentDate desc", $top: 100 })).map((p) => ({ id: String(p.PaymentKey), item: { payment: p } })),
  },
  new_file: {
    description: "A file is added to a work item, contact or organization in Karbon, by the firm or uploaded by the client (checked every 5 minutes).",
    config: z.object({
      entity_type: z.enum(["WorkItem", "Contact", "Organization"]).describe("What the files are on: WorkItem, Contact or Organization"),
      entity_key: z.string().describe("Its key in Karbon"),
      shared_only: z.boolean().optional().describe("Only files the client can see (uploaded by the client, or shared with them)"),
    }),
    output: [{ name: "file", type: "object", required: true, description: "The file: FileContextKey, FileName, MimeType, FileSize, Source, FolderPath, IsShared, DateCreated. download_file with its FileContextKey gets the file itself." }],
    every: 5,
    min: 1,
    poll: async ({ entity_type, entity_key, shared_only }, run) => {
      const out = await run("karbon.list_files", { EntityType: entity_type, EntityKey: entity_key, $orderby: "DateCreated desc", $top: 100, ...(shared_only && { $filter: "IsShared eq true" }) });
      return rows(out, "Attachments").map((f) => ({ id: String(f.FileContextKey), item: { file: f } }));
    },
  },
};
