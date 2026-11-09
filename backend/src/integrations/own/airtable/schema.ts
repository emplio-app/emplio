// Who the token is, and the bases, tables, fields and views it can see.
import { z } from "zod";
import type { OwnAction } from "../index";
import { type Api, call } from "../openapi";
import { api, baseId, include, r, withList } from "./client";

const tableId = z.string().min(1).describe("The table's id, starting tbl... (airtable.get_base_schema)");
const fieldId = z.string().min(1).describe("The field's id, starting fld... (airtable.get_base_schema)");
const viewId = z.string().min(1).describe("The view's id, starting viw... (airtable.get_base_schema)");
const fieldDef = z.object({ name: z.string().describe("The field's name"), type: z.string().describe('Its type, e.g. "singleLineText", "number", "singleSelect"'), description: z.string().optional(), options: z.record(z.string(), z.any()).optional().describe("Settings some types need, e.g. a singleSelect's choices") }).loose();
const VISIBLE = ["visibleFieldIds"] as const;

export const schemaActions: Record<string, OwnAction> = {
  who_am_i: r("GET", "/v0/meta/whoami", "Whose token this is: the user id, the email if the token may read it, and its scopes."),
  list_bases: r("GET", "/v0/meta/bases", "The bases this token can reach: id, name and permission level.", { offset: z.string().optional().describe("Next page: the offset the last answer gave") }),
  get_base_metadata: {
    description: "One base's name and permission level.",
    readOnly: true,
    input: z.object({ base_id: baseId }),
    async run(i: { base_id: string }, key: string) {
      let offset: string | undefined;
      do {
        const page = (await call(api as Api, key, { method: "GET", path: "/v0/meta/bases", query: ["offset"], headers: [] }, { offset })) as { bases?: { id: string }[]; offset?: string };
        const hit = page.bases?.find((b) => b.id === i.base_id);
        if (hit) return hit;
        offset = page.offset;
      } while (offset);
      return { error: "this token can't reach that base" };
    },
  },
  get_base_schema: withList("GET", "/v0/meta/bases/{base_id}/tables", "A base's tables with their fields and views.", { base_id: baseId, include: include(VISIBLE) }, "include", true),
  create_base: r("POST", "/v0/meta/bases", "Make a new base with its tables.", {
    name: z.string().min(1).describe("The base's name"),
    workspaceId: z.string().min(1).describe("The workspace it goes in, starting wsp... (from its web address)"),
    tables: z.array(z.object({ name: z.string(), description: z.string().optional(), fields: z.array(fieldDef).min(1).describe("The fields; the first one is the table's main field") })).min(1).describe("The tables to start with"),
  }),
  delete_base: r("DELETE", "/v0/meta/bases/{base_id}", "Delete a whole base and everything in it (Enterprise plan).", { base_id: baseId }),
  create_table: r("POST", "/v0/meta/bases/{base_id}/tables", "Add a table to a base.", { base_id: baseId, name: z.string().min(1).describe("The table's name"), description: z.string().optional(), fields: z.array(fieldDef).min(1).describe("The fields; the first one is the main field") }),
  update_table: r("PATCH", "/v0/meta/bases/{base_id}/tables/{table_id}", "Rename a table or change its description.", { base_id: baseId, table_id: z.string().min(1).describe("The table's id or name"), name: z.string().optional(), description: z.string().optional(), dateDependencySettings: z.record(z.string(), z.any()).optional().describe("Date dependency settings, in Airtable's format") }),
  create_field: r("POST", "/v0/meta/bases/{base_id}/tables/{table_id}/fields", "Add a field (column) to a table.", { base_id: baseId, table_id: tableId, name: z.string().min(1).describe("The field's name"), type: z.string().min(1).describe('Its type, e.g. "singleLineText", "number", "singleSelect"'), description: z.string().optional(), options: z.record(z.string(), z.any()).optional().describe("Settings some types need, e.g. a singleSelect's choices") }),
  update_field: r("PATCH", "/v0/meta/bases/{base_id}/tables/{table_id}/fields/{field_id}", "Rename a field or change its description or options.", { base_id: baseId, table_id: tableId, field_id: fieldId, name: z.string().optional(), description: z.string().optional(), options: z.record(z.string(), z.any()).optional().describe("New settings for the field's type") }),
  list_views: withList("GET", "/v0/meta/bases/{base_id}/views", "A base's views (Enterprise plan; airtable.get_base_schema shows them on every plan).", { base_id: baseId, include: include(VISIBLE) }, "include", true),
  get_view_metadata: withList("GET", "/v0/meta/bases/{base_id}/views/{view_id}", "One view's details (Enterprise plan).", { base_id: baseId, view_id: viewId, include: include(VISIBLE) }, "include", true),
  delete_view: r("DELETE", "/v0/meta/bases/{base_id}/views/{view_id}", "Delete a view (Enterprise plan). Its records stay.", { base_id: baseId, view_id: viewId }),
};
