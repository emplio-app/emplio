import { expect, test } from "bun:test";
import { blocked, describeSkill, safety } from "./skill-store";

test("two scanners rating it high risk block a skill; one is shown on the card instead", () => {
  expect(blocked({ ath: { risk: "high" }, snyk: { risk: "critical" } })).toBe(true);
  expect(blocked({ ath: { risk: "safe" }, socket: { risk: "safe" }, snyk: { risk: "critical" } })).toBe(false);
  expect(safety({ ath: { risk: "safe" }, socket: { risk: "safe" }, snyk: { risk: "critical" } })).toBe("1 of 3 scanners flag critical risk");
  expect(safety(null)).toBe("not checked by the store's scanners");
});

test("skills show lists a store skill's scripts and files and how to install it, installing nothing", () => {
  const file = (path: string) => ({ path, content: new Uint8Array() });
  const text = describeSkill(
    "anthropics/skills/pptx",
    { report: null, files: ["SKILL.md", "scripts/clean.py", "LICENSE.txt"].map(file), found: { source: "anthropics/skills", skill: "pptx", installs: 1200 }, scripts: ["scripts/clean.py"] },
    "/work/tmp/store-skills/anthropics-skills-pptx",
  );
  expect(text).toContain("1,200 installs\tnot checked by the store's scanners");
  expect(text).toContain("Not installed. Its files are in /work/tmp/store-skills/anthropics-skills-pptx/");
  expect(text).toContain("Scripts: scripts/clean.py");
  expect(text).toContain("Other files: LICENSE.txt");
  expect(text).toContain("emplio skills add anthropics/skills/pptx");
});
