import { expect, test } from "bun:test";
import { canReopen } from "./browser";

test("the Live browser button lasts 24 hours after the browser last ran", () => {
  const now = Date.now();
  const hoursAgo = (h: number) => new Date(now - h * 3600_000);
  expect(canReopen(null, now)).toBe(false);
  expect(canReopen(hoursAgo(23.9), now)).toBe(true);
  expect(canReopen(hoursAgo(24.1), now)).toBe(false);
});
