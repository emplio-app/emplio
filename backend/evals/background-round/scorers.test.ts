import { expect, test } from "bun:test";
import { didOf, ideal, lean, noBrowser, rightCall, staysInside } from "./scorers";

const args = (commands: string[], does: ("skill" | "knowledge" | "preference" | "task")[]) => ({ input: null, output: { text: "", commands }, expected: { does } });
const skill = "mkdir -p /work/company/skillset/packing-slip && cat > /work/company/skillset/packing-slip/SKILL.md <<'EOF'\nx\nEOF";
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

const run = (commands: string[], expect: Record<string, unknown>) => ideal({ input: null, output: { text: "", commands }, expected: { does: [], ...expect } as never }).score;

test("tasks: done ones closed, others left open, one of each pair of duplicates", () => {
  expect(run(["emplio tasks done a1b2c3d4"], { done: ["a1b2c3d4"], open: ["e5f6a7b8"] })).toBe(1);
  expect(run(["emplio tasks done a1b2c3d4", "emplio tasks done e5f6a7b8"], { done: ["a1b2c3d4"], open: ["e5f6a7b8"] })).toBe(0);
  expect(run(["emplio tasks update c0ffee02 --status cancelled"], { cancelled: [["c0ffee01", "c0ffee02"]] })).toBe(1);
  expect(run(["emplio tasks remove c0ffee01", "emplio tasks remove c0ffee02"], { cancelled: [["c0ffee01", "c0ffee02"]] })).toBe(0);
});

test("a rewrite keeps what must stay, drops the rest, and fits", () => {
  const rewrite = { email: "m@k.example", file: "prefer", max: 200, keep: ["emoji"], drop: ["order 43\\d\\d"], once: ["short"] };
  expect(run(["emplio person m@k.example rewrite prefer <<'EOF'\n# Preferences\n- No emojis\n- Short replies\nEOF"], { rewrite })).toBe(1);
  expect(run(["emplio person rewrite m@k.example prefer <<'EOF'\n# Preferences\n- Short replies\n- short answers\n- No emojis\nEOF"], { rewrite })).toBe(0);
  expect(run(["emplio person m@k.example rewrite prefer <<'EOF'\n# Preferences\n- No emojis\n- order 4301 packed\nEOF"], { rewrite })).toBe(0);
  expect(run(["emplio person m@k.example prefer 'No emojis'"], { rewrite })).toBe(0);
  expect(run(["cat > /work/tmp/p.md <<'EOF'\n# Preferences\n- No emojis\nEOF", "emplio person m@k.example rewrite prefer < /work/tmp/p.md"], { rewrite })).toBe(1);
  expect(run(["emplio person 'm@k.example rewrite prefer' <<'EOF'\n# Preferences\n- No emojis\nEOF"], { rewrite })).toBe(1);
  expect(run(["cat > /work/me/preferences.md <<'EOF'\n# Preferences\n- No emojis\nEOF"], { rewrite })).toBe(1);
});

test("goals: progress written, goals kept, tasks added", () => {
  const goals = { headings: ["Grow online orders"], tasks: 1 };
  expect(run(["cat > /work/company/goals.md <<'EOF'\n# Goals\n## Grow online orders\n- 2026-11-10: 37%\nEOF", 'emplio tasks add "Push online offer" --to ai'], { goals })).toBe(1);
  expect(run(["cat > /work/company/goals.md <<'EOF'\n# Goals\n## Grow web orders\n- 37%\nEOF", 'emplio tasks add "x" --to ai'], { goals })).toBe(0);
  expect(run(['emplio tasks add "x" --to ai'], { goals })).toBe(0);
});

test("no browser, and few commands", () => {
  expect(noBrowser({ input: null, output: { text: "", commands: ['emplio.browser.open("https://x.example")'] }, expected: { does: [] } }).score).toBe(0);
  expect(lean({ input: null, output: { text: "", commands: Array(16).fill("emplio search x") }, expected: { does: [] } }).score).toBe(0);
});
