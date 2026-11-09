// Google Docs on sign-in: the API's three methods from its Discovery document (`bun scripts/openapi-actions.ts googledocs`), each request
// inside batchUpdate as its own action the way Composio had them, and Markdown both ways. Drive reach is limited to files Emplio made (google-drive.ts).
import { z } from "zod";
import { AppsError } from "../../types";
import { copyFile, createFile, exportFile, fileMetadata, filePermissions, searchFiles, uploadFile } from "../google-drive";
import { googleApi, googleCheck, googleOAuth } from "../google-login";
import type { OwnAction, OwnApp } from "../index";
import { call, type Send, specActions } from "../openapi";
import { markdownRequests, plainText } from "./text";

const api = googleApi("Google Docs", "https://docs.googleapis.com");
const actions = await specActions(new URL("./actions.json", import.meta.url), api);

const BATCH: Send = { method: "POST", path: "/v1/documents/{documentId}:batchUpdate", query: [], headers: [], body: { kind: "fields", fields: [["requests", "requests"]] } };
const GET_DOC: Send = { method: "GET", path: "/v1/documents/{documentId}", query: ["includeTabsContent"], headers: [] };
const CREATE: Send = { method: "POST", path: "/v1/documents", query: [], headers: [], body: { kind: "fields", fields: [["title", "title"]] } };

export const DOCUMENT_ID = z.string().describe("The document's id, the long part of its link: docs.google.com/document/d/<id>/edit");
const tabId = z.string().optional().describe("Which tab, for a document with several (default: the first)");
const index = z.number().int().optional().describe("Where, counted in characters from the start of the document (1 is the very start). Leave out for the end. googledocs.get_document_by_id shows positions");
const open = z.record(z.string(), z.any());
const range = open.describe('From and to, as character positions: {"startIndex": 5, "endIndex": 20}, and "tabId" for another tab');
const cell = open.describe('A table cell: {"tableStartLocation": {"index": <where the table starts>}, "rowIndex": 0, "columnIndex": 0}');
const at = (i: { index?: number; tabId?: string }) => (i.index !== undefined ? { location: { index: i.index, ...(i.tabId && { tabId: i.tabId }) } } : { endOfSegmentLocation: i.tabId ? { tabId: i.tabId } : {} });

const batch = (key: string, documentId: string, requests: unknown[]) => call(api, key, BATCH, { documentId, requests });
const read = (key: string, documentId: string, tab?: string) => call(api, key, GET_DOC, { documentId, ...(tab && { includeTabsContent: true }) }) as Promise<any>;
// the content of the first tab, or the one asked for
const bodyOf = (doc: any, tab?: string): any[] => {
  if (!tab) return doc.body?.content ?? [];
  const find = (tabs: any[] = []): any => { for (const t of tabs) { if (t.tabProperties?.tabId === tab) return t; const c = find(t.childTabs); if (c) return c; } };
  const hit = find(doc.tabs);
  if (!hit) throw new AppsError(`this document has no tab ${tab}`);
  return hit.documentTab?.body?.content ?? [];
};
const endOf = (content: any[]) => (content.at(-1)?.endIndex ?? 2) as number;

// one of batchUpdate's requests as an action; `build` turns the input into the request
const one = (request: string, description: string, shape: z.ZodRawShape, build: (i: any) => unknown = (i) => i): OwnAction => ({
  description,
  input: z.object({ documentId: DOCUMENT_ID, ...shape }).loose(),
  run: ({ documentId, ...rest }, key) => batch(key, documentId, [{ [request]: build(rest) }]),
});

const singles: Record<string, OwnAction> = {
  insert_text_action: one("insertText", "Add text to a document, at the end or at a given position.", { text: z.string().describe("The text to add"), index, tabId }, ({ text, ...i }) => ({ text, ...at(i) })),
  replace_all_text: one("replaceAllText", 'Replace every occurrence of some text in the document. Handy for filling in a template\'s {{placeholders}}.', { find: z.string().describe("The text to find"), replace: z.string().describe("What to put instead"), matchCase: z.boolean().default(true).describe("Whether capitals must match") }, (i) => ({ containsText: { text: i.find, matchCase: i.matchCase }, replaceText: i.replace })),
  delete_content_range: one("deleteContentRange", "Delete a stretch of the document.", { range }),
  insert_page_break: one("insertPageBreak", "Add a page break, at the end or at a given position.", { index, tabId }, at),
  insert_table_action: one("insertTable", "Add an empty table, at the end or at a given position.", { rows: z.number().int().describe("How many rows"), columns: z.number().int().describe("How many columns"), index, tabId }, ({ rows, columns, ...i }) => ({ rows, columns, ...at(i) })),
  insert_inline_image: one("insertInlineImage", "Add an image from a public web address, at the end or at a given position.", { uri: z.string().describe("A public link to a PNG, JPEG or GIF under 50 MB"), objectSize: open.optional().describe('Its size: {"width": {"magnitude": 300, "unit": "PT"}, "height": {...}}'), index, tabId }, ({ uri, objectSize, ...i }) => ({ uri, objectSize, ...at(i) })),
  create_footer: one("createFooter", "Add a footer to the document.", { type: z.string().default("DEFAULT").describe("The footer type") }),
  create_header: one("createHeader", "Add a header to the document.", { type: z.string().default("DEFAULT").describe("The header type") }),
  create_footnote: one("createFootnote", "Add a footnote at a given position.", { index: z.number().int().describe("Where, in characters from the start") }, ({ index: i }) => ({ location: { index: i } })),
  delete_footer: one("deleteFooter", "Remove a footer.", { footerId: z.string().describe("The footer's id, from googledocs.get_document_by_id") }),
  delete_header: one("deleteHeader", "Remove a header.", { headerId: z.string().describe("The header's id, from googledocs.get_document_by_id") }),
  create_named_range: one("createNamedRange", "Give a stretch of the document a name, so it can be found and replaced later.", { name: z.string().describe("The name"), range }),
  delete_named_range: one("deleteNamedRange", "Remove a named range. The text stays.", { name: z.string().optional().describe("By name"), namedRangeId: z.string().optional().describe("Or by id") }),
  create_paragraph_bullets: one("createParagraphBullets", "Turn paragraphs into a bulleted or numbered list.", { range, bulletPreset: z.string().default("BULLET_DISC_CIRCLE_SQUARE").describe("The list style; NUMBERED_DECIMAL_ALPHA_ROMAN for numbers") }),
  delete_paragraph_bullets: one("deleteParagraphBullets", "Turn list items back into plain paragraphs.", { range }),
  create_tab: one("addDocumentTab", "Add a tab to the document.", { tabProperties: open.optional().describe('Its settings, e.g. {"title": "Notes"}') }),
  delete_tab: one("deleteTab", "Delete a tab and everything in it.", { tabId: z.string().describe("The tab's id") }),
  update_tab_properties: one("updateDocumentTabProperties", "Rename a tab or change its settings.", { tabProperties: open.describe('Its id and the new settings: {"tabId": "t.0", "title": "Notes"}'), fields: z.string().default("title").describe("Which settings to change") }),
  insert_table_row: one("insertTableRow", "Add a row to a table.", { tableCellLocation: cell, insertBelow: z.boolean().default(true) }),
  insert_table_column: one("insertTableColumn", "Add a column to a table.", { tableCellLocation: cell, insertRight: z.boolean().default(true) }),
  delete_table_row: one("deleteTableRow", "Delete a row of a table.", { tableCellLocation: cell }),
  delete_table_column: one("deleteTableColumn", "Delete a column of a table.", { tableCellLocation: cell }),
  unmerge_table_cells: one("unmergeTableCells", "Split merged table cells apart again.", { tableRange: open.describe('{"tableCellLocation": ..., "rowSpan": 1, "columnSpan": 2}') }),
  update_table_row_style: one("updateTableRowStyle", "Change the height of table rows.", { tableStartLocation: open.describe('Where the table starts: {"index": 5}'), rowIndices: z.array(z.number().int()).optional().describe("Which rows (default: all)"), tableRowStyle: open.describe('The style: {"minRowHeight": {"magnitude": 30, "unit": "PT"}}'), fields: z.string().default("minRowHeight").describe("Which settings to change") }),
  replace_image: one("replaceImage", "Swap an image in the document for another.", { imageObjectId: z.string().describe("The image's id, from googledocs.get_document_by_id"), uri: z.string().describe("A public link to the new image"), imageReplaceMethod: z.string().default("CENTER_CROP") }),
  update_document_style: one("updateDocumentStyle", "Change the page: size, margins, background.", { documentStyle: open.describe('The new values, e.g. {"marginTop": {"magnitude": 72, "unit": "PT"}}'), fields: z.string().describe("Which values to change, like marginTop or pageSize") }),
};

// the Nth table in the document, or a clear error
const tableIn = (doc: any, table: number, tab?: string) => {
  const found = bodyOf(doc, tab).filter((s) => s.table);
  if (!found[table]) throw new AppsError(`this document has ${found.length} table(s); there is no table ${table + 1}`);
  return found[table];
};
const cellAt = (t: any, row: number, column: number) => {
  const c = t.table.tableRows[row]?.tableCells[column];
  if (!c) throw new AppsError(`that table has no row ${row + 1}, column ${column + 1}`);
  return c.content[0].startIndex as number;
};
const cellInput = { documentId: DOCUMENT_ID, table: z.number().int().default(0).describe("Which table, counting from 0 (default: the first)"), row: z.number().int().describe("Row, counting from 0"), column: z.number().int().describe("Column, counting from 0"), tabId };

const helpers: Record<string, OwnAction> = {
  get_document_plaintext: { description: "Read a document as plain text.", readOnly: true, input: z.object({ documentId: DOCUMENT_ID, tabId }), run: async (i, key) => { const doc = await read(key, i.documentId, i.tabId); return { title: doc.title, text: plainText(bodyOf(doc, i.tabId)) }; } },
  get_document_end_index: { description: "Find the position of the end of a document, for adding to it.", readOnly: true, input: z.object({ documentId: DOCUMENT_ID, tabId }), run: async (i, key) => { const end = endOf(bodyOf(await read(key, i.documentId, i.tabId), i.tabId)); return { endIndex: end, insertAt: end - 1 }; } },
  create_document_markdown: {
    description: "Make a new document from Markdown (headings, bullets, numbers, bold, italic, code and links).",
    input: z.object({ title: z.string().describe("The document's title"), markdown: z.string().describe("Its content, as Markdown") }),
    async run(i, key) {
      const made = (await call(api, key, CREATE, { title: i.title })) as { documentId: string };
      await batch(key, made.documentId, markdownRequests(i.markdown, 1));
      return { documentId: made.documentId, title: i.title, url: `https://docs.google.com/document/d/${made.documentId}/edit` };
    },
  },
  update_document_markdown: {
    description: "Replace everything in a document (or one tab) with Markdown (headings, bullets, numbers, bold, italic, code and links).",
    input: z.object({ documentId: DOCUMENT_ID, markdown: z.string().describe("The new content, as Markdown"), tabId }),
    async run(i, key) {
      const end = endOf(bodyOf(await read(key, i.documentId, i.tabId), i.tabId));
      const clear = end > 2 ? [{ deleteContentRange: { range: { startIndex: 1, endIndex: end - 1, ...(i.tabId && { tabId: i.tabId }) } } }] : [];
      return batch(key, i.documentId, [...clear, ...markdownRequests(i.markdown, 1, i.tabId)]);
    },
  },
  update_document_section_markdown: {
    description: "Add Markdown to a document, or replace a stretch of it with Markdown. Give startIndex alone to insert there, startIndex and endIndex to replace that stretch, or neither to add at the end.",
    input: z.object({ documentId: DOCUMENT_ID, markdown: z.string().describe("The content, as Markdown"), startIndex: z.number().int().optional().describe("Where it goes, in characters from the start"), endIndex: z.number().int().optional().describe("Where the stretch to replace ends"), tabId }),
    async run(i, key) {
      const start = i.startIndex ?? endOf(bodyOf(await read(key, i.documentId, i.tabId), i.tabId)) - 1;
      const clear = i.endIndex !== undefined && i.endIndex > start ? [{ deleteContentRange: { range: { startIndex: start, endIndex: i.endIndex, ...(i.tabId && { tabId: i.tabId }) } } }] : [];
      return batch(key, i.documentId, [...clear, ...markdownRequests(i.markdown, start, i.tabId)]);
    },
  },
  create_and_populate_table: {
    description: "Add a table filled with the given rows, at the end or at a given position.",
    input: z.object({ documentId: DOCUMENT_ID, rows: z.array(z.array(z.string())).min(1).describe('The table, row by row: [["Name", "City"], ["Asha", "Pune"]]'), index, tabId }),
    async run(i, key) {
      const before = bodyOf(await read(key, i.documentId, i.tabId), i.tabId).filter((s) => s.table).length;
      const columns = Math.max(...i.rows.map((r: string[]) => r.length));
      await batch(key, i.documentId, [{ insertTable: { rows: i.rows.length, columns, ...at(i) } }]);
      const doc = await read(key, i.documentId, i.tabId);
      // the new table: the one that wasn't there before, or, when added at a position, the first at or after it
      const tables = bodyOf(doc, i.tabId).filter((s) => s.table);
      const t = i.index !== undefined ? tables.find((s) => s.startIndex >= i.index!) : tables[before];
      if (!t) throw new AppsError("the table was added but couldn't be found to fill it");
      // last cell first, so writing one doesn't move the ones still to come
      const requests = i.rows.flatMap((r: string[], row: number) => r.map((text, column) => ({ row, column, text })))
        .filter((c: { text: string }) => c.text)
        .reverse()
        .map((c: { row: number; column: number; text: string }) => ({ insertText: { text: c.text, location: { index: cellAt(t, c.row, c.column), ...(i.tabId && { tabId: i.tabId }) } } }));
      return requests.length ? batch(key, i.documentId, requests) : { ok: true };
    },
  },
  insert_text_in_table_cell: {
    description: "Write text into a table cell, in front of what's there.",
    input: z.object({ ...cellInput, text: z.string().describe("The text") }),
    async run(i, key) {
      const location = { index: cellAt(tableIn(await read(key, i.documentId, i.tabId), i.table, i.tabId), i.row, i.column), ...(i.tabId && { tabId: i.tabId }) };
      return batch(key, i.documentId, [{ insertText: { text: i.text, location } }]);
    },
  },
  insert_image_in_table_cell: {
    description: "Put an image from a public web address into a table cell.",
    input: z.object({ ...cellInput, uri: z.string().describe("A public link to a PNG, JPEG or GIF under 50 MB") }),
    async run(i, key) {
      const location = { index: cellAt(tableIn(await read(key, i.documentId, i.tabId), i.table, i.tabId), i.row, i.column), ...(i.tabId && { tabId: i.tabId }) };
      return batch(key, i.documentId, [{ insertInlineImage: { uri: i.uri, location } }]);
    },
  },
};

export const GOOGLE_DOC = "application/vnd.google-apps.document";
const drive: Record<string, OwnAction> = {
  search_documents: searchFiles(GOOGLE_DOC, "documents"),
  get_docs_drive_file_metadata: fileMetadata,
  list_drive_item_permissions: filePermissions,
  export_document_as_pdf: exportFile({ mimeType: "application/pdf", extension: "pdf" }),
  copy_document: copyFile,
  create_drive_file: createFile,
  upload_drive_file: uploadFile,
};

export const googledocs: OwnApp = {
  app: "googledocs",
  name: "Google Docs",
  logo: "/logos/googledocs.svg",
  check: googleCheck,
  oauth: googleOAuth("Google Docs", "googledocs"),
  actions: { ...actions, ...singles, ...helpers, ...drive, create_document2: actions.create_document!, update_existing_document: actions.update_document_batch! },
};
