// CHANGELOG.md is the one place versions live: its newest heading is the version this server is running, and its
// "What's new" lines are what people see in the app. "For developers" goes to the GitHub release only (ci.yml).
import { readFileSync } from "node:fs";
import type { Release } from "@emplio/shared";

export function parseChangelog(md: string): Release[] {
  return md
    .split(/^(?=## )/m)
    .filter((section) => section.startsWith("## "))
    .map((section) => {
      const heading = section.split("\n")[0]!;
      const [, version, date] = /^## (\d+\.\d+\.\d+) \((\d{4}-\d{2}-\d{2})\)$/.exec(heading) ?? [];
      if (!version) throw new Error(`CHANGELOG.md: "${heading}" should look like "## 1.2.3 (2026-11-09)"`);
      const lines = /^### What's new\n+((?:- .*\n?)+)/m.exec(section)?.[1];
      if (!lines) throw new Error(`CHANGELOG.md: ${version} needs a "### What's new" list`);
      return { version, date: date!, changes: lines.trim().split("\n").map((l) => l.slice(2)) };
    });
}

// a bad file stops the server here, but changelog.test.ts stops it reaching one first
export const releases = parseChangelog(readFileSync(new URL("../../CHANGELOG.md", import.meta.url), "utf8"));
export const version = releases[0]!.version;
