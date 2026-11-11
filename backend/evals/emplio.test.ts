import { expect, test } from "bun:test";
import { pretend } from "./emplio";

test("the stand-in computer answers a chain part by part, and a write with nothing", () => {
  expect(pretend("cd /work; emplio search shop timing; echo ---; cat company/heartbeat.md 2>&1 | head -5")).toStartWith("No matches.\n---\n# Check-ins");
  expect(pretend("mkdir -p /work/company/skills/x && cat > /work/company/skills/x/SKILL.md <<'EOF'\nemplio search y\nEOF")).toBe("(no output)");
  expect(pretend("cat /work/tmp/nope.py")).toContain("No such file");
});
