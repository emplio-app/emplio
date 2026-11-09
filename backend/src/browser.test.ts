import { expect, test } from "bun:test";
import { canReopen, keepIndexedDb } from "./browser";

test("the Live browser button lasts 24 hours after the browser last ran", () => {
  const now = Date.now();
  const hoursAgo = (h: number) => new Date(now - h * 3600_000);
  expect(canReopen(null, now)).toBe(false);
  expect(canReopen(hoursAgo(23.9), now)).toBe(true);
  expect(canReopen(hoursAgo(24.1), now)).toBe(false);
});

test("Indexed DB: sites read now replace what was kept, emptied ones go, and only the newest five stay", () => {
  const db = (n: string) => [{ name: n }];
  expect(keepIndexedDb({ a: db("old") }, { a: db("new") })).toEqual({ a: db("new") });
  expect(keepIndexedDb({ a: db("old"), b: db("b") }, { a: [] })).toEqual({ b: db("b") });
  expect(keepIndexedDb({ a: db("a") }, undefined)).toEqual({ a: db("a") });
  const six = Object.fromEntries("abcdef".split("").map((s) => [s, db(s)]));
  expect(Object.keys(keepIndexedDb(six, { a: db("back") }))).toEqual(["c", "d", "e", "f", "a"]);
});
