import { expect, test } from "bun:test";
import { cases } from "./cases";
import { keepsWords, noBrowser, rightCall, routesOf } from "./scorers";

const business = { agents: ["- Supplier Finder (agents/supplier-finder, light): Finds suppliers"], threads: ["- 7f3a2c1e · Supplier Finder · Surat · done, 10 Nov", "- 2c9e7710 · myself · Page · done, 9 Nov"] };
const hand = (pick: string) => [`emplio hand ${pick} <<'EOF'\nPrices from Surat\nEOF`];
const old = { business, carriesOn: false };
const now = { business, carriesOn: true };
const args = (commands: string[], expected: object, carriesOn = false) => ({ input: { business, chat: [], world: [], carriesOn }, output: { text: "", commands, byHand: 0 }, expected: expected as never });

test("where a hand-off goes, in the old and the new hand-off", () => {
  expect(routesOf(hand("7f3a2c1e"), old)[0]).toMatchObject({ agent: "Supplier Finder", cont: true });
  expect(routesOf(hand("7f3a"), now)[0]).toMatchObject({ agent: "Supplier Finder", cont: true });
  expect(routesOf(hand('"Supplier Finder"'), old)[0]).toMatchObject({ agent: "Supplier Finder", cont: false });
  expect(routesOf(hand('"Supplier Finder"'), now)[0]).toMatchObject({ agent: "Supplier Finder", cont: true });
  expect(routesOf(hand("supplier-finder --new"), now)[0]).toMatchObject({ agent: "Supplier Finder", cont: false });
  expect(routesOf(hand('"Price Checker" --description "Checks prices"'), now)[0]).toMatchObject({ agent: "new", cont: false });
  expect(routesOf(hand("myself"), old)[0]).toMatchObject({ agent: "myself" });
  expect(routesOf(["emplio threads list"], old)).toEqual([]);
});

test("the right call: agent, carry on or fresh, never a plain copy", () => {
  expect(rightCall(args(hand("7f3a2c1e"), { hand: true, agent: ["Supplier Finder"], cont: true })).score).toBe(1);
  expect(rightCall(args(hand('"Supplier Finder"'), { hand: true, agent: ["Supplier Finder"], cont: true })).score).toBe(0);
  expect(rightCall(args(hand('"Supplier Finder"'), { hand: true, agent: ["Supplier Finder"], cont: true }, true)).score).toBe(1);
  expect(rightCall(args(hand("myself"), { hand: true })).score).toBe(0);
  expect(rightCall(args([], { hand: false })).score).toBe(1);
  expect(rightCall(args(hand("myself"), { hand: false })).score).toBe(0);
});

test("the brief carries the person's words, and the browser stays with the agents", () => {
  expect(keepsWords(args(hand("7f3a"), { hand: true, say: ["surat"] })).score).toBe(1);
  expect(keepsWords(args(hand("7f3a"), { hand: true, say: ["mumbai"] })).score).toBe(0);
  expect(noBrowser(args(["emplio browser open https://x.example"], { hand: true })).score).toBe(0);
  expect(noBrowser(args(hand("7f3a"), { hand: true })).score).toBe(1);
});

test("the cases are well formed", () => {
  const all = cases();
  expect(new Set(all.map((c) => c.name)).size).toBe(all.length);
  for (const c of all) {
    if (!c.expect.hand) expect(c.expect.agent ?? c.expect.cont ?? c.expect.say).toBeUndefined();
    for (const w of c.expect.say ?? []) expect(() => new RegExp(w)).not.toThrow();
  }
  // both sides: work that stays with Emplio next to work that goes
  expect(all.filter((c) => !c.expect.hand).length).toBeGreaterThanOrEqual(5);
});
