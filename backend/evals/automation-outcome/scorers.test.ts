import { expect, test } from "bun:test";
import { NOT_DONE, outcome } from "../../src/automations";
import { cases } from "./cases";
import { rightCall, saysWhy } from "./scorers";

const args = (text: string, notDone: boolean) => ({ output: { text, commands: [], outcome: outcome(null, text) }, expected: { notDone } });

test("the run's status is marked against what the case wants", () => {
  expect(rightCall(args(`${NOT_DONE} Sent 0 of 20: every profile asks for an email.`, true)).score).toBe(1);
  expect(rightCall(args("Sent 20 invites.", true)).score).toBe(0);
  expect(rightCall(args("[SILENT]", false)).score).toBe(1);
  expect(rightCall(args(`${NOT_DONE} Nothing new.`, false)).score).toBe(0);
  // handed off and ended: the run waits for that report, so this reply doesn't decide it
  expect(rightCall({ ...args("Handed it on.", true), output: { ...args("Handed it on.", true).output, commands: ["emplio hand x <<'EOF'\nx\nEOF"] } }).score).toBeNull();
  expect(rightCall({ ...args("Sent.", false), output: { ...args("Sent.", false).output, commands: ["emplio hand x", "emplio threads wait"] } }).score).toBe(1);
});

test("a failed run has to say why", () => {
  expect(saysWhy(args(`${NOT_DONE} Sent 0 of 20: every profile asks for an email.`, true)).score).toBe(1);
  expect(saysWhy(args(`${NOT_DONE} Blocked.`, true)).score).toBe(0);
  expect(saysWhy(args("Sent 20.", false)).score).toBeNull();
});

test("the cases are well formed, with both sides covered", async () => {
  const all = await cases();
  expect(new Set(all.map((c) => c.name)).size).toBe(all.length);
  expect(all.some((c) => c.expect.notDone)).toBe(true);
  expect(all.some((c) => !c.expect.notDone)).toBe(true);
  for (const c of all) expect(c.chat[0]!.role).toBe("user");
});
