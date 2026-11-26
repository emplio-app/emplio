import { expect, test } from "bun:test";
import type { UIMessageChunk } from "ai";
import { addApp, catchUp, notify } from "./live";

test("catching up joins words and keeps only a command's latest progress", () => {
  const chunks = [
    { type: "text-start", id: "a" },
    { type: "text-delta", id: "a", delta: "Hello " },
    { type: "text-delta", id: "a", delta: "there" },
    { type: "text-end", id: "a" },
    { type: "tool-input-start", toolCallId: "t", toolName: "bash" },
    { type: "tool-input-delta", toolCallId: "t", inputTextDelta: "{\"a\":" },
    { type: "tool-input-delta", toolCallId: "t", inputTextDelta: "1}" },
    { type: "tool-output-available", toolCallId: "t", output: 1, preliminary: true },
    { type: "tool-output-available", toolCallId: "t", output: 2, preliminary: true },
  ] as UIMessageChunk[];
  expect(catchUp(chunks)).toEqual([
    { type: "text-start", id: "a" },
    { type: "text-delta", id: "a", delta: "Hello there" },
    { type: "text-end", id: "a" },
    { type: "tool-input-start", toolCallId: "t", toolName: "bash" },
    { type: "tool-input-delta", toolCallId: "t", inputTextDelta: "{\"a\":1}" },
    { type: "tool-output-available", toolCallId: "t", output: 2, preliminary: true },
  ] as UIMessageChunk[]);
});

test("a nudge names the lists that changed, to each of the person's open apps", () => {
  const got: string[] = [];
  const socket = { OPEN: 1, readyState: 1, send: (s: string) => got.push(s), on: () => {} } as never;
  addApp("u-live-test", socket);
  notify("u-live-test", ["tasks"]);
  expect(got.map((s) => JSON.parse(s))).toEqual([{ type: "changed", what: ["tasks"] }]);
});
