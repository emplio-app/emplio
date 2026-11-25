// Smartsheet things no sheet webhook reports: new sheets (and sheets changed anywhere in the account), reports,
// dashboards, workspaces, and the admin event log. Changes on one sheet come by webhook (own/smartsheet/triggers.ts).
import { z } from "zod";
import { recent, type PollTrigger, type Run } from "./index";

const rows = (out: unknown) => ((out as { data?: unknown[] | null })?.data ?? []) as any[];
const DAY = 86_400_000;

// ponytail: reports, dashboards and workspaces carry no creation time in their lists, so every one is kept as seen; fine for the dozens a business has
const listed = (description: string, field: string, what: string, list: (c: any, run: Run) => Promise<any[]>, keep: (row: any) => boolean = () => true, id: (row: any) => string = (row) => String(row.id), config: z.ZodObject = z.object({})): PollTrigger => ({
  description,
  config,
  output: [{ name: field, type: "object", required: true, description: what }],
  every: 5,
  min: 1,
  poll: async (c, run) => (await list(c, run)).filter(keep).map((row) => ({ id: id(row), item: { [field]: row } })),
});

export const smartsheet: Record<string, PollTrigger> = {
  new_sheet: listed(
    "A sheet is made in Smartsheet or shared with the connected account (checked every 5 minutes).",
    "sheet",
    "The sheet: id, name, permalink, accessLevel, createdAt, modifiedAt. get_sheet reads its rows.",
    async (_c, run) => rows(await run("smartsheet.list_sheets", { includeAll: true, modifiedSince: new Date(Date.now() - DAY).toISOString() })),
    (s) => recent(s.createdAt),
  ),
  sheet_modified: listed(
    "Any sheet the connected account can see changed: rows, cells, columns or settings (checked every 5 minutes). To react to one sheet's changes the moment they happen, use the sheet triggers (new_row, cell_changed...).",
    "sheet",
    "The sheet: id, name, permalink, modifiedAt, version. get_sheet with rowsModifiedSince gives the rows that changed.",
    async (_c, run) => rows(await run("smartsheet.list_sheets", { includeAll: true, modifiedSince: new Date(Date.now() - DAY).toISOString() })),
    (s) => recent(s.modifiedAt),
    (s) => `${s.id}:${s.version ?? s.modifiedAt}`,
  ),
  new_report: listed(
    "A report is made in Smartsheet or shared with the connected account (checked every 5 minutes).",
    "report",
    "The report: id, name, permalink, accessLevel, isSummaryReport. get_report reads it.",
    async (_c, run) => rows(await run("smartsheet.list_reports", {})),
  ),
  new_dashboard: listed(
    "A dashboard is made in Smartsheet or shared with the connected account (checked every 5 minutes).",
    "dashboard",
    "The dashboard: id, name, permalink, accessLevel",
    async (_c, run) => rows(await run("smartsheet.list_dashboards", { maxItems: 1000 })),
  ),
  new_workspace: listed(
    "A workspace is made in Smartsheet or shared with the connected account (checked every 5 minutes).",
    "workspace",
    "The workspace: id, name, permalink, accessLevel. list_workspace_children shows what's in it.",
    async (_c, run) => rows(await run("smartsheet.list_workspaces", { maxItems: 1000 })),
  ),
  new_admin_event: listed(
    "Something happens anywhere in the Smartsheet plan, from the admin event log: sign-ins, sheets made, shared, exported or deleted, users added... (checked every 5 minutes). Needs a System Admin's token and Smartsheet's Event Reporting add-on.",
    "event",
    "The event: eventId, objectType (SHEET, USER, WORKSPACE...), action (CREATE, LOAD, EXPORT...), objectId, eventTimestamp, userId, additionalDetails",
    async ({ object_type, action }, run) =>
      rows(await run("smartsheet.list_events", { since: new Date(Date.now() - DAY).toISOString(), maxCount: 1000 })).filter(
        (e) => (!object_type || String(e.objectType).toUpperCase() === String(object_type).toUpperCase()) && (!action || String(e.action).toUpperCase() === String(action).toUpperCase()),
      ),
    (e) => recent(e.eventTimestamp),
    (e) => String(e.eventId),
    z.object({
      object_type: z.string().optional().describe("Only events about this kind of thing: SHEET, REPORT, DASHBOARD, WORKSPACE, FOLDER, USER, GROUP, ATTACHMENT, DISCUSSION, ACCOUNT..."),
      action: z.string().optional().describe("Only this action: CREATE, UPDATE, DELETE, LOAD, EXPORT, ADD_SHARE, REMOVE_SHARE, LOGIN..."),
    }),
  ),
};
