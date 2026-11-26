import { expect, test } from "bun:test";
import { toYaml } from "./move-client-notes";

test("values stay as written; lists and loose lines aren't lost", () => {
  const out = toYaml("---\nphone: +919812345678\ncode: 007\naddress: 12 Main St #4, Pune\nfee: 1200\ntags:\n  - retail\n  - wholesale\nsome loose line\n---\nhi");
  expect(out).toBe('---\nphone: "+919812345678"\ncode: "007"\naddress: "12 Main St #4, Pune"\nfee: 1200\ntags:\n  - retail\n  - wholesale\n---\nsome loose line\n\nhi');
});
