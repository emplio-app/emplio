import { expect, test } from "bun:test";
import { skillNote } from "./chat";

test("the skill reminder comes on the first command and at the two moments it's skipped", () => {
  expect(skillNote(1, "ls")).toContain("save it as a skill");
  expect(skillNote(2, "ls")).toBeNull();
  expect(skillNote(3, "cat >> /work/company/AGENT.md <<'EOF'\nreturns: check 7 days\nEOF")).toContain("belongs in a skill");
  expect(skillNote(3, "cat /work/company/AGENT.md")).toBeNull();
  expect(skillNote(2, "python3 /work/tmp/slip/make.py 4417")).toContain("isn't a skill yet");
  expect(skillNote(2, "python3 /work/company/skills/packing-slip/make.py 4417")).toBeNull();
});
