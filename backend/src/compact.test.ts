import { expect, test } from "bun:test";
import type { ModelMessage, UIMessage } from "ai";
import { foldingStep, recentStart, trimOld, trimSteps } from "./compact";

const ask = (text: string, extra: object[] = []) => ({ id: text, role: "user", parts: [{ type: "text", text }, ...extra] }) as UIMessage;
const ran = (output: string) => ({ id: output.slice(0, 9), role: "assistant", parts: [{ type: "tool-bash", state: "output-available", toolCallId: "c", input: {}, output: { exitCode: 0, output } }] }) as unknown as UIMessage;
const outputOf = (m: UIMessage) => (m.parts[0] as unknown as { output: { output: string } }).output.output;

const call = (id: string) => ({ role: "assistant", content: [{ type: "tool-call", toolCallId: id, toolName: "python", input: {} }] }) as ModelMessage;
const result = (id: string, output: string) =>
  ({ role: "tool", content: [{ type: "tool-result", toolCallId: id, toolName: "python", output: { type: "json", value: { exitCode: 0, output } } }] }) as ModelMessage;
const resultText = (m: ModelMessage) => ((m.content as unknown as { output: { value: { output: string } } }[])[0]!.output.value.output);
const run = (n: number, size = 5_000) => [
  { role: "user", content: "the brief" } as ModelMessage,
  ...Array.from({ length: n }, (_, i) => [call(`c${i}`), result(`c${i}`, `${i} ${"o".repeat(size)}`)]).flat(),
];

test("inside a long run, older outputs are cut ten at a time, the last five never", () => {
  // 14 outputs: only 9 are old enough, not a batch yet
  expect(trimSteps(run(14))).toBeNull();
  const t = trimSteps(run(15))!;
  expect(resultText(t[2]!).length).toBeLessThan(1_000);
  expect(resultText(t[2]!)).toContain("older output, read already");
  expect(t.slice(-10)).toEqual(run(15).slice(-10));
  // once cut, they stay cut, and nothing changes again until ten more are due
  expect(trimSteps([...t, call("x"), result("x", "o".repeat(5_000))])).toBeNull();
  // a short output, and one that says where its whole is kept, keep what matters
  const saved = "The whole output (90,000 characters) is saved in /work/tmp/output/abc.txt (if missing: emplio output abc).";
  const mixed = trimSteps([...run(10), call("s"), result("s", `${saved} ${"o".repeat(5_000)}`), ...run(5).slice(1)])!;
  expect(resultText(mixed.find((m) => m.role === "tool" && resultText(m).includes("abc.txt"))!)).toContain("saved in /work/tmp/output/abc.txt");
  expect(trimSteps(run(30, 500))).toBeNull();
});

test("a fold in the middle of a long run keeps its last steps word for word, never a call without its result", async () => {
  let folded: ModelMessage[] = [];
  const step = foldingStep({
    settings: { compactAt: 10_000, summaryModel: "auto", modelSet: "save", openrouterKey: null } as never,
    bill: {} as never,
    keep: [{ role: "user", content: "the brief" }],
    notes: null,
    contextTokens: null,
    system: [],
    withNotes: () => [],
    onFold: async () => {},
    signal: new AbortController().signal,
    warn: () => {},
    job: true,
    takeNotes: async (m) => ((folded = m), "notes"),
  });
  const sending = run(20, 3_000);
  const out = (await step.prepareStep({ steps: [{ usage: { inputTokens: 50_000 }, toolResults: [] }], messages: sending })) as { messages: ModelMessage[] };
  // budget is a quarter of compactAt: the brief, then the last steps that fit, each call with its result
  expect(out.messages[0]).toEqual({ role: "user", content: "the brief" });
  expect(out.messages[1]!.role).toBe("assistant");
  expect(out.messages.length).toBeGreaterThan(3);
  expect(out.messages.slice(1)).toEqual(sending.slice(sending.length - (out.messages.length - 1)));
  expect(folded.length + out.messages.length - 1).toBe(sending.length);
});

test("notes are taken on the chat's own request when that works, from a transcript when it doesn't", async () => {
  const sending = run(20, 3_000);
  const make = (forked: string | null, seen: { fork?: ModelMessage[]; transcript?: number }) =>
    foldingStep({
      settings: { compactAt: 10_000, summaryModel: "auto", modelSet: "save", openrouterKey: null } as never,
      bill: {} as never,
      keep: [{ role: "user", content: "the brief" }],
      notes: null,
      contextTokens: null,
      system: [],
      withNotes: () => [],
      onFold: async () => {},
      signal: new AbortController().signal,
      warn: () => {},
      job: true,
      fork: { model: "m", tools: {}, providerOptions: {} },
      forkNotes: async (_f, _i, m) => ((seen.fork = m), forked),
      takeNotes: async (m) => ((seen.transcript = m.length), "from transcript"),
    });
  const step = [{ usage: { inputTokens: 50_000 }, toolResults: [] }];
  const a: { fork?: ModelMessage[]; transcript?: number } = {};
  const out = (await make("forked notes", a).prepareStep({ steps: step, messages: sending })) as { instructions: unknown };
  // the whole request as sent, so its cache is read; no transcript
  expect(a.fork).toEqual(sending);
  expect(a.transcript).toBeUndefined();
  expect(out.instructions).toEqual([]);
  const b: { fork?: ModelMessage[]; transcript?: number } = {};
  await make(null, b).prepareStep({ steps: step, messages: sending });
  expect(b.transcript).toBeGreaterThan(0);
});

test("older turns are cut down ten at a time, the last three never", () => {
  const big = "x".repeat(10_000);
  const chat = (n: number) => Array.from({ length: n }, (_, i) => [ask(`q${i}`), ran(`${i}${big}`)]).flat();
  // 12 asks: nothing old enough yet
  expect(trimOld(chat(12))).toEqual(chat(12));
  // 13 asks: the first ten are cut, the last three are untouched
  const t = trimOld(chat(13));
  expect(outputOf(t[1]!).length).toBeLessThan(3_300);
  expect(outputOf(t[1]!)).toContain("characters of this older output left out");
  expect(t.slice(20)).toEqual(chat(13).slice(20));
  // the line doesn't move again until 23 asks, so what's sent before it stays the same
  expect(trimOld(chat(22)).slice(0, 20)).toEqual(t.slice(0, 20));
});

test("a repeated output keeps only its latest copy; old attachments become a pointer", () => {
  const same = "y".repeat(500);
  const chat = [ask("q0", [{ type: "file", url: "/files/a/b/photo.jpg", mediaType: "image/jpeg", filename: "photo.jpg" }]), ran(same), ask("q1"), ran(same), ...Array.from({ length: 11 }, (_, i) => ask(`r${i}`))];
  const t = trimOld(chat);
  expect(outputOf(t[1]!)).toBe("[Same output as a later run, shown there.]");
  expect(outputOf(t[3]!)).toBe(same);
  expect(t[0]!.parts[1]).toEqual({ type: "text", text: expect.stringContaining("/work/in/photo.jpg") });
});

test("a fold keeps the last few exchanges word for word, while they fit", () => {
  const turn = (q: string, size: number) => [
    { role: "user", content: q },
    { role: "assistant", content: [{ type: "tool-call", toolCallId: q, toolName: "bash", input: {} }] },
    { role: "tool", content: [{ type: "tool-result", toolCallId: q, toolName: "bash", output: { type: "text", value: "z".repeat(size) } }] },
  ];
  const chat = [...turn("a", 30), ...turn("b", 30), ...turn("c", 30), ...turn("d", 30), ...turn("e", 30), { role: "user", content: "now" }] as ModelMessage[];
  // the last three exchanges and the message being answered; a and b are folded
  expect(recentStart(chat, 20_000)).toBe(6);
  // a big one stops it: only what comes after it is kept
  const big = [...turn("a", 30), ...turn("b", 90_000), ...turn("c", 30), { role: "user", content: "now" }] as ModelMessage[];
  expect(recentStart(big, 20_000)).toBe(6);
  // never everything: something is always left to fold
  expect(recentStart(chat.slice(9), 20_000)).toBe(3);
});

test("a fold keeps the last few exchanges word for word, while they fit", () => {
  const turn = (q: string, size: number) => [
    { role: "user", content: q },
    { role: "assistant", content: [{ type: "tool-call", toolCallId: q, toolName: "bash", input: {} }] },
    { role: "tool", content: [{ type: "tool-result", toolCallId: q, toolName: "bash", output: { type: "text", value: "z".repeat(size) } }] },
  ];
  const chat = [...turn("a", 30), ...turn("b", 30), ...turn("c", 30), ...turn("d", 30), ...turn("e", 30), { role: "user", content: "now" }] as ModelMessage[];
  // the last three exchanges and the message being answered; a and b are folded
  expect(recentStart(chat, 20_000)).toBe(6);
  // a big one stops it: only what comes after it is kept
  const big = [...turn("a", 30), ...turn("b", 90_000), ...turn("c", 30), { role: "user", content: "now" }] as ModelMessage[];
  expect(recentStart(big, 20_000)).toBe(6);
  // never everything: something is always left to fold
  expect(recentStart(chat.slice(9), 20_000)).toBe(3);
});
