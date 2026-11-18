import { expect, test } from "bun:test";
import { MAX_RUNS, MIN_GAP, pacing } from "./tasks";

test("the AI's own next wake-up is spaced out and capped; first runs and people's tasks aren't", () => {
  const now = Date.parse("2026-11-18T10:00:00Z");
  const ran = { assigneeId: null, chases: 1, dueAt: null };
  const later = new Date(now + MIN_GAP + 1000);
  expect(pacing(ran, { status: "todo", dueAt: "x" }, later, now)).toBeNull();
  expect(pacing(ran, { status: "todo", dueAt: "x" }, new Date(now + 60_000), now)).toContain("at least 15 minutes");
  // back to to do with no new date: it would start straight away
  expect(pacing(ran, { status: "todo" }, undefined, now)).toContain("at least 15 minutes");
  expect(pacing({ ...ran, chases: MAX_RUNS }, { status: "todo", dueAt: "x" }, later, now)).toContain("set it waiting");
  expect(pacing({ ...ran, chases: 0 }, { status: "todo" }, undefined, now)).toBeNull();
  expect(pacing({ ...ran, assigneeId: "someone" } as never, { status: "todo" }, undefined, now)).toBeNull();
  expect(pacing(ran, { status: "done" }, undefined, now)).toBeNull();
});
