import { expect, test } from "bun:test";
import { fenceHolds, hiddenOnWindows, HIDDEN, labelScript } from "./fence-win.js";

test("Windows hides the same kinds of folders as the Mac", () => {
  const hidden = hiddenOnWindows("C:\\Users\\Raj", { LOCALAPPDATA: "C:\\Users\\Raj\\AppData\\Local", APPDATA: "C:\\Users\\Raj\\AppData\\Roaming" });
  for (const p of [".ssh", "Documents", "Google", "Mozilla"]) expect(hidden.some((h) => h.includes(p))).toBe(true);
});

test("a path with a quote can't break out of the labelling script", () => {
  const script = labelScript([["C:\\Users\\O'Neil\\.ssh", HIDDEN]]);
  expect(script).toContain(`'C:\\Users\\O''Neil\\.ssh'`);
});

test("the fence holds only when every check says so", () => {
  expect(fenceHolds("LOW\nWROTE\n")).toBe(true);
  expect(fenceHolds("WROTE\n")).toBe(false);
  expect(fenceHolds("LOW\nWROTE\nESCAPED\n")).toBe(false);
  expect(fenceHolds("LOW\nWROTE\nLEAKED\n")).toBe(false);
});
