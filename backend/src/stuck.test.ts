import { expect, test } from "bun:test";
import { failureGuard, outOfUsage, unlessStuck } from "./stuck";

test("same failure: warned the second time, stopped the third", () => {
  const g = failureGuard();
  const fail = { exitCode: 2, output: "curl: (6) Could not resolve host" };
  expect(g.check("curl  x.com", fail)).toBeNull();
  expect(g.check("curl x.com", fail)).toContain("same way before");
  expect(g.stuck).toBe(false);
  expect(g.check("curl x.com", fail)).toContain("Stopped");
  expect(g.stuck).toBe(true);
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
