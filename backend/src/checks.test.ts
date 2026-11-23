import { expect, test } from "bun:test";
import { badEnding, doneProblem, ENDINGS, shapeProblem, statusOf } from "./checks";

const report = (status: string, checked = "Checked: read back invoice INV-1 in Zoho; 52 of 52 imported") =>
  `Status: ${status}\nResult: imported 52 invoices\n${checked}\nFiles: none\nChanged outside: 52 invoices in Zoho\nLeft: nothing`;

test("a run that ended badly is sent back with what to do", () => {
  expect(badEnding({ text: "", reasoned: false })).toBe(ENDINGS.empty);
  expect(badEnding({ text: "", reasoned: true })).toBe(ENDINGS.thought);
  expect(badEnding({ text: report("Done"), reasoned: false, finishReason: "length" })).toBe(ENDINGS.cut);
  expect(badEnding({ text: "Running it:\n```python\nimport emplio\nprint(emplio.files.list())\n```", reasoned: false })).toBe(ENDINGS.code);
  expect(badEnding({ text: "The files tie out. Next I'll compute the balances.", reasoned: false })).toBe(ENDINGS.announced);
  expect(badEnding({ text: report("Done"), reasoned: false, finishReason: "stop" })).toBeNull();
});

test("a report is in shape with its status first, and a Done says how it was checked", () => {
  expect(statusOf(report("Partly done"))).toBe("partly done");
  expect(statusOf("**Status:** Blocked")).toBe("blocked");
  expect(shapeProblem(report("Done"))).toBeNull();
  expect(shapeProblem(report("Blocked", ""))).toBeNull();
  expect(shapeProblem("All done! Imported everything.")).not.toBeNull();
  expect(shapeProblem(report("Done", ""))).not.toBeNull();
});

test("a Done with steps not ticked or a failed last command is asked about once", () => {
  const clean = { open: [], lastFailed: null, askedBefore: false };
  expect(doneProblem(report("Done"), clean)).toBeNull();
  expect(doneProblem(report("Done"), { ...clean, open: ["Import March"] })).toContain('"Import March"');
  expect(doneProblem(report("Done"), { ...clean, lastFailed: "Save invoices" })).toContain('"Save invoices"');
  // not Done: nothing to hold against it; asked once already: the job's word stands
  expect(doneProblem(report("Partly done"), { ...clean, open: ["Import March"] })).toBeNull();
  expect(doneProblem(report("Done"), { ...clean, open: ["Import March"], askedBefore: true })).toBeNull();
});
