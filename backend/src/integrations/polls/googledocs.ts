import { z } from "zod";
import { plainText } from "../own/googledocs/text";
import { recent, type PollTrigger, type Run } from "./index";

const stamp = (v: unknown) => Bun.hash(JSON.stringify(v)).toString(36);
const DOC = { document_id: z.string().describe("The document to watch: the long part of its link, docs.google.com/document/d/<id>/edit") };
const ONE_DOC = "Watches one document";
const ONLY_OURS = "Only documents Emplio made: Google doesn't let it see the rest of the person's Drive";
const docOut: PollTrigger["output"] = [
  { name: "document_id", type: "string", required: true, description: "The document's id" },
  { name: "title", type: "string", required: true, description: "Its title" },
];
const fileOut: PollTrigger["output"] = [{ name: "file", type: "object", required: true, description: "The Drive file: id, name, mimeType, createdTime, modifiedTime, webViewLink" }];

const read = (run: Run, id: string) => run("googledocs.get_document_by_id", { documentId: id }) as Promise<any>;
const text = (doc: any) => plainText(doc.body?.content);
const files = (run: Run, input: Record<string, unknown> = {}) => run("googledocs.search_documents", { pageSize: 100, ...input }).then((r: any) => (r.files ?? []) as any[]);

const watched = (description: string, config: z.ZodRawShape, poll: (c: any, doc: any) => { id: string; item?: Record<string, unknown> }[]): PollTrigger => ({
  description: `${description}. ${ONE_DOC}.`,
  config: z.object({ ...DOC, ...config }),
  output: docOut,
  every: 5,
  min: 5,
  poll: async (c, run) => {
    const doc = await read(run, c.document_id);
    return poll(c, doc).map((p) => ({ id: p.id, item: { document_id: c.document_id, title: doc.title, ...p.item } }));
  },
});
const inDrive = (description: string, input: (c: any) => Record<string, unknown>, keep: (f: any) => boolean, id: (f: any) => string = (f) => f.id, config: z.ZodRawShape = {}): PollTrigger => ({
  description: `${description}. ${ONLY_OURS}.`,
  config: z.object(config),
  output: fileOut,
  every: 5,
  min: 5,
  poll: async (c, run) => (await files(run, input(c))).filter(keep).map((file) => ({ id: id(file), item: { file } })),
});

const created = inDrive("A new document appears", () => ({ orderBy: "createdTime desc" }), (f) => recent(f.createdTime));

export const googledocs: Record<string, PollTrigger> = {
  document_created_trigger: created,
  // Composio's trigger of this name is the same "new document" event; Docs has no page events
  page_added_trigger: created,
  document_deleted_trigger: inDrive("A document is moved to the trash", () => ({ trashed: true }), () => true),
  folder_created_trigger: inDrive("A new folder appears", () => ({ mimeType: "application/vnd.google-apps.folder", orderBy: "createdTime desc" }), (f) => recent(f.createdTime)),
  document_search_update_trigger: inDrive(
    "A document matching a search is created or changed",
    (c) => ({ name: c.name, text: c.text }),
    (f) => recent(f.modifiedTime),
    (f) => `${f.id}:${f.modifiedTime}`,
    { name: z.string().optional().describe("Names containing this"), text: z.string().optional().describe("Documents containing this text") },
  ),
  document_updated_trigger: watched("A document is edited", {}, (_c, doc) => [{ id: String(doc.revisionId), item: { revision_id: doc.revisionId } }]),
  document_placeholder_filled_trigger: watched(
    "A placeholder in a document, like {{name}}, is filled in: it was there and now it's gone. The first check notes what's there, so turn this on while the placeholder is still in the document",
    { placeholder: z.string().describe("The exact text to watch for, like {{name}}") },
    (c, doc) => (text(doc).includes(c.placeholder) ? [] : [{ id: `filled:${c.placeholder}` }]),
  ),
  document_structure_changed_trigger: watched("A document's layout changes: headers, footers, footnotes, tables or images added or removed", {}, (_c, doc) => [{
    id: stamp([Object.keys(doc.headers ?? {}), Object.keys(doc.footers ?? {}), Object.keys(doc.footnotes ?? {}), (doc.body?.content ?? []).filter((s: any) => s.table).length, Object.keys(doc.inlineObjects ?? {}), Object.keys(doc.positionedObjects ?? {})]),
  }]),
  document_word_count_threshold_trigger: watched(
    "A document reaches a number of words or characters",
    { threshold: z.number().int().positive().describe("The number to reach"), unit: z.enum(["words", "characters"]).default("words") },
    (c, doc) => {
      const t = text(doc);
      const count = c.unit === "words" ? t.split(/\s+/).filter(Boolean).length : t.length;
      return count >= c.threshold ? [{ id: `reached:${c.threshold}:${c.unit}`, item: { count } }] : [];
    },
  ),
  keyword_detected_trigger: watched(
    "A word or phrase first appears in a document. It fires once for that word",
    { keyword: z.string().describe("The word or phrase"), match_case: z.boolean().default(false) },
    (c, doc) => {
      const t = text(doc);
      return (c.match_case ? t.includes(c.keyword) : t.toLowerCase().includes(c.keyword.toLowerCase())) ? [{ id: `keyword:${c.keyword}`, item: { keyword: c.keyword } }] : [];
    },
  ),
};
