// Records (rows), their comments and attachments.
import { z } from "zod";
import { AppFile, AppsError } from "../../types";
import type { OwnAction } from "../index";
import { call } from "../openapi";
import { api, baseId, byFieldId, fields, r, recordId, table, typecast, withList } from "./client";

const where = { base_id: baseId, table };
const one = { ...where, record_id: recordId };
const merge = z.object({ fieldsToMergeOn: z.array(z.string()).min(1).max(3).describe("One to three fields whose values identify the same record") }).optional().describe("Update the matching record, or add a new one if none matches, comparing these fields");
const updates = z.array(z.object({ id: z.string().optional().describe("The record's id (not needed with performUpsert)"), fields })).min(1).max(10).describe("The records to change, up to 10 per call");
const CSV_API = { ...api, upload: (_f: AppFile, _s: unknown, headers: Record<string, string>) => void (headers["Content-Type"] = "text/csv") };
const MAX_UPLOAD = 5 * 1024 * 1024;

const updateMany = (method: "PATCH" | "PUT", note: string) =>
  r(method, "/v0/{base_id}/{table}", `Change up to 10 records at once, or upsert them with performUpsert. ${note}`, { ...where, records: updates, typecast, returnFieldsByFieldId: byFieldId, performUpsert: merge });

export const recordActions: Record<string, OwnAction> = {
  list_records: r(
    "POST",
    "/v0/{base_id}/{table}/listRecords",
    "Read records from a table, up to 100 at a time; offset in the answer gets the next page.",
    {
      ...where,
      view: z.string().optional().describe("Only the records in this view, in its order (view name or id)"),
      fields: z.array(z.string()).optional().describe("Only these fields (names or ids). Leave out for every field"),
      filterByFormula: z.string().optional().describe('Only records where this Airtable formula is true, e.g. {Status} = "Open"'),
      sort: z.array(z.object({ field: z.string(), direction: z.enum(["asc", "desc"]).optional() })).optional().describe('Sort order, e.g. [{"field": "Created", "direction": "desc"}]'),
      maxRecords: z.number().int().positive().optional().describe("The most records to return in all"),
      pageSize: z.number().int().min(1).max(100).optional().describe("Records per page (1-100, default 100)"),
      offset: z.string().optional().describe("Next page: the offset the last answer gave"),
      cellFormat: z.enum(["json", "string"]).optional().describe("string gives cells as shown in Airtable, and then needs timeZone and userLocale"),
      timeZone: z.string().optional().describe("For cellFormat string: e.g. Asia/Kolkata"),
      userLocale: z.string().optional().describe("For cellFormat string: e.g. en-in"),
      returnFieldsByFieldId: byFieldId,
      recordMetadata: z.array(z.enum(["commentCount"])).optional().describe('Add ["commentCount"] to get each record\'s comment count'),
    },
    { readOnly: true },
  ),
  get_record: r("GET", "/v0/{base_id}/{table}/{record_id}", "Read one record and its cells, including attachment links (which expire after a couple of hours).", {
    ...one,
    cellFormat: z.enum(["json", "string"]).optional().describe("string gives cells as shown in Airtable"),
    returnFieldsByFieldId: byFieldId,
  }),
  create_record: r("POST", "/v0/{base_id}/{table}", "Add one record to a table.", { ...where, fields, typecast, returnFieldsByFieldId: byFieldId }),
  create_records: r("POST", "/v0/{base_id}/{table}", "Add up to 10 records to a table in one call.", {
    ...where,
    records: z.array(z.object({ fields })).min(1).max(10).describe('The records, up to 10 per call: [{"fields": {"Name": "Asha"}}]'),
    typecast,
    returnFieldsByFieldId: byFieldId,
  }),
  update_record: r("PATCH", "/v0/{base_id}/{table}/{record_id}", "Change some cells of a record; cells left out stay as they are.", { ...one, fields, typecast, returnFieldsByFieldId: byFieldId }),
  update_record_put: r("PUT", "/v0/{base_id}/{table}/{record_id}", "Replace a whole record: cells left out are cleared.", { ...one, fields, typecast, returnFieldsByFieldId: byFieldId }),
  update_multiple_records: updateMany("PATCH", "Cells left out stay as they are."),
  update_multiple_records_put: updateMany("PUT", "Cells left out are cleared."),
  delete_record: r("DELETE", "/v0/{base_id}/{table}/{record_id}", "Delete one record.", one),
  delete_multiple_records: withList("DELETE", "/v0/{base_id}/{table}", "Delete up to 10 records at once.", { ...where, records: z.array(z.string()).min(1).max(10).describe("The ids of the records to delete, up to 10") }, "records", false),
  get_attachment_info: {
    description: "The files in one attachment cell of a record: name, type, size and download links (which expire after a couple of hours).",
    readOnly: true,
    input: z.object({ ...one, field: z.string().describe("The attachment field's name") }),
    async run(i: { base_id: string; table: string; record_id: string; field: string }, key: string) {
      const record = (await call(api, key, { method: "GET", path: "/v0/{base_id}/{table}/{record_id}", query: [], headers: [] }, i)) as { fields?: Record<string, unknown> };
      return { attachments: record.fields?.[i.field] ?? [] };
    },
  },
  upload_attachment: {
    description: "Add a file from the computer (up to 5 MB) to an attachment cell of a record.",
    input: z.object({
      base_id: baseId,
      record_id: recordId,
      field: z.string().min(1).describe("The attachment field's name or id"),
      file: z.any().describe('A file from the computer: {"file": "/work/..."}'),
      filename: z.string().optional().describe("The name to give it (default: the file's own)"),
    }),
    run: (i: { base_id: string; record_id: string; field: string; file: unknown; filename?: string }, key: string) => {
      if (!(i.file instanceof AppFile)) throw new AppsError('file: give the file as {"file": "/work/..."}');
      if (i.file.bytes.length > MAX_UPLOAD) throw new AppsError("Airtable takes files up to 5 MB this way; give a public link in the cell's url for anything larger");
      const send = { method: "POST", base: "https://content.airtable.com", path: "/v0/{base_id}/{record_id}/{field}/uploadAttachment", query: [], headers: [], body: { kind: "whole" as const, field: "body" } };
      return call(api, key, send, { ...i, body: { contentType: i.file.mimetype, filename: i.filename ?? i.file.name, file: Buffer.from(i.file.bytes).toString("base64") } });
    },
  },
  sync_csv_data: {
    description: "Push CSV text into a Sync API table (Airtable Pro or Enterprise; the sync is first set up in Airtable). Up to 10,000 rows and 2 MB.",
    input: z.object({ ...where, sync_id: z.string().min(1).describe("The sync's id, from the table's sync settings"), csv: z.string().min(1).describe("The CSV text, header row first") }),
    run: (i: { base_id: string; table: string; sync_id: string; csv: string }, key: string) =>
      call(CSV_API, key, { method: "POST", path: "/v0/{base_id}/{table}/sync/{sync_id}", query: [], headers: [], body: { kind: "file", field: "data" } }, { ...i, data: new AppFile("data.csv", "text/csv", new TextEncoder().encode(i.csv)) }),
  },
  update_date_dependency_metadata: r("PATCH", "/v0/{base_id}/{table}/{record_id}/dateDependencyMetadata", "Set which record this one depends on, in a table with date dependencies turned on (Airtable may not have this switched on for every account).", {
    ...one,
    predecessorRecordId: z.string().nullable().optional().describe("The record this one comes after; null clears it"),
    dateDependencyMetadata: z.record(z.string(), z.any()).optional().describe("The dependency settings, in Airtable's format"),
  }),

  // ── comments
  list_comments: r("GET", "/v0/{base_id}/{table}/{record_id}/comments", "Read a record's comments, newest first; offset in the answer gets the next page.", {
    ...one,
    pageSize: z.number().int().min(1).max(100).optional().describe("Comments per page (1-100, default 100)"),
    offset: z.string().optional().describe("Next page: the offset the last answer gave"),
  }),
  create_comment: r("POST", "/v0/{base_id}/{table}/{record_id}/comments", "Add a comment to a record. Mention someone with @[usrXXX].", {
    ...one,
    text: z.string().min(1).describe("The comment"),
    parentCommentId: z.string().optional().describe("To reply in a thread: the comment being replied to"),
  }),
  update_comment: r("PATCH", "/v0/{base_id}/{table}/{record_id}/comments/{comment_id}", "Change the text of a comment (only the token's own comments).", { ...one, comment_id: z.string().min(1).describe("The comment's id, from airtable.list_comments"), text: z.string().min(1).describe("The new text") }),
  delete_comment: r("DELETE", "/v0/{base_id}/{table}/{record_id}/comments/{comment_id}", "Delete a comment.", { ...one, comment_id: z.string().min(1).describe("The comment's id, from airtable.list_comments") }),
};
