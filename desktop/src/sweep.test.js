import { expect, test } from "bun:test";
import { LINK_LOST_MS, overdue } from "./sweep.js";

const at = (ms) => ({ timeoutAt: new Date(ms) });
const now = 1_000_000_000;

test("a browser past its time limit ends, the others stay", () => {
  expect(overdue([["old", at(now - 1)], ["new", at(now + 60_000)]], now, 0)).toEqual(["old"]);
});

test("when the server has been out of reach too long, every browser ends", () => {
  const all = [["a", at(now + 3_600_000)], ["b", at(now + 3_600_000)]];
  expect(overdue(all, now, now - LINK_LOST_MS - 1)).toEqual(["a", "b"]);
  expect(overdue(all, now, now - 60_000)).toEqual([]);
});
