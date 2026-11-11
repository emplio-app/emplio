import { expect, test } from "bun:test";
import { cases } from "./cases";
import { picksOf, rightCall, rightPick, staysEmplio } from "./scorers";

const business = { agents: ["- Supplier Finder (agents/supplier-finder, light): Finds suppliers"], threads: ["- 7f3a2c1e · Supplier Finder · Surat · done, 10 Nov"] };
const hand = (pick: string) => [`emplio plan set "a" "b"; emplio hand ${pick} <<'EOF'\nDo the thing\nEOF`];
const args = (commands: string[], expected: { hand: boolean; picks?: never[] | string[] }, text = "") => ({ input: { business, chat: [], world: [] }, output: { text, commands, byHand: 0 }, expected: expected as never });

test("where a hand-off goes is read from the command", () => {
  expect(picksOf(hand("7f3a2c1e"), business)).toEqual(["thread:7f3a2c1e"]);
  expect(picksOf(hand("7f3a"), business)).toEqual(["thread:7f3a2c1e"]);
  expect(picksOf(hand('"Supplier Finder"'), business)).toEqual(["agent:Supplier Finder"]);
  expect(picksOf(hand("supplier-finder"), business)).toEqual(["agent:Supplier Finder"]);
  expect(picksOf(hand('"Price Checker" --description "Checks prices"'), business)).toEqual(["new"]);
  expect(picksOf(hand("myself"), business)).toEqual(["myself"]);
  expect(picksOf(["emplio threads list", "python3 x.py"], business)).toEqual([]);
});

test("handing off when it shouldn't, or not when it should, is the wrong call", () => {
  expect(rightCall(args(hand("myself"), { hand: true })).score).toBe(1);
  expect(rightCall(args(["python3 -c 'print(1)'"], { hand: false })).score).toBe(1);
  expect(rightCall(args([], { hand: true })).score).toBe(0);
  expect(rightCall(args(hand("myself"), { hand: false })).score).toBe(0);
});

test("the pick is marked only when the case names one and a hand-off happened", () => {
  expect(rightPick(args(hand("7f3a2c1e"), { hand: true, picks: ["thread:7f3a2c1e"] })).score).toBe(1);
  expect(rightPick(args(hand("myself"), { hand: true, picks: ["thread:7f3a2c1e"] })).score).toBe(0);
  expect(rightPick(args(hand("myself"), { hand: true })).score).toBeNull();
  expect(rightPick(args([], { hand: true, picks: ["myself"] })).score).toBeNull();
});

test("talk of threads or agents to the person is caught", () => {
  expect(staysEmplio(args([], { hand: true }, "On it, I'll send the sheet when it's ready.")).score).toBe(1);
  expect(staysEmplio(args([], { hand: true }, "I've handed this off to an agent.")).score).toBe(0);
  expect(staysEmplio(args([], { hand: true })).score).toBeNull();
});

test("every case has its own name, and ends where Emplio answers next", () => {
  const all = cases();
  expect(new Set(all.map((c) => c.name)).size).toBe(all.length);
  for (const c of all) expect(c.chat.at(-1)?.role).not.toBe("assistant");
});
