import { expect, test } from "bun:test";
import { canReopen, keepIndexedDb, signedInSites, sitesIn } from "./browser";

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

test("sites are picked out of a browser command", () => {
  expect(sitesIn('emplio browser open https://app.getswipe.in/invoices && emplio browser snapshot -i')).toEqual(["getswipe.in"]);
  expect(sitesIn('emplio browser open "books.zoho.co.in"')).toEqual(["zoho.co.in"]);
  expect(sitesIn("emplio browser click @e3")).toEqual([]);
});

test("only long-lived, script-hidden sign-in cookies make a site a signed-in one", () => {
  const now = Date.parse("2026-11-09T00:00:00Z");
  const later = now / 1000 + 30 * 86_400;
  const cookie = (name: string, domain: string, httpOnly: boolean, expires: number) => ({ name, value: "x", domain, httpOnly, expires });
  const found = signedInSites(
    [
      cookie("session_token", ".app.getswipe.in", true, later),
      cookie("__Secure-1PSID", ".google.com", true, later),
      cookie("_ga", ".news.example.com", false, later),
      cookie("PHPSESSID", "shop.example.org", true, -1),
      cookie("session", "soon.example.net", true, now / 1000 + 3600),
      cookie("auth", "visible.example.io", false, later),
    ],
    now,
  );
  expect([...found].sort()).toEqual(["getswipe.in", "google.com"]);
});
