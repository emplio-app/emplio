import { expect, test } from "bun:test";
import { finished } from "./done-sound";

test("finished: only what was running and has stopped", () => {
  const before = new Set(["a", "b", "gone"]);
  const after = [
    { id: "a", running: false }, // finished
    { id: "b", running: true }, // still going
    { id: "c", running: false }, // never seen running
  ];
  expect(finished(before, after)).toEqual(["a"]);
  expect(finished(new Set(), after)).toEqual([]);
});
