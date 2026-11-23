import { expect, test } from "bun:test";
import { failureGuard, outOfUsage, progressGuard, STALLED_NOTE, unlessStuck } from "./stuck";

test("same failure: warned the second time, stopped the third", () => {
  const g = failureGuard();
  const fail = { exitCode: 2, output: "curl: (6) Could not resolve host" };
  expect(g.check("curl  x.com", fail)).toBeNull();
  expect(g.check("curl x.com", fail)).toContain("same way before");
  expect(g.stuck).toBe(false);
  expect(g.check("curl x.com", fail)).toContain("Stopped");
  expect(g.stuck).toBe(true);
});

test("the same read with the same result a third time gets a note, and never stops it", () => {
  const g = failureGuard();
  const read = { exitCode: 0, output: "65 rows" };
  expect(g.check("cat a.csv", read)).toBeNull();
  expect(g.check("cat a.csv", read)).toBeNull();
  expect(g.check("cat a.csv", read)).toContain("got exactly this");
  expect(g.check("cat a.csv", { exitCode: 0, output: "66 rows" })).toBeNull();
  expect(g.stuck).toBe(false);
});

test("a job whose checklist never moves is asked for one, told, then stopped; ticking starts the count again", () => {
  const g = progressGuard(false);
  const notes = Array.from({ length: 80 }, () => g.check(false, true));
  expect(notes[14]).toContain("no checklist");
  expect(notes[39]).toContain("hasn't moved in 40");
  expect(notes[79]).toBe(STALLED_NOTE);
  expect(notes.filter(Boolean).length).toBe(3);
  const h = progressGuard(true);
  for (let i = 0; i < 70; i++) h.check(false, true);
  expect(h.check(true, true)).toBeNull();
  for (let i = 0; i < 79; i++) expect(h.check(false, true) ?? "").not.toBe(STALLED_NOTE);
  // managing commands (emplio plan, hand, ask) aren't counted
  expect(h.check(false, false)).toBeNull();
});

test("different searches finding nothing never stop it", () => {
  const g = failureGuard();
  for (let i = 0; i < 20; i++) expect(g.check(`grep -r word${i} .`, { exitCode: 1, output: "" })).toBeNull();
  expect(g.stuck).toBe(false);
});

test("8 different real failures in a row stop it; a success starts the count again", () => {
  const g = failureGuard();
  for (let i = 0; i < 7; i++) g.check(`cmd${i}`, { exitCode: 127, output: `cmd${i}: not found` });
  g.check("ls", { exitCode: 0, output: "" });
  for (let i = 0; i < 7; i++) g.check(`again${i}`, { exitCode: 124, output: "timed out" + i });
  expect(g.stuck).toBe(false);
  expect(g.check("last", { exitCode: 2, output: "x" })).toContain("Stopped");
});

test("background starts and stopped commands aren't judged", () => {
  const g = failureGuard();
  for (let i = 0; i < 5; i++) {
    expect(g.check("server", { pid: 1 } as never)).toBeNull();
    expect(g.check("x", { stopped: true, exitCode: 130 })).toBeNull();
  }
  expect(g.stuck).toBe(false);
});

test("usage running out ends the run's commands with the reason", async () => {
  const g = failureGuard();
  expect(g.end(outOfUsage("This month's usage is used up."))).toContain("This month's usage is used up.");
  expect(g.stuck).toBe(true);
  const step = await unlessStuck(async () => ({}), g)(null);
  expect(step).toMatchObject({ toolChoice: "none", activeTools: [] });
});
