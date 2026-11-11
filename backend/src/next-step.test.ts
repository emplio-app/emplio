import { expect, test } from "bun:test";
import { parseNextStep, promises } from "./next-step";

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

test("a button that only promises an answer drops the card; a real go-ahead doesn't", () => {
  for (const b of ["Send the repo", "I'll share it", "I’ll type it", "Yes, I'll send them", "Share the link", "Tell you later", "Send my logo", "Name the repository"]) expect(promises(b)).toBe(true);
  for (const b of ["Yes, send it", "Send it", "Send the email", "Not yet", "Daily", "Weekly", "Yes, share it", "Yes, send them", "I'll decide later", "Let me think"]) expect(promises(b)).toBe(false);
  expect(parseNextStep(JSON.stringify({ ...card, buttons: ["Send the repo", "Not yet"] }))).toBeNull();
});
