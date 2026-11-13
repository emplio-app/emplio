import { expect, test } from "bun:test";
import { canReopen, keepIndexedDb, signInPrint, signedInSites, sitesIn, stillRunning } from "./browser";

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

test("a browser being stopped isn't picked up again as the chat's browser", () => {
  const b = (id: string, startedAt: string) => ({ id, cdpUrl: "https://cdp", liveUrl: "https://live", startedAt });
  const listed = [b("old", "2026-11-11T04:57:56"), b("new", "2026-11-11T05:13:40"), { id: "half", cdpUrl: "", liveUrl: "https://live" }];
  expect(stillRunning(listed, new Set()).map((x) => x.id)).toEqual(["new", "old"]);
  expect(stillRunning(listed, new Set(["new"])).map((x) => x.id)).toEqual(["old"]);
  expect(stillRunning([b("old", "2026-11-11T04:57:56")], new Set(["old"]))).toEqual([]);
});

test("a computer's browser saves again when a sign-in changes, not when analytics cookies do", () => {
  const c = (name: string, value: string, httpOnly: boolean) => ({ name, value, domain: ".example.com", httpOnly });
  const before = signInPrint([c("session", "a", true), c("_ga", "1", false)]);
  expect(signInPrint([c("_ga", "2", false), c("session", "a", true)])).toBe(before);
  expect(signInPrint([c("session", "b", true), c("_ga", "1", false)])).not.toBe(before);
  expect(signInPrint([c("session", "a", true), c("sid", "x", true), c("_ga", "1", false)])).not.toBe(before);
});
