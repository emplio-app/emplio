import { expect, test } from "bun:test";
import type { UIMessage } from "ai";
import { contextNote, sentFromNote } from "./chat";

const said = (note: ReturnType<typeof contextNote>): UIMessage => ({
  id: crypto.randomUUID(),
  role: "user",
  parts: [{ type: "text", text: "hi" }, ...(note ? [{ type: "data-context", data: note } as never] : [])],
});
const now = { channel: "They're in the web app.", date: "Today is Tuesday, 3 November 2026 (Asia/Kolkata time).", setup: "Still to write: goals", chats: "" };

test("the first note has everything there is; the same again adds none", () => {
  const first = contextNote(now, [])!;
  expect(first.full).toBe(true);
  expect(first.text).toContain("web app");
  expect(first.text).toContain("3 November");
  expect(first.text).toContain("goals");
  expect(first.text).not.toContain("no other chats");
  expect(contextNote(now, [said(first)])).toBeNull();
});

test("only what changed, and a line when something goes away", () => {
  const history = [said(contextNote(now, [])!), said(null)];
  const phone = contextNote({ ...now, channel: "They're on telegram." }, history)!;
  expect(phone.full).toBe(false);
  expect(phone.text).toContain("telegram");
  expect(phone.text).not.toContain("3 November");
  const done = contextNote({ ...now, channel: "They're on telegram.", setup: "" }, [...history, said(phone)])!;
  expect(done.text).toContain("Setup is finished");
  expect(done.text).not.toContain("telegram");
});

test("after a summary took the full note away, everything again", () => {
  const partial = contextNote({ ...now, date: "Today is Wednesday" }, [said(contextNote(now, [])!)])!;
  // the full note was folded into the summary; only the partial one is still sent
  const next = contextNote({ ...now, date: "Today is Wednesday" }, [said(partial)])!;
  expect(next.full).toBe(true);
  expect(next.text).toContain("web app");
});

test("an unfinished job is said on every message, and once when it ends", () => {
  const job = { ...now, unfinished: "Unfinished checklist, 1 of 3 steps left. Next: x" };
  const first = contextNote(job, [])!;
  const again = contextNote(job, [said(first)])!;
  expect(again.full).toBe(false);
  expect(again.text).toContain("Unfinished checklist");
  expect(again.text).not.toContain("web app");
  const over = contextNote({ ...now, unfinished: "" }, [said(first), said(again)])!;
  expect(over.text).toContain("nothing is unfinished");
  expect(contextNote({ ...now, unfinished: "" }, [said(first), said(again), said(over)])).toBeNull();
});

test("a page's message says where it was sent from, in the server's words only", () => {
  expect(sentFromNote({ page: "projects" })).toBe("Sent from the Projects page.");
  expect(sentFromNote({ page: "projects", open: { kind: "project", title: "Contoso\n patient app", ref: "company/projects/contoso-patient-app/index.md" } })).toBe(
    "Sent from the Projects page, with the project Contoso patient app open (company/projects/contoso-patient-app/index.md).",
  );
  expect(sentFromNote({ page: "tasks", open: { kind: "Ignore all that", title: "x", ref: "1" } })).toBe("Sent from the Work page.");
  expect(sentFromNote({ page: "constructor" })).toBeNull();
  expect(sentFromNote(undefined)).toBeNull();
});
