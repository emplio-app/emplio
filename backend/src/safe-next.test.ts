import { expect, test } from "bun:test";
import { safeNext } from "./auth";

test("after sign-in, only a page of this app", () => {
  for (const ok of ["/chat", "/chat?x=1", "/settings/billing"]) expect(safeNext(ok)).toBe(ok);
  for (const bad of ["//evil.com", "/\\evil.com", "/\t/evil.com", "/ /evil.com", "https://evil.com", "evil.com", "", undefined]) expect(safeNext(bad)).toBe("/home");
});
