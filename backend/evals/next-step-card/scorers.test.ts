import { expect, test } from "bun:test";
import { cases } from "./cases";
import { limitsOf, offersNamed, rightCall, withinLimits } from "./scorers";

const card = { summary: "Invoice sent to Acme, payment pending.", question: "Should I remind them on Friday?", buttons: ["Yes, remind them", "Not yet"] };
const args = (output: { card: typeof card | null }, expected: { card: boolean; offers?: string[] }) => ({ input: [], output: { ...output, said: "" }, expected });

test("a card when none was wanted, or none when one was, is the wrong call", () => {
  expect(rightCall(args({ card }, { card: true })).score).toBe(1);
  expect(rightCall(args({ card: null }, { card: false })).score).toBe(1);
  expect(rightCall(args({ card }, { card: false })).score).toBe(0);
  expect(rightCall(args({ card: null }, { card: true })).score).toBe(0);
});

test("a card over its size is marked", () => {
  expect(limitsOf(card)).toEqual([]);
  expect(limitsOf({ ...card, buttons: ["Yes please go ahead now", "No"] })).toHaveLength(1);
  expect(withinLimits(args({ card: null }, { card: false })).score).toBeNull();
});

test("named choices must be on the buttons", () => {
  const daily = { ...card, buttons: ["Daily", "Weekly"] };
  expect(offersNamed(args({ card: daily }, { card: true, offers: ["daily", "weekly"] })).score).toBe(1);
  expect(offersNamed(args({ card }, { card: true, offers: ["daily", "weekly"] })).score).toBe(0);
  expect(offersNamed(args({ card }, { card: true })).score).toBeNull();
});

test("every case ends on Emplio's reply and has its own name", () => {
  for (const c of cases) expect(c.chat.at(-1)?.role).toBe("assistant");
  expect(new Set(cases.map((c) => c.name)).size).toBe(cases.length);
});
