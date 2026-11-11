import { expect, test } from "bun:test";
import { readOf, rightCall, savedOf } from "./scorers";

const args = (commands: string[], expected: { use?: string | null; save?: boolean }) => ({ input: { chat: [], world: [] }, output: { text: "", commands }, expected });
const write = "mkdir -p /work/company/skills/amazon-payouts && cat > /work/company/skills/amazon-payouts/SKILL.md <<'EOF'\n---\nname: amazon-payouts\n---\nEOF";

test("reading and saving a skill are read from the commands", () => {
  expect(readOf(["emplio plan set a b; emplio skills use gst-quote"])).toEqual(["gst-quote"]);
  expect(readOf(["cat /work/company/skills/gst-quote/SKILL.md"])).toEqual(["gst-quote"]);
  expect(savedOf([write])).toEqual(["amazon-payouts"]);
  expect(savedOf(["mkdir -p /work/me/skills/slips && cd /work/me/skills/slips && cat > SKILL.md <<'EOF'\nx\nEOF"])).toEqual(["slips"]);
  expect(savedOf(["emplio skills use gst-quote", "python3 x.py"])).toEqual([]);
});

test("the right call needs the right skill read, and a save only when wanted", () => {
  expect(rightCall(args(["emplio skills use gst-quote"], { use: "gst-quote" })).score).toBe(1);
  expect(rightCall(args(["emplio skills use courier-booking"], { use: "gst-quote" })).score).toBe(0);
  expect(rightCall(args(["python3 q.py"], { use: "gst-quote" })).score).toBe(0);
  expect(rightCall(args(["emplio skills use gst-quote"], { use: null })).score).toBe(0);
  expect(rightCall(args([write], { save: true })).score).toBe(1);
  expect(rightCall(args(["python3 x.py"], { save: true })).score).toBe(0);
  expect(rightCall(args([write], { save: false })).score).toBe(0);
});
