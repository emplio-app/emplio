import { expect, test } from "bun:test";
import { didOf, rightCall, staysInside } from "./scorers";

const args = (commands: string[], does: ("skill" | "knowledge" | "preference" | "task")[]) => ({ input: null, output: { text: "", commands }, expected: { does } });
const skill = "mkdir -p /work/company/skills/packing-slip && cat > /work/company/skills/packing-slip/SKILL.md <<'EOF'\nx\nEOF";
const fact = "cat >> /work/company/knowledge/shop.md <<'EOF'\nClosed Sundays from 15 Nov\nEOF";

test("what a round did is read from its commands", () => {
  expect(didOf([skill, fact, 'emplio person meera@kaveri.example prefer "No emojis"', 'emplio tasks add "Check invoice 215" --to ai --due 2026-11-13'])).toEqual(["skill", "knowledge", "preference", "task"]);
  expect(didOf(["emplio search shop timing", "cat /work/company/knowledge/shop.md", "emplio tasks list"])).toEqual([]);
});

test("everything called for must be done, and nothing when there were no notes", () => {
  expect(rightCall(args([fact, 'emplio tasks add "PO" --to raj@kaveri.example'], ["knowledge", "task"])).score).toBe(1);
  expect(rightCall(args([fact], ["knowledge", "task"])).score).toBe(0);
  expect(rightCall(args(["emplio activity --n 60"], [])).score).toBe(1);
  expect(rightCall(args([fact], [])).score).toBe(0);
});

test("sending from an app itself is outside work", () => {
  expect(staysInside(args(["emplio apps run gmail.send_email '{}'"], [])).score).toBe(0);
  expect(staysInside(args(["emplio apps run gmail.search '{}'"], [])).score).toBe(1);
});

test("a changed fact has to mark the old one replaced", () => {
  const expected = { does: ["knowledge" as const], replaces: true };
  const score = (command: string) => rightCall({ input: null, output: { text: "", commands: [command] }, expected }).score;
  expect(score('echo "2026-11-10: timing 10:30 to 8:30" >> company/knowledge/topics/shop.md')).toBe(0);
  expect(score("sed -i 's/10 to 8.*/& (replaced 2026-11-10)/' company/knowledge/topics/shop.md")).toBe(1);
});

test("a journal line that names a knowledge file isn't a knowledge write", () => {
  expect(didOf(["cat > /work/restricted/journal.md <<'EOF'\nalready in company/knowledge/suppliers/shree-foam.md\nEOF"])).toEqual([]);
  expect(didOf(["cd /work/company && cat >> knowledge/topics/shop.md <<'EOF'\nx\nEOF"])).toEqual(["knowledge"]);
});
