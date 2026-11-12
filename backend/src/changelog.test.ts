import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { parseChangelog, releases } from "./changelog";

const newer = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true }) > 0;

test("CHANGELOG.md is well formed, newest version first, and its pictures exist", () => {
  expect(releases.length).toBeGreaterThan(0);
  for (const [i, r] of releases.entries()) {
    expect(r.changes.length).toBeGreaterThan(0);
    if (i) expect(newer(releases[i - 1]!.version, r.version)).toBe(true);
    for (const { image } of r.changes) {
      if (image?.startsWith("/")) expect(existsSync(new URL(`../../frontend/public${image}`, import.meta.url))).toBe(true);
    }
  }
});

test("people get the plain lines only, and a bad heading is caught", () => {
  const md = "# Changelog\n\nIntro.\n\n## 1.2.10 (2026-11-09)\n\n### What's new\n\n- One\n- Two\n\n### For developers\n\n- Secret detail\n";
  expect(parseChangelog(md)).toEqual([{ version: "1.2.10", date: "2026-11-09", changes: [{ text: "One" }, { text: "Two" }] }]);
  expect(() => parseChangelog("## next\n\n### What's new\n\n- One\n")).toThrow("should look like");
  expect(() => parseChangelog("## 1.0.0 (2026-11-09)\n\n### For developers\n\n- One\n")).toThrow("What's new");
});

test("a picture at the end of a line comes apart from its text", () => {
  const md = "## 1.0.0 (2026-11-09)\n\n### What's new\n\n- Cards slide. ![The card](frontend/public/whats-new/card.gif)\n- From afar ![](https://example.com/a.png)\n- Plain\n";
  expect(parseChangelog(md)[0]!.changes).toEqual([
    { text: "Cards slide.", image: "/whats-new/card.gif" },
    { text: "From afar", image: "https://example.com/a.png" },
    { text: "Plain" },
  ]);
});
