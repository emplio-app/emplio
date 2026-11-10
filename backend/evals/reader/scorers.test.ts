import { expect, test } from "bun:test";
import { keepsShape, kindsOf, rightCall } from "./scorers";

const args = (output: string, expected: { silent: boolean; kinds?: string[][] }) => ({ input: null, output, expected });

test("the kinds in a note are read from how its lines start", () => {
  expect(kindsOf("Fact: shop opens 10:30\nURGENT: Promise: PO by Wednesday\n- Couldn’t: open the bank site")).toEqual(["Fact", "Promise", "Couldn't"]);
});

test("silent when nothing, every wanted kind when something", () => {
  expect(rightCall(args("[SILENT]", { silent: true })).score).toBe(1);
  expect(rightCall(args("Fact: x", { silent: true })).score).toBe(0);
  expect(rightCall(args("[SILENT]", { silent: false, kinds: [["Fact"]] })).score).toBe(0);
  expect(rightCall(args("Way: add back the fee", { silent: false, kinds: [["Way", "Repeated"]] })).score).toBe(1);
  expect(rightCall(args("Fact: x", { silent: false, kinds: [["Fact"], ["Promise"]] })).score).toBe(0);
});

test("a line with no kind breaks the shape", () => {
  expect(keepsShape(args("Fact: x\nPromise: y", { silent: true })).score).toBe(1);
  expect(keepsShape(args("Here is what I found:\nFact: x", { silent: true })).score).toBe(0);
});
