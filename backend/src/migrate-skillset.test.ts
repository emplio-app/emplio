import { expect, test } from "bun:test";
import { repointed } from "../scripts/migrate-skillset";

test("paths to the old skills folder point at skillset", () => {
  expect(repointed("Run /work/company/skills/quote/run.py, see me/skills/x and restricted/skills/pay")).toBe(
    "Run /work/company/skillset/quote/run.py, see me/skillset/x and restricted/skillset/pay",
  );
  expect(repointed("company/skillset/a and emplio skills use a")).toBe("company/skillset/a and emplio skills use a");
});
