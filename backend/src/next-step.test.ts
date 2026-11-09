import { expect, test } from "bun:test";
import { echoes } from "./chat";

test("a guess that repeats the employee's question is dropped, a real answer isn't", () => {
  const reply = "Yes, if the server is reachable and we have a login for it. Which server do you need, and what should I do there?";
  expect(echoes("Which server do you need me to SSH into, and what should I do there?", reply)).toBe(true);
  expect(echoes("The Hostinger VPS, check disk space", reply)).toBe(false);
  expect(echoes("yes send it", "Should I send it? yes or no")).toBe(false);
});
