import { afterEach, expect, test } from "bun:test";
import { z } from "zod";
import { pollOnce } from "../../polls/index";
import { AppFile } from "../../types";
import { own } from "../index";
import { googledocs } from "./index";
import { markdownRequests, plainText } from "./text";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
type Call = { url: URL; method: string; body: any };
const stub = (answer: (c: Call) => Response) => {
  const calls: Call[] = [];
  globalThis.fetch = (async (url: string, init: RequestInit = {}) => {
    const c = { url: new URL(String(url)), method: init.method ?? "GET", body: init.body ? JSON.parse(String(init.body)) : undefined };
    calls.push(c);
    return answer(c);
  }) as typeof fetch;
  return calls;
};
const login = { externalId: "c1", secret: "tok" };
const run = (a: string, i: unknown) => own.run(a, i, login, "o");
const para = (text: string, startIndex = 1) => ({ startIndex, endIndex: startIndex + text.length, paragraph: { elements: [{ textRun: { content: text } }] } });

test("reads run unasked, writes ask, every input is a usable schema", async () => {
  for (const r of ["get_document_by_id", "get_document_plaintext", "get_document_end_index", "search_documents", "get_docs_drive_file_metadata", "list_drive_item_permissions", "export_document_as_pdf"]) expect((await own.getAction(`googledocs.${r}`))?.readOnly, r).toBe(true);
  for (const w of ["create_document", "update_document_batch", "insert_text_action", "replace_all_text", "delete_content_range", "create_document_markdown", "update_document_markdown", "create_and_populate_table", "copy_document", "upload_drive_file"]) expect((await own.getAction(`googledocs.${w}`))?.readOnly, w).toBeFalsy();
  for (const a of Object.values(googledocs.actions)) z.toJSONSchema(a.input, { io: "input" });
});

test("batchUpdate reaches Google whole; requests are sent nested, as written", async () => {
  const calls = stub(() => json({ replies: [] }));
  const requests = [{ insertText: { location: { index: 1 }, text: "hi" } }];
  await run("googledocs.update_document_batch", { documentId: "d1", requests });
  expect(calls[0]!.url.href).toBe("https://docs.googleapis.com/v1/documents/d1:batchUpdate");
  expect(calls[0]!.body).toEqual({ requests });
});

test("insert_text adds at the end unless told where; replace_all_text fills templates", async () => {
  const calls = stub(() => json({ replies: [] }));
  await run("googledocs.insert_text_action", { documentId: "d1", text: "x" });
  expect(calls[0]!.body.requests).toEqual([{ insertText: { text: "x", endOfSegmentLocation: {} } }]);
  await run("googledocs.insert_text_action", { documentId: "d1", text: "x", index: 5 });
  expect(calls[1]!.body.requests).toEqual([{ insertText: { text: "x", location: { index: 5 } } }]);
  await run("googledocs.replace_all_text", { documentId: "d1", find: "{{name}}", replace: "Asha" });
  expect(calls[2]!.body.requests).toEqual([{ replaceAllText: { containsText: { text: "{{name}}", matchCase: true }, replaceText: "Asha" } }]);
});

test("Markdown becomes text with headings, bold and bullets at the right positions", () => {
  const r = markdownRequests("# Hi\nsee **this**\n- one\n- two", 1);
  expect(r[0].insertText.text).toBe("Hi\nsee this\none\ntwo\n");
  const bold = r.find((x) => x.updateTextStyle);
  expect(bold.updateTextStyle.range).toEqual({ startIndex: 8, endIndex: 12 });
  expect(bold.updateTextStyle.textStyle).toEqual({ bold: true });
  expect(r.find((x) => x.updateParagraphStyle).updateParagraphStyle.paragraphStyle.namedStyleType).toBe("HEADING_1");
  const list = r.filter((x) => x.createParagraphBullets);
  expect(list).toHaveLength(1);
  expect(list[0].createParagraphBullets.range).toEqual({ startIndex: 13, endIndex: 21 });
});

test("update_document_markdown clears the body first; a blank document has nothing to clear", async () => {
  const calls = stub((c) => (c.method === "GET" ? json({ body: { content: [para("hello\n")] } }) : json({ replies: [] })));
  await run("googledocs.update_document_markdown", { documentId: "d1", markdown: "New" });
  expect(calls[1]!.body.requests[0]).toEqual({ deleteContentRange: { range: { startIndex: 1, endIndex: 6 } } });
  expect(calls[1]!.body.requests[1].insertText.location).toEqual({ index: 1 });
  const blank = stub((c) => (c.method === "GET" ? json({ body: { content: [{ endIndex: 2 }] } }) : json({ replies: [] })));
  await run("googledocs.update_document_markdown", { documentId: "d1", markdown: "New" });
  expect(blank[1]!.body.requests[0].insertText).toBeDefined();
});

test("plain text and a cell found by position", async () => {
  const table = { startIndex: 5, table: { tableRows: [{ tableCells: [{ content: [para("A\n", 7)] }, { content: [para("B\n", 9)] }] }] } };
  expect(plainText([para("hi\n"), table])).toBe("hi\nA\tB\n");
  const calls = stub((c) => (c.method === "GET" ? json({ body: { content: [para("hi\n"), table] } }) : json({ replies: [] })));
  await run("googledocs.insert_text_in_table_cell", { documentId: "d1", row: 0, column: 1, text: "Z" });
  expect(calls[1]!.body.requests).toEqual([{ insertText: { text: "Z", location: { index: 9 } } }]);
  await expect(run("googledocs.insert_text_in_table_cell", { documentId: "d1", table: 3, row: 0, column: 0, text: "Z" })).rejects.toThrow("there is no table 4");
});

test("Drive reach: search is only documents and says so; a file Drive won't show gets an honest message; export comes back as a file", async () => {
  expect((await own.getAction("googledocs.search_documents"))!.description).toContain("files it made");
  const calls = stub(() => json({ files: [] }));
  await run("googledocs.search_documents", { name: "Q3" });
  expect(calls[0]!.url.searchParams.get("q")).toBe("mimeType = 'application/vnd.google-apps.document' and trashed = false and name contains 'Q3'");
  stub(() => json({ error: { message: "File not found" } }, 404));
  await expect(run("googledocs.get_docs_drive_file_metadata", { fileId: "x" })).rejects.toThrow("files it made");
  globalThis.fetch = (async () => new Response(new Uint8Array([1, 2]), { headers: { "content-type": "application/pdf" } })) as unknown as typeof fetch;
  const pdf = await run("googledocs.export_document_as_pdf", { fileId: "d1" });
  expect(pdf).toBeInstanceOf(AppFile);
  expect((pdf as AppFile).name).toBe("d1.pdf");
});

test("polled: a document's new revision is reported, then only when it changes again", async () => {
  let revisionId = "r1";
  const calls = stub(() => json({ title: "Plan", revisionId, body: { content: [para("hello\n")] } }));
  const first = await pollOnce("googledocs.document_updated_trigger", { document_id: "d1" }, null, run);
  expect(first.fresh).toEqual([]);
  expect(calls[0]!.url.pathname).toBe("/v1/documents/d1");
  revisionId = "r2";
  const later = await pollOnce("googledocs.document_updated_trigger", { document_id: "d1" }, first.seen, run);
  expect(later.fresh).toEqual([{ document_id: "d1", title: "Plan", revision_id: "r2" }]);
  expect((await pollOnce("googledocs.document_updated_trigger", { document_id: "d1" }, later.seen, run)).fresh).toEqual([]);
});

test("polled: the placeholder is gone, the keyword appears, only once", async () => {
  let text = "Dear {{name}},\n";
  stub(() => json({ title: "T", revisionId: "r", body: { content: [para(text)] } }));
  const c = { document_id: "d1", placeholder: "{{name}}" };
  const before = await pollOnce("googledocs.document_placeholder_filled_trigger", c, null, run);
  expect(before.fresh).toEqual([]);
  text = "Dear Asha,\n";
  const after = await pollOnce("googledocs.document_placeholder_filled_trigger", c, before.seen, run);
  expect(after.fresh).toHaveLength(1);
  expect((await pollOnce("googledocs.document_placeholder_filled_trigger", c, after.seen, run)).fresh).toEqual([]);
  const k = { document_id: "d1", keyword: "URGENT" };
  const none = await pollOnce("googledocs.keyword_detected_trigger", k, null, run);
  text = "this is urgent\n";
  expect((await pollOnce("googledocs.keyword_detected_trigger", k, none.seen, run)).fresh).toHaveLength(1);
});

test("polled: new documents are only ones Google lets Emplio see", async () => {
  const calls = stub(() => json({ files: [{ id: "f1", createdTime: new Date().toISOString() }] }));
  const out = await pollOnce("googledocs.document_created_trigger", {}, [], run);
  expect((out.fresh[0] as any).file.id).toBe("f1");
  expect(calls[0]!.url.href).toStartWith("https://www.googleapis.com/drive/v3/files?");
});
