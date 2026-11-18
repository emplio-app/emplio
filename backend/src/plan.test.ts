import { expect, test } from "bun:test";
import type { PlanStep } from "@emplio/shared";
import { blocked, settle, unfinishedNote } from "./plan";

const of = (...st: PlanStep["status"][]) => st.map((status, i) => ({ text: `step ${i + 1}`, status }));
const statuses = (steps: PlanStep[]) => steps.map((s) => s.status);

test("one step in progress at a time, and the next one picks up when none is", () => {
  expect(statuses(settle(of("todo", "todo")))).toEqual(["doing", "todo"]);
  expect(statuses(settle(of("done", "todo", "todo")))).toEqual(["done", "doing", "todo"]);
  expect(statuses(settle(of("doing", "todo", "doing"), 2))).toEqual(["todo", "todo", "doing"]);
  expect(statuses(settle(of("todo", "doing", "doing")))).toEqual(["todo", "doing", "todo"]);
  expect(statuses(settle(of("done", "done")))).toEqual(["done", "done"]);
});

test("a job under way can't be wiped or ticked off wholesale; a finished or nearly finished one can", () => {
  expect(blocked("set", ["new"], of("done", "doing"))).toContain("isn't finished");
  expect(blocked("set", ["new"], of("done", "done"))).toBeNull();
  expect(blocked("set", ["new"], [])).toBeNull();
  expect(blocked("done", [], of("doing", "todo", "todo"))).toBeNull(); // the work's finished, steps never reached included
  expect(blocked("done", [], of("done", "doing", "todo"))).toBeNull(); // the answer itself may cover the last one
  expect(blocked("done", ["2", "3"], of("doing", "todo", "todo"))).toBeNull();
});

test("the unfinished note names what's next, and nothing when all is done", () => {
  expect(unfinishedNote(of("done", "doing", "todo"))).toBe("Unfinished checklist, 2 of 3 steps left. Next: step 2");
  expect(unfinishedNote(of("done"))).toBe("");
  expect(unfinishedNote(null)).toBe("");
});
