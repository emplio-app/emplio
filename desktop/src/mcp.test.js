import { expect, test } from "bun:test";
import { LocalMcp } from "./mcp.js";

const setup = (answer) => {
  const sent = [];
  const known = [];
  const mcp = new LocalMcp({ ask: async () => answer, allowed: () => known, remember: (c) => known.push(c), emit: (m) => sent.push(m) });
  return { mcp, sent, known };
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test("a command the person refuses never runs", async () => {
  const { mcp, sent } = setup(false);
  await mcp.open({ key: "a", command: "echo hi" });
  expect(sent).toEqual([{ ev: "mcp.closed", key: "a", e: "the person said no on their Mac" }]);
});

test("an allowed command's lines come back, messages go in, and it is remembered", async () => {
  const { mcp, sent, known } = setup(true);
  // answers each line it is given with the same line wrapped
  await mcp.open({ key: "b", command: `while read l; do echo "got $l"; done` });
  mcp.send({ key: "b", data: "ping" });
  await wait(500);
  expect(sent).toContainEqual({ ev: "mcp.data", key: "b", data: "got ping" });
  expect(known).toEqual([`while read l; do echo "got $l"; done`]);
  mcp.close({ key: "b" });
});

test("a command that fails says why", async () => {
  const { mcp, sent } = setup(true);
  await mcp.open({ key: "c", command: "echo nope >&2; exit 3" });
  await wait(500);
  expect(sent.at(-1)).toEqual({ ev: "mcp.closed", key: "c", e: "nope" });
});
