import { expect, test } from "bun:test";
import { parseNextStep } from "./chat";

const card = { summary: "Invoice sent to Acme, payment pending.", question: "Should I remind them on Friday?", buttons: ["Yes, remind them", "Not yet"] };

test("a well-formed card is read, even wrapped in a code fence", () => {
  expect(parseNextStep(JSON.stringify(card))).toEqual(card);
  expect(parseNextStep("```json\n" + JSON.stringify(card) + "\n```")).toEqual(card);
});

test("silence or a broken card shows nothing", () => {
  expect(parseNextStep("[SILENT]")).toBeNull();
  expect(parseNextStep('{"summary": "cut off')).toBeNull();
  expect(parseNextStep(JSON.stringify({ ...card, buttons: ["Only one"] }))).toBeNull();
  expect(parseNextStep(JSON.stringify({ ...card, question: "" }))).toBeNull();
});
