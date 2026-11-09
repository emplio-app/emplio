import { expect, test } from "bun:test";
import { parseChangelog, releases } from "./changelog";

const newer = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true }) > 0;

test("CHANGELOG.md is well formed, newest version first", () => {
  expect(releases.length).toBeGreaterThan(0);
  for (const [i, r] of releases.entries()) {
    expect(r.changes.length).toBeGreaterThan(0);
    if (i) expect(newer(releases[i - 1]!.version, r.version)).toBe(true);
  }
});

test("people get the plain lines only, and a bad heading is caught", () => {
  const md = "# Changelog\n\nIntro.\n\n## 1.2.10 (2026-11-09)\n\n### What's new\n\n- One\n- Two\n\n### For developers\n\n- Secret detail\n";
  expect(parseChangelog(md)).toEqual([{ version: "1.2.10", date: "2026-11-09", changes: ["One", "Two"] }]);
  expect(() => parseChangelog("## next\n\n### What's new\n\n- One\n")).toThrow("should look like");
  expect(() => parseChangelog("## 1.0.0 (2026-11-09)\n\n### For developers\n\n- One\n")).toThrow("What's new");
});
