import { expect, test } from "bun:test";
import { plain } from "./push";

test("a lock screen shows plain words", () => {
  expect(plain("**Done.** See [the report](https://x.y/z)\n\n# Next")).toBe("Done. See the report Next");
  expect(plain("a".repeat(400))).toHaveLength(180);
});
