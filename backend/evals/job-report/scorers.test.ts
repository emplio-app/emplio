import { expect, test } from "bun:test";
import { cases } from "./cases";
import { rightCall, shape, statusIn } from "./scorers";

const out = (report: string, commands: string[] = []) => ({ text: report, commands, report, first: report, sentBack: null });

test("the cases are well formed", () => {
  const all = cases();
  expect(new Set(all.map((c) => c.name)).size).toBe(all.length);
  for (const c of all) {
    expect(c.expect.status.length).toBeGreaterThan(0);
    expect(c.done.length).toBeGreaterThan(0);
    if (c.expect.runs) new RegExp(c.expect.runs);
    for (const s of c.expect.says ?? []) new RegExp(s);
  }
});

test("its status is read from the report, or a question from a card", () => {
  expect(statusIn("Status: Partly done\nResult: ...", [])).toBe("partly done");
  expect(statusIn("**Status:** Done", [])).toBe("done");
  expect(statusIn("Question: which account?", [])).toBe("question");
  expect(statusIn("Asked.", ['emplio ask "Which account?" "HDFC" "ICICI"'])).toBe("question");
  expect(statusIn("All done!", [])).toBeNull();
});

test("right only with the right status and the command it had to run", () => {
  const expected = { status: ["done" as const], runs: "gmail\\.search", orNotDone: true };
  expect(rightCall({ input: {} as never, output: out("Status: Done\nChecked: read back", ["emplio apps run gmail.search x"]), expected }).score).toBe(1);
  expect(rightCall({ input: {} as never, output: out("Status: Done\nChecked: sent"), expected }).score).toBe(0);
  expect(rightCall({ input: {} as never, output: out("Status: Partly done"), expected: { ...expected, status: ["done", "partly done"] } }).score).toBe(1);
  expect(shape({ input: {} as never, output: out("Status: Done\nResult: x"), expected }).score).toBe(0);
});
