import { expect, test } from "bun:test";
import { zodSchema } from "ai";
import { z } from "zod";
import { commandLabel } from "./chat";

const input = z.object({ description: commandLabel, command: z.string() });

test("the model is told the label is required", async () => {
  expect((await zodSchema(input).jsonSchema).required).toContain("description");
});

test("a label it writes is kept; a missing or empty one gets the stand-in instead of failing", () => {
  expect(input.parse({ description: "Counting rows", command: "ls" }).description).toBe("Counting rows");
  expect(input.parse({ command: "ls" }).description).toBe("Running a command");
  expect(input.parse({ description: "", command: "ls" }).description).toBe("Running a command");
});
